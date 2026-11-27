// What the worker hands back, as JSON in $GH_RUNNER_RESULT. The runner turns it into labels and
// one comment; gh-review reads the same fields off that comment later.
export interface Result {
  /** done: the work is committed. blocked: it needs an answer from you first. */
  status: 'done' | 'blocked';
  /** Two or three sentences on what changed, or what it got stuck on. */
  summary: string;
  /** For blocked: the one question, answerable in a sentence. */
  question?: string;
  /** Review findings it fixed, as a count. */
  fixed?: number;
  /** Review findings it left, each with why. */
  skipped?: { finding: string; reason: string }[];
  /** What it could not check, like a flow that needs a browser. */
  unverified?: string[];
  /** Test commands it ran, and whether they passed. */
  tests?: { command: string; passed: boolean }[];
  /** Calls it made on its own where the issue left room. */
  assumptions?: string[];
  /** For a bug: the test that fails without the fix and passes with it, with both runs. */
  proof?: { test: string; command: string; red: string; green: string };
  /** For a bug no test can show: why. */
  noTest?: string;
}

/** The instructions every worker prompt ends with, whatever the repo's own prompt says. */
export const RESULT_INSTRUCTIONS = `
## Rules for this run

You are running unattended for gh-runner. Nobody will answer a question mid-run.

- Work on the branch you are on. Commit as you go. Do not push and do not open a PR: the runner does both.
- If a question would change the fix materially, stop and ask it through the result file below instead of guessing. Otherwise pick the most reasonable reading and list it under assumptions.
- Before you finish, write your result as JSON to the file named in $GH_RUNNER_RESULT, with this shape:

  {"status": "done" | "blocked", "summary": "...", "question": "... (blocked only)",
   "fixed": 0, "skipped": [{"finding": "...", "reason": "..."}],
   "unverified": ["..."], "tests": [{"command": "...", "passed": true}], "assumptions": ["..."]}

A run that ends without that file is treated as failed.
`;

/** Exported for tests: reads a result, refusing anything that isn't one. */
export function parseResult(raw: unknown): Result {
  const r = raw as Result;
  if (!r || (r.status !== 'done' && r.status !== 'blocked')) throw new Error('result has no done or blocked status');
  if (typeof r.summary !== 'string' || !r.summary.trim()) throw new Error('result has no summary');
  if (r.status === 'blocked' && !r.question?.trim()) throw new Error('blocked result has no question');
  return r;
}

const OPEN = '<!-- gh-runner:result ';
const CLOSE = ' -->';

/** The result as a hidden line a PR description carries, for gh-review to read back. `--` can't
 * appear inside an HTML comment, so dashes are escaped; JSON reads - back as a dash. */
export const encodeResult = (r: Result) => `${OPEN}${JSON.stringify(r).replace(/-/g, '\\u002d')}${CLOSE}`;

/** The result a PR description carries, or null. */
export function decodeResult(body: string): Result | null {
  const at = body.lastIndexOf(OPEN);
  if (at < 0) return null;
  const end = body.indexOf(CLOSE, at + OPEN.length);
  try {
    return parseResult(JSON.parse(body.slice(at + OPEN.length, end < 0 ? undefined : end)));
  } catch {
    return null;
  }
}
