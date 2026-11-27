import { MARK, type Issue } from './github';
import type { Run } from './runs';

/**
 * Which ready issues to start now: oldest first, skipping any this runner already has a run for,
 * until working plus blocked issues reach the cap. Blocked ones count, because each still holds a
 * branch and a question you owe an answer to.
 */
export function pick(ready: Issue[], inFlight: number, cap: number, running: Set<string>): Issue[] {
  const room = Math.max(0, cap - inFlight);
  return ready
    .filter((i) => !running.has(i.url))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, room);
}

/**
 * Blocked issues you've answered: the runner has a session for them and the newest comment is
 * yours, not the runner's. Only your login counts, since anyone who can comment on the issue
 * could otherwise steer the agent.
 */
export function answered(blocked: Issue[], runs: Map<string, Run>, me: string, running: Set<string>): { issue: Issue; answer: string }[] {
  return blocked.flatMap((issue) => {
    const c = issue.lastComment;
    const run = runs.get(issue.url);
    if (!c || !run || running.has(issue.url) || c.author !== me || c.body.includes(MARK)) return [];
    if (run.state !== 'blocked' && run.state !== 'failed') return [];
    return [{ issue, answer: c.body }];
  });
}

/** Done runs whose worktree is still on disk, to check whether their PR has landed. */
export function sweepable(runs: Run[], exists: (path: string) => boolean): Run[] {
  return runs.filter((r) => r.state === 'done' && r.pr && exists(r.worktree));
}

/** Working issues the runner isn't running and whose process is gone, like after a restart or a sleep. */
export function orphaned(working: Issue[], runs: Map<string, Run>, running: Set<string>, alive: (pid: number) => boolean): Issue[] {
  return working.filter((i) => {
    const run = runs.get(i.url);
    return run && run.state === 'working' && !running.has(i.url) && !(run.pid && alive(run.pid));
  });
}
