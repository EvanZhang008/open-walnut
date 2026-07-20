# Cloud Data Sync — git smart HTTP over 443

How the Mac (source of truth) syncs its data repo (`~/.open-walnut`) with the
cloud companion box. The companion's security group only allows 443/80, so
sync rides **git smart HTTP** through Caddy — no SSH.

```
Mac ~/.open-walnut  ──push/pull https://<domain>/git/data──▶  Caddy :443
                                                                 │
                                                    Walnut server 127.0.0.1:3456
                                                    /git/data (git http-backend CGI)
                                                                 │
                                            /var/lib/walnut/git/walnut-data.git (bare hub)
                                                                 │ post-receive hook
                                            /var/lib/walnut/.open-walnut (working tree)
```

- Server endpoint: `src/web/routes/git-http.ts` (cloud mode only). It spawns
  `git http-backend` per request; the bare repo lives in
  `WALNUT_GIT_HUB_DIR` (default `/var/lib/walnut/git`), repo name fixed
  `walnut-data.git`.
- Auth: a **device token** (same one the iOS app / API uses, from the claim
  flow in [`api-v1.md`](api-v1.md)). The endpoint accepts it as `Bearer` or as the
  **password** half of HTTP Basic — the git CLI's native scheme. The username
  is ignored (use anything, e.g. `walnut`).
- Pushes require `http.receivepack=true` on the hub repo —
  `scripts/cloud/setup.sh` sets it during bootstrap.

## Mac-side setup

Add the cloud hub as a remote of the data repo, with the device token embedded
in the URL:

```bash
git -C ~/.open-walnut remote add cloud "https://walnut:<device-token>@<domain>/git/data"
chmod 600 ~/.open-walnut/.git/config   # token sits in this file — owner-only
```

The username half (`walnut`) is ignored by the server; the token is the
password half. This is the ONLY supported credential path for the sync:

- It works unattended — Walnut's auto-sync runs headless every 30s, so the
  credential must be readable without any prompt or keychain session.
- **Do NOT configure a credential helper (e.g. `osxkeychain`) for this repo.**
  Helpers add nothing here (the URL token always wins) but git still calls the
  helper's `store` action after every successful auth — on macOS that write
  triggers repeated "Keychain Not Found" dialogs from background sync
  processes that have no keychain session. Walnut's own git invocations
  neutralize helpers (`-c credential.helper=`) whenever the remote URL carries
  credentials, so a system-level helper (Xcode ships one) won't interfere.

The token never leaves the machine (`.git/config` is not synced) and is
revocable: if it ever leaks, revoke the device (`walnut device revoke <name>`)
and pair a new one.

## Day-to-day

```bash
git -C ~/.open-walnut push cloud main    # publish local data to the companion
git -C ~/.open-walnut pull cloud main    # pick up changes made on the companion
```

A push lands in the bare hub repo; its `post-receive` hook immediately
fast-forwards the companion's working tree (`/var/lib/walnut/.open-walnut`),
so the running cloud server sees new data within a second — no restart needed.

## Daemon bridge (live session talk)

Data sync (above) covers projections and notes. LIVE session interaction
(phone sends text into a running CLI session and streams its output) rides a
separate channel: each execution host's daemon dials OUT to the companion
over `wss://<domain>/bridge` and speaks its native RPC protocol there, so
sessions stay talkable while the Mac sleeps.

- **Zero config**: when the `cloud` git remote above exists, the Mac derives
  the bridge URL from it, mints a per-host **machine token** on the companion
  (`POST /api/devices` with `kind:"machine"`, using the remote's device
  token), and pushes `bridge.configure` to each daemon after its capability
  handshake (`src/providers/daemon-connection.ts`). The daemon persists
  `bridge.json` next to its registry and re-dials on its own after restarts.
- Machine tokens are scoped: valid ONLY for the `/bridge` upgrade, rejected
  on every REST route, `/ws`, and git-http. Revoke like any device
  (`walnut device revoke bridge-<host>`); the Mac re-mints on next connect.
- Opt out / override in `config.yaml`:

```yaml
cloud_bridge:
  enabled: false        # or:
  url: wss://other.example.com/bridge
```

- Cloud-side registry: `src/web/ws/bridge-registry.ts` (one connection per
  host, newer dial replaces older). Phone-facing endpoints:
  `POST /api/v1/sessions/:id/messages` + `GET /api/v1/sessions/:id/stream`
  (see [`api-v1.md`](api-v1.md)). `GET /api/v1/status` lists live `bridgeHosts`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Authentication required` | Missing/invalid device token in the remote URL — check `git -C ~/.open-walnut remote get-url cloud`, re-set it with a valid token |
| Repeated "Keychain Not Found" dialogs | A credential helper is configured for the repo — remove it: `git -C ~/.open-walnut config credential.helper ""` (empty value also masks system-level helpers) |
| `403` / receive-pack refused | `http.receivepack` unset on the hub repo — re-run `scripts/cloud/setup.sh` |
| `404 data hub repo not found` | `WALNUT_GIT_HUB_DIR` mismatch or bare repo missing on the box |
| Push hangs / resets | Check Caddy is proxying `/git/*` (it proxies everything to :3456 by default) |
