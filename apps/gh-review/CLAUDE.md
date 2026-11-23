# gh-review

Local review queue for PRs where someone asked for your review. Anyone should be able to run it with their own config. Bun, no build step, vanilla JS in `public/`.

- GitHub access goes through `fetchQueue()` in `src/github.ts`. Don't call `gh` from elsewhere.
- Local storage is `src/db.ts` (bun:sqlite, `~/.gh-review/gh-review.db`). The PR table is only a cache of the last fetch; GitHub stays the source of truth.
- Never write to a PR (review, comment, label) without an explicit key press or click from the user.
- Settings live in `~/.gh-review/config.json` (read by `src/config.ts`), not in the repo. `config.example.json` is the starting point and the fallback, so keep it free of anyone's own repos or skills.
- Per-PR Claude work belongs in the config's `actions`, or its `checks` plus `prompts/` for Run review, not in the server.
- Review runs are read-only against GitHub. Keep `bin/readonly/` first on their PATH and the write tools denied.
- `/mine` (My PRs) lists your own open PRs with its own cache, set-aside and done tables (`mine`, `mine_aside`, `mine_done`). Done there holds until a new commit lands; set aside until any change. Keep it apart from the review queue: nothing it does should change what `/queue` (the review queue) shows.
- `/` is Today (`src/today.ts`, `public/today.js`): one list built from the queue, My PRs, mentions and agent issues. It reads their caches and set-asides; it adds nothing of its own beyond the local slot.
- `/board` shows the same PRs as a kanban, one column per pipeline stage. The stage rules live in `src/stage.ts` and read only GitHub fields plus the review runs kept here; nothing on the board is set by hand, and cards never drag.
- A check with `"findings": true` writes findings to `$GH_REVIEW_FINDINGS` (`src/findings.ts`). On your own PRs only, the PR page posts the ones you pick as one review, after a click and a confirm. Don't tie this to any one tool.
- `bun test` runs against `test/fixture.json`; regenerate it with `bun test/make-fixture.ts`.
- `public/followup.js` spots threads that put work off and drafts a follow-up issue. The PR page files it in the PR's repo through `createIssue()` only after File issue and a confirm.
- The brief (`src/lane.ts`, `prompts/brief.md`) is the first thing on the PR page: a lane (Agent approves, Answer questions, Read it, Do not merge), the intent, the 0 to 3 decisions only you can make, every claim with its evidence, and the diff as a few groups. Most PRs should land on Agent approves. Code moves the lane both ways: a read with no quoted raise, or an answer with no decision, comes down; a red path or a red Check finding puts it at least at answer. Older configs' merge, signal, help and description checks become the brief in `upgradeChecks()`.
- Each review you submit is logged in `outcomes`; `/calibration` compares it with the lane. Bulk approve (`⇧A` in the queue, `/api/approve`) only approves PRs still in Agent approves on the head they were briefed on, after a confirm.
- Check (the bug hunt) and Taste run on every PR, even ones another AI reviewer already reviewed. Both get what's already been said on the PR (`saidLines()` in `src/hunt.ts`) and leave it out, and each has a skeptic pass that drops what doesn't hold. Nothing they find goes to GitHub unless you add it to your review. Useful and Noise marks on their notes live in `finding_ratings` and show as hit rates on `/calibration`.
