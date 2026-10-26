---
description: Show the PRs waiting on my review and suggest which to take first
---

Run `bun run queue --json` at the repo root (it runs apps/gh-review) and read the result. List the PRs as a short table (repo#number, title, author, size, CI, how long I've been asked). Then recommend the two or three to review first and say why in one line each: small and green goes first, anything I was asked for by name beats a team request, and a PR I've been waiting on longest breaks ties. Don't open or change anything on GitHub.
