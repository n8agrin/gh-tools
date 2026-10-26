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
- `danger`: areas where a change needs a careful read. Check and Signal are told about them.
- `reviewedLabel`: a label that means someone already ran a bug pass. Leave it out if your team doesn't use one.
- `defaultRepo`: which repo a bare PR number means when you import one. Defaults to the first repo under `checkouts`.
- `browser`: the app to open GitHub links in, like `"Google Chrome"`. Defaults to your default browser.

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

- Bug pass: whether the PR has your config's `reviewedLabel` or a submitted Copilot review. With a label set and neither there, the page says to send it back to the author. The other checks still run.
- How this works: what changes in one sentence, then the flow in 2 or 3 steps with links to the code.
- Reading guide: minutes to spend, every changed file in reading order with a color and a one-line note, and up to 6 notes on specific lines (spots to check and untested behaviors).
- Description vs change: gaps between what the description says and what the diff does, and UI changes with no screenshots.
- Check: a light pass for obvious bugs, performance gotchas, surprising API changes, high-level OWASP issues and changes in the danger areas from your config (`danger`; by default auth, billing, migrations and the public API). Each finding names a file, a line range and a failure scenario, shows under its file, and a red one turns the PR red.
- Signal: green (approve if CI passes), yellow (skim) or red (read it all), with a one-line reason. Any changed non-test file matching a path under `red` in your config makes the PR red before the AI is asked, and the AI can only raise the color. Green only stands when the change sits behind a flag that defaults off with all changed code inside it, or changes nothing at runtime. Press `g`, `y` or `r` on the PR page to set your own color; it's saved locally and shows in the queue.
- Taste: questions for the author through three lenses (consistency, simple first, right-sized fix), each on the file and lines it's about and backed by links to prior art in the repo. A second, skeptical `claude -p` pass reads the cited code on both sides and drops comparisons where the prior art doesn't do the same job.
- Optional checks you add yourself, off until you tick them for a run, like your own bug finder (below).

The PR page follows the PR Page v3 design. A checklist on the left holds the brief, then the files to read in full, then the ones to skim, with the routine files hidden until you ask. The brief has the purpose, the risk with its numbers and a map of the diff, the description next to its gaps, how the change works and the taste questions. Each file opens on its own with the run's notes and its diff, notes sitting under the line they're about. `j`/`k` move through the list, `space` ticks off what you're on and opens the next unread item, `n` jumps to the next unread one, `b` goes back to the brief, `[`/`]` move between PRs, `s` shows a file's diff side by side and `t` switches dark and light. Under each file name is a plain link to that file in the PR on GitHub. In the run's Options you can tick any steps and press Run selected to redo just those, keeping the rest of the run; each brief section also has its own Rerun. What you've ticked is saved in the browser per PR. When everything is ticked, a finish screen offers GitHub, done and Claude.

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
