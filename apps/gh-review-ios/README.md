# gh-review for iOS

The review queue from `apps/gh-review` as a native SwiftUI app for iPhone and iPad. It lists every open PR where someone asked for your review, across all repos, and talks to GitHub directly with a token. It only reads from GitHub; there's no code that writes to a PR.

```bash
open GHReview.xcodeproj   # then run on a simulator or your phone
bin/sim                   # build and run in the simulator with your gh token, nothing to paste
bin/test                  # core tests, no Xcode needed
LIVE=1 bin/test           # also reads your real queue through `gh auth token`
```

Needs Xcode 16 or newer and iOS 18. On first launch it asks for a GitHub token: a classic token with `repo` and `read:org`, kept in the Keychain. To run on your own phone, pick your team under Signing & Capabilities.

## What's there

- Queue: the same list as the web app, oldest request first, drafts at the bottom, stacks grouped bottom first. GitHub's own stacks show the layers that aren't asking you as quiet lines that say why. The sort menu has the three sorts and "Asked me by name".
- Swipe right to mark a PR done, swipe left to set it aside until it changes on GitHub. Undo is in the toolbar. Set-aside PRs fold into one line at the bottom.
- Done: PRs you approved, asked changes on, or marked done, newest first. It fills itself from your reviews the same way the web app does.
- PR page: title, author, size, CI, status, bug pass (label or a Copilot review), branch, labels, the description and the files by size. Open on GitHub is in the toolbar.
- Pull to refresh, or come back to the app. The last good list stays on screen if GitHub errors.
- With a keyboard on iPad: `j`/`k` move, `e` done, `x` set aside, `o` opens on GitHub, `u` undoes, `v` switches Queue and Done.

Claude actions and Run review stay in the web app, since they need `claude` and your clones on the Mac.

## Layout

- `GHReview/Core/` has no UI: the GitHub queries, the queue rules (stacks, set aside, Done, sorts) and the local JSON store. `Package.swift` builds this folder alone so `bin/test` can run it.
- `GHReview/AppModel.swift` is the one `@Observable` model the screens read, plus the Keychain token.
- `GHReview/Views/` has the screens.
- `GHReview.xcodeproj` uses a synchronized folder, so new files under `GHReview/` show up in Xcode without editing the project.
