import { expect, test } from 'bun:test';
import { plist, services, unit, type Service } from './services';

const s: Service = { name: 'gh-review', cwd: '/Users/me/src/gh tools/apps/gh-review', bun: '/Users/me/.bun/bin/bun', path: '/opt/homebrew/bin:/usr/bin', home: '/Users/me', log: '/Users/me/.gh-review/service.log' };

test('one service per app, each with the installing shell\'s PATH', () => {
  const all = services('/repo', { PATH: '/a:/b' }, '/home/me');
  expect(all.map((x) => [x.name, x.cwd, x.path, x.log])).toEqual([
    ['gh-review', '/repo/apps/gh-review', '/a:/b', '/home/me/.gh-review/service.log'],
    ['gh-runner', '/repo/apps/gh-runner', '/a:/b', '/home/me/.gh-runner/service.log'],
  ]);
});

test('the launchd agent restarts the app and escapes what XML would misread', () => {
  const out = plist({ ...s, path: '/a&b:<c>' });
  expect(out).toContain('<key>Label</key><string>dev.gh-tools.gh-review</string>');
  expect(out).toContain('<array><string>/Users/me/.bun/bin/bun</string><string>run</string><string>start</string></array>');
  expect(out).toContain('<key>KeepAlive</key><true/>');
  expect(out).toContain('<key>PATH</key><string>/a&amp;b:&lt;c&gt;</string>');
});

test('the systemd unit quotes paths with spaces and doubles a percent sign', () => {
  const out = unit({ ...s, path: '/a b:/100%' });
  expect(out).toContain('ExecStart="/Users/me/.bun/bin/bun" run start');
  expect(out).toContain('Environment="PATH=/a b:/100%%"');
  expect(out).toContain('WorkingDirectory=/Users/me/src/gh tools/apps/gh-review');
  expect(out).toContain('Restart=always');
});
