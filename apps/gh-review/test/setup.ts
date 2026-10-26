// Keep tests away from your real ~/.gh-review.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GH_REVIEW_HOME = mkdtempSync(join(tmpdir(), 'gh-review-test-'));
