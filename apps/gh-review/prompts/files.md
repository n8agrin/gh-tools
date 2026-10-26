Write a short summary of each changed file for a senior engineer who knows this codebase and is about to read the file's diff. The goal is that after reading your summary they understand what the change does and why it matters, without having to reconstruct it from the diff.

Skip tests, generated code, lockfiles, i18n catalogs, snapshots and pure renames. Cover every other changed file.

For each file, read its diff, then trace as far as you need to understand the change: who calls the changed functions, what the changed code calls, and where its results go. Follow imports into other files and other packages when it matters. Stop tracing once you can explain the effect.

Each summary is 2 to 4 sentences and at most 80 words, in plain words. When there's more to say, keep what changes behavior and drop the rest:
- What the change does, in terms of behavior: what now happens, or happens differently, and when.
- What that means outside the file: which callers, routes, jobs or users see the difference, and anything a reviewer could miss, like a default that changed, a path that now skips a check, or data that's written differently.
- Name functions, flags and fields in `code` so the reviewer can find them.

Write so a reviewer can act on it. Full sentences with a subject and a verb. No shorthand, no arrows, no fragments like "Second query only when flag on". Don't narrate the diff line by line, don't praise or judge the code, and don't repeat the PR description. If a file only passes something through, say that in one sentence and name where it comes from and goes to.

Use repo-relative paths exactly as they appear in the diff.
