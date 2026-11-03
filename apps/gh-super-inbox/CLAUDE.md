# gh-super-inbox

Chrome extension (Manifest V3) for `github.com/notifications` and PR Files changed pages. Plain JS with no dependencies and no build step: Chrome loads this folder as is, so don't add a bundler or a `package.json`.

- `background.js` is the service worker. It holds the token and makes every GitHub GraphQL call, so content scripts never talk to GitHub directly.
- `shared.js` holds the logic both sides use, including `isTestPath`.
- After a change, reload the extension on `chrome://extensions` and refresh the GitHub tab.
