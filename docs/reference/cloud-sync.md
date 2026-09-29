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

## Bridge monitor (Mac)

A multi-day recorder for the Mac side of the daemon bridge, to find out why
it drops. Code in `scripts/bridge-monitor/`, tests in
`tests/scripts/bridge-monitor/`. macOS only.

**Install.** `scripts/bridge-monitor/install.sh` copies the scripts (and the
`ws` package) to `~/Library/Application Support/Walnut/bridge-monitor/app/`,
so edits in a working tree never change a running monitor, then loads two
LaunchAgents with `launchctl bootstrap gui/$UID`:

| Label | Runs | launchd policy |
|---|---|---|
| `dev.openwalnut.bridge-monitor` | the collector, all the time | `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 60`: restarted only after a crash, at most once a minute |
| `dev.openwalnut.bridge-monitor-summary` | the daily letter at 08:00 | `StartCalendarInterval`, no KeepAlive |

Re-running the script is safe (it reloads). `uninstall.sh` unloads and removes
the plists; `--purge` also removes the code copy and state, `--purge-all`
also the records and the local config. Both scripts refuse a record dir
(`BRIDGE_MONITOR_LOG_DIR`) that is not an absolute path ending in
`/bridge-monitor`, since one runs `chmod 700` on it and the other deletes it.
Never load these jobs with `launchctl submit`: a submitted job is KeepAlive
and relaunches forever.

Only one collector runs at a time (a lock in the state dir; a second one
exits 1). The lock is created complete and in one step, a stale one (dead
pid, or a pid now running something else) is taken over by renaming it
aside first, and a holder that `ps` cannot check counts as running, so the
next start tries again. The takeover has one known limit: two collectors can
both win only if three start at the same moment over a stale lock, and
launchd starts one. The heavy samples run as detached process groups so
a timeout can kill the whole tree, which also puts them outside launchd's
reach: the collector kills them on every exit path and lists each one in
`children.json` with its pid, its group, the second it started and its full
argv. The next start signals a listed group only when it can prove the
collector spawned it: the pid still leads its own group, started at the
recorded second, and runs the recorded argv, compared whole (for a
`nice`-wrapped command, also the argv `nice` execs into). It never signals
pid 1 or its own group. Any mismatch, an entry older than its own timeout
plus 2 minutes, or a `ps` that fails or times out leaves the group alone;
the entry is dropped and the start record says why. The state file is
written only when it changed and at most once a minute, plus at shutdown and
right after an alert or new bridge records.

**What it records**, change-only where it can, to
`~/Library/Logs/Walnut/bridge-monitor/YYYY-MM-DD.ndjson` (14 days kept; not
`/tmp`, which a reboot wipes, and not the data dir, which syncs):

- every 10 s: primary interface and router, `scutil --nwi`, interfaces with
  IPv4 (a `utun` there means a full tunnel VPN), the route actually used to
  reach the bridge host, Wi-Fi link state, power source, and gaps between
  ticks. A gap is a sleep when the kernel's last sleep and wake times
  (`kern.sleeptime`, `kern.waketime`) fall inside it. Wall clock minus the
  monotonic clock does not work here: Node's monotonic clock on macOS keeps
  counting while the Mac sleeps, so that measure read every sleep as zero and
  the first alerts called a sleeping Mac "down while awake";
- every 10 s: new bridge lines from the daemon logs and the SSH link lines
  from the server log (the daemon logs in `/tmp` die at reboot, so they are
  copied as they appear). Only an allowlist of fields is copied, the ones the
  classifier reads (the close record, dial time, silence), so a field a
  newer daemon adds, such as a session id, a working directory or a host
  alias, is never recorded; a message is stored as its fixed name, never its
  text, and an SSH host only as local or remote;
- every 60 s: load average, CPU idle, the collector's own CPU and memory;
- every 5 min: whether the public IP changed (one small HTTPS request to a
  plain text echo service, `publicIp.url`), whether the bridge host's DNS
  answer changed, and the Wi-Fi radio (channel, signal); the radio is also
  sampled on every drop. Neither address is stored: only a 4 hex digit HMAC
  fingerprint under a per-install key (`state/privacy.key`), enough to see a
  change and useless for recovering the address. Records and state written
  by older versions still held addresses and Wi-Fi names: the collector
  removes those fields once per scrub version, in place (version 2 also
  takes the Wi-Fi key names out of a net record's list of changed fields;
  version 3 cuts older daemon records down to the allowlist and SSH host
  aliases down to local or remote, in the store and in the state), and writes a `scrub` record with the counts (`scrub.mjs` does the same for
  copies kept elsewhere);
- every 15 min: the kernel's `tcp_connection_summary` for the daemon's
  sockets (close reason, RST and FIN counts, retransmits, RTT), merged by
  `so_gencnt`. The unified log keeps these for only about 2 hours (1 h 47 min
  measured on a busy Mac, less when more is logged), so this cannot be done
  later. The first sweep after an install reads back as far as the log goes;
- daily: sleep, wake and dark wake events from `pmset -g log`, and the clock
  offset from `sntp`.

Wi-Fi network names and BSSIDs are dropped when the tool output is parsed,
so no record or state file holds one or lists one as changed (since macOS 14.4 a process without
Location Services permission reads them as redacted anyway, and the monitor
never asks for it: asking pops a privacy prompt). Channel, band and signal
still show roaming.

**How drops are classified** (`lib/classify.mjs`):

| | Meaning | Evidence |
|---|---|---|
| M1 | reset or closed from the far side | the replica saw the close within 2 s, or the Mac kernel saw a peer reset or FIN, or the far end sent a close frame, with no Mac network change. Without a replica log this cannot tell the cloud from a middlebox on the way, and the letter says so |
| M2 | network path drop | the replica never saw the close, or the Mac's SSH links died at the same moment, or the Mac network changed, or the kernel gave up on the socket (a timeout, or a lost local address) |
| M3 | Mac asleep or in dark wake | a sleep across the drop, whether the daemon's silence watchdog or a plain close ended it |
| M4 | daemon restart | a deploy or reconfigure |
| M5 | silent while awake | the watchdog fired, the collector sampled the Mac awake through the whole silence, and the daemon's measured stall is too short to explain it (with no measurement, the letter says the stall is unknown); the Mac side cannot say where the traffic stopped |
| M6 | Mac daemon froze | the watchdog fired while the Mac was awake, and the daemon's own event-loop stall covers so much of the silence that the rest is under the 75 s limit: the stall alone tripped it |
| M? | no cause found yet | a close with no other evidence, a local abort (the kernel's `tcp_drop` with no error: a process on the Mac reset the socket), or a silence with no record of whether the Mac was awake |

"Awake" is shown, never assumed: a load sample at most 2 minutes apart
through the whole window, or a collector gap the kernel proves the Mac did
not sleep through. Samples on both sides are not enough, since a starved or
sleeping collector leaves a hole in the middle. On 2026-09-27 and 09-28, 7
of the 8 drops first filed as "silent while awake" were M6, at a load around
300.

A storm is more than `alert.maxDropsPer10Min` drops inside 10 minutes. The
letter also reports whether cloud-side drops cluster in one 20 s slot of a
5-minute cycle, which points at something periodic on the replica.

**Letters** go to the inbox through `POST /api/v1/human-inbox` on the local
server: one daily summary (the top hypothesis, then two tables narrow enough
for a phone: a row per day with drops, long outages and uptime, and a row per
mechanism with the day's drops and the whole window's; storms are listed under
their own heading), and an
alert on a storm or on an outage longer than `alert.outageSec` while the Mac
is awake, by the same rule as above (rate limited; outages and drops across a
sleep, or where the collector cannot show the Mac awake, are skipped). An
alert's title, first line and table cover the same drops, the ones it
counted, and say when ("4 drops between 23:42 and 23:50"). The table holds
one short token per cell (time, uptime, cause, M code), so a phone shows it
without wrapping; below it, one line per cause with a count and its
evidence. Right after a drop the kernel log and the sleep records are often
not in yet: when no drop has a cause, the letter says once that the morning
summary works them out. A day the bridge never connected says so instead of
reporting 0 drops. No letter shows the home directory: it is written as `~`
wherever it appears. A letter that cannot be delivered waits in the outbox
and is retried.

An alert is written with what the collector knew at the moment; the daily
pmset read can show later that the Mac was asleep. When the full analysis
changes an alert's verdict, the summary run replies once in that letter's
thread with one sentence (for example "Correction: the Mac was asleep then,
so this was not a drop while awake."), through `POST
/api/v1/human-inbox/:id/reply`, and writes an `alert-correction` record so it
never repeats. Alerts older than 36 hours are left alone;
`summarize.mjs --corrections-only --only <letter id>` sends one on demand.
A daily letter is corrected only on demand the same way (its counts shift a
little as late evidence lands, and a reply every morning would be noise):
one sentence with the day's counts under the current rules, plus a note when
the letter came from a version whose evidence lines ran past the day's end;
it writes a `daily-correction` record.

**Local config** (never in the repo):
`~/Library/Application Support/Walnut/bridge-monitor.json`, created from
`scripts/bridge-monitor/config.example.json` on first install. The bridge URL
is read from the daemon's `bridge.json` unless `bridgeUrl` is set. To join
replica logs, copy them from the box into a directory and set `replicaLogDir`
(server JSON logs or a TSV of bridge lines both work).

**Cost**, measured on a Mac at load average 120 to 300: the collector itself
uses 0.1 to 0.2 CPU-s a minute, and its resident memory is 108 MB at the
median and 261 MB at the peak over the busiest measured day (86 MB median
over three days, growing from 85 to 98 MB a day); the Wi-Fi
radio sample about 0.4 CPU-s every 5 minutes; each 15-minute kernel log sweep
about 8 CPU-s with a brief peak near 600 MB (it runs at `nice 10`), which is
most of the total, and a full catch-up sweep about 30 CPU-s; the daily
`pmset -g log` read about 5 CPU-s.

**Busy machine.** The two heavy samples (the kernel log sweep and the pmset
read) are skipped only under memory pressure at `heavy.maxPressureLevel`
(default 4, critical), with a `skip` record that says why, and retried
later: the sweep in 5 minutes (its window then stretches back to the last
good sweep, up to 6 hours, which is more than the log keeps), the pmset read
in 30. Load alone never skips them, and that is deliberate: the bridge flaps
most when the Mac is busiest, and a sweep skipped then loses exactly the
sockets that explain the drops, since the log forgets them in about 2 hours.
If you run a machine-wide job semaphore and would rather yield to it anyway,
set `heavy.busySlots` to `{"base": "/tmp/<name>.slot", "count": N}` (slot
directories `<base>.1` to `<base>.N`, each holding its holder's pid): a
sweep then also waits while every slot is held by a live process.

**Control probe (off by default).** `probe.mjs` is a second, independent
`/bridge` client (Node and the `ws` package, not the daemon's runtime) that
mimics the daemon's traffic: a ping every 30 s, a 64 KB frame every 30 s,
and a 2 MB burst every 15 minutes placed half a cycle away from the replica's
5-minute tick, each frame carrying a sequence number and a sha256. If both
links drop together the cause is the path or the cloud; if only the daemon
drops, it is the daemon. Test it locally with `fake-bridge.mjs`. Turning it on
changes the cloud box, so do it only when you decide to:

1. Mint a machine token named `bridge-probe` on the companion, the same way
   the Mac mints one per host: `POST https://<domain>/api/devices` with
   `{"name":"bridge-probe","kind":"machine"}` and your device token as
   `Authorization: Bearer`. The plaintext token comes back once.
2. Save it to a file readable only by you (for example
   `~/Library/Application Support/Walnut/bridge-probe.token`, mode 600).
3. In the local config set `probe.enabled: true`, `probe.url` to the bridge
   URL, and `probe.tokenFile` to that file.
4. Run `scripts/bridge-monitor/install.sh --with-probe`.

The probe registers as host `probe`, so it shows up in the companion's live
bridge list. Revoke it with `walnut device revoke bridge-probe`.
