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
  expect(t.counts).toEqual({ waiting: 1, hunt: 1, hidden: 1, teamMentions: 0 });
});

test('mentions come oldest first, and a mention on a PR already above gets no second row', async () => {
  const { toMention } = await import('../src/github');
  const raw = await Bun.file(`${import.meta.dir}/notifications.json`).json();
  const mentions = raw.map(toMention).filter(Boolean);
  // CI and review requests are left out; a release links to its repo.
  expect(mentions.map((m: any) => m.id)).toEqual(['101', '102', '105']);
  expect(mentions[0].url).toBe('https://github.com/acme/app/pull/63120');
  expect(mentions[1].url).toBe('https://github.com/acme/app/issues/63140');
  expect(mentions[2].url).toBe('https://github.com/acme/docs');

  const queue = [pr(63120, { url: 'https://github.com/acme/app/pull/63120', repo: 'acme/app' })];
  const t = buildToday(input({ queue, mentions }));
  // A team mention is only counted, since a busy team's would bury the rest.
  expect(t.bands[2].rows.map((r) => r.thread)).toEqual(['102']);
  expect(t.bands[2].rows[0]).toMatchObject({ number: 63140, tag: 'MENTION', next: 'thread', why: "New comments on a thread you're in." });
  expect(t.counts.teamMentions).toBe(1);
});

test("an agent's question comes before mentions, and issues to start come last", async () => {
  const agents = { ...(await Bun.file(`${import.meta.dir}/agent-issues.json`).json()), cap: 5 };
  // A mention on the blocked issue is the same thing to do as answering it.
  const mentions = [{ id: '1', url: 'https://github.com/acme/app/issues/3', repo: 'acme/app', number: 3, title: 'Speed up the board', reason: 'mention', updatedAt: '2026-11-15T10:00:00Z' }];
  const t = buildToday(input({ agents, mentions: mentions as any }));
  expect(t.bands.map((b) => b.key)).toEqual(['review', 'move', 'agents', 'mentions', 'start']);
  const [asking] = t.bands[2].rows;
  expect(asking).toMatchObject({ tag: 'AGENT', next: 'answer', number: 3, why: '@agent-bot: Should the cache live in sqlite or memory?', since: '2026-11-15T09:00:00Z' });
  expect(t.bands[3].rows).toEqual([]);
  expect(t.bands[4].rows.map((r) => [r.number, r.tag, r.next])).toEqual([[7, 'ISSUE', 'start'], [9, 'ISSUE', 'start']]);
  expect(t.agents).toEqual({ inFlight: 2, cap: 5, working: [] });
  // Without an agent in your config there are no agent bands.
  expect(buildToday(input()).bands.map((b) => b.key)).toEqual(['review', 'move', 'mentions']);
});
