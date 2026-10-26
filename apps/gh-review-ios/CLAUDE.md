# gh-review-ios

Native SwiftUI port of `apps/gh-review`. iOS 18, Swift 6, Observation. Read `README.md` first.

- All GitHub access goes through `GitHubClient` in `GHReview/Core/GitHub.swift`. It sends GraphQL queries only. Never add a mutation or any call that writes to a PR.
- Keep `GHReview/Core/` free of SwiftUI and UIKit so `bin/test` can build it without Xcode.
- When the web app changes how the queue works (`apps/gh-review/src/github.ts`, `public/app.js`, `public/stacks.js`), port the rule into `Core/` and add a test in `Tests/`.
- Without Xcode, check the views compile by typechecking against the macOS SDK with small shims for the iOS-only modifiers.
