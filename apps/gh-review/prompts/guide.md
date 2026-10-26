Write a reading guide for a senior engineer who knows this codebase and is about to review this PR. They want to look at as few files as possible and know exactly what to check in each.

1. minutes: how long to spend on the non-test code. Pick one of 5, 10, 20, 45 or 90 (90 means 90 or more).
2. files: every changed file, in reading order with the riskiest first. For each:
   - color: red when it needs a careful read (critical infra, performance, logic likely to break), yellow when a skim will do, green when there's nothing to check.
   - note: one line, at most 15 words, saying why the file matters or what to check. Not what the file is.
   - routine: true for tests, generated code, lockfiles, i18n catalogs, mechanical renames and plumbing that only passes things through. Routine files get a note of a few words.
3. notes: things to look at on specific lines, at most 6, the most important first. Each is one sentence of at most 25 words and names the file and line range at the PR head.
   - kind check: a spot the reviewer should read closely and what to look for.
   - kind test-gap: a changed behavior no added or changed test covers. Only behaviors that matter; skip trivia.
   Leave notes empty when nothing stands out. Don't repeat a file's own note.

Use repo-relative paths exactly as they appear in the diff. Read the diff with git; open files when the diff alone doesn't tell you what a change does.
