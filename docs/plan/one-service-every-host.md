# One service on every host

Status: decided (2026-11-18). Phase 1 is built: a host's own calls answered by its follower, and a follower
on every host by default behind the experiment `follower_on_every_host`. Builds on
[servers everywhere](./walnut-servers-everywhere.md), [replica servers](./walnut-replica-servers.md),
[daemon-first hosts](./daemon-first-hosts.md), [the single file](./walnut-single-binary.md) and
[daemon boot start](../reference/daemon-boot-start.md).

## Summary

Every machine Walnut uses has the same shape and the same way in: **one program, one service, one API.**

- **One program**: the `walnut` file, the same version for everything on a host.
- **One service**: it answers every call made on its machine, decides, and stores. Starting and watching
  processes is its own internal part (today's session daemon, which stops answering calls). Nothing outside a
  service talks to that part.
- **One API**: the UI, the phone, a session's or a job's `walnut` call, and another machine all speak the same
  HTTP and WebSocket API.

The Mac is not special. Its service plays the **leader** role (its data is the truth); every other machine's
service plays **follower** (a copy of what it needs), and works **alone** while it cannot reach the leader,
then hands the leader what it wrote. Machines differ only in their conditions: the role, whether the leader
can be reached, and which capabilities are on.

Today a host runs two programs that both answer: the session daemon answers a session's calls with its own
copy of task logic, the follower server answers a phone, and a plugin job gets no answer at all while the
leader is away. And the leader reaches past a host's server to command its daemon. Both end.

## Rules

1. **A caller on a host talks only to that host's service**: a browser, a session, a plugin job, the command
   line. The way in does not change with the leader's state.
2. **Between machines, only service to service**, with the one API. No machine reaches into another machine's
   process manager.
3. **Processes on a host are run only by that host's service.** To run something on another host, ask that
   host's service.
4. **Each service writes only its own data.** The leader's is the truth; a follower keeps a copy, and a
   journal of what it wrote alone.
5. **One program, one version per host.**
6. **What must outlive a restart is a detached process recorded on disk**: agent CLIs, plugin jobs,
   terminals, check scripts. After any restart they are adopted from that record.
7. **The main thread never blocks.** A worker takes only pure heavy work: data in, a result out.
8. **Conditions decide behaviour, never a host name** (`role()`, `isFollower()`, `leaderAnswers()`,
   `hasCapability()`). The leader role can sit on any machine a person owns.

Every call goes through one decision, the same code on every host:

```
the thing is mine                               -> do it
it is the leader's, and the leader answers      -> hand the call to the leader
the leader does not answer, the rules allow it  -> do it here, journal it, hand it over later
otherwise                                       -> refuse, and say why
```

What a host does by itself whenever it can: its sessions (process, output, messages), its plugin jobs, its
terminals and files, and, while the leader is away, reading and writing the tasks it works on. While the
leader answers, a change to a task goes to the leader, which keeps the one board.

## The shape

One host:

```
systemd user unit / @reboot cron / LaunchAgent
  boot start           a small shell script: starts the service, restarts it, rolls a bad version back
    service            walnut serve      the same on every host
      the API            UI port, local door for sessions and jobs, link to other services
      logic and data     tasks, sessions; the only writer of this host's data
      process manager    internal: start, adopt, stop, stdin, output tail, check runs
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
   |                               |  handed calls, streams   | its own sessions and jobs     |
   +-------------------------------+                          +-------------------------------+
                     leader unreachable: the follower works alone and journals its writes
```

## Decisions

| Question | Decided | Turned down, and why |
|---|---|---|
| language | TypeScript on bun, one compiled file | a rewrite, or a second language for the backend: 750k lines, and no kept stall profile shows slow computation |
| who answers on a host | the service, on every host | the daemon answering sessions on a host while the server answers on the Mac: two answerers, task logic written twice |
| the process manager | an internal part of the service; first today's daemon process started by the service, later its modules inside the service where that pays | a worker thread for it: it shares no objects with the rest, so the protocol would stay |
| what keeps the service alive | the boot start script hosts already have | a new launcher program |
| upgrade | stop, then start, with proof boot, probation and rollback | a new version taking over beside the old one: two processes on one data directory, to save a pause that agents do not feel and clients retry through |
| data across machines | one leader; followers that work alone and hand over a journal, as today | every machine writing everything and merging, or one owner per task: both spread the board's and the org's rules across machines |
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
  host's daemon starts `walnut web --replica`, restarts it and adopts it. It holds a full copy of the tasks.
  On a dev host with 19 agents it used 311 MB right after a start, the daemon 246 MB.
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
| answering a session's or a job's `walnut` call on a host | the daemon relays it to the leader, and answers a subset itself while the leader is away (`offline-host-core.ts`) | the host's service: hands it to the leader, or answers alone |
| the way in for those calls | a socket protocol in the daemon; on the Mac, the API | the API on a local door, on every host |
| start, adopt, stop agents; stdin; output tail | daemon, commanded by the leader | the process manager of that host's service, asked only by that service |
| judging a session's output (status, turn end, usage, hints) | the Mac's server, for every host | the service of the session's host |
| starting a session on a host | the Mac builds the command line, the daemon runs it; a pushed template when the Mac is away | the host's service builds and runs it with the code the Mac uses |
| the copy of the leader's data, and the journal of writes made alone | two copies: the daemon's small one and the follower's full one; the journal in the daemon | the follower's data layer |
| clocks and trigger decisions | daemon | the host's service |
| keeping things alive | hosts: boot start keeps the daemon, the daemon keeps the server. Mac: a launchd job from the deploy script | boot start keeps the service, everywhere |
| the link to another machine | the Mac sends each daemon commands; a replica's bytes are relayed by its daemon | services call each other's API |
| upgrade | two: a server deploy, and a daemon update with its own gap and holds | one |
| the leader's truth, the board, the org, search | Mac server | Mac service (unchanged) |

## Scenarios

**A. The Mac is off; a plugin job on a dev host receives work.** The job calls through its host's door:
create a task, start a session, add a tag. The follower writes the task to the journal, starts the agent
through its process manager, and answers the job from its copy plus the journal. When the Mac is back, the
journal drains once (op ids, base values, idempotent), and the task and its session appear on the board.
Nothing in the job's code asks whether the Mac is there.

**B. The same job while the Mac is on.** The call is handed to the Mac, which makes the task and answers; the
session still starts on the dev host.

**C. A deploy while ten agents run.** The service writes down what it holds and stops; the boot start runs the
new version, which adopts the agents and listens. Agents never notice. A browser reconnects. A session's
`walnut` call made in those seconds is retried.

**D. A bad version.** The new service does not stay up through probation. The boot start switches back to the
last good version and reports the bad one to Walnut Health. Agents kept running; their output waited in their
files.

**E. The service crashes or hangs.** A crash: the boot start runs it again. A hang: the service stops touching
its heartbeat file, the boot start ends it and runs it again. Either way it adopts every live process from the
registry, the same path as after an upgrade. Messages queued on disk are delivered.

**F. From the Mac, the user opens a session that runs on a host.** The Mac's service calls that host's service
and streams what the UI needs. The host's service is the one that tails and parses the output.

**G. A new host.** Settings adds it; the Mac pushes the file once; the boot start is installed and starts the
service as a follower. No second artifact, no second version to track.

**H. A test or isolated server.** `walnut serve` with its own data directory and no boot start. It keeps its
own registry there and ends its agents on exit, as a non-production daemon does today.

## Inside the service

| Part | What | Rule |
|---|---|---|
| main thread | the API, task and session logic, the only writer of data | never blocks: no synchronous process call, no large synchronous read or parse |
| process manager | start and adopt, FIFO writes, output tail and fold, check runs, job runs | answers no caller but its own service; imports no task logic |
| workers | pure heavy work: parse of a large payload, a merge, redaction, a heavy query on a second SQLite connection | data in, a result out; a worker holds no state another part needs |
| separate processes | agents, plugin jobs, terminals, check scripts | what must outlive a restart, and plugins |

- The process manager begins as today's daemon process, started by the service from its own file and always
  its version. That is enough for every rule above. Moving its modules onto the main thread is a later,
  internal step, taken module by module where it pays: its code may block today (12 synchronous process calls
  and about 490 synchronous file calls), so a module moves only once its process calls are async and the file
  calls on its hot paths are async or bounded.
- A worker is not a place for a subsystem. It has its own memory and cannot use the main thread's objects, so
  anything that talks to the rest often would need a message for every interaction.
- A move of work to a worker follows a measurement: a stall profile that names it. Each move adds its guard to
  the existing ratchet (`tests/core/event-loop-blocking-ratchet.test.ts`).

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
permission prompts still name Walnut.

## Roles and data

- The leader's data directory is the truth. A follower holds copies and its journal. A read alone folds the
  journal over the copy, with one fold shared by every reader (`core/offline-merge/task-row-fold.ts`).
- The existing table decides each call (`src/replica/route-table.ts`): answered here, a feature of this box,
  or the leader's.

| A call on a follower | Leader answers | Leader away |
|---|---|---|
| read a task | handed to the leader | the copy with the journal folded in |
| create or change a task | handed to the leader | journaled; answered from the fold |
| start a session for a task made on this host | handed to the leader, which asks this host to start it | started here; journaled |
| start a session for a task made on the leader | handed to the leader | refused: `needs_leader` |
| message a session on this host | handed to the leader | its FIFO |
| message a session elsewhere | handed to the leader | refused or held; the caller hears which |
| what only the leader has (the org, search by meaning) | handed to the leader | refused, with `needs_leader` |

- The drain on reconnect is the existing protocol. The leader stays the only writer of truth.
- What may be copied to which host follows the existing replica rules (`replica-targets.ts`). A task marked
  local to one machine is never copied.
- A follower turns features on by capability. The cloud box names its own; a host's follower is given
  `host-local-calls` (answer the host's own calls and start sessions alone).

## Phase 1 as built

- **The hand-off.** The daemon passes a session's or a plugin job's call to the host's follower only while the
  follower may write (one rule for "the leader is away", the test `follower.op` applies). While the leader
  answers, the call is relayed to it as before. In the seconds between the two, a session keeps the old path
  and a job's call waits within its deadline (`src/providers/follower-gateway-core.ts`).
- **The answer.** The follower runs the call with the code the leader uses for a relayed call
  (`src/core/peers/gateway-answer.ts`), acting as the session or the plugin job through a credential that
  exists only in its own process (`src/replica/write-actor.ts`, `local-calls.ts`). A request that carries it
  is never forwarded.
- **A session that the follower cannot serve keeps today's answer.** If the follower is not linked, is late,
  or says the leader is needed, a session's call falls back to the daemon's old offline answers. A plugin
  job's answer is final.
- **Starts made alone** (`src/replica/away-starts.ts`): only for a task this host's journal made, with a
  session id derived from the op id so a retry starts nothing twice, and at most as many live sessions as this
  machine's memory allows.
- **The leader's side.** A plugin job is an actor of the journal; a task's session started on the host is
  adopted by the `task-start` drain; a task made away lands where the same caller's create lands online.
- **A call handed over after a wait is never answered "may have run".** The daemon sends how long it will
  wait; when that is too short for the op (a start needs ten seconds), the follower refuses before anything
  runs and the caller retries.
- **Every host gets a follower by default, once the experiment is switched on** (`follower_on_every_host` in
  `src/core/experimental.ts`, off by default; `src/core/host-server/follower-default.ts`). With it on, a host
  Walnut manages (in config.yaml, not turned off as a host, not the cloud box, not a found host waiting for
  a yes) runs one unless the person turned its switch off. The switch (`hosts.<key>.server.enabled`) is
  written only when the person flips it, so a stored `false` is theirs and stays off across upgrades; a host
  with nothing stored follows the experiment, and nothing is written for it. With it off, the switch is
  opt-in as before: nothing new is installed, probed or reported. After an upgrade with the experiment on, a
  host gets its follower on its next connect; an older release reads the same file and reads an unset switch
  as off.
- **Conditions decide, never a host name** (`src/core/host-server/eligibility.ts`). Before the first follower
  of this Walnut on a host that is on only by default (not one the person turned on, nor the one carrying
  this Walnut's tunnel), one probe over its link reads its platform, its memory and its disk. No build that
  runs there (no file for its system, or the file's proof boot failed), less than 2 GiB of memory in all or
  1 GiB free, or less than 2.5 GiB free on its disk keeps the host without a follower: its view says why
  (`not-eligible`), and memory and disk are looked at again every 30 minutes. The floors come from a dev host
  with 19 agents (2026-11-18): the follower used 311 MB right after a start and 194 MB after 16 minutes, the
  daemon beside it 246 MB; one version of the program takes about 160 MB unpacked, and that follower's data
  copy was 1.9 GB.
- **A slow link or a failed start harms nothing else.** The program goes up in the background with the
  resumable upload, on connections of its own and with no deadline; the view shows the bytes sent. With the
  experiment on, a start that fails runs again by itself after 1, 5, 15, 30, then 60 minutes, never touching
  the daemon link or the host's sessions, and goes to Walnut Health as one item per host (never a popup),
  recovered once it runs.
- **Not yet.** A task made on the leader cannot be started alone. A message that expects a reply needs the
  leader. A task made away by a plugin that keeps its tasks off the board shows on the follower's own board
  until the leader has taken it. Every host gets a follower by default only once the experiment
  `follower_on_every_host` is switched on. The Settings page still shows the switch as before: it reads on for
  a host on by default, and does not yet say which hosts follow the default or why one has no follower.

## Compatibility

- A host still on a separate daemon keeps working with a new leader, through today's daemon protocol. The
  leader tells the two kinds of host apart by capability.
- A host the file cannot run on (an old C library, an unusual CPU) stays on the source daemon and is shown as
  a limited host: agents run there, less works with the leader away.
- An older leader that cannot drain a plugin job's records or a task start is told apart by the kinds it
  drains; the host then answers `needs_leader` instead of journaling what would be refused.
- `/api/v1` (the phone app) does not change, and a phone or a browser hears the same answers while the leader
  is away as before. `walnut web` stays as a name for `walnut serve`.
- Between machines on different versions the API is the contract: changes are additive, and a route a host
  does not have yet answers "not supported" so the caller can fall back.

## Phases

Each phase lands alone and leaves production working.

| # | Phase | Done when |
|---|---|---|
| 1 | **A host's own calls are answered by its service.** The follower answers a session's and a plugin job's calls while the leader is away, with the real task logic and the journal; the daemon only passes the call on. Then every host gets a follower by default. | with the Mac's service stopped, a plugin job on a host creates a task, starts a session and tags it; after the Mac returns the board shows them once, and a second drain changes nothing |
| 2 | **Between machines, service to service.** The leader asks a host's service to start, stop and message its sessions; a session is run and judged by its host's service; local callers use the API on a local door, whatever the leader's state. | the leader sends no command to another machine's process manager; the Mac's main thread parses no line of a session on another host |
| 3 | **The boot start keeps the service**, on hosts and on the Mac; one version per host. | a service ended by hand is back within seconds with its agents; a build that cannot stay up is rolled back without a person; the Mac's Walnut is back after a reboot |
| 4 | **Clean up inside.** Delete the source twin, the daemon's own offline answers and its small copy, and the checks for a daemon older than its server; move process manager modules into the service where it pays. | no task logic outside the service; one copy of the daemon's code |

Beside the phases, the main thread is cleared one measured item at a time (its own task): spawns through a
pool, heavy statements and large parses to workers, the remaining synchronous file reads to async.

## Budgets

| | Today | Target |
|---|---|---|
| who answers a call on a host | the daemon, the follower server, or nobody | the service |
| versions to keep matched on a host | 2 | 1 |
| protocols between parts of Walnut | the API, the daemon's commands, the session socket, the replica relay | the API |
| copies of task logic | 2 | 1 |
| an agent ended by a deploy | 0 | 0 |
| deploy gap, stop to listening | 3.5 to 15.8 s | 5 s or less in 9 of 10 deploys |
| parses of one output line | 3 | 1 |
| lines removed at the end | | the source twin (17k), most of the daemon client (16k), the daemon's offline host (3k) |

## Risks

- **A host's calls depend on its service being up.** It is restarted within seconds, and callers retry. Until
  phase 4 a session's call still has the daemon's old answers to fall back on.
- **Two answerers remain until phase 4** for a session while the leader is away (the follower first, the
  daemon's old code as the fallback). They share one journal, so their writes cannot diverge; the fallback is
  deleted once the follower covers every op it has.
- **Moving the process manager's code takes care**, because it may block today. It is last, and optional.
- **A follower's memory** on a small host: measured (above), and a host below the floors gets none by default.
- **Hosts the file cannot run on**: count them before phase 4 deletes the source twin.
