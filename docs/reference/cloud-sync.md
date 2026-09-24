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

**Primary path: let Walnut do it.** One-click cloud setup provisions the box,
waits for it to boot, claims it, and configures this remote for you — including
the `chmod 600` and the first verification push. Two entry points, one
resumable job behind both (`/api/cloud-setup`, driven by
`src/core/cloud-setup/job.ts`):

- **Settings → Cloud Companion** — the wizard.
- **Ask your Personal AI**: "set up my cloud companion" routes to the shipped
  `setup-cloud-companion` skill.

The claim step is what mints the device token: the box boots holding a one-shot
setup token, and `POST /api/v1/setup/claim` trades it for the long-lived device
token that ends up in the remote URL below. After that, the only manual step
left is scanning the pairing QR for your phone.

The rest of this section is the **manual equivalent**, useful for a box you
provisioned yourself, for re-pointing an existing remote, or for understanding
what the automated path produced.

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

## The companion as an exec host

A provisioned companion also runs sessions itself, through its own loopback
session daemon (cloud exec, `src/core/cloud-exec.ts`), so the phone can start
and continue work while the Mac is asleep. `scripts/cloud/setup.sh` runs
`scripts/cloud/ensure-harness.sh` on every deploy. That script is idempotent
and converges the box to:

- **`/var/lib/walnut/.claude/settings.json`**, written only when absent, with
  `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION` set to the Bedrock region.
  Claude Code signs in to Bedrock with the EC2 instance role through the
  default AWS credential chain. There is no Bedrock proxy on the box, and no
  key or token is copied to it. The Bedrock region defaults to `us-west-2` and
  does not depend on the region the box runs in. The file is only written when
  the box has an instance role (asked through IMDSv2); off AWS there is nothing
  for it to point at, so it is skipped.
- **Claude Code** for the `walnut` user, version 2.1.280 or newer. The native
  installer puts it in `~/.local/bin` and keeps it updated;
  `npm install -g @anthropic-ai/claude-code` is the fallback. It is always
  installed, whatever the default engine is, because Walnut's own chat lanes
  run on it. Nothing in the `walnut` home is linked into `/usr/local/bin`: such
  a link would put a file that user can rewrite on root's PATH, and Walnut
  finds `~/.local/bin` by itself. A stale `claude` earlier on the PATH is reported,
  since it would run instead.
- **The default engine's CLI**, when that engine is not claude. codex, gemini,
  opencode, pi and dsh come from `npm install -g` (`@openai/codex`,
  `@google/gemini-cli`, `opencode-ai`, `@earendil-works/pi-coding-agent`,
  `@deepseek-ai/dsh`); goose comes from its official download script into
  `~/.local/bin`. `custom` has nothing to install. When the box's node is
  older than the package's own floor (pi needs 22.19 or newer), the CLI is not
  installed and not made the default; the summary says so, and node is never
  upgraded for you. The engine's own login or API key is not set up for you:
  sign it in on the box (`sudo -u walnut -H <cli>`).
- **A systemd drop-in**, `walnut.service.d/harness.conf`, with
  `SHELL=/bin/bash`. The service user keeps its nologin shell; the daemon
  spawns the CLI through `$SHELL`, so the unit needs a real one.
- **`config.yaml` keys**, each one only when absent:
  `cloud.exec.enabled: true`, `cloud.exec.cwd_roots: [/var/lib/walnut/work]`
  and `defaults.engine`. A key you already set, comments included, is never
  changed. Cloud exec is only switched on once Claude Code is installed and
  has a credential: the instance role, a `settings.json` you wrote yourself,
  or a `claude` login (`sudo -u walnut -H claude`). Until then the box stays a
  relay, and the summary says what is missing; run the script again after
  fixing it.

The script never restarts the service (`setup.sh` does, at its end). Each run
ends with a one-line status per item; `--dry-run` prints the plan and changes
nothing. Installers are bounded by a 10-minute timeout, and a failure never
stops first boot: the box comes up as a relay and the next run retries.

**The code tree is root's.** `/opt/walnut` (including `.git` and
`node_modules`) is owned by root and only readable by the `walnut` user. That
user runs agents, and root runs code from this tree on every deploy: git, npm
lifecycle scripts, the build, `ensure-harness.sh`. If the service user could
write it, a prompt-injected agent could plant a git hook, an `fsmonitor`
command, a `.npmrc` or a `node_modules/.bin` file and get root on the next
deploy. A link in the tree counts by what it resolves to: one out to the
service home, to something the service user owns, or to a name that does not
exist yet is treated the same way.

The server keeps running on a package it cannot write. Plugin bundles and the
daemon binary archive go under the data dir instead of next to the code.
Skills that ship with Walnut cannot be edited or deleted there: both answer
409 with the reason (edit them on your primary Mac; disable one to turn it
off). No copy is made in the data dir's `skills/`, because that dir syncs to
the Mac, where the copy would hide every later release of the shipped skill.
One other thing does not work there: the server's own
`npm rebuild` of a native module that fails to load, which is why `setup.sh`
and the deploy check `better-sqlite3` at build time.

`setup.sh`, the deploy and `ensure-harness.sh` all check the tree before root
runs anything from it. A tree someone else can write is never taken back and
built on in place: taking it back (`chown`) erases the only evidence, and then
nothing tells whose `.npmrc`, `node_modules` or `.git` it holds. The finding
goes into `/root/.walnut-code-tree-exposed` (root only) first, and
`ensure-harness.sh` stops there. While that file exists `setup.sh` refuses to
run, and the deploy builds a fresh clone next to the live tree, swaps it in (then restarts) only once it
builds, and removes the file only after that swap. A failed rebuild keeps the
old tree serving and the file in place, so the retry takes the same path. By
hand: move the old tree aside (`chmod 700` it), clone fresh into `/opt/walnut`,
delete the file, and run `setup.sh` from the new tree. The first-boot script
does the same by cloning fresh. Before any git command in an old tree, the
deploy also refuses a `.git` holding hooks, replace refs, borrowed object
stores (`objects/info/alternates`) or config keys a clone does not write.

**`/etc/walnut` is root's too.** The directory is `root:walnut 0750`;
`walnut.env` (secrets from SSM) is root's `0600`, read only by systemd. The
pairing code cloud-init leaves in `/etc/walnut/setup-token` is handed to the
service user, which writes its own copy into `/etc/walnut/claim/` (`walnut
0700`, the one place the server writes: it deletes the spent code after a
claim), and root's copy is removed. Root never writes by path inside a
directory the service user can write: files are written to a temp file and
renamed over the name, the hub repo's hook is written by the service user
itself, and every command run as that user gets a session of its own with no
terminal (so it cannot type into, or read from, a root shell it was started
from).

**Which engine.** One-click setup reads the default engine you chose in
Settings on this machine when the job starts, and passes it to the box
together with the Bedrock region (the `/api/cloud-setup/start` body takes an
optional `bedrockRegion`). A hand deploy of the CDK app takes
`-c engine=<id>` and `-c bedrockRegion=<region>`, which default to `claude`
and `us-west-2` (see [`infra/README.md`](../../infra/README.md)). An engine
the box's checkout does not know yet (a newer release on the Mac) is dropped
with a warning, and the box falls back to its own default.

**Changing the engine later.** On the box, as root: set `defaults.engine` in
`/var/lib/walnut/.open-walnut/config.yaml`, then run
`bash /opt/walnut/scripts/cloud/ensure-harness.sh` (with no `--engine` it reads
that key and installs the CLI), then `systemctl restart walnut`.
`--engine <id>` installs a CLI without touching a `defaults.engine` that is
already set. A deploy that only pulls new code and restarts the service does
not run the script, so run it by hand after such a deploy if the harness
changed.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Authentication required` | Missing/invalid device token in the remote URL — check `git -C ~/.open-walnut remote get-url cloud`, re-set it with a valid token |
| Repeated "Keychain Not Found" dialogs | A credential helper is configured for the repo — remove it: `git -C ~/.open-walnut config credential.helper ""` (empty value also masks system-level helpers) |
| `403` / receive-pack refused | `http.receivepack` unset on the hub repo — re-run `scripts/cloud/setup.sh` |
| `404 data hub repo not found` | `WALNUT_GIT_HUB_DIR` mismatch or bare repo missing on the box |
| Push hangs / resets | Check Caddy is proxying `/git/*` (it proxies everything to :3456 by default) |
