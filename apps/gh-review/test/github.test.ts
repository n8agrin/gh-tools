import { expect, test } from 'bun:test';
import { fill } from '../src/actions';
import { fetchQueue } from '../src/github';

process.env.GH_REVIEW_FIXTURE = `${import.meta.dir}/fixture.json`;

test('reads a search result into rows', async () => {
  const q = await fetchQueue();
  expect(q.viewer).toBe('n8agrin');
  expect(q.prs).toHaveLength(4);
  const fix = q.prs.find((p) => p.number === 63901)!;
  expect(fix.requestedVia).toBe('direct');
  expect(fix.ci).toBe('success');
  const autosave = q.prs.find((p) => p.number === 63877)!;
  expect(autosave.requestedVia).toEqual(['frontend']);
  expect(autosave.ci).toBe('failure');
  expect(autosave.requestedAt < autosave.updatedAt).toBe(true);
});

test('fills action templates', () => {
  const pr = { url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1, title: 't', author: 'x' };
  expect(fill('/nate-pr-summary {url}', pr)).toBe('/nate-pr-summary https://github.com/a/b/pull/1');
  expect(fill('{repo}#{number} by {author}', pr)).toBe('a/b#1 by x');
});

test('runs an action and records its output', async () => {
  const { startAction, listRuns } = await import('../src/actions');
  const pr = { url: 'https://github.com/a/b/pull/2', repo: 'a/b', number: 2, title: 't', author: 'x' } as any;
  await startAction({ key: 'e', label: 'Echo', command: ['echo', 'hi {repo}#{number}'] }, pr);
  await Bun.sleep(300);
  const run = listRuns().find((r) => r.prUrl === pr.url)!;
  expect(run.status).toBe('done');
  expect(run.tail).toBe('hi a/b#2');
});

test('keeps a PR you were asked on and only commented', async () => {
  const { toPR, commentedOnly } = await import('../src/github');
  const raw = JSON.parse(await Bun.file(`${import.meta.dir}/fixture.json`).text());
  const base = raw.data.search.nodes.find((n: any) => n?.number === 63901);
  // GitHub has cleared the request after the comment-only review; only the timeline event remains.
  const n = {
    ...base,
    reviewRequests: { nodes: [] },
    viewerLatestReview: { state: 'COMMENTED' },
    timelineItems: { nodes: [{ createdAt: '2026-09-15T16:34:53Z', requestedReviewer: { __typename: 'User', login: 'n8agrin' } }] },
  };
  expect(commentedOnly(n, 'n8agrin')).toBe(true);
  const pr = toPR(n, 'n8agrin');
  expect(pr.requestedVia).toBe('direct');
  expect(pr.requestedAt).toBe('2026-09-15T16:34:53Z');
  expect(pr.myReview).toBe('COMMENTED');
  expect(commentedOnly({ ...n, viewerLatestReview: { state: 'APPROVED' } }, 'n8agrin')).toBe(false);
  expect(commentedOnly({ ...n, timelineItems: { nodes: [] } }, 'n8agrin')).toBe(false);
});

test('a submitted Copilot review counts as a bug pass', async () => {
  const { hasCopilotReview } = await import('../src/github');
  expect(hasCopilotReview([{ author: { login: 'copilot-pull-request-reviewer' }, state: 'COMMENTED' }])).toBe(true);
  expect(hasCopilotReview([{ author: { login: 'Copilot-Pull-Request-Reviewer[bot]' }, state: 'COMMENTED' }])).toBe(true);
  expect(hasCopilotReview([{ author: { login: 'copilot-pull-request-reviewer' }, state: 'PENDING' }])).toBe(false);
  expect(hasCopilotReview([{ author: { login: 'n8agrin' }, state: 'APPROVED' }])).toBe(false);
});

test('reads a PR to import from a link, owner/repo#n, or a bare number', async () => {
  const { parsePRRef } = await import('../src/github');
  const app = 'https://github.com/acme/app/pull/69713';
  expect(parsePRRef('https://github.com/acme/app/pull/69713')).toBe(app);
  expect(parsePRRef(' https://github.com/acme/app/pull/69713/files ')).toBe(app);
  expect(parsePRRef('69713', 'acme/app')).toBe(app);
  expect(parsePRRef('#69713', 'acme/app')).toBe(app);
  // A bare number means nothing until your config names a repo.
  expect(parsePRRef('69713')).toBeNull();
  expect(parsePRRef('acme/cli#12')).toBe('https://github.com/acme/cli/pull/12');
  expect(parsePRRef('pivot totals')).toBeNull();
  expect(parsePRRef('https://github.com/acme/app/issues/5')).toBeNull();
});
