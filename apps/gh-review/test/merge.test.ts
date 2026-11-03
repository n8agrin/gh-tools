import { expect, test } from 'bun:test';
import { decideCall, readCall } from '../src/merge';

const ai = { call: 'merge', reason: 'small copy change', why: '', domain: '', flag: '', fixes: [] };

test('takes the AI call as it is when nothing raises it', () => {
  expect(decideCall(ai, [])).toMatchObject({ call: 'merge', reason: 'small copy change', fixes: [] });
  expect(decideCall(ai, []).raisedBy).toBeUndefined();
});

test('an unknown call reads as merge with review, and a leading call name is dropped', () => {
  expect(readCall({ ...ai, call: 'ship it' }).call).toBe('review');
  expect(readCall({ ...ai, reason: 'Merge with fixes: two small things' }).reason).toBe('two small things');
  expect(readCall({ ...ai, fixes: [{ fix: ' ' }, { fix: 'Add a test', where: 'a.ts:3' }] }).fixes).toEqual([{ fix: 'Add a test', where: 'a.ts:3' }]);
});

test('a red path from your config means a careful review, but never lowers block', () => {
  const floor = [{ file: 'billing/charge.ts', why: 'billing' }];
  expect(decideCall(ai, floor)).toMatchObject({ call: 'review', domain: 'billing', raisedFrom: 'merge' });
  expect(decideCall({ ...ai, call: 'block', why: 'fails to build' }, floor)).toMatchObject({ call: 'block' });
});

test('a red Check finding turns merge into merge with fixes and lists it', () => {
  const findings = [{ file: 'a.ts', lines: '40-52', color: 'red', note: 'Swallows the save error' }, { file: 'b.ts', lines: '3', color: 'yellow', note: 'minor' }];
  const out = decideCall(ai, [], findings);
  expect(out).toMatchObject({ call: 'fixes', raisedFrom: 'merge', fixes: [{ fix: 'Swallows the save error', where: 'a.ts:40' }] });
  expect(decideCall(ai, [], findings.slice(1)).call).toBe('merge');
  expect(decideCall({ ...ai, call: 'review' }, [], findings).call).toBe('review');
});

test('keeps the AI answer so a rerun of Check can start from it again', () => {
  const first = decideCall(ai, [], [{ file: 'a.ts', lines: '1', color: 'red', note: 'x' }]);
  expect(decideCall(first.ai, [], []).call).toBe('merge');
});
