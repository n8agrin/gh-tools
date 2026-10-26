# gh-stat

Local board of Nate's weekly GitHub numbers (PRs created, merged, reviewed, lines changed). Plain Node, no dependencies, no build step. `node server.js` serves it on port 4747.

- GitHub data comes from the `gh` CLI's GraphQL search in `server.js`, cached in `.cache.json` next to it.
- `checkouts.js` watches local checkouts to show which branch each is on.
