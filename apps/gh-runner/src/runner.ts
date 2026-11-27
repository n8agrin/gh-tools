// gh-runner: watches your agent-ready issues and hands each to Claude Code.
//   bun src/runner.ts             keep watching
//   bun src/runner.ts --once      look once, wait for what it started, and exit
//   --dry-run                     say what it would start, and change nothing
import { loadConfig } from './config';
import { existsSync } from 'node:fs';
import { fetchQueue, moveLabel, prState, viewer, type Issue } from './github';
import { answered, orphaned, pick, sweepable } from './pick';
import { kindOf } from './route';
import { listRuns } from './runs';
import { removeWorktree, work, type Begin } from './worker';

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const dryRun = args.has('--dry-run');

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
const running = new Map<string, Promise<unknown>>();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const RESTARTED = 'The runner stopped while you were working (a restart or the machine slept). Check `git status` and the last commits, then carry on where you left off.';

/** Once an hour, removes the worktrees of done runs whose PR has merged or closed, since each can hold gigabytes. */
let swept = 0;
async function sweep(s: Awaited<ReturnType<typeof loadConfig>>) {
  if (dryRun || Date.now() - swept < 3600_000) return;
  swept = Date.now();
  for (const r of sweepable(await listRuns(), existsSync)) {
    const state = await prState(r.pr!).catch(() => 'OPEN');
    if (state === 'OPEN') continue;
    await removeWorktree(s, r).then(
      () => log(`${r.repo}#${r.number}: PR ${state.toLowerCase()}, removed ${r.worktree}`),
      (e) => log(`${r.repo}#${r.number}: left ${r.worktree} in place, ${(e as Error).message}`),
    );
  }
}

async function tick() {
  const s = await loadConfig();
  const all = [s.ready, s.working, s.blocked];
  const { ready, working, blocked, inFlight } = await fetchQueue(Object.keys(s.repos), s);
  const runs = new Map((await listRuns()).map((r) => [r.url, r]));
  const busy = new Set(running.keys());
  const next = pick(ready, inFlight, s.cap, busy);
  const answers = answered(blocked, runs, await viewer(), busy);
  const lost = orphaned(working, runs, busy, alive);
  if (next.length || answers.length || lost.length || dryRun) log(`${ready.length} ready, ${inFlight} of ${s.cap} in flight.`);

  const go = async (issue: Issue, from: string | null, begin: Begin, what: string) => {
    const kind = runs.get(issue.url)?.kind ?? kindOf(issue.labels, s.repos[issue.repo]?.bugLabels ?? []);
    if (dryRun) return log(`would ${what} ${issue.repo}#${issue.number} as a ${kind}: ${issue.title}`);
    // The label moves first, so the issue leaves its band on Today before any work starts.
    if (from) await moveLabel(issue, from, s.working, all);
    log(`${what} ${issue.repo}#${issue.number} as a ${kind}: ${issue.title}`);
    running.set(issue.url, work(s, issue, log, begin).finally(() => running.delete(issue.url)));
  };
  for (const issue of lost) await go(issue, null, { resume: true, message: RESTARTED }, 'pick up');
  for (const { issue, answer } of answers) await go(issue, s.blocked, { resume: true, message: `Your question on the issue was answered:\n\n${answer}\n\nCarry on with that.` }, 'resume');
  for (const issue of next) await go(issue, s.ready, { resume: false }, 'start');
  await sweep(s);
}

while (true) {
  await tick().catch((e) => log(`error: ${(e as Error).message}`));
  if (once) break;
  await Bun.sleep((await loadConfig().catch(() => ({ pollSeconds: 60 }))).pollSeconds * 1000);
}
await Promise.all(running.values());
