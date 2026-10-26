import { expect, test } from 'bun:test';
// @ts-ignore plain JS module shared with the page
import { findStacks, groupStacks } from '../public/stacks.js';

const pr = (number: number, headRef: string, baseRef: string, repo = 'o/app') => ({ url: `${repo}/${number}`, number, repo, headRef, baseRef, defaultBranch: 'main' });

test('orders a stack bottom first and names the branch under it', () => {
  const prs = [pr(3, 'c', 'b'), pr(1, 'a', 'decision'), pr(9, 'z', 'main'), pr(2, 'b', 'a')];
  const stacks = findStacks(prs);
  expect([...stacks.values()].every((s) => s.size === 3 && s.base === 'decision')).toBe(true);
  expect(stacks.has('o/app/9')).toBe(false);
  const sections = groupStacks(prs, stacks);
  expect(sections.map((s: any) => s.rows.map((r: any) => r.number))).toEqual([[1, 2, 3], [9]]);
});

test('a stack keeps the place of its first member in the sort', () => {
  const prs = [pr(9, 'z', 'main'), pr(2, 'b', 'a'), pr(8, 'y', 'main'), pr(1, 'a', 'main')];
  const sections = groupStacks(prs, findStacks(prs));
  expect(sections.map((s: any) => s.rows.map((r: any) => r.number))).toEqual([[9], [1, 2], [8]]);
});

test('same branch names in different repos are not a stack', () => {
  expect(findStacks([pr(1, 'a', 'main', 'o/x'), pr(2, 'b', 'a', 'o/y')]).size).toBe(0);
});

test("GitHub's own stack wins, and a lone layer still groups", () => {
  const entries = [1, 2, 3].map((n) => ({ position: n, number: n, url: `o/app/${n}` }));
  const native = { ...pr(2, 'b', 'a'), stack: { id: 'S', size: 3, base: 'main', position: 2, entries } };
  const stacks = findStacks([native, pr(9, 'z', 'main')]);
  expect(stacks.get('o/app/2')).toMatchObject({ id: 'S', index: 1, size: 3 });
  expect(groupStacks([native], stacks)[0].stack.entries).toHaveLength(3);
});
