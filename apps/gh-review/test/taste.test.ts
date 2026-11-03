import { expect, test } from 'bun:test';
import { applyVerdicts, excerpt, site, verifyTaste } from '../src/taste';

const base = 'https://github.com/o/r/blob/aaaaaaa';
const q = (question: string, url: string) => ({ question, why: 'w', job: 'store a limit', evidence: [{ label: 'Base: x', url }] });
const taste = () => ({
  lenses: [
    { lens: 'consistency', note: '', questions: [q('keep me', `${base}/a.ts#L3`), q('wrong comparison', `${base}/routes/enforce.ts#L2-L4`)] },
    { lens: 'simple_first', note: '', questions: [q('overstated', `${base}/a.ts#L1`)] },
  ],
  surface: [],
});

test('reads a cited GitHub line range', () => {
  expect(site(`${base}/app/routes/x%20y.tsx#L10-L14`)).toEqual({ sha: 'aaaaaaa', path: 'app/routes/x y.tsx', start: 10, end: 14 });
  expect(site('https://example.com/x')).toBeNull();
  expect(excerpt('a\nb\nc\nd', 2, 2, 1)).toBe('    1  a\n    2  b\n    3  c');
});

test('the skeptic sees the cited code, and its verdicts keep, drop and reword', async () => {
  let seen = '';
  const out = await verifyTaste(taste(), {
    read: async (_sha, path) => (path === 'routes/enforce.ts' ? 'l1\nif (overLimit) throw\nl3\nl4' : 'x\ny\nz'),
    ask: async (text) => {
      seen = text;
      return {
        verdicts: [
          { id: 'consistency.2', verdict: 'drop', reason: 'the route enforces the limit; the PR stores it' },
          { id: 'simple_first.1', verdict: 'reword', reason: 'there is one caller, not two', question: 'better question' },
        ],
      };
    },
  });
  expect(seen).toContain('## consistency.2');
  expect(seen).toContain('if (overLimit) throw');
  expect(out.lenses[0].questions.map((x: any) => x.question)).toEqual(['keep me']);
  expect(out.lenses[1].questions[0]).toMatchObject({ question: 'better question', reworded: 'there is one caller, not two' });
  expect(out.dropped).toEqual([{ question: 'wrong comparison', reason: 'the route enforces the limit; the PR stores it' }]);
});

test('a finding with no verdict is kept', () => {
  const out = applyVerdicts(taste(), []);
  expect(out.lenses.flatMap((l: any) => l.questions).length).toBe(3);
  expect(out.dropped).toEqual([]);
});

test('the skeptic is told when a finding is about the existing code', async () => {
  let seen = '';
  const t = { lenses: [{ lens: 'area_standards', note: '', questions: [{ ...q('existing note', `${base}/a.ts#L1`), kind: 'existing' }, { ...q('author ask', `${base}/a.ts#L2`), kind: 'author' }] }] };
  await verifyTaste(t, { read: async () => 'x', ask: async (text) => ((seen = text), { verdicts: [] }) });
  expect(seen).toContain('## area_standards.1\n\nKind: existing');
  expect(seen).not.toContain('## area_standards.2\n\nKind: existing');
});

test('the skeptic sees each example, and can drop a wrong one while keeping the question', async () => {
  let seen = '';
  const example = { before: '// a.ts:3\nconst x = `own_${i}`', after: 'const ownColumn = (i: number) => `own_${i}`\nconst x = ownColumn(i)', replaces: 'Replaces the inline template.' };
  const t = { lenses: [{ lens: 'consistency', note: '', questions: [{ ...q('helper?', `${base}/a.ts#L3`), example }, { ...q('rename?', `${base}/a.ts#L1`), example }, q('no sketch', `${base}/a.ts#L2`)] }] };
  const out = await verifyTaste(t, {
    read: async () => 'x',
    ask: async (text) => ((seen = text), { verdicts: [{ id: 'consistency.2', verdict: 'keep', reason: 'after calls a name that is out of scope', drop_example: true }] }),
  });
  expect(seen).toContain('Example (Replaces the inline template.)');
  expect(seen).toContain('const x = ownColumn(i)');
  expect(seen.split('## consistency.3')[1]).not.toContain('Example');
  const [kept, dropped] = out.lenses[0].questions;
  expect(kept.example).toEqual(example);
  expect(dropped.question).toBe('rename?');
  expect(dropped.example).toBeUndefined();
});
