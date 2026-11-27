// Keep tests away from your real ~/.gh-review.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GH_REVIEW_HOME = mkdtempSync(join(tmpdir(), 'gh-review-test-'));
// The old state file src/db imports once on first load (test/db.test.ts). It has to exist before any test file loads the db.
writeFileSync(join(process.env.GH_REVIEW_HOME, 'state.json'), JSON.stringify({ skipped: { 'https://github.com/a/b/pull/9': '2026-09-01T00:00:00Z' } }));
