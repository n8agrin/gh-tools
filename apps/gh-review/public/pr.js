// The page for one PR, laid out as PR Page v3: a checklist of what to read on the left, and on the right
// either the brief (risk, description, how it works, taste questions), one file with its notes and diff, or a finish screen.
import { inline, markdown } from './md.js';
import { initChat } from './chat.js';
import { findStacks } from './stacks.js';
import { toMarkdown } from './tomd.js';

const [, , owner, name, number] = location.pathname.split('/');
const url = `https://github.com/${owner}/${name}/pull/${number}`;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Claude's prose fields use `code` spans, so render those; inline() escapes everything else.
const t = (s) => inline(String(s ?? ''));
const safe = (u) => (/^https:\/\//.test(u) ? esc(u) : '#');
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const REVIEWED_KEY = `reviewed:${url}`;
const loadReviewed = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
};

// Your line comments wait here, per PR, until you submit them as one review.
const COMMENTS_KEY = `comments:${url}`;
const loadComments = () => {
  try {
    return JSON.parse(localStorage.getItem(COMMENTS_KEY) ?? '[]');
  } catch {
    return [];
  }
};

const state = {
  pr: null, error: null, reviews: [], optional: [], extras: new Set(), shown: null, diffIds: {}, starting: false, queue: null,
  help: false, override: null, runOpen: false, cur: 'brief', reviewed: loadReviewed(), diff: null, diffError: null, showRoutine: false, descOpen: false, split: !!localStorage.getItem('diffSplit'), comments: loadComments(), draft: null, verdict: 'COMMENT', summary: '', back: 'brief', submitError: null, submitting: false, gh: null, drawer: !!localStorage.getItem('runDrawer'), files: {}, mdRendered: localStorage.getItem('mdRendered') !== '', mineList: null, bh: {},
};

// Your own PRs come back to My PRs instead of the review queue.
const home = () => (state.pr?.mine ? '/mine' : '/');

$('#ref').textContent = `${name}#${number}`;
$('#github').href = url;
document.title = `${name}#${number}`;

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ago2(iso) {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (m < 60) return `${Math.max(1, Math.floor(m))}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 20160) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

// GitHub anchors each file in the diff by the sha256 of its path.
async function diffIds(files) {
  const out = {};
  for (const f of files) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.path));
    out[f.path] = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return out;
}

const base = (p) => p.slice(p.lastIndexOf('/') + 1);

// When two changed files share a name, each gets just enough of its folder to tell them apart.
let prefixCache = { files: null, map: new Map() };
function prefixOf(path) {
  const files = state.pr?.files;
  if (prefixCache.files !== files) {
    const paths = (files ?? []).map((f) => f.path);
    const map = new Map();
    for (const p of paths) {
      const parts = p.split('/');
      const twins = paths.filter((q) => q !== p && base(q) === base(p)).map((q) => q.split('/'));
      if (!twins.length) continue;
      // Grow the folder part from the file outward until no twin ends the same way.
      let k = 1;
      while (k < parts.length - 1 && twins.some((t) => t.slice(-k - 1).join('/') === parts.slice(-k - 1).join('/'))) k++;
      let pfx = parts.slice(-k - 1, -1).join('/') || '.';
      // Route folders like api.v1.ai.credit-controls.users differ only at the end, so keep just the dotted parts that differ.
      const dir = parts[parts.length - 2];
      if (k === 1 && dir?.includes('.')) {
        const others = twins.map((t) => t[t.length - 2] ?? '');
        const toks = dir.split('.');
        let n = 1;
        while (n < toks.length && others.some((o) => o.split('.').slice(-n).join('.') === toks.slice(-n).join('.'))) n++;
        if (n < toks.length) pfx = `…${toks.slice(-n).join('.')}`;
      }
      map.set(p, pfx + '/');
    }
    prefixCache = { files, map };
  }
  return prefixCache.map.get(path) ?? '';
}
const nameHtml = (path) => `${prefixOf(path) ? `<span class="pfx">${esc(prefixOf(path))}</span>` : ''}<span class="bn">${esc(base(path))}</span>`;
const shortName = (path) => prefixOf(path) + base(path);
const fileUrl = (file) => `${url}/files${state.diffIds[file] ? `#diff-${state.diffIds[file]}` : ''}`;

// "path:12" or "path:12-20" to a link at the PR head. Inside this PR it opens the file here instead.
function whereLink(where, sha) {
  const m = String(where).match(/^([^:\s]+)(?::(\d+)(?:-(\d+))?)?/);
  if (!m) return esc(where);
  const label = `${esc(base(m[1]))}${m[2] ? `:${m[2]}` : ''}`;
  const full = state.pr?.files.find((f) => f.path === m[1] || f.path.endsWith(`/${m[1]}`));
  if (full) return `<a class="ref-l" href="#" data-open="${esc(full.path)}" title="${esc(where)}">${label}</a>`;
  const lines = m[2] ? `#L${m[2]}${m[3] ? `-L${m[3]}` : ''}` : '';
  return `<a class="ref-l" href="https://github.com/${owner}/${name}/blob/${sha}/${esc(m[1])}${lines}" target="_blank" rel="noreferrer" title="${esc(where)}">${label}</a>`;
}

const parse = (step) => {
  try {
    return JSON.parse(step.output);
  } catch {
    return null;
  }
};

// The queue's last fetch knows what GitHub's single-PR view doesn't: CI, the request, your review, the stack.
const row = () => state.queue?.prs.find((p) => p.url === url) ?? state.mineList?.prs.find((p) => p.url === url);
const doneEntry = () => {
  const d = state.queue?.done.find((x) => x.pr.url === url);
  const live = row();
  return d && (!live || d.doneAt >= live.requestedAt) ? d : null;
};

// The bug pass as a few words in the meta line, or a box when the PR should go back to its author.
function gate() {
  const pr = state.pr;
  if (pr.reviewedLabel && pr.labels.includes(pr.reviewedLabel)) return { word: 'Bug pass done' };
  if (pr.copilotReviewed) return { word: 'Copilot bug pass' };
  // Without a bug-pass label in your config there's no bug pass to expect, so say nothing.
  if (!pr.reviewedLabel) return { word: '' };
  // Sending back only makes sense on an open PR you haven't approved or finished with.
  const past = pr.mine || pr.state !== 'OPEN' || doneEntry() || row()?.myReview === 'APPROVED';
  return { word: 'No bug pass', sendBack: !past };
}

const REVIEW_WORD = { APPROVED: 'you approved', CHANGES_REQUESTED: 'you requested changes', COMMENTED: 'you commented' };
const DONE_WORD = { approved: 'You approved', 'changes requested': 'You requested changes', marked: 'You marked it done' };

const pagePath = (u) => {
  const m = u.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `/pr/${m[1]}/${m[2]}/${m[3]}` : u;
};

// The stack as one pip per layer, bottom first: you're the big one, filled means merged or approved.
function stackPips() {
  if (!state.queue) return '';
  // PRs in Done still carry their stack, so a layer you already approved keeps its neighbors.
  const prs = [...state.queue.prs, ...state.queue.done.map((d) => d.pr).filter((p) => !state.queue.prs.some((q) => q.url === p.url))];
  const stacks = findStacks(prs);
  const s = stacks.get(url);
  if (!s) return '';
  const layers = s.entries
    ? [...s.entries].sort((a, b) => a.position - b.position).map((e) => ({ url: e.url, number: e.number, title: e.title, state: e.state, myReview: e.myReview }))
    : prs.filter((p) => stacks.get(p.url)?.id === s.id).sort((a, b) => stacks.get(a.url).index - stacks.get(b.url).index);
  const i = layers.findIndex((l) => l.url === url);
  const asking = new Set(state.queue.prs.map((p) => p.url));
  const pip = (l, k) => {
    const why = l.url === url ? 'this PR' : l.state === 'MERGED' ? 'merged' : l.state === 'CLOSED' ? 'closed' : l.myReview === 'APPROVED' ? 'you approved' : asking.has(l.url) ? 'asking you' : 'not asking you';
    const cls = { 'this PR': 'me', merged: 'merged', closed: 'merged', 'you approved': 'approved', 'asking you': 'asking' }[why] ?? '';
    return `<a class="pip ${cls}" href="${pagePath(l.url)}" title="${k + 1} of ${layers.length} · #${l.number} · ${esc(why)}"></a>`;
  };
  const link = (l, label) => (l ? `<a href="${pagePath(l.url)}" title="#${l.number} ${esc(l.title)}">${label}</a>` : '');
  return `<span class="stack">${link(layers[i - 1], '←')}<span class="pips">${layers.map(pip).join('')}</span>${link(layers[i + 1], '→')}<span>stack part ${s.index + 1} of ${s.size}</span></span>`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const num = (n) => n.toLocaleString();
const COLOR = { green: 'Green', yellow: 'Yellow', red: 'Red' };
const RANK = { green: 0, yellow: 1, red: 2 };
const doneOutput = (steps, k) => (steps[k]?.status === 'done' ? parse(steps[k]) : null);
// Questions for the author. Area standards can also note shortfalls in the existing code (kind "existing"); those are for you, not the author.
const allTaste = (taste) => (taste?.lenses ?? []).flatMap((l) => l.questions.map((q) => ({ ...q, lens: l.lens })));
const tasteQuestions = (taste) => allTaste(taste).filter((q) => q.kind !== 'existing');
const tasteExisting = (taste) => allTaste(taste).filter((q) => q.kind === 'existing');
const LENS = { consistency: 'Consistency', simple_first: 'Simple first', right_sized: 'Right-sized fix', area_standards: 'Area standards' };

// Prior art is what the reviewer clicks, so a taste note links a written rule first, then its first Base: link.
const priorArt = (q) => q.evidence?.find((e) => /^rule:/i.test(e.label)) ?? q.evidence?.find((e) => /^base:/i.test(e.label)) ?? q.evidence?.[0];
const artLink = (art) => {
  if (!art) return '';
  const rule = /^rule:/i.test(art.label);
  return `<a class="ref-l" href="${safe(art.url)}" target="_blank" rel="noreferrer">${rule ? 'rule' : 'prior art'}: ${esc(art.label.replace(/^(base|rule):\s*/i, ''))}</a>`;
};

function allNotes(steps) {
  return [
    ...(doneOutput(steps, 'check')?.findings ?? []).map((f) => ({ ...f, kind: 'finding' })),
    ...(doneOutput(steps, 'guide')?.notes ?? []),
    ...tasteQuestions(doneOutput(steps, 'taste')).map((q) => ({ file: q.file, lines: q.lines, kind: 'taste', note: q.question, why: q.why, art: priorArt(q) })),
  ];
}
const NOTE_WORD = { finding: 'Check.', check: 'Check.', 'test-gap': 'Untested.', taste: 'Taste question.' };
const isCheck = (n) => n.kind === 'check' || n.kind === 'finding';

// The files to read and the routine ones, decided once so the sidebar, the numbers and the map agree.
// A file on a red path or with a Check finding always gets read, even when the guide called it routine.
function fileItems(steps) {
  const g = doneOutput(steps, 'guide');
  const floor = new Set((doneOutput(steps, 'signal')?.floor ?? []).map((f) => f.file));
  const sizes = Object.fromEntries((state.pr?.files ?? []).map((f) => [f.path, f]));
  const seen = new Set(g.files.map((f) => f.file));
  // Files the guide left out still show, so nothing changed goes unlisted.
  const all = [...g.files, ...(state.pr?.files ?? []).filter((f) => !seen.has(f.path)).map((f) => ({ file: f.path, color: 'yellow', note: '', routine: true }))];
  const found = {};
  for (const x of doneOutput(steps, 'check')?.findings ?? []) if ((RANK[x.color] ?? 0) > (RANK[found[x.file]] ?? -1)) found[x.file] = x.color;
  const items = all.map((f) => {
    const color = floor.has(f.file) ? 'red' : (RANK[found[f.file]] ?? -1) > (RANK[f.color] ?? 1) ? found[f.file] : f.color;
    return { ...f, color, add: sizes[f.file]?.additions ?? 0, del: sizes[f.file]?.deletions ?? 0, routine: f.routine && !floor.has(f.file) && !found[f.file] };
  });
  return { items, main: items.filter((f) => !f.routine).sort((a, b) => (RANK[b.color] ?? 1) - (RANK[a.color] ?? 1)), routine: items.filter((f) => f.routine) };
}

const lines = (fs) => fs.reduce((a, f) => a + f.add + f.del, 0);
const mins = (f) => (f.color === 'red' ? Math.max(2, Math.round((f.add + f.del) / 40)) : 1);
const LEVEL = { red: 'read in full', yellow: 'skim', green: 'skim' };

const shownRunAfter = (reviews) => reviews.find((x) => x.status !== 'running' && x.error !== STOPPED);

// The run you picked, else the newest finished one. A rerun keeps the last results up until it's done.
const liveRun = () => state.reviews.find((x) => x.status === 'running');
// A run you stopped as a whole has nothing new to show, so the one before it stays up.
const STOPPED = 'Stopped by you';
const shownRun = () =>
  state.reviews.find((x) => x.id === state.shown) ?? state.reviews.find((x) => x.status !== 'running' && x.error !== STOPPED) ?? state.reviews.find((x) => x.status !== 'running') ?? state.reviews[0];

// ——— Run progress ———

const secs = (iso) => Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
const dur = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);
// A step we have no history for gets a minute, which is about what the AI checks take.
const typical = (key) => state.typical?.[key] ?? 60;

// Seconds left on one step, and how far along its bar is. Past its usual time it holds at 95%.
function stepLeft(s) {
  if (s.status === 'running') {
    const t = typical(s.key);
    const el = secs(s.startedAt);
    return { left: Math.max(0, t - el), frac: Math.min(0.95, el / Math.max(1, t)), over: el > t * 1.2 };
  }
  if (s.status === 'queued') return { left: typical(s.key), frac: 0 };
  return { left: 0, frac: 1 };
}

// The worktree comes first, then the checks run side by side, so what's left is the worktree plus the slowest check.
function runLeft(run) {
  const wt = run.steps.find((s) => s.key === 'worktree');
  const rest = run.steps.filter((s) => s.key !== 'worktree' && s.key !== 'gate' && s.key !== 'signal');
  const pre = wt && wt.status !== 'done' ? stepLeft(wt).left : 0;
  return pre + Math.max(0, ...rest.map((s) => stepLeft(s).left));
}

const STEP_ICON = { done: '✓', failed: '✕', skipped: '–', running: '', queued: '' };

// ——— The run: a button in the bottom bar, and a drawer on the right with the details ———

// How one step reads in the drawer: its time taken, or its clock and what's left while it runs.
function stepTime(s) {
  const p = stepLeft(s);
  if (s.status === 'running') return `${dur(secs(s.startedAt))}${p.over ? ' · longer than usual' : p.left > 1 ? ` · ~${dur(p.left)} left` : ''}`;
  if (s.status === 'queued') return `usually ${dur(typical(s.key))}`;
  if (s.status === 'done') return s.startedAt && s.endedAt ? took(s.startedAt, s.endedAt) : 'done';
  if (s.status === 'skipped') return s.output === STOPPED ? 'stopped' : 'skipped';
  return s.status;
}

const runDone = (run) => run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
const runLeftLabel = (run) => {
  const left = runLeft(run);
  return left > 1 ? `about ${dur(left)} left` : run.steps.some((s) => s.status === 'running' && stepLeft(s).over) ? 'taking longer than usual' : 'finishing up';
};

// The bottom bar's summary of the run on screen, or the one going now.
function runButtonHtml() {
  const live = liveRun();
  const r = shownRun();
  const stale = r && state.pr && r.headSha !== state.pr.headSha;
  let dot, title, sub;
  if (live) (dot = 'amber'), (title = `Run ${live.id} running`), (sub = `${runDone(live)} of ${live.steps.length} · ${runLeftLabel(live)}`);
  else if (state.starting) (dot = 'amber'), (title = 'Starting a run'), (sub = '');
  else if (r) (dot = r.status === 'failed' ? 'red' : 'green'), (title = `Run ${r.id} ${r.status === 'failed' ? (r.error === STOPPED ? 'stopped' : 'had a failed step') : 'done'}`), (sub = `${when(r.startedAt)}${r.endedAt ? ` · ${took(r.startedAt, r.endedAt)}` : ''}`);
  else (dot = 'faint'), (title = 'No review yet'), (sub = '⇧R to run one');
  return `${live || state.starting ? '<span class="spin"></span>' : `<i class="rdot ${dot}"></i>`}<b>${esc(title)}</b>${sub ? `<span class="rsub">${esc(sub)}</span>` : ''}${stale && !live ? '<span class="rstale" title="New commits since the run on screen">new commits</span>' : ''}`;
}

// The run part of the drawer: which run, what's left, and a row per step with a box to tick it for Run selected.
function drawerRun() {
  const live = liveRun();
  const r = shownRun();
  const run = live ?? r;
  if (!run) return `<div class="rd-title"><b>No review yet</b></div><p class="rd-note">Run review reads the PR in a throwaway worktree with <span class="mono">claude -p</span>. Tick optional steps below to include them.</p>`;
  const left = live ? runLeftLabel(live) : run.endedAt ? `done in ${took(run.startedAt, run.endedAt)}` : '';
  const notes = [];
  if (live && r && live.id !== r.id) notes.push(`Showing run ${r.id} until this one is done, so you can keep reading.`);
  if (live && !r) notes.push('Sections fill in as their steps finish. You can open files and read the diff meanwhile.');
  if (r && state.pr && r.headSha !== state.pr.headSha) notes.push(`The PR has new commits since run ${r.id} (${esc(r.headSha.slice(0, 7))} → ${esc(state.pr.headSha.slice(0, 7))}).`);
  const wt = run.steps.find((s) => s.key === 'worktree');
  if (wt?.status === 'failed') notes.push(`<span class="bad">${esc(wt.output)}</span>`);
  if (!live && doneOutput(Object.fromEntries(run.steps.map((s) => [s.key, s])), 'taste')?.verify_error) notes.push("Taste questions weren't checked against the cited code.");
  const pickable = new Set((state.checks ?? []).filter((c) => !c.unavailable).map((c) => c.key));
  const rows = run.steps
    .map((s) => {
      const p = stepLeft(s);
      const box = pickable.has(s.key) ? `<input type="checkbox" data-extra="${esc(s.key)}" ${state.extras.has(s.key) ? 'checked' : ''} title="Tick to rerun just this step">` : '<span></span>';
      const x = live && (s.status === 'running' || s.status === 'queued') && s.key !== 'worktree' && s.key !== 'gate' ? `<button class="sx" type="button" data-stop="${esc(s.key)}" title="Stop just this step">×</button>` : '';
      return `<div class="rstep ${s.status}" data-key="${esc(s.key)}" title="${esc(s.status === 'failed' || s.status === 'skipped' ? s.output ?? '' : '')}">${box}<span class="rl">${esc(s.label)}</span><span class="rt">${esc(stepTime(s))}</span>${x}<span class="rb"><i style="width:${Math.round(p.frac * 100)}%"></i></span></div>`;
    })
    .join('');
  return `<div class="rd-title"><b>${live ? `Run ${live.id} running` : `Run ${run.id}`}</b><span id="rd-left" class="${live ? 'warn' : ''}">${esc(left)}</span></div>${notes.length ? `<p class="rd-note">${notes.join(' ')}</p>` : ''}<div class="rd-steps">${rows}</div>`;
}

function drawerHtml() {
  const live = liveRun();
  const r = shownRun();
  const run = live ?? r;
  const busy = !!live || state.starting;
  const colors = ['green', 'yellow', 'red'].map((c) => `<button type="button" data-color="${c}" class="c-${c} ${state.override === c ? 'on' : ''}" title="${COLOR[c]} (${c[0]})"><i></i>${COLOR[c]}</button>`).join('');
  const inRun = new Set((run?.steps ?? []).map((s) => s.key));
  const others = (state.checks ?? state.optional.map((o) => ({ ...o, optional: true }))).filter((c) => !inRun.has(c.key));
  const extras = others
    .map((c) => `<label class="rx ${c.unavailable ? 'faint' : ''}" title="${esc(c.unavailable ?? c.hint ?? '')}"><input type="checkbox" data-extra="${esc(c.key)}" ${state.extras.has(c.key) ? 'checked' : ''} ${c.unavailable ? 'disabled' : ''}><span>${esc(c.label)}</span><i>${c.optional ? 'optional, not run' : 'not in this run'}</i></label>`)
    .join('');
  const n = state.extras.size;
  const sameHead = r && state.pr && r.headSha === state.pr.headSha;
  const sel = r ? `<button class="btn" id="run-sel" type="button" ${busy || !n || !sameHead ? 'disabled' : ''} title="${sameHead ? 'Runs only the ticked steps and keeps the rest of this run' : 'The PR has new commits since this run, so run everything'}">${n ? `Run ${n} selected` : 'Run selected'}</button>` : '';
  const main = live ? `<button class="btn stop" type="button" id="stop-run" title="Stop every step and clean up">Cancel run</button>` : `<button class="btn primary" type="button" id="run" ${state.starting ? 'disabled' : ''}>${state.starting ? 'Starting…' : r ? 'Run everything' : 'Run review'}<kbd>⇧R</kbd></button>`;
  const pick = state.reviews.length > 1 ? `<select id="pick">${state.reviews.map((x) => `<option value="${x.id}" ${x.id === r?.id ? 'selected' : ''}>Run ${x.id} · ${when(x.startedAt)} · ${x.error === STOPPED ? 'stopped' : x.status}</option>`).join('')}</select>` : '';
  const hints = state.optional.filter((o) => o.hint && state.extras.has(o.key)).map((o) => `<p class="rd-foot">${esc(o.label)}: ${esc(o.hint)}</p>`).join('');
  return `<div class="rd-head"><span>Review run</span><button type="button" id="rd-close" title="Close (⇧D)">✕</button></div>
    <div class="rd-body"><span class="yourcall"><span>Your call</span><span class="seg3">${colors}</span></span>
    <div id="rd-live">${drawerRun()}</div>
    ${extras ? `<div class="rd-opt"><span class="kicker">Optional</span>${extras}</div>` : ''}
    <div class="rd-btns">${sel}${main}${pick}</div>
    <p class="rd-foot">Tick steps to redo just those. Runs locally in a throwaway worktree. Nothing is posted to GitHub.</p>${hints}</div>`;
}

function drawRun() {
  $('#runbtn').innerHTML = runButtonHtml();
  $('#runbtn').classList.toggle('on', !!state.drawer);
  const d = $('#rundrawer');
  d.hidden = !state.drawer;
  // An open run picker would close if redrawn under you, so leave the drawer alone while it has focus.
  if (state.drawer && !(d.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) {
    const top = d.scrollTop;
    d.innerHTML = drawerHtml();
    d.scrollTop = top;
  }
}

function toggleDrawer(open = !state.drawer) {
  state.drawer = open;
  localStorage.setItem('runDrawer', open ? '1' : '');
  drawRun();
}

// A section whose step is still going shows a placeholder with its own clock instead of a blank.
function pendingBody(step) {
  if (!step || (step.status !== 'running' && step.status !== 'queued')) return '';
  const p = stepLeft(step);
  const what = step.status === 'queued' ? `Waiting to start · usually ${dur(typical(step.key))}` : `Running ${dur(secs(step.startedAt))}${p.left > 1 ? ` · about ${dur(p.left)} left` : ''}`;
  return `<div class="pending" data-step="${esc(step.key)}"><span class="pw">${what}</span><span class="sk" style="width:92%"></span><span class="sk" style="width:78%"></span><span class="sk" style="width:85%"></span></div>`;
}

// Everything the page draws comes from one model, so the sidebar, the keys and the views agree on the order.
function model() {
  const r = shownRun();
  const steps = Object.fromEntries((r?.steps ?? []).map((s) => [s.key, s]));
  const lists = doneOutput(steps, 'guide')?.files ? fileItems(steps) : null;
  const notes = allNotes(steps);
  let groups;
  if (lists) {
    const full = lists.main.filter((f) => f.color === 'red');
    const skim = lists.main.filter((f) => f.color !== 'red');
    groups = [{ key: 'full', label: 'Read in full', files: full }, { key: 'skim', label: 'Skim', files: skim }];
    if (state.showRoutine || lists.routine.some((f) => f.file === state.cur)) groups.push({ key: 'routine', label: 'Routine', files: lists.routine });
  } else {
    groups = [{ key: 'all', label: 'Files', files: (state.pr?.files ?? []).map((f) => ({ file: f.path, color: null, note: '', add: f.additions, del: f.deletions })) }];
  }
  groups = groups.filter((g) => g.files.length);
  const files = groups.flatMap((g) => g.files);
  const order = ['brief', ...files.map((f) => f.file)];
  return { r, steps, lists, notes, groups, files, order };
}

function nextOpen(order, from) {
  const i = Math.max(0, order.indexOf(from));
  return [...order.slice(i + 1), ...order.slice(0, i)].find((x) => !state.reviewed.has(x)) ?? 'done';
}

// ——— Sidebar ———

function sidebar(m) {
  const g = gate();
  const R = state.reviewed;
  const reading = m.groups.filter((x) => x.key !== 'routine').flatMap((x) => x.files);
  const done = reading.filter((f) => R.has(f.file)).length;
  const left = reading.filter((f) => !R.has(f.file)).reduce((a, f) => a + mins(f), 0) + (R.has('brief') ? 0 : 2);
  const sig = signalOf(m.steps);
  let html = '';
  if (g.sendBack) html += `<div class="sendback"><span class="k1">Send back</span><b>Author should run a bug pass</b><span>No bug-pass label and no Copilot review.</span></div>`;
  html += `<section class="prog"><div class="top"><span><span class="big">${done}</span><span class="of">of ${reading.length} reviewed</span></span><span class="left">${left ? `~${left} min left` : 'nothing left'}</span></div>`;
  html += `<span class="pbar">${reading.map((f) => `<i class="${R.has(f.file) ? 'on' : ''}"></i>`).join('')}</span>`;
  if (sig) html += `<span class="risk c-${esc(sig.color)}"><i class="dot"></i><b>${esc(sig.title)}</b><span class="rs" title="${esc(sig.reason)}">${esc(sig.reason)}</span></span>`;
  html += `</section><nav>`;
  const item = (id, label, meta, hot = false) =>
    `<div class="it ${R.has(id) ? 'done' : ''} ${state.cur === id ? 'cur' : ''}" data-go="${esc(id)}" title="${esc(id === 'brief' ? label : id)}"><span class="box" data-tick="${esc(id)}" title="Mark reviewed (space)">${R.has(id) ? '✓' : ''}</span><span class="lbl">${id === 'brief' ? esc(label) : nameHtml(id)}</span><span class="im ${hot ? 'hot' : ''}">${esc(meta)}</span></div>`;
  const d = doneOutput(m.steps, 'description');
  const nGaps = d ? d.gaps.length + (d.ui_change && !d.has_screenshots ? 1 : 0) : 0;
  const gaps = d?.verdict === 'no description' ? 'no description' : nGaps ? plural(nGaps, 'gap') : '';
  html += `<div class="grp"><span class="glabel"><span>Read first</span><span>${R.has('brief') ? 'read' : ''}</span></span>${item('brief', 'Risk, description and how it works', gaps, !!gaps)}</div>`;
  for (const grp of m.groups) {
    const count = `${grp.files.filter((f) => R.has(f.file)).length}/${grp.files.length}`;
    html += `<div class="grp"><span class="glabel"><span>${esc(grp.label)}</span><span>${count}</span></span>`;
    for (const f of grp.files) {
      const ns = m.notes.filter((n) => n.file === f.file);
      const checks = ns.filter(isCheck).length;
      const untested = ns.filter((n) => n.kind === 'test-gap').length;
      const taste = ns.filter((n) => n.kind === 'taste').length;
      const meta = !m.lists ? `+${f.add} −${f.del}` : checks ? `${checks} check` : untested ? `${untested} untested` : taste ? `${taste} taste` : `${mins(f)}m`;
      const mine = state.comments.filter((c) => c.path === f.file).length;
      const talk = threadCount(f.file);
      html += item(f.file, base(f.file), [meta, talk && `${talk} 💬`, mine && `${mine} yours`].filter(Boolean).join(' · '), checks > 0);
    }
    html += `</div>`;
  }
  if (m.lists?.routine.length && !m.groups.some((x) => x.key === 'routine')) {
    const rt = m.lists.routine;
    html += `<button class="hidden-note" id="show-routine" type="button" title="Show them in the list">${plural(rt.length, 'routine file')} hidden · +${num(rt.reduce((a, f) => a + f.add, 0))} −${num(rt.reduce((a, f) => a + f.del, 0))}</button>`;
  }
  const n = state.comments.length;
  // Each pending comment as one line you can click to jump to it.
  const list = [...state.comments]
    .sort((a, b) => m.order.indexOf(a.path) - m.order.indexOf(b.path) || a.line - b.line)
    .map((c) => `<button class="cj" type="button" data-jump="${c.id}" title="${esc(c.text)}"><span class="cf">${esc(shortName(c.path))}:${c.line}</span><span class="cx">${esc(c.text.split('\n')[0])}</span></button>`)
    .join('');
  html += `</nav><div class="subbox">${list ? `<div class="clist">${list}</div>` : ''}<span class="sbt"><span>${n ? plural(n, 'pending comment') : 'No pending comments'}</span>${n ? '<span class="faint">not posted yet</span>' : ''}</span><button class="btn ${n ? 'primary' : ''}" type="button" id="open-submit">Submit review<kbd>⇧S</kbd></button></div>`;
  return html;
}

// ——— Brief ———

// Your color wins over the run's.
function signalOf(steps) {
  const sig = doneOutput(steps, 'signal');
  const o = state.override;
  // The run's reason often starts with its own color word, which the page already shows.
  const reason = (sig?.reason ?? '').replace(/^(red|yellow|green):\s*/i, '');
  if (o) return { color: o, title: `${COLOR[o]}, your call`, reason };
  if (!sig) return null;
  return { color: sig.color, title: COLOR[sig.color], reason, raisedBy: sig.raisedBy, floor: sig.floor };
}

function headMeta() {
  const pr = state.pr;
  const bits = [`<span class="who"><span class="av" style="background-image:url(https://github.com/${encodeURIComponent(pr.author)}.png?size=48)"></span>@${esc(pr.author)}</span>`];
  const d = doneEntry();
  const p = row();
  if (pr.state && pr.state !== 'OPEN') bits.push(`<b>${pr.state.toLowerCase()}</b>`);
  if (d) bits.push(`✓ ${esc(DONE_WORD[d.reason] ?? d.reason)} ${ago2(d.doneAt)} ago`);
  if (pr.mine) {
    bits.push('<span class="direct">your PR</span>');
    if (p?.waitingOn) bits.push(p.waitingOn.length ? `waiting on ${esc(p.waitingOn.join(', '))}` : 'no reviewer asked');
    if (p?.reviewDecision === 'APPROVED') bits.push('approved');
    if (p?.reviewDecision === 'CHANGES_REQUESTED') bits.push('changes requested');
  } else if (p && !d) {
    bits.push(`${p.requestedVia === 'direct' ? '<span class="direct">asked you</span>' : `via ${esc(p.requestedVia.join(', ') || 'a team')}`} ${ago2(p.requestedAt)} ago`);
    if (REVIEW_WORD[p.myReview]) bits.push(REVIEW_WORD[p.myReview]);
    if (p.reviewDecision === 'CHANGES_REQUESTED') bits.push('changes requested');
  }
  bits.push(`<span class="num"><span class="add">+${num(pr.additions)}</span> <span class="del">−${num(pr.deletions)}</span></span> in ${plural(pr.files.length, 'file')}`);
  bits.push(`into <code>${esc(pr.baseRef)}</code>`);
  if (pr.isDraft) bits.push('<span class="draft-pill">Draft</span>');
  if (p?.ci === 'failure') bits.push('<span class="bad">CI failing</span>');
  if (p?.ci === 'pending') bits.push('CI running');
  if (gate().word) bits.push(gate().word);
  const stack = stackPips();
  if (stack) bits.push(stack);
  return `<div class="meta">${bits.map((b) => `<span>${b}</span>`).join('')}</div>`;
}

const tools = `<span class="tools"><button class="ask-md" type="button" title="Ask Claude about this section">Ask</button><button class="copy-md" type="button" title="Copy this section as markdown for a GitHub comment">Copy</button></span>`;
// The steps each section comes from, so its Rerun button redoes just those.
const SEC_STEPS = { risk: ['signal', 'check'], help: ['help'], description: ['description'], explain: ['explain'], taste: ['taste'] };
const rerunBtn = (id) => {
  const keys = SEC_STEPS[id] ?? (shownRun()?.steps.some((x) => x.key === id) ? [id] : null);
  if (!keys) return '';
  return shownRun() && !liveRun() ? `<button class="ask-md rerun-sec" type="button" data-only="${esc(keys.join(','))}" title="Rerun just this section, keeping the rest of the run">Rerun</button>` : '';
};
const bsec = (id, title, body, extra = '', cls = '') => `<section class="bsec ${cls}" id="c-${id}" data-sec="${id}"><div class="shead"><h2>${esc(title)}</h2>${extra}${tools.replace('<span class="tools">', `<span class="tools">${rerunBtn(id)}`)}</div><div class="sec-body">${body}</div></section>`;

// The numbers row: how long, then what's waiting. Each number is the thing you act on.
function stats(m) {
  const g = doneOutput(m.steps, 'guide');
  const d = doneOutput(m.steps, 'description');
  const spots = m.notes.filter(isCheck).length;
  const untested = m.notes.filter((n) => n.kind === 'test-gap').length;
  const taste = m.notes.filter((n) => n.kind === 'taste').length;
  const cell = (big, label, cls = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="stat ${cls}"><span class="big">${big}</span><span class="label">${label}</span></${href ? 'a' : 'div'}>`;
  const cells = [cell(`~${g.minutes === 90 ? '90+' : g.minutes} min`, `to read ${m.lists.main.length} of ${m.lists.items.length} files`)];
  cells.push(cell(spots, `spot${spots === 1 ? '' : 's'} to check`, spots ? 'bad' : 'zero'));
  cells.push(cell(untested, `untested behavior${untested === 1 ? '' : 's'}`, untested ? 'warn' : 'zero'));
  if (taste) cells.push(cell(taste, `taste question${taste === 1 ? '' : 's'}`, '', '#c-taste'));
  if (d) {
    const shots = d.ui_change && !d.has_screenshots;
    if (d.verdict === 'matches' && !shots) cells.push(cell('✓', 'description matches', 'zero'));
    else cells.push(cell(d.verdict === 'no description' ? '—' : d.gaps.length, `${d.verdict === 'no description' ? 'no description' : `description gap${d.gaps.length === 1 ? '' : 's'}`}${shots ? ', no screenshots' : ''}`, 'warn', '#c-description'));
  }
  return `<div class="stats">${cells.join('')}</div>`;
}

const SEG = { red: 'read in full', yellow: 'skim', green: 'nothing flagged' };

// One bar for the whole diff: a segment per file to read, sized by changed lines, then the routine rest.
function fileMap(main, routine) {
  const caption = `${num(lines(main))} of ${num(lines(main) + lines(routine))} changed lines need eyes`;
  const segs = main.map((f) => `<span class="seg ${esc(f.color)}" data-file="${esc(f.file)}" data-cap="${esc(`${shortName(f.file)} · +${f.add} −${f.del} · ${SEG[f.color] ?? ''}`)}" style="flex:${Math.max(1, f.add + f.del)}"></span>`);
  if (routine.length) segs.push(`<span class="seg routine" data-cap="${esc(`${plural(routine.length, 'routine file')} · +${num(routine.reduce((a, f) => a + f.add, 0))} −${num(routine.reduce((a, f) => a + f.del, 0))}`)}" style="flex:${Math.max(1, lines(routine))}"></span>`);
  const used = new Set([...main.map((f) => f.color), ...(routine.length ? ['routine'] : [])]);
  const legend = ['red', 'yellow', 'green', 'routine'].filter((c) => used.has(c)).map((c) => `<span><i class="sw ${c}"></i>${SEG[c] ?? 'routine'}</span>`).join('');
  return `<div class="map"><div class="mapbar">${segs.join('')}</div><div class="map-foot"><span class="cap" data-default="${esc(caption)}">${esc(caption)}</span><span class="legend">${legend}</span></div></div>`;
}

const took = (from, to) => {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

function statusWord(s) {
  if (s.status === 'running') return `running ${ago(s.startedAt)}`;
  if (s.status === 'done' && s.startedAt && s.endedAt) return `done in ${took(s.startedAt, s.endedAt)}`;
  return s.status;
}

const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function stepBody(step) {
  if (step.status === 'queued' || step.status === 'running') return pendingBody(step);
  if (step.status === 'skipped') return `<p class="faint">Skipped. ${esc(step.output)}</p>`;
  if (step.status === 'failed') return `<pre class="err">${esc(step.output)}</pre>`;
  return `<div class="md">${markdown(step.output)}</div>`;
}

// Steps the brief and the files already show. Anything else, like the optional checks, gets its own section.
const SHOWN = ['gate', 'worktree', 'help', 'explain', 'guide', 'description', 'signal', 'check', 'taste', 'risk', 'files'];

// The first sentence of each step leads in bold, so the list reads as a summary at a glance.
function howStep(s, sha) {
  const m = String(s.text).match(/^(.+?[.!?])\s+(.+)$/s);
  return `<p>${m ? `<b>${t(m[1])}</b> ${t(m[2])}` : t(s.text)} ${whereLink(s.where, sha)}</p>`;
}

function brief(m) {
  const pr = state.pr;
  const { r, steps } = m;
  const ex = doneOutput(steps, 'explain');
  let html = `<div class="brief"><div class="head"><span class="kicker">Read first · about 2 min</span><h1>${esc(pr.title)}</h1>${headMeta()}${ex ? `<p class="purpose">${t(ex.one_liner)}</p>` : ''}</div>`;

  // Risk: the color, the numbers and the map.
  const sig = signalOf(steps);
  let risk = '';
  const why = state.override ? (doneOutput(steps, 'signal') ? `The run said ${esc(COLOR[doneOutput(steps, 'signal').color].toLowerCase())}: ${t(doneOutput(steps, 'signal').reason)}.` : '') : sig?.floor?.length ? `Path floor: ${plural(sig.floor.length, 'file')} on a red path ${sig.floor.length === 1 ? 'is' : 'are'} always read in full.` : sig?.raisedBy ? `Raised by a check, was ${esc(sig.raisedBy)}.` : '';
  if (why) risk += `<span class="riskwhy">${why}</span>`;
  if (m.lists) risk += stats(m) + fileMap(m.lists.main, m.lists.routine);
  const g = doneOutput(steps, 'guide');
  if (g && !g.files) risk += `<div class="flag">This run is from before the file list. Run review again (<kbd>⇧R</kbd>) to get it.</div>`;
  // The run itself lives in the bottom bar and its drawer (⇧D); the brief only says when there's nothing yet.
  if (!r && !liveRun()) risk += `<p class="riskwhy">No review yet. <button class="link" type="button" id="run">Run review</button> (⇧R) to get the color, the numbers and the notes, or open the run (⇧D) to pick optional steps first.</p>`;
  const sigHead = sig ? `<span class="sig c-${esc(sig.color)}"><i></i>${esc(sig.title)}${sig.reason ? `: ${t(sig.reason)}` : ''}</span>` : '';
  html += bsec('risk', 'Risk', risk, sigHead, 'first');

  // Where you can help: the few calls that need an expert, before the wall of findings below.
  const h = doneOutput(steps, 'help');
  if (h) {
    const asks = (h.asks ?? []).map((a) => `<div class="ask"><p><b>${t(a.question)}</b> ${t(a.stake)} ${a.where ? whereLink(a.where, r.headSha) : ''}</p>${a.why_you ? `<p class="why">${t(a.why_you)}</p>` : ''}</div>`);
    html += bsec('help', 'Where you can help', `<div class="help"><p class="${asks.length ? 'stake' : ''}">${t(h.at_stake)}</p>${asks.join('')}</div>`, `<span class="sub">The calls that need your expertise</span>`);
  } else if (steps.help && steps.help.status !== 'skipped') html += bsec('help', 'Where you can help', stepBody(steps.help));

  const talk = conversation();
  if (talk) html += bsec('conversation', 'Conversation', talk, `<span class="sub">From GitHub, read only</span>`);

  // Description: what the author wrote, next to where it and the diff disagree.
  const d = doneOutput(steps, 'description');
  // Long descriptions fold so How this works stays close; the toggle shows the rest.
  const written = `<div class="col"><span class="kicker">Description, as written</span><div class="md ${state.descOpen ? '' : 'clip'}" id="desc-body">${pr.body.trim() ? markdown(pr.body) : '<p class="faint">No description.</p>'}</div><button class="link" id="desc-more" type="button" hidden>${state.descOpen ? 'Show less' : 'Show the whole description'}</button></div>`;
  let gaps = '';
  if (d) {
    const shots = d.ui_change && !d.has_screenshots;
    const items = [...(shots ? [`<p><b>No screenshots.</b> This changes UI and the description has none.</p>`] : []), ...d.gaps.map((x) => `<p>${t(x.gap)} ${whereLink(x.where, r.headSha)}</p>`)];
    if (d.verdict === 'no description') items.unshift(`<p><b>No description.</b> ${t(d.summary)}</p>`);
    const n = items.length;
    gaps = `<div class="gaps"><span class="kicker"><span>Description gaps</span><span class="${n ? 'c-yellow' : ''}">${n || '✓'}</span></span>${n ? items.join('') : `<p class="ok">Matches the diff. ${t(d.summary)}</p>`}</div>`;
  } else if (steps.description) gaps = `<div class="gaps">${stepBody(steps.description)}</div>`;
  html += bsec('description', 'Description', `<div class="desc2">${written}${gaps}</div>`);

  if (steps.explain?.status === 'done' && ex) html += bsec('explain', 'How this works', `<div class="how">${ex.steps.map((s) => howStep(s, r.headSha)).join('')}</div>`);
  else if (steps.explain) html += bsec('explain', 'How this works', stepBody(steps.explain));

  const qs = tasteQuestions(doneOutput(steps, 'taste'));
  const existing = tasteExisting(doneOutput(steps, 'taste'));
  if (!qs.length && !existing.length && pendingBody(steps.taste)) html += bsec('taste', 'Taste questions', pendingBody(steps.taste));
  if (qs.length || existing.length) {
    const row = (q, label) => {
      const pr0 = q.file ? whereLink(`${q.file}${q.lines ? `:${String(q.lines).split('-')[0]}` : ''}`, r.headSha) : '';
      return `<div class="taste"><span class="lens">${esc(label)}</span><div class="q"><p>${t(q.question)}</p>${q.why ? `<p>${t(q.why)}</p>` : ''}<span class="links">${pr0}${artLink(priorArt(q))}</span></div></div>`;
    };
    let body = qs.map((q) => row(q, LENS[q.lens] ?? q.lens)).join('');
    if (existing.length) body += `<span class="kicker taste-sub">While you're here: the existing code, not for the author</span>${existing.map((q) => row(q, 'Existing code')).join('')}`;
    html += bsec('taste', 'Taste questions', body, `<span class="sub">Questions for the author, checked against prior art and the area's standards</span>`);
  }
  for (const s of r?.steps ?? []) if (!SHOWN.includes(s.key)) html += bsec(s.key, s.label, `<div class="other">${hasFindings(s.key) && s.status === 'done' && pr.mine ? findingsPick(r, s) : ''}${stepBody(s)}</div>`);

  const read = state.reviewed.has('brief');
  html += `<div class="cta"><button class="btn primary" type="button" id="brief-done">${read ? 'Start the files' : 'Done reading, start the files'}<kbd>space</kbd></button><span>Ticks this off and moves it out of the way. It stays one click away in the list.</span></div>`;
  return html + `</div>`;
}

// ——— Findings to post from a bug-finding check (your own PRs only) ———

const SEV = { blocker: 'Blocker', important: 'Important', suggestion: 'Suggestion' };
const hasFindings = (key) => !!state.checks?.some((c) => c.key === key && c.findings);
const bhKey = (reviewId, key) => `${reviewId}:${key}`;

async function loadFindings(reviewId, key) {
  const k = bhKey(reviewId, key);
  state.bh[k] = { reviewId, key, run: undefined, picked: new Set(), posting: false, error: null };
  const res = await fetch(`/api/findings?url=${encodeURIComponent(url)}&review=${reviewId}&key=${encodeURIComponent(key)}`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (!state.bh[k]) return;
  state.bh[k].run = res.run ?? null;
  state.bh[k].error = res.error ?? null;
  render();
}

// You tick the findings you want and press Post. Nothing is ticked to start, and nothing posts without that click.
function findingsPick(r, step) {
  const k = bhKey(r.id, step.key);
  const bh = state.bh[k];
  if (!bh) return loadFindings(r.id, step.key), '';
  if (bh.run === undefined) return '<p class="faint">Looking for this run\'s findings…</p>';
  const run = bh.run;
  if (!run) return `<p class="faint">${bh.error ? esc(bh.error) : "This run saved no findings, so there's nothing to post from here."}</p>`;
  const done = new Set(run.posted.flatMap((p) => p.ids));
  const posted = run.posted.map((p) => `<p class="bh-posted">Posted ${plural(p.ids.length, 'finding')} ${when(p.at)}${p.url ? ` · <a href="${safe(p.url)}" target="_blank" rel="noreferrer">see it on GitHub</a>` : ''}</p>`).join('');
  if (!run.findings.length) return `<div class="bh">${posted}<p class="faint">${esc(step.label)} found nothing worth posting.</p></div>`;
  const moved = state.pr.headSha !== run.headSha;
  const items = run.findings
    .map((f) => {
      const was = done.has(f.id);
      const on = bh.picked.has(f.id);
      const where = whereLink(`${f.file}:${f.line}`, run.headSha);
      const sev = f.severity ? `<span class="sev ${esc(f.severity)}">${esc(SEV[f.severity] ?? f.severity)}</span>` : '';
      return `<div class="bhf ${on ? 'on' : ''} ${was ? 'was' : ''}"><label><input type="checkbox" data-bh="${esc(k)}" data-id="${f.id}" ${on ? 'checked' : ''} ${moved ? 'disabled' : ''}>${sev}<b>${t(f.title)}</b>${was ? '<span class="tagp">posted</span>' : ''}</label>
        <div class="bhm">${where}${f.inline ? '' : ' · goes in the review body, GitHub can\'t anchor this line'}</div>${f.body ? `<p>${t(f.body)}</p>` : ''}</div>`;
    })
    .join('');
  const n = bh.picked.size;
  const note = moved
    ? `<p class="flag">The PR has new commits since ${esc(step.label)} ran on ${esc(run.headSha.slice(0, 7))}. Run it again to post from the new head.</p>`
    : '<p class="faint">Posts one review from you with a line comment per finding, saying you picked them.</p>';
  return `<div class="bh"><span class="kicker"><span>Post findings to GitHub</span><span>${n} of ${run.findings.length} picked</span></span>${posted}${items}${note}${bh.error ? `<p class="flag">${esc(bh.error)}</p>` : ''}
    <span class="bh-acts"><button class="btn primary" type="button" id="bh-post" data-bhk="${esc(k)}" ${!n || moved || bh.posting ? 'disabled' : ''}>${bh.posting ? 'Posting…' : n ? `Post ${plural(n, 'finding')}` : 'Pick findings to post'}</button><button class="btn" type="button" id="bh-all" data-bhk="${esc(k)}" ${moved ? 'disabled' : ''}>${n === run.findings.length ? 'Pick none' : 'Pick all'}</button></span></div>`;
}

async function postFindings(k) {
  const bh = state.bh[k];
  if (!bh?.run || !bh.picked.size || bh.posting) return;
  const ids = [...bh.picked].sort((a, b) => a - b);
  if (!confirm(`Post ${plural(ids.length, 'finding')} to #${number} on GitHub? This can't be unsent.`)) return;
  bh.posting = true;
  bh.error = null;
  render();
  const res = await post('/api/findings/post', { url, review: bh.reviewId, key: bh.key, ids }).catch((e) => ({ error: e.message }));
  bh.posting = false;
  if (res.error) bh.error = `GitHub didn't take it: ${res.error}`;
  else (bh.run = res.run), bh.picked.clear(), status(`Posted ${plural(ids.length, 'finding')} to GitHub`);
  render();
  // GitHub's comments on the page pick up the new review.
  fetch(`/api/comments?url=${encodeURIComponent(url)}`).then((r) => (r.ok ? r.json() : null)).then((g) => g?.lines && ((state.gh = g), render())).catch(() => {});
}

// ——— One file ———

// gh pr diff, split per file into hunks of [sign, old line, new line, code].
function parseDiff(text) {
  const out = {};
  let file = null;
  let hunk = null;
  let o = 0;
  let n = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) {
      file = { hunks: [], binary: false };
      const m = l.match(/ b\/(.+)$/);
      if (m) out[m[1]] = file;
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (l.startsWith('+++ ')) {
      // Renames carry the new path here, which is the one the PR's file list uses.
      const m = l.match(/^\+\+\+ b\/(.+)$/);
      if (m && !out[m[1]]) out[m[1]] = file;
      continue;
    }
    if (l.startsWith('Binary files')) file.binary = true;
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      hunk = { head: l.slice(0, l.indexOf('@@', 2) + 2), ctx: h[3].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const s = l[0];
    if (s === '+') hunk.lines.push(['+', '', n++, l.slice(1)]);
    else if (s === '-') hunk.lines.push(['-', o++, '', l.slice(1)]);
    else if (s === ' ') hunk.lines.push([' ', o++, n++, l.slice(1)]);
  }
  return out;
}

const MAX_LINES = 1500;

// ——— Syntax highlighting ———

const LANG = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml', md: 'markdown', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp', graphql: 'graphql', gql: 'graphql', lua: 'lua', mk: 'makefile',
};
const langOf = (path) => (/(^|\/)Makefile$/.test(path) ? 'makefile' : LANG[path.split('.').pop().toLowerCase()]);

// highlight.js returns one HTML string; cut it per line, closing and reopening spans that cross a line break.
function splitLines(html) {
  const out = [];
  const open = [];
  let cur = '';
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) open.push(m[1]), (cur += m[1]);
    else if (m[2]) open.pop(), (cur += '</span>');
    else if (m[3]) out.push(cur + '</span>'.repeat(open.length)), (cur = open.join(''));
    else cur += m[4];
  }
  out.push(cur);
  return out;
}

// Each side of a hunk is highlighted as one block, so strings and comments that span lines color right.
// Context lines take the new side's colors. Returns one HTML string per line, or null to fall back to plain text.
function highlightHunk(h, lang) {
  if (!lang || !window.hljs?.getLanguage(lang)) return null;
  const side = (skip) => {
    const idx = h.lines.map((l, i) => (l[0] === skip ? -1 : i)).filter((i) => i >= 0);
    try {
      const lines = splitLines(window.hljs.highlight(idx.map((i) => h.lines[i][3]).join('\n'), { language: lang, ignoreIllegals: true }).value);
      return new Map(idx.map((i, k) => [i, lines[k]]));
    } catch {
      return new Map();
    }
  };
  const oldSide = side('+');
  const newSide = side('-');
  return h.lines.map((l, i) => (l[0] === '-' ? oldSide.get(i) : newSide.get(i)) ?? esc(l[3]));
}

// ——— Everyone else's comments, read from GitHub ———

const av = (user) => `<span class="av" style="background-image:url(https://github.com/${encodeURIComponent(user)}.png?size=40)"></span>`;
const ghComment = (c) =>
  `<div class="gc"><span class="gh2">${av(c.user)}<b>@${esc(c.user)}</b><span>${ago2(c.at)} ago</span><a class="gl" href="${safe(c.url)}" target="_blank" rel="noreferrer">on GitHub ↗</a></span><div class="md">${markdown(c.body)}</div></div>`;

// A line's threads: each first comment with its replies under it, oldest first.
function ghThreads(path, side, line) {
  const all = state.gh?.lines ?? [];
  return all
    .filter((c) => !c.replyTo && c.path === path && c.side === side && c.line === line)
    .map((root) => `<div class="gthread">${[root, ...all.filter((r) => r.replyTo === root.id)].map(ghComment).join('')}</div>`)
    .join('');
}

const threadCount = (path) => (state.gh?.lines ?? []).filter((c) => !c.replyTo && c.path === path).length;

// Reviews and the conversation, newest last, with bot comments folded away.
function conversation() {
  const g = state.gh;
  if (!g) return '';
  const word = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'review dismissed' };
  const items = [...g.reviews.map((r) => ({ ...r, review: true })), ...g.conversation.filter((c) => !c.bot)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const bots = g.conversation.filter((c) => c.bot);
  const roots = g.lines.filter((c) => !c.replyTo);
  if (!items.length && !bots.length && !roots.length) return '';
  const files = [...new Set(roots.map((c) => c.path))];
  let html = '';
  if (roots.length) html += `<p class="threads">${plural(roots.length, 'line thread')} in ${plural(files.length, 'file')}: ${files.map((f) => `<a href="#" data-open="${esc(f)}">${esc(shortName(f))}</a> <span class="faint">${threadCount(f)}</span>`).join(' · ')}</p>`;
  html += items
    .map((c) => (c.review ? `<div class="gc rv ${esc(c.state.toLowerCase())}"><span class="gh2">${av(c.user)}<b>@${esc(c.user)}</b><span class="st">${esc(word[c.state] ?? c.state.toLowerCase())}</span><span>${ago2(c.at)} ago</span><a class="gl" href="${safe(c.url)}" target="_blank" rel="noreferrer">on GitHub ↗</a></span>${c.body.trim() ? `<div class="md">${markdown(c.body)}</div>` : ''}</div>` : ghComment(c)))
    .join('');
  if (bots.length) html += `<details class="bots"><summary>${plural(bots.length, 'bot comment')} (${esc([...new Set(bots.map((b) => b.user))].join(', '))})</summary>${bots.map(ghComment).join('')}</details>`;
  return html;
}

// ——— Your line comments ———

function saveComments() {
  localStorage.setItem(COMMENTS_KEY, JSON.stringify(state.comments));
}

// The + that opens a comment box on one side of one line.
const cmtBtn = (path, side, line, code, label = '+') =>
  line ? `<button class="cmt" type="button" tabindex="-1" data-path="${esc(path)}" data-side="${side}" data-line="${line}" data-code="${esc(code)}" title="Comment on line ${line}">${label}</button>` : '<span></span>';

function commentsAt(path, side, line) {
  if (!line) return '';
  let html = ghThreads(path, side, line) + state.comments
    .filter((c) => c.path === path && c.side === side && c.line === line && c.id !== state.draft?.editId)
    .map((c) => `<div class="ucmt" data-cid="${c.id}"><span class="uh"><b>You</b><span>pending · goes to GitHub when you submit</span><span class="ua"><button class="link" type="button" data-edit="${c.id}">Edit</button><button class="link" type="button" data-del="${c.id}">Delete</button></span></span><div class="ut">${esc(c.text)}</div></div>`)
    .join('');
  const d = state.draft;
  if (d && d.path === path && d.side === side && d.line === line)
    html += `<div class="draft"><textarea id="draft" rows="3" placeholder="Comment on line ${line}">${esc(d.text)}</textarea><span class="da"><button class="btn primary" type="button" id="draft-save">${d.editId ? 'Save' : 'Add to review'}<kbd>⌘⏎</kbd></button><button class="btn" type="button" id="draft-cancel">Cancel</button><button class="link" type="button" id="draft-ask">Ask Claude about this line</button></span></div>`;
  return html;
}

function openDraft(path, side, line, code, text = '', editId = null, from = null) {
  state.draft = { path, side, line, code, text, editId, from };
  render();
}

// ——— Callouts into your review ———

// What a callout becomes as a line comment: the note, the failure it describes, and the prior art it cites.
const noteText = (x) => [x.note, x.scenario, x.art?.url ? `Prior art: ${x.art.url}` : ''].filter(Boolean).join('\n\n');
const noteKey = (x) => `${x.kind}:${x.note}`;
const fromNote = (path, line, key) => state.comments.find((c) => c.path === path && c.line === line && c.from === key);

// A Taste or Check callout under a diff line can become a pending comment on that line, which you edit before it goes in.
function noteBtn(path, line, x) {
  const added = fromNote(path, line, noteKey(x));
  if (added) return `<button class="link nadd" type="button" data-jump="${added.id}" title="Already a pending comment on line ${line}">In your review ✓</button>`;
  return `<button class="link nadd" type="button" data-note-path="${esc(path)}" data-note-line="${line}" data-note-key="${esc(noteKey(x))}" data-note-text="${esc(noteText(x))}" title="Opens a comment on line ${line} with this text, for you to edit and add">Add to review</button>`;
}

function draftFromNote(btn) {
  const path = btn.dataset.notePath;
  const line = Number(btn.dataset.noteLine);
  const code = state.diff?.[path]?.hunks.flatMap((h) => h.lines).find((l) => l[0] !== '-' && l[2] === line)?.[3] ?? '';
  openDraft(path, 'RIGHT', line, code, btn.dataset.noteText, null, btn.dataset.noteKey);
}

function saveDraft() {
  const d = state.draft;
  if (!d) return;
  const text = d.text.trim();
  state.draft = null;
  const from = d.from ?? state.comments.find((c) => c.id === d.editId)?.from;
  if (d.editId) state.comments = state.comments.filter((c) => c.id !== d.editId);
  if (text) state.comments.push({ id: d.editId ?? Date.now(), path: d.path, side: d.side, line: d.line, code: d.code, text, sha: state.pr.headSha, ...(from ? { from } : {}) });
  saveComments();
  status(text ? `Comment added to your pending review · ${plural(state.comments.length, 'pending comment')}` : 'Comment dropped');
  render();
}

function removeComment(id) {
  state.comments = state.comments.filter((c) => c.id !== id);
  saveComments();
  status(`Comment deleted · ${plural(state.comments.length, 'pending comment')}`);
  render();
}

// Opens the comment's file and scrolls to it, once the diff is there to scroll to.
function jumpToComment(id) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) return;
  state.jump = id;
  open(c.path);
}

function openSubmit() {
  if (state.cur !== 'submit') state.back = state.cur;
  state.submitError = null;
  open('submit');
}

const VERDICTS = [['COMMENT', 'Comment'], ['APPROVE', 'Approve'], ['REQUEST_CHANGES', 'Request changes']];

function submitView() {
  const n = state.comments.length;
  // GitHub doesn't let you approve or request changes on your own PR.
  if (state.pr.mine) state.verdict = 'COMMENT';
  const verdicts = VERDICTS.filter(([k]) => !state.pr.mine || k === 'COMMENT').map(([k, label]) => `<button type="button" data-verdict="${k}" class="${state.verdict === k ? 'on' : ''}">${label}</button>`).join('');
  const files = [...new Set(state.comments.map((c) => c.path))];
  const groups = files
    .map((p) => `<div class="pg"><a href="#" class="pgn" data-open="${esc(p)}">${esc(shortName(p))}</a>${state.comments.filter((c) => c.path === p).sort((a, b) => a.line - b.line).map((c) => `<div class="pc"><span class="pl">${c.side === 'LEFT' ? 'old ' : ''}line ${c.line}</span><span class="pt2">${esc(c.text)}</span><button class="link" type="button" data-del="${c.id}">Delete</button></div>`).join('')}</div>`)
    .join('');
  const label = { COMMENT: 'Submit comments', APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes' }[state.verdict];
  const moved = n && state.comments.some((c) => c.sha && c.sha !== state.pr.headSha) ? `<p class="flag">Some comments were written on an older version of this PR. GitHub may reject lines that moved.</p>` : '';
  return `<div class="submit"><div class="head"><h1>Submit review</h1><span class="why">Posts to GitHub as one review on #${number}. Nothing is sent until you press ${esc(label)}.</span></div>
    <span class="seg3 verdicts">${verdicts}</span>
    <textarea id="summary" rows="4" placeholder="Summary for the author${state.verdict === 'REQUEST_CHANGES' ? ' (needed to request changes)' : ' (optional)'}">${esc(state.summary)}</textarea>
    <div class="plist"><span class="kicker">${n ? plural(n, 'pending comment') : 'No pending comments'}</span>${groups || '<p class="why">No line comments yet. Click + next to any diff line to add one.</p>'}</div>
    ${moved}${state.submitError ? `<p class="flag">${esc(state.submitError)}</p>` : ''}
    <span class="sacts"><button class="btn primary" type="button" id="submit-review" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Posting…' : esc(label)}<kbd>⌘⏎</kbd></button><button class="btn" type="button" id="sub-back">Keep reviewing</button></span></div>`;
}

async function submitReview() {
  if (state.submitting) return;
  const body = state.summary.trim();
  if (state.verdict === 'REQUEST_CHANGES' && !body) return (state.submitError = 'Requesting changes needs a summary for the author.'), render();
  if (state.verdict === 'COMMENT' && !body && !state.comments.length) return (state.submitError = 'Add a summary or at least one line comment.'), render();
  state.submitting = true;
  state.submitError = null;
  render();
  const comments = state.comments.map(({ path, line, side, text }) => ({ path, line, side, body: text }));
  const res = await fetch('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, event: state.verdict, body, comments, commitId: state.pr.headSha }) })
    .then(async (r) => (r.status === 404 ? { error: "this server can't submit reviews yet, so your comments are still saved here" } : r.json()))
    .catch((e) => ({ error: e.message }));
  state.submitting = false;
  if (res.error) return (state.submitError = `GitHub didn't take it: ${res.error}`), render();
  const word = VERDICTS.find(([k]) => k === state.verdict)[1];
  status(`Posted your review to GitHub · ${word} · ${plural(comments.length, 'line comment')}`);
  state.comments = [];
  state.summary = '';
  saveComments();
  open(state.back === 'submit' ? 'brief' : state.back);
}

// Side by side like GitHub: context on both sides, and each run of removals paired with the additions after it.
function splitRows(lines, noteAt, path) {
  const out = [];
  // Unchanged lines take comments on the new side, like GitHub's own split view.
  const key = (side, l) => (side === 'L' && l[0] === '-' ? ['LEFT', l[1]] : ['RIGHT', l[2]]);
  const cell = (side, l) => {
    if (!l) return '<span class="o e"></span><span class="c e"></span>';
    const [sd, ln] = key(side, l);
    return `<span class="o">${cmtBtn(path, sd, ln, l[3], side === 'L' ? l[1] : l[2])}</span><span class="c ${l[0] === '-' ? 'd' : l[0] === '+' ? 'a' : ''}">${l[4]}</span>`;
  };
  const after = (l, r) => (l && l[0] === '-' ? commentsAt(path, 'LEFT', l[1]) : '') + (r ? commentsAt(path, 'RIGHT', r[2]) : '');
  for (let i = 0; i < lines.length; ) {
    if (lines[i][0] === ' ') {
      out.push(`<div class="sl">${cell('L', lines[i])}${cell('R', lines[i])}</div>${noteAt(lines[i][2])}${after(null, lines[i])}`);
      i++;
      continue;
    }
    const del = [];
    const add = [];
    while (i < lines.length && lines[i][0] === '-') del.push(lines[i++]);
    while (i < lines.length && lines[i][0] === '+') add.push(lines[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) out.push(`<div class="sl">${cell('L', del[k])}${cell('R', add[k])}</div>${add[k] ? noteAt(add[k][2]) : ''}${after(del[k], add[k])}`);
  }
  return out.join('');
}

// ——— Markdown files, rendered ———

const isMd = (path) => /\.(md|mdx|markdown)$/i.test(path);

async function loadFile(path) {
  if (state.files[path] !== undefined) return;
  state.files[path] = null;
  try {
    const res = await fetch(`/api/file?url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}&sha=${state.pr.headSha}`);
    const text = await res.text();
    if (!res.ok) throw new Error(res.status === 404 ? "this server can't read files yet, so restart it" : (() => { try { return JSON.parse(text).error; } catch { return text; } })());
    state.files[path] = { text };
  } catch (e) {
    state.files[path] = { error: e.message };
  }
  if (state.cur === path) render();
}

// The file split into blocks the way markdown reads it: paragraphs, headings, lists, tables and fenced code.
function mdBlocks(lines) {
  const out = [];
  let cur = null;
  let fence = false;
  const end = (i) => cur && (out.push({ ...cur, end: i }), (cur = null));
  lines.forEach((l, k) => {
    const i = k + 1;
    if (fence) {
      if (/^\s*```/.test(l)) (fence = false), end(i);
      return;
    }
    if (/^\s*```/.test(l)) return end(i - 1), (cur = { start: i }), (fence = true);
    if (!l.trim()) return end(i - 1);
    if (/^#{1,6}\s/.test(l)) return end(i - 1), (cur = { start: i }), end(i);
    if (!cur) cur = { start: i };
  });
  end(lines.length);
  return out;
}

// The new file rendered, with a bar on blocks that have added lines and removed text folded where it was.
function mdPreview(path, notes) {
  const got = state.files[path];
  if (!got) return loadFile(path), `<p class="nodiff">Loading the file…</p>`;
  if (got.error) return `<p class="nodiff">Couldn't load the file: ${esc(got.error)}. Here is the diff instead.</p>${diffHtml(path, notes)}`;
  const added = new Set();
  const removed = [];
  for (const h of state.diff?.[path]?.hunks ?? []) {
    for (let i = 0; i < h.lines.length; i++) {
      if (h.lines[i][0] === '+') added.add(h.lines[i][2]);
      if (h.lines[i][0] !== '-') continue;
      const run = [];
      while (i < h.lines.length && h.lines[i][0] === '-') run.push(h.lines[i++][3]);
      // A removal sits just before the next line that's still in the file.
      const next = h.lines.slice(i).find((l) => l[0] !== '-');
      const last = [...h.lines.slice(0, i)].reverse().find((l) => l[0] !== '-');
      removed.push({ at: next ? next[2] : (last?.[2] ?? 0) + 1, text: run.join('\n') });
      i--;
    }
  }
  const lines = got.text.replace(/\r/g, '').split('\n');
  const gone = (r) => `<details class="mdrm"><summary>${plural(r.text.split('\n').length, 'line')} removed</summary><pre>${esc(r.text)}</pre></details>`;
  let html = '';
  let k = 0;
  removed.sort((a, b) => a.at - b.at);
  for (const b of mdBlocks(lines)) {
    while (k < removed.length && removed[k].at <= b.start) html += gone(removed[k++]);
    let n = 0;
    for (let i = b.start; i <= b.end; i++) if (added.has(i)) n++;
    const cls = !n ? '' : n === b.end - b.start + 1 ? 'add' : 'chg';
    html += `<div class="mdb ${cls}">${markdown(lines.slice(b.start - 1, b.end).join('\n'))}</div>`;
  }
  while (k < removed.length) html += gone(removed[k++]);
  return `<p class="mdkey">Rendered at the PR head. <i class="add"></i>added <i class="chg"></i>changed <i class="rm"></i>removed · <kbd>m</kbd> for the diff, where you can comment.</p><div class="md mdview">${html}</div>`;
}

function diffHtml(path, notes) {
  if (state.diffError) return `<p class="nodiff">Couldn't load the diff: ${esc(state.diffError)}. <a href="${esc(fileUrl(path))}" target="_blank" rel="noreferrer">Open it on GitHub</a>.</p>`;
  if (!state.diff) return `<p class="nodiff">Loading the diff…</p>`;
  const f = state.diff[path];
  if (!f) return `<p class="nodiff">No diff for this file here. <a href="${esc(fileUrl(path))}" target="_blank" rel="noreferrer">Open it on GitHub</a>.</p>`;
  if (f.binary || !f.hunks.length) return `<p class="nodiff">${f.binary ? 'Binary file.' : 'Nothing to show, likely a rename or mode change.'}</p>`;
  // Each note sits under the first line of its range, so it reads next to the code it's about.
  const at = new Map();
  for (const x of notes) {
    const line = Number(String(x.lines ?? '').split('-')[0]);
    if (line) at.set(line, [...(at.get(line) ?? []), x]);
  }
  const noteAt = (n) => {
    const here = n && at.get(n);
    if (!here) return '';
    at.delete(n);
    return here.map((x) => `<div class="inote"><span class="nt"><b>${NOTE_WORD[x.kind] ?? ''}</b> ${t(x.note)}</span>${noteBtn(path, n, x)}</div>`).join('');
  };
  const lang = langOf(path);
  let shown = 0;
  const parts = f.hunks.map((h, i) => {
    if (shown >= MAX_LINES) return '';
    if ((!h.html && window.hljs) || h.lang !== lang) (h.html = highlightHunk(h, lang)), (h.lang = lang);
    const lines = h.lines.slice(0, MAX_LINES - shown).map((l, k) => [...l.slice(0, 4), h.html?.[k] ?? esc(l[3])]);
    shown += lines.length;
    const rows = state.split ? splitRows(lines, noteAt, path) : lines
      .map(([s, o, n, code, html]) => {
        const cls = s === '+' ? 'a' : s === '-' ? 'd' : '';
        const [side, ln] = s === '-' ? ['LEFT', o] : ['RIGHT', n];
        return `<div class="dl ${cls}">${cmtBtn(path, side, ln, code)}<span class="o">${o}</span><span class="nn">${n}</span><span class="s">${s === ' ' ? '' : s === '-' ? '−' : '+'}</span><span class="c">${html}</span></div>${s !== '-' ? noteAt(n) : ''}${commentsAt(path, side, ln)}`;
      })
      .join('');
    return `<div class="diff ${state.split ? 'split' : ''}"><div class="hh"><span>${esc(h.head)} ${esc(h.ctx)}</span><span>${i + 1} of ${plural(f.hunks.length, 'hunk')}</span></div>${rows}</div>`;
  });
  const total = f.hunks.reduce((a, h) => a + h.lines.length, 0);
  const more = total > MAX_LINES ? `<p class="nodiff">Showing the first ${num(MAX_LINES)} of ${num(total)} lines. <a href="${esc(fileUrl(path))}" target="_blank" rel="noreferrer">The rest is on GitHub</a>.</p>` : '';
  return parts.join('') + more;
}

function fileView(m, path) {
  const f = m.files.find((x) => x.file === path) ?? m.lists?.routine.find((x) => x.file === path) ?? { file: path, color: null, note: '', add: 0, del: 0 };
  const sizes = state.pr.files.find((x) => x.path === path);
  const add = sizes?.additions ?? f.add;
  const del = sizes?.deletions ?? f.del;
  const notes = m.notes.filter((n) => n.file === path);
  const done = state.reviewed.has(path);
  const level = f.routine ? 'routine' : LEVEL[f.color] ?? '';
  const levelCls = f.routine ? '' : f.color === 'red' ? 'c-red' : f.color ? 'c-yellow' : '';
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  // The link under the name is plain so it can be dragged or opened in a split pane.
  let html = `<div class="fview"><div class="fhead"><span class="names"><span class="dir">${esc(dir)}</span><span class="line"><span class="base">${esc(base(path))}</span><span class="n"><span class="add">+${add}</span> <span class="del">−${del}</span></span><span class="lvl ${levelCls}">${esc(level)}</span></span><a class="rawlink" href="${esc(fileUrl(path))}" target="_blank" rel="noreferrer" title="This file in the PR on GitHub">${esc(fileUrl(path).replace(/^https:\/\//, ''))}</a></span>`;
  html += `<span class="acts">${isMd(path) ? `<button class="btn ${state.mdRendered ? 'on' : ''}" type="button" id="f-md" title="Rendered markdown or the diff (m)">${state.mdRendered ? 'Diff' : 'Rendered'} <kbd>m</kbd></button>` : ''}<button class="btn" type="button" id="f-split" title="Side by side or one column (s)">${state.split ? 'Unified' : 'Split'} <kbd>s</kbd></button><button class="btn ${$('#chat').hidden ? '' : 'on'}" type="button" id="f-ask">Ask Claude <kbd>c</kbd></button><button class="btn" type="button" id="f-gh">GitHub <kbd>o</kbd></button><button class="btn ${done ? '' : 'primary'}" type="button" id="f-mark">${done ? 'Reviewed ✓' : 'Mark reviewed'}<kbd>space</kbd></button></span></div>`;
  const noteLines = notes.map((n) => {
    const line = n.lines ? `<span class="at">line ${esc(String(n.lines))}</span>` : '';
    const scenario = n.scenario ? ` <span class="why">${t(n.scenario)}</span>` : '';
    const art = n.art ? ` <a class="ref-l" href="${safe(n.art.url)}" target="_blank" rel="noreferrer">prior art</a>` : '';
    return `<p><b>${NOTE_WORD[n.kind] ?? ''}</b> ${t(n.note)}${scenario} ${line}${art}</p>`;
  });
  // Threads whose lines moved away can't sit in the diff, so they're listed here.
  const stale = (state.gh?.lines ?? []).filter((c) => !c.replyTo && c.path === path && c.line === null);
  if (stale.length) noteLines.push(`<p><b>Outdated ${stale.length === 1 ? 'thread' : 'threads'}.</b> ${stale.map((c) => `<a class="ref-l" href="${safe(c.url)}" target="_blank" rel="noreferrer">@${esc(c.user)}: ${esc(c.body.replace(/\s+/g, ' ').slice(0, 70))}${c.body.length > 70 ? '…' : ''}</a>`).join(' · ')}</p>`);
  // The File summaries step explains the change; the guide's one-liner is the fallback until it has run.
  const sum = doneOutput(m.steps, 'files')?.files?.find((x) => x.file === path)?.summary;
  const lead = sum ? `<p class="fsum">${t(sum)}</p>` : pendingBody(m.steps.files) || (f.note ? `<p>${t(f.note)}</p>` : '');
  if (lead || noteLines.length) html += `<div class="fnotes">${lead}${noteLines.join('')}</div>`;
  html += isMd(path) && state.mdRendered && state.diff?.[path]?.hunks.some((h) => h.lines.some((l) => l[0] !== '-')) ? mdPreview(path, notes) : diffHtml(path, notes);
  const nx = nextOpen(m.order, path);
  html += `<div class="fnext"><span>${nx === 'done' ? 'Last file on the list' : `Next up: ${nx === 'brief' ? 'the brief' : esc(shortName(nx))}`}</span><span class="r"><span><kbd>k</kbd>previous</span><span><kbd>j</kbd>next</span></span></div>`;
  return html + `</div>`;
}

function doneView(m) {
  const n = m.groups.filter((g) => g.key !== 'routine').flatMap((g) => g.files).length;
  const spots = m.notes.filter(isCheck).length;
  const g = gate();
  const ci = row()?.ci === 'failure';
  const note = [`You went through every file on the list.`, spots ? `The run flagged ${plural(spots, 'spot')} to check.` : '', ci ? 'CI is still failing.' : '', g.sendBack ? 'The author has not run a bug pass, so sending it back is the usual next step.' : ''].filter(Boolean).join(' ');
  const btn = (id, label, key) => `<button class="btn" type="button" id="${id}">${label}<kbd>${key}</kbd></button>`;
  return `<div class="alldone"><h1>All ${plural(n, 'file')} reviewed</h1><p>${note}</p><span class="acts">${btn('d-submit', state.comments.length ? `Submit review (${plural(state.comments.length, 'comment')})` : 'Submit review', '⇧S')}${btn('d-gh', 'Open on GitHub', 'o')}${state.pr.mine ? '' : btn('d-done', 'Mark done', 'e')}${btn('d-ask', 'Ask Claude', 'c')}${btn('d-brief', 'Back to the brief', 'b')}</span></div>`;
}

// ——— Drawing ———

function render() {
  const { pr, error } = state;
  if (error) return ($('#page').innerHTML = `<div class="empty"><b>Couldn't load this PR</b><pre>${esc(error)}</pre></div>`);
  if (!pr) return;
  document.title = `${name}#${number} ${pr.title}`;
  $('#htitle').textContent = pr.title;
  const list = order();
  const i = list.indexOf(url);
  $('#pos').textContent = i === -1 ? '' : `PR ${i + 1} of ${list.length}`;
  const m = model();
  if (!['brief', 'done', 'submit'].includes(state.cur) && !pr.files.some((f) => f.path === state.cur)) state.cur = 'brief';
  drawRun();
  const side = $('#side');
  const sideTop = side.scrollTop;
  side.innerHTML = sidebar(m);
  side.scrollTop = sideTop;
  const page = $('#page');
  const view = state.cur === 'brief' ? brief(m) : state.cur === 'done' ? doneView(m) : state.cur === 'submit' ? submitView() : fileView(m, state.cur);
  // A redraw while you type keeps the box you were typing in focused, with the cursor where it was.
  const active = document.activeElement?.id;
  const sel = active && ['draft', 'summary'].includes(active) ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  // Redraws while a run is going keep your place; a new view starts at the top.
  const top = page.dataset.view === state.cur ? page.scrollTop : 0;
  page.innerHTML = view;
  page.dataset.view = state.cur;
  page.scrollTop = top;
  const box = sel ? $(`#${active}`) : state.draft && !$('#draft')?.dataset.seen ? $('#draft') : null;
  if (box) {
    box.dataset.seen = '1';
    box.focus({ preventScroll: !!sel });
    const at = sel ?? [box.value.length, box.value.length];
    box.setSelectionRange(at[0], at[1]);
  }
  const target = state.jump && $(`[data-cid="${state.jump}"]`);
  if (target) {
    state.jump = null;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('flash');
  }
  const body = $('#desc-body');
  if (body) $('#desc-more').hidden = !state.descOpen && body.scrollHeight <= body.clientHeight + 4;
  if (side.dataset.cur !== state.cur && state.cur !== 'brief') side.querySelector('.it.cur')?.scrollIntoView({ block: 'nearest' });
  side.dataset.cur = state.cur;
}

function open(id) {
  state.cur = id;
  if (id !== 'brief' && id !== 'done' && id !== 'submit') loadDiff();
  render();
}

function saveReviewed() {
  localStorage.setItem(REVIEWED_KEY, JSON.stringify([...state.reviewed]));
}

function tick(id) {
  const on = !state.reviewed.has(id);
  on ? state.reviewed.add(id) : state.reviewed.delete(id);
  saveReviewed();
  status(on ? `${id === 'brief' ? 'Brief' : shortName(id)} reviewed` : `${id === 'brief' ? 'Brief' : shortName(id)} back on the list`);
  return on;
}

// Space: tick what you're on and move to the next thing you haven't read.
function markCurrent() {
  const id = state.cur;
  if (id === 'done') return;
  if (id === 'brief' && state.reviewed.has('brief')) return open(nextOpen(model().order, 'brief'));
  if (tick(id)) open(nextOpen(model().order, id));
  else render();
}

function step(d) {
  const o = [...model().order, 'done'];
  const i = o.indexOf(state.cur);
  open(o[Math.max(0, Math.min(o.length - 1, (i < 0 ? 0 : i) + d))]);
}

let diffLoading = false;
async function loadDiff() {
  if (state.diff || diffLoading) return;
  diffLoading = true;
  try {
    const res = await fetch(`/api/diff?url=${encodeURIComponent(url)}`);
    const text = await res.text();
    // A 404 here means the server is older than this page and needs a restart.
    if (res.status === 404) throw new Error('the server has no diff endpoint yet, so restart it with bun start');
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {}
      throw new Error(msg);
    }
    state.diff = parseDiff(text);
  } catch (e) {
    state.diffError = e.message;
  }
  diffLoading = false;
  render();
}

async function loadReviews() {
  const res = await fetch(`/api/reviews?url=${encodeURIComponent(url)}`).then((r) => r.json()).catch(() => null);
  if (!res?.reviews) return;
  // When a run you were waiting on finishes, it swaps in and the footer says so.
  const was = liveRun();
  const now = was && res.reviews.find((x) => x.id === was.id);
  if (now && now.status !== 'running') {
    if (state.shown && state.shown !== now.id) state.shown = null;
    status(now.error === STOPPED ? `Run ${now.id} stopped${shownRunAfter(res.reviews) ? ` · still showing run ${shownRunAfter(res.reviews).id}` : ''}` : `Run ${now.id} ${now.status === 'failed' ? 'finished with a failed step' : 'finished'} · showing it now`);
  }
  state.reviews = res.reviews;
  state.typical = res.typical ?? state.typical;
  state.optional = res.optional;
  state.checks = (res.checks ?? state.checks)?.filter((c) => !(state.pr?.mine && c.skipOnMine));
  state.override = res.override;
}

async function load() {
  // The queue only adds context, so a failed fetch leaves it out rather than breaking the page.
  const queue = fetch('/api/queue?cached=1').then((r) => r.json()).then((q) => (state.queue = q.prs ? q : null)).catch(() => null);
  const mine = fetch('/api/mine?cached=1').then((r) => r.json()).then((q) => (state.mineList = q.prs ? q : null)).catch(() => null);
  const [res] = await Promise.all([fetch(`/api/pr?url=${encodeURIComponent(url)}`).then((r) => r.json()), loadReviews(), queue, mine]);
  if (res.error) state.error = res.error;
  else (state.pr = res), (state.diffIds = await diffIds(res.files));
  if (state.pr?.mine && state.checks) state.checks = state.checks.filter((c) => !c.skipOnMine);
  if (state.pr?.mine) ($('#back').href = '/mine'), ($('#back').textContent = '← My PRs'), ($('#back').title = 'Back to My PRs (esc)');
  render();
  // Everyone's comments only add to the page, so a failure just leaves them out.
  fetch(`/api/comments?url=${encodeURIComponent(url)}`).then((r) => (r.ok ? r.json() : null)).then((g) => g?.lines && ((state.gh = g), render())).catch(() => {});
  // The diff is usually wanted a few seconds later, so fetch it now.
  if (state.pr) loadDiff();
}

// Stops the whole run, or one step, and kills its Claude processes. The worktree is cleaned up as usual.
async function stopRun(key) {
  const live = liveRun();
  if (!live) return;
  if (!key && !confirm(`Stop run ${live.id}? Every step still going stops, and the run before it stays on screen.`)) return;
  const res = await post('/api/review/stop', { url, key });
  if (!res.stopped) return status(res.error ? `Couldn't stop: ${res.error}` : 'This run started before the server could stop runs. Restart the server once it finishes.');
  status(key ? `Stopped ${live.steps.find((s) => s.key === key)?.label ?? key}` : `Stopping run ${live.id}…`);
  await loadReviews();
  render();
}

// With `only`, just those steps run and the rest is kept from the run on screen.
async function runReview(only = []) {
  if (state.starting || liveRun()) return;
  state.starting = true;
  render();
  const res = await post('/api/review', { url, extras: [...state.extras], only, from: shownRun()?.id });
  state.starting = false;
  if (res.error) status(`Couldn't start: ${res.error}`);
  else {
    const what = only.length ? `Rerunning ${only.map((k) => state.checks?.find((c) => c.key === k)?.label ?? k).join(', ')}` : 'Run started';
    if (only.length) state.extras.clear();
    status(shownRun() ? `${what} · keep reading, the results swap in when it's done` : what);
  }
  await loadReviews();
  render();
}

// Only redraw while something is running, so reading and scrolling aren't disturbed.
setInterval(async () => {
  if (!state.reviews.some((r) => r.status === 'running')) return;
  await loadReviews();
  render();
}, 3000);

// The clocks tick every second without redrawing the page, so nothing you're reading moves.
setInterval(() => {
  const live = liveRun();
  if (!live) return;
  const shown = shownRun();
  // Only the clocks and bars change, so a box you're ticking isn't redrawn under your click.
  $('#runbtn').innerHTML = runButtonHtml();
  const left = $('#rd-left');
  if (left) left.textContent = runLeftLabel(live);
  for (const s of live.steps) {
    const row = document.querySelector(`#rd-live .rstep[data-key="${CSS.escape(s.key)}"]`);
    if (!row) continue;
    if (!row.classList.contains(s.status)) {
      $('#rd-live').innerHTML = drawerRun();
      break;
    }
    row.querySelector('.rt').textContent = stepTime(s);
    row.querySelector('.rb i').style.width = `${Math.round(stepLeft(s).frac * 100)}%`;
  }
  document.querySelectorAll('.pending[data-step]').forEach((el) => {
    const st = shown?.steps.find((x) => x.key === el.dataset.step);
    const html = st && pendingBody(st);
    if (html) el.outerHTML = html;
  });
}, 1000);

// What just happened goes in the footer's status line.
function status(msg) {
  $('#status').textContent = msg;
}
const toast = status;

// The queue saves the order it drew when you opened this page, so [ and ] walk the same list.
const order = () => JSON.parse(sessionStorage.getItem('order') ?? '[]');

function go(delta) {
  const list = order();
  const i = list.indexOf(url);
  const next = i === -1 ? null : list[i + delta];
  if (!next) return toast(i === -1 ? "This PR isn't in the queue you opened it from" : delta > 0 ? 'This is the last PR in the queue' : 'This is the first PR in the queue');
  sessionStorage.setItem('selected', next);
  location.href = pagePath(next);
}

// After done or set aside, drop this PR from the saved order and open the next one.
function leave(kind, msg) {
  const list = order();
  const i = list.indexOf(url);
  sessionStorage.setItem('undo', JSON.stringify({ kind, url, at: i }));
  sessionStorage.setItem('order', JSON.stringify(list.filter((u) => u !== url)));
  sessionStorage.setItem('toast', msg);
  const next = i === -1 ? null : list[i + 1];
  if (next) return sessionStorage.setItem('selected', next), (location.href = pagePath(next));
  location.href = home();
}

async function markDone() {
  if (state.pr?.mine) return toast('Your own PRs leave My PRs when they merge or close. x sets one aside until it changes.');
  const d = doneEntry();
  if (d && d.reason !== 'marked') return toast(`You ${d.reason} #${number} on GitHub, so it stays in Done`);
  if (d) {
    await post('/api/done', { url, done: false });
    state.queue.done = state.queue.done.filter((x) => x !== d);
    render();
    return toast(`#${number} is back in the queue`);
  }
  await post('/api/done', { url, done: true });
  leave('done', `#${number} is done · u to undo`);
}

async function setAside() {
  const p = row();
  if (!p) return toast('Only PRs in the queue can be set aside');
  if (state.pr?.mine) {
    await post('/api/mine/aside', { url, updatedAt: p.updatedAt });
    return leave('mine-aside', `Set aside #${number} until it changes · u to undo`);
  }
  await post('/api/skip', { url, updatedAt: p.updatedAt });
  leave('skip', `Set aside #${number} until it changes · u to undo`);
}

async function undo() {
  const last = JSON.parse(sessionStorage.getItem('undo') ?? 'null');
  if (!last) return toast('Nothing to undo');
  sessionStorage.removeItem('undo');
  const path = { done: '/api/done', 'mine-aside': '/api/mine/aside' }[last.kind] ?? '/api/skip';
  await post(path, last.kind === 'done' ? { url: last.url, done: false } : { url: last.url, updatedAt: null });
  const list = order();
  if (last.at >= 0 && !list.includes(last.url)) list.splice(last.at, 0, last.url), sessionStorage.setItem('order', JSON.stringify(list));
  sessionStorage.setItem('selected', last.url);
  location.href = pagePath(last.url);
}

// Pressing the color you already set clears it, so the run's color shows again.
async function setColor(color) {
  const next = state.override === color ? null : color;
  await post('/api/override', { url, color: next });
  state.override = next;
  render();
  toast(next ? `Marked #${number} ${next}` : `Back to the run's color for #${number}`);
}

// o opens the file you're on, or the PR from anywhere else.
const openGitHub = () => post('/api/open', { url: state.cur === 'brief' || state.cur === 'done' ? url : fileUrl(state.cur) });
const askHere = () => (state.cur !== 'brief' && state.cur !== 'done' && !window.getSelection()?.toString().trim() ? chat.open(`About ${state.cur}: `) : chat.open());

function toggleMd() {
  state.mdRendered = !state.mdRendered;
  localStorage.setItem('mdRendered', state.mdRendered ? '1' : '');
  status(state.mdRendered ? 'Markdown rendered' : 'Markdown as a diff');
  render();
}

function toggleSplit() {
  state.split = !state.split;
  localStorage.setItem('diffSplit', state.split ? '1' : '');
  status(state.split ? 'Diff side by side' : 'Diff in one column');
  render();
}

function setTheme(next) {
  document.documentElement.dataset.theme = next;
  localStorage.setItem('prTheme', next);
  drawTheme();
}
const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
const drawTheme = () => ($('#theme').textContent = isDark() ? 'Dark' : 'Light');
const toggleTheme = () => setTheme(isDark() ? 'light' : 'dark');

const KEYS = [
  [['j', '↓'], 'Next file'],
  [['k', '↑'], 'Previous file'],
  [['space', '⏎'], 'Mark reviewed and open the next unread file'],
  [['n'], 'Next unread file'],
  [['b'], 'Back to the brief'],
  [[']'], 'Next PR in the queue'],
  [['['], 'Previous PR in the queue'],
  [['e'], 'Mark done and open the next PR'],
  [['x'], 'Set aside until it changes and open the next PR'],
  [['u'], 'Undo the last done or set aside'],
  [['1–9'], 'Jump to a section of the brief'],
  [['o'], 'Open the PR, or the file you are on, on GitHub'],
  [['⇧R'], 'Run review, or run everything again'],
  [['⇧D'], 'Show or hide the review run: steps, Run selected, Cancel and past runs'],
  [['g', 'y', 'r'], 'Set the color to green, yellow or red (again to clear)'],
  [['c'], 'Ask Claude about this PR or file, quoting any text you selected'],
  [['⇧C'], 'Show or hide the chat'],
  [['s'], 'Show the diff side by side or in one column'],
  [['m'], 'Show a markdown file rendered, or as a diff'],
  [['⇧S'], 'Submit your review: line comments, a summary, and comment, approve or request changes'],
  [['t'], 'Switch between dark and light'],
  [['esc'], 'Back to the queue'],
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
  const kbds = (ks) => ks.map((k) => `<kbd>${esc(k)}</kbd>`).join('<span class="or">or</span>');
  el.innerHTML = `<div class="panel"><h2>Keyboard shortcuts</h2><dl>${KEYS.map(([k, what]) => `<dt>${kbds(k)}</dt><dd>${esc(what)}</dd>`).join('')}</dl></div>`;
}

function jumpTo(el) {
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('keydown', (e) => {
  const cmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
  if (e.target.id === 'draft') {
    if (cmdEnter) return e.preventDefault(), saveDraft();
    if (e.key === 'Escape') return e.preventDefault(), (state.draft = null), render();
    return;
  }
  if (state.cur === 'submit' && cmdEnter) return e.preventDefault(), submitReview();
  if (e.shiftKey && e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey && !e.target.closest('input, textarea, select')) return e.preventDefault(), toggleDrawer();
  if (e.shiftKey && e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey && !e.target.closest('input, textarea, select')) return e.preventDefault(), openSubmit();
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select')) return;
  if (state.help) {
    if (e.key === 'Escape' || e.key === '?') (state.help = false), renderHelp();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    if (state.cur !== 'brief') open('brief');
    const secs = [...document.querySelectorAll('.bsec')];
    return jumpTo(secs[e.key - 1]);
  }
  // Buttons keep their own Enter and space; everywhere else they move through the review.
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a')) return;
  const fn = {
    Escape: () => (location.href = home()),
    o: openGitHub,
    R: () => runReview(),
    S: openSubmit,
    s: () => state.cur !== 'brief' && state.cur !== 'done' && toggleSplit(),
    m: () => isMd(state.cur) && toggleMd(),
    c: askHere,
    C: () => chat.toggle(),
    j: () => step(1),
    ArrowDown: () => step(1),
    k: () => step(-1),
    ArrowUp: () => step(-1),
    ' ': markCurrent,
    Enter: markCurrent,
    n: () => open(nextOpen(model().order, state.cur)),
    b: () => open('brief'),
    ']': () => go(1),
    '[': () => go(-1),
    e: () => markDone(),
    g: () => setColor('green'),
    y: () => setColor('yellow'),
    r: () => setColor('red'),
    x: () => setAside(),
    u: () => undo(),
    t: toggleTheme,
    '?': () => ((state.help = true), renderHelp()),
  }[e.key];
  if (fn) (e.preventDefault(), fn());
});
const pending = sessionStorage.getItem('toast');
status(pending ?? 'Read the brief first, then work down the list');
if (pending) sessionStorage.removeItem('toast');
$('#github').addEventListener('click', (e) => (e.preventDefault(), post('/api/open', { url })));
$('#theme').addEventListener('click', toggleTheme);
drawTheme();

$('#side').addEventListener('click', (e) => {
  if (e.target.id === 'show-routine') return (state.showRoutine = true), render();
  if (e.target.closest('#open-submit')) return openSubmit();
  const jump = e.target.closest('[data-jump]');
  if (jump) return jumpToComment(Number(jump.dataset.jump));
  const box = e.target.closest('[data-tick]');
  if (box) return tick(box.dataset.tick), render();
  const it = e.target.closest('[data-go]');
  if (it) open(it.dataset.go);
});

$('#page').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  if (id === 'run') return runReview();
  const again = e.target.closest('.rerun-sec');
  if (again) return e.preventDefault(), runReview(again.dataset.only.split(','));
  if (id === 'desc-more') return (state.descOpen = !state.descOpen), render();
  if (id === 'brief-done' || id === 'f-mark') return markCurrent();
  if (id === 'f-ask' || id === 'd-ask') return $('#chat').hidden ? askHere() : chat.toggle();
  if (id === 'f-gh' || id === 'd-gh') return openGitHub();
  if (id === 'f-split') return toggleSplit();
  if (id === 'f-md') return toggleMd();
  if (id === 'd-submit') return openSubmit();
  if (id === 'draft-save') return saveDraft();
  if (id === 'draft-cancel') return (state.draft = null), render();
  if (id === 'draft-ask') {
    const d = state.draft;
    state.draft = null;
    render();
    return chat.open(`About ${d.path} line ${d.line} (\`${d.code.trim()}\`): `);
  }
  if (id === 'submit-review') return submitReview();
  if (id === 'bh-post') return postFindings(e.target.closest('button').dataset.bhk);
  const bhAll = id === 'bh-all' && state.bh[e.target.closest('button').dataset.bhk];
  if (bhAll?.run) {
    const all = bhAll.run.findings.map((f) => f.id);
    bhAll.picked = bhAll.picked.size === all.length ? new Set() : new Set(all);
    return render();
  }
  if (id === 'sub-back') return open(state.back === 'submit' ? 'brief' : state.back);
  const nadd = e.target.closest('[data-note-text]');
  if (nadd) return draftFromNote(nadd);
  const nj = e.target.closest('.nadd[data-jump]');
  if (nj) return jumpToComment(Number(nj.dataset.jump));
  const cmt = e.target.closest('.cmt');
  if (cmt) return openDraft(cmt.dataset.path, cmt.dataset.side, Number(cmt.dataset.line), cmt.dataset.code);
  const del = e.target.closest('[data-del]');
  if (del) return removeComment(Number(del.dataset.del));
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const c = state.comments.find((x) => x.id === Number(edit.dataset.edit));
    return c && openDraft(c.path, c.side, c.line, c.code, c.text, c.id);
  }
  const verdict = e.target.closest('[data-verdict]');
  if (verdict) return (state.verdict = verdict.dataset.verdict), (state.submitError = null), render();
  if (id === 'd-done') return markDone();
  if (id === 'd-brief') return open('brief');
  const color = e.target.closest('[data-color]');
  if (color) return setColor(color.dataset.color);
  const opener = e.target.closest('[data-open]');
  if (opener) return e.preventDefault(), open(opener.dataset.open);
  const ask = e.target.closest('.ask-md');
  if (ask) return e.preventDefault(), chat.open(`About the ${ask.closest('.bsec').querySelector('h2').textContent} section: `);
  const copy = e.target.closest('.copy-md');
  if (copy) return e.preventDefault(), copySection(copy);
  // Stat links jump without leaving a #fragment that would fight the scroll restore on redraw.
  const a = e.target.closest('a[href^="#c-"]');
  if (a) (e.preventDefault(), jumpTo(document.getElementById(a.getAttribute('href').slice(1))));
  const seg = e.target.closest('.seg[data-file]');
  if (seg) open(seg.dataset.file);
});

// Copies to the clipboard only. Posting stays on GitHub, where you paste it.
async function copySection(btn) {
  const sec = btn.closest('.bsec');
  const title = sec.querySelector('h2').textContent;
  const text = `### ${title}\n\n${toMarkdown(sec.querySelector('.sec-body'))}\n`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Some browsers deny the async clipboard; the old copy command still works from a click.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast("Couldn't copy to the clipboard");
  }
  btn.textContent = 'Copied';
  btn.classList.add('done');
  setTimeout(() => ((btn.textContent = 'Copy'), btn.classList.remove('done')), 1500);
}

// Hovering a segment of the map names its file in the caption.
$('#page').addEventListener('mouseover', (e) => {
  const seg = e.target.closest('.seg');
  const cap = document.querySelector('.map .cap');
  if (!cap) return;
  document.querySelectorAll('.seg.hot').forEach((el) => el.classList.remove('hot'));
  seg?.classList.add('hot');
  cap.textContent = seg?.dataset.cap ?? cap.dataset.default;
  document.querySelector('.map .mapbar')?.classList.toggle('hovering', !!seg);
});

$('#page').addEventListener('input', (e) => {
  if (e.target.id === 'draft' && state.draft) state.draft.text = e.target.value;
  if (e.target.id === 'summary') state.summary = e.target.value;
});

// The run drawer and its button in the bottom bar.
$('#runbtn').addEventListener('click', () => toggleDrawer());
$('#rundrawer').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  if (id === 'rd-close') return toggleDrawer(false);
  if (id === 'run') return runReview();
  if (id === 'run-sel') return runReview([...state.extras]);
  if (id === 'stop-run') return stopRun();
  const sx = e.target.closest('[data-stop]');
  if (sx) return stopRun(sx.dataset.stop);
  const color = e.target.closest('[data-color]');
  if (color) return setColor(color.dataset.color);
});
$('#rundrawer').addEventListener('change', (e) => {
  if (e.target.dataset.extra) (e.target.checked ? state.extras.add(e.target.dataset.extra) : state.extras.delete(e.target.dataset.extra)), drawRun();
  if (e.target.id === 'pick') (state.shown = Number(e.target.value)), render();
});

$('#page').addEventListener('change', (e) => {
  const bh = e.target.dataset.bh && state.bh[e.target.dataset.bh];
  if (bh) {
    const id = Number(e.target.dataset.id);
    e.target.checked ? bh.picked.add(id) : bh.picked.delete(id);
    return render();
  }
  if (e.target.dataset.extra) (e.target.checked ? state.extras.add(e.target.dataset.extra) : state.extras.delete(e.target.dataset.extra)), render();
  if (e.target.id === 'pick') (state.shown = Number(e.target.value)), render();
});

// highlight.js loads from a CDN; if it lands after the first draw, draw again with colors.
if (!window.hljs) window.addEventListener('load', () => window.hljs && state.cur !== 'brief' && state.cur !== 'done' && render());

// Drag the edge of the file list or the chat to resize it. Widths are remembered; double-click a handle to reset.
function grip(handle, panel, key, min, max, fromRight) {
  const apply = (w) => (panel.style.width = w ? `${Math.max(min, Math.min(max, w))}px` : '');
  apply(Number(localStorage.getItem(key)) || 0);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = e.clientX;
    const width = panel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (ev) => apply(width + (fromRight ? start - ev.clientX : ev.clientX - start));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      localStorage.setItem(key, String(Math.round(panel.getBoundingClientRect().width)));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  handle.addEventListener('dblclick', () => (localStorage.removeItem(key), apply(0)));
}
grip($('#grip-side'), $('#side'), 'sideWidth', 200, 640, false);
grip($('#grip-chat'), $('#chat'), 'chatWidth', 260, 900, true);
grip($('#grip-run'), $('#rundrawer'), 'runWidth', 260, 700, true);

const chat = initChat(url);
load();
