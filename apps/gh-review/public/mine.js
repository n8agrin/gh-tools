// My PRs: your own open PRs, with the same review tools as the queue but none of its state.
// It has its own fetch, cache and set-aside list, so nothing here changes what the review queue shows.
import { findStacks, groupStacks } from './stacks.js';

const state = {
  prs: [],
  aside: {},
  done: {}, // url -> { headSha, doneAt }
  actions: [],
  runs: [],
  reviews: {},
  live: {},
  reviewing: new Set(),
  fetchedAt: null,
  error: null,
  loading: true,
  filter: '',
  showAside: false,
  showDone: false,
  picked: [], // urls picked with space or a; done and set aside apply to these instead of the selected row
  selected: sessionStorage.getItem('mineSelected'),
  history: [],
  status: '',
  help: false,
  theme: document.documentElement.dataset.theme ?? 'dark',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const mins = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

function age(iso) {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (m < 60) return `${Math.max(1, Math.floor(m))}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 20160) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

const splitTitle = (title) => {
  const m = title.match(/^(\w+(?:\([^)]*\))?!?):\s*(.+)$/);
  return m ? { kind: m[1], subject: m[2] } : { kind: '', subject: title };
};

// Set aside holds until the PR changes on GitHub, the same rule as the review queue.
const isAside = (p) => state.aside[p.url] && state.aside[p.url] >= p.updatedAt;

// Done holds until a new commit lands, so a PR you've reviewed stays cleared through comments and CI.
const isDone = (p) => !!state.done[p.url] && state.done[p.url].headSha === p.headSha;

const matches = (p) => {
  const q = state.filter.trim().toLowerCase();
  return !q || [p.title, p.repo, `#${p.number}`, ...p.labels, ...p.waitingOn].some((s) => s.toLowerCase().includes(q));
};

function visible() {
  // Ready PRs first, newest activity first; drafts sink below them.
  const sorted = state.prs.filter(matches).sort((a, b) => a.isDraft - b.isDraft || b.updatedAt.localeCompare(a.updatedAt));
  const stacks = findStacks(state.prs);
  const doneCount = state.prs.filter(isDone).length;
  if (state.showDone) {
    const done = sorted.filter(isDone).sort((a, b) => state.done[b.url].doneAt.localeCompare(state.done[a.url].doneAt));
    return { active: done.map((p) => ({ rows: [p] })), aside: [], stacks, all: done, asideCount: 0, doneCount };
  }
  const rows = sorted.filter((p) => !isDone(p));
  const active = groupStacks(rows.filter((p) => !isAside(p)), stacks);
  const aside = groupStacks(rows.filter(isAside), stacks);
  const flat = (secs) => secs.flatMap((s) => s.rows);
  return { active, aside, stacks, all: state.showAside ? [...flat(active), ...flat(aside)] : flat(active), asideCount: flat(aside).length, doneCount };
}

// What's happening on the PR, as the status column and the panel show it.
function flags(p) {
  const out = [];
  for (const r of state.runs.filter((r) => r.prUrl === p.url)) out.push(`${r.label.replace(/\?$/, '').toLowerCase()} ${r.status}`);
  const live = state.live[p.url];
  if (live) out.push(`review ${live.done}/${live.total}${live.left > 5 ? ` · ~${mins(live.left)} left` : ''}`);
  else if (state.reviewing.has(p.url)) out.push('review starting');
  if (p.reviewDecision === 'APPROVED') out.push('approved');
  if (p.reviewDecision === 'CHANGES_REQUESTED') out.push('changes requested');
  if (p.waitingOn.length) out.push(`waiting on ${p.waitingOn.join(', ')}`);
  else if (!p.isDraft && p.reviewDecision !== 'APPROVED') out.push('no reviewer asked');
  if (state.reviewedLabel && p.labels.includes(state.reviewedLabel)) out.push('bug pass');
  return out;
}

const busy = (p) => !!state.live[p.url] || state.reviewing.has(p.url) || state.runs.some((r) => r.prUrl === p.url && r.status === 'running');
const CI = { success: ['pass', 'passing'], failure: ['fail', 'failing'], pending: ['run', 'running'] };

function row(p, stack) {
  const { subject } = splitTitle(p.title);
  const st = flags(p);
  const ci = CI[p.ci];
  const live = state.live[p.url];
  const bar = live ? `<span class="livebar"><i style="width:${Math.round((live.done / Math.max(1, live.total)) * 100)}%"></i></span>` : '';
  return `
  <div class="row grid${p.isDraft ? ' draft' : ''}${isAside(p) ? ' aside' : ''}${state.picked.includes(p.url) ? ' picked' : ''}" role="option" data-url="${esc(p.url)}" aria-selected="${p.url === state.selected}">
    <span class="check" title="Select  space" data-pick>${state.picked.includes(p.url) ? '✓' : ''}</span>
    <span class="state-dot" title="${p.isDraft ? 'Draft' : 'Ready for review'}"></span>
    <span class="repo mono" title="${esc(p.repo)}">${esc(p.repo.split('/')[1])}</span>
    <span class="pr">${p.isDraft ? '<span class="tag draft-tag">Draft</span>' : ''}<span class="subject ell" title="${esc(p.title)}">${esc(subject)}</span>${stack ? `<span class="tag mono">${stack.index + 1}/${stack.size}</span>` : ''}</span>
    <span class="status ell${busy(p) ? ' busy' : ''}" title="${esc(st.join(' · '))}">${live ? '<i class="spin"></i>' : ''}${esc(st.join(' · ') || '—')}${bar}</span>
    <span class="cm r">${p.comments ?? 0}</span>
    <span class="size r mono"><span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span></span>
    <span class="ci ${p.ci ?? ''}" title="${ci ? `CI ${ci[1]}` : 'no CI'}"><i></i>${ci?.[0] ?? '—'}</span>
    <span class="age r" title="${state.showDone ? `done ${new Date(state.done[p.url].doneAt).toLocaleString()}` : `updated ${new Date(p.updatedAt).toLocaleString()}`}">${age(state.showDone ? state.done[p.url].doneAt : p.updatedAt)}</span>
  </div>`;
}

function drawSections(sections, stacks) {
  return sections
    .map(({ stack, rows }) => {
      if (!stack) return row(rows[0]);
      const bits = ['bottom first'];
      if (rows.length < stack.size) bits.push(`${rows.length} open here`);
      return `<div class="stack" role="group" aria-label="stack of ${stack.size} PRs"><div class="stack-head"><b>Stack of ${stack.size}</b><span>${bits.join(' · ')}</span></div>${rows.map((p) => row(p, stacks.get(p.url))).join('')}</div>`;
    })
    .join('');
}

const HEAD = `<div class="head grid cap"><span></span><span></span><span>Repo</span><span>Pull request</span><span class="status">Status</span><span class="cm r" title="Comments">Cm</span><span class="size r">Size</span><span>CI</span><span class="r" title="Since the last update">Upd</span></div>`;

// A 5xx is GitHub timing out, not your login, so only point at the token for auth errors.
const errorHint = (err) =>
  /HTTP 5\d\d|timed? ?out/i.test(err) ? 'GitHub timed out or had a hiccup. Press <kbd>r</kbd> to try again.'
  : /HTTP 401|token|auth|login/i.test(err) ? 'Your gh login looks expired. Run <code>gh auth refresh -h github.com</code>, then press <kbd>r</kbd>.'
  : 'Press <kbd>r</kbd> to try again.';

function renderList(v) {
  const list = $('#list');
  if (state.error && !state.prs.length) {
    list.innerHTML = `<div class="empty">Couldn't load your PRs<br><pre>${esc(state.error)}</pre><div>${errorHint(state.error)}</div></div>`;
  } else if (state.loading && !state.prs.length) {
    list.innerHTML = `<div class="empty">Loading your PRs…</div>`;
  } else if (state.showDone) {
    const head = `<div class="section cap">Done until a new commit lands, newest first <span style="text-transform:none"><kbd>v</kbd> back to your PRs</span></div>`;
    list.innerHTML = HEAD + head + (v.all.length ? drawSections(v.active, v.stacks) : `<div class="empty"><b>0</b>${state.filter ? 'Nothing done matches that filter.' : 'Nothing done. <kbd>e</kbd> marks the selected PR done.'}</div>`);
  } else if (!v.all.length) {
    list.innerHTML = `<div class="empty"><b>0</b>${state.filter ? 'Nothing matches that filter. Press <kbd>esc</kbd> to clear it.' : `No open PRs of yours left.${v.asideCount ? ` ${v.asideCount} set aside, <kbd>h</kbd> shows them.` : ''}${v.doneCount ? ` ${v.doneCount} done, <kbd>v</kbd> shows them.` : ''}`}</div>`;
  } else {
    let html = HEAD + drawSections(v.active, v.stacks);
    if (state.showAside && v.asideCount) html += `<div class="section cap">Set aside until they change</div>` + drawSections(v.aside, v.stacks);
    else if (v.asideCount) html += `<div class="section cap">${v.asideCount} set aside <span style="text-transform:none"><kbd>h</kbd> to show</span></div>`;
    if (v.doneCount) html += `<div class="section cap">${v.doneCount} done <span style="text-transform:none"><kbd>v</kbd> to show</span></div>`;
    list.innerHTML = html;
  }
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

const current = () => visible().all.find((p) => p.url === state.selected);
const label = (prs) => (prs.length > 1 ? `${prs.length} PRs` : `#${prs[0].number}`);

// Picked rows win over the cursor, so a batch is one key press.
function targets() {
  const { all } = visible();
  return state.picked.length ? state.picked.map((u) => all.find((p) => p.url === u)).filter(Boolean) : [current()].filter(Boolean);
}

function actionList(multi = state.picked.length > 1) {
  if (multi) return [
    { label: state.showDone ? 'Put back' : 'Mark done', key: 'e', run: () => markDone() },
    ...(state.showDone ? [] : [{ label: 'Set aside', key: 'x', run: () => setAside() }]),
  ];
  return [
    { label: 'Open PR page', key: '↵', run: () => openPage() },
    { label: 'Run review', key: '⇧R', run: () => review() },
    ...state.actions.map((a) => ({ label: a.label.replace(/\?$/, ''), key: `⇧${a.key.toUpperCase()}`, run: () => runAction(a) })),
    { label: state.showDone ? 'Put back' : 'Mark done', key: 'e', run: () => markDone() },
    ...(state.showDone ? [] : [{ label: current() && isAside(current()) ? 'Bring back' : 'Set aside', key: 'x', run: () => setAside() }]),
    { label: 'Open on GitHub', key: 'o', run: () => openGitHub() },
  ];
}

function renderRail(v) {
  const p = current();
  const open = state.prs.filter((x) => !isAside(x) && !isDone(x));
  const count = (f) => open.filter(f).length;
  let insp = `<section class="insp"><div class="top cap"><span>Selected</span></div><div class="status">Nothing selected</div></section>`;
  if (state.picked.length > 1) {
    const rows = targets();
    const buttons = `<div class="actions">${actionList().map((a, i) => `<button data-act="${i}">${esc(`${a.label} (${rows.length})`)}<kbd>${esc(a.key)}</kbd></button>`).join('')}</div>`;
    insp = `<section class="insp"><div class="top cap"><span>${rows.length} selected</span><span class="mono">esc clears</span></div>
      <dl class="facts">${rows.map((x) => `<dt class="mono">#${x.number}</dt><dd class="ell">${esc(splitTitle(x.title).subject)}</dd>`).join('')}</dl>${buttons}</section>`;
  } else if (p) {
    const { kind, subject } = splitTitle(p.title);
    const stack = v.stacks.get(p.url);
    const live = state.live[p.url];
    const facts = [
      ['State', p.isDraft ? '<span class="draft-word">Draft</span>' : 'Ready for review'],
      kind && ['Type', `<span class="mono">${esc(kind)}</span>`],
      ['Opened', `${age(p.createdAt)} ago`],
      ['Updated', `${age(p.updatedAt)} ago`],
      isDone(p) && ['Done', `${age(state.done[p.url].doneAt)} ago, until a new commit`],
      ['Size', `<span class="mono"><span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span></span> <span class="status">${plural(p.changedFiles, 'file')}</span>`],
      ['CI', `<span class="ci ${p.ci ?? ''}" style="display:inline">${CI[p.ci]?.[1] ?? 'none'}</span>`],
      ['Reviewers', p.waitingOn.length ? esc(p.waitingOn.join(', ')) : 'nobody asked yet'],
      ['Comments', p.comments ?? 0],
      ['Status', esc(flags(p).join(' · ') || '—')],
      live && ['Review', `<span class="busy">Run ${live.id} · ${live.done} of ${live.total} steps${live.left > 5 ? ` · about ${mins(live.left)} left` : ''}</span>`],
      stack && ['Stack', `Part ${stack.index + 1} of ${stack.size}`],
    ].filter(Boolean);
    const buttons = `<div class="actions">${actionList().map((a, i) => `<button data-act="${i}">${esc(a.label)}<kbd>${esc(a.key)}</kbd></button>`).join('')}</div>`;
    insp = `<section class="insp"><div class="top cap"><span>Selected</span><span class="mono">${esc(p.repo.split('/')[1])}#${p.number}</span></div>
      <span class="subject">${esc(subject)}</span>
      <dl class="facts">${facts.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>${buttons}</section>`;
  }
  $('#rail').innerHTML = `${insp}
    <section class="stats"><div><b>${count((x) => !x.isDraft)}</b><span>ready</span></div><div><b>${count((x) => x.isDraft)}</b><span>drafts</span></div><div><b>${count((x) => x.reviewDecision === 'APPROVED')}</b><span>approved</span></div><div><b>${count((x) => x.ci === 'failure')}</b><span>CI failing</span></div></section>
    <section><span class="cap">Needs you</span>
      <div class="kv"><span>Changes requested</span><span>${count((x) => x.reviewDecision === 'CHANGES_REQUESTED')}</span></div>
      <div class="kv"><span>Ready, nobody asked</span><span>${count((x) => !x.isDraft && !x.waitingOn.length && x.reviewDecision !== 'APPROVED')}</span></div>
      ${state.reviewedLabel ? `<div class="kv"><span>No bug pass yet</span><span>${count((x) => !x.labels.includes(state.reviewedLabel))}</span></div>` : ''}</section>`;
}

const KEYS = [
  [['j', '↓'], 'Next PR'],
  [['k', '↑'], 'Previous PR'],
  [['↵'], 'Open the PR page (a click does the same)'],
  [['o'], 'Open the PR on GitHub'],
  [['⇧R'], 'Run review on the PR'],
  [['space'], 'Select or unselect this PR (or click its checkbox). Done and set aside then apply to every selected PR'],
  [['a'], 'Select every PR in the list, or none'],
  [['e'], 'Mark the PR done until a new commit lands (or, in Done, put it back)'],
  [['v'], 'Show the PRs you marked done, or go back'],
  [['x'], 'Set the PR aside until it changes at all, or bring it back'],
  [['u'], 'Undo the last done or set aside'],
  [['h'], 'Show or hide set-aside PRs'],
  [['/'], 'Filter by title, repo, #number, label or reviewer'],
  [['esc'], 'Clear the selection, then the filter'],
  [['q'], 'Go to the review queue'],
  [['b'], 'The same PRs as a board, one column per stage'],
  [['t'], 'Switch between dark and light'],
  [['r'], 'Refresh from GitHub'],
  [['?'], 'Show or hide this list'],
];

function renderHelp() {
  let el = $('#help');
  if (!state.help) return el?.remove();
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', '<div id="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"></div>');
    el = $('#help');
    el.addEventListener('mousedown', (e) => e.target === el && ((state.help = false), renderHelp()));
  }
  const keys = [...KEYS.slice(0, 5), ...state.actions.map((a) => [[`⇧${a.key.toUpperCase()}`], `${a.label.replace(/\?$/, '')} (runs ${a.command[0]} on the PR)`]), ...KEYS.slice(5)];
  el.innerHTML = `<div class="panel"><h2>Keyboard shortcuts</h2><dl>${keys.map(([k, what]) => `<dt>${k.map((x) => `<kbd>${esc(x)}</kbd>`).join('<span class="or">or</span>')}</dt><dd>${esc(what)}</dd>`).join('')}</dl></div>`;
}

function render() {
  const v = visible();
  if (!v.all.some((p) => p.url === state.selected)) state.selected = v.all[0]?.url ?? null;
  // A pick that left the list (done, set aside, filtered out) shouldn't stay picked out of sight.
  state.picked = state.picked.filter((u) => v.all.some((p) => p.url === u));
  const open = state.prs.filter((p) => !isAside(p) && !isDone(p));
  $('#count').textContent = state.loading && !state.prs.length ? '–' : state.showDone ? v.all.length : open.length;
  $('#count').nextElementSibling.textContent = state.showDone ? 'done' : 'open';
  document.title = open.length ? `(${open.length}) My PRs` : 'My PRs';
  const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const stale = state.error && state.prs.length;
  $('#fetched').textContent = state.loading ? 'Refreshing…' : stale ? `Couldn't refresh, showing ${when}` : when ? `Updated ${when}` : '';
  $('#fetched').title = stale ? state.error : '';
  $('#fetched').classList.toggle('stale', !!stale);
  $('#theme').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  $('#done').hidden = !state.picked.length;
  $('#done').textContent = `${state.showDone ? 'Put back' : 'Mark done'} (${state.picked.length})`;
  renderList(v);
  renderRail(v);
  const drafts = open.filter((p) => p.isDraft).length;
  $('#status').textContent = state.status || (state.prs.length ? `${plural(open.length, 'open PR')}${drafts ? `, ${drafts} of them ${drafts === 1 ? 'a draft' : 'drafts'}` : ''}` : '');
  const footer = [['j k', 'move'], ['space', 'select'], ['↵', 'open'], ['⇧R', 'review'], ['e', 'done'], ['x', 'aside'], ['u', 'undo'], ['v', state.showDone ? 'mine' : 'done'], ['/', 'filter'], ['b', 'board'], ['q', 'queue'], ['?', 'keys']];
  $('#keys').innerHTML = footer.map(([k, t]) => `<span><kbd>${esc(k)}</kbd>${esc(t)}</span>`).join('');
  renderHelp();
}

const say = (msg) => ((state.status = msg), render());

const apply = (res) => Object.assign(state, { prs: res.prs, aside: res.aside ?? {}, done: res.done ?? {}, actions: res.actions ?? [], reviewedLabel: res.reviewedLabel ?? null, reviews: res.reviews ?? {}, live: res.live ?? state.live, fetchedAt: res.fetchedAt, error: res.error ?? null });

async function load() {
  state.loading = true;
  render();
  try {
    if (!state.prs.length) apply(await fetch('/api/mine?cached=1').then((r) => r.json())), render();
    const res = await fetch('/api/mine').then((r) => r.json());
    if (res.prs) apply(res);
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
  state.live = await fetch('/api/live').then((r) => (r.ok ? r.json() : {})).catch(() => state.live);
  for (const u of Object.keys(state.live)) state.reviewing.delete(u);
  if (had || state.runs.some((r) => r.status === 'running') || Object.keys(state.live).length) render();
}

function move(delta) {
  const { all } = visible();
  const i = all.findIndex((p) => p.url === state.selected);
  const next = all[Math.max(0, Math.min(all.length - 1, i + delta))];
  if (next) state.selected = next.url;
  render();
}

function openPage(p = current()) {
  if (!p) return;
  sessionStorage.setItem('mineSelected', p.url);
  // The PR page walks this list with [ and ], and comes back here instead of the review queue.
  sessionStorage.setItem('order', JSON.stringify(visible().all.map((x) => x.url)));
  sessionStorage.setItem('back', '/mine');
  location.href = `/pr/${p.repo}/${p.number}`;
}

function openGitHub(p = current()) {
  if (!p) return;
  post('/api/open', { url: p.url });
  say(`Opened #${p.number} on GitHub`);
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

async function setAside() {
  const prs = targets();
  if (!prs.length || state.showDone) return;
  if (prs.length === 1 && isAside(prs[0])) {
    const [p] = prs;
    delete state.aside[p.url];
    say(`#${p.number} is back in the list`);
    return post('/api/mine/aside', { url: p.url, updatedAt: null });
  }
  if (!state.showAside) moveOffOf(prs);
  else state.picked = [];
  for (const p of prs) state.aside[p.url] = p.updatedAt;
  state.history.push({ kind: 'aside', prs });
  say(`Set aside ${label(prs)} until ${prs.length > 1 ? 'they change' : 'it changes'} · u to undo`);
  await Promise.all(prs.map((p) => post('/api/mine/aside', { url: p.url, updatedAt: p.updatedAt })));
}

// Local only, like set aside: nothing goes to GitHub.
async function markDone() {
  const prs = targets();
  if (!prs.length) return;
  moveOffOf(prs);
  if (state.showDone) {
    for (const p of prs) delete state.done[p.url];
    say(`${label(prs)} ${prs.length > 1 ? 'are' : 'is'} back in your PRs`);
    return Promise.all(prs.map((p) => post('/api/mine/done', { url: p.url, headSha: null })));
  }
  const doneAt = new Date().toISOString();
  for (const p of prs) state.done[p.url] = { headSha: p.headSha, doneAt };
  state.history.push({ kind: 'done', prs });
  say(`Done with ${label(prs)} until a new commit lands · u to undo`);
  await Promise.all(prs.map((p) => post('/api/mine/done', { url: p.url, headSha: p.headSha })));
}

async function undo() {
  const last = state.history.pop();
  if (!last) return undoFromPage();
  const { kind, prs } = last;
  for (const p of prs) delete state[kind][p.url];
  state.selected = prs[0].url;
  say(`${label(prs)} ${prs.length > 1 ? 'are' : 'is'} back in the list`);
  const path = kind === 'done' ? '/api/mine/done' : '/api/mine/aside';
  await Promise.all(prs.map((p) => post(path, kind === 'done' ? { url: p.url, headSha: null } : { url: p.url, updatedAt: null })));
}

// Set aside pressed on a PR page is undone here the same way.
async function undoFromPage() {
  const last = JSON.parse(sessionStorage.getItem('undo') ?? 'null');
  if (last?.kind !== 'mine-aside') return say('Nothing to undo');
  sessionStorage.removeItem('undo');
  delete state.aside[last.url];
  state.selected = last.url;
  say('Back in the list');
  await post('/api/mine/aside', { url: last.url, updatedAt: null });
}

async function runAction(a, p = current()) {
  if (!p) return;
  const res = await post('/api/action', { key: a.key, url: p.url });
  say(res.error ?? `${a.label.replace(/\?$/, '')} started on #${p.number} · runs in the background`);
  pollRuns();
}

async function review(p = current()) {
  if (!p) return;
  state.reviewing.add(p.url);
  say(`Review started on #${p.number} · runs in the background`);
  const res = await post('/api/review', { url: p.url });
  if (res.error) state.reviewing.delete(p.url), say(res.error);
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {}
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
    if (e.key === 'Enter' || e.key === 'ArrowDown') search.blur();
    return;
  }
  if (document.activeElement?.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) document.activeElement.blur();
  const action = state.actions.find((a) => a.key.toUpperCase() === e.key);
  if (action) return e.preventDefault(), runAction(action);
  const fn = {
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    Enter: () => openPage(),
    o: () => openGitHub(),
    R: () => review(),
    ' ': () => state.selected && togglePick(state.selected),
    a: () => {
      const { all } = visible();
      state.picked = state.picked.length === all.length ? [] : all.map((p) => p.url);
      render();
    },
    e: () => markDone(),
    v: () => ((state.showDone = !state.showDone), (state.selected = null), (state.picked = []), render()),
    x: () => setAside(),
    u: () => undo(),
    h: () => ((state.showAside = !state.showAside), render()),
    r: () => load(),
    q: () => (location.href = '/'),
    b: () => (location.href = '/board'),
    t: () => setTheme(state.theme === 'dark' ? 'light' : 'dark'),
    Escape: () => {
      if (state.picked.length) (state.picked = []), render();
      else if (state.filter) (search.value = ''), (state.filter = ''), render();
    },
    '/': () => search.focus(),
    '?': () => ((state.help = true), renderHelp()),
  }[e.key];
  if (fn) (e.preventDefault(), fn());
});

$('#search').addEventListener('input', (e) => ((state.filter = e.target.value), render()));
$('#done').addEventListener('click', () => markDone());
$('#theme').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
$('#list').addEventListener('click', (e) => {
  const r = e.target.closest('.row');
  if (!r) return;
  if (e.target.closest('[data-pick]')) return togglePick(r.dataset.url);
  state.selected = r.dataset.url;
  openPage(current());
});
$('#rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) actionList()[Number(b.dataset.act)]?.run();
});

window.addEventListener('focus', () => state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 60_000 && load());
setInterval(() => !state.loading && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 5 * 60_000 && load(), 60_000);
setInterval(pollRuns, 3000);
const pending = sessionStorage.getItem('toast');
if (pending) sessionStorage.removeItem('toast'), (state.status = pending);
load();
pollRuns();
