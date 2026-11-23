import { expect, test } from 'bun:test';
import { keepFindings, pathFloor } from '../src/signal';

const red = [
  { match: 'billing', why: 'billing' },
  { match: '/db/migrations/', why: 'migrations or schema' },
  { match: '^services/query/', why: 'query generation' },
];

test('a red path sets the floor, and tests under it do not', () => {
  const floor = pathFloor(['services/query/src/Sql.kt', 'services/query/src/SqlTest.kt', 'e2e/page-objects/settings/billing-settings.ts', 'packages/ui/Button.tsx'], red);
  expect(floor).toEqual([{ file: 'services/query/src/Sql.kt', why: 'query generation' }]);
});

test('Check findings need a changed file and lines', () => {
  const files = ['a/query.ts', 'b/ui.tsx'];
  const found = [
    { file: 'a/query.ts', lines: '40-52', color: 'red', note: 'Org filter dropped from the join.' },
    { file: 'b/ui.tsx', lines: '', color: 'yellow', note: 'no lines' },
    { file: 'c/other.ts', lines: '3', color: 'red', note: 'not in the PR' },
  ];
  expect(keepFindings(found, files).map((f) => f.note)).toEqual(['Org filter dropped from the join.']);
});
