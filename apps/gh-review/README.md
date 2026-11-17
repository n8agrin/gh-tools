# gh-review

A local page that lists every open PR where someone asked for your review, across all repos, so you can go down the list fast. It reads GitHub through your `gh` login. A SQLite file at `~/.gh-review/gh-review.db` keeps a copy of the last fetch, so the page opens instantly and still shows the last good list if GitHub errors. It also holds the PRs you set aside and the Claude run history.

## Setup

You need [Bun](https://bun.sh), the GitHub CLI logged in (`gh auth status`), and the [Claude Code](https://claude.com/claude-code) CLI for review runs, chat and actions. Clone the repo and install from its root:

```bash
git clone https://github.com/n8agrin/gh-tools.git
cd gh-tools
bun install
```

Then copy the example config into your home folder and add your repos under `checkouts` (see Config below):

```bash
mkdir -p ~/.gh-review
cp apps/gh-review/config.example.json ~/.gh-review/config.json
```

In the copy, replace the `"owner/repo": "~/src/repo"` line under `checkouts` with each repo you review and the path to your clone of it, like `"your-org/your-repo": "~/src/your-repo"`. Keep the `checks` list as it is, since Run review only runs the checks your config lists.

## Running it

Run these from the repo root, or the same names from `apps/gh-review`:

```bash
bun start          # http://localhost:4790
bun run dev        # the same, restarting when the code changes
bun run queue      # the same list in the terminal (--json for scripts)
bun run demo       # sample data, no GitHub needed
bun test
```

`PORT` picks another port, like `PORT=4800 bun start`. `GH_REVIEW_HOME` moves the data folder away from `~/.gh-review`, and `GH_REVIEW_CONFIG` points at a config file somewhere else. When the server starts without a config it says so in the terminal and runs on the example.

## Config

Your settings live in `~/.gh-review/config.json`, outside the repo. Without one the app runs on [config.example.json](config.example.json), which has no repos, so Run review and chat won't work until you add yours under `checkouts`. The file is read on every request, so edits apply without a restart.

- `checkouts`: your clone of each repo, like `{"owner/repo": "~/src/repo"}`. Run review and chat need one, and each run gets its own worktree from it, so several PRs from one repo can be checked out at once.
- `checks`: the steps Run review runs. See "Your own bug finder" for adding your own.
- `actions`: commands bound to Shift plus a key in the queue.
- `red`: path patterns that make a PR red whatever the AI says, like `{"match": "^db/migrations/", "why": "migrations"}`.
- `danger`: areas where a change needs a careful read. Check and the brief are told about them.
- `reviewedLabel`: a label that means someone already ran a bug pass. Leave it out if your team doesn't use one.
- `defaultRepo`: which repo a bare PR number means when you import one. Defaults to the first repo under `checkouts`.
- `browser`: the app to open GitHub links in, like `"Google Chrome"`. Defaults to your default browser.

## Board

My PRs (`/mine`) has a Board link (`b`). On My PRs, `e` marks the selected PR done (or every PR picked with `space`), which clears it from the list until a new commit lands; `v` shows the done ones and `e` there puts one back. It's local only, nothing goes to GitHub, and the board still shows the PR.

`/board` shows your own open PRs as a kanban with one column per pipeline stage, left to right in the order a PR moves: Hunt (no bug pass on the current head yet), Fix findings (a bug pass ran and left findings), Undraft (a clean bug pass on the current head, CI green, still a draft), Waiting (on someone else), Ship (approved, CI green, nothing in the way), and last Blocked (red CI, a conflict, or changes requested), which is off the line until it's sorted. A bug pass is a finished review run on the PR's current head with a findings check in it, or the `reviewedLabel` on the PR. Nothing on the board is set by hand and cards don't drag: a stage comes from GitHub, so the button on the selected card is how a PR moves. `h`, `j`, `k` and `l` walk the cards, `Enter` opens the PR page, `o` opens GitHub, where merging and undrafting happen, and `⇧R` runs a review.

## Lanes and calibration

The queue shows each PR's lane once a review has run: `agent ok`, the number of questions waiting (`2 q`), `read` or `block`, faded when the PR has new commits since. The panel lists the questions. `l` cycles a filter through the lanes, and `⇧A` approves the selected PRs that are in Agent approves on their current commit, after a confirm that lists them. Each PR is checked again on the server, and your own PRs are never approved.

Every review you submit from the PR page or the queue is logged with its verdict and line comments. `/calibration` (`c` in the queue) puts each brief's lane next to what you did: approved clean, commented, or asked for changes, with approvals and change requests made on GitHub counted too. It shows agreement per lane, whether Agent approves has earned bulk approval (95% over at least 50 PRs, set in `src/server.ts`), and the PRs where the lane was wrong or too careful.

## Keys

`j`/`k` move, `Enter` (or a click) opens the PR's page in the app, `o` opens it on GitHub in your browser, `space`, `J` and `a` pick several PRs so the next action applies to all of them, `⇧R` runs a review, `x` sets it aside until it changes on GitHub, `e` marks it done, `u` undoes either, `s` cycles the sort (waiting longest, smallest, newest), `d` shows only PRs that asked you by name, `h` shows set-aside PRs, `v` shows Done, `/` filters (type a PR number or paste a PR link that isn't in the queue and press Enter to import it, say one that merged before you got to it), `n` turns on a desktop notification for new review requests while the tab is open, `r` refreshes, `t` switches dark and light, `[` and `]` move the side panel, and `?` lists every key.

Stacked PRs are grouped, bottom first. GitHub's own stacks show every layer, with the ones not asking you as quiet lines that say why (merged, you commented, not asking you). Older stacks are found by branch names. Each PR asking you still moves and sets aside on its own. Each row shows the repo and number, title, draft badge, author, whether you were asked directly or through a team, approval state, comment count, labels, lines added and removed, CI, and how long ago you were asked.

## Queue and Done

The queue holds open PRs that ask for your review, plus ones where you were asked by name and only left comments. GitHub clears the request after any review, but a comment isn't a finished review.

Done keeps the PRs you're finished with so you can find them again, newest first. A PR goes there on its own when your latest review approves or requests changes, and stays after it merges or closes. Press `e` to put one there by hand, and `e` again in Done to bring it back. A new review request after that sends it back to the queue. Review runs stay with the PR, so its page still shows them.

## Claude actions

`actions` in your config maps a key to a command that runs on the selected PR. Press Shift plus the key. `{url}`, `{repo}`, `{number}`, `{title}` and `{author}` are filled in. The example config has one, `⇧S`, which asks Claude for a short summary of the PR.

Runs happen in the background with `claude -p`; the row shows running, done or failed, and the output lands in `~/.gh-review/runs/`. Add any skill or shell command the same way.

## Run review

Each PR's page has a Run review button (or `⇧R`). Nothing runs until you press it. A run checks out the PR head in a throwaway `git worktree` of your own clone (paths under `checkouts` in your config), runs each check below through `claude -p` there, saves every step to SQLite as it finishes, and removes the worktree at the end.

- Brief: the first thing on the page, and a line in the sidebar. It reads the issues the PR closes as its spec, then gives:
  - A lane: Agent approves (nothing needs you; approve when CI is green), Answer questions (approve once you answer the decisions listed), Read it (a high blast radius it can point at in the diff) or Do not merge (something is broken). Most PRs should land on Agent approves. A Read it with no raise that quotes the diff comes down to Answer questions, and an Answer questions with no decision comes down to Agent approves. A changed file on a `red` path from your config, or a red Check finding, puts it at least at Answer questions. Why this lane lists each raise with the lines it quotes and each piece of evidence that kept it down.
  - The intent in one line, and any behavior change.
  - Your decisions: 0 to 3 questions only someone with context can answer, each with what's at stake and where to look, and buttons to approve, ask the author (fills the review summary with the question) or open the code. Nothing posts until you press Submit.
  - What the agent checked: every claim in the issue and the description, verified, deliberate, the author's data, unverified, not done or contradicted, with its evidence. The test that would fail if the central claim were false is marked Proof test.
  - Shape of the change: the files as a few groups (the core change, each repeated mechanical edit with any file that differs from it, the tests). Files in a pattern with no outliers move to Routine in the file list.
  Configs from before the brief have their `merge`, `signal`, `help` and `description` checks swapped for it automatically.
- Bug pass: whether the PR has your config's `reviewedLabel` or a submitted Copilot review. With a label set and neither there, the page says to send it back to the author. The other checks still run.
- How this works: what changes in one sentence, then the flow in 2 or 3 steps with links to the code.
- Reading guide: minutes to spend, every changed file in reading order with a color and a one-line note, and up to 6 notes on specific lines (spots to check and untested behaviors).
- Bug hunt (the `check` step): a full pass for bugs, performance gotchas, surprising API changes, security issues and changes in the danger areas from your config (`danger`; by default auth, billing, migrations and the public API). It traces each changed path through its callers, and ends on a verdict: safe to merge, merge with care, or dangerous to merge. It is told what people and other AI reviewers already said on the PR and leaves those points out, listing what it skipped. A second, skeptical `claude -p` pass tries to disprove each finding against the code: it drops what can't happen and takes a red finding that's real but less than breaking down to yellow, and a dangerous verdict whose red findings all went comes down to merge with care. Each finding names a file, a line range and a failure scenario, shows under its file and in the brief's Bug hunt section, and a red one puts the lane at least at Answer questions.
- Taste: questions for the author through two lenses. Duplicate finds code already in the repo that does what the PR's new code does, or blocks the PR repeats itself. Simpler shows the same behavior in less code or less surface. Each question sits on the file and lines it's about, links the code it rests on, and skips what's already been said on the PR. A second, skeptical `claude -p` pass reads the cited code on both sides and drops comparisons where the existing code doesn't do the same job, or where the simpler version doesn't behave the same. When a question suggests a code change, it comes with a short example: the code now, the code after, and what it replaces. The skeptic drops an example that doesn't match the code, and Add to review carries it into the comment as fenced code.
- Narration (optional): a spoken walkthrough written from the diff, not the description. It covers what the PR does, then each important file with why it matters and its risks. The brief's Listen section plays it all (press Write one there to run just this check), each file page plays that file's part, and `p` plays or pauses. It uses your browser's voices, so it costs nothing beyond the Claude run. On a Mac, the Premium and Enhanced voices from System Settings, Accessibility, Spoken Content sound best, and the voice menu lists them once they're installed. Turn on Follow along to open each file as the narration reaches it. If your config predates it, copy the `narrate` check from `config.example.json` into yours.
- Optional checks you add yourself, off until you tick them for a run, like your own bug finder (below).

The PR page follows the PR Page v3 design. A checklist on the left holds the brief, then the files to read in full, then the ones to skim, with the routine files hidden until you ask. The brief has the lane with your decisions, the risk numbers and a map of the diff, what the agent checked, the shape of the change, the description, how the change works and the taste questions. Each file opens on its own with the run's notes and its diff, notes sitting under the line they're about. `j`/`k` move through the list, `space` ticks off what you're on and opens the next unread item, `n` jumps to the next unread one, `b` goes back to the brief, `[`/`]` move between PRs, `s` shows a file's diff side by side and `t` switches dark and light. Under each file name is a plain link to that file in the PR on GitHub. In the run's Options you can tick any steps and press Run selected to redo just those, keeping the rest of the run; each brief section also has its own Rerun. What you've ticked is saved in the browser per PR. When everything is ticked, a finish screen offers GitHub, done and Claude.

Feedback for the author, right under the brief, lists every note the agents wrote in one place: bugs from the bug hunt (with its verdict), the brief's fixes, spots to verify, untested behaviors and taste questions. Add to review puts one straight into your pending review on its line (the nearest changed line when the note's own isn't in the diff). Each comment opens with **Generated by AI**, then Verify:, Untested:, Taste: or Fix: (a bug is just the bug), and you can edit it before you submit. Each note also sits under its line in the diff with an Add to review button. It opens a comment on that line with the note's text (and its prior-art link) for you to edit; once added it sits with your other pending comments and goes to GitHub only when you submit your review. Each one also has Useful and Noise. They stay on this machine, and adding a note to your review counts as Useful. /calibration shows the hit rate for each kind of note (bugs, security, duplicate code, simpler code), so a lens that stays noisy can be cut from the prompt.

Comment threads that put work off for later ("fine for now, but ideally…", "the right follow-up", "in a separate PR", TODO) get a Create follow-up issue button, and the brief lists them. Every other line thread has a quieter Make a follow-up issue link. Either opens a draft you can edit: a title taken from the sentence that names the work, and a body that links back to the PR and the thread and quotes the discussion. Nothing goes to GitHub until you press File issue and confirm; it's filed in the PR's repo with your `gh` login, and the thread then links to it.

Runs never write to GitHub. The claude runs are denied GitHub write tools, and `bin/readonly/gh` and `bin/readonly/git` sit first on their PATH, so `gh` can only read and `git` can't push or touch anything outside the worktree. Prompts live in `prompts/`; add a check by adding it to `checks` in your config.

## Your own bug finder

Any tool can be a check. Give it a `prompt` (a slash command like `/my-review {url}`, run through `claude -p`) or a `command` (any program, run in the PR's worktree, whose output becomes the step's result). Add `"optional": true` to keep it off until you tick it, and `"needs"` with a path, like the skill's file, to skip it on machines that don't have it.

Add `"findings": true` and the PR page lists what it found so you can pick findings and post them as one review on your own PRs. The tool writes them to the file named in `$GH_REVIEW_FINDINGS` (a Claude check is told the path and format for you):

```json
{"findings": [{"file": "src/a.ts", "line": 42, "title": "one line", "body": "what goes wrong and when", "severity": "important"}]}
```

```json
{"key": "bugs", "label": "Bug finder", "optional": true, "findings": true, "command": ["my-reviewer", "--pr", "{url}"]}
```

## Layout

- `src/github.ts` is the only code that talks to GitHub. Everything else goes through `fetchQueue()`.
- `src/config.ts` reads `~/.gh-review/config.json`, or `config.example.json` when you don't have one.
- `src/actions.ts` runs the per-PR actions from your config.
- `src/review.ts` runs Run review from your config's `checks` and `prompts/`.
- `src/db.ts` is the SQLite storage: cached PRs, set-aside PRs, Claude runs and reviews.
- `src/server.ts` serves `public/` and a small JSON API.
- `.claude/commands/` has slash commands that read the queue from Claude.
