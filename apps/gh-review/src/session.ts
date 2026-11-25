// Test boxes per PR: a label on the PR starts one, a bot comment says when it's up and how to reach it,
// and removing the label stops it. omni's Depot sessions work this way. The state is read from GitHub
// every time; the only thing kept here is the tunnel process this server started for you.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expand, type Session } from './config';
import { HOME } from './db';

export type SessionState = 'none' | 'booting' | 'ready' | 'ended';

export interface SessionInfo {
  state: SessionState;
  /** From the up comment: the box's id, the app's address, and when it ends. */
  sandbox: string | null;
  appUrl: string | null;
  endsAt: string | null;
  /** A tunnel this server started for the PR is still running. */
  tunnel: boolean;
}

/**
 * The box's state from the label and the newest bot comment. The label is the switch: on with no up
 * comment yet (or only an old ended one) is booting; the bot takes the label off when a box ends.
 */
export function sessionState(cfg: Session, labeled: boolean, comment: { body: string; at: string } | null, now = new Date()): Omit<SessionInfo, 'tunnel'> {
  const up = comment?.body.includes(cfg.up) ? comment : null;
  const none = { sandbox: null, appUrl: null, endsAt: null };
  if (!labeled) return { state: comment?.body.includes(cfg.ended) ? 'ended' : 'none', ...none };
  if (!up) return { state: 'booting', ...none };
  const sandbox = up.body.match(/--sandbox\s+([\w.-]+)/)?.[1] ?? null;
  const appUrl = up.body.match(/https?:\/\/[^\s)`'"]+:\d+/)?.[0] ?? null;
  // "ends at 14:05 UTC": the next 14:05 UTC after the comment was written.
  const hm = up.body.match(/ends at (\d{1,2}):(\d{2}) UTC/);
  let endsAt: string | null = null;
  if (hm) {
    const t = new Date(up.at);
    t.setUTCHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (t.getTime() < Date.parse(up.at)) t.setUTCDate(t.getUTCDate() + 1);
    endsAt = t.toISOString();
  } else if (cfg.ttl) endsAt = new Date(Date.parse(up.at) + cfg.ttl * 60_000).toISOString();
  // Past its end the bot is about to take the label off; call it ended rather than offer a dead box.
  if (endsAt && Date.parse(endsAt) < now.getTime()) return { state: 'ended', ...none };
  return { state: 'ready', sandbox, appUrl, endsAt };
}

/** The open command with {number} and {sandbox} filled in. */
export function openCommand(cfg: Session, number: number, sandbox: string): string[] | null {
  return cfg.open?.length ? cfg.open.map((p) => p.replace(/\{number\}/g, String(number)).replace(/\{sandbox\}/g, sandbox)) : null;
}

const tunnels = new Map<string, { proc: ReturnType<typeof Bun.spawn>; sandbox: string; log: string }>();

export const tunnelRunning = (url: string, sandbox?: string | null) => {
  const t = tunnels.get(url);
  return !!t && t.proc.exitCode === null && (!sandbox || t.sandbox === sandbox);
};

/** Starts the open command in your checkout and leaves it running, logging to ~/.gh-review/tunnels. */
export function startTunnel(url: string, cmd: string[], sandbox: string, checkout: string): string {
  if (tunnelRunning(url, sandbox)) return tunnels.get(url)!.log;
  stopTunnel(url);
  const dir = join(HOME, 'tunnels');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${url.split('/').slice(-3).join('-')}-${Date.now()}.log`);
  const proc = Bun.spawn(cmd, { cwd: expand(checkout), stdout: Bun.file(log), stderr: Bun.file(`${log}.err`), stdin: 'ignore' });
  tunnels.set(url, { proc, sandbox, log });
  return log;
}

export function stopTunnel(url: string) {
  const t = tunnels.get(url);
  if (t && t.proc.exitCode === null) t.proc.kill();
  tunnels.delete(url);
}

/** The box count for the header: tunnels this server is holding open. */
export const openTunnels = () => [...tunnels.values()].filter((t) => t.proc.exitCode === null).length;
