import { expect, test } from 'bun:test';
import { autoLimits, autoPick, headKey, startedOn, type AutoState } from '../src/auto';
import type { ReviewPR } from '../src/github';

const pr = (number: number, requestedAt: string, over: Partial<ReviewPR> = {}) => ({ repo: 'o/app', number, url: `https://github.com/o/app/pull/${number}`, headSha: `sha${number}`, isDraft: false, requestedAt, ...over }) as ReviewPR;
const state = (over: Partial<AutoState> = {}): AutoState => ({ repos: new Set(['o/app']), seen: new Set(), hidden: new Set(), running: 0, startedToday: 0, ...over });
const numbers = (prs: ReviewPR[]) => prs.map((p) => p.number);

test('picks the longest-waiting requests first, up to what may run at once', () => {
  const prs = [pr(3, '2026-11-03'), pr(1, '2026-11-01'), pr(2, '2026-11-02')];
  expect(numbers(autoPick(prs, state(), autoLimits({ atOnce: 2 })))).toEqual([1, 2]);
  expect(numbers(autoPick(prs, state({ running: 1 }), autoLimits({ atOnce: 2 })))).toEqual([1]);
});

test('leaves out drafts, repos with no checkout, set-aside PRs and heads that already have a run', () => {
  const prs = [pr(1, '2026-11-01', { isDraft: true }), pr(2, '2026-11-02', { repo: 'o/other' }), pr(3, '2026-11-03'), pr(4, '2026-11-04'), pr(5, '2026-11-05')];
  const s = state({ hidden: new Set([prs[2].url]), seen: new Set([headKey(prs[3].url, 'sha4')]) });
  expect(numbers(autoPick(prs, s, autoLimits({ atOnce: 9 })))).toEqual([5]);
});

test('a new commit makes a reviewed PR eligible again', () => {
  const s = state({ seen: new Set([headKey('https://github.com/o/app/pull/1', 'old')]) });
  expect(numbers(autoPick([pr(1, '2026-11-01')], s, autoLimits({})))).toEqual([1]);
});

test('stops at the day\'s cap', () => {
  const prs = [pr(1, '2026-11-01'), pr(2, '2026-11-02'), pr(3, '2026-11-03')];
  expect(numbers(autoPick(prs, state({ startedToday: 19 }), autoLimits({ atOnce: 5 })))).toEqual([1]);
  expect(autoPick(prs, state({ startedToday: 20 }), autoLimits({ atOnce: 5 }))).toEqual([]);
});

test('yesterday\'s count does not carry over, and a broken count reads as zero', () => {
  expect(startedOn('2026-11-27', JSON.stringify({ day: '2026-11-27', n: 7 }))).toBe(7);
  expect(startedOn('2026-11-27', JSON.stringify({ day: '2026-11-26', n: 7 }))).toBe(0);
  expect(startedOn('2026-11-27', 'not json')).toBe(0);
  expect(startedOn('2026-11-27', null)).toBe(0);
});
