# Replica servers: the same Walnut server on every machine

Status: design (2026-10-13). Builds on [servers everywhere](./walnut-servers-everywhere.md)
(the host server, one kind of link, byte streams through a daemon) and
[the control plane](./walnut-control-plane.md) (the leader book, the epoch, the
copies, the host journal).

## Goal

A person scans one QR code with their phone and Walnut works: with the Mac awake
or asleep, with or without a cloud companion. Most people have no companion. They
do have a host their Mac already links to (a cloud desktop that runs their remote
sessions), so that host is the front door, and while the Mac is away it has to be
a working Walnut, not a page of last resort.

## Where we are

| | Mac | Cloud companion | Host server |
|---|---|---|---|
| Program | `walnut web` | `walnut web` with `WALNUT_CLOUD_MODE=1` | `walnut host-server` (`src/host-server/`, about 1,500 lines): a front door, not the server |
| Copies it holds | owns every store | tasks (exact), search index, devices; a session projection | tasks (exact), search index, devices |
| Leader answers | | `/api/v1` forwarded as `server.http` over the bridge (1 MB in, 256 KB out); the web console's `/api/*` answered from its copies | every byte forwarded on a stream through the host's daemon |
| Leader away | | full console from its copies; about 570 `CLOUD_MODE` branches in 152 files; its own queues | the "alone" page: this host's sessions only (read, send, answer a prompt) |
| Sessions | runs them | none; controls through host daemons | send and permission answers through its daemon |

Three consequences:

1. On a host, the Mac away means Walnut is not usable, although the host already
   holds the task store and the search index.
2. What the companion does differently lives in branches on one flag, not in a role.
3. There are two ways to reach the leader, with different limits.

## Target: one program, two roles, three placements

```
                 leader                          replica
program          walnut web                      walnut web --replica (same build)
data             owns every store                copies of the stores it serves, from the leader
writes           applies them                    leader answers: forwards them, never applies
                                                 leader away: its own domain applied and journaled,
                                                 a queueable global op queued, anything else "needs the Mac"
placement        the Mac                         host: a local daemon, local sessions
                                                 cloud: no local daemon, a public address
```

The companion is a replica with two traits: it is placed in the cloud (its daemons
dial in to it, it runs no session), and it may stand in as the leader (the leader
book and the epoch, control plane doc). A host replica never stands in as the
global leader in this design, but it always leads its own host's domain (below).

Role and placement are configuration, read through capabilities. Code never asks
`CLOUD_MODE`:

- `role()`: `leader` or `replica`; `leaderAnswers()` (exists, `src/core/server-role.ts`)
- `placement()`: `mac`, `host` or `cloud`; `hasLocalDaemon()`, `runsSessions()`
- `canStandIn()`: true on the companion when the user allows it

## The link: one abstraction for every connection

A server talks to daemons, and only to daemons. Every connection is a **link**,
whatever dialled it:

```ts
interface Link {
  readonly peer: { host: string; walnutId: string }
  state(): 'up' | 'down'
  /** Milliseconds since the last frame from the peer (frames, not the socket: a sleeping Mac keeps its sockets). */
  heard(): number
  request(cmd: string, params: unknown, timeoutMs?: number): Promise<unknown>
  on(event: string, cb: (data: unknown) => void): () => void
  /** A byte stream through the daemon to another server it links ('leader', a replica id). */
  openStream(to: string, door: 'web' | 'replica'): Promise<Duplex>
}
```

| Transport | Who dials | Used for |
|---|---|---|
| SSH forward, plus the stream lane | the Mac | the Mac to every host's daemon |
| loopback socket | the replica | a host replica to its own daemon |
| reverse WebSocket (`/bridge`) | the daemon | every daemon to the companion |

Today these are three classes with three APIs (`DaemonConnection`, the bridge
registry, `src/host-server/daemon-link.ts`). Stage 1 puts them behind `Link`.
Nothing above a link knows its transport: "connected" means the link is up and
frames arrive.

Server to server traffic is always a byte stream through a daemon both servers
link (exists: `stream-relay-v1`). The companion's `server.http` JSON forward
becomes a stream too: the Mac's own daemon already links the companion over the
bridge, so the companion opens a `web` stream to the leader through it. One
forward path for every replica (`src/host-server/proxy.ts`), WebSockets
included, no size caps.

## Routing on a replica: one table

Every route declares its class once, as route metadata read by one dispatcher in
front of the routes:

| Class | Leader answers | Leader away |
|---|---|---|
| `leader` (the default) | forward the bytes on a stream | reads from the copy; writes journaled, queued, or `503 needs_leader` |
| `local` | answered here | answered here |
| `feature` | ordered engines (`src/core/feature-route.ts`): the leader's, this server's, a hosted API | the same list without the leader's |

An unlisted route is `leader`, so a new route works through every replica without
a line of replica code (the property the companion's `policy.ts` has today).

`local` is for what the host's daemon owns and the leader only relays: the bytes
of this host's sessions (stream, history, transcript), its files, its git diffs,
its terminal, its health. It removes the hairpin: a phone reading a host session
through the host today goes phone, host, Mac, host's daemon, Mac, host, phone; as
`local` it goes phone, host server, host's daemon. What the leader enriches (a
session's state on the board, task joins) stays `leader`.

While the leader answers, a replica never applies a write: one writer. A write
that was sent and got no answer is `504 primary_timeout` ("it may have been
applied"), never retried on the replica, as on the companion today.

```
dispatch(req):
  cls = routeClass(req)
  if cls is local:   return handleHere(req)
  if cls is feature: return routeFeature(req)
  if leaderAnswers():
    return forwardStream(req, leader)
      on failure: a read is answered away; a write that may have arrived is 504
  return answerAway(req)

answerAway(req):
  read                        -> the route runs on the replica's stores; reply marked {offline, asOf}
  write, host domain          -> applied to the copy, appended to the host journal, row held
  write, queueable global op  -> queued in the same journal with an op id, applied to the copy, row held
  anything else               -> 503 needs_leader {why, retryAfter}
```

## What a replica holds

| Store | Today | For the leader away |
|---|---|---|
| tasks and the registry (projects, folders, tiers) | exact copy on both replicas (`task-replica`) | ready |
| search index | copy on both (`search-replica`) | ready |
| devices (token hashes only) | copy on both (`device-replica`) | ready |
| session registry (every session: task, host, state, model) | companion: a projection; host: none | exact copy |
| session transcripts | | this host's sessions: its daemon; others: the leader only, no copy |
| reply requests, inbox, routines and cron state, Ask Walnut history, Boards, UI prefs, favorites and ordering | none | a copy each |
| notes, memory, skills | the host daemon's copy (`host-replica`) | the replica reads that same copy: no second copy on a host |
| config | | a sanitized copy: no secret, no credential, plugin settings without keys |
| secrets, plugin credentials | never | never: a feature that needs one is `feature` with the leader's engine, or says so |

One generic replication kind does all of them: a manifest of `{key, hash}` in
order, the replica names what it lacks, the leader puts those, a row the replica
wrote itself is held until the leader's version comes back, and a manifest that
would remove more than half of a large copy is refused. `task-replica` already
works this way and becomes its first user; each new store is a table of keys and
rows, not a new protocol.

## Ownership and writes while the Mac is away

Two domains:

- **The host domain**: this host's sessions and their tasks (the `host.slice`),
  the team Board, triggers, reply requests between its sessions. The host writes
  them while the Mac is away, as its daemon already does (`offline-host-core.ts`).
  The replica server writes them through its daemon, into the host's one
  journal, so a session's `walnut` call and the phone's tap land in the same
  journal, in order.
- **The global domain**: everything else (a new task's placement, messages to
  another host, notes, settings). While a companion stands in, it goes there.
  Without one, a queueable op (task create, update, complete) is queued in the
  same journal with an op id made by the replica and applied to its copy at once;
  anything else answers `503 needs_leader` with the reason.

The Mac drains the journal when it is back (exists: `offline.drain`): in order,
idempotent by op id, field by field newest wins for a task's fields, a delete
wins, a request's state only moves forward. A real conflict becomes one inbox
letter (control plane rule); none means no letter.

**Sessions on its own host.** The replica is the server code, so it can build a
session's command line for its own host and ask its daemon to spawn it (the daemon
refuses today only because just the server builds one). The new session is a
record in the journal, which the Mac adopts on drain. Stage 4.

## Presence

`leaderAnswers()` is fed by links only: the leader book read over the daemon link
(the leader heard within 30 s, the window the daemon applies to follower writes,
so page and daemon agree), plus the last forward's outcome. The console hears a
change as one WebSocket event and shows one quiet line, "Your Mac is away. This
is the copy on <host> from 2 min ago."; an item whose write waits says "Syncs
when your Mac is back". When the Mac returns the line goes away; nothing reloads
under the person.

## Security

- A replica holds no secret and no credential of the leader; devices as token
  hashes only.
- Its writes reach the leader only through the journal drain, which the leader
  runs with the rights of a paired device, never more (an op only the Mac may run
  stays refused).
- The daemon's follower socket gains the read commands the `local` routes need,
  for its own Walnut's sessions only; never a configure command, never another
  Walnut's session.
- The companion keeps its narrow bridge set. Its streams to the leader carry the
  rights of a paired device (as the `server.http` forward does now).

## Scenarios

| Scenario | The phone sees |
|---|---|
| Mac awake, the host's QR code | the full console, the Mac answers; a host session's stream comes straight from the host |
| Mac asleep, no companion | the full console from the host's copy at the next request: board, tasks, notes, search, the host's live sessions; a new Ask Walnut runs as a session on the host (stage 4) |
| Mac asleep, the phone edits a task | saved at once, marked "Syncs when your Mac is back"; on the Mac after it wakes |
| Mac asleep, the phone creates a task | queued, on the board at once, the same mark |
| Mac asleep, a session on the Mac | listed from the copy, "Your Mac is asleep" instead of its controls |
| Mac asleep, the phone writes a note | "Needs your Mac" (a note edit is a document merge, not a field) |
| Mac wakes | the journal drains, the line goes away, the board shows the Mac's rows |
| Mac asleep, a companion stands in | the host forwards to the companion, as today |
| A write sent as the Mac fell asleep | `504`: "may have been applied", never applied twice |
| The replica restarts while the Mac is away | its copies are on disk; it answers at boot |
| A test server on the same host | another Walnut id: no copy, no journal, no lead (as today) |

## Stages

| # | Stage | Change for the person |
|---|---|---|
| 1 | `Link` over the three transports; the companion forwards on a stream | none (no size limits on the companion) |
| 2 | The host replica is `walnut web --replica` (same build): the dispatcher and route table; the Mac awake forwards as today, plus `local` routes for the host's sessions | host sessions open faster through the host |
| 3 | Copies of the remaining stores; the host replica answers reads from them while the Mac is away; the alone page retires | the full console, read only, while the Mac sleeps |
| 4 | Writes while away: the host domain through the journal, queueable global ops, sessions started on its own host | edit, create, start work while the Mac sleeps |
| 5 | The companion on the same path: `CLOUD_MODE` branches become `placement: cloud`, its own queues retire into stage 4's journal | none, less code |

Every stage ships behind a daemon capability; an old daemon or an old replica keeps
today's behaviour.

## Decisions

- A host replica leads its own host's domain and serves the console; it never
  takes the global lead (no epoch claim). The companion stays the only stand-in
  leader.
- Queueable while nobody leads: task create, update, complete. Not queueable:
  notes, settings, messages to another host (they wait for the Mac or a companion).
- Ask Walnut is a Claude Code session like any other. While the Mac is away a
  new ask runs as a session on the replica's own host (stage 4), with the same
  agent persona; an ask that runs on the Mac is listed from the copy and waits
  for the Mac.

## Tests

- Unit: the route table (every route classed, the default), the dispatcher's
  decisions, the generic replication kind (order, held rows, the half rule), the
  journal's op ids (applied once), the drain's merge rules.
- Real processes: a leader, a host replica and its daemon, the leader frozen with
  `SIGSTOP` (sockets stay open, as a sleeping Mac's): every scenario above, then
  `SIGCONT` and the drain, checked against the stores on disk.
- Browser, WebKit first: the phone through a fake tunnel to the host replica,
  Mac awake and asleep: the board, a task edit, a host session, the away line.
