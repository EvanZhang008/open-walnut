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
  flow in `docs/api-v1.md`). The endpoint accepts it as `Bearer` or as the
  **password** half of HTTP Basic — the git CLI's native scheme. The username
  is ignored (use anything, e.g. `walnut`).
- Pushes require `http.receivepack=true` on the hub repo —
  `scripts/cloud/setup.sh` sets it during bootstrap.

## Mac-side setup

Add the cloud hub as a remote of the data repo:

```bash
git -C ~/.open-walnut remote add cloud https://<domain>/git/data
```

Then give git the device token as the password. Two options:

**Recommended — macOS keychain credential helper** (token stored encrypted in
the login keychain, never on disk in plaintext):

```bash
git -C ~/.open-walnut config credential.helper osxkeychain
git -C ~/.open-walnut push cloud main
# On first push git prompts:
#   Username: walnut          (any value — the server ignores it)
#   Password: <device token>
# The keychain remembers it; subsequent pushes/pulls are silent.
```

**Alternative — token embedded in the remote URL** (zero prompts, but the
token sits in plaintext inside `~/.open-walnut/.git/config`; acceptable only
because that file never leaves the machine and the token is revocable):

```bash
git -C ~/.open-walnut remote set-url cloud "https://walnut:<device-token>@<domain>/git/data"
```

Prefer the keychain helper. If a token ever leaks, revoke the device
(`walnut device revoke <name>`) and pair a new one.

## Day-to-day

```bash
git -C ~/.open-walnut push cloud main    # publish local data to the companion
git -C ~/.open-walnut pull cloud main    # pick up changes made on the companion
```

A push lands in the bare hub repo; its `post-receive` hook immediately
fast-forwards the companion's working tree (`/var/lib/walnut/.open-walnut`),
so the running cloud server sees new data within a second — no restart needed.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Authentication required` | Missing/invalid device token — re-enter it (`git credential-osxkeychain erase` then push again) |
| `403` / receive-pack refused | `http.receivepack` unset on the hub repo — re-run `scripts/cloud/setup.sh` |
| `404 data hub repo not found` | `WALNUT_GIT_HUB_DIR` mismatch or bare repo missing on the box |
| Push hangs / resets | Check Caddy is proxying `/git/*` (it proxies everything to :3456 by default) |
