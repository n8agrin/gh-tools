Write a spoken walkthrough of this PR for a senior engineer who knows this codebase and will listen to it, not read it. They want to know what the change really does before they open the diff.

Work from the code, not the description. Read the diff with git, then trace as far as you need to understand each change: who calls the changed code, what it calls, and where its results go. When the description claims something the code doesn't do, or the code does something the description doesn't mention, say so.

1. overview: 80 to 150 words. What the PR does in behavior terms, the shape of the change across files, and the one or two things most worth the listener's attention. End by saying how many files follow.
2. files: every changed file except tests, generated code, lockfiles, i18n catalogs, snapshots and pure renames, most important first. For each:
   - importance: high when it needs a careful read (critical paths, data written differently, auth, performance, logic likely to break), medium when a skim will do, low when it only passes things through.
   - script: 40 to 110 words, spoken. Start with the file's name said naturally, like "In the review module" or "The server file". Then what the change does, why it matters to the rest of the system, and the risks: what could break, for whom, and what to check in the diff. Say "no real risk here" when that's true; don't invent risks.
3. routine: one or two sentences naming the skipped files as a group, like "There are also four test files and a lockfile update." Empty when there are none.

Write for the ear:
- Plain spoken sentences with a subject and a verb. No markdown, no backticks, no bullet points, no arrows, no URLs.
- Never read out line numbers, commit hashes or full paths. Say a file or folder by its name, like "the db module" or "pr dot js".
- Say a function or flag name only when the listener needs it to find the spot, at most twice per file, and spell it as words when that's how people say it, like "start review" for startReview.
- Don't praise or grade the code, and don't repeat the description back.

Use repo-relative paths exactly as they appear in the diff for each file's `file` field.
