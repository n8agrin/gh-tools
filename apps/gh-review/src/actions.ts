// Per-PR actions come from "actions" in your config so you can plug in any Claude skill or shell command
// without touching the app. {url}, {repo}, {number}, {title}, {author} are filled in per PR.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, listRuns, saveRun } from './db';
import type { ReviewPR } from './github';
import { loadConfig, ROOT } from './config';

export interface Action {
  key: string;
  label: string;
  command: string[];
}

export interface Run {
  action: string;
  label: string;
  prUrl: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  log: string;
  /** The last lines of output, so the page can show a result without opening the log. */
  tail?: string;
}

export async function loadActions(): Promise<Action[]> {
  return (await loadConfig()).actions ?? [];
}

export function fill(template: string, pr: Pick<ReviewPR, 'url' | 'repo' | 'number' | 'title' | 'author'>): string {
  return template.replace(/\{(url|repo|number|title|author)\}/g, (_, k) => String(pr[k as keyof typeof pr]));
}

export { listRuns };

export async function startAction(action: Action, pr: ReviewPR): Promise<Run> {
  const existing = listRuns().find((r) => r.prUrl === pr.url && r.action === action.key);
  if (existing?.status === 'running') return existing;
  const dir = join(HOME, 'runs');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${pr.repo.replace('/', '-')}-${pr.number}-${action.key}-${Date.now()}.log`);
  const run: Run = { action: action.key, label: action.label, prUrl: pr.url, status: 'running', startedAt: new Date().toISOString(), log };
  saveRun(run);

  const proc = Bun.spawn(action.command.map((part) => fill(part, pr)), { cwd: ROOT, stdout: Bun.file(log), stderr: Bun.file(`${log}.err`), stdin: 'ignore' });
  proc.exited.then(async (code) => {
    const out = (await Bun.file(log).text()) + (await Bun.file(`${log}.err`).text());
    run.status = code === 0 ? 'done' : 'failed';
    run.endedAt = new Date().toISOString();
    run.tail = out.trim().split('\n').slice(-6).join('\n');
    saveRun(run);
  });
  return run;
}
