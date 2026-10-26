import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.GH_REVIEW_HOME!;
writeFileSync(join(home, 'state.json'), JSON.stringify({ skipped: { 'https://github.com/a/b/pull/9': '2026-09-01T00:00:00Z' } }));
const db = await import('../src/db');

test('imports set-aside PRs from the old state.json once', () => {
  expect(db.getSkipped()).toEqual({ 'https://github.com/a/b/pull/9': '2026-09-01T00:00:00Z' });
  expect(existsSync(join(home, 'state.json'))).toBe(false);
});

test('set aside and bring back', () => {
  db.setSkipped('https://github.com/a/b/pull/1', '2026-09-02T00:00:00Z');
  expect(db.getSkipped()['https://github.com/a/b/pull/1']).toBe('2026-09-02T00:00:00Z');
  db.setSkipped('https://github.com/a/b/pull/1', null);
  expect(db.getSkipped()['https://github.com/a/b/pull/1']).toBeUndefined();
});

test('a new fetch replaces the cached queue', () => {
  const pr = (n: number) => ({ url: `https://github.com/a/b/pull/${n}`, number: n }) as any;
  db.saveQueue({ viewer: 'me', fetchedAt: '2026-09-29T00:00:00Z', prs: [pr(1), pr(2)] });
  db.saveQueue({ viewer: 'me', fetchedAt: '2026-09-29T01:00:00Z', prs: [pr(2)] });
  const q = db.cachedQueue()!;
  expect(q.fetchedAt).toBe('2026-09-29T01:00:00Z');
  expect(q.prs.map((p) => p.number)).toEqual([2]);
});

test('Done keeps approved PRs and ones marked by hand, newest first', () => {
  const pr = (n: number) => ({ url: `https://github.com/a/b/pull/${n}`, number: n, state: 'OPEN' }) as any;
  db.saveReviewed([{ pr: pr(10), review: 'APPROVED', at: '2026-09-20T00:00:00Z' }]);
  db.markDone(pr(11), '2026-09-21T00:00:00Z');
  expect(db.listDone().map((d) => [d.pr.number, d.reason])).toEqual([[11, 'marked'], [10, 'approved']]);

  // A merge refreshes the PR info but keeps when it went to Done.
  db.saveReviewed([{ pr: { ...pr(10), state: 'MERGED' }, review: 'APPROVED', at: '2026-09-20T00:00:00Z' }]);
  const merged = db.listDone().find((d) => d.pr.number === 10)!;
  expect(merged.pr.state).toBe('MERGED');
  expect(merged.doneAt).toBe('2026-09-20T00:00:00Z');

  // Approving a PR you had marked done replaces the reason with the newer review.
  db.saveReviewed([{ pr: pr(11), review: 'APPROVED', at: '2026-09-22T00:00:00Z' }]);
  expect(db.listDone().find((d) => d.pr.number === 11)!.reason).toBe('approved');

  db.unmarkDone(pr(11).url);
  expect(db.listDone().map((d) => d.pr.number)).toEqual([10]);
});

test('review summaries take minutes and signal from the newest review that has them', () => {
  const url = 'https://github.com/a/b/pull/7';
  const old = db.createReview(url, 'sha1', [
    { key: 'guide', label: 'Reading guide', status: 'done', output: JSON.stringify({ minutes: 45 }) },
    { key: 'signal', label: 'Signal', status: 'done', output: JSON.stringify({ color: 'red', reason: 'Red: changes SQL' }) },
  ]);
  const newer = db.createReview(url, 'sha2', [
    { key: 'guide', label: 'Reading guide', status: 'done', output: JSON.stringify({ minutes: 10 }) },
    { key: 'signal', label: 'Signal', status: 'failed', output: 'timed out' },
  ]);
  expect(newer).toBeGreaterThan(old);
  expect(db.reviewSummaries()[url]).toMatchObject({ minutes: 10, color: 'red', reason: 'Red: changes SQL', headSha: 'sha1', override: null });

  db.setOverride(url, 'yellow');
  expect(db.reviewSummaries()[url].override).toBe('yellow');
  db.setOverride(url, null);
  expect(db.reviewSummaries()[url].override).toBeNull();
});

const mpr = (n: number, extra = {}) => ({ url: `https://github.com/a/b/pull/${n}`, number: n, ...extra }) as any;

test('your own PRs never touch the review queue', () => {
  db.saveQueue({ viewer: 'me', fetchedAt: '2026-10-22T00:00:00Z', prs: [mpr(1)], reviewed: [] });
  db.saveMine({ viewer: 'me', fetchedAt: '2026-10-22T01:00:00Z', prs: [mpr(2, { waitingOn: [] })] });
  db.setMineAside(mpr(2).url, '2026-10-22T01:00:00Z');
  expect(db.cachedQueue()!.prs.map((p) => p.number)).toEqual([1]);
  expect(db.getSkipped()[mpr(2).url]).toBeUndefined();
  expect(db.cachedMine()!.prs.map((p) => p.number)).toEqual([2]);
  expect(db.getMineAside()[mpr(2).url]).toBe('2026-10-22T01:00:00Z');
  // Review runs and actions find a PR in either list.
  expect(db.cachedPR(mpr(1).url)?.number).toBe(1);
  expect(db.cachedPR(mpr(2).url)?.number).toBe(2);
  expect(db.viewer()).toBe('me');
});
