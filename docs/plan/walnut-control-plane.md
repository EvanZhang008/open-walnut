# Walnut control plane: every host runs itself, the Mac leads, the cloud companion stands in

## Summary

Every host does its own work through its daemon. A host keeps a read copy of
what its sessions need and answers from it, writes its own things first and
hands them to the leader later (docs/plan/daemon-first-hosts.md). What a host
cannot answer alone (a message to a session on another host, a task outside its
copy) goes to the **leader**.

The leader is the Mac (the primary). While the Mac is away (asleep, offline),
the cloud companion leads instead, if the user allows it. When the Mac comes
back it takes back what the hosts did alone and then takes the lead back.

The rule, for every feature: **if a feature can be self-managed, self-manage it
in the daemon; when it cannot, go to the leader.**

## Roles

```
control plane (leader)                     data plane (every host's daemon)
  Mac        primary, no public address      owns: its sessions, their tasks, triggers,
  companion  backup, reached by every host         the team Board, reply requests
                                             reads: its own copy, always
                                             writes: its own things first, journaled
                                             global: to the leader, or queued
```

Only one leader at a time writes for a host. The daemons are witnesses and
fences, never leaders.

## Who leads

Each daemon keeps a **leader book** per Walnut (`src/providers/leader-core.ts`,
on disk, so a daemon restart keeps it): which Walnut it is (the primary's
instance id), whether the user allows the companion to lead, the current
**epoch**, and who holds it (`primary` or `backup`).

The companion takes the lead of a host only when **both views agree**:

1. its own: the primary's heartbeat (a `leader-heartbeat` frame every 15s down
   the primary's own bridge) has been silent for the takeover window (60s), or
   for the longer window the primary announced when it went down for a restart;
2. every host it can reach: each daemon reports how long ago it last heard the
   primary on its trusted socket. One host that still hears the primary is
   enough to wait: only the link between the primary and the companion is down.

The decision is pure (`src/core/leader/takeover.ts`); the loop that asks and
claims is `src/core/leader/backup-leader.ts`. A daemon grants a claim
(`leader.claim` over the bridge) only when the user allowed it, the epoch is
higher than the one it holds, and the daemon itself has not heard the primary
for the window. Silence is judged on frames, not on the TCP socket: a sleeping
Mac keeps its sockets open.

Every command the companion sends while it leads carries the epoch. When the
primary takes the lead back the epoch goes up, and anything the companion still
sends at the old epoch is refused.

## While the companion leads

- A gateway call a host cannot answer from its copy is handed to the companion
  (`gateway-request` over the bridge, answered with `gateway-result`). A
  primary socket that is open but silent is not a target meanwhile.
- A message to a session on another host is routed with `leader.deliver` to that
  host's daemon, which delivers it as task_send does and owns the reply request
  beside the session that answers it. The answer and the "finished without
  replying" notice go back the same way (`leader.deliverText`).
- Reads and task writes outside every copy run on the companion's copy of the
  task store ("The companion's copy of the tasks" below) through the op
  registry, on the same routes the phone's calls reach; its task queue carries
  the writes to the Mac. A cloud-mode server has no loopback
  waiver, so its own op calls carry a credential that lives only in that
  process (`src/lib/self-api-root.ts`).
- What needs the Mac itself (starting a session, a session on the Mac) says so.
- The team Board stays the host's own: each host answers and writes its copy and
  journals the write for the Mac.

The bridge allowlist grows by four commands: `leader.witness`, `leader.claim`,
`leader.deliver` and `gateway-result`. The last two are honoured only for the
current epoch, and only for a relay that went to the bridge. `leader.configure`
stays trusted-only.

## The Mac comes back

On every connect, after the offline handover (it drains each host's journal:
request rows, deliveries, queued task and Board writes), the Mac describes the
Walnut (`leader.configure`) and, when the companion holds the lead, takes it
back (`leader.claim`, epoch + 1). A Mac that wakes on sockets that outlived its
sleep is told at once: the daemon sends `leader-lost` on the first frame it
hears from it. The companion sees the higher epoch on its next look and lets
the host go.

## What a host keeps

Every host keeps a read copy of what its sessions read, so a read answers the
same whether the Mac is there or not. Its own work (its sessions, their tasks
and team, triggers, the team Board, reply requests) is always kept: that is the
`host.slice`. On top of it, by default:

| Kind | What is copied | Answers |
|---|---|---|
| notes | the `.md` text of the vault; no dot folders, no `_attachment`, nothing over 1 MB, none of the folders the user left out | `note_read` (by path, id or title), `note_search` (keyword, every word, title first; the server's search exclusions apply) |
| memory | the global and user memory documents | `memory_read` |
| skills | every skill `skill_read` can open | `skill_read` |

The Mac sends each kind as a manifest of `{key, sha256 head, size, metadata}`
(`replica.sync`); the host names the bodies it lacks, and the Mac sends those
on the bulk channel (`replica.put`, at most 512 KB a frame). The host stores a
body only when its hash is the one the manifest named, so a note edited between
the two steps is sent on the next round, never a mixed one. A note keeps its old
text until its new one arrives; a key gone from the manifest leaves the host.
The copy lives in the daemon's state dir (`~/.open-walnut/tmp/host-replica` on
the Mac, the daemon's own dir elsewhere), files 0600, file names hashed from the
keys, never the keys themselves. A round runs when the host connects, a few
seconds after a note, memory or the settings change, and every 5 minutes; a
round that finds nothing changed sends nothing.

When the copy answers: the host has no server, or the server has missed 3
keepalive beats (a Mac asleep with its sockets still open), or a relayed read
timed out. Beats are counted, not wall time, so a daemon that was itself
suspended does not judge the server by the time it slept. A server that missed
3 beats is away for every call, not only reads: the host's own task and Board
writes are made on the host and journaled at once, messages between its
sessions are delivered by the host, and what needs the leader goes to the
companion while it leads or is refused at once instead of after a 20 s
timeout. A relayed write that times out is never answered from the host: the
server may have applied it. Every answer says it came from the copy and how
old it is (`offline: true`, `as_of`); note search from the copy says
`degraded: 'offline-keyword'`.

`hosts.<alias>.keep` (Settings, Remote Hosts, Edit): `notes`, `memory`,
`skills` switches and `notes_exclude` folders. A kind turned off is removed from
the host (`replica.drop`), and its reads go to the server again. The commands
are trusted-socket only: the companion's bridge can neither send nor read a
copy. An old daemon (no `host-replica-v1`) keeps no copy and is never sent one.

## The companion's copy of the tasks

The companion keeps an exact copy of the Mac's task store: every task with
every field (description, notes, parent, folder, session links), done tasks of
any age, the projects, folders and custom tiers, and the store's order. It is
kept the way a host's copy is (`src/core/replication/task-replica.ts` on the
Mac, `task-replica-store.ts` on the companion):

1. The Mac sends a manifest, every task id with the sha256 head of its row in
   store order, to `POST /bridge/replica` (same machine credential and gzip as
   `/bridge/ingest`).
2. The companion removes the rows the manifest no longer names, follows its
   order, and answers the ids it lacks or holds at another hash.
3. The Mac sends those rows, at most 512 KB a request. The registry rides
   beside them as one document.

A round runs a few seconds after a task or registry change, and every 5
minutes. An unchanged manifest is sent again only by the 5-minute round, which
is how a companion that lost its copy is found. The Mac hashes a row once per
change (an unchanged row keeps its object in the store's cache), so a round
over thousands of tasks costs only what changed.

A row the companion wrote itself is **held**: it is neither replaced nor
removed while its op waits in the companion's task queue, while a delete
tombstone covers it, or for 30 seconds after the write (its relay to the Mac
may still be in flight). The companion says how many rows it held; the Mac then
sends the manifest again 35 seconds later, and once the Mac applied the write,
the Mac's row comes back. A manifest that would remove more than half of a
store of 50 or more rows is refused: a Mac that lost its store must not empty
the copy, which may then be the only one left.

What it replaces: the import of the slim task projection into the companion's
store (no description or notes, done tasks for 14 days only, deletes guessed
from absence). That import stands down while the copy is fresh (a manifest in
the last 15 minutes), and for any projection older than the copy, so an old
projection cannot bring back a removed row. An older Mac that sends only
projections is still imported. The phone's task list there is built from the
copy (as it was from the imported rows), and task detail answers from it
instead of asking the Mac (which waited 5 s and gave up while the Mac slept). The copy is kept in `cache/task-replica.json` (row hashes, order, the
Mac's clock), so a companion restart asks for nothing again. A companion
without the route answers 404, and the Mac rests the lane for 10 minutes.

## One request path on the companion

The companion is the same Walnut server with a public address. While the Mac
answers, a phone's `/api/v1` call to the companion is carried to the Mac and
answered there; while it does not, the companion's own route answers it. The
phone keeps one address, and no route needs its own relay to reach the Mac.

```
phone ──HTTPS──► companion  /api/v1 forward (src/web/v1-forward/proxy.ts)
                   │ the Mac answers?  yes: session.control "server.http" over /bridge
                   │                   no:  the companion's own route
                   ▼
                 Mac's daemon ──► Mac server: runForwardedCall (target.ts)
                                  loopback call to its own /api/v1, as a paired client
```

**When the Mac answers** (all of them, from the companion's view):

- the Mac's bridge is connected and its heartbeat is fresh (less than
  min(three beats, the takeover window) old);
- the companion leads no host;
- the user allows the companion to stand in (`cloud_bridge.backup_leader`,
  carried on every heartbeat as `backup`). Off: the companion answers every call
  itself, as it did before;
- the Mac knows `server.http` (an older Mac answers "unknown control action",
  and it is not asked again for 10 minutes);
- no forward since the Mac was last heard went out and got no answer.

**Routes the companion keeps**, whatever the Mac does (`policy.ts`, one table
both boxes read): event and session streams; message sends (they have their own
lane); the Personal AI chat (its own relay to the Mac carries the turns the
companion answered alone, so the Mac adopts them); identity (`devices`, `setup`, `status`, `canary`, `me`, `instance`,
`routes`); bytes (media, voice, file content, images, note attachments, a
letter's document); the phone's own health and places data; the task copy
(`tasks`, `focus`, except a task's Board); paged session lists and
transcripts; session launch. A call to
any of these is answered there and never sent. The companion's own op calls (its
Personal AI, its gateway) keep their own path too: they are the companion
answering itself, never a phone on the Mac.

**What crosses**: the method, the path under `/api/v1` with its query, a JSON
body of at most 1 MB, and the content and cache headers. No credential, no
cookie, no Walnut caller header. The Mac refuses a path outside `/api/v1`, a dot
segment (encoded or not), a doubled slash, a line break, a body whose size does
not match, and any route the companion keeps, before any route runs. It runs the
call against its own server over loopback with `x-walnut-origin: remote-http`,
so the call has exactly the rights of a paired phone: an op only this Mac may
run (`health_status`, a `remote: 'deny'` op) is refused as it is for any phone.
A reply of at most 256 KB comes back with its status and headers (content,
cache, `x-walnut-*`); the companion marks every reply `X-Walnut-Answered-By:
primary` or `companion`.

**When a forward fails**:

| What happened | Read | Write |
|---|---|---|
| Never sent (no bridge lane) | answered here | answered here |
| The Mac refused it before the route ran | answered here | answered here |
| The Mac is too old | answered here, 10 minutes rest | answered here, 10 minutes rest |
| Sent, no answer in time (8 s read, 25 s write) | answered here; the Mac is not asked again until it is heard | 504 `primary_timeout`: it may have been applied, check before trying again |
| The reply is over 256 KB | answered here | the Mac's status, and a note that it was applied |

A write is never run on both boxes: once it was sent, only the Mac's answer or
"it may have been applied" comes back. At most 16 reads are in flight; more are
answered here.

**What it costs**: while the Mac answers, a read takes one bridge round trip
more than before. A Mac that falls asleep makes the first call wait out its
budget (8 s for a read); every later call is answered at once, and after
min(three beats, the takeover window) of silence nothing waits at all.

**Trust**: the forward gives the companion the rights of a paired phone on the
Mac, never more (a Mac-only op stays refused). Every phone call already passes
through the companion, so a companion that is broken into already sees what the
phone sends. The forward is gated on the user's backup leader setting all the
same.

`GET /api/leader` on the companion shows `forward`: how many calls went to the
Mac, how many were answered here and why, writes left unanswered, and the last
decision. `WALNUT_COMPANION_FORWARD=0` turns the forward off. Each box's request
log says it too: on the Mac a forwarded call carries `origin: remote-http`, on
the companion every `/api/v1` line carries `answeredBy`.

## Model and effort while the Mac is away

The phone's model picker for a session is a session control
(`/api/v1/sessions/:id/model-options`, `/model`, `/effort`). While the Mac
answers, it is the Mac's, as every other call. While the Mac is away the
companion answers from what it holds (`src/core/sessions/model-options-copy.ts`):

```
phone ──► companion ──(Mac away)──► the session's row in the Mac's last push
                                     (cli_model, effort, host) + that host's
                                     model catalog (host_model_catalogs)
       change, while it leads the host:
          companion ──/bridge──► host daemon: leader.settings {walnutId, epoch, sid, model|effort}
                                  │ fence: this lead's epoch, a session of this Walnut
                                  ├─ the CLI's own control_request apply_flag_settings,
                                  │  written into the live session, its answer awaited (10 s)
                                  └─ journaled as a `settings` record
          Mac wakes ──► offline.drain ──► the session record keeps the values (cold resume)
```

- **Away** is the forward's own view: no bridge, the Mac silent, a forward since
  its last beat unanswered, or the companion leading a host. Unknown (never
  heard) is not away: the call goes to the Mac as before.
- **Reading**: the session's row carries its CLI model and the effort in effect;
  the push to the companion carries each host's catalog beside the rows (only
  the models and their age; the Mac's own cache and the phone's projection stay
  without them). A host with no catalog gets the static model list. The answer
  is the Mac's shape plus `offline: true` and `asOf`. A session the copy does not
  list is asked of the Mac as before.
- **Changing**: only while the companion leads the session's host, and only for
  a session that runs there. A session on the Mac itself, or a host nothing
  leads yet, gets a 503 that says why and when to try again. A refused epoch lets
  the lead go. An older daemon (no `leader-settings-v1`) answers "not permitted
  over bridge", which the phone sees as `session_control_needs_upgrade`. A
  session that is not running is not woken: the values are journaled and
  `appliedLive: false` says so. Until the Mac pushes again, the picker shows what
  the companion applied.
- **The Mac wakes**: it takes the `settings` records with the rest of the host's
  journal and writes them into the session record; a live session object on the
  Mac adopts them without sending anything, so it never writes older values
  back.

## Settings

`cloud_bridge.backup_leader` (Settings, Phones & Cloud, "Cloud companion takes
over"), default on. Off: every host keeps to what it can do alone while the Mac
is away, and the companion answers every phone call itself. A change reaches
every host and the companion at once.

## Scenarios

| Scenario | Expected |
|---|---|
| Mac lid closed mid-turn, companion allowed | after the window the companion leads every host; messages between hosts keep flowing |
| Only the Mac to companion link is down | a host still hears the Mac, so nothing is taken over |
| Mac deploy restart | the restart notice holds the takeover off for 5 minutes |
| Mac wakes on the same sockets | the daemon tells it; it drains, takes the lead back; the companion lets go |
| Mac wakes after the daemons closed its sockets | it reconnects, drains, takes the lead back |
| The companion sends at an old epoch | refused by the host |
| A test server on a shared host | another walnut id: it gets no lead and no copy of the real Walnut |
| No companion | no takeover; every host keeps working alone, global writes wait |
| Mac asleep, a session reads a note | answered from the host's copy after 3 missed beats, with its age |
| Mac up but stuck, a session reads a note | the relay times out, then the copy answers; a write still times out |
| Mac asleep, a session updates its own task | written on the host at once and journaled; the Mac takes it when it wakes, on the same socket or a new one |
| Mac asleep, a session writes a note | refused at once (the note is the leader's), or done by the companion while it leads |
| Mac asleep, a session's context is compacted | `open_items` is answered from the copy, so the list of what is open comes back |
| Notes turned off for a host | its copy of the notes is removed; `note_read` there needs the server |
| The Mac creates or edits a task | the companion holds the new row within seconds, every field |
| Mac asleep, the phone or the leader opens a task | the companion answers from its copy at once, description and notes included |
| Mac asleep, the companion writes a task | written there and queued; the Mac's next manifest does not undo it; the Mac's row comes back once the Mac applied it |
| The companion lost its copy | the 5-minute round finds it and sends every row again |
| An older companion (no `/bridge/replica`) | the Mac rests the lane; the companion keeps importing the projection |
| Mac up, the phone asks the companion for usage | the Mac answers (the companion alone has no usage data) |
| Mac up, the phone writes the heartbeat checklist | written once, on the Mac; the companion's file is not touched |
| Mac up, the phone runs an op only the Mac may run | refused by the Mac, as for any phone |
| Mac asleep, the phone reads | the first read waits up to 8 s, then the companion answers; later ones at once |
| Mac asleep mid-write | 504 that says it may have been applied; never run a second time on the companion |
| "Cloud companion takes over" off | the companion answers every call itself |
| An older Mac (no `server.http`) | the companion answers, and asks again 10 minutes later |
| Mac asleep, the phone opens a session's model picker | the companion answers from the Mac's last push at once, marked `offline` |
| Mac asleep, the phone switches a remote session's model or effort | the companion has the host apply it to the live CLI; the Mac keeps it when it wakes |
| Mac asleep, a session on the Mac itself | the picker reads from the copy; a change says the Mac is offline |
| Mac asleep, the companion not leading yet | a change says it takes over within about a minute |

## Tests

- Unit: `tests/providers/leader-core.test.ts`, `tests/core/leader-takeover.test.ts`,
  `tests/core/backup-leader.test.ts`, `tests/core/backup-gateway.test.ts`,
  `tests/providers/offline-host-leader.test.ts`, `tests/providers/offline-board.test.ts`,
  `tests/providers/leader-twins.test.ts` (both daemon twins).
- Simulated cluster, every core real: `tests/core/leader-cluster-sim.test.ts`.
- Real daemon processes (both twins, a SIGSTOPped primary):
  `tests/integration/leader-takeover-twins.test.ts`.
- Real servers (a primary and a cloud-mode companion, three daemons):
  `tests/e2e/leader-takeover-live-e2e.test.ts`; the companion's own op calls:
  `tests/web/self-call-auth.test.ts`.
- The setting, both engines: `tests/e2e/browser/devices-backup-leader.spec.ts`.
- The host's copy: `tests/providers/host-replica-core.test.ts` (the daemon
  core), `tests/core/host-replica.test.ts` (the Mac's rounds against the real
  core), `tests/providers/host-replica-twins.test.ts` (both twins),
  `tests/integration/host-replica-twins.test.ts` (real daemon processes behind
  a freezable link: asleep, stuck, gone, restarted, notes turned off; asleep
  also covers an own write journaled and taken on wake, and a write only the
  leader can make refused at once), `tests/providers/offline-open-items.test.ts`
  (`open_items` from the copy, worded as the server words it), and the
  per-host list, both engines: `tests/e2e/browser/remote-hosts-keep.spec.ts`.
- The companion's copy of the tasks: `tests/core/task-replica.test.ts` (the
  Mac's rounds against the real companion store: every field, only what
  changed, removals, order, held rows, restart, the projection standing down),
  `tests/web/routes/bridge-replica-cloud.test.ts` (the route on a real
  cloud-mode server, over the real client), and the live e2e above (every task
  on the companion, a new one within seconds, task detail from the copy while
  the Mac sleeps, the companion's own write delivered and its row the Mac's
  again after the wake).
- One request path: `tests/web/routes/v1-forward-policy.test.ts` (the route
  table, paths, headers), `tests/web/routes/v1-forward-target.test.ts` (the
  Mac's half against a real HTTP server and through the relay entry),
  `tests/web/routes/v1-forward-proxy.test.ts` (every decision of the
  companion's half), and `tests/e2e/companion-forward-live-e2e.test.ts` (a real
  Mac server and daemon, a real cloud-mode companion: usage, a read and a write
  answered by the Mac, a Mac-only op refused, the setting off and on, the Mac
  asleep and awake), `tests/web/request-logger-forward-fields.test.ts` (the log
  fields).
- Model and effort while the Mac is away: `tests/providers/live-settings-core.test.ts`
  (the daemon core: the CLI's line, its answer, a session not running, bad
  values), `tests/core/model-options-copy.test.ts` (reading and changing from
  the copy), `tests/core/session-projection-model-fields.test.ts` (the push),
  `tests/web/routes/api-v1-session-control-mac-away.test.ts` (the routes),
  `tests/core/offline-handover-settings.test.ts` (the Mac keeps them on wake),
  `tests/providers/leader-twins.test.ts` (both twins),
  `tests/integration/leader-takeover-twins.test.ts` (real daemon processes: a
  live session's CLI gets the change, an old epoch is refused), and the live
  e2e above (the phone's picker and switch on a real companion while the Mac
  sleeps, the Mac's record after the wake).

## Not yet

- The companion's copy of the other stores (sessions, reply requests, inbox,
  routines), retiring the task projection push once every companion takes the
  copy, and retiring the companion's special-purpose queues.
- Writes to a host's own work made on the host even while the Mac answers.
  Messages between a host's sessions already are (docs/plan/daemon-first-hosts.md
  "Same-host messages while the server answers").
- A daemon as a leader (a host that reaches every other host).
- Answers the companion gives alone while the Mac is away for what only the Mac
  holds today (usage, search): copies of those stores, and the other session
  controls (stop, interrupt, permission mode) sent straight to the host's daemon
  while the companion leads.
- Search on a host while the Mac is away, over its own copy (keyword first; the
  Mac's vectors and a query embedder for meaning). While the Mac answers, search
  stays on the Mac.
- Calls the forward cannot carry yet: a device's own identity (`devices/self`,
  `instance`, `routes` stay the companion's), replies over 256 KB, and non-JSON
  bodies.
