# Daemon-first hosts: a host keeps working when the Walnut server is away

## Summary

Every `walnut` call a session makes (read its task, message a sibling, answer a
request, mark work done) travels from the host's daemon to the Walnut server on
the Mac. When no server is connected, the daemon answers `hub_unreachable` at
once. The Mac sleeps, laptops close, and every deploy restarts the server for a
minute or two, so this happens often: two sessions on the same dev box cannot
even message each other while the Mac is away.

This plan moves host-local work into the daemon and leaves global work on the
server. The rule is one owner per object, chosen by where the object lives:

| Object | Owner | Others hold |
|---|---|---|
| A session's process, FIFO, stream file, turn ends | that host's daemon (already true) | a mirror |
| A message between two sessions of one Walnut on one host, and its reply request | that host's daemon | a copy, handed over when the server reconnects |
| Tasks, projects, folders, notes, memory, the board | the server | a read copy on each daemon (only what that host needs) and a queue of writes made while the server was away |
| A message across hosts | the server | nothing |

The daemon plays the part a node agent plays in a cluster: the control plane
owns the desired state, the node keeps its workloads running and reports back
when the control plane returns.

## Why not consensus (Raft, a quorum)

- **It lowers availability in the case that matters.** Raft needs a majority of
  a fixed member set to write. The usual setup is the Mac plus one dev box: a
  majority of two is two, so the Mac going to sleep stops every write. The goal
  is the opposite.
- **The network is a star.** The Mac dials out to each host over SSH; hosts
  cannot reach each other, and usually cannot reach the Mac. Consensus needs
  links between members that do not exist.
- **There is almost no contention.** One user; two writers editing the same
  field of the same task inside one offline window is rare. An idempotent op
  queue with a last-writer-wins guard (what the cloud replica's task queue
  already does, `src/core/task-queue.ts`) handles it, and a skipped write is
  reported instead of silently merged.
- **The exactly-once questions are local.** Settling a reply request exactly
  once needs one owner, not a vote. A same-host request is owned by that host.

## Architecture

```
 today                                     this plan
 ─────                                     ─────────
 session A ─walnut─▶ daemon ─relay─▶ Mac   session A ─walnut─▶ daemon ─relay─▶ Mac      (server connected)
 session A ─walnut─▶ daemon ✗ hub_unreachable                  │
                                                               └─ offline host ─┐       (server away)
                                                                  read copy     │ task_get / task_list / session_list
                                                                  request rows  │ task_send to a session on this host
                                                                  journal ◀─────┘ task_update / task_complete (queued)

 reconnect:  Mac ─host.slice─▶ daemon      (read copy, tags the connection with the Walnut's data dir)
             Mac ◀─offline.drain─ daemon   (journal: request rows, settles, deliveries, queued writes)
             Mac: import rows, apply settles, replay writes through the op registry (same code as online)
             Mac ─offline.ack─▶ daemon     (drop what was applied; relay resumes)
```

### The read copy (`host.slice`)

The server pushes, per host, what that host's sessions need:

- `home`: the server's data dir. A daemon on a shared host can serve several
  Walnuts (the real one, a test server), and the spawn journal already records
  which Walnut started each session. Everything below is kept per `home`, and a
  session only ever sees its own Walnut's copy.
- `sessions`: this Walnut's sessions on the host, with task id and title.
- `tasks`: those sessions' tasks, their parents and their children (slim rows:
  id, title, phase, project, folder, parent, a clipped description, updated_at).
- `requests`: pending reply requests whose asker and target are both on the host.

It is pushed on connect and again (debounced, hash-skipped) when a task or
session changes, the same way hooks and triggers are pushed. The daemon
persists it, so a daemon restart while the Mac sleeps keeps it.

### Routing a gateway call

```
home = spawn journal home of the calling session
client = the connected server whose home matches, else an untagged server (old build)
client missed 3 keepalive beats?     → no client (a Mac asleep with its socket open is away)
journal pending for home?           → answer offline (the server is still taking the handover)
client found                         → relay (a read that times out is answered from the copy)
read copy for home exists            → answer offline
otherwise                            → hub_unreachable (unchanged)
```

A server that has stopped answering pings is treated as gone at once, for every
call, not after the socket is closed (8 beats) or a relay times out (20 s):
what the host does itself (reads, its own task and Board writes, messages
between its sessions) is done and journaled, the rest is refused at once or
goes to the companion while it leads. Nothing was relayed to it, so nothing is
applied twice. Its first pong makes it the client again, and the journal nudge
it finds waiting on the socket has it take the handover.

Matching by home also fixes a quiet bug: the relay used to pick "any connected
server", so on a shared host a test server could answer the real Walnut's calls.

### Offline answers

| Op | Offline behavior |
|---|---|
| `task_get`, `task_list`, `session_list` | from the read copy, marked `offline: true` with `as_of` |
| `task_send` to a session of the same Walnut running on this host | delivered into the target's FIFO with the same envelope the server builds (one shared envelope kit, `src/core/peers/envelope-kit.ts`), journaled |
| `task_send` with `expect_reply` (the default) | the daemon creates the request row and owns it: a reply settles it, the target's turn end without a reply sends the same notice the server sends (quoting the turn's result text) |
| `task_send` with `in_reply_to` | settles a row the daemon owns, or delivers the reply for a server-owned row from the read copy and journals the settle |
| `request_get` | rows the daemon owns or holds a copy of |
| `task_update`, `task_complete` | journaled with the caller and time, applied to the read copy so later reads agree, replayed through the op registry on reconnect |
| `note_read`, `note_search`, `memory_read`, `skill_read` | from the host's copy of notes, memory and skills, when the host keeps that kind (docs/plan/walnut-control-plane.md "What a host keeps"); also while the server is silent or a relayed read timed out |
| `open_items` (and the compact hook) | from the copy: the caller's unfinished subtasks, the requests it waits on and owes (with what this host settled or opened since), its Board; worded by the server's own formatter (`open-items-text.ts`) |
| anything else | `hub_unreachable`, with a message listing what works offline |

On the Mac, a session's `walnut` is the installed Walnut CLI, which talks to the
server over HTTP (the daemon's own `walnut` is first on PATH only on hosts
without an install). When nothing answers there, it hands the same call to the
session's host daemon through the agent socket the daemon put in the session's
environment, so Mac sessions get the same offline answers while the server
restarts.

What deliberately stays on the server: starting sessions (the launch recipe:
model, prompt, environment), creating tasks (placement rules), cross-host
messages, writing notes and memory, the human inbox.

### Handover

On reconnect the server takes the journal before it relies on its own view:

1. `offline.drain`: request rows are imported into `session-requests.json`,
   settles are applied (so the server's own turn-end hook finds the row already
   settled and stays silent), queued writes are replayed with the recorded caller.
2. A replayed write whose task changed after the write was queued is skipped and
   logged: an offline edit never overwrites a newer one. A write that did not
   land (skipped, task gone, or refused by the server's own rules) is told to the
   session that made it, in one Walnut notice per session.
3. `offline.ack` drops the applied records; the daemon relays again once its
   journal is empty. Records written during the handover are drained in the next
   round.

The server's fallback notifier waits for a running handover (bounded) before it
settles anything, so an offline reply is never followed by a "no reply" notice.

## Scenarios

1. **The Mac sleeps while two sessions on a dev box work together.** A asks B a
   question with `task_send`. The daemon delivers it into B's FIFO, B answers
   with `in_reply_to`, A receives the reply. When the Mac wakes, the server
   imports the request as replied and shows both messages in the timeline (they
   are in the stream files like any other message).
2. **B finishes without replying.** B's turn ends; the daemon sees the result
   line and sends A the usual notice, quoting B's final text.
3. **A session on a dev box marks its task done during a deploy restart.**
   `task_complete` is journaled and answered `queued`. The server comes back,
   replays it, and the task is complete on the board.
4. **The phone edited the same task meanwhile.** The replayed write finds a
   newer `updated_at`, is skipped, and the session that queued it is told so.
5. **A test server is attached to a shared host.** Calls from the real Walnut's
   sessions are relayed to the real Walnut or answered offline, never to the
   test server.

## Phases

| Phase | Scope |
|---|---|
| 1 (this change) | read copy, home-aware routing, offline reads, same-host messaging with request rows and turn-end notices, queued `task_update` / `task_complete`, handover |
| 2 | trigger fires delivered to same-host sessions by the daemon (done: the daemon arbitrates every fire, `trigger-claim-v1`, see docs/plan/walnut-trigger.md "Who delivers a fire"); a server that stopped answering pings is away for every call at once (done); same-host messaging owned by the daemon even while the server answers (open, see "Same-host messages while the server answers") |
| 3 | the cloud companion as the fallback hub for cross-host and global ops while the Mac is away (done: the companion is the backup leader, see docs/plan/walnut-control-plane.md); the team Board kept on the host (done: `board_*` answered from the copy and journaled); notes, memory and skills read from the host's own copy, with a per-host list of what it keeps (done: `host-replica-v1`) |
| later | offline session start, once the launch recipe can be cached per project |

## Same-host messages while the server answers

Not done, on purpose for now. The daemon's delivery is the simple one a host
can do alone; the server's send does more, and a message between two sessions
on one host would lose all of it if the daemon took it while the server answers:

- a target waiting on a tool permission prompt gets the message parked until
  the prompt is answered, not written into the middle of it;
- a peer's queue is capped, and the throttle is shared with every other path;
- an answer goes to the session the asker continues in (a fork), not the row's;
- the server's message queue drives what the web and phone show for the send.

Moving them means a second message queue in the daemon. Until then a host
delivers itself only while the server is away or silent, which is when it matters.

## Known limits of phase 1

- A session that has been idle for two hours with no server attached is stopped
  by the daemon's idle reaper, and restarting it needs the launch recipe, so a
  message to it waits for the server.
- `walnut wait <task>` offline only sees the phase the read copy had; waiting on
  a request id (`rq-…`) works, since the daemon settles its own rows.
- A message delivered while the target is mid-turn only counts the NEXT turn
  end as "finished without replying", because the CLI may take it into the
  current turn or queue it for the next one.
- `task_complete` offline checks the children the copy knows of; the server
  checks again on replay, and a refusal there reaches the caller as a notice.
- A server too old to drain the journal gets the host's relays only while the
  journal is empty; with records pending, the host keeps answering itself until
  a current server takes them.
