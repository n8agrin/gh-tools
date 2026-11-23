import { expect, test } from 'bun:test';
import { applyHuntVerdicts, saidLines, verifyHunt, type Finding } from '../src/hunt';

const f = (note: string, color: 'red' | 'yellow', lines = '3-4'): Finding => ({ file: 'src/a.ts', lines, kind: 'check', category: 'bug', color, note, scenario: 'x is null' });

test('the skeptic drops, downgrades and keeps findings by position, and a missing verdict keeps', () => {
  const out = applyHuntVerdicts({ verdict: 'careful', findings: [f('gone', 'red'), f('softer', 'red'), f('stays', 'yellow'), f('unjudged', 'red')] }, [
    { id: '1', verdict: 'drop', reason: 'the caller checks for null first' },
    { id: '2', verdict: 'yellow', reason: 'only an admin page' },
    { id: '3', verdict: 'keep', reason: 'holds' },
  ]);
  expect(out.findings.map((x) => [x.note, x.color, x.downgraded ?? null])).toEqual([
    ['softer', 'yellow', 'only an admin page'],
    ['stays', 'yellow', null],
    ['unjudged', 'red', null],
  ]);
  expect(out.dropped).toEqual([{ note: 'gone', file: 'src/a.ts', lines: '3-4', reason: 'the caller checks for null first' }]);
});

test('dangerous comes down to careful when no red finding survives, and stays when one does', () => {
  const both = { verdict: 'dangerous', findings: [f('a', 'red'), f('b', 'red')] };
  const none = applyHuntVerdicts(both, [{ id: '1', verdict: 'drop', reason: 'r' }, { id: '2', verdict: 'yellow', reason: 'r' }]);
  expect([none.verdict, none.verdict_moved]).toEqual(['careful', 'the red findings it rested on did not hold up']);
  expect(applyHuntVerdicts(both, [{ id: '1', verdict: 'drop', reason: 'r' }]).verdict).toBe('dangerous');
});

test('verifyHunt shows the skeptic each finding with the code at its lines, and skips the call when there are none', async () => {
  let seen = '';
  const file = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = await verifyHunt({ verdict: 'careful', findings: [f('off by one', 'yellow', '30-31')] }, { read: async () => file, ask: async (text) => ((seen = text), { verdicts: [] }) });
  expect(seen).toContain('## 1');
  expect(seen).toContain('yellow, bug: off by one');
  expect(seen).toContain('   30  line 30');
  expect(out.findings).toHaveLength(1);
  let asked = false;
  const empty = await verifyHunt({ verdict: 'safe', findings: [] }, { read: async () => null, ask: async () => ((asked = true), { verdicts: [] }) });
  expect([asked, empty.dropped]).toEqual([false, []]);
});

test('saidLines lists what was said in order, marks bots and outdated lines, leaves out CI reports and folded detail, and caps the length', () => {
  const c = {
    lines: [
      { id: 1, user: 'copilot-pull-request-reviewer[bot]', bot: true, body: 'Possible null deref.<details>long trace</details>', at: '2026-11-02T00:00:00Z', url: '', path: 'src/a.ts', line: 12, originalLine: 12, side: 'RIGHT' as const, replyTo: null },
      { id: 2, user: 'sam', bot: false, body: 'moved', at: '2026-11-03T00:00:00Z', url: '', path: 'src/b.ts', line: null, originalLine: 7, side: 'RIGHT' as const, replyTo: null },
    ],
    conversation: [
      { id: 3, user: 'pat', bot: false, body: 'LGTM once CI is green', at: '2026-11-01T00:00:00Z', url: '' },
      { id: 5, user: 'github-actions[bot]', bot: true, body: 'Playwright: 833 passed', at: '2026-11-01T01:00:00Z', url: '' },
    ],
    reviews: [{ id: 4, user: 'sam', bot: false, body: '', at: '2026-11-04T00:00:00Z', url: '', state: 'APPROVED' }],
  };
  expect(saidLines(c)).toBe(['- @pat: LGTM once CI is green', '- @copilot-pull-request-reviewer[bot] (bot) on src/a.ts:12: Possible null deref.', '- @sam on src/b.ts:7 (outdated): moved'].join('\n'));
  expect(saidLines({ lines: [], conversation: [], reviews: [] })).toBe('Nothing yet.');
  const long = saidLines({ ...c, lines: [] }, 10);
  expect(long).toBe('- …and 1 more, cut for length.');
});
