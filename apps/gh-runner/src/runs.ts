// One folder per issue under ~/.gh-runner/runs: run.json (the status gh-review reads), the
// transcript, the worker's result and its stderr. GitHub labels stay the source of truth for
// where an issue is; this is what GitHub can't hold.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './config';

export type RunState = 'working' | 'blocked' | 'done' | 'failed';

export interface Run {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: RunState;
  branch: string;
  worktree: string;
  /** Claude Code session id, so a run can be resumed. */
  sessionId: string;
  pid: number | null;
  /** The draft PR, once the first commit is pushed. */
  pr: string | null;
  startedAt: string;
  updatedAt: string;
  /** One line on where it is: the agent's question, why it stopped, or its summary. */
  note: string;
}

export const RUNS = join(HOME, 'runs');
export const runKey = (repo: string, number: number) => `${repo.replace('/', '__')}__${number}`;
export const runDir = (repo: string, number: number) => join(RUNS, runKey(repo, number));

export function saveRun(r: Run): Run {
  const dir = runDir(r.repo, r.number);
  mkdirSync(dir, { recursive: true });
  const next = { ...r, updatedAt: new Date().toISOString() };
  // Written whole and renamed, so a reader never sees half a file.
  writeFileSync(join(dir, 'run.json.tmp'), JSON.stringify(next, null, 2));
  renameSync(join(dir, 'run.json.tmp'), join(dir, 'run.json'));
  return next;
}

export async function loadRun(repo: string, number: number): Promise<Run | null> {
  const f = join(runDir(repo, number), 'run.json');
  return existsSync(f) ? Bun.file(f).json() : null;
}

export async function listRuns(): Promise<Run[]> {
  if (!existsSync(RUNS)) return [];
  const files = readdirSync(RUNS).map((d) => join(RUNS, d, 'run.json')).filter(existsSync);
  return Promise.all(files.map((f) => Bun.file(f).json()));
}
