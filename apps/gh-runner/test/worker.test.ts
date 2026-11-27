import { expect, test } from 'bun:test';
import { settle } from '../src/config';
import { parseResult } from '../src/result';
import { branchFor, claudeArgs, fill, resultComment, sessionStarted } from '../src/worker';

test('branchFor makes a short readable branch from the issue', () => {
  expect(branchFor('agent/', { number: 12, title: 'Export button does nothing on Safari!' })).toBe('agent/12-export-button-does-nothing-on-safari');
  expect(branchFor('nate-claude/', { number: 3, title: '???' })).toBe('nate-claude/3');
  expect(branchFor('agent/', { number: 4, title: 'a'.repeat(39) + ' b' })).toBe(`agent/4-${'a'.repeat(39)}`);
});

test('fill leaves unknown placeholders alone', () => {
  expect(fill('{path} {branch} {nope}', { path: '/x', branch: 'b' })).toBe('/x b {nope}');
});

test('the agent can never push or open a PR itself, and gets the session id and model', () => {
  const s = settle({ repos: { 'a/b': { checkout: '/x' } }, model: 'opus' });
  const args = claudeArgs(s, 'p', 'sid');
  expect(args).toContain('Bash(git push:*)');
  expect(args).toContain('Bash(gh pr create:*)');
  expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'sid']);
  expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
  expect(claudeArgs(settle({ repos: { 'a/b': { checkout: '/x' } } }), 'p', 's')).not.toContain('--model');
});

test('parseResult refuses results the runner cannot act on', () => {
  expect(() => parseResult(null)).toThrow();
  expect(() => parseResult({ status: 'maybe', summary: 'x' })).toThrow();
  expect(() => parseResult({ status: 'done', summary: ' ' })).toThrow();
  expect(() => parseResult({ status: 'blocked', summary: 'x' })).toThrow('question');
  expect(parseResult({ status: 'done', summary: 'Fixed.' }).status).toBe('done');
});

test("a blocked comment leads with the question, since that's the line Today shows", () => {
  const c = resultComment({ status: 'blocked', summary: 'Two ways to do it.', question: 'Keep the old flag?' }, 'agent/1', null);
  expect(c.split('\n')[0]).toBe('**Question:** Keep the old flag?');
  const d = resultComment({ status: 'done', summary: 'Fixed it.', skipped: [{ finding: 'f', reason: 'r' }] }, 'agent/1', null);
  expect(d).toContain('- f: r');
});

test('a done PR description carries the result for gh-review to read back, even with dashes in it', async () => {
  const { prBody } = await import('../src/worker');
  const { decodeResult } = await import('../src/result');
  const r = { status: 'done' as const, summary: 'Fixed --flag --> parsing.', tests: [{ command: 'bun test', passed: true }], skipped: [{ finding: 'x', reason: 'y' }] };
  const body = prBody({ repo: 'a/b', number: 4 }, r);
  expect(body.startsWith('Fixes a/b#4.')).toBe(true);
  expect(body).toContain('- passed: `bun test`');
  expect(body.split('\n').pop()!.match(/--/g)?.length).toBe(2);
  expect(decodeResult(body)).toEqual(r);
  expect(decodeResult(prBody({ repo: 'a/b', number: 4 }, null))).toBeNull();
});

test('a session counts as started only once claude logged its init line for it', () => {
  const init = (id: string) => JSON.stringify({ type: 'system', subtype: 'init', session_id: id });
  const hook = JSON.stringify({ type: 'system', subtype: 'hook_started', session_id: 's1' });
  const failed = JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 's1' });
  expect(sessionStarted('', 's1')).toBe(false);
  expect(sessionStarted([hook, failed].join('\n'), 's1')).toBe(false);
  expect(sessionStarted([init('s0'), hook].join('\n'), 's1')).toBe(false);
  expect(sessionStarted([hook, init('s1')].join('\n'), 's1')).toBe(true);
});
