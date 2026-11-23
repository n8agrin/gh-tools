// gh-runner: watches your agent-ready issues and hands each to Claude Code.
//   bun src/runner.ts             keep watching
//   bun src/runner.ts --once      look once, wait for what it started, and exit
//   --dry-run                     say what it would start, and change nothing
import { loadConfig } from './config';
import { fetchQueue, moveLabel } from './github';
import { pick } from './pick';
import { work } from './worker';

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const dryRun = args.has('--dry-run');

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
const running = new Map<string, Promise<unknown>>();

async function tick() {
  const s = await loadConfig();
  const { ready, inFlight } = await fetchQueue(Object.keys(s.repos), s);
  const next = pick(ready, inFlight, s.cap, new Set(running.keys()));
  if (next.length || dryRun) log(`${ready.length} ready, ${inFlight} of ${s.cap} in flight.`);
  for (const issue of next) {
    if (dryRun) {
      log(`would start ${issue.repo}#${issue.number}: ${issue.title}`);
      continue;
    }
    // The label moves first, so the issue leaves the queue before any work starts.
    await moveLabel(issue, s.ready, s.working, [s.ready, s.working, s.blocked]);
    log(`started ${issue.repo}#${issue.number}: ${issue.title}`);
    running.set(issue.url, work(s, issue, log).finally(() => running.delete(issue.url)));
  }
}

while (true) {
  await tick().catch((e) => log(`error: ${(e as Error).message}`));
  if (once) break;
  await Bun.sleep((await loadConfig().catch(() => ({ pollSeconds: 60 }))).pollSeconds * 1000);
}
await Promise.all(running.values());
