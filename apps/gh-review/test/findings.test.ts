import { expect, test } from 'bun:test';
import { findingsReview, loadFindings, parseFindings, rightLines, saveFindings } from '../src/findings';

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ fn
 keep
-gone
+added
+added too
 keep
diff --git a/old.ts b/old.ts
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye`;

test('knows which lines GitHub can anchor a comment to', () => {
  expect([...rightLines(diff).get('src/a.ts')!]).toEqual([10, 11, 12, 13]);
  expect(rightLines(diff).has('old.ts')).toBe(false);
});

test('reads any tool\'s findings and drops the ones it can\'t place', () => {
  const f = parseFindings({ findings: [
    { file: 'src/a.ts', line: 11, title: 'Off by one', body: 'Skips the last row.', severity: 'important' },
    { file: 'src/a.ts', line: 99, title: 'Outside the diff' },
    { file: 'src/a.ts', title: 'No line' },
    { line: 3, title: 'No file' },
  ] }, diff);
  expect(f.map((x) => [x.id, x.title, x.inline])).toEqual([[1, 'Off by one', true], [2, 'Outside the diff', false]]);
  expect(parseFindings('nonsense', diff)).toEqual([]);
});

test('posts picked findings as line comments, and unanchored ones in the body', () => {
  const run = { reviewId: 4, key: 'bugs', headSha: 'a'.repeat(40), posted: [], findings: parseFindings({ findings: [
    { file: 'src/a.ts', line: 11, title: 'Off by one', severity: 'important' },
    { file: 'src/a.ts', line: 99, title: 'Outside the diff' },
    { file: 'src/a.ts', line: 12, title: 'Not picked' },
  ] }, diff) };
  const r = findingsReview(run, [1, 2], 'My bug finder');
  expect(r.comments).toEqual([{ path: 'src/a.ts', line: 11, side: 'RIGHT', body: '**important: Off by one**' }]);
  expect(r.body).toContain('My bug finder');
  expect(r.body).toContain('`src/a.ts:99` **Outside the diff**');
  expect(r.body).not.toContain('Not picked');
  saveFindings(run);
  expect(loadFindings(4, 'bugs')?.findings.length).toBe(3);
  expect(loadFindings(5, 'bugs')).toBeNull();
});
