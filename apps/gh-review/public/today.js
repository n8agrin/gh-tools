// Today: everything where you hold the ball, one row each, most-waited-on first. The server builds
// the bands (src/today.ts); this page draws them and turns each row's one main button into a click or a key.

const state = {
  bands: [],
  counts: { waiting: 0, hunt: 0, hidden: 0 },
  fetchedAt: null,
  error: null,
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

const rows = () => state.bands.flatMap((b) => b.rows);
const current = () => rows().find((r) => r.key === state.selected);
const say = (msg) => ((state.status = msg), render());

/** How long it's been: a review request has been waiting on you, your own PR since it last changed. */
const sinceText = (r) => (r.mine ? `updated ${age(r.since)} ago` : `waiting on you ${age(r.since)}`);

/** Each row's one main button: its label, its key, and what it does. */
const PRIMARY = {
  brief: ['Open brief', '↵', (r) => openPage(r)],
  approve: ['Approve', 'A', (r) => approve(r)],
  merge: ['Merge on GitHub', '↵', (r) => openGitHub(r)],
  undraft: ['Mark ready on GitHub', '↵', (r) => openGitHub(r)],
  findings: ['See the findings', '↵', (r) => openPage(r)],
  unblock: ['Open on GitHub', '↵', (r) => openGitHub(r)],
};

/** The other buttons on the selected row. Later features add theirs here. */
function extras(r) {
  const out = [];
  if (!['brief', 'findings'].includes(r.next)) out.push('<button class="btn" type="button" data-do="page">PR page <kbd>p</kbd></button>');
  if (!['merge', 'undraft', 'unblock'].includes(r.next)) out.push('<button class="btn" type="button" data-do="github">GitHub <kbd>o</kbd></button>');
  out.push('<button class="btn" type="button" data-do="aside">Set aside <kbd>x</kbd></button>');
  return out.join('');
}

function row(r) {
  const selected = r.key === state.selected;
  const primary = PRIMARY[r.next] ?? PRIMARY.unblock;
  const more = selected && r.decisions.length > 1
    ? `<div class="more"><p class="cap">Decisions the brief left for you</p><ol>${r.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ol></div>`
    : '';
  return `<div class="trow" role="option" data-key="${esc(r.key)}" aria-selected="${selected}">
    <span class="tag ${esc(r.tag)}">${esc(r.tag)}</span>
    <span class="ref mono">${esc(r.repo.split('/')[1])}#${r.number}</span>
    <span class="ttl">${esc(r.title)}</span>
    <span class="since mono" title="${esc(new Date(r.since).toLocaleString())}">${esc(sinceText(r))}</span>
    <button class="btn primary" type="button" data-do="primary">${esc(primary[0])} <kbd>${esc(primary[1])}</kbd></button>
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
    .map((b) => `<section class="band" data-band="${esc(b.key)}"><h2>${esc(b.label)} <span class="n">${b.rows.length}</span></h2>${b.rows.length ? `<div class="rows" role="listbox" aria-label="${esc(b.label)}">${b.rows.map(row).join('')}</div>` : '<div class="rows"><div class="none">Nothing here.</div></div>'}</section>`)
    .join('');
  const c = state.counts;
  const foot = [
    c.waiting ? `<a href="/board">${plural(c.waiting, 'PR')} waiting on others</a>` : '',
    c.hunt ? `<a href="/board">${c.hunt} without a bug pass</a>` : '',
    c.hidden ? `<span>${c.hidden} set aside or done</span>` : '',
  ].filter(Boolean);
  main.innerHTML = `<div class="wrap">${bands}${foot.length ? `<div class="foot">${foot.join('')}</div>` : ''}</div>`;
  main.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

const KEYS = [
  [['j', '↓'], 'Next row'],
  [['k', '↑'], 'Previous row'],
  [['↵'], "The row's main button"],
  [['A'], 'Approve, when the brief cleared it on this commit (asks first)'],
  [['p'], 'Open the PR page'],
  [['o'], 'Open the PR on GitHub'],
  [['x'], 'Set the row aside until the PR changes'],
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
  $('#needs').innerHTML = state.bands.map((b) => `<span title="${esc(b.label)}"><b>${b.rows.length}</b>${esc(b.key === 'review' ? 'reviews' : b.key === 'move' ? 'yours' : b.key)}</span>`).join('');
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
}

// A PR can sit in two bands (you review it and it's yours), so a row is keyed by its band too.
const apply = (res) => Object.assign(state, { bands: (res.bands ?? []).map((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, key: `${b.key} ${r.url}` })) })), counts: res.counts ?? state.counts, fetchedAt: res.fetchedAt ?? null, error: res.error ?? null });

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
  if (!r) return;
  sessionStorage.setItem('todaySelected', r.key);
  sessionStorage.setItem('order', JSON.stringify(rows().map((x) => x.url)));
  sessionStorage.setItem('back', '/today');
  location.href = `/pr/${r.repo}/${r.number}`;
}

function openGitHub(r = current()) {
  if (!r) return;
  post('/api/open', { url: r.url });
  say(`Opened #${r.number} on GitHub`);
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

async function setAside(r = current()) {
  if (!r) return;
  drop(r);
  say(`Set #${r.number} aside until it changes`);
  await post(r.mine ? '/api/mine/aside' : '/api/skip', { url: r.url, updatedAt: r.updatedAt });
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
    p: () => openPage(),
    o: () => openGitHub(),
    x: () => setAside(),
    r: () => load(),
    q: () => (location.href = '/'),
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
  ({ primary: () => primary(r), page: () => openPage(r), github: () => openGitHub(r), aside: () => setAside(r) })[b.dataset.do]?.();
});

window.addEventListener('focus', () => state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 60_000 && load());
setInterval(() => !state.loading && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 5 * 60_000 && load(), 60_000);
load();
