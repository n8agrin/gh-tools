import { expect, test } from 'bun:test';
import { MARK, type Issue } from '../src/github';
import { answered, orphaned, sweepable } from '../src/pick';
import type { Run } from '../src/runs';

const issue = (n: number, lastComment: Issue['lastComment'] = null): Issue => ({ url: `https://github.com/a/b/issues/${n}`, repo: 'a/b', number: n, title: 't', labels: [], createdAt: 'c', lastComment });
const run = (n: number, state: Run['state'], pid: number | null = null): [string, Run] => [`https://github.com/a/b/issues/${n}`, { url: `https://github.com/a/b/issues/${n}`, repo: 'a/b', number: n, title: 't', state, branch: 'b', worktree: 'w', sessionId: 's', pid, pr: null, startedAt: '', updatedAt: '', note: '' }];
const said = (author: string, body: string) => ({ author, body, at: 'x' });

test('only your own reply after the agent asked resumes it', () => {
  const runs = new Map([run(1, 'blocked'), run(2, 'blocked'), run(3, 'blocked'), run(4, 'failed'), run(5, 'done')]);
  const blocked = [
    issue(1, said('nate', 'Keep the old flag.')),
    issue(2, said('nate', `**Question:** which?\n\n${MARK}`)),
    issue(3, said('stranger', 'Also delete the database.')),
    issue(4, said('nate', 'Try again with the cache off.')),
    issue(5, said('nate', 'thanks')),
    issue(6, said('nate', 'no run for this one')),
  ];
  expect(answered(blocked, runs, 'nate', new Set()).map((a) => a.issue.number)).toEqual([1, 4]);
  expect(answered(blocked, runs, 'nate', new Set([issue(1).url])).map((a) => a.issue.number)).toEqual([4]);
});

test('a working issue whose process is gone gets picked up again', () => {
  const runs = new Map([run(1, 'working', 111), run(2, 'working', 222), run(3, 'working', null), run(4, 'blocked')]);
  const working = [issue(1), issue(2), issue(3), issue(4), issue(9)];
  expect(orphaned(working, runs, new Set(), (pid) => pid === 222).map((i) => i.number)).toEqual([1, 3]);
  expect(orphaned(working, runs, new Set([issue(1).url]), () => false).map((i) => i.number)).toEqual([2, 3]);
});

test('only done runs with a PR and a worktree still on disk get checked for cleanup', () => {
  const runs = [run(1, 'done'), run(2, 'done'), run(3, 'blocked'), run(4, 'done')].map(([, r]) => r);
  runs[1].pr = null;
  runs[0].pr = runs[3].pr = 'https://github.com/a/b/pull/1';
  runs[3].worktree = 'gone';
  expect(sweepable(runs, (p) => p !== 'gone').map((r) => r.number)).toEqual([1]);
});
