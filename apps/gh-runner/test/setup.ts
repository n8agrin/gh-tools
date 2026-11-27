// Keep tests away from your real ~/.gh-runner.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GH_RUNNER_HOME = mkdtempSync(join(tmpdir(), 'gh-runner-test-'));
