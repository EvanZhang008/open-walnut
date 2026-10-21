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

### 2b: boards, config

| Kind | The box read that switches to the copy | Today, Mac away |
|---|---|---|
| `boards` | every board read (`board-store.ts` `getBoard`, `hasBoard`, `listBoardTaskIds`: the team walk too) once the copy is held | the file git sync wrote |
| `config` | the phone's settings view (`GET /api/v1/config`): the copy laid over the box's own config, top-level key by key | the box's own config |

Nothing on the companion writes a board (its board writes answer 501, and no board
job runs there), so the copy is the one source its readers see; git sync keeps
writing the old files until stage 4, unread. The config copy never replaces the
box's file: `getConfig` on the box stays its own (cloud exec, push, its lane's
providers).

When the companion changes build (an update, or one the Mac sees for the first
time), the Mac ends the rests of its copy kinds and sends a round at once
(`companion-build/mac.ts` `companionBuildChanged`), so a kind an older build
refused does not wait out its 10 minutes.

The inbox and the conversation index are not copied to the companion in stage 2:
the box writes both itself (inbox flags while away, the conversation list always),
so a copy would hide its own writes until they came back through the Mac. They move
with stage 3, whose `inbox-state` and `chat-turn` records hand those writes to the
Mac, and the readers switch then (the inbox in 3c, below).

### 2c: sessions

The sessions copy, in its own `cache/replica/home/sessions.sqlite`, replaces the
projection push and the transcript tails for a companion that took it; the box's
own sessions stay in its live registry. `cloudOwnedSession` then reads ownership
from the row (`owner: 'cloud'`, written where the box starts a session) instead of
inferring it from an empty host. The session reads (list, detail, history) are
specified when this part starts.

## Stage 3: writes while the Mac is away go to journal v2

The companion keeps the same records a host journals, in the same journal core
(`offline-journal-core.ts`), run inside the companion server: the companion is
the process that takes these writes, and keeping the journal there needs no
change to the session daemons. The Mac drains it with the same handover
(`runOfflineHandover`) over a `HandoverConnection` whose `send` calls
`POST /bridge/journal` (`offline.drain`, `offline.ack`, `offline.blob`), host key
`companion`.

### The parts

```
 phone write, Mac away                           the Mac
   |                                                ^
   v                                                | runOfflineHandover('companion')
 companion route -> local store write               |   drain -> apply (ledger, merge,
   |                -> companion journal ---------- |   conflict log) -> ack
   |                   cache/journal/               |
   +-- primary bridge back: `server.journal.due` ---+  (and the queues' 60 s sweep)
```

- **The journal.** One `createOfflineJournal` in the companion server, dir
  `cache/journal/`, one fixed home (the companion has one Mac; the door answers the
  Mac's `home` with it), `keepOpen`, no owner check (one process). An append is one
  O_DSYNC write on the loop; the companion takes a few writes a minute at most.
- **The writer.** The queue's dispatch stays the one place an away write leaves
  from (`task-queue.ts dispatchTaskOp`): it tries the Mac live first, as before, and
  only a write the Mac did not answer becomes a record (`companion-journal.ts`). The
  record carries the queue's op id, so a live send that landed but timed out is
  applied once (the task's `applied_ops` key `companion|<opId>|<rev>` is the same on
  both paths). Only kinds the Mac said it drains are written (the `kinds` of its last
  `offline.drain`, kept in `cache/journal/drains.json`); none known yet: the old
  queue. The field set is the queue's (`companionFieldWrites`, the fields the Mac
  merges), and the journal's own budget (`limit`) applies.
- **The door.** `/bridge/journal`, mounted beside `/bridge/replica` with the same
  `authenticate` (the Mac's machine credential only), answers the daemon's reply
  shapes. `offline.blob` errors carry `code` (the Mac's blob reader reads it).
- **The trigger.** The companion relays `server.journal.due`; the Mac runs the
  handover for `companion` (joined, if one runs). It asks when the primary bridge
  connects (always: that drain is how the companion learns the kinds, so a Mac that
  never drained would otherwise never be asked), and while records wait on a frame
  from the Mac (at most every 15 s: a Mac that slept wakes on a socket that never
  closed) and on the queues' 60 s sweep. Nothing new on the bridge allowlist: the
  relay is the queues' `session.control` path. An older Mac refuses the action.
- **The local write stays.** Unlike a host replica (which never writes its copy
  and reads copy plus overlay), the companion writes its own task store and holds
  those rows against copy rounds until the Mac has them. A row with a pending
  journal record is held the same way (`task-replica-store.ts` companion branch).
- **Actors.** A record carries no device actor yet, as the queues' ops did: the
  companion's pairing ids are not always the Mac's (C6), and a record from a device
  the Mac does not know is dropped with a letter.

### Slices

| Slice | Moves to the journal | Stays |
|---|---|---|
| 3a | the door, the trigger, the drain; a task update whose fields the Mac merges (`task-fields`, the op the queue already sends with `fields`) | everything else in `task-queue` |
| 3b | session metadata (`session-meta`: title, archived, note, output mode, thread fields), applied with the online patch's own call; a refusal becomes a letter naming the session by its title, instead of a silent drop | the live mode change (a relay) |
| 3c | inbox flags (`inbox-state`) with the inbox copy reader | |
| 3d | task creates (`task-create`) | deletes and whole-list reorders keep the task queue: no journal kind takes them (a host refuses both while the Mac is away); the companion makes no single moves (`task-move`), its board order ops are whole lists |
| 3e | chat turns (`chat-turn`, texts as blobs) with the conversation copy reader, after stage 4 brings the conversation bodies as a copy (the copy kind is index only today, and the box's list reads git's) | `cloud-chat-outbox` until then |

One task's writes reach the Mac in the order they were made: an op for a task
that still has an op in `task-queue` joins that queue; an op for a task that still
has a record joins the journal (a second field write coalesces into the record)
or, when the journal cannot take it (an appended note, a delete), waits in the
queue, which skips it until the Mac acked the record and flushes it then. At the
start of each slice, the files its kind replaces are left to drain the old way
(they are minutes of writes at most), and new writes take the journal.

**3c, the inbox.** The companion keeps `inbox` and `inbox-bodies` (bodies on for it
by default: git sync already brings them to the box) in `cache/replica/home/human-inbox/`.
The away inbox reads (`human-inbox/replica-state.ts`: the list, one letter) take that
copy once it is held, with its leader clock in place of the git index's `lastUpdated`;
before, the files git sync wrote. A flag the human sets while the Mac does not answer
is an `inbox-state` record (`letterId`, `field`, `value`, `madeAt`); a queued change of
the same flag goes, being older. The Mac applies it as the relayed replay was
(`setLetterState` with `since` = `madeAt` on its clock), so a newer change made on
the Mac wins; a letter gone is skipped quietly. Until the ack the record is shown on
top of the copy; at the ack it becomes an applied entry stamped with the Mac's ack
clock, shown until the copy passes that clock (the copy rounds the drain sends again).

**3d, task creates.** A task born on the companion while the Mac does not answer is a
`task-create` record in a host's shape: the id the box minted, the fields set on the row
(never a born default: the TODO phase, the status, the order, the unread mark), and its
placement (project, folder, parent, tier). The Mac applies it with a host's create
(`applyTaskCreate`: its create rules, the id kept unless another task holds it). A create
the queue landed (a live send that timed out after it landed, then journaled) stamps the
row with the op id as `created_by_op` and as its op key, so the drain skips the record,
neither re-minting the task nor merging its fields again over a later Mac edit. The task's
later edits join the journal behind it; a delete waits in the queue until the ack.

- **send-queue stays.** A queued send waits on the session's host, not on the Mac,
  and carries delivery fates and held images; the journal adds nothing there.
- This reverses C3 of `walnut-replica-servers-impl.md`: retiring the queues now has
  user value (one merge path, the ledger instead of a 500-entry memory, one
  conflict letter per drain, op ids end to end).

## Stage 4: notes, memory and skills from a copy

The companion gets the notes, memory and skills copy that hosts get (WP6), held by
the companion server. Notes written on the companion while the Mac is away are
`note` records in its journal, merged on the Mac with the notes merge (`notes.ts`,
N-way context). Git sync then stops writing the box's data dir; the hub stays as a
backup the Mac pushes to, and nothing on the box reads from it.

The copy is the host replica a daemon keeps (`providers/host-replica-core.ts`), not
a copy kind: it already carries each note's title, id and time, stores bodies under
a hash of their key, answers the reads a host answers (`note_read`, `note_search`,
`memory_read`, `skill_read`, list, read, read many) and takes a journal view for
pending away writes. The companion server runs one (`core/companion-host-replica.ts`,
`cache/replica/host/`, one home: `mac`), behind `POST /bridge/host-replica` with a
daemon's command names and replies. The Mac's round for it is a host's round
(`syncHostReplica`, host key `companion`, keep settings `hosts.companion.keep`) over
`postToCloudHostReplica`, run with the daemons' rounds (a note, memory or settings
change, the 5-minute sweep, once 20 s after boot) and when the companion changes
build. A daemon's memo of the last manifest ends with its link; the companion has
none, so its memo ends when the box says a kind never arrived whole, every 30
minutes, and at a build change.

| Slice | Change |
|---|---|
| 4a | the copy and its round (no reader yet) |
| 4b | the box's notes reads (`/api/notes-v2` always, `/api/v1/notes` when the Mac does not answer: the tree, a note, links, backlinks, tags, the flat list) take the copy once a whole manifest arrived, through the source a host replica reads (`replica/notes-source.ts`); searches stay the box's own (its copy of the Mac's index) |
| 4c | a note saved, created or deleted on the box (the v2 save and delete, the v1 save, create and delete) is a `note` record in its journal once the copy is held and the Mac drains `note`, checked as a host checks one (the lock hash against what the box shows, the size, the id from the Mac's copy); the Mac drains it with the notes merge |
| 4d | the box's other note paths (moves, folders, tags, attachments), its memory and skill reads, and the chat lane's note tools; then the box stops committing notes, memory and skills, and git sync stops writing its data dir (after 3e) |

Every copy read shows the pending saves over the copy (the copy's journal view,
`core/companion-notes.ts`), and a save the Mac took until a copy round from after its
ack stores the Mac's own text (or 10 minutes), so the box never shows a note going
back; the round after a drain that took notes goes at once. Until 4d the box's other
note writes still go to its disk and git sync, as before, and the copy shows their
result once the Mac has it.

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
