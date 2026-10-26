// Local storage in one SQLite file. GitHub is still the source of truth: the PR table is a cache
// of the last fetch, so the page can open instantly and keep working when GitHub errors.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Run } from './actions';
import type { Imported, MyPR, MyQueue, Queue, ReviewedPR, ReviewPR } from './github';

export const HOME = process.env.GH_REVIEW_HOME ?? join(homedir(), '.gh-review');

let db: Database | null = null;

function open(): Database {
  if (db) return db;
  mkdirSync(HOME, { recursive: true });
  db = new Database(join(HOME, 'gh-review.db'), { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prs (url TEXT PRIMARY KEY, data TEXT NOT NULL, seen_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skipped (url TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      pr_url TEXT NOT NULL, action TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, log TEXT NOT NULL, tail TEXT,
      PRIMARY KEY (pr_url, action)
    );
    CREATE TABLE IF NOT EXISTS done (url TEXT PRIMARY KEY, data TEXT NOT NULL, reason TEXT NOT NULL, done_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS review_steps (
      review_id INTEGER NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
      output TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY (review_id, key)
    );
    CREATE TABLE IF NOT EXISTS imported (url TEXT PRIMARY KEY, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS overrides (pr_url TEXT PRIMARY KEY, color TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (pr_url TEXT PRIMARY KEY, session_id TEXT, dir TEXT NOT NULL, head_sha TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mine (url TEXT PRIMARY KEY, data TEXT NOT NULL, seen_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mine_aside (url TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pr_url TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, at TEXT NOT NULL
    );
  `);
  importStateJson(db);
  return db;
}

/**
 * A run still marked running when the server starts belonged to a server that has since stopped, so it never finished.
 * Only the server calls this at startup: scripts and tests open the same database while a real server is mid-run.
 */
export function markInterrupted() {
  const d = open();
  d.run(`UPDATE reviews SET status = 'failed', error = 'interrupted when the server stopped' WHERE status = 'running'`);
  d.run(`UPDATE review_steps SET status = 'failed', output = 'interrupted when the server stopped' WHERE status IN ('running', 'queued')`);
  d.run(`UPDATE runs SET status = 'failed', tail = 'interrupted when the server stopped' WHERE status = 'running'`);
  d.run(`UPDATE chat_messages SET status = 'failed', text = text || '\n\n(interrupted when the server stopped)' WHERE status = 'running'`);
}

// Set-aside PRs used to live in state.json. Bring them over once, then keep the old file as a backup.
function importStateJson(d: Database) {
  const file = join(HOME, 'state.json');
  if (!existsSync(file)) return;
  const { skipped = {} } = JSON.parse(readFileSync(file, 'utf8'));
  const insert = d.prepare('INSERT OR IGNORE INTO skipped (url, updated_at) VALUES (?, ?)');
  for (const [url, at] of Object.entries(skipped)) insert.run(url, at as string);
  renameSync(file, `${file}.imported`);
}

/** Replace the cached queue with a fresh fetch. PRs that left the queue leave the cache too. */
export function saveQueue(q: Queue) {
  const d = open();
  d.transaction(() => {
    d.run('DELETE FROM prs');
    const insert = d.prepare('INSERT INTO prs (url, data, seen_at) VALUES (?, ?, ?)');
    for (const pr of q.prs) insert.run(pr.url, JSON.stringify(pr), q.fetchedAt);
    d.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?), (?, ?)', ['viewer', q.viewer, 'fetchedAt', q.fetchedAt]);
  })();
}

export function cachedQueue(): Queue | null {
  const d = open();
  const meta = Object.fromEntries(d.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  if (!meta.fetchedAt) return null;
  const prs = d.query<{ data: string }, []>('SELECT data FROM prs').all().map((r) => JSON.parse(r.data) as ReviewPR);
  return { viewer: meta.viewer ?? '', fetchedAt: meta.fetchedAt, prs, reviewed: [] };
}

// Your own PRs live in their own tables, so nothing on the My PRs page can change the review queue.

/** Replace the cached list of your own PRs. Ones that merged or closed leave with it. */
export function saveMine(q: MyQueue) {
  const d = open();
  d.transaction(() => {
    d.run('DELETE FROM mine');
    const insert = d.prepare('INSERT INTO mine (url, data, seen_at) VALUES (?, ?, ?)');
    for (const pr of q.prs) insert.run(pr.url, JSON.stringify(pr), q.fetchedAt);
    d.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?), (?, ?)', ['viewer', q.viewer, 'mineFetchedAt', q.fetchedAt]);
  })();
}

export function cachedMine(): MyQueue | null {
  const d = open();
  const meta = Object.fromEntries(d.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  if (!meta.mineFetchedAt) return null;
  const prs = d.query<{ data: string }, []>('SELECT data FROM mine').all().map((r) => JSON.parse(r.data) as MyPR);
  return { viewer: meta.viewer ?? '', fetchedAt: meta.mineFetchedAt, prs };
}

/** Your GitHub login as of the last fetch of either list, or null before the first one. */
export function viewer(): string | null {
  return open().query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'viewer'").get()?.value || null;
}

/** A PR from either cached list. Review runs and actions use it, so they work the same on your own PRs. */
export function cachedPR(url: string): ReviewPR | null {
  const d = open();
  const row = d.query<{ data: string }, [string]>('SELECT data FROM prs WHERE url = ?').get(url) ?? d.query<{ data: string }, [string]>('SELECT data FROM mine WHERE url = ?').get(url);
  return row ? JSON.parse(row.data) : null;
}

export function getMineAside(): Record<string, string> {
  const rows = open().query<{ url: string; updated_at: string }, []>('SELECT url, updated_at FROM mine_aside').all();
  return Object.fromEntries(rows.map((r) => [r.url, r.updated_at]));
}

export function setMineAside(url: string, updatedAt: string | null) {
  if (updatedAt) open().run('INSERT OR REPLACE INTO mine_aside (url, updated_at) VALUES (?, ?)', [url, updatedAt]);
  else open().run('DELETE FROM mine_aside WHERE url = ?', [url]);
}

/** Pull a PR into the queue by hand. Importing again restarts its age. */
export function addImported(url: string, at = new Date().toISOString()) {
  open().run('INSERT OR REPLACE INTO imported (url, at) VALUES (?, ?)', [url, at]);
}

/** Imported PRs still worth fetching: the ones you haven't marked done since importing them. */
export function listImported(): Imported[] {
  return open()
    .query<Imported, []>('SELECT i.url, i.at FROM imported i LEFT JOIN done d ON d.url = i.url WHERE d.done_at IS NULL OR d.done_at < i.at')
    .all();
}

/** Add one PR to the cached queue without waiting for the next full fetch. */
export function cachePR(pr: ReviewPR) {
  open().run('INSERT OR REPLACE INTO prs (url, data, seen_at) VALUES (?, ?, ?)', [pr.url, JSON.stringify(pr), new Date().toISOString()]);
}

export function getSkipped(): Record<string, string> {
  const rows = open().query<{ url: string; updated_at: string }, []>('SELECT url, updated_at FROM skipped').all();
  return Object.fromEntries(rows.map((r) => [r.url, r.updated_at]));
}

export function setSkipped(url: string, updatedAt: string | null) {
  if (updatedAt) open().run('INSERT OR REPLACE INTO skipped (url, updated_at) VALUES (?, ?)', [url, updatedAt]);
  else open().run('DELETE FROM skipped WHERE url = ?', [url]);
}

export function saveRun(r: Run) {
  open().run(
    'INSERT OR REPLACE INTO runs (pr_url, action, label, status, started_at, ended_at, log, tail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [r.prUrl, r.action, r.label, r.status, r.startedAt, r.endedAt ?? null, r.log, r.tail ?? null],
  );
}

export function listRuns(): Run[] {
  type Row = { pr_url: string; action: string; label: string; status: Run['status']; started_at: string; ended_at: string | null; log: string; tail: string | null };
  return open()
    .query<Row, []>('SELECT * FROM runs')
    .all()
    .map((r) => ({ prUrl: r.pr_url, action: r.action, label: r.label, status: r.status, startedAt: r.started_at, endedAt: r.ended_at ?? undefined, log: r.log, tail: r.tail ?? undefined }));
}

export interface ReviewStep {
  key: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  /** JSON for structured checks, markdown or an error message otherwise. */
  output?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Review {
  id: number;
  prUrl: string;
  headSha: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  error?: string;
  steps: ReviewStep[];
}

export function createReview(prUrl: string, headSha: string, steps: ReviewStep[]): number {
  const d = open();
  return d.transaction(() => {
    const { id } = d.query<{ id: number }, [string, string, string]>(`INSERT INTO reviews (pr_url, head_sha, status, started_at) VALUES (?, ?, 'running', ?) RETURNING id`).get(prUrl, headSha, new Date().toISOString())!;
    for (const s of steps) saveStep(id, s);
    return id;
  })();
}

export function saveStep(reviewId: number, s: ReviewStep) {
  // An upsert rather than REPLACE keeps the rowid, which is the order the steps show in.
  open().run(
    `INSERT INTO review_steps (review_id, key, label, status, output, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_id, key) DO UPDATE SET status = excluded.status, output = excluded.output, started_at = excluded.started_at, ended_at = excluded.ended_at`,
    [
    reviewId, s.key, s.label, s.status, s.output ?? null, s.startedAt ?? null, s.endedAt ?? null,
    ],
  );
}

export function finishReview(id: number, status: Review['status'], error?: string) {
  open().run('UPDATE reviews SET status = ?, ended_at = ?, error = ? WHERE id = ?', [status, new Date().toISOString(), error ?? null, id]);
}

/** Every review of a PR, newest first, with its steps. */
export function listReviews(prUrl: string): Review[] {
  const d = open();
  type Row = { id: number; pr_url: string; head_sha: string; status: Review['status']; started_at: string; ended_at: string | null; error: string | null };
  type StepRow = { key: string; label: string; status: ReviewStep['status']; output: string | null; started_at: string | null; ended_at: string | null };
  return d
    .query<Row, [string]>('SELECT * FROM reviews WHERE pr_url = ? ORDER BY id DESC')
    .all(prUrl)
    .map((r) => ({
      id: r.id,
      prUrl: r.pr_url,
      headSha: r.head_sha,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      error: r.error ?? undefined,
      steps: d
        .query<StepRow, [number]>('SELECT * FROM review_steps WHERE review_id = ? ORDER BY rowid')
        .all(r.id)
        .map((s) => ({ key: s.key, label: s.label, status: s.status, output: s.output ?? undefined, startedAt: s.started_at ?? undefined, endedAt: s.ended_at ?? undefined })),
    }));
}

/** How long each review step usually takes in seconds: the median of its last 30 finished runs, so the page can estimate what's left. */
export function typicalStepSeconds(): Record<string, number> {
  type Row = { key: string; started_at: string; ended_at: string };
  const rows = open()
    .query<Row, []>(`SELECT key, started_at, ended_at FROM review_steps WHERE status = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL ORDER BY review_id DESC LIMIT 1000`)
    .all();
  const by: Record<string, number[]> = {};
  for (const r of rows) {
    const secs = (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
    if (secs >= 0 && (by[r.key] ??= []).length < 30) by[r.key].push(secs);
  }
  return Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]]));
}

/** Review runs going now, per PR: steps done, the step labels still running, and a rough time left from typical step times. */
export function liveReviews(): Record<string, { id: number; done: number; total: number; startedAt: string; running: string[]; left: number }> {
  const d = open();
  const typical = typicalStepSeconds();
  const out: Record<string, any> = {};
  type Row = { id: number; pr_url: string; started_at: string };
  type Step = { key: string; label: string; status: string; started_at: string | null };
  for (const r of d.query<Row, []>(`SELECT id, pr_url, started_at FROM reviews WHERE status = 'running' ORDER BY id`).all()) {
    const steps = d.query<Step, [number]>('SELECT key, label, status, started_at FROM review_steps WHERE review_id = ? ORDER BY rowid').all(r.id);
    // The checks run side by side, so what's left is roughly the slowest one still going.
    const left = Math.max(
      0,
      ...steps.map((s) => (s.status === 'queued' ? (typical[s.key] ?? 60) : s.status === 'running' ? Math.max(0, (typical[s.key] ?? 60) - (Date.now() - Date.parse(s.started_at ?? '')) / 1000) : 0)),
    );
    out[r.pr_url] = { id: r.id, done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: steps.length, startedAt: r.started_at, running: steps.filter((s) => s.status === 'running').map((s) => s.label), left: Math.round(left) };
  }
  return out;
}

export interface ReviewSummary {
  minutes: number | null;
  color: string | null;
  reason: string | null;
  /** The head the signal was decided on, so the queue can fade it once the PR moves on. */
  headSha: string | null;
  /** Your own color, which wins over the run's. */
  override: string | null;
  reviewId: number;
}

/** Minutes and signal from each PR's newest review that has them, plus your override, so the queue can show them per row. */
export function reviewSummaries(): Record<string, ReviewSummary> {
  type Row = { pr_url: string; review_id: number; head_sha: string; key: string; output: string };
  const rows = open()
    .query<Row, []>(
      `SELECT r.pr_url, s.review_id, r.head_sha, s.key, s.output FROM review_steps s JOIN reviews r ON r.id = s.review_id
       WHERE s.key IN ('guide', 'signal') AND s.status = 'done' ORDER BY s.review_id DESC`,
    )
    .all();
  const out: Record<string, ReviewSummary> = {};
  for (const r of rows) {
    let o: any;
    try {
      o = JSON.parse(r.output);
    } catch {
      continue;
    }
    const sum = (out[r.pr_url] ??= { minutes: null, color: null, reason: null, headSha: null, override: null, reviewId: r.review_id });
    // Rows come newest first, so only fill from the newest review that answered each one.
    if (r.key === 'guide' && sum.minutes === null && typeof o.minutes === 'number') sum.minutes = o.minutes;
    if (r.key === 'signal' && sum.color === null && typeof o.color === 'string') Object.assign(sum, { color: o.color, reason: o.reason, headSha: r.head_sha });
  }
  for (const [url, color] of Object.entries(getOverrides())) (out[url] ??= { minutes: null, color: null, reason: null, headSha: null, override: null, reviewId: 0 }).override = color;
  return out;
}

export function getOverrides(): Record<string, string> {
  const rows = open().query<{ pr_url: string; color: string }, []>('SELECT pr_url, color FROM overrides').all();
  return Object.fromEntries(rows.map((r) => [r.pr_url, r.color]));
}

/** Your color for a PR, or null to go back to the run's. */
export function setOverride(prUrl: string, color: string | null) {
  if (color) open().run('INSERT OR REPLACE INTO overrides (pr_url, color, at) VALUES (?, ?, ?)', [prUrl, color, new Date().toISOString()]);
  else open().run('DELETE FROM overrides WHERE pr_url = ?', [prUrl]);
}

export interface DoneEntry {
  pr: ReviewPR;
  /** approved, changes requested, or marked (by hand). */
  reason: string;
  doneAt: string;
}

const REASON = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested' } as const;

/** Record PRs you approved or asked changes on. A later review moves the entry; the PR info always refreshes. */
export function saveReviewed(list: ReviewedPR[]) {
  const d = open();
  const upsert = d.prepare(`
    INSERT INTO done (url, data, reason, done_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (url) DO UPDATE SET data = excluded.data,
      reason = CASE WHEN excluded.done_at > done.done_at THEN excluded.reason ELSE done.reason END,
      done_at = max(done.done_at, excluded.done_at)`);
  d.transaction(() => {
    for (const r of list) upsert.run(r.pr.url, JSON.stringify(r.pr), REASON[r.review], r.at);
  })();
}

export function markDone(pr: ReviewPR, at = new Date().toISOString()) {
  open().run('INSERT OR REPLACE INTO done (url, data, reason, done_at) VALUES (?, ?, ?, ?)', [pr.url, JSON.stringify(pr), 'marked', at]);
}

export function unmarkDone(url: string) {
  open().run('DELETE FROM done WHERE url = ?', [url]);
}

/** Newest first. */
export function listDone(): DoneEntry[] {
  return open()
    .query<{ data: string; reason: string; done_at: string }, []>('SELECT data, reason, done_at FROM done ORDER BY done_at DESC')
    .all()
    .map((r) => ({ pr: JSON.parse(r.data), reason: r.reason, doneAt: r.done_at }));
}

export interface Chat {
  prUrl: string;
  /** The claude session to --resume, once the first answer has one. */
  sessionId: string | null;
  /** The chat's worktree, kept between messages so the session can resume in the same place. */
  dir: string;
  headSha: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  status: 'running' | 'done' | 'failed';
  at: string;
}

export function getChat(prUrl: string): Chat | null {
  const r = open().query<{ session_id: string | null; dir: string; head_sha: string }, [string]>('SELECT * FROM chats WHERE pr_url = ?').get(prUrl);
  return r ? { prUrl, sessionId: r.session_id, dir: r.dir, headSha: r.head_sha } : null;
}

export function saveChat(c: Chat) {
  open().run('INSERT OR REPLACE INTO chats (pr_url, session_id, dir, head_sha) VALUES (?, ?, ?, ?)', [c.prUrl, c.sessionId, c.dir, c.headSha]);
}

export function addChatMessage(prUrl: string, role: ChatMessage['role'], text: string, status: ChatMessage['status']): number {
  const at = new Date().toISOString();
  return open().query<{ id: number }, [string, string, string, string, string]>('INSERT INTO chat_messages (pr_url, role, text, status, at) VALUES (?, ?, ?, ?, ?) RETURNING id').get(prUrl, role, text, status, at)!.id;
}

export function updateChatMessage(id: number, text: string, status: ChatMessage['status']) {
  open().run('UPDATE chat_messages SET text = ?, status = ? WHERE id = ?', [text, status, id]);
}

export function listChatMessages(prUrl: string): ChatMessage[] {
  return open().query<ChatMessage, [string]>('SELECT id, role, text, status, at FROM chat_messages WHERE pr_url = ? ORDER BY id').all(prUrl);
}

export function clearChat(prUrl: string) {
  const d = open();
  d.transaction(() => {
    d.run('DELETE FROM chat_messages WHERE pr_url = ?', [prUrl]);
    d.run('DELETE FROM chats WHERE pr_url = ?', [prUrl]);
  })();
}
