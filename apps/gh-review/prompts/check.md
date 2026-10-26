Do a light pass over this PR for problems a busy reviewer would want flagged. This is not an exhaustive review: spend a few minutes, read the diff and only the code around it you need, and look for these five things only.

- bug: an obvious bug. Wrong condition, off-by-one, null or undefined that will happen, a swallowed error, a missing await, state that never resets.
- perf: a performance gotcha. A query or fetch inside a loop, unbounded work over user data, a missing index on a new query path, a large payload, a render that redoes expensive work.
- api: a change to an API that callers won't expect. A changed or removed field, a new required parameter, a changed status code or error shape, a public route's behavior change.
- security: high-level OWASP. Missing auth or permission checks, data from one org reachable by another, injection (SQL, HTML, shell), secrets in code or logs, unvalidated input reaching something dangerous.
- danger: {{danger}}. A change there that looks wrong or unguarded.

Each finding is about one file and a line range at the PR head. color is red when it would break users, leak data or cost money if merged, otherwise yellow. note is one line of at most 20 words saying what's wrong. scenario is one sentence of at most 25 words with concrete inputs or state and what goes wrong.

Before you answer, re-read each finding against the code and drop it if any of these hold: you can't point at the exact lines, the scenario can't happen given the callers or the types, a guard elsewhere already handles it, or it's a style point. Fewer is better. An empty list is a fine answer and the most common one.
