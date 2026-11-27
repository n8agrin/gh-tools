import { expect, test } from 'bun:test';
// @ts-ignore plain JS module shared with the pages
import { isRemote, openLink } from '../public/open.js';

test('only the machine running gh-review counts as local', () => {
  expect(['localhost', '127.0.0.1', '[::1]'].map(isRemote)).toEqual([false, false, false]);
  expect(['box.tail1234.ts.net', '100.64.0.7'].map(isRemote)).toEqual([true, true]);
});

test('a local page asks the server to open the link', () => {
  const calls: unknown[] = [];
  openLink('https://github.com/o/r/pull/1', (path: string, body: unknown) => calls.push([path, body]), 'localhost');
  expect(calls).toEqual([['/api/open', { url: 'https://github.com/o/r/pull/1' }]]);
});

test('a page on another device opens the link itself and leaves the server out', () => {
  const opened: unknown[] = [];
  const calls: unknown[] = [];
  (globalThis as any).window = { open: (...a: unknown[]) => opened.push(a) };
  try {
    openLink('https://github.com/o/r/pull/1', () => calls.push(1), 'box.tail1234.ts.net');
  } finally {
    delete (globalThis as any).window;
  }
  expect(opened).toEqual([['https://github.com/o/r/pull/1', '_blank', 'noopener']]);
  expect(calls).toEqual([]);
});
