import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a failed login lookup is tried again on the next call', async () => {
  // A stand-in gh that fails the first time it runs and answers after that. Bun.spawn reads PATH
  // once at startup, so the check runs in its own process.
  const bin = mkdtempSync(join(tmpdir(), 'gh-runner-bin-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ -e "${bin}/ran" ]; then echo me; else touch "${bin}/ran"; echo offline >&2; exit 1; fi\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const script = `import { viewer } from '${join(import.meta.dir, '../src/github.ts')}';
const first = await viewer().catch((e) => 'error: ' + e.message);
console.log(JSON.stringify([first, await viewer()]));`;
  const p = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  expect(JSON.parse(p.stdout.toString())).toEqual(['error: offline', 'me']);
});
