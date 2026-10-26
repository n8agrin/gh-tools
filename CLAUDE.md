# tools

Nate's local tools, one Bun workspace per app under `apps/`. Each app has its own `CLAUDE.md`; read it before changing that app.

- `apps/gh-review`: local review queue for PRs where someone asked for Nate's review. `bun start` at the root runs it on port 4790.
- `apps/gh-review-ios`: the same queue as a native SwiftUI app. Open `GHReview.xcodeproj` in Xcode; `bin/test` runs the core tests.
- `apps/gh-stat`: weekly GitHub PR stats board. `bun run stat` at the root runs it on port 4747.

Keep apps independent. Only add a shared package under `packages/` once two apps actually need the same code.
