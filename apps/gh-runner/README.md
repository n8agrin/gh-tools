# gh-runner

Turns an issue into a draft PR without you starting anything by hand. Label an issue `agent:ready` (or press Start agent on gh-review's Today page) and the runner picks it up.

## Setup

You need [Bun](https://bun.sh), the [GitHub CLI](https://cli.github.com) logged in, and Claude Code. Create `~/.gh-runner/config.json`:

```json
{
  "repos": {
    "owner/repo": { "checkout": "~/src/repo" }
  }
}
```

- `repos`: where to take issues from, and your clone of each. `base` sets the branch work starts from (default `main`).
- `ready`, `working`, `blocked`: the labels, defaulting to `agent:ready`, `agent:working` and `agent:blocked`. Keep them the same as gh-review's `agent` config.
- `cap`: how many issues may be working or blocked at once (default 5). Blocked ones count, since each still waits on you.
- `pollSeconds`: how often it looks (default 60).
- Per repo, `prompt` is the prompt file the agent gets (default `prompts/fix.md`; `prompts/deep-fix.md` runs `/nate-deep-fix-issue` then `/humanize`), and `worktree` is how to make the worktree, run in your checkout with `{path}`, `{branch}` and `{base}` filled in. For omni: `["bin/worktree-new.mts", "{path}", "origin/{base}", "-b", "{branch}"]`.
- `branchPrefix` (default `agent/`), `model` (passed on every run), `permissionMode` (default `auto`) and `silenceMinutes` (default 30: a run with no output that long is stopped).

Only open issues **assigned to you** in those repos are picked up, oldest first.

## Run it

From the repo root:

```bash
bun run runner:plan   # look once and say what would start; changes nothing
bun run runner        # keep watching
```

For each issue it starts, the runner swaps `agent:ready` for `agent:working`, makes a worktree on a new branch under `~/.gh-runner/worktrees`, and runs `claude -p` there with the prompt. The agent commits but can't push or open PRs; the runner does that. It pushes new commits every minute, and the first one opens a draft PR that says `Fixes owner/repo#N`, so the work is on GitHub from the start. When the agent ends:

- **Done**: the last commits go up, the PR description gets the summary, tests, assumptions and any review findings it left (plus the same as hidden JSON for gh-review), the issue gets a comment linking the PR, and the working label comes off.
- **Blocked**: its question as the first line of a comment, and `agent:blocked`, so it shows under Agents asking you on Today.
- **Failed** (no result, a crash, or `silenceMinutes` of silence): whatever it committed is pushed anyway, then the reason as a comment, and `agent:blocked`.

### Answering and restarts

Reply on a blocked issue and the runner picks the same Claude session back up with your reply, on the same branch and PR. Only comments from your own GitHub login count, and the runner's own comments are told apart by a hidden mark, since on GitHub they're yours too. A failed run resumes the same way, or swap `agent:blocked` for `agent:ready` to start a fresh session on the same branch.

If the runner stops mid-run (a restart, the laptop sleeping), the next start finds issues still labeled `agent:working` whose process is gone and resumes each session where it left off.

Each run's status, transcript and result are in `~/.gh-runner/runs/<owner>__<repo>__<number>/`.

Once an hour the runner looks at finished runs and removes the worktree of any whose PR has merged or closed, since each can hold gigabytes. A worktree with uncommitted changes is left alone, and the branch stays, so starting the issue again checks it back out.
