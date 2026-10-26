# gh-tools

Small local tools for keeping up with GitHub pull requests. They run on your own machine and read GitHub through your `gh` login or a token. Each tool is its own app under `apps/`, and each one has its own README.

## The tools

- [gh-review](apps/gh-review/README.md): a local page that lists every open PR where someone asked for your review, across all repos, so you can go down the list fast. It can also run a read-only Claude review of a PR in a throwaway checkout. Runs on http://localhost:4790.
- [gh-review for iOS](apps/gh-review-ios/README.md): the same review queue as a native SwiftUI app for iPhone and iPad.
- [gh-stat](apps/gh-stat/README.md): a board of your weekly GitHub numbers (PRs created, merged and reviewed, lines added and removed) for the last 12 weeks. Runs on http://localhost:4747.

## Getting started

You need [Bun](https://bun.sh) and the [GitHub CLI](https://cli.github.com) logged in (`gh auth status`). Clone the repo and install from its root:

```bash
git clone https://github.com/n8agrin/gh-tools.git
cd gh-tools
bun install
```

Then from the root:

```bash
bun start       # gh-review on http://localhost:4790
bun run stat    # gh-stat on http://localhost:4747
bun run test    # run the tests
```

gh-review needs a small config file before review runs work. [Its README](apps/gh-review/README.md#setup) walks through the setup. The iOS app is built in Xcode; see [its README](apps/gh-review-ios/README.md).

## Layout

The repo is a Bun workspace with one app per folder under `apps/`. The apps don't share code, so each can be read and changed on its own.
