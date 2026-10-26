import { expect, test } from 'bun:test';
import { reviewPayload } from '../src/github';

const sha = 'a'.repeat(40);

test('builds the create-review body with line comments', () => {
  const p = reviewPayload('COMMENT', '  Looks close. ', [{ path: 'a.ts', line: 12, side: 'RIGHT', body: ' nit ' }], sha);
  expect(p).toEqual({ event: 'COMMENT', body: 'Looks close.', commit_id: sha, comments: [{ path: 'a.ts', line: 12, side: 'RIGHT', body: 'nit' }] });
});

test('approve needs nothing else', () => {
  expect(reviewPayload('APPROVE', '', [], sha).event).toBe('APPROVE');
});

test('rejects what GitHub would reject', () => {
  expect(() => reviewPayload('REQUEST_CHANGES', ' ', [], sha)).toThrow('summary');
  expect(() => reviewPayload('COMMENT', '', [], sha)).toThrow();
  expect(() => reviewPayload('MERGE', 'x', [], sha)).toThrow('unknown');
  expect(() => reviewPayload('COMMENT', 'x', [], 'abc')).toThrow('commit');
  expect(() => reviewPayload('COMMENT', '', [{ path: 'a.ts', line: 0, side: 'RIGHT', body: 'x' }], sha)).toThrow('bad line comment');
  expect(() => reviewPayload('COMMENT', '', [{ path: 'a.ts', line: 3, side: 'UP' as any, body: 'x' }], sha)).toThrow('bad line comment');
});
