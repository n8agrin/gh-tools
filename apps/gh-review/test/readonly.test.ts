import { expect, test } from 'bun:test';
import { join } from 'node:path';

const bin = join(import.meta.dir, '..', 'bin', 'readonly');
const run = (tool: string, args: string[]) => {
  const p = Bun.spawnSync([join(bin, tool), ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REVIEW_WORKTREES: '/nowhere' } });
  return { code: p.exitCode, err: p.stderr.toString() };
};

test('gh blocks every kind of write to a PR', () => {
  for (const args of [
    ['pr', 'edit', '1', '--add-label', 'x'],
    ['pr', 'review', '1', '--approve'],
    ['pr', 'comment', '1', '-b', 'hi'],
    ['label', 'create', 'x'],
    ['api', 'repos/a/b/issues/1/labels', '-f', 'labels[]=x'],
    ['api', '-X', 'POST', 'repos/a/b/issues/1/comments'],
    ['api', '--method=DELETE', 'repos/a/b/issues/1/labels/x'],
    ['api', 'graphql', '-f', 'query=mutation { addLabelsToLabelable }'],
  ]) {
    const r = run('gh', args);
    expect(r.code).toBe(1);
    expect(r.err).toContain('gh-review: blocked');
  }
});

test('git never pushes and leaves other checkouts alone', () => {
  for (const args of [['push'], ['-C', import.meta.dir, 'checkout', 'main'], ['commit', '-m', 'x']]) {
    const r = run('git', args);
    expect(r.code).toBe(1);
    expect(r.err).toContain('gh-review: blocked');
  }
  expect(run('git', ['--version']).code).toBe(0);
});
