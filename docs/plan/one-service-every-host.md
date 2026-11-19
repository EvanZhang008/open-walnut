# One service on every host

Status: decided (2026-11-18). Builds on [servers everywhere](./walnut-servers-everywhere.md),
[replica servers](./walnut-replica-servers.md), [daemon-first hosts](./daemon-first-hosts.md),
[the single file](./walnut-single-binary.md) and [daemon boot start](../reference/daemon-boot-start.md).

## Summary

Every machine Walnut uses runs the same thing: **one program, one process, one API.**

- **One program**: the `walnut` file, the same version for everything on a host.
- **One process**: the **service**. It answers every call, decides, stores, and starts and watches the
  processes that do the work. There is no separate daemon.
- **One API**: the UI, the phone, a session's or a job's `walnut` call, and another machine all speak the same
  HTTP and WebSocket API. A call is answered where the thing lives, or forwarded to the host that owns it.

The Mac is not special. Its service plays the **leader** role (its data is the truth); every other machine's
service plays **follower** (a copy of what it needs), and works **alone** while it cannot reach the leader,
then hands the leader what it wrote.

Today a host runs two programs with two versions, the server and the session daemon, with a protocol between
them. The daemon exists so that a server deploy never ends a running agent. That reason is gone: agents are
detached processes recorded on disk, and whoever starts next adopts them.

## Rules

1. **One program, one version per host.** Nothing on a host asks what version its neighbour runs.
2. **The service answers, decides and stores.** Everything with state is ordinary code on its main thread,
   calling each other directly.
3. **One API.** No second protocol between two parts of Walnut, on one machine or between machines.
4. **Work runs where it lives.** A session is started, fed, read and judged by the service of the host it runs
   on. Another machine only shows it.
5. **What must outlive a restart is a detached process recorded on disk**: agent CLIs, plugin jobs, terminals,
   check scripts. After any restart the service adopts them from that record.
6. **The main thread never blocks.** A worker takes only pure heavy work: data in, a result out.
7. **Role decides behaviour, never a host name** (`role()`, `isFollower()`, `hasCapability()`). The leader role
   can sit on any machine a person owns.
8. **A host keeps working with the leader off.** A caller on a host talks only to that host's service.

## The shape

One host:

```
systemd user unit / @reboot cron / LaunchAgent
  boot start           a small shell script: starts the service, restarts it, rolls a bad version back
    service            walnut serve      one process, the same on every host
      main thread        the API (UI port, local socket, host link), task and session logic,
                         starting and watching processes, the only writer of data
      workers            pure heavy work only: large parses, merges, heavy queries

  kept processes (detached, listed in a registry on disk, adopted by pid and start time)
      agent CLIs    plugin jobs    terminals (dtach)    check scripts
```

Several hosts:

```
                 browser / phone
                       |   any service serves the UI and the API
   +-------------------v-----------+       the same API       +-------------------------------+
   | service, role leader (Mac)    | <----------------------> | service, role follower (host) |
   | the truth: tasks, board, org  |  copies down, journal up | a copy of what it needs,      |
   |                               |  forwarded calls, streams| its own sessions and jobs     |
   +-------------------------------+                          +-------------------------------+
                     leader unreachable: the follower works alone and journals its writes
```

## Decisions

| Question | Decided | Turned down, and why |
|---|---|---|
| language | TypeScript on bun, one compiled file | a rewrite, or a second language for the backend: 750k lines, and no kept stall profile shows slow computation |
| processes per host | one service | server and daemon: two versions, a protocol, and task logic written twice |
| threads | the main thread for everything with state; workers for pure heavy work | the daemon as a worker thread: it shares no objects with the rest, so the protocol would stay |
| what keeps the service alive | the boot start script hosts already have | a new launcher program |
| upgrade | stop, then start, with proof boot, probation and rollback | a new version taking over beside the old one: two processes on one data directory, to save a pause that agents do not feel and clients retry through |
| data across machines | one leader; followers that work alone and hand over a journal | every machine writing everything and merging, or one owner per task: both spread the board's and the org's rules across machines |
| protocol between machines | the API | process-level commands with a capability list per command |
| plugins | a plugin's host work runs in its own job process, beside the service of its host | plugin work inside the service |

## What others do

| | T3 Code | Walnut today | Walnut after |
|---|---|---|---|
| per machine | a launcher and one full server | a server (Mac, and hosts that turn one on) and a daemon | one service |
| agents owned by | the server | the daemon | the service |
| agents across an update | killed, then resumed from the stored session id | keep running | keep running |
| a remote machine | its own full server, no shared data | a daemon; a replica server where enabled | its own service with a copy of the leader's data |
| native code | three small helper programs (process metrics, window capture) | none | none; one hot spot at a time if a measurement asks for it |

## Today, measured

Read from the source and from the maintainer's machines on 2026-11-18.

- **One file already holds both programs.** `walnut web` and `walnut __daemon` are subcommands of the same
  compiled file (`src/binary/main.ts`), 122 MB, built for six targets. Every connected host runs the daemon
  from a compiled file.
- **The daemon is large and written twice.** `daemon-standalone.ts` 14.9k lines, `daemon-core.ts` 2.9k, 85
  `*-core.ts` modules 46.5k. `daemon-source.ts` (17.4k) repeats the first by hand, for a host that runs it
  from source under bun or node. On the server side, the code that talks to the daemon is 16.4k lines
  (`daemon-connection.ts`, `remote-session-manager.ts`, `local-daemon.ts`, `daemon-capabilities.ts`).
- **Agents already live through a restart of what watches them.** A CLI is spawned detached, its stdin a FIFO,
  its output appended to a file; nothing is piped to the daemon. `sessions.json` is rewritten atomically on
  every change. A new daemon adopts each entry whose pid is alive with the recorded start time
  (`reconcileRegistry`). Plugin jobs are adopted the same way. Terminals run under dtach. Check scripts are
  short and simply run again.
- **The boot start already exists.** On a dev host a small shell script, started from the crontab, had been
  keeping the daemon for four days, with a versions directory, a proof boot of a new build, a 15 minute
  probation and rollback (`daemon-service-*.ts`). The Mac has none: its Walnut does not start after a reboot.
- **A host can already run a server.** With `hosts.<key>.server.enabled`, the Mac pushes the file, and the
  host's daemon starts `walnut web --replica`, restarts it and adopts it. That replica talks only to its host's
  daemon, which relays its bytes to the Mac. On a dev host with 19 agents it used 311 MB right after a start,
  the daemon 246 MB.
- **Two ways to make a `walnut` call.** A session on the Mac calls the server's API. A session on a host calls
  a socket in its daemon, which relays to the Mac; with the Mac away the daemon answers a subset itself from a
  pushed copy and a journal (`offline-host-core.ts`, 3.3k lines): task logic written a second time.
- **A deploy stops the old server before the new one listens.** Observed gaps: 3.5 s, 15.4 s, 15.8 s. Agents
  are not affected.
- **Load is not CPU.** With 10 sessions the Mac's server used about 0.3 of a core and its daemon 0.07, on 14
  cores. Of 9 holds of the main thread of a second or more in 24 hours, 8 were the machine not giving the
  process a core. The kept CPU profiles show what holds the main thread: starting child processes (6 to 21%),
  `JSON.parse` of large payloads (3 to 22%), synchronous SQLite statements (up to 48% in one), synchronous
  file reads (42% in one). Each output line of a session is parsed three times: once in the daemon and twice
  on the Mac's main thread, for the sessions of every host.

## What moves

| Piece | Today | After |
|---|---|---|
| start, adopt, stop agents; stdin; output tail | daemon process | the service of that host |
| judging a session's output (status, turn end, usage, hints) | the Mac's server, for every host | the service of the session's host |
| plugin jobs, check scripts, terminals' attach | daemon process | the service |
| a session's or a job's `walnut` call | a socket protocol in the daemon; on the Mac, the API | the API on a local socket, on every host |
| answering with the leader away | daemon (`offline-host-core.ts`) | the follower's own task logic, role alone |
| the copy of the leader's data, and the journal of writes made alone | pushed to and kept by the daemon | the follower's data layer |
| starting a session on a host | the Mac builds the command line, the daemon runs it; a pushed template when the Mac is away | the host's service builds and runs it with the code the Mac uses |
| clocks and trigger decisions | daemon | the host's service |
| keeping things alive | hosts: boot start keeps the daemon, the daemon keeps the server. Mac: a launchd job from the deploy script | boot start keeps the service, everywhere |
| the link to another machine | the Mac sends each daemon commands; a replica's bytes are relayed by its daemon | services call each other's API |
| upgrade | two: a server deploy, and a daemon update with its own gap and holds | one |
| the leader's truth, the board, the org, search | Mac server | Mac service (unchanged) |

## Scenarios

**A. The Mac is off; a plugin job on a dev host receives work.** The job calls its host's service: create a
task, start a session, add a tag. The follower is alone, so it writes the task to its journal, starts the
agent itself, and answers the job from its copy plus the journal. When the Mac is back, the journal drains
once (existing protocol: op ids, base values, idempotent), and the task and its session appear on the board.
Nothing in the job's code asks whether the Mac is there.

**B. A deploy while ten agents run.** The service writes down what it holds and stops; the boot start runs the
new version, which adopts the agents and listens. Agents never notice. A browser reconnects. A session's
`walnut` call made in those seconds is retried by the CLI.

**C. A bad version.** The new service does not stay up through probation. The boot start switches back to the
last good version and reports the bad one to Walnut Health. Agents kept running; their output waited in their
files.

**D. The service crashes or hangs.** A crash: the boot start runs it again. A hang: the service stops touching
its heartbeat file, the boot start ends it and runs it again. Either way it reads the registry and adopts
every live process, the same path as after an upgrade. Messages queued on disk are delivered.

**E. A host reboots.** The boot start runs the service. Agents ended with the machine; the service resumes
only what today's restart rules resume.

**F. From the Mac, the user opens a session that runs on a host.** The Mac's service calls that host's service
and streams what the UI needs. The host's service is the one that tails and parses the output.

**G. A new host.** Settings adds it; the Mac pushes the file once; the boot start is installed and starts the
service as a follower. No second artifact, no second version to track.

**H. A test or isolated server.** `walnut serve` with its own data directory and no boot start. It keeps its
own registry there and ends its agents on exit, as a non-production daemon does today.

## Inside the service

| Runs on | What | Rule |
|---|---|---|
| main thread | the API, task and session logic, starting and watching processes, the only writer of data | never blocks: no synchronous process call, no large synchronous read or parse |
| workers | pure heavy work: parse of a large payload, a merge, redaction, rebuilding a session's fold at adoption, a heavy query on a second SQLite connection | data in, a result out; a worker holds no state another part needs |
| separate processes | agents, plugin jobs, terminals, check scripts | what must outlive a restart, and plugins |

- The part that starts and watches processes has a small typed interface (start, adopt, stop, send, events)
  and imports no task logic. A test holds that boundary, so the part that keeps agents alive stays small and
  changes rarely.
- A worker is not a place for a subsystem. It has its own memory and cannot use the main thread's objects, so
  anything that talks to the rest often would need a message for every interaction.
- The daemon's code may block today (12 synchronous process calls and about 490 synchronous file calls across
  its files). A module moves into the service when its process calls are async and the file calls on its hot
  paths (the output tail, the registry write) are async or bounded. Small, rare reads may stay.
- A move of work to a worker follows a measurement: a stall profile that names it. Each move adds its guard to
  the existing ratchet (`tests/core/event-loop-blocking-ratchet.test.ts`).
- Child processes the main thread starts on a timer (git status, `sysctl`) go through one small pool with a
  cache and a deadline.

## Lifecycle

```
boot start (shell; from systemd, cron or launchd):
  loop:
    run versions/current/walnut serve
    it exits                                  -> run it again, with backoff
    its heartbeat file is older than 60 s     -> end it, run it again
    a new version fails during probation      -> current = last good; report the bad version

upgrade:
  the new file is staged and proof-booted in a throwaway directory
  the service flushes, writes down what it holds, and exits
  the boot start runs the new version; it adopts and listens
  15 minutes without a crash                  -> it becomes the last good version

adoption, at every start:
  for each registry entry: the pid is alive and its start time matches
      -> tail its output from the last complete line; deliver what is queued for it
  otherwise -> report it as ended
```

On macOS the service runs under the app's session host, as the server and the daemon each do today, so
permission prompts still name Walnut: one chain instead of two.

## Roles and data

- The leader's data directory is the truth. A follower holds copies scoped to what the host needs (every
  project whose default host it is, every task with a session there, the tasks of plugins whose jobs run
  there) and its journal. A read alone folds the journal over the copy, with one fold shared by every reader
  (`core/offline-merge/task-row-fold.ts`).
- The existing table decides each call (`src/replica/route-table.ts`): answered here, a feature of this box,
  or the leader's.

| A call on a follower | Leader reachable | Leader away |
|---|---|---|
| read a task this host holds | the copy | the copy with the journal folded in |
| create or change a task | forwarded; the leader writes | journaled; answered from the fold |
| start a session on this host | started here; the record is synced | the same; journaled |
| message a session on this host | its FIFO | its FIFO |
| message a session elsewhere | through the leader | held; the caller hears "queued" |
| what only the leader has (the org, search by meaning) | forwarded | refused, with `needs_leader` |

- The drain on reconnect is the existing protocol, served by the follower's service. The leader stays the only
  writer of truth.
- What may be copied to which host follows the existing replica rules (`replica-targets.ts`). A task marked
  local to one machine is never copied.
- A follower turns heavy features off by capability, as a replica does today.
- Because role is a setting and every host runs the same service, a person with an always-on machine of their
  own can later put the leader there. Nothing in this design depends on the leader being a laptop.

## Compatibility

- A host still on a separate daemon keeps working with a new leader, through today's daemon protocol, until
  the last phase. The leader tells the two kinds of host apart by capability.
- A host the file cannot run on (an old C library, an unusual CPU) stays on the source daemon and is shown as
  a limited host: agents run there, nothing works with the leader away.
- At the switch on a host, the service adopts the agents the daemon was running, from the same registry
  files. No agent ends.
- Going back: the previous release starts the separate daemon again, which adopts the same registry.
- `/api/v1` (the phone app) does not change. `walnut web` stays as a name for `walnut serve`.
- Between machines on different versions the API is the contract: changes are additive, and a route a host
  does not have yet answers "not supported" so the caller can fall back.

## Phases

Each phase lands alone and leaves production working. The system is simpler after each one, and it is already
the target shape for callers after phase 3.

| # | Phase | Done when |
|---|---|---|
| 1 | **A follower on every host, and it works alone.** Every host gets the follower server (today opt-in). A session's or a job's call on a host goes to that host's follower. Alone mode answers with the real task logic and its own journal, replacing the daemon's offline answers. A follower can start a session by itself. | with the Mac's service stopped, a plugin job on a host creates a task, starts a session and tags it; after the Mac returns the board shows them once, and a second drain changes nothing |
| 2 | **The service is the root on every host.** The boot start runs `walnut serve`, on hosts and on the Mac. The service starts the daemon from its own file and adopts it, so a host has one version. | a service ended by hand is back within seconds with its agents; a build that cannot stay up is rolled back without a person; the Mac's Walnut is back after a reboot |
| 3 | **One API; work runs where it lives.** Local callers use the API on a local socket. The leader reaches a host through its service's API. A session is run and judged by its host's service. The source twin and the checks for a daemon older than its server are deleted. | the Mac's main thread parses no line of a session on another host; the daemon protocol has one caller, the service beside it |
| 4 | **The daemon's modules move into the service**, one at a time (calls from sessions and jobs, clocks, plugin jobs, then agents), each once its blocking calls are gone. | no daemon process and no protocol to it; the main thread's stall count has not risen |

Beside the phases, the main thread is cleared one measured item at a time: spawns through a pool, heavy
statements and large parses to workers, the remaining synchronous file reads to async.

A plugin whose logic runs in a job on a dev host ships on phase 1.

## Budgets

| | Today | Target |
|---|---|---|
| Walnut processes to keep alive on a host | 2, with 2 versions | 1 |
| protocols between parts of Walnut | the API, the daemon's commands, the session socket, the replica relay | the API |
| copies of task logic | 2 | 1 |
| an agent ended by a deploy | 0 | 0 |
| deploy gap, stop to listening | 3.5 to 15.8 s | 5 s or less in 9 of 10 deploys |
| holds of the main thread of a second or more, caused by our own code | present in every kept profile | none |
| parses of one output line | 3 | 1 |
| lines removed at the end | | the source twin (17k), most of the daemon client (16k), the daemon's offline host (3k) |

## Risks

- **One process shares one fate.** A crash, a hang or an out-of-memory anywhere stops everything on that host
  until the boot start runs the service again (seconds). Nothing is lost: agents are detached, their output is
  in files, the registry and the message queue are on disk.
- **Moving the daemon's code takes care**, because it may block today. Phase 4 moves one module at a time
  behind the same tests, and the daemon process keeps working until the last one is in.
- **The main thread is the ceiling.** It is far from full today. The stall recorder stays on. If a measurement
  ever shows it full, the output tail is the piece to give a worker: bytes in, events out.
- **A follower's memory** on a small host: measure in phase 1, and switch off by capability what it does not
  need.
- **Hosts the file cannot run on**: count them before phase 3 deletes the source twin.
