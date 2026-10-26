// `bun run queue` prints your review queue. `--json` is for scripts and Claude commands.
import { fetchQueue } from './github';

const q = await fetchQueue();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(q, null, 2));
} else {
  for (const p of q.prs) {
    const via = p.requestedVia === 'direct' ? 'you' : p.requestedVia.join(',');
    console.log(`${p.url}  ${p.title}  (@${p.author}, +${p.additions}/-${p.deletions}, via ${via})`);
  }
  console.log(`${q.prs.length} PRs waiting on your review`);
}
