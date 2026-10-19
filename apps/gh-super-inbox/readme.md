# GitHub Super Inbox

A Chrome extension for `github.com/notifications`. For every pull request in your inbox it shows why it's still there, highlights the ones that merged after you approved them, and gives you a one-click way to select those so you can mark them done.

## What it does

- Adds a badge to each PR row: `Merged · you approved`, `Merged · no review from you`, `Open · awaiting your review`, `Open · you approved`, and so on.
- Highlights a row purple when the PR is **merged with your approval**: it's merged, and your own latest review on it is an approval submitted before the merge.
- Adds a **Select merged with your approval** button next to GitHub's "Select all". It ticks the real GitHub checkboxes, so GitHub's own "Done" button works on them.

Only your own approval counts. A PR someone else approved that you never reviewed stays unhighlighted. If your approval was dismissed, or you later requested changes, it doesn't count either.

## Install

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
3. Click the extension's icon (or open its options page) and paste a GitHub token. `gh auth token` prints one if you use the `gh` CLI. Otherwise make a classic token with the `repo` scope, or a fine-grained one with Pull requests and Metadata read access.
4. Open `https://github.com/notifications`.

The token lives in the extension's local storage and is only sent to `api.github.com`. If your org uses SAML SSO, authorize the token for that org or those repos will show as unreadable.

## How it works

The content script finds every PR row on the page and asks the service worker for its status. The worker batches the whole page into one GraphQL query that fetches each PR's state, merge time, pending review requests, and only *your* reviews on it. Results are cached in `chrome.storage.local`: merged PRs for 7 days, closed for an hour, open for 2 minutes. The ↻ button re-checks the current page.

GitHub navigates with Turbo, so the script also re-runs when you page through notifications or change filters.

## Files

- `manifest.json` – MV3 manifest.
- `shared.js` – the classification logic, shared by the worker and the content script.
- `background.js` – service worker: token, GraphQL, cache.
- `content.js` / `content.css` – badges, row highlight, toolbar button.
- `options.html` / `options.js` – token setup.
- `scripts/make-icons.js` – regenerates the icons with `node scripts/make-icons.js`.
