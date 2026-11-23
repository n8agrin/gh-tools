# gh-runner

Watches your `agent:ready` issues and hands each to Claude Code, then opens a draft PR that gh-review picks up. Bun, no dependencies, no server.

- GitHub is the state. Labels say where an issue is (`agent:ready` -> `agent:working` -> `agent:blocked`), the same labels gh-review's `agent` config uses. Local files under `~/.gh-runner` only hold what GitHub can't: run logs and session ids.
- Every GitHub call goes through `gh()` in `src/github.ts`, as the user.
- Only issues assigned to the user are picked up (`scope()`); keep it that way, since a label alone is something anyone with triage rights can add.
- The runner owns pushing and opening PRs. `claudeArgs()` denies `git push` and `gh pr` writes to the agent; keep that.
- The worker reports through a JSON file at `$GH_RUNNER_RESULT` (`src/result.ts`). A run without one failed.
- Comments the runner writes end with `MARK`, because on GitHub they're authored by the user too.
- `pick()` in `src/pick.ts` decides what starts. Keep it pure and tested.
- Settings live in `~/.gh-runner/config.json` (`src/config.ts`). `config.example.json` stays free of anyone's own repos.
- `bun test` runs offline. `GH_RUNNER_FIXTURE` swaps the GitHub search for a JSON file.
