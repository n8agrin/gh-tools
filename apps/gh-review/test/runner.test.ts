import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workingRuns } from '../src/runner';
import { buildToday } from '../src/today';

test("Today lists gh-runner's working runs from its status files, oldest first, and skips the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runs-'));
  const put = (name: string, body: string) => (mkdirSync(join(dir, name)), writeFileSync(join(dir, name, 'run.json'), body));
  const run = (n: number, state: string, startedAt: string, pr: string | null = null) => JSON.stringify({ url: `https://github.com/a/b/issues/${n}`, repo: 'a/b', number: n, title: `t${n}`, state, pr, startedAt, updatedAt: startedAt, sessionId: 'secret' });
  put('a__b__1', run(1, 'working', '2026-11-23T10:00:00Z', 'https://github.com/a/b/pull/5'));
  put('a__b__2', run(2, 'blocked', '2026-11-23T09:00:00Z'));
  put('a__b__3', run(3, 'working', '2026-11-23T08:00:00Z'));
  put('a__b__4', '{"half');
  mkdirSync(join(dir, 'empty'));
  const working = await workingRuns(dir);
  expect(working.map((w) => w.number)).toEqual([3, 1]);
  expect(working[1]).toEqual({ url: 'https://github.com/a/b/issues/1', repo: 'a/b', number: 1, title: 't1', pr: 'https://github.com/a/b/pull/5', startedAt: '2026-11-23T10:00:00Z', updatedAt: '2026-11-23T10:00:00Z' });
  expect(await workingRuns(join(dir, 'missing'))).toEqual([]);

  const t = buildToday({ viewer: 'me', queue: [], mine: [], summaries: {}, stages: {}, overrides: {}, skipped: {}, mineAside: {}, mineDone: {}, agents: { ready: [], asking: [], inFlight: 2, cap: 5, working } } as any);
  expect(t.agents?.working.map((w) => w.number)).toEqual([3, 1]);
});
