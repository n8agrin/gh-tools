# Running on a home box

gh-review and gh-runner can live on a machine that stays on, so your laptop can be closed and your phone can reach the queue. Nothing about the apps changes: gh-review still listens only on `127.0.0.1`, and a private network puts it on your other devices.

## What the box needs

- [Bun](https://bun.sh), the [GitHub CLI](https://cli.github.com) logged in as you (`gh auth status`), and Claude Code logged in (`claude -p hi` answers).
- This repo, with `bun install` run at its root.
- A clone of each repo you review or hand to the agent, plus `~/.gh-review/config.json` and `~/.gh-runner/config.json` pointing at them. Copy both files from your laptop and fix the paths.
- Any tokens your repos' own tooling needs, such as a `DEPOT_TOKEN`. Services don't read your shell profile, so put them in the `env` block of `~/.claude/settings.json`, where Claude's commands pick them up.

## Start the services

```bash
bun run services install     # writes a service per app and starts both
bun run services print       # shows what install writes, and changes nothing
bun run services uninstall
```

Each app restarts if it exits and starts again after a reboot. Logs go to `~/.gh-review/service.log` and `~/.gh-runner/service.log`. The services run with the `PATH` of the shell you installed from, so run `install` again after you move `gh`, `claude` or `bun`.

- **macOS** uses launchd agents, which run while you're logged in. Turn on automatic login, and in System Settings, Energy, keep the Mac from sleeping.
- **Linux** uses systemd user units. Run `sudo loginctl enable-linger $USER` once so they run while you're logged out.

After a `git pull`, restart them by running `install` again.

## Reach it from your phone

Install [Tailscale](https://tailscale.com) on the box and on your phone, both on your own tailnet, then on the box:

```bash
tailscale serve --bg 4790
```

That prints an `https://<box>.<tailnet>.ts.net` address that only your devices can open. Anyone who can open it can do everything gh-review can do as you, so don't use `tailscale funnel`, and don't bind gh-review to a public address.

From another device, links to GitHub open in that device's browser instead of the box's.

If you put a different proxy in front, it has to pass the `Host` header through unchanged (nginx: `proxy_set_header Host $host;`). gh-review only takes a button press from a page whose address matches the `Host` it was asked for, and `tailscale serve` keeps that header. A proxy that rewrites it to `localhost:4790` makes every button answer "refused a request from …".

## What doesn't work from another device yet

- Open on a Depot test box, and Run locally. Both start a tunnel or an app on the box and open it in the box's browser.
- Desktop notifications for new review requests, which need the tab open.
