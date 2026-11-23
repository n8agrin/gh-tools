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

Only open issues **assigned to you** in those repos are picked up, oldest first.

## Run it

From the repo root:

```bash
bun run runner:plan   # look once and say what would start; changes nothing
bun run runner        # keep watching
```
