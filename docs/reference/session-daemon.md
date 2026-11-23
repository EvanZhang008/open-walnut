# The session daemon

Why host-local work belongs to the daemon, the remote session daemon's resilience model, how a CLI is owned and ended, how the daemon is updated, and why CLI crons are directory-scoped.

_Moved from the root `AGENTS.md` on 2026-11-11; the root file keeps a one-line summary of each rule._

## Design principle: host-local work belongs to the daemon, not the server

**Every host does its own work through its daemon; the walnut server stays a lightweight
coordinator.** If a computation only touches files/processes on ONE host (parsing that host's
session JSONLs, reading file contents, running git), it runs IN THE DAEMON on that host, and
only the (small) result crosses the tunnel: never the raw bytes, and never "N RPCs per file".
Ship data to the server on demand, at the granularity the UI actually consumes (a list, ONE
file's diff), not wholesale.

**The same split applies to RUNNING things, not just reading them: the server is the API, storage,
delivery and UI plane; a clock, a poll loop, a check script, anything that executes on a host, runs
in that host's daemon (precedents: walnut-trigger, `docs/plan/walnut-trigger.md`; a plugin's jobs, which
the daemon of the machine the user picked runs as processes, `plugin-jobs-v1`, `src/providers/plugin-jobs-core.ts`). Offload to the
daemon whenever the work can live there.**

**If a feature can be self-managed, self-manage it in the daemon; when it cannot, go to the
leader.** A host keeps a read copy of what its sessions need, answers reads from it, writes its
own things first and journals them for the leader. The leader is the Mac (the primary); while
the Mac is away, the cloud companion leads instead when the user allows it, fenced by an epoch
the daemons hold, and the Mac takes the lead back when it returns (`docs/plan/walnut-control-plane.md`,
`src/providers/leader-core.ts`, `src/core/leader/`). Only what a host cannot answer alone (a
session on another host, a task outside its copy) goes to the leader.

Why (each learned the hard way): raw-bytes-over-tunnel hits the WS frame kills and the 32MB
read ceiling (whale JSONLs); per-file RPC fan-out floods the daemon socket and starves its
command timeout; and parse work on the server burns the ONE event loop every route shares.
The daemon has local fs + git + CPU right next to the data: a whale parse that took 40-80s
of chunked tunnel reads is seconds host-local.

Precedents: `git.diff` (daemon runs the whole diff host-side), `changes.compute`/`changes.file`
(daemon parses session JSONLs + reads contents host-side, returns a light list / one file),
snapshot-v1 (daemon folds its own stream files), `fs.resolvePath` (path-resolve-v1: the daemon
runs the whole layered path search on its own tree). When adding a feature that reads
session/host data, default to a daemon command + a thin server relay; only fall back to
DaemonFileReader byte-shuttling when the daemon genuinely can't own the work (e.g. cross-host
aggregation). Capability-gate new commands (`daemon-capabilities.ts`) so old daemons degrade to
the fallback path instead of erroring.

**Corollary: a search over host data is host work too, and a per-item RPC loop is the
anti-pattern.** The old path resolver lived on the SERVER and probed the daemon with ~2
`fs.stat` calls per ancestor level (~18 round trips on a deep path). It routinely spent its
whole 10s budget on latency, then returned a path that didn't exist, which surfaced as a raw
`ENOENT: scandir` in the Files tree. `fs.resolvePath` (`src/providers/path-resolve-core.ts`) is
the same logic moved next to the data: one RPC, and it can use signals the server never had
(the session transcript, `git ls-files --recurse-submodules`). Two rules it encodes: bound the
CANDIDATE SET, not just the clock (an unbounded suffix list burns the budget on tails that
can't match), and batch: every needle rides ONE `ls-files` call per repo root.

**Order search scopes by cost, not by completeness.** `git ls-files --recurse-submodules` is
the complete answer, and on a monorepo of 2,606 initialized submodules it costs **1.24s
regardless of outcome**: while the same pathspec against the superproject index alone costs
**45ms**, and a parallel fan-out over just the submodules under cwd costs **20ms**. Since a
path the model mentioned is almost always inside the subtree the session is working in, the
resolver tries superproject → submodules-under-cwd → submodules-under-cwd's-parent →
everything, returning at the first hit: 2.3s became **~85ms** on the real repo. Two things make
this safe to generalize: read `.gitmodules` as TEXT (~2ms; `git submodule status` stats every
submodule and takes seconds at that scale), and skip the whole submodule question outright when
`.gitmodules` is absent: an ordinary repo spawns exactly ONE `git ls-files` and never touches
the submodule path at all.

**A confident wrong answer is worse than an error.** Trimming leading segments is what lets
`repo/src/x.ts` find `src/x.ts`; taken to its limit it also let `no/such/thing.ts` "find" an
unrelated `other/thing.ts` and report `resolved: true`, so the user opened the wrong file
believing it was right. `MIN_NEEDLE_SEGMENTS` keeps at least one directory of context for any
multi-segment reference (a bare `Makefile` is exempt: there is no context to preserve).

**Parse a path reference before guarding or searching it** (`src/providers/path-ref-parse.ts`,
shared by the resolver and both HTTP edges). A path in prose arrives decorated: `` `a.ts` ``,
`a.ts:42`, `a.ts#L10-L20`, `a.ts(42,7)`, a trailing sentence period, Windows separators. Each
one used to become part of the name being searched for, so the file was missed; the position is
now parsed out and returned (`line`/`column`/`endLine`) instead. Two traps this file encodes:
check traversal SEGMENT-wise, not by substring (`mod..old/thing.ts` is an ordinary filename that
a substring check rejects outright), and note that any rule which can DELETE a `..` must run
after every rule that can CREATE one: trailing-noise trimming turned `a/b/..` into a clean-
looking `a/b` and laundered an escape past the safety check. A generated matrix pins that
invariant.

**Never answer a path question with an errno.** `/api/files/list` accepts optional
`cwd`/`sessionId` and, when the requested path can't be listed, resolves and retries, flagging
a stand-in via `requestedPath`. A dead-end error message in a file tree is a bug, not a
diagnosis: degrade to the nearest existing directory plus "couldn't find X".

## The cloud companion is a replica with capabilities, nothing more

(2026-11-11, the user, translated: "the cloud companion has nothing special, it is just a replica server
plus a public capability ... we must not maintain a pile of logic", then "it cannot go wrong next time".)
A Walnut server is the **leader** (the Mac) or a **replica**. The cloud companion is a replica like
the server on any host; what it offers on top is a set of **capabilities**, each a flag the box turns
on (`public-door` phones pair, push and voice reach it from the internet; `bridge-door` daemons dial in;
`cloud-exec` it runs its own machine's daemon; `backup-leader` it may stand in for the Mac). Each one is a
manifest in `src/core/capabilities/` (see "Adding a capability" below). Walnut keeps ONE replica logic,
never a second one for the companion:

- **Never ask "am I the companion".** No new `CLOUD_MODE`, `process.env.WALNUT_CLOUD_MODE`,
  `isCompanion()`, `followerKind() === 'companion'` or `placement() === 'cloud'` in a feature, on the
  server or in a client. Ask what you mean instead: `isFollower()` / `role()` (this server is a
  replica, its leader is elsewhere), `leaderAnswers()` (the leader answers now), `hasCapability(<name>)`
  or a `bootPolicy` row (this box offers that door or job). A new optional feature of one box is a new
  capability, on by default only where it ran before.
- **Clients read the same way**: the web and the phone read `role`, `placement` and `capabilities` from
  `GET /api/config` and `GET /api/v1/status` (and the leader presence headers), never `cloud: true` or
  `mode: 'REPLICA'` as "this is the companion"; those two fields stay only for older clients.
- **What may still differ is the link**: how a replica reaches the Mac (the bridge sockets for the
  companion, its daemon link for a host). That lives in the link and front modules, not in features.
- **The ratchet** `tests/core/companion-is-a-replica-ratchet.test.ts` counts every such read per file
  in `src/`, `web/src/` and `ios-native/`, with why each one is still there (the companion's own front
  and queues, which plan slice 5b of `docs/plan/walnut-companion-unified-replica.md` removes, a stored
  value that names the companion, a fact a client is told). A new read fails it; a count may only
  fall. Do not raise a row: convert the read.

### Adding a capability

(2026-11-14, the user: "make them an internal capability platform, so relatively easy to add ... but
please still keep the security to the best, as the public thing is not kidding".) A capability is one
file in `src/core/capabilities/`, and that file is its whole surface:

| Field | What it holds | Kept true by |
|---|---|---|
| `name` | the wire name: `WALNUT_CAPABILITIES`, `serverCapabilities` in `GET /api/config` and `/api/v1/status`, the boot policy line; never renamed | the wire-name check |
| `summary` | one sentence a person reads | |
| `companionDefault` | whether a companion that sets nothing has it: true only for the four that existed before `WALNUT_CAPABILITIES` | the default set is exactly those four |
| `jobs` | the boot policy rows (`src/core/boot-policy.ts`) it turns on for a replica, in table order | every job is a row, owned by one capability |
| `doors` | each socket path it opens: who may open it (`opensWith`), the file that checks the credential (`verifiedIn`) and that check as it reads in the code (`check`) | the upgrade handler reads the path only to look the door up and to test `/ws`; every door branch checks a credential before it hands the socket on; only the listed files take upgrades; a door is shut without its capability; the `check` is in the code of `verifiedIn` |
| `routes` | each HTTP path it mounts that the `/api` device-token check does not cover (an invite code, the Mac's machine token, git's own credential), with the same three fields | everything `server.ts` mounts outside `/api`, and every path `middleware/auth.ts` lets in without a token, is a declared route or named in the test as no capability's, with why |
| `reads` | every file in `src/` and `web/src/` that asks `hasCapability('<name>')` or `useServerCapability('<name>')` with a literal name (a wrapper such as `canStandIn` counts as its own file's read) | the read list must match the code exactly |

To add one:

1. Write the manifest (`companionDefault: false`) and add it to `MANIFESTS` in `src/core/capabilities.ts`.
2. Add its name to `ServerCapability` in `web/src/api/config.ts`.
3. Gate its jobs with `bootPolicy` rows, and add them to `CAPABILITY_JOBS` (and their old truth to
   `OLD_TRUTH`) in `tests/core/boot-policy.test.ts`.
4. Gate its code with `hasCapability`, and declare every door and route it opens.

`tests/core/capability-manifests.test.ts` fails until the manifest names all of it. A box turns it on by
naming it in `WALNUT_CAPABILITIES`.

The security rules every capability keeps:

- **Closed list.** Manifests are compiled in; nothing loads a capability from disk, a plugin or the
  network. A name in `WALNUT_CAPABILITIES` that no manifest has stops the companion's boot, and the Mac
  and a host replica ignore the variable.
- **Off unless named.** The Mac and a host replica have no capability, so no door opens on them. A
  companion that sets nothing has the four it always ran; a capability added later is off on every box
  until the box names it, so an update never opens a new door by itself.
- **Every way in states its credential.** A socket door or an HTTP route outside `/api` names the one
  credential that opens it, the file that checks it before anything else happens, and the check itself.
  The upgrade handler destroys every other socket path; every other `/api` route takes the device-token
  check (`src/web/middleware/auth.ts`).
- **The smallest surface.** What a bridge socket may ask a daemon is the daemon's own allowlist
  (`BRIDGE_ALLOWED_COMMANDS`), never its full command set; a capability that needs more adds the one
  command to that list on purpose, with a test.

## Every host runs a follower server by default

The leader runs a follower Walnut server (`walnut web --replica`) on a host through that host's daemon
(`src/core/host-server/`). The host's switch (`hosts.<key>.server.enabled`) turns it on. With the experiment
`follower_on_every_host` on (`src/core/experimental.ts`, Settings, Experimental; on by default since
2026-11-22, a stored `false` keeps it off, and an older release reads it unset as off), it is on by
default on each host the leader manages, and the switch is the opt-out (`follower-default.ts`). With the
experiment off, nothing below the first rule applies: the switch is opt-in, nothing is probed, a failed start
waits for Retry, and nothing goes to Walnut Health (a Health item raised before is still cleared). Turning
the experiment off stops the followers that ran only by default, cancels their waits, and leaves their files
on the host.

- **A stored value is the person's.** Only PUT `/api/host-servers/:hostKey` writes the switch, so a stored
  `false` stays off across upgrades and a stored `true` stays on. A host with nothing stored follows the
  experiment; nothing is written for it, so an older release reads an unset switch as off, as it always did.
  The cloud box, a host turned off and a found host waiting for a yes never get one by default. GET
  `/api/host-servers` says whose each value is (`settings.chosenBy`, and `byDefault` on the view).
- **Conditions decide, never a host name** (`eligibility.ts`). A host on only by default, where this Walnut
  never set a follower up (no port kept, its daemon runs none), gets one only where a build of the file runs
  (its platform, the install's proof boot) and it has 2 GiB of memory, 1 GiB free and 2.5 GiB of disk free,
  judged by the smaller of the machine and its container's memory limit (cgroup v2 `memory.max`, v1
  `memory.limit_in_bytes`). The person's own switch and this Walnut's tunnel placed on the host skip the
  gates. Otherwise its view reads `not-eligible` with `gate.reason` (`no-build`, `memory`, `disk`,
  `this-computer`). Free memory and disk are looked at again every 30 minutes; too little memory in total
  and no build for its system wait for a connect, Retry or a newer build; a proof boot that failed is tried
  again every 6 hours. A host row whose link reaches this computer's own daemon process (the hello's
  instance id, `sameDaemonHosts`) is this computer and gets none by default; while this computer's own
  daemon is not linked yet, that is not known, so the host reads `checking`, nothing is installed, and it is
  looked at again soon.
- **Nothing happens on a host that is not connected**: its follower starts on the connect the host gets
  anyway (a follower on by default dials nothing; `hostRunsServer` counts only the person's switch and the
  tunnel). The upload is the resumable one on connections of its own, with no deadline, and hosts on by
  default install one at a time (a host the person turned on never waits in that line). A start that fails
  runs again by itself, later and later (`try-later.ts`; a config change elsewhere does not hurry it), never
  touches the daemon link or the host's sessions, and raises one Walnut Health item per host
  (`health-item.ts`). On a host on only by default, the follower is stopped after the failure, and after the
  last step of the ladder (60 minutes) Walnut stops trying by itself until a newer build, a reconnect or
  Retry. A host on by default that waits for its host or a newer daemon, or is not eligible, is not listed
  as a problem in Settings nor as a replica.
- **On a machine that handed the leader over**, the follower also serves that machine's console at the
  address its leader served (a second listener, `src/replica/console-door.ts`), the console being a device
  of the new leader. Nothing in the daemon changes for it: the follower reads a console file beside the
  machine id. Detail: [The old leader's console](./leader-switch-console.md).

## Topology, files, CLI lifecycle and delivery paths

**Topology:** walnut (Mac) ←ssh tunnel→ daemon (remote bun binary) ←spawn→ `claude -p` CLI. Goal: tunnel/daemon crashes don't lose sessions.

**Remote files:** `/tmp/open-walnut/sessions.json` (registry), `/tmp/open-walnut-streams/<sid>.{pipe,jsonl,pgid}`. JSONL is source of truth.

**CLI lifecycle (READ THIS: easy to get wrong):**
- `claude -p --input-format stream-json` is **LONG-RUNNING**, NOT per-turn. One CLI process stays alive across many messages, reading new input from its FIFO stdin between turns. (Evidence: a session with 39 messages had only 4 spawns.)
- The daemon holds the FIFO open with `O_RDWR` (`daemon-standalone.ts`) so the pipe survives between turns. Process is reaped only by the **idle timer** (`SESSION_IDLE_KILL_MS = 2h`, 5-min warning) or a real death (ENXIO / pid gone / crash): never "turn ended".
- `isTurnCompleteExit()` does NOT mean turns exit. It only runs *inside* `reapSession()` to normalize the exit code *when a death already happened*, deciding if the last JSONL `result` line was a clean turn-end vs a crash.
- `--resume <sid>` is the **fallback** path (FIFO write failed / process really died), not the normal send path. Normal send = write the live FIFO.

**Delivery paths (where mid-turn injection breaks):** A send to a session walnut thinks is "processing" (`activeProcessing`) goes through `injectMidTurn` (gated on `targetSession.hasPipe`); otherwise `processNext` (writes the FIFO directly, no hasPipe gate). Pitfall: `RemoteSessionManager._hasPipe` is set `true` only in `start()`: `attach()` (used when reconnecting to an already-alive CLI after a daemon restart) returns `alive:true` but historically left `_hasPipe=false`, so `injectMidTurn` falsely reported "no FIFO pipe" and queued the message until the turn ended (25 to 55s grey stall). Keep `_hasPipe` in sync with daemon-authoritative liveness, not with spawn-vs-attach.

## The server never signals a CLI pid; orphans end through the owning daemon

**The server never signals a CLI pid; orphans end through the owning daemon.** A pid in a session
record proves nothing about which daemon spawned the process: on 2026-09-26 an ephemeral test server
over a hand-copied production `sessions.sqlite` SIGTERM'd the user's live CLIs from its orphan sweep.
Every server path that ends a CLI now sends the owning daemon's `stop` (`src/core/sessions/owner-stop.ts`),
and every such stop names the asking Walnut (`home`, capability `owner-home-v1`, `stop-provenance.ts`): the
daemon refuses one for a session its spawn journal records for another Walnut. Orphans use reason
`'orphan'` (capability `orphan-stop-v1`, fail-closed on old daemons), which the daemon honours only for a
process in its own registry (the pid it holds, a matching `.pgid` file in its own streams dir written at
spawn by it or by the daemon it took the session over from, a first spawn-journal line naming the asking
data dir) that nothing keeps alive. Ephemeral servers clear every
inherited pid at boot, refuse to boot on the production data dir, send `strict` stops (only sessions the
journal names them for), and send no stop at all to a daemon without `owner-home-v1`. Ratchet:
`tests/core/signal-call-ratchet.test.ts`.

A host's own server starts its sessions naming its data dir as their home, while its follower link,
the leader's link and the slices name that Walnut by its leader's home. Every owner lookup and compare
in the daemon goes through `walnutOfHome` (both twins): a data dir of a server the daemon runs for a
leader (`host-server-core.ts walnutOf`, from the spec files it reads again at boot) is that leader's
Walnut, and the spawn journal line names that Walnut (`walnut`, beside `home`) so it stays so after the
spec is gone. Without it, after a restart of the host's service, the host's runner could not read its
own host-judged session's stream and dropped the next turn's result (2026-11-23 release rehearsal).
What follows the mapping: the follower's reads, the session's hooks and turn-snapshot settings, its
gateway caller (whose `walnut` calls it makes), its call socket, and the leader's stop, orphan stop,
strict start and trigger resume. What does not:
- only the leader's layouts count, by real path: `<host root>/walnuts/<walnut id>/...`, or the shared
  `<host root>/data` from before the split when its `.walnut-id` mark names the spec's whole walnut id
  (`legacyDataOwnerScript`). A spec whose data dir is a Walnut's own home, the production data dir or
  another server's is refused at configure;
- the companion bridge's gate reads the home the latest spawn here named, unmapped
  (`sessionStartHomeOf`: the live spawn, else the resume record, else the journal's first line): the
  bridge never sends to, attaches to, resumes or answers a prompt of a session the host's own server
  started or took over by a resume, also after the daemon restarts; that server and its leader's
  channel operate it;
- a stop asked from the data dir (the host's replica) reaches only a session that server spawned last
  here (`servedStopRefusal`, the same latest-spawn home): one the Mac started and runs stays the Mac's
  to stop. The replica is that
  Walnut everywhere else at the daemon, so the server's own guard (`replica-process-guard.ts`) is the
  fence for the rest.
Tests: `tests/providers/host-server-own-session-owner-twins.test.ts`, `tests/e2e/host-judge-service-restart-e2e.test.ts`.

## One CLI per session id on a host, whichever daemon asks

**One CLI per session id on a host, whichever daemon asks** (`src/providers/cli-owner-core.ts`, both
twins). A daemon only knows its own registry, so a second daemon on the same host (an ephemeral test
server's, a restarted one that could not adopt) used to `--resume` a live session as a second process
on the same transcript: 2026-10-25, an ephemeral server's copied `wait_until` clock did, and two CLIs of
one session edited one tree. Every spawn that names its transcript (`--resume`/`--session-id`, not a
fork) first claims `<spawn-journal dir>/cli-owners/<config dir key>/<sid>.json` with O_EXCL; a record
there is judged against the process table (CLI pid alive with its start time, or a live daemon's claim
under 120 s), never trusted, and a stale one is broken. After the claim a `ps` scan refuses a live
process of the same sid in the same `~/.claude` that no record names (an older daemon's CLI). A refusal
is `errorKind: 'session_live'`, spawns nothing and touches no one's FIFO or process. The server reads
it as `SessionHeldElsewhereError` (`delivery-failure.ts`): the message is parked with that cause (a
Retry sends it once the other process is gone), the session goes back to stopped, the task to
NEED_ACTION with the cause as its status, and an asker waiting on a reply is told at once that its
message was NOT delivered (2026-10-28: a `claude -r` left open in a terminal refused every send for
hours, the server retried on each reconnect, and the asker read "its turn ended" with a quote from
hours before). The words say plainly that the user (or someone) has the session open in a terminal,
the task is fine and the message waits, so nobody takes the task for broken; a lead is not told its
worker failed, and the record keeps `heldElsewhere` (2026-10-28: a lead read the old words as "broken",
moved the work and closed the task the user was working in). `task_transfer` from a session never
completes a source still in use (`src/core/transfer/source-in-use.ts`: a person wrote in it, or its
session was open elsewhere, within 7 days; open subtasks, an org role, an armed trigger); it says why
in `sourceKeptOpen`. Every park answers the askers of the rows it parks
(`src/core/sessions/undelivered-requests.ts`), a request whose message still waits in the target's
queue is never settled by a turn end of the target, and a cold resume's first line stays queued until
the new process's init (a CLI that dies loading the session parks it instead of losing it). Ratchet:
`tests/e2e/session-undelivered-e2e.test.ts`. A daemon replacing its own CLI waits for its whole process group to exit
first. An ephemeral server's starts carry `strict`, and the daemon refuses one for a transcript the
spawn journal records for another Walnut (`session_other_walnut`), live or not. Ratchets:
`tests/providers/cli-owner-core.test.ts`, `tests/providers/daemon-cli-owner-twins-e2e.test.ts`.

## A session's walnut call reaches only its own Walnut's server

**A session's `walnut` call reaches only its own Walnut's server** (`src/providers/gateway-identity-core.ts`,
both twins; 2026-11-10: on a host shared by two people's Walnuts, one person's link dropped three
times in ten minutes and the gateway's fallback to "any server socket that names no Walnut" sent
that person's sessions' calls to the other person's bulk socket, which never names one). A socket
speaks for the Walnut it is bound to (`leader.configure`, `host.slice`), else for the Walnut of a
bound socket of the same server run (the hello's `run`, which the bulk channel sends too). A session
is pinned to the Walnut its copy, its spawn or the spawn journal names (`gatewayOwnerHome`), and its
calls go only to that Walnut's sockets: never another Walnut's, and a socket that names none only for
a Walnut that never identified itself on this host (`walnutPinned`: a copy, a bound socket, or
`daemon.serves.json` within the week), and never one whose hello said it binds (`binds: true`, every
server since this change) in the minute before it does. A call no Walnut owns (a session no record
names, a terminal's `walnut` on a host with two Walnuts' copies) keeps the old rule, a socket that
names none, which cannot tell two older servers apart; a terminal's call on a host where every
connected server speaks for one Walnut goes to that one. With none connected the call is answered from the copy, waits,
or fails `hub_unreachable` saying nothing was sent; it never falls back. A result is taken only from
that Walnut's sockets (`mayAnswer`). Ratchets: `tests/providers/gateway-walnut-pin-guard.test.ts`
(every function that sends a relay frame and every caller of the send), E2E with the link dropped
and stalled again and again beside a second Walnut: `tests/providers/daemon-gateway-walnut-pin-twins-e2e.test.ts`.

## A task whose session host is gone is never stuck

**A task whose session host is gone is never stuck** (`src/core/sessions/host-lost.ts`; 2026-11-07:
a task on a laptop that went offline answered 502 to task_move, "already has its active session" to
a start elsewhere, and "its host has not confirmed it yet" to task_stop, for good). A stop on a host
with no live link and no answer to a fresh connect (8 s) stops the session here at once: the record
carries `hostLost` (when, which host, why, who), its stop request stays pending, so nothing is sent
to it from here, and the host's reconnect sends that stop before any redelivery (`sessionStops.flush`),
which ends the old CLI and stamps `hostLost.endedAt`. Carrying the work on elsewhere is stricter
(`hostGone`): the link down 2 minutes or more of this machine's AWAKE time (a down link samples
its own clock, `AWAKE_TICK_MS`, so a Mac's sleep never counts), not for a sign-in failure, and this
machine online (the move's new host answers, or another host does, or with none it has an address
and the failure is not its own network); short of that the move or start answers 409
`host_unreachable` with why and when to try again (it was a 502). Then `task_move` copies nothing
from the old host and starts on the new one with Walnut's own copy of the conversation (the
history cache from the last compaction on) or, with none, the task's summary; a start on another
host (`task_start`, quick start) becomes that move. ACP engines keep the refusal (their thread lives
on the host). What the lost session wrote on its host after the stop is refused at the journal
replay (`lostSessionWindow` in `offline-handover.ts`). A send to a task, or to its old session,
while any move runs is held and goes with the task, never `target_archived` (2026-11-08).
Ratchet: `tests/core/sessions/host-lost-paths.test.ts` (every refusal on an unreachable host, per
file, with its way out); live: `tests/fleet/host-lost.fleet.ts`.

## Daemon restart

**Daemon restart:** old `cleanup()` leaves CLI alive. New daemon reconciles sessions.json then scans `.pgid` files: scan MUST skip sids already adopted (`if (sessions.has(sid)) continue`). All death paths funnel into `reapSession()` in `daemon-core.ts`; it calls `isTurnCompleteExit()` to normalize code to 0 when JSONL tail shows clean turn completion (otherwise every turn-end shows "exit -1" in UI).

## Work survives a daemon restart (experiment `work_survives_restart`)

With the experiment on and a daemon that names the capability, work started on a host outlives the
daemon that started it, and the next daemon follows it. The known exceptions, where the code picks
the safer side or says it does not know:

- A run adopted with no start time recorded (its daemon died a few ms after the spawn) is followed
  but never signalled, and let go at its deadline plus 60 s (`endedBy: 'let-go'`); it may still run.
- An ACP command whose daemon never answered reads `result_unknown`, never a guessed success.
- A trigger fire whose whole line went into the pipe of a CLI that died before reading it counts as
  delivered (no second copy; that fire is lost). A fire being delivered at the moment of an upgrade
  from an older daemon, which wrote it under another uuid, may be delivered again once.

- **host_exec** (`host-exec-detach-v1`): the command runs under a `/bin/sh` wrapper that writes its exit
  status to a file (`detached-run.ts`); the output goes straight to its log. The next daemon adopts it
  from its registry entry (`host-exec-adopt.ts`), so deadline, stop, `wait_for` and the exit code work as
  before. The audit only records: a run whose start line left the audit's 1 MB tail is still adopted.
- **Plugin scripts** (`host-script-detach-v1`): the server asks again with the same `scriptId` after a
  lost link and gets that run's result (`host-script-detached.ts`, `src/core/hosts/host-script.ts`).
- **ACP workers** (`acp-survive-v1`): stdin is a FIFO, stdout and stderr are files, request ids never
  repeat and the read offset is saved (`acp-survive.ts`). A lost command is asked again with the same
  command id, which the worker answers once; when no daemon answers in time the caller gets
  `result_unknown`, never a guessed success (`acp-ask-once.ts`).
- **Trigger fires**: every fire has a persistent id (`fireMessageId` in `trigger-check-core.ts`), saved
  with its batch before the write; a retry sends that same batch and the receiver keeps it once. A fire
  that resumes a stopped session is checked against that session's own records first and written as
  one marked line under a uuid derived from its id (`lineReachedSession`, `lineUuidOf` in
  `line-fate-core.ts`). This part is not behind the experiment (with it off, ids only stop being random
  and a resume is not repeated).

**Rollback.** New-way work is listed in `<state>/detached/` (`detached-registry.ts`), one shell-readable
file per run. `stop-detached.sh <dir> [kind ...]` ends the listed runs whose process still started when
the listed one did, and records why. Every service of this version writes `<dir>/adopts` (the kinds it
adopts) before it tells the launcher it is ready, and ends listed runs of any kind it cannot adopt. The
launcher removes `adopts` before it starts any version and runs the stop script when a ready version
did not write it (a version older than this file adopts nothing). A handover from an older CLI names
no `adopts`, and the outgoing daemon ends that work itself. A server older than detached runs reads
hello `execHolding`, which counts them, so it waits for them to end before it puts its own daemon in
place; a newer server reads `execHoldsUpdate`, which does not.

**Trigger checks that cannot catch up.** A check interrupted by a restart runs again, and a fire is
delivered once. What a check missed while no daemon ran is caught up only when the check can see it
afterwards:

| Kind of check | What happens across a restart |
|---|---|
| Compares the current value with the last one | A change that came and went while no daemon ran is never seen |
| Reads a source that keeps data for a limited time | Data that expired during the gap is gone |
| Consumes what it reads at the source | A restart after the check consumed items but before its state was saved loses them |
| Fires (`fire: true`) without items | Whether it fires again depends only on the script's own state |
| First run, or its state was lost | Unreadable state is replaced by empty state; state unused for 30 days is deleted; a failed save is only logged; nothing is fsynced |
| Clock routines | Missed runs catch up once, merged into one run |
| Ids pushed out of the `seen` list | Fire again (a duplicate, never a loss) |
| More than 50 undelivered fires (`PENDING_FIRES_MAX`) | The oldest are dropped |
| Throttled checks | Keep the cursor they had |
| Check state over 16 KB (`CHECK_STATE_CAP`) | The run is refused as an error; the last saved state stays |

Tests: `tests/providers/host-exec-detach.test.ts`, `tests/providers/acp-survive.test.ts`,
`tests/providers/acp-ask-once.test.ts`, `tests/providers/trigger-restart-once.test.ts`,
`tests/providers/oneshot-mcp-restart.test.ts`, `tests/core/hosts/host-script-reask.test.ts`.

## A session's stdin FIFO is write-only (mode 0200), and nothing but its CLI may read it

**A session's stdin FIFO is write-only (mode 0200), and nothing but its CLI may read it.** A FIFO
has one byte stream and any reader takes from it. On 2026-10-05 an agent ran
`grep … $(ls -t)` in the streams dir; Claude Code's `grep` is its embedded ugrep, which reads a
FIFO named on its command line, so for 12 minutes every line written to every live session on
that host went to grep. The daemon locks each FIFO right after it opens it for the CLI, on every
adopt path, and in its startup permission repair (`LIVE_FIFO_MODE`, `daemon-core.ts`); the CLI
keeps its fd 0 and the daemon writes O_WRONLY, so neither notices. Behind it,
`send-lost-line-v1`: a line the CLI has not named after 30 s is challenged with a `get_settings`
written after it. Claude Code reads stdin in order, so an ANSWER with still no word on the line
proves the process read past it, and only then is the line written again under its uuid
(`lostPid`, after a lone newline that ends any fragment the CLI holds). No answer proves nothing;
a marker out of the daemon's scan window proves nothing either. Ratchets:
`tests/providers/daemon-send-dedupe-twins-e2e.test.ts`, `tests/providers/line-read-past-rewrite.test.ts`.

## A machine has one id, whichever alias reaches it

Each OS account on a machine keeps one stable id in `~/.local/state/open-walnut/machine-id` (32
random hex digits, made once and never rewritten; never under `XDG_STATE_HOME`, the same rule as
the net key). It lives outside every Walnut data dir, so it survives a reinstall that keeps the home,
a new port, a new or moved data dir and a renamed alias; a copy of the data dir on another machine
does not carry it. The first one is seeded from the id an older build kept in a data dir's
`local/machine-id`: the served data dir's first (the server's `WALNUT_HOME`, a daemon's
`OPEN_WALNUT_HOME` when it has one), then `~/.open-walnut`'s; one rule for the server and both
twins. The daemon update stores still read an entry kept under the data dir's older id and move it
under the stable one, so a stable id another process seeded first orphans none. Where the file
system has no hard links the file is made with an exclusive create. The server reads it through `src/core/machine-id.ts`; both daemon twins send it in
their hello as `machineId` (`src/providers/machine-id-core.ts`). The Mac records the id each alias's
hello gave in that alias's host profile (`~/.open-walnut/hosts/<alias>.json`, `machine`, with what
the row connected to then), and the `hosts` aliases with one id are one machine in every list
(`src/core/hosts/daemon-twins.ts`), though their links were never up at once. A daemon older than
the id sends none, and its aliases are joined only by the pair both links confirmed together, as
before. The backup writer keeps an existing `local/backup/machine-id` and uses the stable id only
where none exists. Known limit: the id is a file in the account's home, not read from the system, so a
machine cloned from a disk image of another (a VM template, a restored home) carries the same id.
Walnut then counts the two as one machine: their aliases join into one row, usage reads one of them,
and naming one in `host_service_offer` offers the other too (the one-service lock is not affected: it
is a lock per machine and daemon dir); the id is also the holder id of a switchable leader's write
permission, so two clones read as one holder there. Walnut does not tell clones apart by a second fact:
the facts that would (the host name, a disk id, `/etc/machine-id`) also change on one machine in
normal life, and a changed id makes a data dir read as copied to another machine
(`src/core/home-move.ts`). Tests: `tests/core/machine-id.test.ts`, `tests/core/hosts/machine-id-twins.test.ts`,
`tests/providers/daemon-machine-id-twins-e2e.test.ts`.

## A Walnut has one key on a host, whatever its data dir

A host's daemon keys each Walnut's state by its first home there (`walnut-scope-core.ts`,
`walnutScope.keyOf`, the ONE key every core takes). A home move is declared, never inferred: the
server keeps `local/home.json` (`src/core/home-move.ts`: this machine's id and the data dir's path).
Same machine, another path, and the old path no longer holds a data dir with this Walnut's id: the
data dir moved, and `leader.configure` carries `movedFrom` (the old path) and `formerHomes` (every
path it used on this machine, newest first, at most 8) as the first per-home frame of every connect
(`daemon-connection.ts` holds the other commands for it). An old path that still holds the id is a
copy and declares nothing, unless it is the same folder (realpath: a symlink, HOME spelled two
ways), which is a move from the other spelling; a copy or a restore on another machine declares
nothing. A restore switch carries the record with the data folder. The record is kept whatever the
one-service experiment (`in_process_daemon`) says, off the connect path; only the declaration waits
for it, and with it known off a connect waits on nothing of this. A leader switch that committed
(`docs/reference/leader-switch.md`, "Hosts follow the new leader") is the one move across machines:
the new leader declares the old holder's data dir, as that server spelled it, with the experiment
off too, and its connects wait until its commit stands.

On the host, `movedFrom` makes the new home an alias of the first one (`<leader dir>/homes.json`
v2, which older daemons never read; land 1's v1 entries are dropped at first read) only when the
host's leader record for the first former home it knows names the same Walnut id (a host that
missed some moves follows from the one it knows), that home is where the Walnut is now there, the
id is not volatile, and the new home has no record of its own. A declaration from a home that is
not where the Walnut is now (a backup started after the move) is refused for good (`contested`):
the first copy to move keeps the Walnut, and the two never take turns. A move the host keeps
under a folder it cannot follow (`lost_trail`, `own_record`, ...) is said on the answer
(`moveNotTaken`), and its server shows one Walnut Health item for that host. From then on every command's `home` (and the `home` inside a `spec`
or `template`, a copy's `home`, a trigger def's `deliver`/`start` home) is read as the first home:
the leader book's epoch, trigger memory (epoch, seq, seen), journals, copies, plugin jobs, the host
server and the bridge link go on. The home the Walnut left is refused for good: a server socket that
still speaks as it gets `walnut_home_busy` with `movedTo`, so two diverged copies never take turns on
one Walnut's state, and its server shows one Walnut Health item for that host
(`src/core/leader/home-busy-health.ts`). Another Walnut (another id) at a path one left gets
`walnut_home_taken`, and its item says to run it from another data folder: the host keeps the
first Walnut's state under that path, so it cannot be let in there. Known limit: that other Walnut
cannot use this host under that path at all (sessions, host_exec and the follower there all refuse it)
until it runs from another data folder, or the first Walnut declares a move back; letting it in would
mix two Walnuts' state under one key. A declared move back flips it. A copy that declares nothing
is a Walnut of its own by its path. No file is moved or rewritten, and every file's embedded `home`
still hashes to its name, so a rollback reads every file as before; a rollback to a daemon without
aliases reads the new home as a separate Walnut (its epoch starts at 0 and its trigger memory is
empty). The served record (`daemon.serves.json`) keys the home the Walnut speaks from now. Tests:
`tests/providers/walnut-scope-alias.test.ts`, `tests/providers/daemon-home-alias-twins-e2e.test.ts`,
`tests/core/home-move.test.ts`.

## The Walnut service on a host

Behind the experiment `service_launcher` (off by default) and the config list `host_service_offer`, a
host can run its session daemon and one Walnut's follower server as ONE process: the Walnut service.
A host not in the list runs two programs, the daemon and the follower child it starts, as before.

**One process.** The launcher still runs `<install root>/versions/<sha>/<file> --service`, the same
command line. That entry first reads `<install root>/service-mode.json` (`src/binary/service-entry.ts`,
`{ v: 1, home, exe, role?, walnutId? }`). With no file, or any doubt (another version's file, no follower spec for that
home, a spec that is not the replica program, a spec running its fallback), it runs the daemon as
always and logs why. Otherwise it runs the follower server of that home (`runWeb({ replica: true })`,
the same entry as `walnut web --replica`) from the spec the daemon keeps for it
(`host-server/server-<key>.json`, with its token), and the server holds the daemon runtime in its
own process (`src/providers/in-process-daemon.ts`, mode `service`). Before it takes the data dir's
lock it ends the follower child an older daemon left (`stopRecordedServer`, by pid and start time);
the spec stays, for a rollback. The server is the one writer of the launcher's marks
(`src/web/serve-launcher-beat.ts`): `ready` once the runtime adopted its sessions, the door answers
and `GET /api/v1/instance` does. `service.update` and `service.handover` from `walnut daemon update`
end the whole process, as they end a daemon. Agent CLIs stay detached and adopted from the registry,
so their pids never change across the switch.

**A role: replica or leader.** The mode file also carries `role` (`src/binary/service-mode.ts`, absent =
`replica`) and `walnutId`. `replica` is the above: `home` is the Walnut this service follows. `leader`
(a machine the leader switch promoted) runs the leader server on `home`, this machine's data dir,
with the runtime in the same process (`runLeaderService`, `runWeb({ replica: false })`); no follower
of that Walnut starts there (the runtime's supervisor skips its spec, `leads`), and the server asks
for its own permit at boot as on any leader. One writer changes the role: `setServiceRole` (by
Walnut id, never by path; idempotent; it checks the follower spec or the home at write time and
sends no signal); `walnut daemon update` keeps the role and leaves a leading machine's mode alone.
Before any home opens, the start hooks of `src/binary/service-start-hooks.ts` run (5 s in all, local
files only; the switch's resume lives there and may add env for this one start). A leader that is not
ready (the launcher's ready mark names it) within `WALNUT_SERVICE_LEAD_READY_SECONDS` (180) writes
`service-role.fallback` and stops the planned way; the next start runs the daemon only until a new
mode write or version. The planned stop writes its release record well inside the launcher's 60 s stop
wait. The compiled file says which roles it can take (`<exe> __daemon --service-roles`); the hello
carries `serviceRoles` and, for the launcher's good version, `goodRoles`, which host_get shows.
Tests: `tests/binary/service-role.test.ts`, `tests/binary/service-start.test.ts`,
`tests/providers/service-roles.test.ts`, `tests/providers/one-service-lead-e2e.test.ts`.

**Two Walnuts on one machine: one service each** (experiment `host_service_sets`, off by default).
A service belongs to one Walnut. The Walnut that already holds the default places keeps them; a later
Walnut on the same OS account gets its own set under `~/.open-walnut-host/walnuts/<id16>/`
(`src/providers/service-set.ts`): install root `daemon/`, runtime `rt/` (or
`/tmp/open-walnut-set-<uid>-<id16>` when its sockets would not fit), its own boot item
(`open-walnut-daemon-<id16>.service`, `dev.openwalnut.session-daemon.<id16>`, cron tag
`# open-walnut-daemon <id16>`), registry, streams and ports. The host's CLI chooses
(`walnut daemon install|update --walnut <id> --walnut-home <home>`, `src/providers/service-set-choice.ts`:
a set already installed, then the claim file `set-owner.json`, then the default's mode owner, then
another Walnut in `daemon.serves.json`) and prints `service set: default|<id16>`. A set's runtime keeps
its sessions like the default one (`WALNUT_SERVICE_SET`, `KEEPS_SESSIONS`); the machine's single copies
(the user PATH shim, `~/.open-walnut/tmp`) stay with the default set. Shared on purpose, and only:
the machine id and the cli-owner records (one CLI per session on the host, whichever service asks).
walnut-net is not shared: a set's daemon runs its own, with its own key, address, config, control
socket and UDP port in `walnuts/<id16>/net/` (`netStateDir`), and the machine's
(`~/.local/state/open-walnut/net`) stays exactly as it is, so a machine with one Walnut changes
nothing. A host-network leader pairs with its set over the link it already holds to the shared daemon
(`walnut daemon net-id`: the set's daemon takes the leader's member list and answers its endpoint;
`src/providers/service-set-net-pair.ts`), keeps the endpoint on the host's record and lists it in its
own walnut-net (with a cloud companion also on its relay list); no pairing, no move. A port stream
never reaches another set's daemon door. Moving off a
shared daemon does not carry live CLIs over (`src/providers/service-set-move.ts`): the leader waits
(bounded) for a moment when nothing of it works there (no session in a turn or with work that outlives
its turn, judged from the host's fresh `getState` and the runner; no host_exec run of its tasks; no
command under way: `service-set-move-checks.ts`), holds every command that would start work there in
`DaemonConnection.send` (`service-set-hold.ts`), stops its follower there, stops each session the normal
way and proves its CLI gone (the daemon's `cli.holder`: pid and start time), empties its triggers and
plugin jobs there (`triggers.configure`, `jobs.configure` for its home), flips the link (SSH: the set's
runtime dir; net: the set's endpoint, the shared one put back when the set does not answer) and resumes
them in its own service on their next message; once a net move is confirmed the leader drops the shared
endpoint from its own list and takes only itself off the machine's walnut-net list (`walnut daemon
net-forget`), never another's key, member or process; a move that cannot finish gives back what it took and is reported, and failures in a row back
off and end after four tries. A host whose move is done stays this Walnut's set whatever the experiment
says later (its lines keep `--walnut`, SSH keeps dialling the set's runtime dir).
The shared daemon, its launcher and boot item stay as they are, the other Walnut's. Leaving a host
(`leaveServiceSet`) stops this Walnut's follower there, then runs
`walnut daemon uninstall --yes --walnut <id>`: the set's boot item goes, and its whole dir
(`walnuts/<id16>/`, the staged versions and its walnut-net state included) goes too once its daemon,
every CLI in its registry and its follower are gone (`src/providers/service-set-remove.ts`); otherwise
the answer's `setDir` says what still runs. Then the set's own walnut-net is stopped if its daemon still
answers (never the machine's), and the leader forgets its endpoint here and on the companion's relay list.

**The follower calls the runtime directly.** In the service the follower link is
`createDirectFollowerLink` (`src/core/link/follower-link-direct.ts`): it calls the runtime's
`follower` seat (`DaemonRuntime.follower`, a `FollowerSeat`), the same `FollowerEntry` functions
(`src/providers/follower-entry-core.ts`) the `follower.*` commands run on a socket. No socket, no
`follower.hello`, no frame is built; the daemon log says `follower: the server in this process
follows its leader`. A call the runtime's drain refuses (a `service.update` pauses it, and an update
that fails resumes it) is sent again inside the caller's timeout, as on the socket link
(`swapResender` in `src/host-server/daemon-link.ts`, which both links share with `preflightFrame`).

**The door still serves everyone else**, with the same commands and handlers as a daemon program:
`daemon.port`, `daemon.pid` (naming the service) and `daemon.stamp` (`src/providers/daemon-door.ts`).
Its hello says `serves: 'walnut-serve'` and `serviceHome`; an older leader sees a daemon, since the
command line is still `--service`. Through it:

- old and new leaders (their session links, list, attach, send, `server.configure`, updates);
- walnut-net: the net supervisor (`net-core.ts`) runs it on a config naming the door's port file;
- hub forwards: a port in the machine's `hub-forwards.json` becomes a stream over a leader's link;
- a second Walnut's follower server: the supervisor (`host-server-core.ts`) starts it as a child, as
  before, and it says `follower.hello` with its token. The supervisor starts no child for the
  service's own home (`selfHome`); a spec change for that home saves the spec and ends the service,
  so the launcher starts it again on the new spec.

One service per machine and daemon dir: a second one on the same dirs is refused with the reason
(`AnotherServiceError`, or the data dir's instance lock naming the first) and the first is never
stopped. Two services on two dir sets of one account are separate: neither lists, adopts or stops
the other's sessions.

**How the leader offers the switch** (`src/providers/one-service-mode.ts`). It wants the service on
a host only when both experiments are on, the host's daemon already runs under the launcher (hello
`launcher`), this Walnut already runs its full follower there (`web --replica`, the spec the
service starts from), and this build's walnut file can go to the host (the daemon-only binary holds
no server). Otherwise there is no offer, and Walnut Health says why, one item per host
(`src/core/hosts/one-service-health.ts`, never a popup). A wanted mode that differs from the hello's
`serves` is an update due, with the same holds and probation as a new build: the update line
carries `--serve <home>` (only under the launcher) or `--no-serve <home>`
(`daemon-service-update.ts`). Only the Walnut whose home the mode file names may change it; another
Walnut's update is told `not_service_owner` and carries the mode over to the new version. For a host
that serves as this Walnut's service, the host-server manager starts no separate follower there, and
the hosts page and Settings say "Walnut service" (only for this Walnut's own: `servesThisWalnut`).

The offer is per host: a host gets it only while its key is in `host_service_offer`, read live from
the config (`hostServiceOfferWanted(hostKey)` in `src/providers/service-launcher-flag.ts`, the one
function every part of the offer reads), and a host taken out of the list goes back to two programs at
its next update. `in_process_daemon`, which runs the Mac's own sessions in process, offers no host
anything (2026-11-23: with it on, every host under the launcher was offered at its next update, a
macOS host that had never run the service among them, and no host could be put back alone).
`WALNUT_HOST_SERVICE_OFFER=1|0` decides the offer alone for one process. A switch whose update ran is recorded per host and build
(`daemon-update-mode-asked.json` in `WALNUT_HOME/local/`, `daemon-update-store.ts`): a host whose service chose the other mode, or whose update failed after
its swap, is not asked again with that build, across leader restarts; a try the host held, deferred
or refused as busy is asked again. A host replica never holds a `__local__` DaemonConnection
(`assertLocalDialAllowed` in daemon-connection.ts): in the service that would be a full-trust
client of the runtime with no owner scope, so its reads of its own host stay on the seat. The one
exception is the own-sessions link: while a service runs and judges its own sessions
(`src/core/session-channel/host-boot.ts`, behind the host-runs-sessions switch), its session runner
reaches the runtime in its own process, at the in-process address only. That link does no leader
work: its hello names no Walnut, and no command in `LEADER_ONLY_COMMANDS` (leader.configure, the
host copy, triggers, hooks, bridge, skills, servers, jobs, secrets, the network, task-dir sweeps)
leaves it (`tests/providers/replica-own-sessions-link.test.ts`).

**Offering chosen hosts only: `host_service_offer`.** A leader config item (not an experiment),
`host_service_offer: [<host key>, ...]`, the keys of `hosts`, set with `PUT /api/config`. A host in
the list is offered the service, whatever `in_process_daemon` says (still with `service_launcher` on),
and gets all of the offer: the walnut file staged in its slot, `--serve`, and its Walnut Health
items. The list turns nothing else on: with `in_process_daemon` off the Mac's own runtime stays a
program, and home-move declarations and same-machine aliases stay off (so move the data dir only with the host out of the
list, or the moved Walnut cannot switch the old home's service back). A host taken out of the list
gets `--no-serve` at its next update. An absent or empty list changes nothing. An older leader keeps
the key: config reads and writes carry top-level keys they do not know. The item is temporary, until
the step that removes the old two-program path on a host.

**Upgrade and rollback.** An update with `--serve` stages the walnut file, proves it boots as a
service in throwaway dirs (`daemon-boot-proof.ts`), writes the mode file naming that version, and
the launcher runs it as a trial; the service adopts every session from the registry. Each way back
uses machinery that already exists:

- a trial that fails, or a crash in probation: the launcher puts the good version back; the mode
  file names the new version only, so the old one runs as a daemon and starts the follower child
  from the kept spec;
- the experiments turned off: the next update carries `--no-serve`, the file goes, and the same
  build restarts as daemon plus follower;
- an older leader or binary: it never reads the file, so the host runs two programs again.

**The machine id.** The service's hello carries the same `machineId` as the daemon it replaces
(`~/.local/state/open-walnut/machine-id`, above), so the leader sees one machine before and after
the switch, and the host keeps each Walnut's state by its Walnut id, as a daemon program does.

Tests: `tests/binary/service-entry.test.ts`, `tests/providers/one-service-host-e2e.test.ts`,
`tests/providers/one-service-lock.test.ts`, `tests/providers/one-service-door.test.ts`,
`tests/providers/one-service-mode.test.ts`, `tests/providers/one-service-switch-chain.test.ts`,
`tests/replica/follower-link-both.test.ts`.

## A session run and judged by its host: the switch, per host

A service on a host can run and judge the sessions started there itself (phase 2 of
`docs/plan/one-service-every-host.md`, `src/core/session-channel/`). Two levels decide it, read in one
place (`src/core/session-channel/switch.ts`):

- the experiment `host_runs_sessions` (Settings, off by default): on for every host;
- `hosts.<name>.runs_sessions` in the leader's config.yaml (config only, no Settings control): `true` turns that one host on even with the experiment off,
  `false` keeps it off even with the experiment on, absent follows the experiment. So one host is
  turned on at a time, and default-on later needs no entry per host.

Only the leader's start decision reads it per host (`hostRunsSessionsFor`, the start probe of
`judge-of.ts`): a new start on a host goes to its service when the switch is on for that host and the
service names `session-judge-v1`. Every other reader asks "on for any host" (`hostRunsSessionsAny`):
the host's session routes and its dialers, the leader's door and credential issuer, the companion's
listener door and the heartbeat. `tests/core/session-channel/switch-readers.test.ts` lists every
caller of each and fails on a new one. A config write takes effect without a restart on either side: the
leader reads the switch again at every write, and a host's service whose session side is not up
starts it after the first config copy round that turns the switch on (`host-boot.ts`
`followHostSwitch`); the leader links its channel once the host's report names `session-judge-v1`.
Turned off again, the host keeps its session side: a new start there answers
`host_runs_sessions_off`, its door and companion dialers do not dial again once their link drops, and
the sessions it runs keep running and reporting over the leader's link.

A host reads the leader's config through the config copy, which never names `hosts.*.runs_sessions`
(an older replica refuses a whole row that names a field it does not know): the leader's copy says the
hosts turned on in a row of its own, `hosts_run_sessions` (`config-allowlist.ts`), which an older
replica refuses alone. An older leader keeps the field (config reads and writes keep host fields
they do not know) and ignores it.

Turning a host off (`runs_sessions: false`): its new starts take today's path at once; the sessions it
already runs keep running and reporting through the channel until they end, as with the experiment.
The full rollback order, and what a straight downgrade does, are in "A session a host runs" of
`docs/plan/one-service-every-host.md`. Going back to a leader older than the ban lifts every ban: it
reads a revoked host's record as never issued and issues it a fresh key. Remove a revoked host from the
config before going back, or revoke it again after going forward.

What a revoke ends and what it keeps is one table, `src/core/session-channel/revoked-reach.ts`, and
the revoke's answer reads it back (`refused`, `stillReaches`). In short: a ban is of the machine
under every config key it had when it was made, and every key a link to the same daemon tied to it
since, whatever its daemon says later; a key whose hello only claims the banned machine id is banned
while it says so, never made part of the ban. Only the key the ban was made as lifts it (another
name answers 409 `banned_as`). It runs no new process there (`gateSessionCommand` refuses each
start, cold `--resume`, ACP start and one-shot run), moves no work there (task start, move,
transfer, subagent), pushes it none of this Walnut's copies, secrets or plugin jobs, pushes the
bridge turned off and deletes its machine tokens at the companion (`bridgeTokens` in the answer; one
the companion did not answer for is tried again each minute), and moves the tunnel back here. A
process there or this Walnut's data handed to it (exec, file writes, commits, HTTP, MCP, a trigger's
run, a terminal, a service update) and a tool allowed in a session there go only for a person's own
call (`core/session-channel/person-call.ts`), never a session's, a routine's, a trigger's or a
peer's. Only a person's own lines and a stop reach a session already running there; every other row
is parked with why. Reads that only bring an answer back stay.

## Keep the twins in sync, and auto-deploy

**Keep in sync:** `daemon-standalone.ts` (bun binary) + `daemon-source.ts` (JS fallback). Build: `bash scripts/build-daemon.sh`.

**Auto-deploy (use this):** `DaemonConnection` compares local `.version` vs remote `binary --version`; if differs, gzips + chunks binary into 1MB pieces, each via separate SSH connection (bypasses proxies that kill >5MB transfers), retries 2x per chunk, falls back to 44KB source deploy if chunked binary fails. Just `bun run build && bash scripts/build-daemon.sh && bun run dev:prod`: the next UI send to that host auto-upgrades (old CLI processes survive via Phase C).

## Every hold on that update has an end

**Every hold on that update has an end** (`src/providers/daemon-update-behind.ts`; 2026-11-05: a host
whose sessions always run stayed on an old daemon for about 17.6 hours, the reasons taking turns).
One clock per host and running build, kept on disk. Once a host has run another build for 3 hours
the waiting stops: every hold gives way (host_exec runs, open ACP turns, the update gap; this
server's writes in flight get 30 s), and the swap passes `walnut daemon update --over-busy`
(`daemon-over-busy.ts`): plain asks for 30 s, then `force` (a daemon with `service-update-force-v1`
goes over its requests, relays, ACP workers and host_exec runs, each run's log saying why), and at
a minute, or when the daemon does not answer (its hello or the update), a restart by its service.
That restart's SIGTERM shutdown drains for at most 45 s, then ends by SIGKILL to itself, and the cron
supervisor SIGKILLs the daemon pid alone after 60 s (systemd and launchd have their own stop
timeouts). The CLI sessions are their own process groups and keep running; an ACP turn or a
host_exec run open at that moment ends. An older daemon's shutdown does not wait for file writes, so
from the swap's start (after the upload, on the SSH path, the host network path and this Mac's own
managed daemon alike: `daemon-file-fence.ts`) this server holds its file changes back, at most 3 minutes in all (`SWAP_FILE_HOLD_MAX_MS`); writes from
another client of that daemon are not covered. A host that still runs another build after 3 such
swaps (a broken version stamp) is not forced again for that build (`MAX_FORCED_TRIES`). 3 hours is when the waiting stops, not a bound on the whole update, and on a
host that is never quiet a forced swap can come about every 3 hours while builds keep landing. An
update not done with no clock to ask again is listed in `DAEMON_UPDATE_STOPS` with why. `DAEMON_UPDATE_HOLDS` lists every place an update is put off;
`tests/providers/daemon-update-holds-ratchet.test.ts` fails on one not listed.

A host_exec run marked `resumable` (it only waits or reads, and its caller runs it again) never
holds the update (`src/providers/exec-runs-hold.ts` `holdingJobs`, the daemon's `holding()`; 2026-11-17:
a chain of 2-hour waits kept one host's daemon about 3 hours behind), and neither does a waiting read
of it. The daemon's stop (a handover's or a SIGTERM's) ends it, its log saying to run it again; other
runs outlive a SIGTERM stop as before. An older daemon ignores the field, so its runs still hold.

## A service's swap reconnects when the new daemon answers

A reconnect waits for a daemon swap this connection runs, so it never deploys, starts, stops or
rebuilds the ControlMaster under the swap. A service-managed swap is the one exception
(`attachDuringSwap` in `daemon-connection.ts`; 2026-11-13: every service update left the host down
for 55 to 60 s although the new daemon served within 8 s, because the update answers only after the
host watched the new daemon stay serving for 30 s). The service starts the new daemon, so the
reconnect looks in the daemon dir (a read-only scan, every 2 s at first and backing off to 10 s) and
attaches only to a daemon that stayed: the same pid, port and runtime-dir instance in two looks a
step apart, whose hello names that instance and not the one that dropped. It still deploys, starts
and stops nothing while the swap runs. The handover stays armed until the update answers, so a
drop before then (a build in a crash loop, or the old build put back after a failed one) reopens
the window, is not counted as a link drop, and reconnects again the same way; the swap ends as
"swap done" when the link is up at its end, else with the failure. A handover that ends with the
link still down puts the outage in the host-link ledger from the drop on (and one link drop when
its window ran out), since later failed redials make no new down edge. An unmanaged swap needs none of
this: it ends at its stop, and the reconnect itself starts the new daemon. Tests: `tests/providers/daemon-connection-deferred-upgrade.test.ts`.

## Never scp manually

**Never scp manually**: some corporate SSH proxies kills large transfers. That's exactly what the chunked auto-deploy solves.

## CLI scheduled tasks (crons) are DIRECTORY-scoped, not session-scoped

Upstream docs say "session-scoped". They are wrong, and a 2026-08-09 incident here proved it: session A's recurring cron fired *inside session B* (same cwd) as a bare user message, running a multi-hour unattended job under `bypassPermissions` with zero provenance. Behavior model, established by controlled experiment (CLI 2.1.224):

| `durable` | Where it lives | Creator killed | Creator `--resume`d |
|---|---|---|---|
| `false` (CLI default) | in-memory | job dies, **no** other session can adopt it | **REVIVES** from history replay and immediately fires anything overdue |
| `true` | `{cwd}/.claude/scheduled_tasks.json` | the current **directory** lock holder (`scheduled_tasks.lock`) ADOPTS and executes it | creator reclaims it |

Consequences to keep in mind: killing a process is *never* a reliable way to stop a cron (only `CronDelete` is); recurring tasks auto-expire after 7 days; a creator schedules its own tasks without holding the lock (the lock only gates adopting *foreign* tasks); `CLAUDE_CODE_DISABLE_CRON=1` stops a bystander from ever adopting.

**Walnut can enforce `durable:false`: OPT-IN, delivered as daemon hooks (hooks-v1)**. Default posture is ZERO hooks: a generic install denies nothing, injects nothing, and never rewrites the user's `scheduled_tasks.json`. Two ways to opt in: (a) config sugar `session.cron_policy: 'session-only'` compiles the built-in rule set, or (b) install the self-contained template `src/data/hook-templates/session-only-cron.yaml` into `~/.open-walnut/hooks/` and edit freely (your file wins over the sugar by id). The server compiles `~/.open-walnut/hooks/*.yaml` with `runtime: daemon` into ONE rules JSON (`src/core/hooks/daemon-hooks.ts`) and pushes it via the `hooks.configure` RPC (NOT bridge-reachable; hash-skipped no-ops) at connect + hot on config change: no daemon restart needed on `hooks-v1` daemons; older daemons fall back to `WALNUT_ENFORCE_SESSION_CRON=1` set at spawn. The daemon interprets rules (never executes pushed code) at four points (`src/providers/daemon-core.ts` `evalDaemonHookRules`), in order of how much they can be argued with: (1) `cron.create` → `deny` the durable `CronCreate` at the `can_use_tool` intercept; (2) `cron.created` → `inject` a fixed "CronDelete + recreate non-durable" correction for bypass sessions which never ask: **advisory, and a live CLI verifiably refused it** on 2026-08-11, reasoning that an automated message is not user authorization (correct reasoning, which is why it can't be the guarantee); (3) `cron.fire` (foreign) → `evict` the orphaned row from disk: a foreign fire proves nobody in this process will ever CronDelete it, and eviction is the only thing that ends the hourly hijack loop (2026-08-13: 22 fires); (4) `session.reap` → `strip-own-rows` from `scheduled_tasks.json`: the model has no say, and death is exactly when a durable row becomes adoptable. Foreign fires always get a `scheduled_task_fire` stream marker for the HUMAN (observation), but deliberately NO model-visible message (the old injected warning burned a turn + context per fire and stopped nothing). Idle reapers treat a cron-armed session as long-lived (`hasDiskCronInterest`, 7d), and terminating one needs `force:true` (409 `cron_owner`). `WALNUT_ALLOW_DURABLE_CRON=1` on the daemon is the emergency kill-all override: better yet use crontab/launchd starting its own dedicated session for cross-session jobs.
