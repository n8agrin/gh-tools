import { expect, test } from 'bun:test';
import { openCommand, sessionState } from '../src/session';

// The comment omni's Depot session workflow posts, trimmed.
const cfg = { name: 'Depot', label: 'session', up: 'Testenv session for this PR is up', ended: 'Testenv session ended', open: ['bin/testenv-session', 'tunnel', '--pr', '{number}', '--sandbox', '{sandbox}'] };
const upBody = [
  '**Testenv session for this PR is up** — `dev` mode on instance 100, ends at 14:05 UTC (about 50 minutes).',
  '',
  '```bash',
  'bin/testenv-session tunnel --pr 75401 --sandbox abc123def',
  '```',
  '',
  'Then browse https://test.thundersalmon.com:4000; the SES inbox is at http://localhost:4005.',
].join('\n');
const up = { body: upBody, at: '2026-11-17T13:15:00Z' };
const ended = { body: '**Testenv session ended**: TTL reached. Add the `session` label again for a new session.', at: '2026-11-17T14:06:00Z' };

test('the label is the switch, the comment says how far along the box is', () => {
  expect(sessionState(cfg, false, null).state).toBe('none');
  expect(sessionState(cfg, false, ended).state).toBe('ended');
  // Label just added: no up comment yet, or only the last box's ended one.
  expect(sessionState(cfg, true, null).state).toBe('booting');
  expect(sessionState(cfg, true, ended).state).toBe('booting');
});

test('an up comment gives the sandbox, the address and when the box ends', () => {
  expect(sessionState(cfg, true, up, new Date('2026-11-17T13:30:00Z'))).toEqual({ state: 'ready', sandbox: 'abc123def', appUrl: 'https://test.thundersalmon.com:4000', endsAt: '2026-11-17T14:05:00.000Z' });
  // Past its end the label is about to come off, so it isn't offered as up.
  expect(sessionState(cfg, true, up, new Date('2026-11-17T14:10:00Z')).state).toBe('ended');
  // An end time before the comment's own time is the next day's.
  const late = { ...up, at: '2026-11-17T23:40:00Z', body: upBody.replace('14:05', '00:30') };
  expect(sessionState(cfg, true, late, new Date('2026-11-17T23:50:00Z')).endsAt).toBe('2026-11-18T00:30:00.000Z');
});

test('the open command gets the PR number and the sandbox', () => {
  expect(openCommand(cfg, 75401, 'abc123def')).toEqual(['bin/testenv-session', 'tunnel', '--pr', '75401', '--sandbox', 'abc123def']);
  expect(openCommand({ ...cfg, open: undefined }, 1, 'x')).toBeNull();
});
