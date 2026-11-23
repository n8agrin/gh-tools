import type { Issue } from './github';

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
