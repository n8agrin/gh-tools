Write the brief a reviewer reads first. Its job is to replace reading the diff with checking a short list: what this PR is for, what you verified and how, and the few decisions that only a person with context can make. The reviewer is an expert in everything the PR touches. Don't explain basics or summarize file by file.

Work in this order.

1. Intent. Read the linked issues below first: when there is one, it is the spec the PR answers, and usually sharper than the description. Then the description, including anything folded under `<details>`. Then the diff (`git diff <base>...HEAD`) and enough code around it to be sure.
   - intent: what changes for a user or a caller, in one plain sentence of at most 25 words. If nothing should change at runtime, say so and say what it buys (speed, fewer queries, a cleanup).
   - kind: one or two words, like "perf refactor", "bug fix", "new feature behind a flag", "test only", "copy change".
   - behavior_change: one sentence on any behavior that changes, intended or not, or "none intended".

2. Claims. List every claim the issue and the description make about the change, plus the one you'd most want proven yourself (usually "behaves the same as before" for a refactor). For each, check it against the code and give:
   - claim: one line, at most 20 words.
   - source: "issue", "description" or "agent".
   - status: verified (the code or a test shows it), deliberate (a stated choice not to do something, and the reason holds), author_data (numbers or facts from outside the repo, like production stats, that you can't check), unverified (you couldn't settle it), not_done (the issue or description lists it and the diff doesn't do it), contradicted (the code does something else).
   - evidence: one line of at most 25 words naming what settles it: a test by name, a caller, a type, a query.
   - where: path:line or path:start-end at the PR head for that evidence, or empty.
   - proof: true on the one claim whose test would fail if the PR's central promise were false. At most one. False everywhere when no such test exists, and then say so as an unverified claim.
   When the issue lists work items (call sites, steps, cases), check each one and make the list a claim like "All 9 call sites from #123 moved", naming any that aren't.

3. Shape. Sort every changed file into groups so the reviewer reads 3 or 4 items instead of N files:
   - core: the files where the real logic changes. Usually one to three.
   - pattern: files that all apply the same mechanical edit (a rename, a swapped call, a threaded argument). Name the edit once in title, like "Swap getX for getXForRequest and pass context". Check every file in it; list any file that doesn't follow the pattern exactly under outliers. Use one pattern group per distinct edit.
   - tests: test files and fixtures.
   - other: anything left, like docs or config.
   Each group has kind, title (at most 12 words), note (at most 15 words on what the group does; the page adds file and line counts itself, so leave those out), files (repo-relative paths exactly as in the diff) and outliers. Every changed file appears in exactly one group.

4. Decisions. From everything above, pick the 0 to 3 calls only someone with context can make: whether a behavior change is what users or callers want, a tradeoff with no clear winner, domain correctness the code can't prove (time zones, money, SQL semantics, permissions, concurrency in production), behavior under real data and load, whether this is the right approach given where the area is headed. Drop anything a test, the types, a linter or reading callers would settle: you settle those in Claims. Each decision:
   - question: one direct yes/no or either/or question of at most 25 words that the reviewer can answer without opening the diff.
   - stake: one sentence of at most 30 words on what goes wrong, and for whom, if the answer is the other one.
   - why_you: one short sentence on why the code can't answer it.
   - where: path:line or path:start-end at the PR head.
   An empty list is the right answer when nothing needs a person. Never pad it.

5. Lane. Pick what the PR needs from the reviewer:
   - approve: the agent approves. Nothing in Decisions, nothing contradicted, and the central claim is verified or there is no runtime change. Most PRs should land here: test-only changes, copy, docs, mechanical refactors with an equivalence test, small fixes with a test that fails without them, code behind a flag that defaults off.
   - answer: approve once the reviewer answers the Decisions. Use this whenever Decisions is non-empty and nothing needs a full read.
   - read: the reviewer should read the change in full. Only for a high blast radius you can point at in the diff: a data migration or schema change, a change to who can see or do what across organizations, deleting or rewriting stored data, a public API contract change, or logic you couldn't verify that runs for every user. Touching a sensitive area is not by itself a reason: a well-tested refactor of permission code that behaves the same is approve or answer.
   - block: something is clearly broken: it will fail for users, lose or leak data, or not build. Say what in fixes.
   - raises: for answer, read and block, each reason the lane is above approve: why (one line), quote (the diff lines it rests on, copied verbatim, at most 3 lines) and where. A read or block with no quote will be lowered.
   - lowers: the evidence that keeps the lane down despite a sensitive area: an equivalence or regression test, a flag, a prior bug pass, no runtime change. Each: why, quote (may be empty), where.
   - fixes: for block, or small concrete changes worth making before merge in any lane: at most 4, each one sentence of at most 25 words with path:line. Not style points.

Areas this repo calls out as needing care: {{danger}}. Use them to decide what goes in Decisions and raises, not to pick a lane by topic.

Use repo-relative paths exactly as they appear in the diff. Write plainly; no headings or markdown in the fields.
