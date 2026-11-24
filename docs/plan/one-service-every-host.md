# One service on every host

Status: decided (2026-11-18); all four phases are to be built. Phase 1 is partly built (the path with the
leader away, proven on two real machines); phases 2 to 4 are open. An edit of 2026-11-19 that marked phases
2 to 4 "not built, by decision" was never the owner's decision and was taken back on 2026-11-21, when the
owner also said the end state plainly: no separate daemon, everything in the service. The order of work and
what differs from the first text are under [Phases](#phases). Builds on
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
| the process manager | ordinary modules of the service, on its main thread, called as functions by the task and session code; no process, thread, socket or request format between them. Kept apart is only what must be: the agents and other child processes themselves (they are other people's programs and must outlive a restart), pure heavy computation on workers, and a plugin's own job | a separate daemon process started by the service (the first text's first step), and a worker thread for today's daemon code: both keep a boundary that every start and every output line must cross, which is where the 225 commands and the repeated parse of a line come from. The owner (2026-11-21): no daemon process, and no thread chosen to save the work of making the code non-blocking |
| what keeps the service alive | a small launcher: the shell script hosts already have, started by systemd, cron or launchd. It runs the service, restarts it when it exits or stops touching its heartbeat file, and is the only writer of which version is current | a launcher inside the program itself (another product's choice): it could not start or take back a version that does not load |
| upgrade | the new version is staged and proof-booted, then started as a trial; it says it is ready once it adopted its processes and listens; the launcher records it; 15 minutes without a crash make it the last good version; a trial that does not get ready, or crashes in probation, is replaced by the last good version | a new version taking over beside the old one: two processes on one data directory, to save a pause that agents do not feel and clients retry through |
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

- Process management is ordinary modules on the main thread. Today's daemon is a 15k line top-level script
  over 88 modules that are already plain functions; the script becomes a module the service creates (it stops
  changing the process's working directory and file mode mask, exiting the process and handling its
  signals), and the service calls it directly. For a session on the service's own machine a line of output
  goes from the file to the session's handler by a function call and is parsed once.
- Its blocking calls are made async where they are hot (the read of every session's output file every
  100 ms, `mkfifo`, `ps`, a history read of up to 32 MB), and the files join the blocking ratchet. The
  longest hold of the main thread with ten sessions writing is measured before and after and may not grow.
- An error in one request or one timer is contained there. A crash or a hang of the whole service is the
  launcher's: it runs the service again, which adopts every live process from the registry.
- What a restart of the service must not lose is detached and recorded, as agents are: a remote command
  (`host_exec`), an ACP agent and a plugin script get an input FIFO, an output file and a registry entry, and
  are adopted. A check script runs again at its next tick, and one fire carries an id its receiver dedupes.
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
- What may be copied to which host follows the existing replica rules (`replica-targets.ts`). A task kept
  local (`local: true`, a private matter) and the rows that belong to it are never copied to a host's
  replica (`core/replication/host-private.ts`); such a task running on a host is answered by the leader
  while it is there and gets `needs_leader` while it is away.
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
- **The follower's "needs the leader" is the caller's answer.** While the leader is away, a `needs_leader`
  the follower answers itself (a route of the leader's, a write it cannot keep, a task kept local) is final
  (`detail.final`, `awayReply` in `src/replica/local-calls.ts`): the daemon never answers that call with its
  old offline code, which for every such op did nothing more than say so. Only refusals meant for someone
  else go on: "the Mac answers again" and "this server does not know its host name yet" (`AWAY_NOT_FINAL`),
  and any refusal while the Mac answers again or the companion leads (the daemon then relays it there). A
  session's call still takes the old path when the follower is not linked or a read is late. A plugin job's
  answer is final. Every fallback is counted (`offlineAnswers` in the daemon's status, and the log line
  `gateway: daemon offline answer used`), so a run can show that none happened while a follower was there;
  step D deletes that code once the count stays at zero.
- **Starts made alone** (`src/replica/away-starts.ts`): only for a task this host's journal made, with a
  session id derived from the op id so a retry starts nothing twice, one start of a task at a time (a second
  hears the leader's 409 `session_exists`), and at most as many live sessions as this machine's memory allows.
  Its mode meets the leader's own start-mode ceiling (`src/replica/start-ceiling.ts`, also for a new ask):
  a session starts work at most as loose as its own mode (an unreadable one counts as `default`), a plugin
  job goes uncapped only with its daemon's vouched token, and a looser mode asked for is the leader's 403,
  final, with nothing started.
- **A caller follows what it started.** While the leader is away, a session's or a plugin job's reads of a
  task its host started alone answer from that host, in the leader's shape. The routes behind `task_get`,
  `task_list` and `task_get_bulk` answer the task's session linked as the leader links it (`session_id`,
  `session_ids`, the slot by mode, no slot once the session stopped: `core/sessions/task-session-link.ts`,
  one rule for the leader's link and the host's fold); the ops show what they show with the leader there,
  which is `execution` from the session's live state and no session field (one
  `follower.sessions` read at most a second old, shared and backed off when the daemon does not answer:
  `ask-launch.ts` `fresh`; then the leader's own session enrichment). `task_history` reads the conversation
  on the host, messages a `task_send` delivered there included, and `GET /api/sessions/task/:id` lists the
  session with its host, folder and live status. The session is folded for readers only and only while the
  task's create is still in the host's journal and its row names no session (`overlay.ts`
  `taskForReaders`); a write's base is the journal's row without it. The phase is the journal's (TODO, or a
  phase a caller on the host set) until the leader returns, and the leader shows the same after the drain,
  which adopts the session without replaying a start's phase. Any other read of such a task that its route
  cannot find answers `needs_leader` (`task_made_here_needs_mac`), never "not found". Every read of tasks or
  sessions has a decision in `tests/replica/away-task-reads-table.ts`, which the route ratchet holds.
- **The leader's side.** A plugin job is an actor of the journal; a task's session started on the host is
  adopted by the `task-start` drain; a task made away lands where the same caller's create lands online. A
  project the session's create took from its caller rides the record as `inheritedProject`, which the host's
  own readers and its start read and no drain does: the leader files the task under its caller where the
  caller is then, so a caller moved to another project meanwhile takes its subtask (and the session the
  host started for it) along, never a refusal of a create the host already answered. A
  session record the leader does not take is a refusal into the letter, never a retry that holds the host's
  later records (an error that may pass, such as a busy database, is still retried). A session the host
  started alone that is refused, or given up after its retries, has its CLI ended through the daemon that owns
  it, and the letter names the session and the host.
- **A plugin's own tasks stay off the follower's board.** A follower loads no plugin manifest, so the leader's
  host server manager names the plugins that keep their tasks to their own view in the settings of the
  follower's spec (`pluginsKeepTasks`, read while it runs: a change restarts nothing). When that set changes,
  the leader reconciles its hosts once the burst settles, and within ten seconds at most. The follower stamps
  a plugin job's away create with `plugin_only` through the function the leader's create uses
  (`plugin-task-visibility.ts` `pluginOnlyForCaller`, in `task-row-fold.ts` `createdRow`): never pinned,
  absent from the board's lists, there for the plugin's own reads.
- **A call handed over after a wait is never answered "may have run".** The daemon sends how long it will
  wait; when that is too short for the op (a start needs ten seconds), the follower refuses before anything
  runs and the caller retries.
- **Every host gets a follower by default** (`src/core/host-server/follower-default.ts`; the experiment
  `follower_on_every_host`, on by default from 2026-11-22, ended on 2026-11-24 and its stored value is ignored).
  A host Walnut manages (in config.yaml, not turned off as a host, not the cloud box, not a found
  host waiting for a yes) runs one unless the person turned its switch off. The switch
  (`hosts.<key>.server.enabled`) is written only when the person flips it, so a stored `false` is theirs and
  stays off across upgrades; a host with nothing stored follows the default, and nothing is written for it.
  After an upgrade, a user who never set it gets a follower on each eligible host at its next connect (the
  gates below, one host at a time, a failure to Walnut Health); a release from before 2026-11-22 reads the
  same file, reads an unset host switch as off, and stops the followers it did not ask for.
- **Conditions decide, never a host name** (`src/core/host-server/eligibility.ts`). Before the first follower
  of this Walnut on a host that is on only by default (not one the person turned on, nor the one carrying
  this Walnut's tunnel), one probe over its link reads its platform, its memory and its disk. No build that
  runs there (no file for its system, or the file's proof boot failed), less than 2 GiB of memory in all or
  1 GiB free (the machine's or its container's limit, whichever is smaller), or less than 2.5 GiB free on its
  disk keeps the host without a follower: its view says why (`not-eligible`). Free memory and disk are
  looked at again every 30 minutes and a failed proof boot every 6 hours; too little memory in all and no
  file for its system wait for a connect, Retry or a newer build. The floors come from a dev host
  with 19 agents (2026-11-18): the follower used 311 MB right after a start and 194 MB after 16 minutes, the
  daemon beside it 246 MB; one version of the program takes about 160 MB unpacked, and that follower's data
  copy was 1.9 GB. A host row that is really the leader's own machine (its link reaches the leader's own
  daemon process, by the hello's instance id) gets none by default either (`this-computer`); while the
  leader's own daemon is not linked yet that is unknown, so nothing is installed and it is looked at again.
- **A slow link or a failed start harms nothing else.** The program goes up in the background with the
  resumable upload, on connections of its own and with no deadline; the view shows the bytes sent. With the
  experiment on, a start that fails runs again by itself after 1, 5, 15, 30, then 60 minutes, never touching
  the daemon link or the host's sessions, and goes to Walnut Health as one item per host (never a popup),
  recovered once it runs. On a host on only by default the follower is stopped after the failure, and the
  tries end after the 60 minute one until a newer build, a reconnect or Retry. Hosts on by default install
  one at a time; a host the person turned on never waits behind them. Switching the experiment off stops the
  followers that ran only by default and leaves their files on the host.
- **Calls the follower answers alone since step B** (`src/replica/away-*.ts`). With the daemon's own records
  and op ids, so the leader's drain applies each one once: a message that asks for a reply (a request row the
  leader opens with the same deadline rules, `away-sends.ts`, rules shared with the leader in
  `core/sessions/send-rules.ts`) and a reply to one (`away-replies.ts`); `agent_memory_write` (held with the
  leader's own note checks) and `human_inbox_send` (`away-calls.ts`); every trigger op (`away-triggers.ts`;
  `trigger_update` in `away-trigger-update.ts`), and the delivery of a trigger's fire to a session on the host
  (`away-trigger-delivery.ts`, the daemon still delivers when the follower is down or keeps failing). Reads
  (`session_list`, `request_get`, `search`, `open_items`, `walnut_status`, `tools.list`) fold the host's own
  records in; every op has a row in `src/replica/away-op-decisions.ts`, which a ratchet holds.
- **Same-host messages while the leader answers** (experiment `host_call_entry`, off by default). A message
  from one session to another on the same host is delivered by the host's follower and told to the leader;
  the message id is claimed first, so a hand-off that times out and is relayed to the leader never delivers
  it twice. With the experiment off, the leader delivers it as before.
- **One entry for new sessions and plugin jobs** (experiment `host_call_entry`). A session or job started by
  a daemon that has `host-call-entry-v1` gets `WALNUT_CALL_SOCKET` (a 0600 unix socket of the follower's,
  never the listener the tunnel reaches) and a token bound to that session's run. The follower hands each
  call to the daemon, which checks the token and routes it exactly as a call on the old gateway socket, so
  both doors share one auth and routing rule. Old sessions keep the socket; a call the entry cannot take
  (flag off, link down, older daemon) goes to the socket with the same call id.
- **A task kept local stays off the host** (`sync_hold`, `core/replication/host-private.ts`). Its row and the
  data that belongs to it are not copied to host followers (the companion still gets them); a copy a host
  already holds is removed within seconds of the hold (every copy listens for a change of the kept set),
  and that removal never waits on the half rule (the sync names the rows it leaves out; the daemon's memory
  file copy still counts them, where a task's own files are a small share). A routine of such a
  task keeps its clock on the leader unless the task's own session runs on that host. A project made local
  leaves every hold a task owns in place (`core/private-tasks/hold-owner.ts`). Its own session's calls are relayed to the leader while it
  answers and answer `needs_leader` (`task_kept_local`) while it is away.
- **Turned down: starting a task made on the leader alone.** Where such a task starts needs the leader's whole
  placement rule: the caller, the task's ancestors, its workspaces and the folders on the leader's disks. A
  second copy of that rule on the follower was wrong twice in review, so such a start keeps answering
  `needs_leader` (`task_made_on_mac`).
- **A trigger changed on its host while the leader is away** (`away-trigger-update.ts`). The routines copy
  already holds each routine's whole row, so the follower runs the op as the leader does (its patch from
  `core/routines/trigger-update-patch.ts`), checks and merges the patch with the leader's own functions
  (`normalizeCronJobPatch`, `checkShapeForSave`, `applyJobPatch`), and the daemon journals one
  `trigger_update` op record of only the fields that changed, arming the changed def at once in place of the
  leader's while the leader's set still says whether it runs. The leader replays it through the op on its
  return, under the record's op id, so it is applied once and a field the leader changed meanwhile that the
  host did not stays (the host's value wins a field both changed, as for every trigger record). Only a leader
  that drains `trigger-update` gets one; an older one answers `needs_leader` (`mac_too_old`). What only the
  leader decides answers `needs_leader` (`fields`) for those fields alone, each named with why: the check's
  host, a template, the task it wakes, a prompt over 32 KB, and the check's command or folder (`run`, `cwd`)
  or its removal: the task a check acts for, whose grants its `walnut` calls get, is decided by the leader
  when what it runs changes (`settleCheckActsFor`), and a host-armed new command would act for the old task
  until the record drained; a trigger whose check runs on another host or a
  scheduled routine (its clock is the leader's) needs the leader whole.
- **Not yet.** The watcher that ends a session's turn stays in the daemon until step C. A prompt that asks
  the person for an approval goes through the old socket.

## Two Walnuts on one machine (as built, behind `host_service_sets`)

"One service per machine" means one per Walnut. When two Walnuts use one machine under one OS account
(a person's own leader and another person's Walnut using the machine as a host), each has its own
service with a whole set of places; neither lists, adopts or stops the other's sessions.

- **Who keeps the default places.** The Walnut already on them (or the machine's own leader). A machine
  with one Walnut moves nothing. A later Walnut uses `~/.open-walnut-host/walnuts/<id16>/`: install
  root, versions, launcher, boot item name, runtime dir, registry, streams, ports, sockets. The choice
  is the host's (`walnut daemon ... --walnut`), taken once with an atomic claim, and sticky.
- **That set is production.** Its sessions survive a restart like the default one's.
- **Shared, and only these two:** the machine id; the cli-owner records. The network is not shared: a
  later Walnut's set runs its own walnut-net (own key, address, config, control socket, UDP port, in
  `walnuts/<id16>/net/`); the machine's stays as it is. A host-network leader pairs with its set over
  the link it already has (`walnut daemon net-id`), and no pairing means no move.
- **The move off a shared daemon carries no live CLI over.** The leader waits, at most a bounded time,
  for a moment when none of its sessions there runs a turn; holds new work; stops them the normal way
  and confirms each exited; flips its link (net: dials the set's endpoint); resumes them in its own
  service on their next message. Once a net move is confirmed it takes only itself off the machine's
  walnut-net list.
  Before the flip it drops its triggers and jobs on the shared daemon, drains its offline journal there
  (no flip while a record is left) and carries each trigger's memory to the set (`triggers.state.seed`),
  so a long quiet watch does not report its old items again. A session started during the hold waits
  for it and starts on the set.
  Each moved session reads its context once. A move that cannot finish (the wait runs out, the new
  service does not answer) is put back and reported; a running turn is never stopped. Sessions started
  after the flip go only to the new service. The shared daemon, its launcher and boot item are left as
  they are, for the other Walnut, which updates them by itself once the shared window passes.
- **Leaving a machine** (Settings > Remove of a net machine, or removing an ssh host from config.yaml)
  stops that Walnut's sessions and follower on its set, then removes only its set, boot item, network
  members and relay registration. A host removed, turned off, or found and not yet allowed is never
  dialled in the background (`src/core/hosts/link.ts` dialRefusal), so a removed host cannot keep the
  shared window open by reconnecting to the other Walnut's daemon.
- This separates running, not permissions: the same OS account reads both. Separate permissions need two
  accounts.

## Compatibility

- A host still on a separate daemon keeps working with a new leader, through today's daemon protocol. The
  leader tells the two kinds of host apart by capability.
- A host the file cannot run on (an old C library, an unusual CPU): the first text keeps it on the source
  daemon as a limited host and also deletes the source twin in phase 4. The two cannot both hold. Such hosts
  are counted before phase 4 and the owner decides; until then the twin stays. Every connected host ran the
  compiled file on 2026-11-21.
- The old daemon protocol stays understood on both sides (a new leader with an old daemon host, an old
  leader with a new service) for at least two releases after every host runs the service.
- An older leader that cannot drain a plugin job's records or a task start is told apart by the kinds it
  drains; the host then answers `needs_leader` instead of journaling what would be refused.
- `/api/v1` (the phone app) does not change, and a phone or a browser hears the same answers while the leader
  is away as before. `walnut web` stays as a name for `walnut serve`.
- Between machines on different versions the API is the contract: changes are additive, and a route a host
  does not have yet answers "not supported" so the caller can fall back.

### A session a host runs (phase 2, step C): hand-off, rollback, delete

- **No hand-off of a running session.** The switch (`host_runs_sessions`) decides where a new start goes,
  and where a session the leader ran resumes once nothing of it runs any more. A delivery to such a session
  (any send, a redelivery, restart recovery, auto-continue) whose CLI runs nowhere (no process the leader
  holds, no turn, start, stop or transfer in flight, and the host's runtime says no CLI of it runs) goes to
  its host as a resume when a start there would (`src/providers/host-resume.ts`): the host resumes the same
  CLI session id from the same row, through the same claim, in-flight and lost-start rules as a start, and
  the session is the host's from then on; refused or never sent, it resumes here as before, once. A session
  with a live CLI is never handed over, and a host that does not name
  `session-resume-v1` is never asked (a host turned on before its service has a build that names it keeps
  its sessions legacy). With the switch on for the host, each such delivery logs one line saying which way it
  went and why (`host resume: ...`, `why`: held legacy, the host takes no resume, not judging, or a reason it is
  not at rest); off, it is quiet. One a host runs stays that host's after the switch goes off (tests:
  L1 in `tests/e2e/host-judged-session-lifecycle-e2e.test.ts`, S6 in `host-judged-session-cluster-e2e.test.ts`,
  L1 to L7 in `host-judge-legacy-resume-e2e.test.ts`). So no session changes its judge while it runs.
  An ACP engine's session (Codex and the rest) is handed the same way, only to a host whose service also
  names `session-resume-acp-v1` (else it stays legacy): nothing moves, since its worker, its journal and the
  engine's own thread already live in the host's daemon; the host attaches it from the same row (its
  runtime id, journal cursor, mode and model) and resumes it there. Its runtime is asked for the worker by
  the row's runtime id, on both ends the runner's ACP object counts live only while it holds anything, and
  every attach of the session asks first, since an attach starts its worker: a send, a delivery, and a read
  that attaches (the panel's controls, the model catalog), which hands it over with no line waiting and is
  answered by the host's proxy (empty controls and catalog, never undefined, until the host reports; a
  read waits a few seconds for that first report, and the leader tells the panel to read again when it
  comes). The host owns a resumed row from the moment it takes it, and its attach says its live state
  changed (no row write shows it), so that report always comes. A Restart and a self-report stay where the session ran. A host taking a resume, or giving a
  session back, lets go of its objects of it that hold nothing, so an old one never replays the
  leader's turns. An attach the hand-over overtakes is let go, its worker left to the host (tests: `host-resume-acp.test.ts`,
  `host-resume-acp-attach.test.ts`, the attach list in `host-resume-entry-ratchet.test.ts`, A1 to A4 in
  `host-judge-legacy-acp-resume-e2e.test.ts`).
- **A hand-over whose answer is lost** (a start or a resume, `src/providers/host-handover.ts`) is neither the
  host's for sends nor the leader's: its lines wait on the leader, never sent, refused or parked, until the
  host's row of the session comes (the channel clears the hand-over's mark in the same transaction; the lines
  then go to the host once, by their ids) or the lost check decides. That check asks the host: it holds the
  session (the host's), or it does not and its runtime runs no CLI of it (a start fails and its waiting lines
  park with why, a resume runs here once); anything else waits on and says so in Walnut Health. The mark is
  on disk (`session_host_handovers` in sessions.sqlite), so a leader that restarts in the window checks it
  again, its clock running from the host's first channel link after the boot. A host takes a row as its own
  only by a claim (a start or a resume it took) or its own writer, never from the leader's copy alone.
- **A host that no longer holds a session it judges** (its store was reset, it gave the row back) answers
  its sends, interrupts and calls `not_own_session`. Outside a hand-over that is no refusal: the leader asks
  once more, and a second no makes the session the leader's again, at rest; its next delivery hands it to
  the host again with the claim and the at-rest checks (`confirmHostDisowns` in
  `src/providers/host-judged-send.ts`). The waiting message goes once, never parked.
- **No line into a session it judges goes past the host's runner unread** (`src/core/session-channel/host-judged-lines.ts`).
  Every host path that writes into a session's CLI through the daemon instead of the runner (a same-host
  send or reply, a plain note, a prompt's answer, a trigger fire, a message while the host is alone) lets the
  runner attach first (not an ACP engine's session, nor while the host stands down for an older leader);
  after a restart of the host's service the runner attaches every own row whose CLI the runtime holds (its
  registry, not the row: the daemon may have resumed one alone), once it reads its own streams; and an
  attach of an own row reads the stream on from the furthest line the leader was told of (the fact log's
  told line, saved with its fsynced state: `toldLine` in `src/core/session-channel/fact-log.ts`,
  `judgedReplayFloor` in `src/providers/attach-evidence.ts`), so a turn that ended while no runner read it,
  whoever wrote its line (the daemon's own away answer too), is said once, and what the leader already
  heard of a turn running at the restart is not said again
  (2026-11-23: a same-host send after a service restart; tests:
  `tests/e2e/host-judge-restart-local-send-e2e.test.ts`, ratchet
  `tests/core/session-channel/host-judged-lines-ratchet.test.ts`).
- **Rolling back, in order.** Each step can stop there; each later one is safe without the earlier.
  1. One host: `hosts.<name>.runs_sessions: false` in the leader's config (no restart). New starts on
     that host take today's path at once; the sessions it already runs keep running and reporting
     through the channel until they end (`tests/e2e/host-judge-per-host-e2e.test.ts` P2).
  2. Every host: the experiment `host_runs_sessions` off (and no host entry set to true). The same, for
     all hosts (S6).
  3. An older release, once those sessions ended or were stopped.
- **Going back lifts every ban.** A leader older than the ban (before land 9) does not know a revoked
  host: it reads a revoked credential record (one that keeps no key) as one never issued, and issues
  that host a fresh key at its next link check, so the host dials in again and its channel, relays and
  journal come in as for any host. Before going back, remove each revoked host from the config (or turn
  its row off): that ends its daemon link and its door on any release. Or go back, then forward again,
  and revoke it again (`POST /api/host-doors/<host>/revoke`): the newer leader keeps the mark the older
  one replaced only if no key was issued meanwhile.
- **A straight downgrade** (an older release put on the leader while a host still runs a session it
  judges). The older leader loses no session: it reads a host-run row as an ordinary row of that host
  and reaches the CLI through the host's daemon as today, and the daemon keeps one CLI per session
  (cli-owner), so its send or resume goes on with the same conversation. It judges every turn itself,
  from the transcript. The host would judge the same turns too (auto-continue, the retriers, the
  turn-end queue) until its service is replaced by the older build, which the leader's daemon update
  does minutes after it links (a fresh daemon waits out 20 minutes, an open host_exec run or ACP turn
  holds it, every hold gives way after 3 hours). So the host stands down (`old-leader-watch.ts`): when
  its leader answers (the daemon's follower view) and no leader opens the session channel for 3
  minutes (`WALNUT_HOST_OLD_LEADER_MS`; any leader with the channel opens it within seconds of linking,
  whatever its switch says), `judgedHere` is false for every row of the host, the one gate its resend
  family acts through, and only the older leader judges; the host stamps no turn end as taken by its
  retriers meanwhile. The CLIs, routes and fact log go on; a leader that opens the channel ends it at
  once (the watch looks on the link), and the turn ends the family skipped meanwhile go to it then
  (`stand-down-held.ts`), so a stand-down that misjudged a newer leader leaves no turn end to no one.
  A leader that speaks the channel says so in its config copy (`leader_capabilities:
  [session-channel-v1]`, while the switch is on), and a host whose leader says it never stands down
  on the timeout: it keeps judging and reports `waiting`; either state shows in the leader's Walnut
  Health (`host-side-health.ts`). The build before that row (land 5) still gets the timeout. A leader
  merely away (the lid closed) does not answer, so it never counts: the host keeps judging, which is
  the point. What the user sees: for up to 3 minutes
  after the downgrade a turn end can be continued twice (both judges), then the sessions behave as
  legacy ones; the host's facts of that time reach no leader until a newer one comes back
  (`tests/e2e/host-judge-old-leader-e2e.test.ts`). A refusal (the task store's schema gate, say) was
  not chosen: it would block the rollback exactly when the new release is the broken one. Not tested
  against a real older release (the older leader is the new code with its channel off).
- **A leader that stops between a batch and its facts (M3).** The channel applies a host's records
  in one transaction and says their facts after it, where the turn-end handlers move the task's
  phase. A stop in between (a crash, a deploy's restart while the handler waits on its git pull) would
  leave the task In Progress for good, since the applied records never come again. So the same
  transaction marks each host-judged session's last phase-moving turn end (`session_turn_ends`,
  `src/core/session-channel/turn-ends.ts`; the edge comes from `sessions/turn-end-edge.ts`, which the
  live handler shares), and the leader's boot applies a mark through `applySessionPhase` only when the
  task's phase has not moved since and the row runs no new turn. A legacy row is never marked; a
  second boot finds no mark (`tests/core/session-channel/turn-ends-reconcile.test.ts`).
- **Delete and archive.** Archive is the leader's field and reaches the host in the sessions copy. A delete
  starts on the leader and goes to the session's host as a command (`POST /host-api/sessions/drop`), never in
  the copy: a host keeps its own rows when the copy stops naming them, and the copy reaches every replica,
  where an older one would store a marker as a session. The leader keeps a mark
  (`session_leader_drops`) until the host's `drop` record answers, and sends the marks again each time the
  host links, so a host that was away does it then. A host's own `drop` with no mark changes nothing on the
  leader. Open: marks of a host that never comes back are not pruned.
- **Stop and mode.** `stopRequest` is a host field: the host's stop coordinator keeps it and fences with it.
  A stop or a mode change of a host-run session goes whole to its host (`lifecycle` host calls); the
  leader moves only the task's plan and exec slots.
- **One machine under two names.** A box can be in the config twice (its ssh row and the row it joined the
  host network as, one daemon), and its one service goes by one of them (`daemonKeeperAlias`). A start or a
  resume on the other name goes to that service under the name it goes by (`leader-side.ts startKeyOf`:
  that name's channel is linked and the switch is on for both names); its row moves to that name with the
  hand-over (`handSeedToHost`), since the host claims only a row of its own name, and back to its own name if
  the host refuses. What the leader records of a host's session (hands, hand-over marks, row and fact
  ownership) is the machine's: a channel under either name brings it, another machine's never. Granting
  needs a tie the leader proved with its own links: both names' daemon links it dialed answer now as one
  live daemon process (`revoked-hosts.ts oneDaemonNow`). The machine id a hello claims never grants (a host
  could name another's, and a data home moved to a new box keeps its old id); it still bans (`sameMachine`)
  (`tests/core/session-channel/one-machine-hosts.test.ts`, `tests/e2e/host-judged-alias-cluster-e2e.test.ts`).
- **The switch's copy lags its write.** A host reads the switch from its config copy, a few seconds behind a
  write, so its first start after the switch went on can be refused `host_runs_sessions_off`. The leader,
  whose switch says on, then sends the config copy to that host alone now (`copyKindNow`), waits for its
  answer and its link, and asks once more (if the switch is still on), within 15 s; never a third time
  (`session-channel/switch-catch-up.ts`). A start
  still refused fails as before; a resume is delivered here as before.

## Phases

Each phase lands alone and leaves production working. Nothing in a phase is dropped without the owner's own
answer.

| # | Phase | Done when | Where it stands (2026-11-21) |
|---|---|---|---|
| 1 | **A host's own calls are answered by its service.** The follower answers a session's and a plugin job's calls while the leader is away, with the real task logic and the journal; the daemon only passes the call on. Then every host gets a follower by default. | with the Mac's service stopped, a plugin job on a host creates a task, starts a session and tags it; after the Mac returns the board shows them once, and a second drain changes nothing | Built behind experiments (`follower_on_every_host`, `host_call_entry`), proven on two real machines with the leader away twice: no call fell back to the daemon's offline code and everything arrived once. The follower now answers a send that asks for a reply, `agent_memory_write`, `human_inbox_send`, the trigger ops and the delivery of a fire; new sessions call their host's own door (a 0600 unix socket and a per-session token). On by default since 2026-11-22 (`follower_on_every_host`), and no longer an experiment since 2026-11-24. Open: `trigger_update` with the leader away, a real disconnect in the middle of a hand-off, and a caller identity the daemon takes from the session's own word. |
| 2 | **Between machines, service to service.** The leader asks a host's service to start, stop and message its sessions; a session is run and judged by its host's service; local callers use the API on a local door, whatever the leader's state. | the leader sends no command to another machine's process manager; the Mac's main thread parses no line of a session on another host | Not built. The cut is scouted: the session class moves to the host, the session's rows belong to its host, and a live channel with a sequence and an acknowledgement per session carries them to the leader. |
| 3 | **The boot start keeps the service**, on hosts and on the Mac; one version per host. | a service ended by hand is back within seconds with its agents; a build that cannot stay up is rolled back without a person; the Mac's Walnut is back after a reboot | Partly built, behind experiments. `walnut serve` exists and can run the process manager as modules in its own process (`in_process_daemon`): no daemon program, direct calls, each line parsed once, running sessions picked up when the mode changes either way. Work on a host outlives a restart (`work_survives_restart`). A launcher keeps a host's daemon up, tries a new version and puts the last good one back (`service_launcher`), proven under systemd, cron and launchd. Open: on a host the launcher still keeps a daemon that keeps the follower (not one service yet), the in-process mode has no WebSocket door for other machines, the Mac's production does not run it, and the Mac's Walnut does not come back after a reboot. |
| 4 | **Clean up inside.** Delete the source twin, the daemon's own offline answers and its small copy, and the checks for a daemon older than its server; move process manager modules into the service where it pays. | no task logic outside the service; one copy of the daemon's code | Not built. |

The order of work (the owner, 2026-11-21: merge the daemon and the server first). Each step has its
acceptance and its proof on real machines before the next starts:

| Step | Phase | What |
|---|---|---|
| A1 | 3, 4 | `walnut serve`; today's daemon script becomes a module the service creates and calls directly, behind an experiment; hot blocking calls made async |
| A2 | 3 | a restart of the service loses no work: remote commands, ACP agents and plugin scripts are adopted, a fire is delivered once |
| A3 | 3 | the launcher (trial, ready, probation, rollback, heartbeat); on hosts the follower is the service, one version; the upgrade from a separate daemon and the way back |
| A4 | 3 | the Mac: production runs the merged service under the same launcher, started at login |
| B | 1 | local callers use their host's API; the follower answers what it does not yet; a service on every host by default |
| C | 2 | the leader calls a host's service only; a session is assembled, run and judged by its host's service |
| D | 4 | the deletions; no task logic in the process modules; one launch path for a session on any machine |

Beside the phases, the main thread is cleared one measured item at a time (its own task): spawns through a
pool, heavy statements and large parses to workers, the remaining synchronous file reads to async.

### Phase 2, Done when 1: one gate for every session command

For a session its host runs and judges, every daemon command about that session's process (start, input,
stop, liveness, state, cron supervision, a line's fate, a pending start's cancel, the transcript holder) has
one host-service answer, named per command in `src/core/sessions/session-command-gate.ts`. Probes answer from
the channel's mirror (its `live` state, else the row only the host writes: `src/providers/host-judged-view.ts`);
controls go as `lifecycle` calls the host carries out against its own daemon (`src/core/sessions/host-lifecycle.ts`);
idle reaps, eviction, stale-row repair and the orphan sweep leave such a session to its host.
`DaemonConnection.send` refuses whatever a caller still aims at the daemon, and a ratchet classifies every daemon
command and every call site (`tests/core/sessions/session-command-gate-ratchet.test.ts`).

The hand-over's own reads are not exceptions to the rule but outside it: the at-rest check before a resume
hand-over asks while the session is still legacy (its process manager is the leader's to command), and while
a hand-over is unanswered the host has not taken the session, so the leader still asks the runtime whether a CLI
of it runs (`status`, `acpState` only; the gate checks the hand-over mark on disk).

The switch decides only where a new session runs. A session a host already runs and judges stays that host's
with the switch off: the leader side runs on every leader, and the host keeps its channel, its routes (all but
`start`) and its capabilities while its fact log exists (`host-boot.ts` followHostSwitch, `hostRanSessions`).
So the gate keeps sending such a session's probes, stops and checks to its host's service, never to the daemon;
`tests/e2e/host-judged-session-commands-e2e.test.ts` C6 proves a probe, a stop and a task-complete stop after
the switch went off.

A host on a build from before the checks (`readSessionSupervision`, `lineAlreadyRan`, `cancelPendingStart`) is not
asked them: its service names `session-host-checks-v1` once it answers them (`switch.ts` SESSION_HOST_CHECKS_CAP).
Until it does, a supervision read answers unavailable, a change says the host needs an update, a resend goes as
before, and a retry of an unconfirmed start says it cannot be retried until the host updates.

The gate reads no store on a send once a session is known: judge-of keeps the judge per session and the runtime
id of each host-judged ACP worker in memory (seeded once at the leader side's boot, then kept where host rows are
learned and forgotten). A take-back is not undone by a read before its row is written back (`takenBack`).

Not in this clause: host-local work (files, git, exec, terminals, transfers, workspaces, task folders, usage,
turn snapshots) and maintenance still go over the daemon's command path, and transcript reads (the rewind
probe and history) belong to clause 2.

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
| lines removed at the end | | the source twin (17k), the daemon's offline host (3k), the follower's link to its daemon, the daemon's keeping of the follower |

## Risks

- **A host's calls depend on its service being up.** It is restarted within seconds, and callers retry. Until
  phase 4 a session's call still has the daemon's old answers to fall back on.
- **Two answerers remain until phase 4** for a session while the leader is away (the follower first, the
  daemon's old code as the fallback). They share one journal, so their writes cannot diverge; the fallback is
  deleted once the follower covers every op it has.
- **A restart of the service restarts process management**, and the Mac's service restarts often. What a
  daemon restart interrupts today is made adoptable first (step A2), before production is merged.
- **Process code on the main thread can hold it.** The hot blocking calls are made async, the ratchet covers
  the files, and the measured longest hold is a gate, not a note.
- **A crash takes the whole service.** The launcher runs it again and it adopts every live process, the same
  path as an upgrade.
- **A follower's memory** on a small host: measured (above), and a host below the floors runs the service
  without a data copy.
- **Hosts the file cannot run on**: count them before phase 4 deletes the source twin.
