import { expect, test } from 'bun:test';
import { decide, keepFindings, pathFloor, raise } from '../src/signal';

const red = [
  { match: 'billing', why: 'billing' },
  { match: '/db/migrations/', why: 'migrations or schema' },
  { match: '^services/query/', why: 'query generation' },
];

test('a red path sets the floor, and tests under it do not', () => {
  const floor = pathFloor(['services/query/src/Sql.kt', 'services/query/src/SqlTest.kt', 'e2e/page-objects/settings/billing-settings.ts', 'packages/ui/Button.tsx'], red);
  expect(floor).toEqual([{ file: 'services/query/src/Sql.kt', why: 'query generation' }]);
  expect(decide({ color: 'green', reason: 'tiny', no_runtime_change: true }, floor)).toMatchObject({ color: 'red', reason: 'Red: changes query generation' });
});

test('green needs a flag that defaults off with everything behind it', () => {
  const ai = { color: 'green', reason: 'new dialog behind export_v2', flag: 'export_v2', flag_defaults_off: true, all_behind_flag: true, no_runtime_change: false };
  expect(decide(ai, [])).toMatchObject({ color: 'green', reason: 'Green: new dialog behind export_v2' });
  expect(decide({ ...ai, all_behind_flag: false }, []).color).toBe('yellow');
  expect(decide({ ...ai, flag: '', flag_defaults_off: false }, []).reason).toBe('Yellow: not behind a flag that defaults off');
  expect(decide({ ...ai, flag: '', no_runtime_change: true }, []).color).toBe('green');
});

test('the AI can raise the color but an unknown answer reads as yellow', () => {
  expect(decide({ color: 'red', reason: 'Red: new query in a loop' }, []).reason).toBe('Red: new query in a loop');
  expect(decide({ color: 'purple', reason: 'odd' }, []).color).toBe('yellow');
});

test('Check findings need a changed file and lines, and can only raise the color', () => {
  const files = ['a/query.ts', 'b/ui.tsx'];
  const found = [
    { file: 'a/query.ts', lines: '40-52', color: 'red', note: 'Org filter dropped from the join.' },
    { file: 'b/ui.tsx', lines: '', color: 'yellow', note: 'no lines' },
    { file: 'c/other.ts', lines: '3', color: 'red', note: 'not in the PR' },
  ];
  const kept = keepFindings(found, files);
  expect(kept.map((f) => f.note)).toEqual(['Org filter dropped from the join.']);
  const yellow = decide({ color: 'yellow', reason: 'skim the UI' }, []);
  expect(raise(yellow, kept)).toMatchObject({ color: 'red', reason: 'Red: Org filter dropped from the join (query.ts)', raisedBy: 'Yellow: skim the UI' });
  expect(raise({ ...yellow, color: 'red', reason: 'Red: path' }, [{ ...kept[0], color: 'yellow' }]).reason).toBe('Red: path');
});
