#!/usr/bin/env node
// Weekly GitHub stats for one user. No dependencies: Node's built-in http + fetch,
// auth from `gh auth token`. Refreshes from GitHub every 5 minutes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCheckouts, watchCheckouts } = require('./checkouts');

const LOGIN = process.env.GH_STAT_LOGIN || 'n8agrin';
const PORT = Number(process.env.PORT || 4747);
const WEEKS = Number(process.env.GH_STAT_WEEKS || 12);
const REFRESH_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(__dirname, '.cache.json');

let stats = null; // last computed payload served to the page
let lastError = null;
let refreshing = null;

try {
  stats = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

// Weeks start Monday 00:00 local time.
function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GitHub ${res.status}: ${JSON.stringify(body.errors || body.message || body)}`);
  }
  return body.data;
}

const PR_FIELDS = `
  id number title url additions deletions createdAt mergedAt state headRefName
  author { login }
  repository { nameWithOwner }
`;

// Search results cap at 1,000, so split the date range until each slice fits.
async function searchAll(q, field, from, to, extra = '') {
  const query = `query($q: String!, $after: String) {
    rateLimit { remaining }
    search(query: $q, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${PR_FIELDS} ${extra} } }
    }
  }`;
  const full = `${q} ${field}:${ymd(from)}..${ymd(to)}`;
  let data = await gql(query, { q: full, after: null });
  if (data.search.issueCount > 1000 && to - from > 86400000) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    return [
      ...(await searchAll(q, field, from, mid, extra)),
      ...(await searchAll(q, field, addDays(mid, 1), to, extra)),
    ];
  }
  const nodes = [...data.search.nodes];
  while (data.search.pageInfo.hasNextPage) {
    data = await gql(query, { q: full, after: data.search.pageInfo.endCursor });
    nodes.push(...data.search.nodes);
  }
  rateRemaining = data.rateLimit.remaining;
  return nodes;
}
let rateRemaining = null;

async function refresh() {
  const now = new Date();
  const first = addDays(weekStart(now), -7 * (WEEKS - 1));
  // Pad the query range by a day on each side; exact bucketing uses timestamps below.
  const from = addDays(first, -1);
  const to = addDays(now, 1);

  const weeks = [];
  for (let i = 0; i < WEEKS; i++) {
    weeks.push({ start: ymd(addDays(first, 7 * i)), created: 0, merged: 0, reviewed: 0, additions: 0, deletions: 0, prs: { created: [], merged: [], reviewed: [] } });
  }
  const bucket = (ts) => {
    if (!ts) return null;
    const d = new Date(ts);
    if (d < first) return null;
    return weeks[Math.floor((weekStart(d) - first) / (7 * 86400000) + 0.5)] || null; // +0.5 absorbs DST shifts
  };
  const brief = (pr) => ({ repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url, additions: pr.additions, deletions: pr.deletions, state: pr.state, branch: pr.headRefName });

  const created = await searchAll(`is:pr author:${LOGIN}`, 'created', from, to);
  for (const pr of created) {
    const w = bucket(pr.createdAt);
    if (w) { w.created++; w.prs.created.push(brief(pr)); }
  }

  // Lines count toward the week a PR merged, so they reflect code that shipped.
  const merged = await searchAll(`is:pr is:merged author:${LOGIN}`, 'merged', from, to);
  for (const pr of merged) {
    const w = bucket(pr.mergedAt);
    if (w) { w.merged++; w.additions += pr.additions; w.deletions += pr.deletions; w.prs.merged.push(brief(pr)); }
  }

  // A reviewed PR counts once in each week you submitted a review on it. Search can't
  // filter by review date, so pull everything updated since the window opened and read
  // your review timestamps off each PR.
  const reviewed = await searchAll(
    `is:pr reviewed-by:${LOGIN} -author:${LOGIN}`, 'updated', from, to,
    `reviews(last: 30, author: "${LOGIN}") { nodes { submittedAt } }`,
  );
  for (const pr of reviewed) {
    const seen = new Set();
    for (const r of pr.reviews?.nodes || []) {
      const w = bucket(r.submittedAt);
      if (w && !seen.has(w)) { seen.add(w); w.reviewed++; w.prs.reviewed.push(brief(pr)); }
    }
  }

  stats = { login: LOGIN, updatedAt: new Date().toISOString(), rateRemaining, weeks };
  lastError = null;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(stats));
  console.log(`[${new Date().toLocaleTimeString()}] refreshed: ${created.length} created, ${merged.length} merged, ${reviewed.length} reviewed; ${rateRemaining} GraphQL points left`);
}

function refreshSafe() {
  if (!refreshing) {
    refreshing = refresh()
      .catch((e) => { lastError = String(e.message || e); console.error(lastError); })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Attach your PR for each checkout's branch, from the PRs already pulled for the stats.
function withPRs(checkouts) {
  const byBranch = new Map();
  for (const w of stats?.weeks || []) {
    for (const pr of w.prs.created) if (pr.branch) byBranch.set(`${pr.repo}:${pr.branch}`, pr);
  }
  return checkouts.map((c) => ({ ...c, pr: (c.branch && byBranch.get(`${c.repo}:${c.branch}`)) || null }));
}

// Open pages listen here so a branch switch shows up right away instead of on the next poll.
const listeners = new Set();
watchCheckouts(async () => {
  if (!listeners.size) return;
  const msg = `event: checkouts\ndata: ${JSON.stringify(withPRs(await readCheckouts()))}\n\n`;
  for (const res of listeners) res.write(msg);
});

const INDEX = path.join(__dirname, 'index.html');
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/stats')) {
    if (!stats) await refreshSafe();
    const checkouts = await withPRs(await readCheckouts());
    res.writeHead(stats ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...stats, checkouts, error: lastError, refreshing: !!refreshing, refreshMs: REFRESH_MS }));
  } else if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
  } else if (req.url === '/api/refresh' && req.method === 'POST') {
    await refreshSafe();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !lastError, error: lastError }));
  } else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX).pipe(res);
  } else if (req.url === '/favicon.svg' || req.url === '/favicon.ico') {
    // Browsers ask for /favicon.ico on their own; answer both with the SVG.
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(path.join(__dirname, 'favicon.svg')).pipe(res);
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`gh-stat for ${LOGIN}: http://localhost:${PORT}`);
  refreshSafe();
  setInterval(refreshSafe, REFRESH_MS);
});
