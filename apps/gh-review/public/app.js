// The whole queue page. No framework: one list and a side panel, keyboard first, redrawn from `state` on every change.
import { findStacks, groupStacks } from './stacks.js';

const SORTS = {
  oldest: { label: 'Waiting longest', fn: (a, b) => a.requestedAt.localeCompare(b.requestedAt) },
  smallest: { label: 'Smallest', fn: (a, b) => a.additions + a.deletions - (b.additions + b.deletions) },
  newest: { label: 'Newest', fn: (a, b) => b.requestedAt.localeCompare(a.requestedAt) },
};

const stored = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

const state = {
  prs: [],
  skipped: {},
  actions: [],
  runs: [],
  viewer: '',
  fetchedAt: null,
  error: null,
  loading: true,
  sort: stored('sort') ?? 'oldest',
  directOnly: stored('directOnly') === '1',
  showSkipped: false,
  done: [], // { pr, reason, doneAt }, newest first
  reviews: {}, // url -> { minutes, color, reason, headSha, override } from the newest local review run
  reviewing: new Set(), // urls with a review run going, started from here
  live: {}, // url -> { id, done, total, running, left } for every review run going now, wherever it was started
  showDone: false,
  filter: '',
  selected: sessionStorage.getItem('selected'), // PR url; kept so Back from a PR page lands on the same row
  picked: [], // urls picked with space, J or a; actions apply to these instead of the selected row
  history: [], // [{ kind: 'skip' | 'done', prs }] for u, newest last
  status: '',
  help: false,
  theme: document.documentElement.dataset.theme ?? 'dark',
  railSide: stored('railSide') ?? 'right',
  notify: stored('notify') === '1' && 'Notification' in window && Notification.permission === 'granted',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function age(iso) {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (m < 60) return `${Math.max(1, Math.floor(m))}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 20160) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

const kilo = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const avatar = (login, size = 48) => `background-image:url(https://github.com/${encodeURIComponent(login)}.png?size=${size})`;

// "feat(api): do a thing" shows as "do a thing", with "feat(api)" in the panel.
function splitTitle(title) {
  const m = title.match(/^(\w+(?:\([^)]*\))?!?):\s*(.+)$/);
  return m ? { kind: m[1], subject: m[2] } : { kind: '', subject: title };
}

// Mirrors parsePRRef in src/github.ts: a PR link, owner/repo#123, or a bare number in your default repo.
function importRef(text) {
  const t = text.trim();
  const link = t.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (link) return { url: `https://github.com/${link[1]}/${link[2]}/pull/${link[3]}`, label: `${link[2]}#${link[3]}` };
  const ref = t.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (ref) return { url: `https://github.com/${ref[1]}/${ref[2]}/pull/${ref[3]}`, label: `${ref[2]}#${ref[3]}` };
  const num = t.match(/^#?(\d+)$/);
  const repo = state.defaultRepo;
  return num && repo ? { url: `https://github.com/${repo}/pull/${num[1]}`, label: `${repo.split('/')[1]}#${num[1]}` } : null;
}

// Whether the PR has the label from your config that says a bug pass already ran.
const bugPassed = (p) => !!state.reviewedLabel && p.labels.includes(state.reviewedLabel);

// What the filter would import, when it names a PR that isn't already in the queue.
function importable() {
  if (state.showDone) return null;
  const ref = importRef(state.filter);
  return ref && !state.prs.some((p) => p.url === ref.url && !doneEntry(p)) ? ref : null;
}

// A PR you set aside stays aside until it changes on GitHub.
const isSkipped = (p) => state.skipped[p.url] && state.skipped[p.url] >= p.updatedAt;

// Done holds until someone asks for your review again after the time it went there.
const doneEntry = (p) => state.done.find((d) => d.pr.url === p.url && d.doneAt >= p.requestedAt);

const queued = () => state.prs.filter((p) => !doneEntry(p) && !isSkipped(p));

const matches = (p) => {
  const q = state.filter.trim().toLowerCase();
  return !q || [p.title, p.repo, `#${p.number}`, p.author, ...p.labels, ...(p.requestedVia === 'direct' ? [] : p.requestedVia)].some((s) => s.toLowerCase().includes(q));
};

function doneRows() {
  return state.done
    .filter((d) => {
      const live = state.prs.find((p) => p.url === d.pr.url);
      return !live || doneEntry(live);
    })
    .map((d) => ({ ...(state.prs.find((p) => p.url === d.pr.url) ?? d.pr), done: d }))
    .filter(matches);
}

function visible() {
  if (state.showDone) {
    const all = doneRows();
    return { active: all, aside: [], activeSections: all.map((p) => ({ rows: [p] })), asideSections: [], stacks: new Map(), all };
  }
  // Drafts sink below ready PRs in every sort: they want early eyes, not a sign-off.
  const rows = state.prs
    .filter((p) => !doneEntry(p) && matches(p) && (!state.directOnly || p.requestedVia === 'direct'))
    .sort((a, b) => a.isDraft - b.isDraft || SORTS[state.sort].fn(a, b));
  // Stacks come from every PR, so a filter or a set-aside layer doesn't change what a stack is.
  const stacks = findStacks(state.prs);
  const activeSections = groupStacks(rows.filter((p) => !isSkipped(p)), stacks);
  const asideSections = groupStacks(rows.filter(isSkipped), stacks);
  // j/k walk rows in the order they're drawn, stacks included.
  const active = activeSections.flatMap((s) => s.rows);
  const aside = asideSections.flatMap((s) => s.rows);
  return { active, aside, activeSections, asideSections, stacks, all: state.showSkipped ? [...active, ...aside] : active };
}

const REVIEW_WORD = { APPROVED: 'you approved', CHANGES_REQUESTED: 'you requested changes', COMMENTED: 'you commented', DISMISSED: 'your review was dismissed' };

// What's already happened on a PR, shortest first. The Status column and the panel both read this.
function flags(p) {
  const out = [];
  for (const r of state.runs.filter((r) => r.prUrl === p.url)) {
    out.push(`${r.label.replace(/\?$/, '').toLowerCase()} ${r.status === 'running' ? 'running' : r.status}`);
  }
  const live = state.live[p.url];
  if (live) out.push(`review ${live.done}/${live.total}${live.left > 5 ? ` · ~${mins(live.left)} left` : ''}`);
  else if (state.reviewing.has(p.url)) out.push('review starting');
  if (p.done) out.push(p.done.reason, ...(p.state && p.state !== 'OPEN' ? [p.state.toLowerCase()] : []));
  else {
    if (p.state && p.state !== 'OPEN') out.push(p.state.toLowerCase());
    if (p.reviewDecision === 'APPROVED') out.push('approved');
    if (p.reviewDecision === 'CHANGES_REQUESTED') out.push('changes requested');
    if (p.myReview === 'COMMENTED') out.push('you commented');
    if (bugPassed(p)) out.push('bug pass');
    if (p.imported) out.push('imported');
    if (p.requestedVia !== 'direct') out.push(`via ${p.requestedVia.join(', ') || 'a team'}`);
  }
  return out;
}
// "~3m", or "~40s" under a minute, for the time a review run has left.
const mins = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

const busy = (p) => !!state.live[p.url] || state.reviewing.has(p.url) || state.runs.some((r) => r.prUrl === p.url && r.status === 'running');

// The review run's color, with your override winning. A run on an older head is stale.
function signalOf(p) {
  const r = state.reviews[p.url];
  const color = r?.override ?? r?.color;
  if (!color) return null;
  const stale = !r.override && r.headSha && p.headSha && r.headSha !== p.headSha;
  const reason = r.override ? `your call${r.color && r.color !== r.override ? ` (run said ${r.color})` : ''}` : r.reason ?? '';
  return { color, reason, stale, minutes: r.minutes };
}

const CI = { success: ['pass', 'passing'], failure: ['fail', 'failing'], pending: ['run', 'running'] };

// A thin bar under a running review's status, filled by steps done.
function livebar(p) {
  const l = state.live[p.url];
  return l ? `<span class="livebar"><i style="width:${Math.round((l.done / Math.max(1, l.total)) * 100)}%"></i></span>` : '';
}

function row(p, stack) {
  const { subject } = splitTitle(p.title);
  const sig = signalOf(p);
  const st = flags(p);
  const picked = state.picked.includes(p.url);
  // Only red and yellow earn space in the row; green is the normal case and shows in the panel.
  const badge = sig && sig.color !== 'green' ? `<span class="sig ${sig.color}${sig.stale ? ' stale' : ''}" title="${esc(sig.reason)}">${sig.color}</span>` : '';
  const ci = CI[p.ci];
  return `
  <div class="row grid${picked ? ' picked' : ''}${isSkipped(p) ? ' aside' : ''}" role="option" data-url="${esc(p.url)}" aria-selected="${p.url === state.selected}">
    <span class="check" title="Select  space" data-pick>${picked ? '✓' : ''}</span>
    <span class="av" title="@${esc(p.author)}" style="${avatar(p.author)}"></span>
    <span class="pr">${badge}<span class="subject ell" title="${esc(p.title)}">${esc(subject)}</span>${stack ? `<span class="tag mono">${stack.index + 1}/${stack.size}</span>` : ''}${p.isDraft ? '<span class="tag">draft</span>' : ''}</span>
    <span class="status ell${busy(p) ? ' busy' : ''}" title="${esc(st.join(' · '))}">${state.live[p.url] ? '<i class="spin"></i>' : ''}${esc(st.join(' · ') || '—')}${livebar(p)}</span>
    <span class="cm r">${p.comments ?? 0}</span>
    <span class="size r mono"><span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span></span>
    <span class="ci ${p.ci ?? ''}" title="${ci ? `CI ${ci[1]}` : 'no CI'}"><i></i>${ci?.[0] ?? '—'}</span>
    <span class="age r" title="${p.done ? `done ${new Date(p.done.doneAt).toLocaleString()}` : `review requested ${new Date(p.requestedAt).toLocaleString()}`}">${age(p.done ? p.done.doneAt : p.requestedAt)}</span>
  </div>`;
}

// A layer of a stack that isn't in the list right now: one quiet line saying why.
function layerLine(e, stack) {
  const inList = state.prs.find((p) => p.url === e.url);
  const why =
    e.state === 'MERGED' ? 'merged'
    : e.state === 'CLOSED' ? 'closed'
    : inList && isSkipped(inList) ? 'set aside'
    : inList && doneEntry(inList) ? 'done'
    : inList ? 'hidden by the filter'
    : REVIEW_WORD[e.myReview] ?? 'not asking you';
  return `<div class="layer grid" data-open="${esc(e.url)}" title="open on GitHub"><span></span><span class="pos mono">${e.position}/${stack.size}</span><span class="ell"><span class="mono">#${e.number}</span>  ${esc(e.title)}</span><span class="why ell">${why}${e.isDraft ? ' · draft' : ''}</span></div>`;
}

function drawSections(sections, stacks) {
  return sections
    .map(({ stack, rows }) => {
      if (!stack) return row(rows[0]);
      const asking = stack.entries ? state.prs.filter((p) => stacks.get(p.url)?.id === stack.id && !doneEntry(p)).length : rows.length;
      const bits = ['bottom first'];
      if (stack.entries) bits.push(`${asking} asking you`);
      else if (rows.length < stack.size) bits.push(`${rows.length} shown`);
      if (stack.base && stack.base !== rows[0].defaultBranch) bits.push(`on top of <span class="mono">${esc(stack.base)}</span>`);
      const byUrl = new Map(rows.map((p) => [p.url, p]));
      // GitHub's stacks list every layer, so the ones not in this list show as quiet lines for context.
      const body = stack.entries
        ? [...stack.entries].sort((a, b) => a.position - b.position).map((e) => (byUrl.has(e.url) ? row(byUrl.get(e.url), stacks.get(e.url)) : layerLine(e, stack))).join('')
        : rows.map((p) => row(p, stacks.get(p.url))).join('');
      return `<div class="stack" role="group" aria-label="stack of ${stack.size} PRs"><div class="stack-head"><b>Stack of ${stack.size}</b><span>${bits.join(' · ')}</span></div>${body}</div>`;
    })
    .join('');
}

const HEAD = `<div class="head grid cap"><span></span><span></span><span>Pull request</span><span class="status">Status</span><span class="cm r" title="Comments">Cm</span><span class="size r">Size</span><span>CI</span><span class="r">Age</span></div>`;

// A 5xx is GitHub timing out, not your login, so only point at the token for auth errors.
const errorHint = (err) =>
  /HTTP 5\d\d|timed? ?out/i.test(err) ? 'GitHub timed out or had a hiccup. Press <kbd>r</kbd> to try again.'
  : /HTTP 401|token|auth|login/i.test(err) ? 'Your gh login looks expired. Run <code>gh auth refresh -h github.com</code>, then press <kbd>r</kbd>.'
  : 'Press <kbd>r</kbd> to try again.';

function renderList(v) {
  const { aside, activeSections, asideSections, stacks, all } = v;
  const list = $('#list');
  if (state.error && !state.prs.length) {
    list.innerHTML = `<div class="empty">Couldn't load your review queue<br><pre>${esc(state.error)}</pre><div>${errorHint(state.error)}</div></div>`;
  } else if (state.loading && !state.prs.length) {
    list.innerHTML = `<div class="empty">Loading your review requests…</div>`;
  } else if (state.showDone) {
    const head = `<div class="section cap">Done, newest first <span style="text-transform:none"><kbd>v</kbd> back to the queue</span></div>`;
    list.innerHTML = HEAD + head + (all.length ? drawSections(activeSections, stacks) : `<div class="empty"><b>0</b>Nothing done yet. PRs you approve or request changes on land here, and <kbd>e</kbd> marks one done by hand.</div>`);
  } else if (!all.length) {
    const imp = importable();
    list.innerHTML = `<div class="empty"><b>0</b>${imp ? `Nothing matches. Press <kbd>↵</kbd> or Import to pull ${esc(imp.label)} into the queue.` : state.filter ? 'Nothing matches that filter. Press <kbd>esc</kbd> to clear it.' : `Nothing waiting on your review.${aside.length && !state.showSkipped ? ` ${aside.length} set aside, <kbd>h</kbd> shows them.` : ''}`}</div>`;
  } else {
    let html = HEAD + drawSections(activeSections, stacks);
    if (state.showSkipped && aside.length) html += `<div class="section cap">Set aside until they change</div>` + drawSections(asideSections, stacks);
    else if (aside.length) html += `<div class="section cap">${aside.length} set aside <span style="text-transform:none"><kbd>h</kbd> to show</span></div>`;
    const done = doneRows().length;
    if (done) html += `<div class="section cap">${done} done <span style="text-transform:none"><kbd>v</kbd> to show</span></div>`;
    list.innerHTML = html;
  }
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

// Buckets for the panel's bar charts. Each bar is scaled to the biggest bucket.
function bars(buckets, mono = false) {
  const max = Math.max(1, ...buckets.map(([, n]) => n));
  return buckets
    .map(([label, n]) => `<div class="bars"><span${mono ? ' class="mono" style="font-size:12px"' : ''}>${esc(label)}</span><span class="track"><i style="width:${(n / max) * 100}%"></i></span><span class="r">${n}</span></div>`)
    .join('');
}

function inspector(v) {
  const targets = actionTargets();
  const multi = state.picked.length > 1;
  const p = multi ? null : targets[0];
  const acts = actionList(multi);
  const buttons = `<div class="actions">${acts.map((a, i) => `<button data-act="${i}">${esc(multi ? `${a.label} (${state.picked.length})` : a.label)}<kbd>${esc(a.key)}</kbd></button>`).join('')}</div>`;
  if (multi) {
    const rows = state.picked.map((u) => state.prs.find((x) => x.url === u)).filter(Boolean);
    return `<section class="insp"><div class="top cap"><span>${state.picked.length} selected</span><span class="mono">esc clears</span></div>
      <div class="picks">${rows.map((x) => `<span><span class="mono">#${x.number}</span><span class="ell">${esc(splitTitle(x.title).subject)}</span></span>`).join('')}</div>${buttons}</section>`;
  }
  if (!p) return `<section class="insp"><div class="top cap"><span>Selected</span></div><div class="status">Nothing selected</div></section>`;
  const { kind, subject } = splitTitle(p.title);
  const sig = signalOf(p);
  const stack = v.stacks.get(p.url);
  const ci = CI[p.ci];
  const facts = [
    kind && ['Type', `<span class="mono">${esc(kind)}</span>`],
    [p.done ? 'Done' : 'Asked', `${age(p.done ? p.done.doneAt : p.requestedAt)} ago`],
    ['Size', `<span class="mono"><span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span></span> <span class="status">${plural(p.changedFiles, 'file')}</span>`],
    ['CI', `<span class="ci ${p.ci ?? ''}" style="display:inline">${ci?.[1] ?? 'none'}</span>`],
    ['Comments', p.comments ?? 0],
    ['Status', esc(flags(p).join(' · ') || '—')],
    state.live[p.url] && ['Review', `<span class="busy">Run ${state.live[p.url].id} · ${state.live[p.url].done} of ${state.live[p.url].total} steps${state.live[p.url].left > 5 ? ` · about ${mins(state.live[p.url].left)} left` : ''}</span>${state.live[p.url].running.length ? `<span class="status"> · ${esc(state.live[p.url].running.join(', '))}</span>` : ''}`],
    stack && ['Stack', `Part ${stack.index + 1} of ${stack.size}`],
    sig?.minutes && ['Estimate', `${sig.minutes === 90 ? '90+' : sig.minutes}m`],
  ].filter(Boolean);
  const color = sig && `${sig.color[0].toUpperCase()}${sig.color.slice(1)}`;
  return `<section class="insp"><div class="top cap"><span>Selected</span><span class="mono">${esc(p.repo.split('/')[1])}#${p.number}</span></div>
    <span class="subject">${esc(subject)}</span>
    <span class="who"><span class="av" style="${avatar(p.author, 40)}"></span><span>@${esc(p.author)}</span></span>
    ${sig ? `<div class="signal ${sig.color}${sig.stale ? ' stale' : ''}" title="${sig.stale ? 'from a run on an older commit' : ''}">${color}${sig.reason ? ` · ${esc(sig.reason)}` : ''}</div>` : ''}
    <dl class="facts">${facts.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>${buttons}</section>`;
}

function renderRail(v) {
  const q = queued();
  const now = Date.now();
  const today = new Date().toDateString();
  const cleared = state.done.filter((d) => new Date(d.doneAt).toDateString() === today).length;
  const oldest = q.reduce((o, p) => (!o || p.requestedAt < o ? p.requestedAt : o), null);
  const lines = q.reduce((n, p) => n + p.additions + p.deletions, 0);
  const stackIds = new Set(q.map((p) => v.stacks.get(p.url)?.id).filter(Boolean));
  const days = (p) => (now - Date.parse(p.requestedAt)) / 864e5;
  const size = (p) => p.additions + p.deletions;
  const count = (f) => q.filter(f).length;
  const authors = Object.entries(q.reduce((m, p) => ((m[p.author] = (m[p.author] ?? 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  $('#rail').innerHTML = `${inspector(v)}
    <section class="stats"><div><b>${cleared}</b><span>cleared today</span></div><div><b>${oldest ? age(oldest) : '—'}</b><span>oldest</span></div><div><b>${kilo(lines)}</b><span>lines</span></div><div><b>${stackIds.size}</b><span>stacks</span></div></section>
    <section><span class="cap">Waiting</span>${bars([
      ['Today', count((p) => days(p) < 1)],
      ['This week', count((p) => days(p) >= 1 && days(p) < 7)],
      ['1–4 weeks', count((p) => days(p) >= 7 && days(p) < 28)],
      ['Older', count((p) => days(p) >= 28)],
    ])}</section>
    <section><span class="cap">Size</span>${bars(
      [
        ['< 100', count((p) => size(p) < 100)],
        ['100–500', count((p) => size(p) >= 100 && size(p) < 500)],
        ['500–1k', count((p) => size(p) >= 500 && size(p) < 1000)],
        ['1k +', count((p) => size(p) >= 1000)],
      ],
      true,
    )}</section>
    <section><span class="cap">Already moving</span>
      ${state.reviewedLabel ? `<div class="kv"><span>Bug pass done</span><span>${count(bugPassed)}</span></div>` : ''}
      <div class="kv"><span>Already approved</span><span>${count((p) => p.reviewDecision === 'APPROVED')}</span></div>
      <div class="kv"><span>You commented</span><span>${count((p) => p.myReview === 'COMMENTED')}</span></div>
      <div class="kv"><span>Review runs</span><span>${count((p) => state.reviews[p.url]?.reviewId || state.reviewing.has(p.url))}</span></div></section>
    <section><span class="cap">Authors</span>${authors
      .map(([name, n]) => `<div class="kv"><span class="who"><span class="av" style="${avatar(name, 40)}"></span><span class="ell">${esc(name)}</span></span><span>${n}</span></div>`)
      .join('')}</section>`;
}

function render() {
  const v = visible();
  const { active, all } = v;
  if (!all.some((p) => p.url === state.selected)) state.selected = all[0]?.url ?? null;
  // A pick that left the list (done, set aside, filtered out) shouldn't stay picked out of sight.
  state.picked = state.picked.filter((u) => all.some((p) => p.url === u));

  const waiting = queued().length;
  $('#count').textContent = state.loading && !state.prs.length ? '–' : state.showDone ? all.length : active.length;
  $('#count').nextElementSibling.textContent = state.showDone ? 'done' : 'waiting';
  document.title = waiting ? `(${waiting}) Review queue` : 'Review queue';
  const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const stale = state.error && state.prs.length;
  // A list over an hour old is dimmed while it refreshes, so last night's rows don't pass for current.
  const old = state.loading && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 60 * 60_000;
  $('#fetched').innerHTML = state.loading
    ? `<i class="spin"></i>${old ? `Refreshing, list is from ${esc(when)}` : 'Refreshing from GitHub…'}`
    : esc(stale ? `Couldn't refresh, showing ${when}` : when ? `Updated ${when}` : '');
  $('#fetched').title = stale ? state.error : '';
  $('#fetched').classList.toggle('stale', !!stale);
  document.body.classList.toggle('refreshing', state.loading);
  document.body.classList.toggle('old', !!old);
  $('#sorts').hidden = state.showDone;
  $('#sorts').innerHTML = Object.entries(SORTS)
    .map(([k, s]) => `<button data-sort="${k}" aria-pressed="${state.sort === k}">${s.label}</button>`)
    .join('');
  const imp = importable();
  $('#import').hidden = !imp;
  $('#import').title = imp ? `Pull ${imp.label} into the queue` : '';
  $('#direct').hidden = state.showDone;
  $('#direct').setAttribute('aria-pressed', state.directOnly);
  // Like the panel and theme buttons, this names what a click does.
  $('#notify').textContent = state.notify ? 'Stop notifying' : 'Notify me';
  $('#side').textContent = state.railSide === 'left' ? 'Panel right' : 'Panel left';
  $('#theme').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  document.body.classList.toggle('rail-left', state.railSide === 'left');

  renderList(v);
  renderRail(v);
  $('#status').textContent = state.status || (state.prs.length ? `Loaded ${plural(state.prs.length, 'PR')} from GitHub` : '');
  const footer = [['j k', 'move'], ['space', 'select'], ['a', 'all'], ['⇧R', 'review'], ['e', 'done'], ['x', 'aside'], ['u', 'undo'], ['/', 'filter'], ['s', 'sort'], ['v', state.showDone ? 'queue' : 'done'], ['?', 'keys']];
  $('#keys').innerHTML = footer.map(([k, t]) => `<span><kbd>${esc(k)}</kbd>${esc(t)}</span>`).join('');
  renderHelp();
}

// Several keys on one line are alternatives, so say "or" rather than letting them read as a chord.
const kbds = (keys) => keys.map((x) => `<kbd>${esc(x)}</kbd>`).join('<span class="or">or</span>');

// Every key the page answers to.
function allKeys() {
  return [
    [['j', '↓'], 'Next PR'],
    [['k', '↑'], 'Previous PR'],
    [['J'], 'Select this PR and move to the next'],
    [['space'], 'Select or unselect this PR (or click its checkbox). Done, set aside and the Claude actions then apply to every selected PR'],
    [['a'], 'Select every PR in the list, or none'],
    [['↵'], 'Open the PR page (a click does the same)'],
    [['o'], 'Open the PR on GitHub'],
    [['⇧R'], 'Run review on the PR'],
    ...state.actions.map((a) => [[`⇧${a.key.toUpperCase()}`], `${a.label.replace(/\?$/, '')} (runs ${a.command[0]} on the PR)`]),
    [['e'], 'Mark the PR done (or, in Done, put one you marked back)'],
    [['x'], 'Set the PR aside until it changes on GitHub'],
    [['u'], 'Undo the last set aside or done'],
    [['v'], 'Show Done: PRs you approved, requested changes on, or marked done'],
    [['h'], 'Show or hide set-aside PRs'],
    [['s'], 'Cycle the sort: waiting longest, smallest, newest'],
    [['d'], 'Show only PRs that asked you by name'],
    [['/'], 'Filter by title, repo, #number, author, label or team. A PR number or link that isn\'t in the queue can be imported'],
    [['esc'], 'Clear the selection, then the filter'],
    [['n'], 'Turn desktop notifications for new review requests on or off'],
    [['t'], 'Switch between dark and light'],
    [['[', ']'], 'Move the panel left or right'],
    [['m'], 'Go to My PRs, your own open PRs in a list of their own'],
    [['r'], 'Refresh from GitHub'],
    [['?'], 'Show or hide this list'],
  ];
}

function renderHelp() {
  let el = $('#help');
  if (!state.help) return el?.remove();
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', '<div id="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"></div>');
    el = $('#help');
    el.addEventListener('mousedown', (e) => e.target === el && ((state.help = false), renderHelp()));
  }
  el.innerHTML = `<div class="panel"><h2>Keyboard shortcuts</h2><dl>${allKeys()
    .map(([k, what]) => `<dt>${kbds(k)}</dt><dd>${esc(what)}</dd>`)
    .join('')}</dl></div>`;
}

const say = (msg) => ((state.status = msg), render());

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const apply = (res) =>
  Object.assign(state, { prs: res.prs, skipped: res.skipped, done: res.done ?? [], reviews: res.reviews ?? {}, live: res.live ?? state.live, actions: res.actions, viewer: res.viewer, reviewedLabel: res.reviewedLabel ?? null, defaultRepo: res.defaultRepo ?? null, fetchedAt: res.fetchedAt, error: res.error ?? null });

// Each request is keyed by when it was made, so being asked again on the same PR counts as new.
const requestKey = (p) => `${p.url} ${p.requestedAt}`;

// Tells you about review requests that weren't there on the last fetch. The first fetch only takes note.
function notifyNew() {
  const keys = state.prs.filter((p) => !p.imported).map(requestKey);
  const seen = stored('seenRequests');
  store('seenRequests', JSON.stringify(keys));
  if (!seen || !state.notify || Notification.permission !== 'granted') return;
  const old = new Set(JSON.parse(seen));
  const fresh = state.prs.filter((p) => !p.imported && !old.has(requestKey(p)) && !doneEntry(p) && !isSkipped(p));
  if (!fresh.length) return;
  const one = fresh.length === 1 ? fresh[0] : null;
  const n = new Notification(one ? `@${one.author} asked for your review` : `${fresh.length} new review requests`, {
    body: one ? `${one.repo.split('/')[1]}#${one.number} ${one.title}` : fresh.map((p) => `#${p.number} ${p.title}`).join('\n'),
    tag: 'gh-review',
    icon: '/favicon.svg',
  });
  n.onclick = () => {
    window.focus();
    state.selected = fresh[0].url;
    render();
    n.close();
  };
}

async function toggleNotify() {
  if (!('Notification' in window)) return say("This browser can't show notifications");
  if (!state.notify && Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') return say('Notifications are blocked for this page in the browser settings');
  }
  state.notify = !state.notify;
  store('notify', state.notify ? '1' : '0');
  say(state.notify ? "You'll get a desktop notification when someone asks for your review, while this tab is open" : 'Notifications off');
}

async function load() {
  state.loading = true;
  render();
  try {
    // Draw the saved copy first so the list is there right away, then replace it with GitHub's.
    if (!state.prs.length) apply(await fetch('/api/queue?cached=1').then((r) => r.json())), render();
    const res = await fetch('/api/queue').then((r) => r.json());
    if (res.prs) apply(res), res.error || notifyNew();
    else state.error = res.error;
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  render();
}

async function pollRuns() {
  const had = state.runs.some((r) => r.status === 'running') || state.reviewing.size || Object.keys(state.live).length;
  state.runs = await fetch('/api/runs').then((r) => r.json()).catch(() => state.runs);
  // Review runs started anywhere, the PR page included. An older server without /api/live just leaves this empty.
  const live = await fetch('/api/live').then((r) => (r.ok ? r.json() : {})).catch(() => state.live);
  const ended = Object.keys(state.live).some((u) => !live[u]);
  state.live = live;
  for (const u of Object.keys(live)) state.reviewing.delete(u);
  // Review runs live on the PR page's endpoint, so only ask about the ones started here.
  for (const url of state.reviewing) {
    const res = await fetch(`/api/reviews?url=${encodeURIComponent(url)}`).then((r) => r.json()).catch(() => null);
    if (res && !res.reviews.some((r) => r.status === 'running')) state.reviewing.delete(url);
  }
  if (ended || (had && !state.reviewing.size && !state.runs.some((r) => r.status === 'running') && !Object.keys(state.live).length)) {
    // Something just finished; pick up its color and estimate.
    const res = await fetch('/api/queue?cached=1').then((r) => r.json()).catch(() => null);
    if (res?.reviews) state.reviews = res.reviews;
  }
  if (had || ended || state.runs.some((r) => r.status === 'running') || Object.keys(state.live).length) render();
}

const current = () => visible().all.find((p) => p.url === state.selected);
const label = (prs) => (prs.length > 1 ? `${prs.length} PRs` : `#${prs[0].number}`);

// Picked rows win over the cursor, so a batch is one key press.
function actionTargets() {
  const { all } = visible();
  return state.picked.length ? state.picked.map((u) => all.find((p) => p.url === u)).filter(Boolean) : [current()].filter(Boolean);
}

function actionList(multi) {
  const list = [
    { label: 'Open PR page', key: '↵', run: () => openPage(), single: true },
    { label: 'Run review', key: '⇧R', run: () => review() },
    ...state.actions.map((a) => ({ label: a.label.replace(/\?$/, ''), key: `⇧${a.key.toUpperCase()}`, run: () => runAction(a) })),
    { label: state.showDone ? 'Put back' : 'Mark done', key: 'e', run: () => markDone() },
    ...(state.showDone ? [] : [{ label: 'Set aside', key: 'x', run: () => skip() }]),
    { label: 'Open on GitHub', key: 'o', run: () => open(), single: true },
  ];
  return multi ? list.filter((a) => !a.single) : list;
}

function move(delta) {
  const { all } = visible();
  const i = all.findIndex((p) => p.url === state.selected);
  const next = all[Math.max(0, Math.min(all.length - 1, i + delta))];
  if (next) state.selected = next.url;
  render();
}

function togglePick(url) {
  state.picked = state.picked.includes(url) ? state.picked.filter((u) => u !== url) : [...state.picked, url];
  render();
}

// After rows leave the list, land on the first row below where they were.
function moveOffOf(prs) {
  const { all } = visible();
  const gone = new Set(prs.map((p) => p.url));
  const start = all.findIndex((p) => p.url === (gone.has(state.selected) ? state.selected : prs[0].url));
  const rest = all.filter((p) => !gone.has(p.url));
  const next = all.slice(start).find((p) => !gone.has(p.url)) ?? rest[rest.length - 1];
  if (gone.has(state.selected)) state.selected = next?.url ?? null;
  state.picked = [];
}

const pagePath = (p) => `/pr/${p.repo}/${p.number}`;

function openPage(p = current()) {
  if (!p) return;
  sessionStorage.setItem('selected', p.url);
  // The PR page walks this list with j/k, so it matches what you see here.
  sessionStorage.setItem('order', JSON.stringify(visible().all.map((x) => x.url)));
  location.href = pagePath(p);
}

function open(p = current()) {
  if (!p) return;
  post('/api/open', { url: p.url });
  say(`Opened #${p.number} on GitHub`);
}

async function skip() {
  const prs = actionTargets();
  if (!prs.length || state.showDone) return;
  // Pressing x on a PR that's already aside (shown with h) brings it back.
  if (prs.length === 1 && isSkipped(prs[0])) {
    delete state.skipped[prs[0].url];
    say(`#${prs[0].number} is back in the queue`);
    return post('/api/skip', { url: prs[0].url, updatedAt: null });
  }
  if (!state.showSkipped) moveOffOf(prs);
  else state.picked = [];
  for (const p of prs) state.skipped[p.url] = p.updatedAt;
  state.history.push({ kind: 'skip', prs });
  say(`Set aside ${label(prs)} until ${prs.length > 1 ? 'they change' : 'it changes'} · u to undo`);
  await Promise.all(prs.map((p) => post('/api/skip', { url: p.url, updatedAt: p.updatedAt })));
}

async function markDone() {
  const prs = actionTargets();
  if (!prs.length) return;
  if (state.showDone) {
    const mine = prs.filter((p) => p.done?.reason === 'marked');
    if (!mine.length) return say(`You ${prs[0].done?.reason ?? 'reviewed'} #${prs[0].number} on GitHub, so it stays in Done`);
    moveOffOf(mine);
    state.done = state.done.filter((d) => !mine.some((p) => p.url === d.pr.url));
    say(`${label(mine)} back in the queue`);
    return Promise.all(mine.map((p) => post('/api/done', { url: p.url, done: false })));
  }
  moveOffOf(prs);
  const now = new Date().toISOString();
  const urls = new Set(prs.map((p) => p.url));
  state.done = [...prs.map(({ done: _, ...pr }) => ({ pr, reason: 'marked', doneAt: now })), ...state.done.filter((d) => !urls.has(d.pr.url))];
  state.history.push({ kind: 'done', prs });
  say(`${label(prs)} marked done · u to undo · v shows Done`);
  const res = await Promise.all(prs.map((p) => post('/api/done', { url: p.url, done: true })));
  const last = res[res.length - 1];
  if (last?.done) (state.done = last.done), render();
}

async function undo() {
  const last = state.history.pop();
  if (!last) return undoFromPage();
  const urls = new Set(last.prs.map((p) => p.url));
  state.selected = last.prs[0].url;
  if (last.kind === 'done') state.done = state.done.filter((d) => !urls.has(d.pr.url));
  else for (const u of urls) delete state.skipped[u];
  say(`${label(last.prs)} back in the queue`);
  await Promise.all([...urls].map((url) => (last.kind === 'done' ? post('/api/done', { url, done: false }) : post('/api/skip', { url, updatedAt: null }))));
}

// Done or set aside pressed on a PR page is undone here the same way.
async function undoFromPage() {
  const last = JSON.parse(sessionStorage.getItem('undo') ?? 'null');
  if (!last) return;
  sessionStorage.removeItem('undo');
  state.selected = last.url;
  if (last.kind === 'done') state.done = state.done.filter((d) => d.pr.url !== last.url);
  else delete state.skipped[last.url];
  say('Back in the queue');
  await (last.kind === 'done' ? post('/api/done', { url: last.url, done: false }) : post('/api/skip', { url: last.url, updatedAt: null }));
}

async function runAction(a) {
  const prs = actionTargets();
  if (!prs.length) return;
  state.picked = [];
  const res = await Promise.all(prs.map((p) => post('/api/action', { key: a.key, url: p.url })));
  const failed = res.find((r) => r.error);
  say(failed ? failed.error : `${a.label.replace(/\?$/, '')} started on ${label(prs)} · runs in the background`);
  pollRuns();
}

// The same review the PR page's Run review starts, without the optional checks.
async function review() {
  const prs = actionTargets();
  if (!prs.length) return;
  state.picked = [];
  for (const p of prs) state.reviewing.add(p.url);
  say(`Review started on ${label(prs)} · runs in the background`);
  const res = await Promise.all(prs.map((p) => post('/api/review', { url: p.url })));
  const failed = res.find((r) => r.error);
  if (failed) {
    prs.forEach((p, i) => res[i].error && state.reviewing.delete(p.url));
    say(failed.error);
  }
}

// Pull in a PR nobody asked you on, like one that merged before you got to it.
async function importPR() {
  const ref = importable();
  if (!ref) return;
  $('#import').disabled = true;
  say(`Importing ${ref.label}…`);
  const res = await post('/api/import', { ref: state.filter }).catch((e) => ({ error: e.message }));
  $('#import').disabled = false;
  if (res.error) return say(res.error);
  state.prs = [...state.prs.filter((p) => p.url !== res.pr.url), res.pr];
  // A PR you'd marked done before comes back now that you asked for it again.
  state.done = state.done.filter((d) => d.pr.url !== res.pr.url || d.doneAt >= res.pr.requestedAt);
  delete state.skipped[res.pr.url];
  $('#search').value = state.filter = '';
  $('#search').blur();
  state.selected = res.pr.url;
  say(`Imported ${ref.label}${res.pr.state === 'OPEN' ? '' : ` (${res.pr.state.toLowerCase()})`}`);
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  store('theme', theme);
  render();
}

function setSide(side) {
  state.railSide = side;
  store('railSide', side);
  render();
}

function setSort(sort) {
  state.sort = sort;
  store('sort', sort);
  render();
}

function toggleDirect() {
  state.directOnly = !state.directOnly;
  store('directOnly', state.directOnly ? '1' : '0');
  render();
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.help) {
    if (e.key === 'Escape' || e.key === '?') (e.preventDefault(), (state.help = false), renderHelp());
    return;
  }
  const search = $('#search');
  if (document.activeElement === search) {
    if (e.key === 'Escape') (search.value = ''), (state.filter = ''), search.blur(), render();
    if (e.key === 'Enter' && importable() && !visible().all.length) return e.preventDefault(), importPR();
    if (e.key === 'Enter' || e.key === 'ArrowDown') search.blur();
    return;
  }
  if (document.activeElement?.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) document.activeElement.blur();
  const action = state.actions.find((a) => a.key.toUpperCase() === e.key);
  if (action) return e.preventDefault(), runAction(action);
  const keymap = {
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    J: () => {
      const p = current();
      if (p && !state.picked.includes(p.url)) state.picked.push(p.url);
      move(1);
    },
    ' ': () => state.selected && togglePick(state.selected),
    a: () => {
      const { all } = visible();
      state.picked = state.picked.length === all.length ? [] : all.map((p) => p.url);
      render();
    },
    Enter: () => openPage(),
    o: () => open(),
    R: () => review(),
    x: () => skip(),
    e: () => markDone(),
    v: () => ((state.showDone = !state.showDone), (state.selected = null), (state.picked = []), render()),
    u: () => undo(),
    r: () => load(),
    m: () => (location.href = '/mine'),
    s: () => {
      const ks = Object.keys(SORTS);
      setSort(ks[(ks.indexOf(state.sort) + 1) % ks.length]);
    },
    d: () => toggleDirect(),
    h: () => ((state.showSkipped = !state.showSkipped), render()),
    n: () => toggleNotify(),
    t: () => setTheme(state.theme === 'dark' ? 'light' : 'dark'),
    '[': () => setSide('left'),
    ']': () => setSide('right'),
    Escape: () => {
      if (state.picked.length) (state.picked = []), render();
      else if (state.filter) (search.value = ''), (state.filter = ''), render();
    },
    '/': () => search.focus(),
    '?': () => ((state.help = true), renderHelp()),
  };
  const fn = keymap[e.key];
  if (fn) (e.preventDefault(), fn());
});

$('#search').addEventListener('input', (e) => ((state.filter = e.target.value), render()));
$('#sorts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (b) setSort(b.dataset.sort);
});
$('#direct').addEventListener('click', toggleDirect);
$('#notify').addEventListener('click', toggleNotify);
$('#import').addEventListener('click', (e) => (e.preventDefault(), importPR()));
$('#side').addEventListener('click', () => setSide(state.railSide === 'left' ? 'right' : 'left'));
$('#theme').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
$('#list').addEventListener('click', (e) => {
  const gh = e.target.closest('[data-open]');
  if (gh) return e.preventDefault(), post('/api/open', { url: gh.dataset.open });
  const r = e.target.closest('.row');
  if (!r) return;
  if (e.target.closest('[data-pick]')) return togglePick(r.dataset.url);
  state.selected = r.dataset.url;
  openPage(current());
});
$('#rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) actionList(state.picked.length > 1)[Number(b.dataset.act)]?.run();
});

// Refresh when you come back to the tab, and every few minutes while it sits open.
const comeBack = () => document.visibilityState === 'visible' && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 60_000 && !state.loading && load();
window.addEventListener('focus', comeBack);
// Focus doesn't fire for a tab switch or for opening the lid with the tab already in front.
document.addEventListener('visibilitychange', comeBack);
window.addEventListener('online', comeBack);
// Check more often while notifications are on, so a request shows up within a couple of minutes.
setInterval(() => (state.notify || !state.fetchedAt || Date.now() - Date.parse(state.fetchedAt) > 5 * 60_000) && !state.loading && load(), 2 * 60_000);
// Timers stop while the laptop sleeps, so a long gap between ticks means it just woke up.
let tick = Date.now();
setInterval(() => {
  if (Date.now() - tick > 60_000) comeBack();
  tick = Date.now();
}, 10_000);
setInterval(pollRuns, 3000);
// The PR page leaves a message when done or set aside brought you back here.
const pending = sessionStorage.getItem('toast');
if (pending) sessionStorage.removeItem('toast'), (state.status = pending);
load();
pollRuns();
