// Run locally: one slot, on purpose. A PR is checked out in a dedicated clone and its dev server
// started there; moving the slot to another PR stops that server first. The slot is kept in the
// meta table so it survives a restart of this server.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { expand, type Local } from './config';
import { getMeta, HOME, setMeta } from './db';

export interface Slot {
  url: string;
  repo: string;
  number: number;
  dir: string;
  pid: number;
  startedAt: string;
  log: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Who holds the slot, and whether its server is still running. */
export function localSlot(): (Slot & { running: boolean }) | null {
  const raw = getMeta('localSlot');
  if (!raw) return null;
  const s = JSON.parse(raw) as Slot;
  return { ...s, running: alive(s.pid) };
}

/** Stops the slot's server and everything it started, which bin/dev-style scripts do a lot of. */
function stop(s: Slot) {
  if (!alive(s.pid)) return;
  try {
    process.kill(-s.pid, 'SIGTERM');
  } catch {
    process.kill(s.pid, 'SIGTERM');
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || `git ${args[0]} exited ${code}`);
  return out;
}

/** What stands between a PR and the slot. Empty means go; the page asks you about each one. */
export async function slotBlockers(url: string, cfg: Local): Promise<{ holder: Slot | null; dirty: string[] }> {
  const held = localSlot();
  const holder = held && held.url !== url && held.running ? held : null;
  const dirty = (await git(expand(cfg.dir), ['status', '--porcelain'])).split('\n').filter(Boolean);
  return { holder, dirty };
}

/**
 * Moves the slot to a PR: stops the old server, checks the PR's head out (detached, so no branch
 * in that clone is moved), and starts `cfg.start` there. Refuses on uncommitted changes in the clone,
 * since the checkout would carry them along or fail on them.
 */
export async function takeSlot(pr: { url: string; repo: string; number: number }, cfg: Local): Promise<Slot> {
  const dir = expand(cfg.dir);
  if ((await git(dir, ['status', '--porcelain'])).trim()) throw new Error(`${cfg.dir} has uncommitted changes. Commit or stash them there first.`);
  const old = localSlot();
  if (old) stop(old);
  await git(dir, ['fetch', 'origin', `pull/${pr.number}/head`]);
  await git(dir, ['checkout', '--detach', 'FETCH_HEAD']);
  const logs = join(HOME, 'local');
  mkdirSync(logs, { recursive: true });
  const log = join(logs, `${pr.repo.replace('/', '-')}-${pr.number}-${Date.now()}.log`);
  const fd = openSync(log, 'a');
  // Its own process group, so moving the slot can stop the server and everything under it.
  const child = spawn(cfg.start[0], cfg.start.slice(1), { cwd: dir, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  if (!child.pid) throw new Error(`Couldn't start ${cfg.start.join(' ')} in ${cfg.dir}`);
  const slot: Slot = { url: pr.url, repo: pr.repo, number: pr.number, dir: cfg.dir, pid: child.pid, startedAt: new Date().toISOString(), log };
  setMeta('localSlot', JSON.stringify(slot));
  return slot;
}

/** Stops the server and frees the slot. The clone stays on the PR's commit. */
export function releaseSlot() {
  const s = localSlot();
  if (s) stop(s);
  setMeta('localSlot', null);
}
