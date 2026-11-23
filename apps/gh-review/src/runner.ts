// What gh-runner is doing right now, read from the status files it writes (one run.json per issue).
// Local files only; GitHub labels stay the record of where an issue is.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** An agent at work, as Today's footer shows it. */
export interface AgentRun {
  url: string;
  repo: string;
  number: number;
  title: string;
  /** The draft PR, once the agent's first commit is pushed. */
  pr: string | null;
  startedAt: string;
  /** When the run last changed state. */
  updatedAt: string;
}

/** The runs in `dir` still working. A file that doesn't parse is skipped, since the runner may be mid-write. */
export async function workingRuns(dir: string): Promise<AgentRun[]> {
  if (!existsSync(dir)) return [];
  const runs = await Promise.all(
    readdirSync(dir).map(async (d) => {
      try {
        const r = await Bun.file(join(dir, d, 'run.json')).json();
        return r?.state === 'working' && typeof r.url === 'string' ? { url: r.url, repo: r.repo, number: r.number, title: r.title ?? '', pr: r.pr ?? null, startedAt: r.startedAt, updatedAt: r.updatedAt } : null;
      } catch {
        return null;
      }
    }),
  );
  return runs.filter((r): r is AgentRun => !!r).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
