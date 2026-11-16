import { expect, test } from 'bun:test';
import { decideLane, readBrief } from '../src/lane';

const decision = { question: 'Keep a session valid until the request ends?', stake: 'Access outlives expiry by one request.', why_you: 'Auth semantics.', where: 'a.ts:3' };
const ai = { lane: 'approve', intent: 'Fewer session reads', kind: 'perf refactor', behavior_change: 'none intended', decisions: [], claims: [], groups: [], raises: [], lowers: [], fixes: [] };

test('takes the AI lane as it is when nothing moves it', () => {
  expect(decideLane(ai, [])).toMatchObject({ lane: 'approve', intent: 'Fewer session reads' });
  expect(decideLane(ai, []).movedFrom).toBeUndefined();
});

test('an unknown lane reads as answer, and bad claims and groups are cleaned up', () => {
  const b = readBrief({ ...ai, lane: 'ship it', claims: [{ claim: 'same pick', status: 'sure', proof: 'yes' }, { claim: ' ' }], groups: [{ kind: 'core', title: 'Pick', files: [] }, { kind: 'odd', title: 'Swap', files: ['x.ts'] }] });
  expect(b.lane).toBe('answer');
  expect(b.claims).toEqual([{ claim: 'same pick', source: '', status: 'unverified', evidence: '', where: '', proof: false }]);
  expect(b.groups).toEqual([{ kind: 'other', title: 'Swap', note: '', files: ['x.ts'], outliers: [] }]);
});

test('read needs a raise that quotes the diff, or it comes down', () => {
  const read = { ...ai, lane: 'read', decisions: [decision], raises: [{ why: 'touches sessions', quote: '', where: 'a.ts:3' }] };
  expect(decideLane(read, [])).toMatchObject({ lane: 'answer', movedFrom: 'read', movedBy: ['no raise quoted the diff'] });
  const quoted = { ...read, raises: [{ why: 'drops the org filter', quote: '- where: { orgId }', where: 'a.ts:3' }] };
  expect(decideLane(quoted, []).lane).toBe('read');
});

test('answer with no decision for you comes down to approve', () => {
  expect(decideLane({ ...ai, lane: 'answer' }, [])).toMatchObject({ lane: 'approve', movedFrom: 'answer' });
  expect(decideLane({ ...ai, lane: 'answer', decisions: [decision] }, []).lane).toBe('answer');
});

test('a red path puts at least one question in front of you, but never lowers', () => {
  const floor = [{ file: 'billing/charge.ts', why: 'billing' }];
  const out = decideLane(ai, floor);
  expect(out).toMatchObject({ lane: 'answer', movedFrom: 'approve' });
  expect(out.decisions[0].where).toBe('billing/charge.ts');
  expect(decideLane({ ...ai, lane: 'block', raises: [{ why: 'fails to build', quote: 'x(', where: 'a.ts:1' }] }, floor).lane).toBe('block');
});

test('a red Check finding raises approve to answer and lists its fix', () => {
  const findings = [{ file: 'a.ts', lines: '40-52', color: 'red', note: 'Swallows the save error', scenario: 'Save fails silently.' }, { file: 'b.ts', lines: '3', color: 'yellow', note: 'minor' }];
  const out = decideLane(ai, [], findings);
  expect(out).toMatchObject({ lane: 'answer', fixes: [{ fix: 'Swallows the save error', where: 'a.ts:40' }] });
  expect(out.decisions[0].question).toContain('Swallows the save error');
  expect(decideLane(ai, [], findings.slice(1)).lane).toBe('approve');
});

test('keeps the AI answer so a rerun of Check can start from it again', () => {
  const first = decideLane(ai, [], [{ file: 'a.ts', lines: '1', color: 'red', note: 'x' }]);
  expect(decideLane(first.ai, [], []).lane).toBe('approve');
});
