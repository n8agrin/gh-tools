import { expect, test } from 'bun:test';

const { fetchMine } = await import('../src/github');

test('reads your own PRs, drafts included, with who they wait on', async () => {
  process.env.GH_REVIEW_MINE_FIXTURE = `${import.meta.dir}/fixture.json`;
  const q = await fetchMine();
  delete process.env.GH_REVIEW_MINE_FIXTURE;
  expect(q.prs.length).toBeGreaterThan(0);
  for (const p of q.prs) expect(Array.isArray(p.waitingOn)).toBe(true);
});
