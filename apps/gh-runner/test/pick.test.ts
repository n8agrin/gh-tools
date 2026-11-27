import { expect, test } from 'bun:test';
import { settle } from '../src/config';
import { toIssue, scope } from '../src/github';
import { pick } from '../src/pick';
import fixture from './fixture-queue.json';

test('pick takes the oldest ready issues until the cap, skipping ones already running', () => {
  expect(pick(fixture.ready, 1, 5, new Set()).map((i) => i.number)).toEqual([9, 12]);
  expect(pick(fixture.ready, 4, 5, new Set()).map((i) => i.number)).toEqual([9]);
  expect(pick(fixture.ready, 5, 5, new Set())).toEqual([]);
  expect(pick(fixture.ready, 7, 5, new Set())).toEqual([]);
  expect(pick(fixture.ready, 0, 5, new Set([fixture.ready[1].url])).map((i) => i.number)).toEqual([12]);
});

test('only issues assigned to you are searched', () => {
  expect(scope(['a/b', 'c/d'])).toBe('is:issue is:open archived:false assignee:@me repo:a/b repo:c/d');
});

test('a search node becomes an issue', () => {
  const n = { url: 'u', number: 3, title: 't', createdAt: 'c', repository: { nameWithOwner: 'a/b' }, labels: { nodes: [{ name: 'agent:ready' }] } };
  expect(toIssue(n)).toEqual({ url: 'u', repo: 'a/b', number: 3, title: 't', labels: ['agent:ready'], createdAt: 'c', lastComment: null });
});

test('settle fills defaults and refuses a config with no usable repos', () => {
  const s = settle({ repos: { 'a/b': { checkout: '~/src/b' } } });
  expect(s.ready).toBe('agent:ready');
  expect(s.cap).toBe(5);
  expect(s.repos['a/b'].base).toBe('main');
  expect(s.repos['a/b'].checkout.startsWith('~')).toBe(false);
  expect(() => settle({ repos: {} })).toThrow();
  expect(() => settle({ repos: { nope: { checkout: 'x' } } })).toThrow();
});
