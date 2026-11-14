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
