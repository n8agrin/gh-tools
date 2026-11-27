import { expect, test } from 'bun:test';
import { settle } from '../src/config';
import type { Result } from '../src/result';
import { kindOf, proofProblem } from '../src/route';
import { prBody } from '../src/worker';

const done = (over: Partial<Result> = {}): Result => ({ status: 'done', summary: 'Fixed.', ...over });
const proof = { test: 'test/export.test.ts', command: 'bun test test/export.test.ts', red: '0 pass\n1 fail', green: '1 pass\n0 fail' };

test('an issue is a bug when it carries one of the repo\'s bug labels, and a change otherwise', () => {
  const { bugLabels } = settle({ repos: { 'a/b': { checkout: '/x' } } }).repos['a/b'];
  expect(kindOf(['Bug', 'agent:ready'], bugLabels)).toBe('bug');
  expect(kindOf(['enhancement'], bugLabels)).toBe('change');
  expect(kindOf(['defect'], settle({ repos: { 'a/b': { checkout: '/x', bugLabels: ['Defect'] } } }).repos['a/b'].bugLabels)).toBe('bug');
});

test('a done bug needs a red and a green run on a test the branch changed', () => {
  const changed = ['src/export.ts', 'test/export.test.ts'];
  expect(proofProblem(done({ proof }), changed)).toBeNull();
  expect(proofProblem(done(), changed)).toContain('needs "proof"');
  expect(proofProblem(done({ proof: { ...proof, red: ' ' } }), changed)).toBe('the proof has no red');
  expect(proofProblem(done({ proof }), ['src/export.ts'])).toContain("doesn't change");
});

test('a bug with no possible test passes with its reason, and says so in the PR', () => {
  const r = done({ noTest: 'A one-pixel misalignment with no visual test for this page.' });
  expect(proofProblem(r, [])).toBeNull();
  expect(prBody({ repo: 'a/b', number: 4 }, r)).toContain('**No failing test:** A one-pixel misalignment');
});

test('the PR description shows the failing run before the passing one, and output cannot break out of its block', () => {
  const body = prBody({ repo: 'a/b', number: 4 }, done({ proof: { ...proof, red: 'expected 1\n```\n1 fail' } }));
  expect(body).toContain('`test/export.test.ts`, with `bun test test/export.test.ts`');
  expect(body.indexOf('Before the fix:')).toBeLessThan(body.indexOf('After the fix:'));
  expect(body).toContain("expected 1\n'''\n1 fail");
  // The hidden result on the last line carries the raw output; only what GitHub renders is counted.
  expect(body.split('\n').slice(0, -1).join('\n').match(/```/g)?.length).toBe(4);
});
