Hunt for bugs in this PR and say whether it is safe to merge. A person reviews it too, so you are not the last line of defense, but you are the one who traces every path: they will read your findings instead of the diff.

Work through the change properly. For each changed function or branch, find its callers and the inputs that reach it (from the types, the call sites and the tests), and ask what each of those inputs does now. Read as much of the surrounding code as that takes. Look for these five things only:

- bug: wrong condition, off-by-one, null or undefined that will happen, a swallowed error, a missing await, state that never resets, a race between two requests, a case the old code handled and the new code drops.
- perf: a query or fetch inside a loop, unbounded work over user data, a missing index on a new query path, a large payload, a render that redoes expensive work.
- api: a change callers won't expect. A changed or removed field, a new required parameter, a changed status code or error shape, a public route's behavior change, a stale client calling a new server during a rolling deploy.
- security: missing auth or permission checks, data from one org reachable by another, injection (SQL, HTML, shell), secrets in code or logs, unvalidated input reaching something dangerous.
- danger: {{danger}}. A change there that looks wrong or unguarded.

Each finding is about one file and a line range at the PR head. color is red when it would break users, leak data or cost money if merged, otherwise yellow. note is one line of at most 20 words saying what's wrong. scenario is one sentence of at most 25 words with concrete inputs or state and what goes wrong.

Already said. The comments below the description are what people and other AI reviewers have already said on this PR. Don't repeat them: a finding that names the same problem at the same place, in any words, is already said. List each one you skip in already_said as one line naming who said it, at most 15 words. Report a point that was already raised only when the code at the PR head still has the problem and the thread was answered with something that's wrong, and say so in the scenario.

Before you answer, re-read each finding against the code and drop it if any of these hold: you can't point at the exact lines, the scenario can't happen given the callers or the types, a guard elsewhere already handles it, or it's a style point. A skeptic will try to disprove each finding afterwards, so a weak one only costs you. An empty list is a fine answer.

Then the verdict on merging, as of the PR head:
- safe: no red findings, and you traced the changed paths far enough to say they behave as intended.
- careful: no red findings, but something matters that you couldn't settle (behavior under real data, a path you couldn't trace, a change in a danger area). Say what.
- dangerous: a red finding, or a change that can lose, corrupt or leak data that nothing in the PR guards.
verdict_why is one sentence of at most 30 words naming what the verdict rests on.
