# gh-stat

A small local board of your weekly GitHub numbers: PRs created, PRs merged, PRs reviewed, and lines added and removed. It covers every repo your GitHub account can see, for the last 12 weeks, with the current week live.

## Run it

```
npm start
```

Then open http://localhost:4747. No install step; it only needs Node 18+ and a logged-in `gh` CLI.

## How the numbers work

- **Created**: your PRs, by the week they were opened.
- **Merged**: your PRs, by the week they merged.
- **Reviewed**: PRs by other people where you submitted a review (approve, comment, or request changes). A PR counts once in each week you reviewed it.
- **Lines added / removed**: additions and deletions on your PRs, counted in the week they merged.

Weeks start Monday at midnight, local time.

## Refreshing

The server pulls from GitHub's GraphQL search when it starts and every 5 minutes after that, and saves the result to `.cache.json` so a restart shows the last numbers right away. A refresh costs around 10 GraphQL points out of the 5,000 per hour you get. The page rereads the server every 30 seconds, and "Refresh now" forces a pull.

## Settings

Environment variables, all optional:

- `GH_STAT_LOGIN` – whose stats to show (default `n8agrin`)
- `GH_STAT_WEEKS` – how many weeks back (default 12)
- `PORT` – default 4747
- `GITHUB_TOKEN` – used instead of `gh auth token` if set

## Local checkouts

The top of the page lists each folder under `~/src`, with the branch it's on, uncommitted changes, ahead/behind counts, and your PR for that branch when there is one. It only runs read-only git commands (`status`, `log`, `remote get-url`) and updates the page as soon as git changes HEAD, the index or refs in one of those checkouts (a branch switch, commit, fetch or push). Uncommitted edits show up on the next 30-second poll. Change the folder with `GH_STAT_CHECKOUTS_DIR`, and set `GH_STAT_CHECKOUTS_PREFIX` to only list folders whose names start with it.
