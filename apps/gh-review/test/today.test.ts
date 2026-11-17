import { expect, test } from 'bun:test';
import type { ReviewSummary } from '../src/db';
import type { MyPR, ReviewPR } from '../src/github';
import type { Stage } from '../src/stage';
import { buildToday, type TodayInput } from '../src/today';

const pr = (n: number, o: Partial<MyPR> = {}): MyPR =>
  ({
    url: `https://github.com/o/r/pull/${n}`,
    repo: 'o/r',
    number: n,
    title: `PR ${n}`,
    author: 'someone',
    headSha: `sha${n}`,
    updatedAt: '2026-11-10T00:00:00Z',
    requestedAt: '2026-11-10T00:00:00Z',
    waitingOn: [],
    ...o,
  }) as MyPR;
const stage = (key: Stage['key'], o: Partial<Stage> = {}): Stage => ({ key, why: `${key} why`, next: 'nudge', findings: 0, stalePass: false, ...o });
const brief = (o: Partial<ReviewSummary>): ReviewSummary => ({ minutes: null, color: null, reason: null, headSha: null, override: null, reviewId: 1, lane: null, intent: null, decisions: [], ...o });
const input = (o: Partial<TodayInput> = {}): TodayInput => ({ viewer: 'me', queue: [], done: new Set(), skipped: {}, summaries: {}, mine: [], stages: {}, mineAside: {}, mineDone: {}, ...o });
const urls = (rows: { url: string }[]) => rows.map((r) => Number(r.url.split('/').at(-1)));

test('review requests come oldest first, without the ones you answered or set aside', () => {
  const queue: ReviewPR[] = [
    pr(1, { requestedAt: '2026-11-12T00:00:00Z' }),
    pr(2, { requestedAt: '2026-11-11T00:00:00Z' }),
    pr(3),
    pr(4, { updatedAt: '2026-11-10T00:00:00Z' }),
    // Set aside, then the PR changed: it comes back.
    pr(5, { updatedAt: '2026-11-15T00:00:00Z' }),
  ];
  const t = buildToday(input({ queue, done: new Set([queue[2].url]), skipped: { [queue[3].url]: '2026-11-10T00:00:00Z', [queue[4].url]: '2026-11-11T00:00:00Z' } }));
  expect(urls(t.bands[0].rows)).toEqual([5, 2, 1]);
  expect(t.counts.hidden).toBe(1);
});

test("approve is offered only when the brief cleared this head, and never on your own PR", () => {
  const queue: ReviewPR[] = [pr(1), pr(2, { headSha: 'new' }), pr(3, { author: 'me' }), pr(4)];
  const summaries = {
    [queue[0].url]: brief({ lane: 'approve', headSha: 'sha1', intent: 'Adds a retry' }),
    [queue[1].url]: brief({ lane: 'approve', headSha: 'sha2' }),
    [queue[2].url]: brief({ lane: 'approve', headSha: 'sha3' }),
    [queue[3].url]: brief({ lane: 'answer', headSha: 'sha4', decisions: ['Keep the old flag?', 'Ship behind a flag?'] }),
  };
  const [a, b, c, d] = buildToday(input({ queue, summaries })).bands[0].rows;
  expect(a).toMatchObject({ next: 'approve', why: 'Agent approves: Adds a retry' });
  expect(b).toMatchObject({ next: 'brief', lane: null, why: 'The brief is from an older commit.' });
  expect(c.next).toBe('brief');
  expect(d).toMatchObject({ next: 'brief', why: 'Answer questions: Keep the old flag?', decisions: ['Keep the old flag?', 'Ship behind a flag?'] });
});

test('your PRs that need you come closest-to-landing first; the rest are counts', () => {
  const mine = [pr(1), pr(2), pr(3), pr(4, { updatedAt: '2026-11-01T00:00:00Z' }), pr(5), pr(6), pr(7), pr(8)];
  const stages: Record<string, Stage> = {
    [mine[0].url]: stage('blocked', { next: 'unblock' }),
    [mine[1].url]: stage('fix', { next: 'findings', findings: 2 }),
    [mine[2].url]: stage('ship', { next: 'merge' }),
    [mine[3].url]: stage('ship', { next: 'merge' }),
    [mine[4].url]: stage('undraft', { next: 'undraft' }),
    [mine[5].url]: stage('waiting'),
    [mine[6].url]: stage('hunt', { next: 'hunt' }),
    [mine[7].url]: stage('ship', { next: 'merge' }),
  };
  // 8 is marked done on its current head, so it stays off until a new commit lands.
  const t = buildToday(input({ mine, stages, mineDone: { [mine[7].url]: { headSha: 'sha8' } } }));
  const move = t.bands[1].rows;
  expect(urls(move)).toEqual([4, 3, 5, 2, 1]);
  expect(move.map((r) => r.tag)).toEqual(['SHIP', 'SHIP', 'UNDRAFT', 'FINDINGS', 'BLOCKED']);
  expect(move[3]).toMatchObject({ next: 'findings', findings: 2, mine: true });
  expect(t.counts).toEqual({ waiting: 1, hunt: 1, hidden: 1 });
});
