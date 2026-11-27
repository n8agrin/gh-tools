// Route: what kind of work an issue is, read from its labels. A bug gets the red-then-green rules
// and has to show its proof; everything else is a change and is built to what the issue asks.
import type { Result } from './result';

export type Kind = 'bug' | 'change';

/** A bug when it carries one of the repo's bug labels, whatever their case. */
export const kindOf = (labels: string[], bugLabels: string[]): Kind => {
  const bug = new Set(bugLabels.map((l) => l.toLowerCase()));
  return labels.some((l) => bug.has(l.toLowerCase())) ? 'bug' : 'change';
};

/** Added to a bug's prompt, after the repo's own. */
export const BUG_RULES = `
## This issue is a bug: red, then green

1. Reproduce it first. If you can't, stop with status "blocked" and ask for what you'd need.
2. Write a test that fails because of the bug, before you touch the fix. Run it, keep the failing output, and commit the test on its own.
3. Fix the bug. Run the same command again and keep the passing output.
4. Put both runs in the result file as "proof": {"test": "the test file, as a path from the repo root", "command": "the exact command", "red": "the last lines of the failing run", "green": "the last lines of the passing run"}.

If no test can show this bug (a visual glitch with no test surface, say), leave "proof" out and set "noTest" to one sentence on why. Never weaken or delete an existing test to get to green.
`;

/**
 * Why a done bug's result isn't enough, or null when it is. The runner checks what it can without
 * trusting the agent: the proof names a test file the branch actually changed.
 */
export function proofProblem(r: Result, changed: string[]): string | null {
  if (r.noTest?.trim()) return null;
  const p = r.proof;
  if (!p) return 'a bug fix needs "proof" (a red run and a green run) or "noTest" with the reason';
  for (const k of ['test', 'command', 'red', 'green'] as const) if (typeof p[k] !== 'string' || !p[k].trim()) return `the proof has no ${k}`;
  if (!changed.includes(p.test.trim())) return `the proof names ${p.test.trim()}, which this branch doesn't change`;
  return null;
}
