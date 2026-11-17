import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSlot, releaseSlot, slotBlockers, takeSlot } from '../src/local';

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** An origin with two PR heads, and a clone of it as the local slot's checkout. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'gh-review-local-'));
  const origin = join(root, 'origin');
  sh(root, 'git', 'init', '-q', '-b', 'main', origin);
  writeFileSync(join(origin, 'a'), 'main');
  sh(origin, 'git', 'add', '.');
  sh(origin, 'git', 'commit', '-qm', 'main');
  const heads: string[] = [];
  for (const n of [1, 2]) {
    sh(origin, 'git', 'checkout', '-qb', `pr${n}`, 'main');
    writeFileSync(join(origin, 'a'), `pr${n}`);
    sh(origin, 'git', 'commit', '-qam', `pr${n}`);
    sh(origin, 'git', 'update-ref', `refs/pull/${n}/head`, 'HEAD');
    heads.push(sh(origin, 'git', 'rev-parse', 'HEAD'));
  }
  const dir = join(root, 'local');
  sh(root, 'git', 'clone', '-q', origin, dir);
  return { dir, heads };
}

const pr = (n: number) => ({ url: `https://github.com/o/r/pull/${n}`, repo: 'o/r', number: n });

test('one slot: taking it for another PR checks that PR out and stops the old server', async () => {
  const { dir, heads } = repo();
  const cfg = { dir, start: ['sleep', '30'] };
  const first = await takeSlot(pr(1), cfg);
  expect(sh(dir, 'git', 'rev-parse', 'HEAD')).toBe(heads[0]);
  expect(localSlot()).toMatchObject({ url: pr(1).url, running: true });

  // PR 2 sees PR 1 holding the slot, which the page asks about before moving it.
  expect((await slotBlockers(pr(2).url, cfg)).holder?.url).toBe(pr(1).url);
  await takeSlot(pr(2), cfg);
  expect(sh(dir, 'git', 'rev-parse', 'HEAD')).toBe(heads[1]);
  await Bun.sleep(100);
  expect(() => process.kill(first.pid, 0)).toThrow();
  expect(localSlot()).toMatchObject({ url: pr(2).url, running: true });

  releaseSlot();
  expect(localSlot()).toBeNull();
});

test('uncommitted changes in the checkout block the move', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'a'), 'local edit');
  const cfg = { dir, start: ['sleep', '30'] };
  expect((await slotBlockers(pr(1).url, cfg)).dirty).toEqual([' M a']);
  await expect(takeSlot(pr(1), cfg)).rejects.toThrow('uncommitted changes');
});
