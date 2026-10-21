# The cloud companion as a regular replica

Status: design, 2026-10-20. Builds on `walnut-replica-servers.md` (the replica
program, its copies, its journal) and `walnut-control-plane.md` (the leader,
takeover, epochs).

## Goal

There are two roles: the **leader** (the Mac) and **replicas**. A replica is
the same Walnut server program wherever it runs. What differs between replicas
is configuration, never code paths:

- **placement**: `host` (a dev box the user picked) or `cloud` (the companion);
- **capabilities**: what this box offers beyond the replica core;
- **link**: how the Mac reaches it (SSH to a host daemon, HTTPS to the companion).

Today the host replica is that program. The companion is still a server with its
own pipeline: a pushed projection instead of copies, five special queues instead
of the journal, git sync for documents, `CLOUD_MODE` branches in about 140 files,
and an update path the user runs by hand. This plan moves the companion onto the
replica core in five stages, each deployable on its own, and gives it the same
update story as a host: the Mac keeps it on the Mac's own build.

## What differs today

| Area | Host replica | Companion today | Companion target |
|---|---|---|---|
| Build it runs | The Mac's build, installed by the Mac | Whatever the box was last deployed with | The Mac's build, installed by the Mac (stage 1) |
| Tasks, registry, search | Copy kinds | Copy kinds | Copy kinds |
| Sessions, requests, boards, inbox, routines, conversations, config, prefs, personas | Copy kinds | Projection push, transcript tails, git sync, own files | Copy kinds (stage 2) |
| Writes while the Mac is away | Journal v2 in the host daemon, drained by the Mac | task-queue, control-queue, human-inbox queue, chat outbox (and send-queue) | Journal v2 records, drained by the Mac (stage 3); send-queue stays |
| Notes, memory, skills | Daemon copy | Git sync through the box's data hub | Copy (stage 4); the hub is a backup only |
| Front | One route table, leader first | `v1-forward` + stream forward + kept routes | The same route table (stage 5) |
| Boot | `bootPolicy` replica column | `CLOUD_MODE` column | One replica column plus capability rows (stage 5) |

## Target

```
                 +------------------------- the Mac (leader) -------------------------+
                 | copy rounds (kinds)   journal drain   build install   heartbeat     |
                 +------+------------------------+-------------------------+---------+
                        | SSH, host daemon       | HTTPS /bridge/*, machine credential
                        v                        v
   +--------- host replica ---------+   +------------- companion (replica, cloud) --------------+
   | replica core: copies, journal, |   | replica core: copies, journal, front, same program    |
   | front, away reads/writes       |   | capabilities: public door (phones pair, push, voice), |
   | supervised by its daemon       |   |   bridge door (daemons dial in), cloud exec, backup   |
   +--------------------------------+   |   leader                                              |
                                        | supervised by systemd through the box launcher        |
                                        +-------------------------------------------------------+
```

The link to the companion is HTTPS with the Mac's own machine credential
(`bridge-local`, the `/bridge/*` door: `bridge-ingest.ts` `authenticate`). It
already carries the task copy (`postToCloudReplica`). The companion reaches the
Mac the other way, over the daemon's `/bridge` socket, as today.

## Stage 1: the Mac keeps the companion on its build

### Why the Mac sends the build and the box never runs it as root

The box's code tree `/opt/walnut` is root's because root runs code from it
(`setup.sh`, the npm lifecycle scripts of a build, `ensure-harness.sh`). The
service user runs agents, so anything it can write must never be run by root.

A build the Mac sends lives in the service user's home and runs as the service
user, exactly like the server does today. Root never runs it, so a bad or hostile
build gains nothing it did not have: the Mac can already make the box run any
command as that user through a cloud-exec session. Nothing in this direction
gives the companion any new power over the Mac or a host.

### Box layout

```
/opt/walnut/                         root's tree (setup, deploy): the BASE build
  scripts/cloud/companion-launch.mjs the launcher systemd runs (as the service user)
$HOME/.open-walnut-host/             the service user's, same layout as a host install
  deps/<hash>/node_modules           one npm install per dependency set
  app/<id>/dist  app/<id>/.ready     one directory per build
  incoming/<id>.tgz(.part)           uploads, install scripts and logs
  companion/current                  the build the box runs (absent: the base)
  companion/trial  companion/attempts the build to try once, and how often it started
  companion/failed/<id>              why a build was given up (one line)
```

`ensure-harness.sh` (run by setup and by every deploy) writes a systemd drop-in
`launcher.conf` that points `ExecStart` at the launcher and sets
`WALNUT_COMPANION_MAC_BUILDS=1`. A box set up with `--no-mac-builds` gets `0`, and
then the Mac only reads the box's build.

### The launcher

A small Node script with no dependencies, in root's tree. On every start:

1. A `trial` with `attempts` under 2: count one more start and run the trial.
   Two starts that never confirmed: write `failed/<id>`, drop the trial.
2. Otherwise `current`, when its directory is ready; otherwise the base.
3. Run `node <dir>/dist/cli.js web --port 3456` with the unit's environment plus
   `WALNUT_COMPANION_LAUNCHER=1`, `WALNUT_COMPANION_BUILD=<id or base>`, and
   `WALNUT_COMPANION_TRIAL=1` for a trial. Forward SIGTERM, SIGINT and SIGHUP,
   and exit with the server's code (`Restart=always` starts the launcher again).
4. A trial that has not confirmed within 10 minutes is stopped (SIGTERM, then
   SIGKILL after 20 s). That counts as a failed start.

A trial confirms itself: 90 s after its server is up, it writes `current=<id>`
and removes `trial` and `attempts`. Sessions survive every one of these
restarts, as they survive a deploy today (`KillMode=process`).

### The install, driven by the Mac

Each step is a call on the `/bridge/build` door. Each one is idempotent, so a
restart of either side resumes where it stopped.

| Step | Call | Box does |
|---|---|---|
| Look | `GET /bridge/build` | Answers its running build id, base or not, current, trial, failed ids, an upload's received bytes, the install and smoke state, platform, arch, Node, free disk, and `accepts` |
| Upload | `PUT /bridge/build/package?id&offset&size&sha256` | Appends a chunk (at most 8 MB) to `incoming/<id>.tgz.part`; checks the sha256 at the end |
| Install | `POST /bridge/build/install` | Runs the host install script (`installScript`, niced, detached), with optional dependencies and with `current` and `trial` kept |
| Activate | `POST /bridge/build/activate` | Boots the build once on a probe port with a temporary home and daemon dir (the `dev-prod.sh` smoke recipe) and needs `/api/v1/instance` to answer 200 within 150 s (a companion's `/api/config` needs a token); then writes `trial` and restarts itself |

The Mac:

- looks after every cloud box probe that succeeds (every 5 minutes) and 60 s
  after its own boot;
- does nothing when the companion already runs its build id, when the box
  answers `accepts: false`, or when the user turned off `cloud_bridge.auto_update`;
- never retries an id the box gave up, until its own build changes;
- builds the companion package: the host package plus `dist/daemon-binaries` for
  the box's platform and arch (the companion starts session daemons; a host
  server does not).

The Mac's Cloud Companion settings show one row for this: it runs this Mac's
build; it is updating (and which step); the update failed and it keeps running
the old build (with Retry); or it needs a one-time update with the setup script,
after which it follows the Mac.

### Mixed versions

| Mac | Companion | Result |
|---|---|---|
| new | old (no `/bridge/build`, 404) | Settings: one-time update needed; asked again in an hour |
| new | new, `MAC_BUILDS=0` | Read only: the row names the box's build |
| old | new | Nobody installs; the box runs `current` or the base |

### Tests

- Launcher: every state of `current`, `trial`, `attempts` and the base, a trial
  that never confirms, signals forwarded, the exit code kept (a real child process
  in a temp home).
- Box routes: chunks in order, out of order, repeated, a bad sha256, a wrong
  credential (401/403 before the body is read), a full disk, a busy install.
- Install and activate on a real tree: a good build becomes current; a build that
  does not start falls back to the old one and is never retried; the current build
  is never pruned.
- Mac side: no push when the ids match or the box refuses; resume after a Mac
  restart in the middle of an upload; no retry of a failed id.
- An end-to-end run: an ephemeral Mac and a real companion process under the
  launcher in temp dirs, updated from one build to another, sessions kept.

## Stage 2: every copy kind goes to the companion

The companion becomes a copy target for every kind, gated by the kind answer
itself (an old companion answers `404 unknown_kind`, and the Mac rests that kind
for it).

### What the companion is not

A host replica is a fresh data dir that holds nothing but copies, so its
followers write the same files the Mac keeps, and every read of a kind it holds
takes the replica branch (`isHostReplicaProgram()`). The companion is not that:

- it keeps data of its own in the live files: the sessions it runs itself
  (cloud exec, its chat lane) in `sessions.sqlite`, its own `config.yaml`
  (`cloud.exec`, push tokens, API keys, the providers its lane uses), its own
  cron engine (git sync and backup jobs) in `cron-jobs.json` and `cron-state.json`;
- git sync writes boards, the inbox, `cron-jobs.json`, the conversation index and
  ui prefs into its data dir, and `restoreNeverStagePaths` reverts a dirty
  tracked file there;
- its console routes (`/api/*` outside `/api/v1`) and several v1 routes
  (`/conversations`, the inbox body) are answered by the box itself whether or not
  the Mac is there, so a "writes need the Mac" refusal would fire with the Mac
  connected.

So the companion takes the copies the other way round: **a copy on the companion
lives in its own store under `cache/replica/`, and never in a live file.** The
followers name their files through `copyPath(live)` (`kinds/gate.ts`): the live
path on a host replica, `cache/replica/home/<same relative path>` on the companion.
The box's own rows, files and engine are never touched by a round, and a manifest
removes only what the copy holds. Readers on the companion read a copy only where
the box answers a read the Mac did not (the Mac is away, or a forwarded read went
unanswered), through `copyHeld(kind)` (`gate.ts copyKindHeld`), never by program.
The answer carries `x-walnut-copy-as-of`.

The Mac side: the companion target takes a kind once the box answers it, the half
rule's confirm works for it as for a host, and the Settings row shows its kinds.

### 2a: requests, routines, favorites, personas

| Kind | The box read that switches to the copy | Today, Mac away |
|---|---|---|
| `requests` | `GET /api/v1/requests/:id`: the box's own file, then the copy | 404 |
| `routines` | `GET /api/v1/routines`, `/routines/:id`, `/routines/status` | 503 from the control relay |
| `prefs` | `GET /api/v1/favorites`: the copy's favorites | the box's own favorites, never the Mac's |
| `personas` | the cloud chat lane's persona for a new lane (`cloud-chat-lane.ts`, `buildLaneProfile` `persona`) | the box renders it from its own config and its git copy of memory; an agent defined only in the Mac's config is not found |

Routine writes while the Mac is away still answer that they need the Mac.

### 2b: config, boards, inbox, conversations

Each needs a reader that does not exist yet on the companion (config: the phone's
settings while away, as an overlay on the box's own file, never a replacement), or
a git-synced file whose reader moves to the copy (boards, the inbox index and
bodies, the conversation index). Git sync keeps writing those files until stage 4;
the readers stop reading them once the copy is held, so each file has one writer
that is read.

### 2c: sessions

The sessions copy, in its own `cache/replica/home/sessions.sqlite`, replaces the
projection push and the transcript tails for a companion that took it; the box's
own sessions stay in its live registry. `cloudOwnedSession` then reads ownership
from the row (`owner: 'cloud'`, written where the box starts a session) instead of
inferring it from an empty host. The session reads (list, detail, history) are
specified when this part starts.

## Stage 3: writes while the Mac is away go to journal v2

The companion keeps the same records a host journals (`task-fields`,
`task-create`, `task-move`, `board`, `note`, `session`, `device-revoke`), in the
same journal core (`offline-journal-core.ts`), run inside the companion server:
the companion is the process that takes these writes, and keeping the journal
there needs no change to the session daemons. The Mac drains it with the same
handover (`runOfflineHandover`) over a `HandoverConnection` whose `send` calls
`POST /bridge/journal` (`offline.drain`, `offline.ack`, `offline.blob`).

- The front writes through the same write port a host uses (`write-port.ts`), so
  the merge rules, op ids, ledger, conflict log and the one letter per drain are
  the same code. `x-walnut-op-id` is carried end to end.
- New record kinds for what only the companion takes: `session-meta` (title,
  archived, note, output mode, thread fields), `inbox-state` (read, pin, archive)
  and `chat-turn` (a turn the companion answered itself, keyed by its turn id).
- At the first boot of this stage, the files left in `task-queue`, `control-queue`,
  the inbox queue and the chat outbox become journal records (deterministic op ids,
  the v1 migration pattern), and new writes wait until that is done. A write with
  no journal kind (a delete, a list reorder) keeps the old drain until its queue is
  empty, then that queue is gone.
- **send-queue stays.** A queued send waits on the session's host, not on the Mac,
  and carries delivery fates and held images; the journal adds nothing there.
- This reverses C3 of `walnut-replica-servers-impl.md`: retiring the queues now has
  user value (one merge path, one conflict letter, op ids end to end) and the
  migration above bounds the risk.

## Stage 4: notes, memory and skills from a copy

The companion gets the notes, memory and skills copy that hosts get (WP6), held by
the companion server. Notes written on the companion while the Mac is away are
`note` records in its journal, merged on the Mac with the notes merge (`notes.ts`,
N-way context). Git sync then stops writing the box's data dir; the hub stays as a
backup the Mac pushes to, and nothing on the box reads from it.

## Stage 5: capabilities instead of `CLOUD_MODE`

`bootPolicy` gets one `replica` column. What only a companion does becomes a
capability row, read from configuration the box sets for itself:

| Capability | Jobs it turns on |
|---|---|
| `public-door` | setup token banner, pairing and claim routes, push, voice, revoke queue |
| `bridge-door` | `/bridge` for daemons, `/daemon-tunnel`, the `/bridge/*` HTTPS routes |
| `cloud-exec` | the box's own session daemons, stream file cleanup, send path canary |
| `backup-leader` | takeover, and while it leads: cron, routines, overview, project summary |

The front is the host replica's route table, with the companion's kept routes as
rows of it, and `v1-forward` and the stream forward are deleted. The boot policy
ratchet then counts the remaining `CLOUD_MODE` reads down to the env parse and the
capability defaults.

## Security

- Only the Mac's own machine credential reaches `/bridge/build` and `/bridge/journal`
  (`authenticate`: 401 without a token, 403 for anything else, a strike per wrong
  token, checked before a body is read).
- The box decides whether it accepts builds (`WALNUT_COMPANION_MAC_BUILDS`, set by
  root in the unit); the Mac's user decides whether to send them
  (`cloud_bridge.auto_update`).
- A build is checked by size and sha256 before it is unpacked, its id is plain
  characters, and it runs as the service user only. Root's tree and the launcher are
  never written by the service user.
- The bridge allowlist does not change: no stage gives the companion a new command
  on a daemon, a new stream target, or a way to make the Mac run code.
- Stage 2 sends the companion no kind a host replica does not get, and each lands
  in the box's copy store at 0600 in a 0700 dir. The config copy (stage 2b) is the
  allowlisted one, checked again for secret shapes on the box.

## Corrections to earlier plans

- `walnut-replica-servers-impl.md` C3 (keep the companion's queues): reversed by
  stage 3, except send-queue.
- `walnut-replica-servers-impl.md` WP4/WP5 (copy kinds to host replicas only):
  stage 2 sends them to the companion too.
