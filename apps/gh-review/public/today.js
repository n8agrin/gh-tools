// Today: everything where you hold the ball, one row each, most-waited-on first. The server builds
// the bands (src/today.ts); this page draws them and turns each row's one main button into a click or a key.

import { isRemote, openLink } from './open.js';

const state = {
  bands: [],
  counts: { waiting: 0, hunt: 0, hidden: 0 },
  fetchedAt: null,
  error: null,
  mentionsError: null,
  agentsError: null,
  /** Agent slots in use against the cap, when your config hands issues to an agent. */
  agents: null,
  /** Repos with test boxes, from your config: {repo: {name, label}}. */
  sessions: {},
  /** Each PR's box as last read: {url: {state, appUrl, endsAt, tunnel, at}}. */
  boxes: {},
  /** Run locally: repos it's set up for, and who holds the one slot. */
  local: { repos: [], slot: null },
  loading: true,
  selected: sessionStorage.getItem('todaySelected'),
  status: '',
  help: false,
  theme: document.documentElement.dataset.theme ?? 'dark',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

function age(iso) {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (m < 60) return `${Math.max(1, Math.floor(m))}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 20160) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

const ref = (r) => `${r.repo.split('/')[1]}${r.number ? `#${r.number}` : ''}`;
/** An issue row: an agent's question, or one ready to hand to an agent. */
const isIssue = (r) => r.next === 'answer' || r.next === 'start';
const rows = () => state.bands.flatMap((b) => b.rows);
const current = () => rows().find((r) => r.key === state.selected);
const say = (msg) => ((state.status = msg), render());

/** How long it's been: a review request has been waiting on you, your own PR since it last changed. */
const sinceText = (r) => (r.mine ? `updated ${age(r.since)} ago` : r.thread || r.next === 'answer' ? `${age(r.since)} ago` : r.next === 'start' ? `updated ${age(r.since)} ago` : `waiting on you ${age(r.since)}`);

/** Each row's one main button: its label, its key, and what it does. */
const PRIMARY = {
  brief: ['Open brief', '↵', (r) => openPage(r)],
  approve: ['Approve', 'A', (r) => approve(r)],
  merge: ['Merge on GitHub', '↵', (r) => openGitHub(r)],
  undraft: ['Mark ready on GitHub', '↵', (r) => openGitHub(r)],
  findings: ['See the findings', '↵', (r) => openPage(r)],
  unblock: ['Open on GitHub', '↵', (r) => openGitHub(r)],
  thread: ['Open thread', '↵', (r) => openThread(r)],
  answer: ['Answer on GitHub', '↵', (r) => openGitHub(r)],
  start: ['Start agent', 'S', (r) => startAgent(r)],
};

/** The other buttons on the selected row. Later features add theirs here. */
const boxCfg = (r) => (!r.thread && !isIssue(r) && state.sessions[r.repo]) || null;
const boxName = (cfg) => (cfg.name ? `Test on ${cfg.name}` : 'Start a test box');
const port = (u) => u?.match(/:(\d+)(?:\/|$)/)?.[1];

/** The test-box buttons for one row, by the box's state. Nothing here writes until you click. */
function boxButtons(r) {
  const cfg = boxCfg(r);
  if (!cfg) return '';
  const b = state.boxes[r.url];
  if (!b || b.loading) return `<button class="btn" type="button" disabled>${esc(cfg.name ? `Checking ${cfg.name}…` : 'Checking the test box…')}</button>`;
  if (b.error) return `<button class="btn" type="button" data-do="box-start">${esc(boxName(cfg))} <kbd>D</kbd></button><span class="since">${esc(b.error)}</span>`;
  if (b.state === 'booting') return `<button class="btn" type="button" disabled><i class="dot amber" aria-hidden="true"></i>Booting</button><button class="btn" type="button" data-do="box-stop">Cancel</button>`;
  if (b.state === 'ready') {
    const left = b.endsAt ? Math.max(0, Math.round((Date.parse(b.endsAt) - Date.now()) / 60000)) : null;
    const where = [port(b.appUrl) && `:${port(b.appUrl)}`, left !== null && `${left} min left`].filter(Boolean).join(' · ');
    return `<button class="btn primary" type="button" data-do="box-open"><i class="dot green" aria-hidden="true"></i>${b.opening ? 'Opening…' : 'Open'}${where ? ` <span class="mono">${esc(where)}</span>` : ''} <kbd>D</kbd></button><button class="btn" type="button" data-do="box-stop">Stop box</button>`;
  }
  return `<button class="btn" type="button" data-do="box-start">${esc(boxName(cfg))} <kbd>D</kbd></button>${b.state === 'ended' ? '<span class="since">last box ended</span>' : ''}`;
}

/** Run locally: one slot. This PR has it, another has it, or it's free. */
function localButtons(r) {
  if (r.thread || isIssue(r) || !state.local.repos.includes(r.repo)) return '';
  const s = state.local.slot;
  if (s?.url === r.url && s.running) {
    const since = new Date(s.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<button class="btn" type="button" aria-pressed="true" disabled>Running locally <span class="mono">since ${esc(since)}</span></button><button class="btn" type="button" data-do="local-release">Release slot</button>`;
  }
  if (s?.running) return `<button class="btn" type="button" data-do="local-take">Switch slot from ${esc(s.repo.split('/')[1])}#${s.number} <kbd>L</kbd></button>`;
  return `<button class="btn" type="button" data-do="local-take">Run locally <kbd>L</kbd></button>`;
}

function extras(r) {
  if (r.thread) return '<button class="btn" type="button" data-do="aside">Mark read <kbd>x</kbd></button>';
  if (r.next === 'start') return '<button class="btn" type="button" data-do="github">GitHub <kbd>o</kbd></button>';
  if (isIssue(r)) return '';
  const out = [boxButtons(r), localButtons(r)];
  if (!['brief', 'findings'].includes(r.next)) out.push('<button class="btn" type="button" data-do="page">PR page <kbd>p</kbd></button>');
  if (!['merge', 'undraft', 'unblock'].includes(r.next)) out.push('<button class="btn" type="button" data-do="github">GitHub <kbd>o</kbd></button>');
  out.push('<button class="btn" type="button" data-do="aside">Set aside <kbd>x</kbd></button>');
  return out.join('');
}

/** Start agent waits while every agent slot is taken; the server refuses it too. */
const full = (r) => r.next === 'start' && state.agents && state.agents.inFlight >= state.agents.cap;

function row(r) {
  const selected = r.key === state.selected;
  const primary = PRIMARY[r.next] ?? PRIMARY.unblock;
  const more = selected && r.decisions.length > 1
    ? `<div class="more"><p class="cap">Decisions the brief left for you</p><ol>${r.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ol></div>`
    : '';
  return `<div class="trow" role="option" data-key="${esc(r.key)}" aria-selected="${selected}">
    <span class="tag ${esc(r.tag)}">${esc(r.tag)}</span>
    <span class="ref mono">${esc(ref(r))}</span>
    <span class="ttl">${esc(r.title)}</span>
    <span class="since mono" title="${esc(new Date(r.since).toLocaleString())}">${esc(sinceText(r))}</span>
    ${full(r) ? `<button class="btn" type="button" disabled title="Land or close one first">All ${state.agents.cap} agent slots taken</button>` : `<button class="btn primary" type="button" data-do="primary">${esc(primary[0])} <kbd>${esc(primary[1])}</kbd></button>`}
    <div class="why">${esc(r.why)}</div>
    ${more}
    ${selected ? `<div class="acts">${extras(r)}</div>` : ''}
  </div>`;
}

function renderList() {
  const main = $('#today');
  if (state.error && !rows().length && !state.loading) {
    main.innerHTML = `<div class="wrap"><div class="empty">Couldn't load Today<br><pre>${esc(state.error)}</pre><div>Press <kbd>r</kbd> to try again.</div></div></div>`;
    return;
  }
  if (state.loading && !state.bands.length) {
    main.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
    return;
  }
  const bands = state.bands
    .map((b) => `<section class="band" data-band="${esc(b.key)}"><h2>${esc(b.label)} <span class="n">${b.rows.length}</span>${(b.key === 'mentions' && state.mentionsError) || ((b.key === 'agents' || b.key === 'start') && state.agentsError) ? `<span class="n warn" title="${esc(b.key === 'mentions' ? state.mentionsError : state.agentsError)}">couldn't refresh</span>` : ''}</h2>${b.rows.length ? `<div class="rows" role="listbox" aria-label="${esc(b.label)}">${b.rows.map(row).join('')}</div>` : '<div class="rows"><div class="none">Nothing here.</div></div>'}</section>`)
    .join('');
  const c = state.counts;
  const foot = [
    c.waiting ? `<a href="/board">${plural(c.waiting, 'PR')} waiting on others</a>` : '',
    c.hunt ? `<a href="/board">${c.hunt} without a bug pass</a>` : '',
    c.hidden ? `<span>${c.hidden} set aside or done</span>` : '',
    // Agents at work aren't yours to act on yet, so they're links here, not rows: the draft PR once there is one.
    ...(state.agents?.working ?? []).map((w) => `<a href="${esc(w.pr ?? w.url)}" target="_blank" rel="noopener" title="${esc(w.title)}">Agent on ${esc(w.repo.split('/')[1])}#${w.number}, ${age(w.startedAt)}${w.pr ? ', draft PR' : ''}</a>`),
  ].filter(Boolean);
  main.innerHTML = `<div class="wrap">${bands}${foot.length ? `<div class="foot">${foot.join('')}</div>` : ''}</div>`;
  main.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

const KEYS = [
  [['j', '↓'], 'Next row'],
  [['k', '↑'], 'Previous row'],
  [['↵'], "The row's main button"],
  [['A'], 'Approve, when the brief cleared it on this commit (asks first)'],
  [['D'], 'Start the test box, or open it once it is up (when your config has one for the repo)'],
  [['L'], 'Run the PR locally in the one local slot (asks before moving it from another PR)'],
  [['S'], 'Hand a Ready to start issue to the agent (asks first)'],
  [['p'], 'Open the PR page'],
  [['o'], 'Open the PR on GitHub'],
  [['x'], 'Set the row aside until the PR changes, or mark a mention read'],
  [['q'], 'Go to the review queue'],
  [['m'], 'Go to My PRs'],
  [['b'], 'Go to the board'],
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
  el.innerHTML = `<div class="panel"><h2>Keyboard shortcuts</h2><dl>${KEYS.map(([k, what]) => `<dt>${k.map((x) => `<kbd>${esc(x)}</kbd>`).join('<span class="or">or</span>')}</dt><dd>${esc(what)}</dd>`).join('')}</dl></div>`;
}

function render() {
  if (!rows().some((r) => r.key === state.selected)) state.selected = rows()[0]?.key ?? null;
  const n = rows().length;
  $('#count').textContent = state.loading && !state.bands.length ? '–' : n;
  document.title = n ? `(${n}) Today` : 'Today';
  const boxes = new Set(rows().filter((r) => boxCfg(r) && r.labels.includes(boxCfg(r).label)).map((r) => r.url)).size;
  $('#needs').innerHTML =
    state.bands.map((b) => `<span title="${esc(b.label)}"><b>${b.rows.length}</b>${esc(({ review: 'reviews', move: 'yours', agents: 'asking', mentions: 'mentions', start: 'to start' })[b.key] ?? b.key)}</span>`).join('') +
    (boxes ? `<span title="PRs with a test box label on"><b>${boxes}</b>${boxes === 1 ? 'box' : 'boxes'} up</span>` : '') +
    (state.agents ? `<span title="Issues queued for or held by an agent, of the most at once"><b>${state.agents.inFlight} of ${state.agents.cap}</b>agents working</span>` : '') +
    (state.local.slot?.running ? `<span title="The PR in the local slot">Local <b>${esc(state.local.slot.repo.split('/')[1])}#${state.local.slot.number}</b></span>` : '');
  const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const stale = state.error && n;
  $('#fetched').textContent = state.loading ? 'Refreshing…' : stale ? `Couldn't refresh, showing ${when}` : when ? `Updated ${when}` : '';
  $('#fetched').title = stale ? state.error : '';
  $('#fetched').classList.toggle('stale', !!stale);
  $('#theme').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  document.body.classList.toggle('refreshing', state.loading);
  renderList();
  $('#status').textContent = state.status || (n ? `${plural(n, 'thing')} need you · acting on a row takes it off the list` : state.loading ? '' : 'Nothing needs you right now.');
  const footer = [['j k', 'move'], ['↵', 'do it'], ['p', 'page'], ['o', 'github'], ['x', 'aside'], ['?', 'keys']];
  $('#keys').innerHTML = footer.map(([k, t]) => `<span><kbd>${esc(k)}</kbd>${esc(t)}</span>`).join('');
  renderHelp();
  // The selected row's box is read when you land on it, then kept fresh while it boots.
  readBox();
}

// A PR can sit in two bands (you review it and it's yours), so a row is keyed by its band too.
const apply = (res) => Object.assign(state, { bands: (res.bands ?? []).map((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, key: `${b.key} ${r.url}` })) })), counts: res.counts ?? state.counts, fetchedAt: res.fetchedAt ?? null, error: res.error ?? null, mentionsError: res.mentionsError ?? null, agentsError: res.agentsError ?? null, agents: res.agents ?? null, sessions: res.sessions ?? state.sessions, local: res.local ?? state.local });

async function load() {
  state.loading = true;
  render();
  try {
    if (!state.bands.length) apply(await fetch('/api/today?cached=1').then((r) => r.json())), render();
    const res = await fetch('/api/today').then((r) => r.json());
    if (res.bands) apply(res);
    else state.error = res.error;
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  render();
}

function move(delta) {
  const all = rows();
  const i = all.findIndex((r) => r.key === state.selected);
  const next = all[Math.max(0, Math.min(all.length - 1, i + delta))];
  if (!next) return;
  state.selected = next.key;
  sessionStorage.setItem('todaySelected', next.key);
  render();
}

/** Takes a row off the page right away, for actions that settle it. The next refresh has the truth. */
function drop(r) {
  const all = rows();
  const i = all.findIndex((x) => x.key === r.key);
  state.selected = all[i + 1]?.key ?? all[i - 1]?.key ?? null;
  for (const b of state.bands) b.rows = b.rows.filter((x) => x.key !== r.key);
}

function openPage(r = current()) {
  if (!r || r.thread || isIssue(r)) return;
  sessionStorage.setItem('todaySelected', r.key);
  sessionStorage.setItem('order', JSON.stringify(rows().map((x) => x.url)));
  sessionStorage.setItem('back', '/');
  location.href = `/pr/${r.repo}/${r.number}`;
}

function openGitHub(r = current()) {
  if (!r) return;
  openLink(r.url, post);
  say(`Opened ${ref(r)} on GitHub`);
}

async function approve(r = current()) {
  if (!r || r.next !== 'approve') return say('Approve is only offered when the brief cleared the PR on its current commit.');
  if (!confirm(`Approve ${r.repo}#${r.number}?\n\n${r.title}`)) return;
  const res = await post('/api/approve', { urls: [r.url] });
  if (res.done?.includes(r.url)) {
    drop(r);
    say(`Approved #${r.number}`);
  } else say(res.error ?? `Didn't approve #${r.number}: ${res.skipped?.[0]?.why ?? 'unknown reason'}`);
}

/** Opens a mention on GitHub and marks it read, so it leaves your GitHub inbox too. */
async function openThread(r = current()) {
  if (!r?.thread) return;
  drop(r);
  say(`Opened ${ref(r)} and marked it read`);
  // From another device the page opens the link itself; the server only marks it read.
  const here = isRemote(location.hostname);
  if (here) window.open(r.url, '_blank', 'noopener');
  const res = await post('/api/mentions/read', { id: r.thread, open: !here });
  if (res.error) say(res.error);
}

async function setAside(r = current()) {
  if (!r || isIssue(r)) return;
  if (r.thread) {
    drop(r);
    say(`Marked ${ref(r)} read`);
    const res = await post('/api/mentions/read', { id: r.thread, open: false });
    return res.error && say(res.error);
  }
  drop(r);
  say(`Set ${ref(r)} aside until it changes`);
  await post(r.mine ? '/api/mine/aside' : '/api/skip', { url: r.url, updatedAt: r.updatedAt });
}

/** Reads the selected row's box from GitHub, at most every 15 seconds unless forced. */
async function readBox(r = current(), force = false) {
  if (!r || !boxCfg(r)) return;
  const had = state.boxes[r.url];
  if (!force && had && (had.loading || Date.now() - had.at < 15_000)) return;
  state.boxes[r.url] = { ...(had ?? {}), loading: !had || had.error, at: Date.now() };
  if (!had) render();
  const res = await fetch(`/api/session?url=${encodeURIComponent(r.url)}`).then((x) => x.json()).catch((e) => ({ error: e.message }));
  state.boxes[r.url] = { ...res, at: Date.now() };
  render();
}

async function box(action, r = current()) {
  const cfg = r && boxCfg(r);
  if (!cfg) return;
  if (action === 'key') action = state.boxes[r.url]?.state === 'ready' ? 'open' : state.boxes[r.url]?.state === 'booting' ? null : 'start';
  if (!action) return say('The box is still booting.');
  if (action === 'stop' && !confirm(`Stop the test box for ${ref(r)}? This removes the ${cfg.label} label.`)) return;
  if (action === 'open') state.boxes[r.url] = { ...state.boxes[r.url], opening: true };
  if (action === 'start') state.boxes[r.url] = { state: 'booting', at: Date.now() };
  render();
  const res = await post('/api/session', { url: r.url, do: action });
  if (res.error) {
    state.boxes[r.url] = { ...state.boxes[r.url], opening: false };
    return say(res.error);
  }
  state.boxes[r.url] = { ...res, at: Date.now() };
  say({ start: `Added the ${cfg.label} label to ${ref(r)}. The box takes a few minutes to boot.`, stop: `Removed the ${cfg.label} label from ${ref(r)}.`, open: `Opened the box for ${ref(r)}.` }[action]);
}

async function local(action, r = current()) {
  if (!r || r.thread || !state.local.repos.includes(r.repo)) return;
  if (action === 'take' && state.local.slot?.url === r.url && state.local.slot.running) return say(`${ref(r)} already has the local slot.`);
  if (action === 'release' && !confirm(`Stop the local server for ${ref(r)} and free the slot?`)) return;
  say(action === 'take' ? `Checking out ${ref(r)} locally…` : 'Freeing the local slot…');
  let res = await post('/api/local', { url: r.url, do: action });
  if (res.confirm) {
    if (!confirm(res.confirm)) return say('Left the local slot where it was.');
    say(`Checking out ${ref(r)} locally…`);
    res = await post('/api/local', { url: r.url, do: action, confirmed: true });
  }
  if (res.error) return say(res.error);
  state.local.slot = res.slot;
  say(res.slot ? `${ref(r)} is running locally. Its log is ${res.slot.log}` : 'Freed the local slot.');
}

/** Adds the agent's ready label to the issue, after a confirm. The server refuses past the cap. */
async function startAgent(r = current()) {
  if (!r || r.next !== 'start') return say('Start agent is only offered on issues in Ready to start.');
  if (full(r)) return say(`All ${state.agents.cap} agent slots are taken. Land or close one first.`);
  if (!confirm(`Hand ${ref(r)} to the agent?\n\n${r.title}\n\nThis adds its ready label on GitHub.`)) return;
  say(`Starting the agent on ${ref(r)}…`);
  const res = await post('/api/agent/start', { url: r.url });
  if (res.error) return say(res.error);
  drop(r);
  state.agents = { ...state.agents, inFlight: res.inFlight, cap: res.cap };
  say(`Handed ${ref(r)} to the agent. ${res.inFlight} of ${res.cap} slots in use.`);
}

function primary(r = current()) {
  if (!r) return;
  (PRIMARY[r.next] ?? PRIMARY.unblock)[2](r);
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
  const fn = {
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    Enter: () => primary(),
    A: () => approve(),
    D: () => box('key'),
    L: () => local('take'),
    S: () => startAgent(),
    p: () => openPage(),
    o: () => openGitHub(),
    x: () => setAside(),
    r: () => load(),
    q: () => (location.href = '/queue'),
    m: () => (location.href = '/mine'),
    b: () => (location.href = '/board'),
    t: () => setTheme(state.theme === 'dark' ? 'light' : 'dark'),
    '?': () => ((state.help = true), renderHelp()),
  }[e.key];
  if (fn) (e.preventDefault(), fn());
});

$('#theme').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
$('#today').addEventListener('click', (e) => {
  const el = e.target.closest('.trow');
  if (!el) return;
  const r = rows().find((x) => x.key === el.dataset.key);
  if (!r) return;
  state.selected = r.key;
  const b = e.target.closest('[data-do]');
  if (!b) return render();
  ({ primary: () => primary(r), page: () => openPage(r), github: () => openGitHub(r), aside: () => setAside(r), 'box-start': () => box('start', r), 'box-stop': () => box('stop', r), 'box-open': () => box('open', r), 'local-take': () => local('take', r), 'local-release': () => local('release', r) })[b.dataset.do]?.();
});

window.addEventListener('focus', () => state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 60_000 && load());
setInterval(() => !state.loading && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 5 * 60_000 && load(), 60_000);
setInterval(() => document.visibilityState === 'visible' && readBox(), 15_000);
load();
