// gh-runner: watches your agent-ready issues and hands each to Claude Code.
//   bun src/runner.ts             keep watching
//   bun src/runner.ts --once      look once and exit
//   --dry-run                     say what it would start, and change nothing
import { loadConfig } from './config';
import { fetchQueue } from './github';
import { pick } from './pick';

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const dryRun = args.has('--dry-run');

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);

async function tick() {
  const s = await loadConfig();
  const { ready, inFlight } = await fetchQueue(Object.keys(s.repos), s);
  const next = pick(ready, inFlight, s.cap, new Set());
  log(`${ready.length} ready, ${inFlight} of ${s.cap} in flight.`);
  for (const issue of next) {
    if (dryRun) log(`would start ${issue.repo}#${issue.number}: ${issue.title}`);
  }
  if (!dryRun && next.length) log('Starting agents arrives in the next change; run with --dry-run for now.');
}

while (true) {
  await tick().catch((e) => log(`error: ${(e as Error).message}`));
  if (once) break;
  await Bun.sleep((await loadConfig().catch(() => ({ pollSeconds: 60 }))).pollSeconds * 1000);
}
