// The board: your own open PRs as a kanban, one column per pipeline stage. It reads the same
// /api/mine answer as the list, plus the stage the server worked out for each PR. Nothing here
// drags: a stage comes from GitHub and the bug-hunt runs, so the button on a card is how it moves.
import { findStacks } from './stacks.js';

// Left to right in the order a PR moves. Blocked sits at the end: it's off the line until it's sorted.
const STAGES = [
  ['hunt', 'Hunt', 'no bug pass on the current head'],
  ['fix', 'Fix findings', 'a bug pass ran, findings still open'],
  ['undraft', 'Undraft', 'bug pass on this head, CI green, still a draft'],
  ['waiting', 'Waiting', 'on someone else'],
  ['ship', 'Ship', 'approved, CI green, nothing in the way'],
  ['blocked', 'Blocked', 'red CI, a conflict, or changes requested'],
];
const NEEDS_YOU = ['ship', 'undraft', 'fix', 'blocked'];
const SHOW = 8;

const state = {
  prs: [],
  stages: {},
  aside: {},
  actions: [],
  runs: [],
  live: {},
  reviewing: new Set(),
  reviewedLabel: null,
  fetchedAt: null,
  error: null,
  loading: true,
  filter: '',
  expanded: new Set(),
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

const isAside = (p) => state.aside[p.url] && state.aside[p.url] >= p.updatedAt;
const stageOf = (p) => state.stages[p.url] ?? { key: 'hunt', why: '', next: 'hunt', findings: 0, stalePass: false };

const matches = (p) => {
  const q = state.filter.trim().toLowerCase();
  return !q || [p.title, p.repo, `#${p.number}`, stageOf(p).key, ...p.labels, ...p.waitingOn].some((s) => s.toLowerCase().includes(q));
};

/** The columns, each with its cards in order, and the flat order the keys walk. */
function visible() {
  const open = state.prs.filter((p) => !isAside(p) && matches(p));
  const stacks = findStacks(state.prs);
  const cols = STAGES.map(([key, label, rule]) => {
    // Newest activity first; a card from a stack sits with the rest of its stack when three or more land here.
    const cards = open.filter((p) => stageOf(p).key === key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const groups = new Map();
    for (const p of cards) {
      const s = stacks.get(p.url);
      if (s) groups.set(s.id, [...(groups.get(s.id) ?? []), p]);
    }
    const ordered = [];
    const placed = new Set();
    for (const p of cards) {
      if (placed.has(p.url)) continue;
      const s = stacks.get(p.url);
      const group = s && groups.get(s.id).length >= 3 ? groups.get(s.id).sort((a, b) => stacks.get(a.url).index - stacks.get(b.url).index) : [p];
      if (group.length > 1) ordered.push({ ladder: s, rows: group });
      for (const q of group) ordered.push(q), placed.add(q.url);
    }
    const shown = state.expanded.has(key) ? cards.length : SHOW;
    return { key, label, rule, cards, ordered, shown };
  });
  const all = cols.flatMap((c) => c.cards);
  return { cols, all, stacks, open };
}

/** The one-line status under a title: a run in flight, else the stage's short reason. */
function note(p) {
  const run = state.runs.find((r) => r.prUrl === p.url && r.status === 'running');
  const live = state.live[p.url];
  if (live) return { busy: true, text: `review ${live.done}/${live.total}${live.left > 5 ? ` · ~${mins(live.left)} left` : ''}` };
  if (state.reviewing.has(p.url)) return { busy: true, text: 'review starting' };
  if (run) return { busy: true, text: `${run.label.replace(/\?$/, '').toLowerCase()} running` };
  const s = stageOf(p);
  const bits = [];
  if (s.key === 'fix') bits.push(plural(s.findings, 'finding'));
  else if (s.key === 'blocked') bits.push(p.ci === 'failure' ? 'CI failing' : p.mergeable === 'CONFLICTING' ? 'conflicts' : 'changes requested');
  else if (s.key === 'hunt') bits.push(s.stalePass ? 'pass on an older head' : 'no bug pass');
  else if (s.key === 'waiting') bits.push(p.waitingOn.length ? `on ${p.waitingOn.join(', ')}` : p.isDraft ? 'on CI' : 'nobody asked');
  else if (s.key === 'ship') bits.push('approved');
  else if (s.key === 'undraft') bits.push('bug pass clean');
  return { busy: false, text: bits.join(' · ') };
}

const PRIMARY = {
  merge: ['Merge on GitHub', 'o', () => openGitHub()],
  undraft: ['Undraft on GitHub', 'o', () => openGitHub()],
  findings: ['See the findings', '↵', () => openPage()],
  unblock: ['Open on GitHub', 'o', () => openGitHub()],
  hunt: ['Run review', '⇧R', () => review()],
  nudge: ['Ask on GitHub', 'o', () => openGitHub()],
};

function card(p, stack) {
  const { subject } = splitTitle(p.title);
  const s = stageOf(p);
  const n = note(p);
  const selected = p.url === state.selected;
  const primary = PRIMARY[s.next] ?? PRIMARY.nudge;
  const open = selected
    ? `<div class="why">${esc(s.why)}</div>
       <div class="acts">
         <button data-do="primary" class="primary">${esc(primary[0])}<kbd>${esc(primary[1])}</kbd></button>
         <div class="row2">${primary[2] !== PRIMARY.findings[2] ? '<button data-do="page">PR page <kbd>↵</kbd></button>' : ''}${s.next !== 'hunt' ? '<button data-do="review">Review <kbd>⇧R</kbd></button>' : ''}<button data-do="aside">Aside <kbd>x</kbd></button>${primary[1] !== 'o' ? '<button data-do="github">GitHub <kbd>o</kbd></button>' : ''}</div>
       </div>`
    : '';
  return `<div class="card${p.isDraft ? ' draft' : ''}" role="option" data-url="${esc(p.url)}" aria-selected="${selected}">
    <div class="m1">${p.isDraft ? '<span class="tag draft-tag">Draft</span>' : ''}<span class="ref mono">${esc(p.repo.split('/')[1])}#${p.number}</span>${stack ? `<span class="stk mono" title="stack of ${stack.size}, bottom first">${stack.index + 1}/${stack.size}</span>` : ''}</div>
    <div class="ttl" title="${esc(p.title)}">${esc(subject)}</div>
    <div class="m2"><span class="note${n.busy ? ' busy' : ''}">${n.busy ? '<i class="spin"></i>' : ''}${esc(n.text)}</span><i class="ci ${p.ci ?? ''}" title="CI ${p.ci ?? 'none'}"></i><span class="ag" title="updated ${new Date(p.updatedAt).toLocaleString()}">${age(p.updatedAt)}</span></div>
    ${open}
  </div>`;
}

function ladder(s, rows, stacks) {
  // One pip per layer of the stack, coloured by its stage; layers not in the list stay hollow.
  const byIndex = new Map(state.prs.filter((p) => stacks.get(p.url)?.id === s.id).map((p) => [stacks.get(p.url).index, p]));
  const pips = Array.from({ length: s.size }, (_, i) => {
    const p = byIndex.get(i);
    return `<i class="pip s-${p ? stageOf(p).key : 'hunt'}${p ? ' full' : ''}" title="${p ? esc(`${i + 1}/${s.size} ${stageOf(p).key}`) : `${i + 1}/${s.size}`}"></i>`;
  }).join('');
  return `<div class="ladder"><span>Stack of ${s.size}</span><span class="pips">${pips}</span><span class="n">${rows.length} here</span></div>`;
}

function renderBoard(v) {
  const main = $('#board');
  if (state.error && !state.prs.length) {
    main.innerHTML = `<div class="empty">Couldn't load your PRs<br><pre>${esc(state.error)}</pre><div>Press <kbd>r</kbd> to try again.</div></div>`;
    return;
  }
  if (state.loading && !state.prs.length) {
    main.innerHTML = `<div class="empty">Loading your PRs…</div>`;
    return;
  }
  main.innerHTML = `<div class="cols">${v.cols
    .map((c) => {
      let count = 0;
      const items = [];
      for (const it of c.ordered) {
        if (it.ladder) {
          if (count < c.shown) items.push(ladder(it.ladder, it.rows, v.stacks));
          continue;
        }
        if (count++ >= c.shown) break;
        items.push(card(it, v.stacks.get(it.url)));
      }
      const hidden = c.cards.length - Math.min(c.cards.length, c.shown);
      const more = hidden ? `<button class="more" data-more="${c.key}"><kbd>→</kbd>${hidden} more</button>` : state.expanded.has(c.key) && c.cards.length > SHOW ? `<button class="more" data-more="${c.key}"><kbd>←</kbd>fewer</button>` : '';
      return `<div class="col s-${c.key}" data-col="${c.key}"><div class="colh"><div class="t"><i></i>${esc(c.label)}<span class="n">${c.cards.length}</span></div><div class="d">${esc(c.rule)}</div></div>${items.join('') || '<div class="empty">nothing here</div>'}${more}</div>`;
    })
    .join('')}</div>`;
  main.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const current = () => visible().all.find((p) => p.url === state.selected);

const KEYS = [
  [['j', '↓'], 'Next card in the column'],
  [['k', '↑'], 'Previous card'],
  [['l', '→'], 'Next column'],
  [['h', '←'], 'Previous column'],
  [['↵'], 'Open the PR page (a click selects, a second click opens)'],
  [['o'], 'Open the PR on GitHub, which is where merge and undraft happen'],
  [['⇧R'], 'Run review on the PR'],
  [['x'], 'Set the PR aside until it changes'],
  [['u'], 'Undo the last set aside'],
  [['/'], 'Filter by title, repo, #number, stage, label or reviewer'],
  [['esc'], 'Clear the filter'],
  [['v'], 'The same PRs as a list'],
  [['q'], 'Go to the review queue'],
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
  const keys = [...KEYS.slice(0, 7), ...state.actions.map((a) => [[`⇧${a.key.toUpperCase()}`], `${a.label.replace(/\?$/, '')} (runs ${a.command[0]} on the PR)`]), ...KEYS.slice(7)];
  el.innerHTML = `<div class="panel"><h2>Keyboard shortcuts</h2><dl>${keys.map(([k, what]) => `<dt>${k.map((x) => `<kbd>${esc(x)}</kbd>`).join('<span class="or">or</span>')}</dt><dd>${esc(what)}</dd>`).join('')}</dl></div>`;
}

function render() {
  const v = visible();
  if (!v.all.some((p) => p.url === state.selected)) state.selected = v.all[0]?.url ?? null;
  const open = state.prs.filter((p) => !isAside(p));
  $('#count').textContent = state.loading && !state.prs.length ? '–' : open.length;
  document.title = open.length ? `(${open.length}) Board` : 'Board';
  const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const stale = state.error && state.prs.length;
  $('#fetched').textContent = state.loading ? 'Refreshing…' : stale ? `Couldn't refresh, showing ${when}` : when ? `Updated ${when}` : '';
  $('#fetched').title = stale ? state.error : '';
  $('#fetched').classList.toggle('stale', !!stale);
  $('#theme').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  const needs = open.filter((p) => NEEDS_YOU.includes(stageOf(p).key)).length;
  $('#needs').innerHTML = `<span><b>${needs}</b>need you</span>${v.cols.filter((c) => NEEDS_YOU.includes(c.key)).map((c) => `<span class="s-${c.key}" title="${esc(c.label)}"><i></i><b>${c.cards.length}</b></span>`).join('')}`;
  renderBoard(v);
  const drafts = open.filter((p) => p.isDraft).length;
  $('#status').textContent = state.status || (state.prs.length ? `${plural(open.length, 'open PR')}${drafts ? `, ${drafts} of them ${drafts === 1 ? 'a draft' : 'drafts'}` : ''} · cards don't drag, GitHub sets the stage` : '');
  const footer = [['h j k l', 'move'], ['↵', 'open'], ['o', 'github'], ['⇧R', 'review'], ['x', 'aside'], ['/', 'filter'], ['v', 'list'], ['?', 'keys']];
  $('#keys').innerHTML = footer.map(([k, t]) => `<span><kbd>${esc(k)}</kbd>${esc(t)}</span>`).join('');
  renderHelp();
}

const say = (msg) => ((state.status = msg), render());

const apply = (res) => Object.assign(state, { prs: res.prs, stages: res.stages ?? {}, aside: res.aside ?? {}, actions: res.actions ?? [], reviewedLabel: res.reviewedLabel ?? null, live: res.live ?? state.live, fetchedAt: res.fetchedAt, error: res.error ?? null });

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
  const live = await fetch('/api/live').then((r) => (r.ok ? r.json() : {})).catch(() => state.live);
  // A review that just finished may have moved its PR to another column, so ask for the stages again.
  const finished = Object.keys(state.live).some((u) => !live[u]);
  state.live = live;
  for (const u of Object.keys(state.live)) state.reviewing.delete(u);
  if (finished) return load();
  if (had || state.runs.some((r) => r.status === 'running') || Object.keys(state.live).length) render();
}

/** Where the selected card is: its column and index in it. */
function where(v) {
  for (let c = 0; c < v.cols.length; c++) {
    const i = v.cols[c].cards.findIndex((p) => p.url === state.selected);
    if (i >= 0) return { c, i };
  }
  return { c: 0, i: 0 };
}

function moveRow(delta) {
  const v = visible();
  const { c, i } = where(v);
  const cards = v.cols[c].cards;
  const next = cards[Math.max(0, Math.min(cards.length - 1, i + delta))];
  if (!next) return;
  if (cards.indexOf(next) >= v.cols[c].shown) state.expanded.add(v.cols[c].key);
  state.selected = next.url;
  render();
}

function moveCol(delta) {
  const v = visible();
  const { c, i } = where(v);
  // Skip empty columns, keeping about the same height.
  for (let n = c + delta; n >= 0 && n < v.cols.length; n += delta) {
    const cards = v.cols[n].cards;
    if (!cards.length) continue;
    state.selected = cards[Math.min(i, cards.length - 1, v.cols[n].shown - 1)].url;
    return render();
  }
}

function openPage(p = current()) {
  if (!p) return;
  sessionStorage.setItem('mineSelected', p.url);
  sessionStorage.setItem('order', JSON.stringify(visible().all.map((x) => x.url)));
  sessionStorage.setItem('back', '/board');
  location.href = `/pr/${p.repo}/${p.number}`;
}

function openGitHub(p = current()) {
  if (!p) return;
  post('/api/open', { url: p.url });
  say(`Opened #${p.number} on GitHub`);
}

async function setAside(p = current()) {
  if (!p) return;
  const { all } = visible();
  const i = all.indexOf(p);
  state.aside[p.url] = p.updatedAt;
  state.history.push(p);
  state.selected = all[i + 1]?.url ?? all[i - 1]?.url ?? null;
  say(`Set aside #${p.number} until it changes · u to undo · it's on the list under h`);
  await post('/api/mine/aside', { url: p.url, updatedAt: p.updatedAt });
}

async function undo() {
  const p = state.history.pop();
  if (!p) return say('Nothing to undo');
  delete state.aside[p.url];
  state.selected = p.url;
  say(`#${p.number} is back on the board`);
  await post('/api/mine/aside', { url: p.url, updatedAt: null });
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
    j: () => moveRow(1),
    ArrowDown: () => moveRow(1),
    k: () => moveRow(-1),
    ArrowUp: () => moveRow(-1),
    l: () => moveCol(1),
    ArrowRight: () => moveCol(1),
    h: () => moveCol(-1),
    ArrowLeft: () => moveCol(-1),
    Enter: () => openPage(),
    o: () => openGitHub(),
    R: () => review(),
    x: () => setAside(),
    u: () => undo(),
    r: () => load(),
    v: () => (location.href = '/mine'),
    q: () => (location.href = '/'),
    t: () => setTheme(state.theme === 'dark' ? 'light' : 'dark'),
    Escape: () => state.filter && ((search.value = ''), (state.filter = ''), render()),
    '/': () => search.focus(),
    '?': () => ((state.help = true), renderHelp()),
  }[e.key];
  if (fn) (e.preventDefault(), fn());
});

$('#search').addEventListener('input', (e) => ((state.filter = e.target.value), render()));
$('#theme').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
$('#board').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    const key = more.dataset.more;
    state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
    return render();
  }
  const c = e.target.closest('.card');
  if (!c) return;
  const p = state.prs.find((x) => x.url === c.dataset.url);
  const b = e.target.closest('[data-do]');
  if (b) {
    const s = stageOf(p);
    const run = { primary: () => (PRIMARY[s.next] ?? PRIMARY.nudge)[2](), page: () => openPage(p), review: () => review(p), aside: () => setAside(p), github: () => openGitHub(p) }[b.dataset.do];
    state.selected = p.url;
    return run?.();
  }
  // First click selects and opens the card up; a second click on it goes to the PR page.
  if (state.selected === p.url) return openPage(p);
  state.selected = p.url;
  render();
});

window.addEventListener('focus', () => state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 60_000 && load());
setInterval(() => !state.loading && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 5 * 60_000 && load(), 60_000);
setInterval(pollRuns, 3000);
const pending = sessionStorage.getItem('toast');
if (pending) sessionStorage.removeItem('toast'), (state.status = pending);
load();
pollRuns();
