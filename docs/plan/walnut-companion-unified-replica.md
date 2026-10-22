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
| `boards` | every board read (`board-store.ts` `getBoard`, `hasBoard`, `listBoardTaskIds`: the team walk too) once the copy is held; without one, needs the Mac (4d) | the file git sync wrote |
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
Mac, and the readers switch then (the inbox in 3c, the conversations in 3e, below).

### 2c: sessions

The sessions copy lives in its own `cache/replica/home/sessions.sqlite`
(`session-db.ts` `applyCompanionSessionCopy`, the box's live registry untouched:
it holds the sessions the box runs itself). Rows are projected again before they
are stored, so no stored row names a process. A row keeps `stopRequest` (the stop
the user asked for, a label like `process_status`): the companion's stop fence
reads it. A host replica's live store leaves it out (`HOST_STORE_DROPPED_FIELDS`
in `kinds/sessions.ts`), because the stop machinery there would act on a pending one.

The hosts' model catalogs are a kind of their own, `model-catalogs`
(`kinds/model-catalogs.ts`, `cache/replica/model-catalogs.json`): one row per host
from the Mac's catalog store, without the cwd and spawn time only the Mac uses.
Not in the config copy (that is config.yaml through an allowlist, and a host's
`getConfig` reads it) and not in prefs (the user's layout): the catalogs have their
own store and their own write, which brings a round. The kind rides the `sessions`
choice, so turning sessions off for a box drops both.

Every companion reader of the session projection reads the copy once a whole round
arrived, through the one seam (`session-projection.ts` `readSessionProjection`, and
`readSessionProjectionWithAsOf` where the answer carries `x-walnut-copy-as-of`):
the box builds the projection the way the Mac builds the pushed one
(`buildSessionProjection`, same eligibility, order and budgets) over the copy's
rows, the task fields from its task copy, the host labels from its config copy,
and the catalogs from its catalogs copy (`companion-sessions.ts`). The readers:
the session list and `/sessions/recent`, the events snapshot, the model picker
(`model-options-copy.ts`), the session controls while the box leads a host
(`host-session-control.ts`), the backup gateway's session list, the stop fence
(`cloud-stop-fence.ts`), and the lookups of one session's host (`cloud-session-host.ts`,
the degraded detail, the host's name in a sentence, the media route). The box's own
sessions are joined in as before. The copy is the Mac's whole store (about 5,000
rows, 18 MB of JSON measured), so the rows a view can show (not archived, live or
active in the last 30 days) are parsed once, in slices, and then kept up to date by
every copy write; a write that lands while they are parsed is applied after.
Before the sessions copy is held, and after a purge, the pushed projection answers
as before; until the catalogs copy is held, the picker takes the catalogs the last
push carried.

The push stops for such a box. Once it holds both copies, the companion answers the
Mac's sessions projection push (`POST /bridge/ingest`) with `unread: true`
(`companionReadsSessionsCopy`), still writing it as the fallback. The Mac then sends
that push on neither lane for 10 minutes (`projection-push-state.ts` `noteUnread`),
after which one push asks again; a companion build change or the Mac purging the
box's sessions copy ends the rest at once. An older companion never says the word
and keeps getting every push; an older Mac ignores it. The task list and the
transcript tails are pushed as before (the tails are not part of this stage).

`cloudOwnedSession` keeps reading the box's live registry: with the copy in a file
of its own, that registry holds only the sessions the box runs itself, so an empty
host there still means the box's own.

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
| 3e | the conversation copy (`conversations` and `conversation-bodies`) with the box's chat readers; chat turns (`chat-turn`, texts as blobs) | `cloud-chat-outbox` for an older Mac and the files already queued; the box's list edits reach the Mac through git sync |

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

**3e, conversations.** The companion keeps `conversations` (each agent's list, in
`cache/replica/home/conversations/`) and `conversation-bodies` (on for it by default,
off for hosts: `conversation_bodies`), one file per conversation holding the Mac's v1
rows (`kinds/conversation-bodies.ts`): per agent its main conversation and the newest
with a message in the last 30 days, at most 50; each the newest rows that fit 2 MB,
with `total` keeping the Mac's positional ids (`m<n>`); every text through the redactor
on both sides; and the turn ids the Mac adopted from the companion. The Mac reads a
conversation again only when its list row moved, or every 2 minutes while it is
active, at most 20 in a round and 3 s (the rest ride in `keep`, and the next round
goes at once).

- **The list** (`listConversations` on the companion, `companion-conversations.ts`) is
  the copy once held, with the box's own changes on top: a chat made, renamed, pinned
  or deleted here (`cache/companion-conversation-edits.json`) shows until the copy
  carries it, and goes when the copy does, when the box's own list no longer has it,
  or after 7 days. The box's list writers take the copy's row into its own list first
  when git has not brought it.
- **One conversation** while the Mac does not answer
  (`GET /api/v1/conversations/:id/messages`): the copy's rows and ids with
  `x-walnut-copy-as-of`, the turns the box answered itself on the tail until the copy
  names their turn id, an older page the copy holds whole, and `503
  primary_unreachable` past what it holds. Before the copy, git's chat history, as
  before; while the Mac answers, its answer.
- **A chat turn** the box answers itself while the Mac does not answer
  (`routes/cloud-chat-fallback.ts`) still starts in the outbox, so the user's words
  survive a crash and a read during the turn shows them. When it ends and the Mac
  drains `chat-turn`, it becomes a `chat-turn` record (`companion-chat-turns.ts`): the
  turn id (op id `chat-<turnId>`), agent, conversation, times and engine, with the
  user's words and the answer as blobs (named in the record's `blobs`, freed at the
  ack), and its outbox file goes. The Mac adopts it with the outbox's own adopt
  (`apply-chat-turn.ts` over `handlePrimaryChatAdopt`: once by turn id, so a turn the
  outbox already handed over is skipped), its times moved onto the Mac's clock; an
  answer the box lost lands as a failed turn with the words, and lost words are
  refused into the letter. The box's reads show the record until the ack, then (in
  memory, at most 10 minutes) until the copy names the turn id; the v1 list moves the
  conversation up while a turn shows. An older Mac, whose drain names no `chat-turn`,
  keeps the outbox and its `server.chat.adopt` hand-over, as do the outbox files
  already there.

What 3e leaves:

- The box's list edits (a chat made, renamed, pinned or deleted there) reach the Mac
  only through git sync, as before. Before git sync stops writing the box's data dir
  (4d), they need a journal kind of their own or a forwarded write.
- The box's chat lane still seeds and catches up from git's chat history, not from
  the bodies copy.
- The list answer carries no `x-walnut-copy-as-of`, and the overlay of acked turns is
  in memory: a box restarted in the minutes between the ack and the next copy round
  shows such a turn only once the copy has it.

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
| 4d | the box's memory reads and saves (`memory` records), its skill reads, and v1's note resolve take the copy; a note move or rename on the box is a `note-move` record, a tag rename is `note` saves, a folder change needs the Mac; a pasted picture is a `note-attachment` record too, a picture move or delete needs the Mac; the box's other reads of git sync's files take a copy or need the Mac (letter bodies, the speech vocabulary as the `stt-vocab` kind, boards, transfer options, conflict logs), and the Mac stops most of its git churn into the box (the untrack pass, no legacy projection files); then the box stops committing notes, memory and skills, and git sync stops writing its data dir (after 3e) |

Every copy read shows the pending saves over the copy (the copy's journal view,
`core/companion-notes.ts`), and a save the Mac took until a copy round from after its
ack stores the Mac's own text (or 10 minutes), so the box never shows a note going
back; the round after a drain that took notes goes at once. Until 4d the box's other
note writes still go to its disk and git sync, as before, and the copy shows their
result once the Mac has it.

**4d, memory and skills.** The box's memory reads (`/api/memory/{global,user}`, and
`/api/v1/memory/{global,user}` when the Mac does not answer, which memory_read calls)
answer the copy's doc objects, and a memory save there is a `memory` record in its
journal (the doc, the text it was made on and the new text, as blobs), shown over the
copy as a note save is (`core/companion-memory.ts`). Both start together, once the copy
is held and the Mac drains `memory`: a copy read beside a save that still went to the
box's disk would show the save reverted until git sync brought it round, and the next
save would answer 409. The Mac applies a record through the editor's own write
(`writeMemoryDoc`, locked to the text it read), three-way against the doc as it is
(`offline-merge/apply-memory.ts`): a clean merge letters nothing; the same lines on both
sides keep the newer side and letter the other in full. Records are not coalesced (the
journal core folds notes and task fields only), so each save is one record made on the
one before it. The skill reads (`/api/skills`, `/api/v1/skills`, one skill or the list,
which skill_read calls) answer the copy once it is held; a skill write there answers
needs-the-Mac (`skill_changes_need_mac`): a skill is a folder (its references, its
enabled flag) the copy holds as one document, so a write could only go to the box's disk
and would show reverted. A skill's references stay the box's own files. v1's note resolve
(note_read by id or title) answers from the copy's ids and titles. The companion's chat
lane has no note, memory or skill tools (its profile drops the Walnut MCP and keeps read
and web tools only), so nothing changes there; the ops that do reach the box (the backup
gateway's note_read, note_search, memory_read and skill_read while the companion leads)
go through the routes above.

**4d, note moves, tags and folders.** A note moved or renamed on the box (`POST
/api/notes-v2/move`, and `POST /api/v1/notes/move` when the Mac does not answer) is one
`note-move` record naming both paths and the note's id, once the Mac drains that kind; a
Mac that does not keeps the old path (the box's disk). The box checks it as the Mac's
route does, against what it shows: the note is there, and the new path is free in any
case (the Mac's disk does not tell case apart). Every copy read shows the move at once,
in order with the saves around it, so a save at the new path and a new note at the old
one are their own records after it: a save never folds into a record made before a move
that names its path, or it would land before the move. The Mac applies the record where
the note is now (`offline-merge/apply-note-move.ts`): found by its id, else at the old
path, and moved through the route's own move (the index keeps the id, a bookmark follows
it). A note already at the new path, or deleted on the Mac, needs nothing; one the Mac
moved elsewhere meanwhile, or onto a path another note holds there, stays where it is
and is lettered. A tag renamed on the box is a `note` save of every note that carries it,
as the box shows them, with the disk route's own rewrite (`core/note-tag-rename.ts`).
When the copy leaves notes out (a folder the Mac keeps back, a note over 1 MB), one of
those may carry the tag too, so the rename answers needs-the-Mac
(`tag_rename_needs_mac`). Making or deleting a folder answers needs-the-Mac
(`folder_changes_need_mac`): the copy holds notes only, so an empty folder made on the
box would never show, and a folder delete also removes pictures and files the box does
not hold. There is no folder rename route (the tree renames notes and never drags a
folder).

**4d, pictures and files.** The copy holds note text only, so the box reads pictures and
files from its own disk, as before. A picture pasted into a note on the box (`POST
/api/notes-v2/attachment`, `POST /api/v1/notes/attachment`, which stays on the box
whoever answers) is written to the box's disk as before, so the editor shows it at once,
and is also a `note-attachment` record with its bytes as a blob, once the Mac drains that
kind (`core/companion-note-attachments.ts`). When the journal refuses the record, the
file is removed again and the paste answers the refusal, so the box never keeps a file
the Mac would not get. The Mac writes the bytes at the same path
(`offline-merge/apply-note-attachment.ts`) and never overwrites: while git sync still
runs it may bring the same file there first, and the same bytes at the path need nothing;
other bytes there stay, and the companion's go beside them under a name with their own
hash, lettered. A file is linked into place only where no file is, from a finished temp
file, so one that appears meanwhile is never replaced and a crash never leaves half a
picture. Moving or deleting a picture or file on the box answers needs-the-Mac
(`attachment_changes_need_mac`): the box holds no copy of the Mac's files to check a
move or delete against. Once git sync stops writing the box's data dir (after 3e), the
box's picture reads need a source of their own.

**4d, the other reads of what git sync wrote.** Each takes a copy or needs the Mac, so
git sync can stop writing the box's data dir without one of them going stale:

- *Letter bodies.* The body route (`GET /api/v1/human-inbox/:id/body`, its Range and its
  framed form) reads the `inbox-bodies` copy once the box holds it
  (`human-inbox/replica-state.ts` `bodySourceDir`: the copy's index and bodies), and a
  body the copy lacks (over its 4 MB cap, or newer than its last round) is relayed from
  the Mac, never read from the folder git sync wrote. A plugin's `letters.get` on a
  follower reads the inbox copy the way the list does (`mirrorRecord`, the box's queued
  flags on top). Before the first bodies round (an older Mac) both read the box's own
  folder, as before: a body is write-once, and the route checks its size against the one
  the Mac recorded. (The framed form of a markdown body now ends its response: it never
  did, so the next request on that keep-alive socket waited behind it.)
- *Speech vocabulary.* A copy kind of its own, `stt-vocab` (`kinds/stt-vocab.ts`,
  `cache/replica/stt-vocab.json`): one row of the file's words (comments left out, a
  secret-shaped word never sent), riding the `config` choice, rounded after every word
  the Mac adds and by the sweep after a hand edit. Once the box holds it, its own
  transcriber (`core/stt/index.ts` `loadVocabPrompt`), `GET /api/v1/stt/vocab` and
  `GET /api/stt/vocab` answer the Mac's words (with `x-walnut-copy-as-of`).
  `/api/v1/stt/vocab` left the `bytes` rule of `v1-forward/policy.ts`, so the Mac answers
  the GET and takes the POST while it answers. A word added on the box while it holds the
  copy (the Mac away, or the console's own `POST /api/stt/vocab`) answers needs-the-Mac
  (`stt_vocab_writes_need_mac`) rather than going into a journal: it is one word, rarely
  added, that the user adds again when the Mac is back, and a journal kind would need a
  drain and a merge for nothing more. Before the first round the box reads and writes its
  own file, as before.
- *Boards.* With no boards copy (before the first round, or the user turned boards off for
  the box), every board read needs the Mac (`kind_not_copied`), never the file git sync
  wrote (`board-store.ts` `readBoardsDir`).
- *Transfer options.* `GET /api/v1/tasks/:id/transfer-options` reads the hosts and their
  profiles, which the task copy does not hold: an exception of the task-copy rule, so the
  Mac answers it while it answers.
- *Conflict logs.* `GET /api/v1/offline-conflicts/:drainId`: the logs are the Mac's and
  are copied nowhere, so a follower answering it (the Mac away) needs the Mac
  (`conflict_log_needs_mac`). `frequent-directories.json` stays the box's own (a hint list).
- *The Mac's side.* The untrack pass (`git-sync.ts` `CRITICAL_IGNORE_FILES`/`DIRS`) now
  drops `triage-state.json`, `session-requests.json` and `local/` from the index: each was
  ignored but still tracked from an older install, so the Mac committed it on every change
  and the box pulled it over its own; git was never their backup (a fresh install never
  tracked them). A box on the same build untracks its copies before the pull that brings
  the Mac's removal, so the files stay on disk on both. `sync.legacy_projection_files` is
  off by default (`projection-cache.ts`): a current box reads its task and session copies
  and the pushed cache, and reads the legacy files only as the fallback the first push
  passes over. In the last 40 auto-saves of a real data repo they were about 360 of about
  410 changed paths (the transcript tails, then the two projections). The files stay
  tracked as they last were, never removed (an untrack would delete them on every box
  that pulls it), so a box on an older build keeps them; `true` turns the rewrites back on.

Still writing the box's data dir or read from it, owned by the other 4d slices: the
notifications, the console's routines and cron, ui prefs and the Ask launch settings; the
conversation list edits and the chat lane (3e); note pictures, notes keyword search,
memory beyond MEMORY.md and USER.md, the lane's skills. Then `reconcileAfterPull` goes on
the box, and git sync stops writing its data dir.

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

### Where the capabilities come from

`core/capabilities.ts`. The box sets `WALNUT_CAPABILITIES` for itself (names
separated by commas or spaces, `none` for no capability), in its own unit, as root
sets `WALNUT_COMPANION_MAC_BUILDS`; no copy from the Mac carries it. A companion
that sets nothing has all four, which is what it ran before; nothing in
`scripts/cloud/` sets the variable.

| Server | Capabilities |
|---|---|
| the Mac (leader) | none: its `leader` column decides every row; a value is ignored with a warning |
| a host replica | none: a value is ignored with a warning |
| the companion | all four when unset or blank; when set, exactly the names given; a name that is not a capability stops the boot |

The `server role` and `boot policy` lines at boot name them. A row is on for a
replica when its `replica` column is, or when the box has the row's capability.
The defaults read `CLOUD_MODE` live (tests flip the constant between cases), so
the ratchet keeps that module with `constants.ts`, `server-role.ts` and `boot-policy.ts`.

### Slices

| Slice | Moves | Stays |
|---|---|---|
| 5a | `capabilities.ts`; the `replica` column; the capability rows below; the boot wiring in `server.ts`, the `/bridge` and `/daemon-tunnel` doors (`ws/handler.ts`), and the job modules of capability rows read a capability or `isCompanion()` instead of `CLOUD_MODE` | the routes' reads, the forward, the `companionUntil` rows |
| 5b | the front: the host replica's route table with the companion's kept routes as rows; `v1-forward` and the stream forward deleted; the routes' reads; each `companionUntil: '5b'` row decided | |

The capability rows as built in 5a:

| Capability | Rows | Also gates |
|---|---|---|
| `public-door` | `setup-token-banner`, `revoke-queue`, `stt-auto-setup`, `expose-runtime` | |
| `bridge-door` | `companion-ingest-routes` (`/bridge/*`, `/git/data`, the trial build's confirm) | the `/bridge`, `/daemon-tunnel` and bridge session stream upgrades |
| `cloud-exec` | `cloud-exec`, `local-daemon`, `stream-file-cleanup`, `send-path-canary` | `cloudExecActive`, the tunnel daemon's exec check, the canary's own start |
| `backup-leader` | `backup-leader`, `cron`, `routine-wake`, `overview-maintainer`, `project-summary` | `getBackupLeader`, `canStandIn` |

`expose-runtime` is a public door too (the tunnel in front of the box), so it joined
`public-door`. The pairing, claim, push and voice routes are mounted on every server
already, so `public-door` gates no mount yet. Inside the core modules those routes
call (device auth and adoption, the push relay and revokes, the voice archive), and
in the cron allowlist, the plugin relay and the `/ws` token check, a read that means
"this box is the companion, its leader is over the bridge" became `isCompanion()`:
that is the follower kind, not a door. `cron`, `routine-wake`, `overview-maintainer`
and `project-summary` still start at boot whenever the box has `backup-leader`;
running them only while it leads is later work.

Rows the companion still runs with no capability (`companionUntil`), each with the
stage that moves it onto the replica core, makes it a capability row or turns it off:

| Stage | Rows |
|---|---|
| 2c | `completed-task-session-migration` |
| 4d | `git-pull`, `git-auto-commit`, `git-maintenance`, `notes-watcher`, `notes-indexer`; 4d also decides whether the hub's gc stays (a `bridge-door` row then) |
| 5b | `v1-forward`, `companion-stream-forward`, `companion-queues` (deletes and whole-list reorders, 3d), `plugins`, `companion-plugin-cards`, `update-check` (a no-op on the companion already: its install kind is `replica`) |

After 5a the ratchet lists 313 raw reads in 116 files (348 in 133 before): 213 in
61 route files (`api-v1.ts` 28 of them), 84 in 46 files of `src/core`, 8 in
`src/integrations`, 5 in `src/providers`, 3 in the web middleware. 5b still has to:

- build the front from the host replica's route table, the companion's kept routes
  as rows, and delete `v1-forward` and the stream forward with their rows;
- convert the routes' reads: a read that relays to the Mac goes with the forward, a
  read that means "this box is the companion" becomes `isCompanion()`, and the
  pairing, claim, push and voice mounts take `public-door`;
- decide each `companionUntil: '5b'` row above;
- convert or justify the reads left in `src/core`, `src/integrations`,
  `src/providers` and the middleware, until the ratchet keeps only `constants.ts`
  and the capability defaults.

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
