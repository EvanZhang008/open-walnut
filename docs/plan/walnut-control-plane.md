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
- Reads and task writes outside every copy run on the companion's replica
  through the op registry, on the same routes the phone's calls reach; its task
  queue carries the writes to the Mac. A cloud-mode server has no loopback
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
suspended does not judge the server by the time it slept. Writes never come
from the copy: a write still goes to the leader, or queues or fails as before.
Every answer says it came from the copy and how old it is (`offline: true`,
`as_of`); note search from the copy says `degraded: 'offline-keyword'`.

`hosts.<alias>.keep` (Settings, Remote Hosts, Edit): `notes`, `memory`,
`skills` switches and `notes_exclude` folders. A kind turned off is removed from
the host (`replica.drop`), and its reads go to the server again. The commands
are trusted-socket only: the companion's bridge can neither send nor read a
copy. An old daemon (no `host-replica-v1`) keeps no copy and is never sent one.

## Settings

`cloud_bridge.backup_leader` (Settings, Phones & Cloud, "Cloud companion takes
over"), default on. Off: every host keeps to what it can do alone while the Mac
is away. A change reaches every host and the companion at once.

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
| Notes turned off for a host | its copy of the notes is removed; `note_read` there needs the server |

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
  a freezable link: asleep, stuck, gone, restarted, notes turned off), and the
  per-host list, both engines: `tests/e2e/browser/remote-hosts-keep.spec.ts`.

## Not yet

- The companion's full replica (a change stream of every store instead of the
  slim projections) and retiring its special-purpose queues.
- Writes to a host's own work made locally first and always journaled, even
  while the Mac is up.
- A daemon as a leader (a host that reaches every other host).
