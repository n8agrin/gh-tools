# gh-review

Local review queue for PRs where someone asked for your review. Anyone should be able to run it with their own config. Bun, no build step, vanilla JS in `public/`.

- GitHub access goes through `fetchQueue()` in `src/github.ts`. Don't call `gh` from elsewhere.
- Local storage is `src/db.ts` (bun:sqlite, `~/.gh-review/gh-review.db`). The PR table is only a cache of the last fetch; GitHub stays the source of truth.
- Never write to a PR (review, comment, label) without an explicit key press or click from the user.
- Settings live in `~/.gh-review/config.json` (read by `src/config.ts`), not in the repo. `config.example.json` is the starting point and the fallback, so keep it free of anyone's own repos or skills.
- Per-PR Claude work belongs in the config's `actions`, or its `checks` plus `prompts/` for Run review, not in the server.
- Review runs are read-only against GitHub. Keep `bin/readonly/` first on their PATH and the write tools denied.
- `/mine` (My PRs) lists your own open PRs with its own cache and set-aside tables (`mine`, `mine_aside`). Keep it apart from the review queue: nothing it does should change what `/` shows.
- A check with `"findings": true` writes findings to `$GH_REVIEW_FINDINGS` (`src/findings.ts`). On your own PRs only, the PR page posts the ones you pick as one review, after a click and a confirm. Don't tie this to any one tool.
- `bun test` runs against `test/fixture.json`; regenerate it with `bun test/make-fixture.ts`.
