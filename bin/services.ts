#!/usr/bin/env bun
// Keeps gh-review and gh-runner running on a machine that stays on (docs/home-box.md).
//   bun bin/services.ts install     write a service for each app and start it
//   bun bin/services.ts uninstall   stop and remove them
//   bun bin/services.ts print       show what install would write, and change nothing
// macOS gets launchd agents, Linux gets systemd user units. Both restart the app when it exits.
import { mkdir, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export interface Service {
  name: string;
  /** The app's folder; the service runs its `start` script. */
  cwd: string;
  /** Absolute path to bun, since services start without your shell. */
  bun: string;
  /** Your shell's PATH at install time, so `gh`, `git` and `claude` resolve the way they do for you. */
  path: string;
  home: string;
  log: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const label = (s: Service) => `dev.gh-tools.${s.name}`;

export function plist(s: Service): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label(s))}
  <key>ProgramArguments</key>
  <array>${[s.bun, 'run', 'start'].map(str).join('')}</array>
  <key>WorkingDirectory</key>${str(s.cwd)}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${str(s.path)}<key>HOME</key>${str(s.home)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(s.log)}
  <key>StandardErrorPath</key>${str(s.log)}
</dict>
</plist>
`;
}

/** systemd reads `%` as a specifier and splits unquoted values on spaces. */
const sd = (v: string) => `"${v.replace(/%/g, '%%').replace(/(["\\])/g, '\\$1')}"`;

export function unit(s: Service): string {
  return `[Unit]
Description=${s.name} (gh-tools)
After=network-online.target

[Service]
WorkingDirectory=${s.cwd.replace(/%/g, '%%')}
ExecStart=${sd(s.bun)} run start
Environment=${sd(`PATH=${s.path}`)}
Restart=always
RestartSec=10
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`;
}

export function services(root: string, env = process.env, home = homedir()): Service[] {
  const bun = process.execPath;
  return ['gh-review', 'gh-runner'].map((name) => ({ name, cwd: join(root, 'apps', name), bun, path: env.PATH ?? '', home, log: join(home, `.${name}`, 'service.log') }));
}

const file = (s: Service, mac: boolean, home: string) => (mac ? join(home, 'Library', 'LaunchAgents', `${label(s)}.plist`) : join(home, '.config', 'systemd', 'user', `${s.name}.service`));

const run = async (cmd: string[], quiet = false) => {
  const p = Bun.spawn(cmd, { stdout: 'inherit', stderr: quiet ? 'ignore' : 'inherit' });
  return (await p.exited) === 0;
};

if (import.meta.main) {
  const action = process.argv[2];
  const mac = process.platform === 'darwin';
  const home = homedir();
  const all = services(join(import.meta.dir, '..'));
  const domain = `gui/${userInfo().uid}`;
  if (action === 'print') {
    for (const s of all) console.log(`# ${file(s, mac, home)}\n${mac ? plist(s) : unit(s)}`);
  } else if (action === 'install') {
    for (const s of all) {
      const f = file(s, mac, home);
      await mkdir(dirname(f), { recursive: true });
      await mkdir(dirname(s.log), { recursive: true });
      await Bun.write(f, mac ? plist(s) : unit(s));
      // Booting out first makes install safe to run again after a `git pull` or a PATH change.
      const ok = mac ? (await run(['launchctl', 'bootout', `${domain}/${label(s)}`], true), await run(['launchctl', 'bootstrap', domain, f])) : (await run(['systemctl', '--user', 'daemon-reload'])) && (await run(['systemctl', '--user', 'enable', '--now', `${s.name}.service`])) && (await run(['systemctl', '--user', 'restart', `${s.name}.service`]));
      console.log(`${ok ? 'started' : 'FAILED to start'} ${s.name}  (${f}, log ${s.log})`);
      if (!ok) process.exitCode = 1;
    }
    if (!mac) console.log('To keep them running while you are logged out: sudo loginctl enable-linger $USER');
  } else if (action === 'uninstall') {
    for (const s of all) {
      const f = file(s, mac, home);
      if (mac) await run(['launchctl', 'bootout', `${domain}/${label(s)}`], true);
      else await run(['systemctl', '--user', 'disable', '--now', `${s.name}.service`], true);
      await rm(f, { force: true });
      console.log(`removed ${s.name}`);
    }
  } else {
    console.error('usage: bun bin/services.ts install | uninstall | print');
    process.exitCode = 2;
  }
}
