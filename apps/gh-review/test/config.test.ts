import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.env.GH_REVIEW_HOME!, 'config.json');
const { CONFIG, appPath, configFile, loadConfig, EXAMPLE, pageConfig } = await import('../src/config');
const { loadActions } = await import('../src/actions');

test('runs on the example until you have your own config', async () => {
  expect(CONFIG).toBe(file);
  expect(configFile()).toBe(EXAMPLE);
  const c = await loadConfig();
  expect(c.checks.some((x) => x.key === 'signal')).toBe(true);
  expect(c.checks.every((x) => !x.optional)).toBe(true);
});

test('reads your config from ~/.gh-review/config.json, actions included', async () => {
  writeFileSync(file, JSON.stringify({ checkouts: { 'a/b': '~/src/b' }, checks: [], actions: [{ key: 'x', label: 'X', command: ['echo', '{url}'] }] }));
  expect(configFile()).toBe(file);
  expect((await loadConfig()).checkouts['a/b']).toBe('~/src/b');
  expect((await loadActions()).map((a) => a.key)).toEqual(['x']);
});

test('prompt paths are relative to the app unless absolute or under ~', () => {
  expect(appPath('prompts/check.md')).toEndWith('/apps/gh-review/prompts/check.md');
  expect(appPath('/x/y.md')).toBe('/x/y.md');
  expect(appPath('~/p.md')).not.toStartWith('~');
});

test('the pages get the bug-pass label and the default repo from your config', async () => {
  writeFileSync(file, JSON.stringify({ checkouts: { 'a/b': '~/b', 'c/d': '~/d' }, checks: [] }));
  expect(await pageConfig()).toEqual({ reviewedLabel: null, defaultRepo: 'a/b' });
  writeFileSync(file, JSON.stringify({ checkouts: { 'a/b': '~/b' }, checks: [], reviewedLabel: 'bug-pass', defaultRepo: 'c/d' }));
  expect(await pageConfig()).toEqual({ reviewedLabel: 'bug-pass', defaultRepo: 'c/d' });
});

test('the example config names nobody\'s repos, labels or skills', async () => {
  const ex = await Bun.file(EXAMPLE).json();
  // The example's placeholder repo isn't a real default.
  writeFileSync(file, JSON.stringify(ex));
  expect((await pageConfig()).defaultRepo).toBeNull();
  expect(Object.keys(ex.checkouts)).toEqual(['owner/repo']);
  expect(ex.reviewedLabel).toBeUndefined();
  expect(ex.red).toEqual([]);
  expect(JSON.stringify(ex)).not.toMatch(/omni|bug-hunt|nate/i);
});

test('every prompt and schema the example config names exists', async () => {
  const ex = await Bun.file(EXAMPLE).json();
  for (const c of ex.checks) for (const p of [c.prompt, c.schema].filter(Boolean)) expect(await Bun.file(appPath(p)).exists()).toBe(true);
  for (const s of ex.checks.map((c: any) => c.schema).filter(Boolean)) JSON.parse(await Bun.file(appPath(s)).text());
});
