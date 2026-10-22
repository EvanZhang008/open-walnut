# Replica servers: implementation plan

Status: implementation plan (2026-10-13, revision 2 on 2026-10-14 folding in the review: per-record ack,
new v2 kind names, coalescing by append, journal location and lock, leader door, drain failure policy,
op ids, conflict log, build order; see 14b for what was changed or rejected), owner: replica architect.
Design: `docs/plan/walnut-replica-servers.md`. Related: `docs/plan/walnut-servers-everywhere.md`,
`docs/plan/walnut-control-plane.md`, `docs/plan/daemon-first-hosts.md`.
Tree read: private clone at `1fe1fd194`. All `path:line` citations refer to that tree.

## 0. What this plan changes in the design (read first)

| # | Design says | Fact | Plan decision |
|---|---|---|---|
| C1 | host server holds "tasks (exact)" (`docs/plan/walnut-replica-servers.md:21`) | task copy posts only to the companion (`src/core/replication/task-replica.ts:59-62`); the store refuses off `CLOUD_MODE` (`src/core/replication/task-replica-store.ts:163,233`) | WP3 sends the task copy to every replica target and gates the store on `isFollower()` |
| C2 | "Mac asleep, the phone writes a note: Needs your Mac" (`:215`, `:240`) | user requirement 2: notes must work and auto-resolve | notes ARE writable while away when the host holds the note's base (WP11, section 5) |
| C3 | stage 5 retires the companion's own queues | six working queues with their own ledgers (`src/core/task-queue.ts:1-70`, `src/core/send-queue.ts:1-82`, `src/core/cloud-chat-outbox.ts:1-51`) | kept. The companion moves to the stream forward and the boot policy only (WP13); retiring queues adds risk and no user value |
| C4 | presence: "leader heard within 30 s" | three windows today: follower writes 30 s (`src/providers/daemon-standalone.ts:3342-3345`), gateway skips the primary at 3 beats = 45 s (`:2883`), takeover 60 s (`:2879`) | one window `LEADER_QUIET_MS` (default 30 s, env `WALNUT_LEADER_QUIET_MS`) read by the daemon for follower writes AND gateway routing for a home that has a follower, and by the replica (WP2, WP7) |
| C5 | "the replica reads that same copy" for notes | follower socket has no `replica.*` read (`src/providers/daemon-standalone.ts:792-809`) | new owner-scoped follower reads `replica.list`, `replica.read`, `replica.readMany` (WP6); no second vault on the host |
| C6 | devices "copy on both" | device copy skips the companion on purpose (`src/core/replication/device-replica.ts:1-16`) | unchanged: companion keeps its own pairings |
| C7 | design mentions no journal location | journal and leader book live in `/tmp/open-walnut` (`src/providers/daemon-standalone.ts:2808`, `:2886`), lost on reboot | WP8 moves journals, slices and the leader book to ONE root per host in every mode (`~/.open-walnut/tmp` for the host's own daemon, `DAEMON_DIR` for an isolated one); every boot migrates any legacy v1 journal that holds records (section 5 Location) |
| C8 | design assumes a per-record handover | the journal ack is a watermark: `ack(home, upTo)` drops every `seq <= upTo` (`src/providers/offline-host-core.ts:476-491`), the Mac acks the max seq it was handed (`src/core/offline-handover.ts:167-171`) | v2 ack names exact seqs (`offline.ack {seqs}`, cap `journal-v2`); an old Mac is handed only the prefix before the first withheld record (section 5) |
| C9 | design lists a boot policy over `server.ts` | `CLOUD_MODE` is read 568 times in 152 files; many modules self-gate in their start function (`src/core/boards/board-reminders.ts:204`, `src/core/task-wait-until.ts:232`, `src/core/session-title-reconciler.ts:310`, `src/core/notes-indexer.ts:189,482`) | WP1 ratchet covers all of `src/`; copy stores open read only on a replica (section 2) |
| C10 | design's dev box check uses an ephemeral Mac | an ephemeral server is `isReadOnlyRemote` for every non-local host: no slice, no leader.configure, no host server, no drain (`src/providers/daemon-connection.ts:625-627,1108-1109,1842`) | browser fixture boots a non-ephemeral Mac child; the dev box check uses an isolated daemon and a narrow opt-in (section 13) |

## 1. Target architecture as built

```
 phone (QR) ──https──▶ tunnel on host ──▶ 127.0.0.1:<public port>
                                              │
 ┌──────────────── host (dev box) ────────────┼──────────────────────────────┐
 │  walnut web --replica  (same dist as the Mac, installed by the Mac)        │
 │  ┌ front (src/replica/front.ts, mounted BEFORE body parsers) ┐            │
 │  │ route table -> dispatcher -> forward | local | feature | away │        │
 │  └───────────────┬──────────────────────────────┬────────────┘            │
 │   copies on disk │ (generic replication kinds)  │ follower Link (loopback)│
 │   WALNUT_HOME=~/.open-walnut-host/data          ▼                          │
 │                                  host daemon (twins: bun standalone,       │
 │                                  node source) owns: CLIs, journal v2,      │
 │                                  host.slice, notes/memory/skills copy,     │
 │                                  leader book, stream relay                 │
 └──────────────────────────────────────────────▲─────────────────────────────┘
                                  SSH forward + │ stream lane (Mac dials)
 Mac: walnut web (leader) ─────────────────────┘   pushes copies on streams,
   owns every store; drains the journal v2 on return (per-field merge, ledger)
 companion (optional): walnut web, placement cloud, may stand in (unchanged leader book)
```

Process facts on the host after this plan:

| Item | Value | Why |
|---|---|---|
| program | `<node> <appDir>/dist/cli.js web --replica` | the spec is generic (`src/providers/host-server-core.ts:142-168`); dist already ships `cli.js web` and the SPA (`src/core/host-server/package.ts:79`) |
| role env | `WALNUT_ROLE=replica`, `WALNUT_PLACEMENT=host` (plus `WALNUT_HOST_SERVER=1` kept for old code paths) | `followerKind()` already keys on `WALNUT_HOST_SERVER` (`src/core/server-role.ts:20-24`) |
| data | `OPEN_WALNUT_HOME=~/.open-walnut-host/data` (same dir the host server uses: device and search copies carry over) | `src/core/host-server/manager.ts:318` |
| own run dir | `WALNUT_DAEMON_DIR=~/.open-walnut-host/run` | `LOG_DIR`, streams, dtach and image dirs derive from it (`src/constants.ts:303-325`); the replica must never write `/tmp/open-walnut` |
| daemon | linked as a follower through `WALNUT_HOST_DAEMON_DIR`; `localDaemon.ensureRunning` never called | hijack risk (`src/web/server.ts:1238-1255`, `src/providers/local-daemon.ts:270-283`) |
| listen | `127.0.0.1` only, public port marked as a tunnel port (no loopback waiver) | `src/web/server.ts:2248-2252` binds all interfaces; `src/web/middleware/local-trust.ts:98-110` |
| leader door | a SECOND http server fed only by streams the daemon accepts from `primary` (`src/host-server/main.ts:77,88,211-226`); `/bridge/*`, `/host-api/*`, `/git/data` and the linked replica router are mounted ONLY there; the public app answers 404 for `/bridge/*` and `/git/data` | `createLinkedReplicaRouter` has no credential (`src/web/routes/bridge-replica.ts:59-77`) and is safe only off the public port |
| env scrub | `WALNUT_FOLLOWER_TOKEN` and `WALNUT_HOST_DAEMON_DIR` read once at boot, then deleted from `process.env` | the supervisor passes the token in env (`src/providers/host-server-core.ts:248`), `readHostServerEnv` keeps it (`src/host-server/env.ts:33-41`); the full server spawns git, shells, workers |
| file modes | every copy file 0600, every copy dir 0700 (as `src/host-server/device-copy.ts` and `src/providers/host-server-core.ts` do); a per-host Settings choice of copied kinds | inbox bodies, boards, personas now reach a dev box that may be shared |
| reboot | for a host with the replica on, the Mac offers and defaults to the managed systemd user service with linger; without it the host row says "after a reboot of <host>, the QR needs your Mac" | only the service restarts the daemon after a reboot (`src/providers/daemon-connection.ts:2911-2915`) |
| budget | idle RSS under 400 MB and idle CPU under 1% with copies of 6,500 tasks and 5,000 sessions, logged in the `boot policy` line | one replica per Walnut home on a host |
| identity | `/api/v1/instance` answers the leader's `walnutId` from `WALNUT_WALNUT_ID`, never a minted `auth.json` id | `src/core/device-store.ts:536-545` |
| auth | device token hashes from the device copy (`src/host-server/device-copy.ts:16-96`), no loopback trust, machine tokens refused; device copy rows gain a stable `id` (the record id), `listHash` stays over `name:tokenHash` so old host servers still match; a device round fires on every device create and rotate, and the pairing UI says "ready on <host>" only after the host acked the new hash | rows hold only `{name, tokenHash}` (`src/host-server/device-copy.ts:24`, `src/core/replication/device-replica.ts:58-61`); immediate rounds fire only on revoke and target change (`:133-150`) |
| fallback | in the DAEMON: `server.configure` carries `fallback {args, env}` (same app dir, `cli.js host-server`); `host-server-core` switches to it by itself after 3 exits within 10 min, reports `{program:'fallback', since, lastError}` in `server.status`, returns to the primary args after 1 h or the next configure | supervisor restarts with backoff only (`src/providers/host-server-core.ts:100-102,188-207`); away-mode code runs only while the Mac sleeps, so the Mac cannot switch the program then |

User decisions encoded: a host replica is the same server program; the Mac leads; the companion is a
replica with placement `cloud` that may stand in; every connection is a `Link` (SSH forward, loopback
socket, reverse WebSocket are transports); `local` routes are answered on the replica even while the
Mac answers; Ask Walnut is a Claude Code session, so while the Mac is away a new ask runs as a session
on the host (WP12).

## 2. Role, placement, boot policy

`src/core/server-role.ts` gains (read once at boot from env, test reset hook kept):

```
role():      'leader' | 'replica'      WALNUT_ROLE, else 'replica' when CLOUD_MODE or WALNUT_HOST_SERVER=1
placement(): 'mac' | 'host' | 'cloud'  WALNUT_PLACEMENT, else cloud when CLOUD_MODE, host when WALNUT_HOST_SERVER=1
hasLocalDaemon(): placement mac, or cloud with cloud.exec on (src/web/server.ts:1215,1238)
runsSessions():   placement mac or host
canStandIn():     placement cloud and the user allowed it (backupAllowed, src/web/v1-forward/proxy.ts:74)
```

`src/core/boot-policy.ts` is one table, one row per background job in `startServer`, each row
`{job, leader, replicaHost, replicaCloud}`. `server.ts` reads `bootPolicy(job)` instead of a raw
`CLOUD_MODE` at each gate the maps listed (`src/web/server.ts:1052,1244,1259,1271,2442,2549,2598,
2649-2675,2691,2709-2710,2762,2935,3114,3139,3171,3197,3275,3301,3470,4829,4957-4964,4970,5232,5380,
5815`) and the primary-only replica pushes (`src/web/server.ts:1953-1972`). For `leader` and `cloud`
the table reproduces today's values exactly (ratchet: a test computes the old `CLOUD_MODE` truth for
each row and compares). At boot the server logs one line `boot policy` with every row's decision.

The gate list above is only the `server.ts` part. `CLOUD_MODE` is read 568 times in 152 files of `src/`, and
many modules gate inside their own start function (C9). Ratchet `tests/core/boot-policy-ratchet.test.ts`
covers ALL of `src/`: every `CLOUD_MODE` read is either replaced by `role()`, `placement()` or `bootPolicy()`
or listed in the ratchet with its host-replica decision; the count may only fall. The gates still missing
from the list above (`src/web/server.ts:1300,1319,1355,1668,1857,1885,1941,2303,2321,2470,2564,3083,3546,
4838,5866`) are read first and get a row each. Runtime guard: when `role()=='replica'` every copy store
opens READ ONLY except the one follower apply connection, so a stray write throws loudly in tests.

Host replica rows that are OFF: local daemon, cloud box probe, local claude probe, letter push,
notes watcher, own search wiring (the search copy is used instead, `src/web/server.ts:1974-1979`),
git auto-commit, git compaction, session auto-recover, integrity check, reconciler, health monitor and
reapers, orphan passes, pin retirement, backup scheduler, plugins, cron, heartbeat, triage bootstrap,
leader heartbeat, every replica push, update check, side threads, board reminders
(`src/core/boards/board-reminders.ts:204`), the wait-until clock (`src/core/task-wait-until.ts:232`), the
title reconciler (`src/core/session-title-reconciler.ts:310`), the notes indexer
(`src/core/notes-indexer.ts:189,482`). A boot test asserts none of their `started` log lines appear on a
replica. ON: express app, WS handler, the front (section 3), copies' follower stores, the search copy,
presence.

Letter push is OFF on a replica (no relay credential is copied). Stated limit, shown in the away line:
"Prompts on <host> are not pushed to your phone while your Mac is away." A push path from the replica
is not built in this plan.

Env scrub: the replica reads `WALNUT_FOLLOWER_TOKEN` and `WALNUT_HOST_DAEMON_DIR` once at boot and deletes
both from `process.env` (as the server does for its QoS request), so no child it spawns carries them.

## 3. Link, routing table, dispatcher, presence

`Link` (`src/core/link/link.ts`) is the design's interface (`docs/plan/walnut-replica-servers.md:63-73`).
Three adapters: `daemon-connection-link.ts` (the Mac's SSH link, wraps `DaemonConnection`),
`follower-link.ts` (wraps `src/host-server/daemon-link.ts`), `bridge-link.ts` (wraps one
`bridge-registry` socket). WP2 builds the follower adapter; WP13 the other two. `heard()` counts frames,
never socket state.

Route table: `src/replica/route-table.ts`, an ordered list of `{method, pattern, cls, away}` where
`cls` is `local | feature | leader` (default `leader`) and `away` is one of `read`, `host-write`,
`queue:<kind>`, `note-write`, `needs-leader` (default for a non-GET: `needs-leader`; default for GET:
`read`). Ratchet `tests/replica/route-table-coverage.test.ts` fails on a write route with no explicit
`away` row, so a new write never journals by accident. The walk is NEW code (the companion's
`tests/web/routes/v1-forward-policy.test.ts:12-40` is a hand-written path table, not a walk): boot
`startServer` in test mode with `WALNUT_ROLE=replica`, read the express 5 `app.router` stack layers
recursively (method and path of every route), and read the WS handler's registered RPC method table;
plugin routes are class `leader` by prefix. The test also lists every `/api/v1` route the iOS app calls
(`/api/v1/status`, `/api/v1/instance`, `/api/v1/me`, `/devices/self`, task list, edit, create, session
list, send, history) and requires an explicit away row for each.

Op ids: every client write carries a client-minted `x-walnut-op-id` (one per user action; web client and
WS RPC writes, the web client's raw `fetch` writes too through `installOpIdFetch` in `web/src/api/op-id.ts`;
the iOS app keeps working without one, the replica mints it then). A web write the client retries keeps
its id across every attempt (`withWriteRetry` in `web/src/api/write-retry.ts`; every automatic retry site,
the session header's phase menu included), and a 504 `sent: true`, a 503 `leader_unsure` with `why:
'lost_answer'` or `journal_unwritable` is never retried automatically: it is shown, as its message asks. A
plain 503 `leader_unsure` (the forward failed before a byte was sent and nothing was journaled) is retried
under the same id. The client's own deadline (its fetch timeout) fires before a replica's write budget,
which starts only once the request is fully written to the Mac, so a web write that reached a slow Mac
is retried under the same id by design: the Mac's `applied-ops` ledger and its in-flight op-id
reservation (WP9) apply it once. The session header's phase menu retries a flat 2 s apart (about 10 s
before it puts the server's copy back), and a newer pick drops the older pick's pending retries. Known exception: the two `navigator.sendBeacon` writes (the time-tracking heartbeat, the browser log
flush) cannot set a header and carry none, so the replica mints one per beacon; both are counters or logs
where a second copy costs nothing. The replica keeps the id
on forward and on journal. The Mac's write routes check and record it in the `applied-ops` ledger (section
5) for direct writes too, so a forward and a journaled retry of the same action apply once. The replica
stamps `x-walnut-forwarded-at`; the Mac refuses a forwarded write older than 20 s with
`409 stale_forward`, never applied (a write that sat in the buffers of a frozen Mac).
What the stamp means (WP9 implements the check to this): the HOST's clock (ms) when the replica opened
the stream to the Mac, before any body byte (a header cannot be stamped later). So the Mac judges the age
when its server first sees the request's headers, never after the body is read (a 15 MB upload from a
phone takes longer than 20 s and is not stale), and against the host's clock, not its own: a remote
host's clock may be minutes off the Mac's. Until the Mac knows that host's clock offset (measured on the
link), it does not refuse on age; the ledger alone then makes a late forward apply once.

Dispatcher (`src/replica/dispatch.ts`), mounted before `createPluginBodyParser` and `express.json`
(`src/web/server.ts:1355,1378`) so forwarded bodies stay raw bytes:

```
cls local   -> next() (the express route runs here: host session history/transcript, file reads, git diff reads, health)
cls feature -> next() (the route calls routeFeature; leader engine dropped when !leaderAnswers())
leaderAnswers() -> forwardHttp over link.openStream('primary','web')   (src/host-server/proxy.ts:31-84)
   writes get a forward budget only when the client says its wait (x-walnut-wait-ms, at least 15 s,
      at most 20 min), then 504; a write that says none (the iOS app, a raw fetch) is never cut while
      the Mac works on it, as on the host server today: the client's own deadline ends it, a presence
      flip answers it 504 at once, 20 min is the backstop (past the iOS app's longest wait, 900 s)
   a 504 says whether the write reached the Mac (`error.sent`): sent, "it may have kept the change;
      check it before you try again"; "nothing was saved" only for a flip while the stream still opened
   GET/HEAD failed before any byte answered -> answerAway
   write failed after the request was written -> 504 {error.code:'primary_timeout'} (never journaled;
      the op id makes a retry safe for a client that sends one: a later journaled retry is deduped by the
      ledger; a client that sends none gets a new id per attempt)
   write failed before the stream opened -> answerAway (provably not sent)
   the Mac really away (the quiet window, no daemon view, the companion leads) -> every in-flight forward
      answered 504 at once, every socket spliced to it closed 4001; a suspect mark (one failed stream to a
      live Mac) only steers NEW requests and handshakes, it cuts nothing (src/replica/presence.ts macAway)
   WebSocket upgrade -> spliced raw (src/host-server/proxy.ts:87-120); a close of its own (4001, 4002)
      goes between two frames (src/replica/ws-frames.ts): mid-frame, the rest of that frame first;
      a target frozen mid-frame has the socket dropped after 1 s (1006), never a broken frame
else answerAway:
   read        -> next() on the copies, response header x-walnut-offline: <asOf ms>, JSON body unchanged
   host-write / queue:<kind> / note-write -> next() with req.replicaWrite set; the route's write goes to
                  the replica write port (WP10) instead of the store
      follower.op answers leader_answers (the replica's view was up to VIEW_STALE_MS old,
                  src/host-server/route.ts:23) -> provably not applied: forward once to the leader
                  with the same op id; that forward failing before any byte -> 503
                  {code:'leader_unsure', retryAfter:5}
      follower.op answer lost or timed out -> retry with the SAME op id (the daemon dedupes, section 5)
      follower.op never sent (the link refused it: `notSent`) -> no lost answer; the next try waits
                  for the link (at most 5 s); never sent on any try -> 503 needs_leader
                  {why:'daemon_unreachable'} (retryable: nothing can be journaled)
      the daemon without `replica-ops-v1` (its `hello`, asked once per link) -> 503 needs_leader
                  {why:'daemon_needs_upgrade'}; no hello answered yet -> {why:'daemon_unreachable'}
   needs-leader -> 503 {error:{code:'needs_leader', why, retryAfter}}
```

WebSocket RPC writes on `/ws` follow the same table: the WS handler checks an RPC method table
(`src/replica/ws-rpc-table.ts`) before dispatch, and every WS RPC write carries the client op id. While
the leader answers, `/ws` itself is spliced to the leader, so the replica's own WS serves only away mode
and the presence event. A spliced socket to a frozen Mac stays open and silent (SIGSTOP keeps sockets),
so the replica moves clients itself: on a flip to away it closes every spliced `/ws` with close code
`4001 leader_away`; on a flip back it closes its own away sockets and the ones the companion took with
`4002 leader_back`, once a probe stream to the Mac opened (`leaderReturn` in `src/replica/presence.ts`: a Mac whose frames flow while its
stream door still refuses must not move every browser off and back on at each flip). The client
reconnects at once without a reload and lands on the right side. `useLeaderPresence` also reads
`x-walnut-offline` on every HTTP response.

Local routes need host data while the Mac answers, and the replica has no `DaemonConnection` for the
Mac's alias of this host (history goes through `record.host`: `readProviderSessionHistory`,
`boundHostRead`, `rewriteHistoryRemoteImages`, `src/web/routes/sessions.ts:1238-1331`). Self-host shim
(`src/replica/self-host.ts`): on a replica, the session host alias equal to this host resolves to the
follower Link. Follower read commands those routes need (owner scoped to that home's session cwds, cap
`replica-reads-v1`): `fs.ls`, `fs.read`, `fs.stat`, `fs.readRange`, `fs.resolvePath`, `fs.grep`,
`git.diff`, `git.fileShow`, `git.fileLog`, `changes.compute`, `changes.file` (none is on the follower
allowlist today, `src/providers/daemon-standalone.ts:786-809`). Every file write, git commit and the
terminal stay class `leader`: the terminal is a `/ws` RPC (`src/web/terminal/register.ts`) and `node-pty`
is not installed on hosts (`--omit=optional`, `src/core/host-server/install.ts:68`), so away it answers
`needs_leader {why:'terminal_needs_mac'}`.

Presence (`src/replica/presence.ts`): input = the follower view (`src/host-server/daemon-link.ts:22-34`),
age, and the last forward outcome (suspect 5 s, `src/host-server/route.ts:23-61`; on the replica each
mark after another with no answer between them doubles, up to LEADER_QUIET_MS, and an answer starts the
count again: `SuspectMarks`). One rule:
`leaderAnswers = holder=='primary' && primaryConnected && primaryHeardAgoMs + viewAge < LEADER_QUIET_MS
&& !suspect && drainablePending == 0`. `drainablePending` (new in the follower view) counts this home's
journal records the CURRENT leader's drain kinds can take; a record parked for a newer Mac never counts,
so it can never pin the host away (the hazard `src/core/offline-handover.ts:146-148` warns about). While
the Mac's frames are back but its drain is still running, the replica stays away and keeps writing to
the journal, and the daemon's `followerWriteTarget` accepts follower writes while `pendingHandover`,
mirroring the gateway rule at `src/providers/daemon-standalone.ts:3458`. So there is one writer during a
drain (the journal, replayed in order), and away edits keep their marks until the drain ends. The
daemon applies the SAME `LEADER_QUIET_MS` to follower writes and gateway routing (WP2), pinned equal by
`tests/providers/leader-twins.test.ts`. The daemon's own leader book keeps `primaryAgeMs` (boot grace)
for the companion's takeover and adds a separate `heardSinceBoot` flag used only by the follower view
and `primaryAnswersFollower` (D14). A change emits one WS event
`replica:presence {answers, asOf, host, why}`; companion standing in keeps today's path
(`chooseRoute` returns `companion`, forwarded as today).

## 4. Copies: one generic replication kind

`src/core/replication/kind.ts` defines a kind; `src/core/replication/kind-leader.ts` runs it per
`ReplicaTarget` (`src/core/replication/replica-targets.ts:30-61`) with per-target state (the search
copy's shape, `src/core/replication/search-replica.ts:363`); `src/core/replication/kind-follower.ts`
is the store side behind `POST /bridge/replica` (`src/web/routes/bridge-replica.ts:29-78`). On a host
replica that route lives ONLY on the leader door (section 1); the public listener answers 404 for every
kind (pinned by `tests/replica/leader-door.test.ts`).

```
interface ReplicaKind<Row> {
  kind: string                        // 'tasks', 'sessions', ...
  keys(): AsyncIterable<string>       // leader, in store order when ordered
  row(key): Promise<Row | null>       // leader
  project(row): unknown               // leader: what is hashed and sent (strips volatile/unsafe fields)
  ordered: boolean
  removalFloor: number                // refuse a manifest removing > half once local count >= floor
  digest?: boolean                    // status step with count + 48-bit sum (src/core/replication/search-digest.ts:1-50)
  apply(puts, removes, order?): Promise<void>   // follower, one serial chain, persisted
  held(key): boolean                  // follower: row written here and not yet seen back from the leader
}
```

Protocol = the task copy's (`src/core/replication/task-replica.ts:27-50`): `status` (digest kinds),
`sync {entries:[{k,h}], asOf}` -> `{need, held, removed}`, `put {rows, last?}` -> `{stored, held}`,
512 KB batches, held > 0 reruns after 35 s, manifest hash skips an unchanged round, 5 min sweep.
A follower answers an unknown kind `404 unknown_kind`; the leader rests that kind for that target
10 min (pattern of `postToCloudReplica` 404/405). Refusals (`manifest_removes_most_rows`) go to a
per-target status (`GET /api/replicas/status` on the Mac, kind by kind: entries, held, asOf,
lastRefusal) and to one warning log; a refusal three rounds in a row raises a Mac Settings row, not a
letter. Each follower kind persists `cache/replica/<kind>.json` (state) plus its store file, at mode 0600
in dirs at 0700 (a test walks the replica data dir).

Schema: every kind carries `schemaVersion`. A follower whose code is older answers `409 schema_newer`
and the leader rests that kind for that target; the replica skips its own store migrations on copy files
(asserted: copy file hashes unchanged across a replica boot).

Mass removal: a legitimate prune on the Mac (session retention, a folder move of most notes) is refused by
the half rule. After 3 refused rounds of a stable leader manifest (the same count and key set), the leader
may send `confirm:true` with `confirmFor` {count, key set} (driven by the Settings row the refusal raised,
which shows the follower's `local` and `removing` from the refusal); the follower accepts it only when
`confirmFor` names the manifest it came with, and logs it.

Hold after ack: a row a journal record wrote stays held (and its overlay and mark stay) after the record
is acked, as `awaiting copy`, until a manifest whose `asOf` is later than the ack time has stored that
key, or 10 min pass. The Mac's copy put follows the drain only after the 3 s debounce, and the Mac may
sleep again in between (the companion's answer to the same gap: `LOCAL_WRITE_HOLD_MS`,
`src/core/replication/task-replica-store.ts:35-37,100-111`).

| Kind | Leader source | Follower store | Projection / guard | Ordered | Floor | Digest |
|---|---|---|---|---|---|---|
| tasks + registry | existing task copy, made a kind (WP3) | tasks.sqlite | as today (`src/core/replication/task-replica-store.ts:37-56`) | yes | 50 | no |
| search, devices | unchanged protocols, registered as kinds for status only; device rows gain a stable `id` and a round on create and rotate (section 1) | unchanged | | | | |
| sessions | sessions.sqlite | sessions.sqlite (replica-owned) | strips `pid`, `output_file`, pgid, every process field; `process_status` kept as a label; volatile `last_activity_at` excluded from the hash | no | 200 | yes |
| requests | session-requests.json | same file | status only moves forward on apply | no | 50 | no |
| inbox | human-inbox/index.json + bodies | same layout | bodies sent by `{id, h}`; letters never deleted by a manifest without the half rule | yes (index order) | 50 | yes |
| routines | cron-jobs.json + routine status projection | same file, read only | cron never runs (boot policy) | yes | 20 | no |
| boards | boards/<taskId>.json | same layout | whole document per key, 1 MB cap (`src/core/boards/board-store.ts:46-51`) | no | 20 | no |
| conversations | conversations/<agent>/_index.json + chat-history index | same layout | index only, bodies on demand by key | no | 50 | no |
| prefs | config/share/ui-prefs.json, favorites from config.yaml | `cache/replica/prefs.json` | favorites carved out, never the rest of config.yaml | no | 0 | no |
| config | config.yaml through an ALLOWLIST (`src/core/replication/config-allowlist.ts`) then `config-redact` | `cache/replica/config.json`, read by `getConfig()` when `role()=='replica'` | allowlist, not denylist; secret-shape check refuses the row on any hit (`src/core/config-redact.ts:1-30`) | no | 0 | no |
| personas | rendered Ask persona per console agent (WP12) | `cache/replica/personas/<agentId>.json` | prompt text without the MCP mount, effort, remembered model | no | 0 | no |

Notes, memory, skills stay in the daemon's copy (`src/providers/host-replica-core.ts:14-18`); WP6 adds
owner-scoped follower reads and WP11 a half-removal guard (today none, `src/providers/host-replica-core.ts:172-189`)
and held keys. The Mac side of that copy (`src/core/host-replica.ts:198-228`) caches the manifest hash in
`lastManifest` and has no held handling, so WP11 changes it too: when `sync` answers `held > 0` the memo
for that kind is deleted and a rerun scheduled after 35 s; after every drain ack that removed note
records, the host's memo is cleared.

Inbox bodies: while the Mac answers they are fetched on demand through the forward and not copied by
default; the per-host Settings choice (section 1) can turn on copying bodies, kinds off by choice answer
`needs_leader {why:'kind_not_copied'}` away. Secrets and plugin credentials are never copied; a route that needs one is `feature`
with the leader's engine only, or `needs-leader`.

Push, never poll: every leader kind triggers on its bus events, 3 s debounce, plus the 5 min sweep;
manifests are built in slices with `setImmediate` every 300 rows (`src/core/replication/task-replica.ts:95-131`).
Targets are served one after another, never in parallel (search pattern).

## 5. Writes while the Mac is away: one journal per host

Single writer rule: while `leaderAnswers()` the replica never applies a write (dispatcher forwards).
While away every write, whoever makes it (a phone tap through the replica, a session's `walnut` call
through the gateway), lands in the host daemon's ONE journal for that Walnut, through the daemon, in
order. The replica never writes its copies directly: it applies the write to an overlay the daemon
returns (WP10), so there is exactly one local writer per home.

New follower command `follower.op {op, args, actor, opId, base}` (cap `replica-ops-v1`). Its gate is
split from `followerWriteTarget` (`src/providers/daemon-standalone.ts:3337-3371`), which needs `cmd.sid`
to be a session of the follower's Walnut (`:3352-3353`) and so refuses every phone task, board or note op:
every `follower.op` passes a home check (follower socket for its home) and the quiet-window check
(refused `leader_answers` inside `LEADER_QUIET_MS` unless `pendingHandover`, section 3); the sid
ownership check runs only for session-scoped ops (send, permission, stop). Task ids outside the partial
slice are accepted for `follower.op` with the replica-supplied base. Then `offlineHost.handleFollower`.
The gateway path for sessions (`src/providers/daemon-standalone.ts:3418-3497`) reaches the same core function.

Dedupe: the daemon keeps an index of pending opIds per home; an append whose opId is already pending is
not written again and answers the first record's result, so a replica retry after a lost answer is safe.

Read side: `follower.pending {sinceSeq}` (new, read only, owner scoped, cap `journal-v2`, on the follower
allowlist and its parity test) returns pending records and blob hashes for the overlay. `offline.drain`
stays trusted only: it has side effects (marks rows handing over, `src/providers/offline-host-core.ts:449`).

One process per journal: a zombie predecessor can keep running after its successor writes `daemon.pid`
(`src/providers/daemon-standalone.ts:9034-9042`), and both share the prod state dir. Before any append or
compaction the daemon takes an exclusive per-home lock (`journal-<key>.lock`, `O_EXCL` with pid plus
process start time, stale only when that pid with that start time is gone) and re-reads the file tail
after acquiring it, so `nextSeq` comes from disk. A daemon that does not own `daemon.pid` refuses
`follower.op` and gateway writes with `journal_unwritable {why:'not_owner'}`.

Journal v2 (`src/providers/offline-host-core.ts`, both twins by `toString` inlining,
`src/providers/daemon-source.ts:238-265`):

```
file   <state>/offline-host/journal-<key>.ndjson   append-only, one JSON record per line, fdatasync per append
       <state>/offline-host/journal-<key>.state.json  {v:2, journalId, nextSeq, frozen:[seq], rows, settledCopies}
       <state>/offline-host/slice-<key>.json          the slice, moved WITH the journal (one dir)
       <state>/offline-host/journal-<key>.lock        per-home writer lock (above)
       <state>/offline-host/blobs/<sha256>            content-addressed note and letter bodies (WP11)
record {v:2, seq, opId, rev, at, actor, kind, supersedes?, ...}
actor  {kind:'session', sid} | {kind:'device', deviceId, name} | {kind:'trigger', id}
opId   'op-' + 16 random hex, minted by the WRITER (the client's x-walnut-op-id when present), unique
       across processes; journalId = 16 random hex per journal file
kinds  row | settle | delivery | settings | stop | resume | op       (v1 kinds, unchanged meaning and
                                                                     shape; 'op' is v1 ONLY)
       task-fields {op:'task_update'|'task_complete', taskId, fields:{f:{base|'unknown', value}}}
       task-create {taskId, fields, placement:{parentTaskId?, project?, groupId?, tier?}, order?}
       task-move   {taskId, anchor:{after|before: taskId}|null, tier?}
       board       {op:'board_set'|'board_edit'|'board_post'|..., args, postId?}
       note        {path, noteId?, mode:'put'|'create'|'delete', baseHash|null, baseBlob|null, oursBlob|null}
       session     {sid, taskId, host, cwd, agentId, model, effort, mode, title, startedAt}   (WP12)
       device-revoke {deviceId}                                                          (WP10)
       letter      {letterId, format:'markdown'|'html', args, bodyBlob}   a session's human_inbox_send; the
                   Mac sends it under letterId at `at`, once (the letter keeps the opId: createdByOp)
```

v2 kinds get NEW names on purpose: a kinds filter by name cannot tell a v1 `op` `{args, callerSid,
base}` from a v2 shape, and an old Mac's `applyRecord` would throw at `String(record.args.id)`
(`src/core/offline-handover.ts:296`) and then ack it as failed (`:146-167`). The daemon's
`tasksWithOverlay` (reads `r.args.id`, `src/providers/offline-host-core.ts:501`), `resolveTask` (`:512-523`)
and the Mac's `recordScope` (`src/core/offline-handover.ts:400-415`) learn the new kinds;
`tasksWithOverlay` and `resolveTask` include `task-create` records and their later `task-fields`
records, so a host-started ask's own `walnut task_get`/`task_update` finds its new task. A parity test
feeds every v2 kind to the `1fe1fd194` `applyRecord` and asserts none is acked (they are never handed
to it, section "Ack").

Coalescing (for `note`, and for `task-fields` on the same task, field and actor) is by APPEND, never in
place: a later save appends `{seq: next, opId: same, rev: rev+1, supersedes: oldSeq}` with the latest
value and the FIRST base; readers fold by opId and keep the highest rev. A record a drain handed out is
FROZEN (its seqs listed in state `frozen`, persisted, kept until acked, never cleared at reconnect, so a
redrain after a crash sees the same content the ledger recorded). A save that would coalesce into a
frozen record appends a NEW record (fresh opId) whose base is the frozen record's ours or value. The
ledger key includes `rev`, as a second guard. A coalesced save (same actor, same path, record not
frozen) is not charged against `WRITE_BUDGET`.

Note mode transitions under coalescing (later save onto a pending record of the same path):

| Pending | Later | Folded record |
|---|---|---|
| create | put | create (latest ours) |
| put | delete | delete with the first base |
| delete | create | put with the first base |
| create | delete | dropped (both lines folded away, blobs freed) |

Compaction: when acked bytes exceed half the file or 4 MB, rewrite the unacked tail by tmp+rename, under
the per-home lock, after re-reading the tail (so a line another process appended is never dropped).
A failed append answers the caller `journal_unwritable` (never a silent warning,
`src/providers/offline-host-core.ts:352-361`) and the replica returns 503 with the reason.

Location: records that exist nowhere else get ONE place per host, whatever mode the daemon runs in.
The host's own daemon (the prod dir, where the service runs, or its home fallback) keeps journals, slices
and the leader book in `~/.open-walnut/tmp` (the trigger state's home); an isolated daemon keeps them in
its `DAEMON_DIR`, in service mode too (only tests run `--service` on another dir).
Copies the Mac re-pushes (the host replica's notes) may follow the mode; a journal may not: two roots
made a cross-dir move of unacked v2 records necessary, and every transient read error in that move
(EACCES, EMFILE, a failed rename) could reorder the Mac's changes or lose a record (WP8 review rounds
1-3). No v2 journal exists on any host yet, so there is nothing to move: the only legacy data is v1.
Known limit: a home dir shared between hosts (NFS) would share this root; the trigger state has the
same limit. (Superseded wording: `<state>` followed the host-replica rule
(`src/providers/daemon-standalone.ts:2789-2791`): service mode `WALNUT_DAEMON_STATE_DIR`, the prod dir
`~/.open-walnut/tmp`, else `DAEMON_DIR`.) Tests use a
new tests-only knob `WALNUT_JOURNAL_DIR` (refused when the daemon dir is the prod dir), because in test
mode the state dir is `DAEMON_DIR` (`src/providers/daemon-standalone.ts:2792-2794`) and
`WALNUT_DAEMON_STATE_DIR` applies only with `--service`. Slices move WITH journals (one dir is
`offlineHost` `deps.dir`). Load: today `load()` finds journals only through `slice-<key>.json` files
(`src/providers/offline-host-core.ts:368-385`) and `configure()` never reads a journal (`:408-423`), so a
migrated journal with no slice beside it is invisible and the next append restarts at seq 1. v2 loads
journals by scanning `journal-*` files, independent of slices; `nextSeq = max(seq on disk) + 1` at load
(never `state.json` alone); `configure()` adopts an on-disk journal for a home it has not loaded.

Migration runs at EVERY boot, not once: any v1 journal that holds records, in `/tmp/open-walnut/offline-host`
or in `DAEMON_DIR/offline-host` (where v1 wrote; never a v2 file, which is never read outside the one root), is appended as v2 lines with opId `v1-<sha16 of the canonical record>`
(deduped by that id while pending, and by the acked ids kept in `state.json`, so a v1 file an older
instance rewrites later never brings an acked record back), then renamed `.migrated`. A downgrade (the
Mac auto-deploys whatever daemon it bundles, an LKG rollback included) writes v1 records again, and the
next upgrade picks them up. The leader book moves the same way (a legacy record wins only with a later lead change, `since`,
at an epoch past this book's; one with a higher epoch but an older lead change only raises this book's
epoch past it, so the holder never flips back to an older lead). Only the host's own daemon (the prod dir,
where the service runs) reads `/tmp/open-walnut/offline-host`, and it also reads the home fallback's
`~/.cache/open-walnut/offline-host` (a v1 daemon journaled there while the server picked it); the home
fallback's daemon never reads `/tmp/open-walnut` (the server picks the fallback exactly when that dir is
another user's or a symlink); an isolated daemon, service mode included, reads only its own `DAEMON_DIR`.
A legacy dir is read only when lstat shows it, and the daemon dir holding it, as real dirs of this uid
that are not world writable, and each file in it as a regular file of this uid; anything else is logged
and left as it is. A v1 file whose Walnut nothing names at boot waits until a configure or a write names
that Walnut, then goes in ahead of that write.
A v1 file is read, then (state readable) CLAIMED by rename (`<file>.migrating-<ms>-<hex>`) and read again,
appended here and renamed `.migrated` (under the v1 name); a migration that stops part way puts the claim
back with a hard link, never over a file written there since: a v1 daemon still running writes by tmp + rename, so a record it writes
after the claim makes a new `journal-<key>.json` that the next boot takes (its older records dedupe by v1
op id), never a file set aside unread. A claim a crash left is taken at the next boot. A read error
leaves the file (or the claim) as it is for the next boot (never "empty"). A state.json read error other than ENOENT is a refusal
(`journal_unwritable`), never a blank state that the next write saves over the file.

Old Mac gate: `leader.configure` gains `drains: ['task-fields','task-create','task-move','board','note',
'session','device-actor','device-revoke']`. The daemon writes a v2-only kind ONLY when the leader book's record for that
home lists it; otherwise `follower.op` answers `needs_leader {why:'mac_too_old'}` and the gateway keeps
today's v1 behaviour (`task_update`/`task_complete` as v1 `op` records). `offline.drain` gains `{kinds}`
from the Mac. The kinds filter runs BEFORE the `DRAIN_BATCH` slice (`src/providers/offline-host-core.ts:446`),
so 200 held-back records at the head cannot starve the rest. A record parked for a newer Mac is
retained, not lost, while an old daemon or Mac runs. The daemon's `pendingHandover`
(`src/providers/offline-host-core.ts:440-442`) counts only records the current leader's kinds can
drain, so a parked record never pins the gateway or the follower view away.

Ack: the v1 ack is a watermark (C8), so "never acked" needs an explicit ack. v2 (cap `journal-v2`):
`offline.ack {seqs:[...]}` names exactly the seqs the Mac applied or gave up on; the daemon keeps every
record not named. For a Mac that sends no `kinds` (old, or an LKG rollback): the daemon remembers the
exact seqs it returned per drain and hands out only the PREFIX before the first withheld record (head of
line), so an `upTo` ack can never cross a parked record, and drops only returned seqs `<= upTo`.

Limits: 1000 unacked records per home (unchanged `queue_full`), `WRITE_BUDGET` keyed by actor (session sid or
device id), coalesced saves exempt (above). Blob bytes: a per-home budget of 200 MB answering `queue_full
{why:'blobs'}`. Note bodies never ride inline in `offline.drain`: the Mac fetches `offline.blob {sha}`,
at most 2 MB per reply (chunked by offset), within the WS frame and read limits. `follower.status` adds
`journal:{records, drainable, bytes, blobBytes, oldestAt, lastDrainAt, lastAckSeq}` for the away line and
observability.

Mac drain v2 (`src/core/offline-handover.ts`): records in seq order; `applied-ops` ledger
(`WALNUT_HOME/cache/applied-ops.sqlite`, key `(hostKey, home, opId, rev)`, appliedAt, outcome, TTL 30
days) checked before each apply and written RIGHT AFTER it. There is no shared transaction: tasks.sqlite
runs WAL (`src/core/task-db.ts:141`), SQLite does not commit atomically across attached WAL databases,
and replays go through `executeOp` over HTTP (`src/core/offline-handover.ts:320-322`). Safety comes from
per-kind idempotence, so a crash between apply and ledger is harmless:

| Kind | Idempotent because |
|---|---|
| task-fields | a field whose Mac value already equals `value` is a no-op (section 7) |
| task-create | the task stores `created_by_op`; an existing id with the same `created_by_op` is a no-op |
| task-move | an anchor placement already in place is a no-op; last move wins |
| board | posts by writer-minted `postId`; `board_set`/`board_edit` by version base (equal value = no-op) |
| note | `bytes == ours` is a no-op (section 6) |
| session | `createSessionRecord` on an existing sid is a no-op |
| v1 kinds | unchanged; migrated ids `v1-<record hash>` (the Mac's ledger keys them by host too) |

Failure policy: the batch STOPS at the first record that throws; the Mac acks only the seqs before it and
keeps the rest for the next attempt, retried on the same connection with backoff 5 s, 30 s, 2 min (the
`pushHostSlice` rerun on `pendingHandover`, `src/providers/daemon-connection.ts:1149`, no longer burns
retries in milliseconds). A `RefusedWrite` (the Mac's own answer, the one an online call would get) is
acked at once into the conflict log and letter; a thrown error is retried. After the third failure the
record is given up into the conflict log ("could not apply: <reason>, the change is attached"), and
every later record that names the same task is given up with it and listed, never skipped as "task
gone" (`src/core/offline-handover.ts:299-303`). Unknown kind: never acked (possible now, see Ack).

Times: a replayed field write stamps `field_at[f]` = the record's SHIFTED `at`, never the drain's wall
clock; a replayed note write records the shifted `at` in a per-note side table
(`WALNUT_HOME/cache/note-write-times.json`, path and noteId to time), never the file mtime. So the result
of two host journals and a companion queue drained in any order is the same (property tests).

Actor check: a record whose device actor (stable device id, section 1) is no longer paired on the Mac is
dropped into the conflict log and letter, never replayed.

Conflict log: every conflict (kind, id, both values in full, base, times) is written to
`WALNUT_HOME/offline-conflicts/` (durable, not tmp) BEFORE its record is acked: a small header
`<drainId>.json` (drain id, host, the letter mark) and the entries appended one fdatasynced line each to
`<drainId>.ndjson`, so N conflicts cost O(N) bytes, never a whole-file rewrite per record. The letter
is built from that log, idempotently keyed by drain id, sent when the drain ends (also when it threw),
and resent by the next drain when not marked sent; the 16 KB cap applies to the letter body only,
which links to the full entry.

Clock: `offline.drain` replies `{now}`; the Mac shifts record times by `macNow - daemonNow - rtt/2`.

## 6. Conflicts: notes

Avoid first:

1. Mac answers: one writer, the Mac. The replica forwards every note write; the existing 409 paths
   apply (`src/web/routes/notes-v2.ts:582-651`, `src/web/routes/api-v1.ts:4060-4090`).
2. Mac away: one writer on the host, the daemon's offline host. Phone saves (through the replica) and
   session `note_write`/`note_edit` (through the gateway) both call `offlineHost.notePut`, which checks
   `expectedHash` against the overlay (pending ours, else the copy body) and answers 409
   `{serverHash, serverContent}` like the v1 route. Two phones editing one note while away therefore
   merge in the editor (WP11 gives `useNoteContent` the Files panel's 409 merge, `web/src/hooks/useLiveEdit.ts:748`).
   The editor autosaves on a ~500 ms debounce (`web/src/hooks/useNoteContent.ts:573-598`); coalesced saves
   are exempt from `WRITE_BUDGET` (30 per 60 s, `src/providers/offline-host-core.ts:284-285,549-558`), so
   typing is never throttled.
3. Only a note with a base on the host is writable away: in the copy, <= 1 MB (`src/core/host-replica.ts:36`),
   not excluded, kind kept. Attachments, moves, renames, folder ops, notes over 1 MB, kinds turned off:
   `503 needs_leader {why}` with the reason shown in the editor.
4. Base pinned: the first away edit of a path stores the copy body as `baseBlob` (content addressed,
   `sha256` of the bytes). `replica.sync` treats a key with a pending (or awaiting copy) `note` record
   as held: neither replaced nor removed, answered in `held`; the Mac side clears its manifest memo on
   `held > 0` and reruns after 35 s, and clears it again after an ack that removed note records
   (section 4). The Mac drains before it pushes the notes manifest
   (`src/providers/daemon-connection.ts:1096-1184` order: drain, slice, configure, host server, host
   replica), so the held path is a backstop.
5. Coalesce: by append with the first base (section 5 Coalescing and its mode table); a frozen record is
   never superseded. Unreferenced blobs are removed at ack.

Drain on the Mac, per `note` record, under `withUserFileLock(path)` (`src/utils/user-file-lock.ts:50`),
skipped when `applied-ops` has the opId and rev. The path is resolved FIRST: the record's `noteId`
(frontmatter `id`) is looked up in the notes index to its current path, falling back to the record path,
so a note renamed or moved on the Mac merges at its new path instead of reading as deleted:

| Mac now | Rule | Result | Letter |
|---|---|---|---|
| bytes == ours | already applied | nothing | no |
| hash == baseHash | fast-forward | write ours, keep the Mac's `id:` line, emit `NOTES_UPDATED` | no |
| changed, base present | `merge3(base, mac, ours)` | clean: write the merge | no |
| changed, conflicting hunks | per hunk, the NEWER side by time wins in the note (Mac side = the note's time in the per-note side table when a replay wrote it last, else its last write time from file-history or mtime; host side = record `at` shifted by the clock offset); the complete other version (every conflicting hunk taken from the other side) is written as a conflict copy | note merged, copy beside it | yes |
| merge over budget (diff gave up or the worker hit its deadline) | whole note is one conflict region | newer side in the note, the other as a conflict copy | yes |
| missing at both noteId and path, base present (Mac deleted) | edit is not lost | ours written as a conflict copy, the path stays deleted | yes |
| exists, record mode create, differs | never diff3 against an empty base (`web/src/utils/three-way-merge.ts:17-18`) | Mac's kept, ours as a conflict copy | yes |
| missing, mode create | create | write ours | no |
| mode delete, hash == baseHash | delete through the notes delete route's code | deleted | no |
| mode delete, Mac edited since base | edit beats delete for documents | Mac's kept | yes |

Conflict copy: same folder, `<stem> (conflict <host label> <YYYY-MM-DD HHmm>).md`, ` 2`, ` 3` on a
name clash, its `id:` line removed so `withNoteId` mints a new id (`src/core/parse-frontmatter.ts:121-133`)
and no two notes share an id. Both sides are also written in full to the durable conflict log (section
5) before the record is acked; file-history (`src/core/file-history.ts:169`) is a convenience only (it
lives in tmp, is pruned by count and swallows errors, `src/core/file-history.ts:1-30,160-175`).
Nothing is ever lost: the note holds one side of every conflicting hunk, the copy holds the other, the
conflict log holds both. Actor check (section 5) runs before a note record is applied.

Merge library: `web/src/utils/three-way-merge.ts` moves to `src/lib/three-way-merge.ts` behind the
`@open-walnut/three-way-merge` alias (web/tsconfig, vite, the three vitest configs). Changes: the 40 ms
wall clock (`web/src/utils/three-way-merge.ts:223`) becomes a step budget (inline word merge only for
lines <= 2,000 chars and a diff of <= 50,000 edit steps; beyond it the line is a line-level conflict),
so the result depends on the input only; the result lists conflict regions `{baseRange, ours, theirs}`;
the frontmatter `id:` line always takes the Mac's value; CRLF and the final newline kept; comments in
English (`:20`, `:154` are Chinese today). The whole-document `diffLines` (`web/src/utils/three-way-merge.ts:215-219`)
is unbounded today: it gets `maxEditLength` (diff 9.0.0 supports it) of 50,000; when the diff gives up the
whole note is one conflict region (row above), so the result is still deterministic. On the Mac the drain
runs note merges in a worker thread with a 2 s deadline; a timeout is the same over-budget row. The Mac's
event loop never runs a note diff (rule in CLAUDE.md, `tests/core/event-loop-blocking-ratchet.test.ts`).

## 7. Conflicts: tasks, boards, requests

Every queued task write records, per field it changes, `{base, value}` where `base` is the value the
replica showed (copy plus overlay) when the person or session made the write. Queueable fields are the
task-outbox whitelist (`src/core/task-outbox.ts:68-110`) plus `phase`, `parent_task_id`, `pinned`,
`focus_tier`. All or nothing: a write that carries ANY other field answers `needs_leader {fields:[...]}`
naming the offending fields, and nothing of it is journaled (pinned by a test).

Session writes go through the daemon gateway, which knows only the slice: `OfflineSliceTask` holds id,
title, phase, project, group_id, parent_task_id, description, updated_at, session_id
(`src/providers/offline-host-core.ts:43-53`) and the overlay maps only title, description, phase, note,
summary (`:495-510`). WP8 extends the slice task with every queueable field plus `field_at`. A field
with no base on the writer's side is recorded as `base:'unknown'`; the drain applies such a field only
when `field_at(Mac) < shifted at`, and never runs `merge3` without a base.

Drain: resolve every field of a record first, then apply ONE patch per record (applying fields one at
a time passes invalid states that validation refuses, e.g. a folder of another project,
`src/core/task-manager.ts:2705-2707`). `(project, group_id)` is ONE compound field for the rule below;
if the resolved pair is invalid, the Mac's pair is kept and the other is in the letter. Per field:

| Mac value | Rule |
|---|---|
| == value | nothing (idempotent) |
| == base | take the replica's value |
| base unknown | the replica's value only when `field_at(Mac) < shifted at`, else the Mac's; listed only when the Mac's value is kept (an away write that wins over an older Mac value is the ordinary case of a copy that lacked the field, and is no conflict) |
| else, text field (description, note, summary) | `merge3(base, mac, value)` (worker thread with a 2 s deadline, made before the task lock and reused in it while the Mac's text is unchanged; over the deadline is the over-budget row of section 6: one conflict over the whole text, the newer side kept, so the outcome depends on the times and not on the machine's speed); clean applies; a conflict takes the newer side and the other side goes to the conflict log in full (the letter body capped 16 KB, linking to the entry) |
| else, scalar | newer by time wins: replica `at` (shifted) vs the Mac's per-field time `task.field_at[f]` (new, written by every task update from WP9 on, and by a replay with the record's shifted `at`; falls back to `updated_at`); both values listed in the letter |

- Delete wins: a task deleted on the Mac drops every queued write for it; listed in the letter when a
  write carried a value. A replica cannot delete (`needs_leader`).
- Complete and reopen are the `phase` field (above). A complete replayed on a task the Mac reopened later
  loses by time and is listed.
- Parent links: validated on apply (exists, no cycle, depth for a session actor, `src/core/sessions/subtask-limits.ts`);
  a refused link is dropped and listed.
- Create: the writer mints the task id with 8 random bytes after the timestamp (today's `generateId` has
  16 random bits, `src/utils/format.ts:6-10`) and the record's opId. The Mac applies through `addTask`
  with a new explicit-id option, never `addTasksBulk` (it skips the validation chain and the project
  registry row, e.g. `Ask <agent>`, and throws on a duplicate id, `src/core/task-manager.ts:8095-8106`).
  The task stores `created_by_op`. Replay: the ledger has the opId, or the id exists with the same
  `created_by_op` = no-op; the id exists with another `created_by_op` = a collision: mint a new id, remap
  later records of the batch, list it. Placement re-runs with the actor's rules (device = human
  defaults, session = `caller-placement.ts`); a parent gone = top level, listed.
- Ordering: `task-move` records carry an anchor, applied after field writes in seq order; a missing anchor
  appends to the tier's end; last move wins; never in the letter.
- Actor rights: a device actor replays with paired-device rights (`x-walnut-origin remote-http`,
  `src/web/v1-forward/target.ts:1-44`), no caller sid, so session-only brakes (title brake, placement)
  do not apply to a phone write; a session actor replays as today (`src/core/offline-handover.ts:322`).
  A device actor no longer paired on the Mac (unpaired before sleep while the host's device copy lagged)
  is dropped and lettered (section 5 Actor check). Revocation while away: the replica accepts a device
  revoke (applied at once to its device copy, journaled as a `device-revoke` record, always safe to
  apply on drain).
- Companion queues (C3) replay with their original time as `field_at`, the same rule as a journal replay,
  so a field edited through the companion and through the host journal ends the same in either drain
  order (R6b). WP13 gives companion task-queue records the same `{base, value, at}` fields.
- Boards: posts carry a writer-minted `postId` (idempotent); `board_set`/`board_edit` carry the board
  `version` base: equal applies, else html three-way merge, a conflict keeps the Mac's html and puts
  the other into the conflict log and the letter.
- Requests: status only moves forward; a settle the Mac already has is a no-op.

The letter: at most ONE inbox letter per drain of one host, sent only when the drain has a real conflict
(a hunk or field both sides changed differently, a delete that beat an edit, a refused or failed write).
Clean merges, fast-forwards and replays send nothing (inbox rule, CLAUDE.md "The inbox is for what needs
the user"). The letter lists each item with a link (note, conflict copy, task) and what was kept.

## 8. Ask Walnut and sessions while the Mac is away

- A new ask while away runs on the replica's host. The replica handles the launch route
  (`POST /api/sessions/quick-start` and the phone launch, `src/core/sessions/mobile-launch.ts:126`) as
  `away: host-write`: it mints the task id and the session id, journals a `task-create` (the task under
  `Ask <agent>` with `agent_id`, `src/core/sessions/ask-agent.ts:21-47`) and asks the daemon to start.
- `follower.start` (cap `replica-start-v1`, both twins): the daemon never runs an argv a follower wrote
  and does not grow a second argv builder beside `src/providers/claude-code-session.ts` (host-resume
  works only because it replays a Mac-built argv, `src/providers/host-resume-core.ts:9-20`). The Mac
  pushes a per-home SPAWN TEMPLATE in `leader.settings`: the argv and env `claude-code-session.ts` built
  itself for this host (provider variables, proxy, the `--settings` JSON with the compact SessionStart
  hook, `--debug`, `WALNUT_*` vars), with placeholders for sid, persona file, model, effort, mode, first
  message. The new shared core `src/providers/host-start-core.ts` substitutes only validated fields
  `{sid, taskId, cwd, model, effort, mode, personaFile, firstMessage}`; a parity test fills a template and
  compares it to what `claude-code-session.ts` builds for the same inputs. No template for that home:
  `needs_leader {why:'no_spawn_template'}`. Allowed modes: the host default and `plan`; `bypassPermissions` only when the leader
  book's settings for that home allow it (pushed by the Mac in `leader.settings`). Limits as
  `resumeForTrigger` (`src/providers/daemon-standalone.ts:2291-2350`): 2 starting, 20 busy, 10 per hour
  per home. The spawn journal stamps `origin.home = the follower's home` (the Mac's `WALNUT_LEADER_HOME`),
  so owner-home-v1 stops from the Mac work later (`src/core/sessions/stop-provenance.ts:1-25`).
- MCP mount: the daemon composes `{command: spec.command, args:[<appDir>/dist/cli.js, 'mcp']}` from the
  host-server spec the Mac configured (trusted), with env pointing the `walnut` CLI at the gateway
  socket, never `OPEN_WALNUT_API_URL` (`src/lib/self-api-root.ts:71-74`).
- Persona: from the `personas` copy (section 4), rendered on the Mac by `buildLaneProfile`
  (`src/core/sessions/personal-ai-lane.ts:386-424`) without the MCP mount. The daemon writes it to a
  0600 file in the home's run dir and the template passes it by path where the CLI has a file flag;
  where the template must pass it as the `--append-system-prompt` string
  (`src/providers/claude-code-session.ts:2381-2387`), it is capped at 120 KB (one argv string on Linux
  is limited to 128 KB). Missing persona copy: the ask answers `needs_leader {why:'persona_not_copied'}`.
- A host session that blocks on a permission prompt while the Mac is away pushes nothing to the phone
  (section 2 stated limit); the away line says so, and the prompt is answerable in the console.
- The daemon appends a `session` record and adds the session to the slice overlay so `ownerOf(sid)`,
  the gateway and `follower.send` know it (`src/providers/offline-host-core.ts:430-433`); the ask's
  `task-create` record is in `tasksWithOverlay` and `resolveTask` (section 5), so the session's own
  `walnut task_get`/`task_update` finds its task. The start is kept on disk (`pending-starts/`,
  `src/providers/host-start-core.ts`) from before the CLI is spawned until that record is kept, so a
  daemon that dies in between journals the record at its next boot, under the same op id.
- A person's message to a STOPPED host session while away resumes it through the `resumeForTrigger`
  path instead of `not_running` (`src/providers/offline-host-core.ts:1607`), journaled as `resume`.
- Mac adoption on drain: only a task that host's own journal created (its `created_by_op` is an op
  drained from that host) and only a mode the Mac's template for that host allows (else `default`);
  `session` record -> `createSessionRecord` (`src/core/session-tracker.ts:1342`)
  with host = this host's alias, then the existing rescue (`src/core/offline-handover.ts:360-370`)
  attaches. The ask keeps its host: `refreshWalnutSessionProfile` (`src/core/sessions/personal-ai-lane.ts:544-571`)
  computes the MCP mount per session host (host app path from the host-server install record) so a
  cold resume on the host never mounts the Mac's `execPath`. Title and organize run on the Mac after
  adoption (scheduled by the drain), never on the host (no credentials).
- An ask whose session runs on the Mac is listed from the `sessions` copy with "Your Mac is away"
  instead of its composer.

## 9. Work packages (IDs; the build order table below is the order of work)

Rules for every package: one implementer, one sitting; `npm run test:quick` and the package's own
files pass; every daemon change lands in BOTH twins with the core added to the version hash lists
(`src/providers/daemon-version-check.ts:158-172`, `scripts/build-daemon.sh:114`) and a parity test;
every new capability in `src/providers/daemon-capabilities.ts`; every new real-process test file in
`SLOW_TEST_FILES` (`tests/setup/slow-tests.ts:32-132`) or `tests/e2e`; every new log line structured
with full ids.

IDs are names, not the build order. Build order (first value early, Ask before notes):

| Step | Package | Note |
|---|---|---|
| 1 | WP1, WP2, WP3 | front, presence, tasks copy |
| 2 | WP4 (sessions kind first, then requests, boards, inbox) | |
| 3 | WP7 (minimal) | FIRST VALUE: board, tasks, host sessions read while the Mac sleeps |
| 4 | WP6, WP5 | follower reads, local routes, notes read; routines, config, prefs; each adds its rows to WP7's away specs |
| 5 | WP8, WP9, WP10 | journal v2, drain v2, writes away |
| 6 | WP12 | Ask while away (requirement 3) right after writes |
| 7 | WP11 | notes writable away |
| 8 | WP13, WP14 | companion path, release gate |

Rollout gate: `web --replica` shipped OFF by default, a per-host opt-in (`hosts.<alias>.server_program:
'replica'`), until the WP14 release gate passed; then the default flipped (D13, done 2026-10-18).

### WP1 Role, placement, boot policy; `walnut web --replica` boots safely
- Depends on: none.
- Files: `src/core/server-role.ts`, `src/core/boot-policy.ts` (new), `src/web/server.ts` (gates only),
  the self-gated modules of C9 (`src/core/boards/board-reminders.ts`, `src/core/task-wait-until.ts`,
  `src/core/session-title-reconciler.ts`, `src/core/notes-indexer.ts`, and every other `CLOUD_MODE`
  read the ratchet lists), `src/commands/index.ts` (`--replica`), `src/web/middleware/auth.ts` +
  `src/replica/auth.ts` (new: device-copy auth, leader walnutId on `/api/v1/instance`),
  `src/host-server/device-copy.ts` and `src/core/replication/device-replica.ts` (stable device id, a
  round on create and rotate), `src/replica/leader-door.ts` (new: the second listener),
  `src/host-server/env.ts` (env scrub), `src/constants.ts` (no change to `CLOUD_MODE`).
- Delivers: section 2 API; one `bootPolicy(job)` read at each listed gate; replica listens on
  127.0.0.1, marks its port as a tunnel port, refuses `localDaemon`, refuses to boot when
  `WALNUT_DAEMON_DIR` is unset or is `/tmp/open-walnut` or equals `WALNUT_HOST_DAEMON_DIR`, refuses when
  `OPEN_WALNUT_HOME` is `~/.open-walnut`; `boot policy` log line (with RSS and CPU after boot);
  `/api/config` facts gain `{role, placement}` beside `cloud`; the leader door listener (section 1); env
  scrub; copy stores read only except the follower apply connection; the self-gated timers OFF.
- Tests: `tests/core/server-role.test.ts` (extend: env matrix, reset); `tests/core/boot-policy.test.ts`
  (new: every row, leader and cloud rows equal the old `CLOUD_MODE` truth); `tests/core/boot-policy-ratchet.test.ts`
  (new: scans ALL of `src/` for a raw `CLOUD_MODE`; each read is replaced or listed with its host-replica
  decision; count may only fall); `tests/replica/leader-door.test.ts` (new: `POST /bridge/replica` with
  every kind, `devices` included, through the public port is 404 and changes no file; the same request
  through a primary stream is 200, except `tasks` and `registry`, which answer `400 not_a_replica` until
  WP3 gates the task copy store on `isFollower()` (C1; WP3 flips that assertion to 200); `/git/data` 404
  on the public port); `tests/replica/env-scrub.test.ts`
  (new: a child spawned by the replica has neither `WALNUT_FOLLOWER_TOKEN` nor `WALNUT_HOST_DAEMON_DIR`);
  `tests/replica/copy-readonly.test.ts` (new: a copy store write outside the apply connection throws);
  `tests/core/replication/device-replica.test.ts` (extend: stable id, old `listHash` unchanged, a round on
  create and rotate); `tests/e2e/replica-boot-e2e.test.ts` (new, real child via the bootServer pattern
  `tests/e2e/leader-takeover-live-e2e.test.ts:161-205`): boots with copies absent, `/api/config` 200 in
  under 15 s, no file created under the host daemon dir, no cron/plugin/daemon log lines, `/api/v1/instance`
  = leader id, an unpaired Bearer 401, a direct loopback request without token 401, a token from the device copy 200,
  none of the `started` lines of board reminders, wait-until, title reconciler or notes indexer, copy
  files and dirs at 0600 and 0700.
- Acceptance: leader and companion behaviour byte-identical in the existing suites (`npm run test:baseline`
  shows no new failure); the replica child never opens `/tmp/open-walnut` (asserted with a watcher on the dir);
  with copies of 6,500 tasks and 5,000 sessions loaded, idle RSS under 400 MB and idle CPU under 1%.

### WP2 Replica front: follower Link, presence, route table, dispatcher, forward
- Depends on: WP1.
- Files: `src/core/link/link.ts`, `src/core/link/follower-link.ts`, `src/replica/front.ts`,
  `src/replica/presence.ts`, `src/replica/route-table.ts`, `src/replica/dispatch.ts`,
  `src/replica/ws-rpc-table.ts` (all new; reuse `src/host-server/{daemon-link,proxy,route,expose,device-copy,alone-api}.ts`
  by import, not copy); `src/web/server.ts` (mount the front before `src/web/server.ts:1355`; start the
  link and the report loop before heavy init); `src/core/host-server/manager.ts` (choose args by cap and
  the per-host opt-in, send `fallback` in the spec); `src/providers/host-server-core.ts` (the daemon-side
  crash-loop fallback, `server.status` program field); `src/web/middleware/op-id.ts` (new, Mac side:
  `x-walnut-op-id` into the `applied-ops` ledger for direct writes, `409 stale_forward` past 20 s);
  `src/core/offline-merge/ledger.ts` (new here, keyed `(hostKey, home, opId, rev)`; WP9 extends it); `web/src/api/client.ts` (mint `x-walnut-op-id`
  per user action); daemon twins: `LEADER_QUIET_MS` env knob for follower writes and gateway routing when
  a follower is linked, `replica-host-v1` cap, follower view gains `quietMs`.
- Delivers: section 3; Mac awake = today's host-server forward plus `x-walnut-answered-via`; Mac away =
  routes run on the replica's stores (until WP3 only search and devices hold data) with
  `x-walnut-offline`; writes away `503 needs_leader`; 504 rule with the 15 s write budget; in-flight
  forwards 504 on a presence flip; WebSocket splice with the `4001`/`4002` close codes; `leader_answers`
  and `leader_unsure` handling; op id headers end to end; the report loop and expose supervisor run inside
  the replica; manager installs `web --replica` when the daemon has `replica-host-v1` AND the host opted
  in, else `host-server`; the DAEMON switches to the fallback after 3 exits in 10 min, for 1 h, shown in
  the host's status (works while the Mac sleeps).
  Test and safety knobs (new): `WALNUT_HOST_SERVER_ROOT` (default `~/.open-walnut-host`) and
  `WALNUT_HOST_SERVER_APP_DIR` (tests only: use a local tree instead of an SSH install).
- Tests: `tests/replica/route-table.test.ts`, `tests/replica/route-table-coverage.test.ts`,
  `tests/replica/dispatch.test.ts` (every branch of section 3 with a fake link: read retried, write after
  bytes = 504, write before open = away, upgrade spliced, companion stands in, write budget 15 s, flip
  answers in-flight 504, `follower.op` `leader_answers` forwarded once with the same op id, that forward
  failing before bytes = `503 leader_unsure`, lost `follower.op` answer retried with the same op id),
  `tests/replica/presence.test.ts` (one window, stale view, suspect, `drainablePending > 0` stays away,
  parked records never count); `tests/web/middleware/op-id.test.ts` (new: a direct write and a replay with
  the same op id apply once; forwarded-at older than 20 s = 409, nothing applied);
  `tests/core/host-server-manager.test.ts` (extend: args by cap and opt-in, `fallback` in the spec);
  `tests/providers/host-server-core.test.ts` (extend: 3 exits in 10 min switch to the fallback args with
  no configure, `server.status` reports it, back after 1 h or the next configure); `tests/providers/leader-twins.test.ts` (extend: `LEADER_QUIET_MS` in both
  twins and `src/replica/presence.ts`, follower allowlists compared as SETS like `tests/providers/daemon-standalone-vs-source-parity.test.ts:532`);
  `tests/integration/replica-front-twins.test.ts` (new, both twins as processes: the daemon supervises
  a real `web --replica` child via `server.configure` with a tsx boot spec; stand-in Mac on WS with
  `createStreamEndpoint` as `tests/helpers/host-alone-harness.ts:121-255`; forward of GET, POST, 4 MB
  body, WebSocket; Mac paused with `ws._socket.pause()` past `LEADER_QUIET_MS=6000`: GET answered away,
  POST 503 needs_leader, daemon refuses a follower write in the same window, the spliced WS closed with
  4001; a replica build that crashes only when away: the daemon falls back to `host-server` by itself
  while the stand-in Mac stays paused, and the front door answers).
- Acceptance: every `tests/e2e/host-server-e2e.test.ts` case passes with the replica program substituted
  (parametrized `describe.each(['host-server','replica'])`); first report within 5 s of spawn.

### WP3 Generic replication kind; tasks on every replica
- Depends on: WP1 (follower gate), WP2 (host targets reach the replica).
- Files: `src/core/replication/kind.ts`, `kind-leader.ts`, `kind-follower.ts`, `replica-status.ts` (new);
  `src/core/replication/task-replica.ts` and `task-replica-store.ts` (become the `tasks` kind:
  per-target state instead of the module-level `lastManifest`/`running`, `src/core/replication/task-replica.ts:75,146,192`;
  store gated on `isFollower()` instead of `CLOUD_MODE`, `src/core/replication/task-replica-store.ts:163,233,292,301`);
  `src/web/routes/bridge-replica.ts` (dispatch by registered kind, `404 unknown_kind`);
  `src/web/routes/replicas-status.ts` (new, `GET /api/replicas/status`, leader only);
  `web/src/components/settings/sections/ReplicaRemovalGroup.tsx` + `replica-removal-status.ts` (new: the
  Settings row a refusal three rounds in a row raises, in Remote Hosts for a host and in Cloud Companion for
  the companion; it names the leader's count and the follower's `local`/`removing`, and its two-click confirm
  posts the count and keys the user read; an error under it lasts while the refusal it was about holds; a
  follower too old for the confirm, which refused one anyway, gets a row saying to update it there first,
  with no button); `src/core/host-server/manager.ts` (the copy target and its `ready`, registered under one
  id while its server starts: its round runs when the server answers, and when another server process
  answers, by the daemon's pid, its memo and rests are forgotten so the round sends a real step).
  A confirm whose step was lost goes again within seconds, backing off up to a minute, and lives
  `CONFIRM_TTL_MS` (10 minutes, two sweeps).
- Delivers: section 4 protocol (with `schemaVersion`, `409 schema_newer`, the `confirm:true` mass-removal
  path, file modes); tasks and registry reach host replicas; held rows on a host come from the journal
  overlay (stub that holds nothing until WP10); the companion keeps its held sources.
- Tests: `tests/core/replication/kind.test.ts` (new: first round, changed row alone, removal, order across
  batches, held row survives, half rule at the floor, 3 refused rounds then `confirm:true` accepted,
  unknown kind rest, `schema_newer` rest, copy file hashes unchanged across a replica boot,
  per-target independence, restart asks nothing again); `tests/core/replication/kind-property.test.ts` (new, seeded mulberry32 as
  `tests/core/session-snapshot-sim.test.ts:64`: random row sets, edits, reorders, held sets, a transport
  that drops, duplicates, reorders and truncates puts; invariant after a quiet round: follower rows ==
  leader rows except held, order equal, no removal past the half rule; default 200 runs, `WALNUT_SIM_RUNS`);
  `tests/core/task-replica.test.ts` (unchanged cases must pass); `tests/core/task-replica-host-target.test.ts`
  (new: a `WALNUT_HOST_SERVER=1` follower store receives tasks through a host target, as
  `tests/core/search-replica-host-follower.test.ts:57`); `tests/web/routes/bridge-replica-cloud.test.ts` (extend);
  `tests/replica/leader-door.test.ts` (flip: `put`/`sync` of `tasks` and `registry` through a primary stream
  is 200, where WP1 pinned `400 not_a_replica`); `tests/core/replication/task-replica-scheduler.test.ts` (fake
  clock: debounce, held rerun, sweep, a target that joins or becomes reachable, the confirm round, a follower
  starts nothing, stop clears every timer); `tests/web/replica-removal-status.test.ts` and
  `tests/e2e/browser/replica-removal-settings.spec.ts` (the Settings row).
- Acceptance: 6,500 tasks (`src/core/host-slice.ts:96`) first round under 10 s and an unchanged round
  with no put; the Mac's event loop never blocked over 50 ms by a round (stall recorder clean).

### WP4 Copies: sessions, requests, boards, inbox
- Depends on: WP3.
- Files: `src/core/replication/kinds/{sessions,requests,boards,inbox}.ts` (new); follower stores write
  `sessions.sqlite` through `src/core/session-db.ts` (replica-owned file, never the Mac's), the same
  file layouts for the others; `src/core/session-tracker.ts` (refuse every process action when
  `role()=='replica'`: no signal, no reap, no stop by pid).
- Delivers: the replica's sessions list, requests, boards and inbox read from copies while away; session
  rows carry no pid or output file; inbox bodies by hash, copied only when the host's Settings choice
  allows (default: index only, bodies fetched on demand while the Mac answers); the per-host kinds
  choice in the host's Settings row (`src/core/host-server/manager.ts` passes it to the leader kinds).
  The sessions kind lands FIRST (build order step 2), so the minimal WP7 can follow it.
- Tests: one unit file per kind under `tests/core/replication/kinds/` (projection strips process fields,
  hash ignores volatile fields, digest skips an unchanged round, forward-only request status, letter
  never removed below the half rule); `tests/core/signal-call-ratchet.test.ts` (extend: no signal path
  reachable with `role()=='replica'`); `tests/core/replication/sessions-scale.test.ts` (5,000 rows, a turn
  ending changes one row: one put, manifest skipped by digest).
- Acceptance: a copied session row can never reach `process.kill` (ratchet); 5,000 session rows first
  round under 5 s.
- As built: the kinds go to HOST targets running the replica PROGRAM only (`kinds/copy-kind.ts`
  `keepsCopiesTarget`, the manager's view `program`); the plain host server, its daemon fallback and the
  companion get none, and the follower gate is the program too (`server-role.ts` `isHostReplicaProgram`,
  `kinds/gate.ts`), so WALNUT_HOST_SERVER=1 alone answers `404 unknown_kind`. A kind the host's choice
  turns off gets one `purge` step: the host drops that kind's store, leaves `cache/replica/<kind>.json`
  as `{v:1, off:true}` (read by `copyKindOff`, a letter body then answers `503 needs_leader
  {why:'kind_not_copied'}` while away), and the next round after it is turned on again is a full
  manifest. A choice change starts a round within the debounce. The companion keeps its session
  projection and answers these kinds `404 unknown_kind` as before (WP13 moves it). The process guard
  keys on placement host, not `role()=='replica'`: the companion is a replica too and, with cloud exec,
  stops its own sessions (`src/core/sessions/replica-process-guard.ts`, funnels in `owner-stop.ts`,
  `session-tracker.ts`, `utils/session-liveness.ts`, and the two pid probes in
  `providers/claude-code-session.ts`); off a host replica every copy kind answers `404 unknown_kind`
  for any op and schema version (`kinds/index.ts` `hostReplicaOnly`). Digest kinds put only the changed rows when the
  target took the previous manifest and nothing was removed, and confirm by the follower's digest on the
  last put; an ordered kind's digest names its order. Inbox bodies are their own kind (`inbox-bodies`,
  keyed by file name, hashed by content), and a host that keeps no inbox keeps no bodies either. The
  choice lives in `hosts.<key>.server.copies`. The half rule starts at 200 session rows, 50 requests,
  20 boards and 50 letters. A board over `BOARD_COPY_MAX_BYTES` (2 MB: the store caps a board's html at
  1 MB, the rest is room for its threads and marks) is not copied, and the host reads it from the Mac
  while the Mac answers; a letter body over 4 MB is not copied either. A board or body file the Mac
  lists but cannot read (it does not open or parse; only a file gone since the listing counts as
  deleted) rides in the sync's `keep` (`kind.ts` `keepOf`): the host neither asks for it nor removes
  it, and the manifest hash takes `keep` in, so a key leaving it runs the round again. A whole-file
  store the Mac fails to read (the request store, the letter index) throws instead of reading as
  empty (`utils/fs.ts` `readErrors: 'throw'`), so that kind skips the round. The host writes a letter
  body through a temp file and a rename, at 0600, as it writes every JSON copy file. The process
  guard's stale-record repair sits in `fixStaleRecords` itself, the one funnel its three callers share.

### WP5 Copies: routines, conversations, prefs and favorites, sanitized config
- Depends on: WP3.
- Files: `src/core/replication/kinds/{routines,conversations,prefs,config}.ts`,
  `src/core/replication/config-allowlist.ts` (new); `src/core/config-manager.ts` (`getConfig()` on a replica reads
  the config copy, writes refused); `src/web/routes/favorites.ts` (replica reads the prefs copy).
- Delivers: Routines page, Ask history list, favorites, ui prefs and settings views render from copies;
  config copy carries only allowlisted keys.
- Tests: unit per kind; `tests/core/replication/config-allowlist.test.ts` (new: every key of a full
  fixture config is either allowlisted or dropped; a planted secret-shaped value in an allowlisted key
  refuses the row; masked strings never written back, `src/core/config-redact.ts`); a ratchet that a new
  config key defaults to NOT copied.
- Acceptance: grep of the replica data dir after a round finds none of the fixture's secret values.
- As built: the four kinds go to host replica programs only, like the WP4 kinds, and each has its own
  per-host choice (`routines`, `conversations`, `prefs`, `config` in `hosts.<key>.server.copies`, on by
  default; no new Settings row). The followers live beside them (`kinds/routines-follower.ts`,
  `kinds/conversations-follower.ts`, `kinds/file-copy.ts` for the one-file copies of prefs and config,
  `kinds/state-io.ts`). Routines: `cron-jobs.json` and `cron-state.json` in the Mac's layout, the status
  projected to next run, last run, last status, last error, duration, error count and pause; the copied
  definition leaves out the engine's `updatedAtMs` clock and a trigger's status leaves out its next check,
  so a running mark or a real quiet check (`applyTriggerChecked`) moves no row; a routine with anything
  secret-shaped in it (a token in a check's shell line, a key in an executor setting, an error quoting a
  header) is left out on the Mac and refused on the host. The Routines page reads them through
  `routines-core.ts`, never through the engine, whose list recomputes and persists. Conversations: the
  chat-history index IS `conversations/<agent>/_index.json` (the legacy single file is migrated into it),
  copied per agent, a secret-shaped title shown as untitled; `GET /api/chat/history`, `/api/chat/stats`,
  `/api/chat/triage` and the phone's `GET /api/v1/conversations/:id/messages` and `/api/v1/chat/stats`
  (the bodies) are `needs-leader` rows while away. The routines and conversations watches hear the
  stores' one write point (`replication/store-writes.ts`: cron `persist()`, `writeIndex()`), since their
  writers tell only the browser sockets. A read that finds no copy of its kind (none yet, or the host
  turned it off) answers `needs_leader {why:'kind_not_copied'}`: the Routines list, the Ask list, GET
  favorites and ui-prefs, never an empty list; GET /api/config stays a 200 (it carries the page's role,
  placement and build, the replica's first answer at boot) and says `configCopied: false` over the defaults. The config copy is one row per
  allowlisted top-level key, each section spelled out field by field; `CONFIG_COPY_DROPPED` names every
  other key and `CONFIG_COPY_DROPPED_FIELDS` every other field of a copied section, with why, and the
  ratchet walks the sections' types in `src/core/types.ts`; the secret check runs on the Mac (the row is
  left out, one warning naming paths) and again on the host (the row is skipped). The copy holds every
  host's ssh target for the views, so `getDaemonConnection` on a host replica refuses every host but its
  own follower link (`needs_leader {why:'other_hosts_need_mac'}`, a link failure): a replica dials no host. On a host replica `getConfig()` and
  `readStoredConfig()` read the copy over the defaults, every config.yaml writer throws
  `NeedsLeaderError` (`replication/needs-leader.ts`, answered `503 needs_leader` by the web error
  handler), and the boot seed and migration are no-ops; routine, conversation-list, ui-prefs and
  favorites writes answer the same.

### WP6 Follower reads (owner scoped), `local` routes, notes read from the daemon copy
- Depends on: WP2.
- Files: daemon twins (`src/providers/daemon-standalone.ts`, `src/providers/daemon-source.ts`):
  owner check on `attach`, `status` (and drop `includeArgs` for followers), `list`, `markers.find` for
  follower sockets (today only `read-history`, `src/providers/daemon-standalone.ts:6870`); new follower
  commands `replica.list {kind}`, `replica.read {kind, key}`, `replica.readMany {kind, keys}` (<= 4 MB per
  answer) answered from `hostReplica` for `followerHome` only; cap `replica-reads-v1`;
  `src/providers/host-replica-core.ts` (read API, no change to sync yet); `src/replica/notes-source.ts`
  (new: `NotesSource` = disk vault on the leader, daemon copy on a replica away: tree from `replica.list`,
  body from `replica.read`, backlinks, links and tags from an index built with `readMany` and cached by the
  manifest hash); `src/web/routes/notes-v2.ts` and the v1 note routes (read through `NotesSource`);
  `src/replica/route-table.ts` (`local` rows: host session history, transcript, file reads, git diff
  reads, health; the terminal and every file write or git commit stay `leader`); `src/replica/self-host.ts`
  (new: the session host alias equal to this host resolves to the follower Link); daemon twins: the
  owner-scoped follower reads `fs.ls`, `fs.read`, `fs.stat`, `fs.readRange`, `fs.resolvePath`, `fs.grep`,
  `git.diff`, `git.fileShow`, `git.fileLog`, `changes.compute`, `changes.file` (scoped to that home's
  session cwds) on the follower allowlist.
- Delivers: host session history and files answered on the host even while the Mac answers (no hairpin);
  notes tree, content, search (search copy), backlinks and tags while away; another Walnut's sessions on
  the same host never readable through a follower.
- Tests: `tests/providers/follower-owner-scope-twins.test.ts` (new, both twins as processes: two homes on
  one daemon; follower of home A gets `not_found` for B's attach, status, list rows, markers, replica reads);
  `tests/providers/leader-twins.test.ts` (extend allowlist sets); `tests/replica/notes-source.test.ts`
  (new: tree, body, Unicode paths and bodies with `\u` escapes, 1 MB note, cache invalidated by a new
  manifest); `tests/integration/replica-local-routes-twins.test.ts` (new: a host session's history read
  through the replica while the Mac answers makes zero streams to the Mac, counted at the relay; a local
  history read plus the Mac's WS stream renders the same timeline as both from the Mac; an `fs.read`
  outside the home's session cwds is `not_found`; the terminal away answers `needs_leader`).
- Acceptance: owner-scope test red on today's daemon (proves the hole) and green after; notes tree of a
  13 MB, 3,000-note vault answers in under 1 s warm.

### WP7 The console away: presence line, offline marks, `needs_leader`, alone page retires
- Depends on: WP2, WP3, the sessions kind of WP4 (minimal slice). WP5 and WP6 add their away rows
  (notes, Routines, inbox, config) to the specs below when they land.
- Files: `web/src/hooks/useLeaderPresence.ts`, `web/src/components/layout/AwayLine.tsx` (new);
  `web/src/api/client.ts` (read `x-walnut-offline` on every response, map `needs_leader`,
  `leader_unsure` and `primary_timeout` to plain messages); the WS client (reconnect without reload on
  close codes 4001 and 4002); session panel and composer (a Mac session away: "Your Mac is away" instead
  of controls); `src/web/ws/handler.ts` (send `replica:presence` on connect and on change);
  `src/host-server/` (the alone page stays only for the `host-server` program).
- Delivers: the quiet line "Your Mac is away. This is the copy on <host> from 2 min ago." (plus "Prompts
  on <host> are not pushed to your phone" while away); writes show "Needs your Mac" with the reason;
  nothing reloads when the Mac returns, the line goes away and live data resumes.
- Tests: `tests/web/leader-presence.test.ts` (hook unit); browser fixture `tests/e2e/browser/replica-server.ts`
  + `replica.config.ts` (new, port 3472, chromium and webkit projects, 390x844 and 1280x800, control port
  3473: `sleep`, `wake`, `drain`, `stores`); the fixture boots the Mac as a NON-ephemeral child with its
  own HOME and data dir (the bootServer pattern of `tests/e2e/leader-takeover-live-e2e.test.ts`, REFUSING
  guard kept), because an ephemeral Mac pushes nothing to a remote host (C10); a host daemon twin child
  linked over a direct test transport, the replica child supervised by that daemon, and the fake
  `ssh -R` tunnel of `tests/e2e/browser/browser-access-tunnel.spec.ts`; `tests/e2e/browser/replica-away-read.spec.ts`:
  pair through the tunnel with real clicks, board and a task open with the Mac awake, `sleep` (SIGSTOP)
  with the `/ws` spliced at that moment, the away line appears within `LEADER_QUIET_MS + 5 s` with no user
  action, board, task, notes tree, a note, search, Routines, inbox, a host session's history all render
  (rows added as WP5 and WP6 land), a Mac session shows "Your Mac is away", an edit shows "Needs your Mac",
  `wake` (SIGCONT), the line goes away with no reload (a `window` marker survives) and live session
  events resume through the spliced socket; `tests/e2e/browser/replica-smoke.spec.ts` (new, ONE chromium
  spec in the MAIN Playwright config so CI covers the path: away read and one away write, the write row
  added by WP10); `tests/e2e/replica-api-v1-away.test.ts` (new: the iOS app's `/api/v1` calls against the
  replica away: status, instance, me, devices/self, task list, edit, create, session list, send, history);
  the iOS stub server flows (`ios-native/tests/ui`) run once against a replica fixture.
- Acceptance: both engines green at both viewports; screenshots under `/tmp/replica-plan/` reviewed by
  the main agent; worst full load of `/` through the tunnel with the Mac asleep under 3 s over 5 loads.

### WP8 Journal v2 in the daemon
- Depends on: WP2 (quiet window), independent of WP3 to WP7.
- Files: `src/providers/offline-host-core.ts` (v2 records under the new kind names, NDJSON append under
  the per-home lock, compaction, opId, rev and actor, opId dedupe index, field bases on `task-fields`,
  `task-create`, `task-move` including `base:'unknown'`, coalescing by append with frozen records,
  `journal_unwritable`, kinds gating before the batch slice, explicit `seqs` ack and the head-of-line
  rule for old Macs, `drainable` count, `tasksWithOverlay`/`resolveTask` over the new kinds and creates,
  the slice task extended with every queueable field plus `field_at`, journal load by scanning
  `journal-*` with `nextSeq` from disk, `configure()` adopting an on-disk journal, blob byte budget,
  `handleFollower` gate split); `src/providers/leader-core.ts` (record keeps `drains` from
  `leader.configure`; `primaryAgeMs` kept for takeover, new `heardSinceBoot` for the follower view,
  D14); daemon twins (ONE journal root per host for journals, slices and the leader book:
  `~/.open-walnut/tmp` for the host's own daemon in service and plain mode alike, `DAEMON_DIR` for an
  isolated one, so no v2 record ever moves between dirs; v1 migration at every boot from
  `DAEMON_DIR/offline-host` and, for the host's own daemon, `/tmp/open-walnut/offline-host`; `WALNUT_JOURNAL_DIR`
  test knob, `follower.op`, `follower.pending`, `follower.status` journal stats, `offline.drain {kinds}`
  reply `{now}`, `offline.ack {seqs}`, `offline.blob {sha, offset}`, non-owner of `daemon.pid` refuses
  writes, `followerWriteTarget` accepts follower writes while `pendingHandover`); cap `journal-v2`.
- Delivers: section 5 daemon side. v1 behaviour unchanged for a Mac without `drains`.
- Tests: `tests/providers/offline-host-journal-v2.test.ts` (new: append, reload, compaction keeps the
  unacked tail, coalesce keeps the first base, a coalesced save is not charged against `WRITE_BUDGET`
  (120 saves in 60 s on one note fold into one record, no throttle), opId unique, a duplicate opId append
  answers the first result, kinds gating refuses `task-create` for an old Mac, EACCES and ENOSPC on
  append answer `journal_unwritable` and keep earlier records, blob budget answers `queue_full`, a v1
  file migrated, the note mode table, a journal with no slice beside it still loads and drains,
  `nextSeq` from disk when `state.json` is stale); `tests/providers/offline-host-v1-parity.test.ts` (new:
  every v2 kind fed to the `1fe1fd194` `applyRecord` is never acked, and an old-Mac drain over a mixed
  v1 and v2 journal never loses a v2 record); `tests/providers/offline-host-journal-property.test.ts`
  (new, seeded: random interleavings of append, drain, ack (explicit seqs and old-Mac `upTo`), coalesce,
  crash at any line boundary or mid-line, daemon restart, compaction, parked kinds at the head of the
  journal; pinned case: drain, then coalesce into the drained record, then ack, then drain again returns
  the later save; a retried record survives two acks of later seqs; invariants: no acked record returns,
  no unacked record lost, seq unique per journal (strictly increasing within one writer), a frozen record
  never changes, a torn last line is dropped and reported, fold by opId keeps the highest rev, replay
  order == append order; 500 runs default, 20,000 in the large run); `tests/providers/leader-core.test.ts`
  (extend: `drains` persisted; after boot `backupClaim` within `takeoverMs` is still refused while
  follower writes are allowed once `heardSinceBoot`); `tests/integration/journal-v2-twins.test.ts` (new,
  both twins: append through `follower.op` and through the gateway socket interleaved, SIGKILL the daemon
  between appends, restart, drain returns every record once in order; reboot simulated with
  `WALNUT_JOURNAL_DIR` kept and a new daemon dir; OVERLAP: two daemons on one dir appending interleaved,
  unique seqs and no loss, the non-owner of `daemon.pid` refuses; DOWNGRADE then upgrade: new, old, new
  daemon keeps every record; an upgrade boot with a v1 journal plus records then drain returns all of
  them (R13c); 500 records queued, SIGCONT, a phone write mid-drain lands once and in order);
  `tests/providers/offline-journal-migration.test.ts` (new; faults injected through `deps.fs`, never chmod,
  which passes as root: the journal root evaluated from both twins' own text over a mode matrix, and
  neither rule reads the service state dir; service-mode and plain-mode daemons on the same HOME write and
  drain the same journal file (both twins); a service daemon followed by a plain daemon, and the reverse,
  loses and reorders nothing; EACCES on a v1 file at boot leaves it un-renamed and the next clean boot
  migrates it once; a v1 file met while state.json cannot be read is kept for the next boot; a v2 file in a
  legacy dir is never read nor renamed; a fold into a migrated v1 record, drain, ack, then the same v1 file
  restored from a copy (or rewritten with one more record) brings back nothing acked; EMFILE on state.json
  at load then `persist()` keeps rows and `importedAcked` on disk; an unreadable or non-v2 state.json
  refuses every write with `journal_unwritable` and is never replaced; the leader book's legacy import
  leaves a record it cannot read for the next boot).
- Acceptance: property suite green at 20,000 runs locally; an append costs under 2 ms p99 at 1,000
  records (measured in the twins test).

### WP9 Mac drain v2: ledger, per-field merge, letter
- Depends on: WP8.
- Files: `src/core/offline-handover.ts` (v2 apply for the new kind names, `recordScope` for them, stop
  at the first throwing record, explicit `seqs` ack, backoff 5 s / 30 s / 2 min on the same connection,
  refused vs thrown, give-up of later records on the same task, unknown kinds never acked, clock offset,
  replay stamps the shifted `at`, actor check against the Mac's paired devices, blobs fetched by
  `offline.blob`); `src/core/offline-merge/{task-fields,letter,conflict-log}.ts` (new) and
  `src/core/offline-merge/ledger.ts` (from WP2, extended: written right after each apply; the op-id
  middleware also RESERVES `(hostKey, home, opId)` in memory when a request arrives, so a duplicate that
  arrives while the first is still in its handler waits for the first answer and returns it, never
  applying again: the web client retries a timed-out write under the same id about 300 ms after it
  aborts, usually while the Mac is still running the first attempt, WP2 review round 3); conflict log under
  `WALNUT_HOME/offline-conflicts/` written before ack, letter resent at boot when not marked sent);
  `src/core/task-manager.ts` (`field_at` per field on every update and on replays, `addTask` with an
  explicit id, `created_by_op`); `src/providers/daemon-connection.ts` (`leader.configure` sends `drains`,
  drain passes `kinds`, acks by `seqs`).
- Delivers: section 7 on the Mac (one patch per record, `(project, group_id)` as one compound field,
  `base:'unknown'` rule); one letter per host drain with conflicts only, built from the conflict log.
- Tests: `tests/core/offline-merge/task-fields.test.ts` (new: every row of the section 7 table, text
  merge, delete wins, parent refused, create replay no-op, create id collision re-minted and later
  records remapped, `Ask <agent>` registry row created, move with a missing anchor, an invalid
  `(project, group_id)` pair keeps the Mac's pair, a write with one non-queueable field is refused whole,
  `base:'unknown'`, an unpaired device actor dropped and lettered);
  `tests/core/offline-merge/task-fields-property.test.ts` (new, seeded: a random base task, random Mac
  edits and random replica edits with random times and skew, drained 1 to 3 times with random crashes
  between apply and ledger, two host journals plus a companion queue drained in random order;
  invariants: a field only one side changed equals that side; for SCALARS a field both changed equals
  the newer; for TEXT a clean merge contains every line either side added and a conflicting merge equals
  the newer side with the other side in the conflict log; the result is independent of drain order; a
  second drain changes nothing; the letter lists exactly the both-changed fields with different values;
  1,000 runs default, 50,000 in the large run); `tests/core/offline-merge/ledger.test.ts` (cross-host
  collision: host A and host B both with `v1-…-1` style ids from different journals apply both; same
  opId with a new rev applies; two requests with the same op id, the second sent while the first is
  still in its handler, apply once and both get the first answer); `tests/core/offline-merge/conflict-log.test.ts` (new: written before ack,
  crash after ack and before the letter resends the letter at boot, once); `tests/integration/offline-handover.test.ts`
  (extend: v2 records, old v1 records still apply, the batch stops at a throwing record and later
  records wait, a record retried with backoff 3 times then given up with later records on the same task,
  a `RefusedWrite` lettered at once, unknown kind left unacked); `tests/core/offline-handover-letter.test.ts`
  (new: no letter on clean drains, one letter for many conflicts, links resolve).
- Acceptance: all existing `tests/core/offline-handover-*.test.ts` pass; property suite green at 50,000.

### WP10 Writes while away: tasks, boards, sends, prompts, held rows, "Syncs when your Mac is back"
- Depends on: WP7, WP8, WP9.
- Files: `src/replica/write-port.ts` (new: turns a route's write into `follower.op` with the actor =
  the paired device (stable id), the request's op id (minted when the client sent none), field bases
  from copy plus overlay (`'unknown'` when the copy lacks the field), minted ids, all-or-nothing field
  check, retry with the same op id); task routes (`src/web/routes/tasks.ts`, `src/web/routes/task-v1.ts`,
  focus and ordering routes), board routes, session send and permission routes (to
  `follower.send`/`follower.permission`), the device revoke route (`device-revoke` record plus the
  replica's device copy); WS RPC writes through the same port with their op id; `src/replica/overlay.ts`
  (new: pending records from `follower.pending` applied over copies; rows held in every kind while
  pending AND as `awaiting copy` after ack, until a manifest with `asOf` later than the ack stored the
  key or 10 min pass); route table `away` rows; `web/src/components/tasks/*` and board UI (the mark).
- Delivers: away edit, create, complete, reopen, move, board post and edit, send to a host session,
  answer a host prompt, revoke a device; each shows "Syncs when your Mac is back" until the Mac's row
  returns in a copy.
- Tests: `tests/replica/write-port.test.ts` (bases recorded, `'unknown'` base, ids minted, op id kept,
  actor set, budget per device, one non-queueable field refuses the whole write, a lost answer retried
  with the same op id appends once); `tests/replica/overlay.test.ts` (hold after ack until a later
  manifest, release after 10 min); `tests/e2e/replica-cluster-e2e.test.ts` (new, section 10 harness,
  both twins): the scenario matrix rows W1 to W14 and R4b; `tests/e2e/browser/replica-away-write.spec.ts`
  (both engines): edit a task, create a task, complete one, post on a Board while asleep; marks visible;
  `wake`; marks go, the Mac's stores (read through the control port) hold every change once; the write
  row of `replica-smoke.spec.ts`; `tests/e2e/replica-old-mac-e2e.test.ts` (new: an old leader booted from
  `git archive 1fe1fd194`, rows R10 and R25).
- Acceptance: every write made away is on the Mac exactly once after wake, checked against the stores on
  disk; nothing is applied on the replica's stores directly (asserted: copy files change only by puts).
- Decision (device revoke away): a device may revoke only ITSELF while the Mac is away (its own sign-out);
  removing another device, or a pairing on the companion (`?target=`), answers `needs_leader
  {why:'device_changes_need_mac'}`. Section 7 says the replica "accepts a device revoke" without naming
  who may make it; the Mac's own rule (`src/core/device-actor.ts` `deviceChangeDecision`) lets a paired
  device remove only itself, unless it holds the owner's rights (it owns the machine credentials), and
  the replica's device copy carries phones and browsers only, never machine credentials
  (`src/host-server/device-copy.ts`), so self is the one case the replica can check. The narrow reading
  also keeps the drain safe: `applyDeviceRevoke` replays with this Mac's own rights, which a record
  naming another device would borrow. The daemon (`offline-host-core.ts` `device_revoke`) and the drain
  (`apply-v2.ts`) refuse a record for another device too. Tests name the rule: "a device revoke while
  away is that device's own sign-out only" in `tests/replica/write-port.test.ts`,
  `tests/replica/away-writes.test.ts` and `tests/e2e/replica-cluster-e2e.test.ts`.
- Decision (op ids of away writes): an away write does not run the Mac's op-id middleware. Its op id
  (the client's, or minted by the dispatcher) is what the daemon dedupes while the record is pending,
  and the Mac's applied-ops ledger dedupes the drained record by the same id; the middleware's ledger on
  the replica would answer a retry after the ack from the replica's own file (W11 must journal it
  again) and record a journaled write as applied. The two middleware answers that still matter are
  kept: a retry under the same id gets the first record's answer (the daemon's), and the same id for
  another kind of change is `409 op_id_reused` (`write-port.ts`). The request logger runs before the
  away routes, so every away write is logged with its op id (`server.ts`).

### WP11 Notes writable while away, merged on return
- Depends on: WP6, WP9, WP10.
- Files: `src/lib/three-way-merge.ts` (moved from `web/src/utils/three-way-merge.ts`, section 6 changes)
  + alias in `web/tsconfig.json`, `web/vite.config.ts`, `vitest.config.ts`, `vitest.focus.config.ts`,
  `vitest.quick.config.ts`; in the moved library, `maxEditLength` on `diffLines` (over budget = one
  conflict region);
  `src/core/offline-merge/note-merge-worker.ts` (new: merges in a worker thread, 2 s deadline);
  `src/providers/offline-host-core.ts` (`notePut`, blobs, coalescing by append with the mode table,
  ack frees blobs); `src/providers/host-replica-core.ts` (held and awaiting-copy keys in `sync`,
  half-removal guard with floor 200 and `confirm:true`); `src/core/host-replica.ts` (Mac side: delete the
  manifest memo on `held > 0` and rerun after 35 s, clear it after an ack that removed note records);
  daemon twins (wire `notePut` into `follower.op` and the gateway's `note_write`/`note_edit`, cap
  `note-journal-v1`); `src/core/offline-merge/notes.ts` (new: the section 6 table, `noteId` resolved to
  the current path first, per-note replay time side table `cache/note-write-times.json`);
  `web/src/hooks/useNoteContent.ts` (409 three-way merge like `useLiveEdit`, `needs_leader` banner).
- Delivers: section 6 end to end.
- Tests: `tests/lib/three-way-merge.test.ts` (moved `tests/web/three-way-merge.test.ts` plus: determinism
  under a busy CPU, conflict regions, CRLF, final newline, `id:` line, Unicode with `\u` escapes, 1 MB
  inputs); `tests/lib/three-way-merge-property.test.ts` (new, seeded line and word edits on random
  documents: one-sided edits merge to that side, disjoint edits merge cleanly and contain both, merge(base,
  x, x) == x, merge(base, base, y) == y, result never drops a line both sides kept; 2,000 runs default,
  100,000 large; a diff over `maxEditLength` gives the same one-region result on every run);
  `tests/core/offline-merge/notes.test.ts` (every table row, conflict copy name clash, no duplicate ids,
  Mac renamed and host edited = clean merge at the new path with no letter, a 1 MB conflicting pair
  drained with the Mac's loop under 50 ms per tick by the stall recorder, a worker timeout = the
  over-budget row); `tests/core/offline-merge/notes-property.test.ts` (random Mac and host edit
  sequences with coalescing, the mode transition table, duplicate drains, two hosts plus a companion
  drained in random order: after drain the union of note plus conflict copies contains every line
  either side added, and the result is independent of drain order; 1,000 default, 20,000 large);
  `tests/providers/host-replica-core.test.ts` (extend: held key, awaiting-copy key, half guard,
  `confirm:true`); `tests/core/host-replica.test.ts` (extend: drain merges a note while its record is
  held, after the ack the host copy body equals the Mac body within one rerun);
  `tests/integration/note-journal-twins.test.ts` (both twins: phone save and session `note_edit` on one
  note while away serialize with 409, coalesce, 120 saves in 60 s with no throttle, drain);
  `tests/e2e/browser/replica-away-notes.spec.ts` (both engines: edit a note asleep, edit the same note on
  the Mac through its API with a disjoint change and a conflicting change, wake: merged text, one conflict
  copy, one letter).
- Acceptance: no note line lost in 100,000 property runs; letter count equals real-conflict drains.

### WP12 Ask Walnut on the host while the Mac is away
- Depends on: WP5 (personas kind lives with config copies), WP8, WP9, WP10.
- Files: `src/core/replication/kinds/personas.ts` (new); `src/providers/host-start-core.ts` (new,
  inlined in both twins); daemon twins (`follower.start`, `session` record, slice overlay, resume of a
  stopped host session on a person's message, cap `replica-start-v1`); `src/replica/ask-launch.ts` (new);
  `src/core/offline-handover.ts` (`session` adoption, title and organize scheduled);
  `src/core/sessions/personal-ai-lane.ts` and `src/core/sessions/profiles.ts` (MCP mount per session host);
  `src/providers/claude-code-session.ts` and `src/providers/daemon-connection.ts` (build the per-home
  spawn template and push it in `leader.settings`).
- Delivers: section 8.
- Tests: `tests/providers/host-start-core.test.ts` (template filled from fields only, mode allowlist,
  persona file at 0600, persona cap on the argv path, MCP mount from the spec, no template =
  `needs_leader`); `tests/providers/spawn-template-parity.test.ts` (new: a filled template equals what
  `claude-code-session.ts` builds for the same inputs: argv, env, the `--settings` JSON with the compact
  hook, `--debug`); `tests/integration/replica-ask-twins.test.ts` (both twins, mock CLI
  `tests/providers/mock-claude.mjs`: start, the session's `walnut task_get` and `task_update` on its own
  new task while away (found through `tasksWithOverlay`), journaled, limits, a stop from the Mac after
  adoption honoured by owner-home-v1); `tests/e2e/replica-ask-e2e.test.ts` (cluster:
  asleep, new ask from the phone API, answer streams through the replica, wake, the Mac lists the ask under
  `Ask Walnut` on that host, a cold resume uses the host's MCP path); `tests/e2e/browser/replica-away-ask.spec.ts`
  (both engines: open Ask Walnut asleep, send, see the mock answer, wake, the ask is still there).
- Acceptance: no argv field from the replica reaches `spawn` unchecked (unit plus a twins test that sends
  an injection string in every field).

### WP13 The companion on the same path
- Depends on: WP2, WP3, WP9 (merge order and `field_at` rule).
- Files: `src/core/link/{daemon-connection-link,bridge-link}.ts` (new); daemon twins (bridge
  `stream.open` to `primary` only, cap `bridge-stream-v1`); `src/web/v1-forward/proxy.ts` (forward on a
  stream when the Mac's daemon has the cap, else `server.http` as today); `src/web/server.ts` companion
  task writes forwarded while the Mac answers (one writer), still local plus queued when away;
  `src/core/task-queue.ts` and its replay on the Mac (records carry `{base, value, at}` per field and
  the op id; replay stamps `field_at` with the original time and runs the section 7 merge);
  `src/core/boot-policy.ts` cloud rows.
- Delivers: no size caps on the companion forward; one forward implementation; companion queues kept (C3)
  and merged by the same rules as a host journal, so two offline writers end the same in either order.
- Tests: `tests/web/routes/v1-forward-proxy.test.ts` (extend: stream path, fallback); `tests/e2e/companion-forward-live-e2e.test.ts`
  (extend: 4 MB body through the stream; old daemon via cap drop uses `server.http`. No WebSocket crosses the
  stream: the Mac serves none under /api/v1, `ws/handler.ts` takes `/ws` only, and the phone's `/ws` and
  `/api/v1/events` stay on the companion, so the Mac's door refuses an upgrade like any call it would not run,
  pinned in `tests/web/routes/v1-forward-proxy.test.ts`);
  `tests/providers/leader-twins.test.ts` (bridge set gains only `stream.open`); `tests/core/task-queue-merge.test.ts`
  (new: a companion queue record and a host journal record on the same field, both drain orders give
  the same task; an old queue file without bases still replays as today). The host-first order is the
  one to pin: since WP9 a drained host record moves `updated_at` to the drain's clock, so today's
  whole-row gate in `task-outbox.ts` `applyTaskOp` (`snapshot.updated_at <= existing.updated_at` is
  stale) drops a phone edit queued away for the same task; the per-field merge replaces that gate.
- Acceptance: the companion live e2e and `tests/e2e/leader-takeover-live-e2e.test.ts` pass unchanged.

### WP14 Release gate: large runs, adversarial review, dev box check, observability
- Depends on: all.
- Files: `scripts/walnut-logs.sh` (`replica --host <alias>` subcommand: presence changes, forwards by
  outcome, journal appends and drains, letters; host-side lines fetched through a new trusted daemon
  command `logs.tail {home, sources:['replica','journal'], n}`, cap `replica-logs-v1`, because those
  lines live on the host); daemon twins (`logs.tail`; the supervisor caps the replica's stdout log by
  size while running, today it rotates only at start, `src/providers/host-server-core.ts` `openLog`);
  `src/logging/logger.ts` (a replica prunes its log dir daily, today only at init, `src/logging/logger.ts:160-168`);
  `tests/setup/large-run.sh` (new); `tests/e2e/replica-scale-e2e.test.ts` (new: row R17, plus the drain
  of 1 MB conflicting notes with a stall recorder assertion on the Mac); `tests/setup/wp-ref-lint.mjs` (new: every `WPn` mention in the plan
  and the checklist file names the package that owns the item); `src/providers/daemon-connection.ts`
  (`WALNUT_EPHEMERAL_REPLICA_HOST`, the narrow opt-in of section 13, refused for a prod daemon dir, with
  a unit test); docs (`docs/plan/walnut-replica-servers.md`
  corrections C1 to C10, `ARCHITECTURE.md`, the module header of `src/host-server/main.ts`); the default
  flip of D13 (opt-in to default) as the LAST commit, after the gate passes.
- Delivers: section 11 large run and section 12 verification evidence.
- Acceptance: section 12 checklist complete with evidence paths; `wp-ref-lint` clean.

## 10. Test strategy: the scenario matrix

Harness `tests/helpers/replica-cluster.ts` (new, WP7, grown by WP10 to WP12): a Mac server child (the
bootServer and serverEnv pattern, `tests/e2e/leader-takeover-live-e2e.test.ts:126-205`, REFUSING guard
kept), the Mac's own daemon, the host daemon child (twin chosen per `describe.each(['source','standalone'])`,
spawn as `tests/e2e/leader-takeover-live-e2e.test.ts:208-237`, `BUN_INSTALL` passed through), the host
replica spawned BY that daemon's supervisor from a `server.configure` the Mac sends (the manager given an
installed-app override `WALNUT_HOST_SERVER_APP_DIR=<tree>` and a tsx boot command, so no SSH install),
an optional companion (`tests/helpers/cloud-box-replica.ts`), a mock CLI on every PATH, and helpers:
`sleepMac()` = SIGSTOP of the Mac server pid and its daemon pid, `wakeMac()` = SIGCONT, `restart(name)`,
`stores()` (read-only sqlite and JSON readers of the Mac, the replica and the journal), `events(name, msg)`
(structured log assertions per process). `afterAll` and a process `exit` handler SIGCONT before SIGTERM.
Windows: `WALNUT_LEADER_QUIET_MS=6000`, `WALNUT_TRUSTED_CLIENT_BEAT_MS=1000`, `WALNUT_LEADER_TAKEOVER_MS=12000`
(beat x 3 < quiet < takeover with seconds of margin, because load averages above 100 are recorded on this
machine; the 2026 flake lesson at `tests/e2e/leader-takeover-live-e2e.test.ts:43-49`). The harness asserts
that ordering itself at start and refuses to run otherwise.
Old builds: a capability-drop knob `WALNUT_BRIDGE_HIDE_CAPS` in both twins (refused when the daemon dir
is the prod dir) and an old leader booted from `git archive 1fe1fd194` into a temp dir with
`node_modules` symlinked.

| ID | Scenario | Expect | Covered by |
|---|---|---|---|
| R1 | Mac awake, phone on the host QR | full console forwarded; host session history `local` (zero Mac streams) | `replica-cluster-e2e` R1, `replica-local-routes-twins`, `replica-away-read.spec` |
| R2 | Mac asleep (SIGSTOP, sockets open), no companion | away line; every read from copies | `replica-cluster-e2e` R2, `replica-away-read.spec` |
| R3 | Mac stuck (frames flow, HTTP never answers: test hook `WALNUT_TEST_HOOKS=1` holds forward targets) | a read has no budget and is answered away only when its stream fails; a write that says its wait (`x-walnut-wait-ms`) is 504 `sent: true` at that wait (at least 15 s), a write that says none waits for the client's own deadline or for the Mac to be really away (the quiet window); a failed stream is a suspect mark that steers new requests and cuts nothing in flight; an away write meanwhile gets `follower.op` `leader_answers` (the daemon still hears frames), is forwarded once, fails, and answers `503 leader_unsure` | `replica-cluster-e2e` R3, `tests/replica/dispatch.test.ts` |
| R4 | Mac wakes on the same sockets | drain, line gone after the drain, no reload | `replica-cluster-e2e` R4, all browser away specs |
| R4b | wake, drain, SIGSTOP again before the copy round | the board still shows the edit with its mark (awaiting copy) | `replica-cluster-e2e` R4b |
| R5 | Mac wakes after reconnect (Mac server SIGKILL plus restart) | drain on connect, held rows released | `replica-cluster-e2e` R5 |
| R6 | companion stands in | host forwards phone traffic to the companion; session task writes on the host are still journaled when the gateway target is null (`src/providers/daemon-standalone.ts:3442,3458`) | `replica-cluster-e2e` R6 (with companion) |
| R6b | the same field edited through the companion and through the host journal | either drain order gives the same task | `replica-cluster-e2e` R6b, `task-queue-merge`, `task-fields-property` |
| R7 | companion present, stand-in not allowed | host answers away itself; a write on each side to the same task ends the same in either drain order | `replica-cluster-e2e` R7 |
| R8 | old daemon (no `replica-host-v1`) | manager installs `host-server`; alone page | `tests/core/host-server-manager.test.ts`, `replica-cluster-e2e` R8 (cap drop) |
| R9 | daemon without `journal-v2`/`replica-ops-v1` | away writes `needs_leader {why:'daemon_needs_upgrade'}` | `replica-cluster-e2e` R9 |
| R10 | old Mac with a new daemon | `host-server` program; v1 journal only; no v2 kind written | `tests/e2e/replica-old-mac-e2e.test.ts` (old leader from the archive) |
| R11 | Mac upgrades the replica | runKey change restarts with a new token, front door gap < 15 s, copies kept | `tests/integration/replica-front-twins.test.ts` |
| R12 | write in flight at sleep | 504 `sent: true` to the client at once when the quiet window flips presence. Dedupe by op id holds for a client that sends one (the web: `withWriteRetry` keeps the id, and does not retry a 504 `sent: true` by itself; a retry the user makes is journaled with a new id): after wake the forwarded copy is refused `409 stale_forward` (older than 20 s) or deduped by the ledger, so an id is applied exactly once, and a create retried under the same id gives ONE task. The iOS app sends no id, so each phone retry gets a new replica-minted one: its only guards are `409 stale_forward` on the late forwarded copy and the 504 message ("check it before you try again") | `replica-cluster-e2e` W1 (a write started after the SIGSTOP is 504 `sent: false`: the stream to the stopped Mac is never accepted; its retry under the same id lands once), `tests/replica/dispatch.test.ts` (504 `sent: true` at the flip), `op-id.test.ts` (the late copy: `stale_forward`, the ledger's first answer) |
| R13 | restarts away: replica, host daemon, host reboot (new daemon dir, `WALNUT_JOURNAL_DIR` kept) | replica answers at boot from disk; journal kept; follower re-hello; after a daemon restart the follower view counts the Mac as unheard until a frame, while the companion's takeover still waits `takeoverMs`; R13c starts the daemon ONLY through the service path (the systemd user unit, a test unit dir), and an upgrade boot with a v1 journal plus records drains all of them | `replica-cluster-e2e` R13a to R13c, `journal-v2-twins` |
| R14 | duplicate drains (Mac killed after apply, before ack) | applied once | `tests/integration/offline-handover.test.ts` (a Board post and a create whose ack was lost, drained again on the next connect, land once by the ledger), `replica-cluster-e2e` W11 (an op id journaled again after its ack), ledger and property tests |
| R15 | concurrent edits on both sides (task fields, notes) | section 6 and 7 rules, one letter | `task-fields-property`, `notes-property`, `replica-away-notes.spec` |
| R16 | Unicode and large notes (1 MB, `\u` escapes, CRLF) | byte exact round trip, merge correct | `three-way-merge` tests, `notes-source`, `note-journal-twins` |
| R17 | thousands: 6,500 tasks, 5,000 sessions, 3,000 notes | first copy round < 10 s, away board load < 3 s | `task-replica-host-target`, `sessions-scale`, `replica-scale-e2e` |
| R18 | another Walnut on the host | no reads across homes, no copy, no journal | `follower-owner-scope-twins` |
| R19 | replica crash loop | back to `host-server` after 3 crashes in 10 min | `host-server-manager`, `replica-front-twins` |
| R20 | journal full / disk full | `queue_full` / `journal_unwritable` shown, nothing earlier lost | `offline-host-journal-v2`, `tests/replica/away-writes.test.ts` (the routes over a full journal and a full disk: 503, earlier records and rows kept, the same write taken once there is room, and the console's words for both), `tests/web/leader-presence.test.ts` (the words) |
| R21 | clock skew +/- 10 min | merge by shifted time | `task-fields-property` |
| R22 | phone write at the 30 to 45 s edge | one writer: daemon and replica use one window | `replica-front-twins`, `leader-twins` |
| R23 | new ask while away; message to a stopped host session | session on the host; resumed; adopted on wake | `replica-ask-e2e`, `replica-ask-twins`, `replica-away-ask.spec` |
| R24 | SIGCONT with 500 records queued, a phone write mid-drain | replica stays away until the drain ends; the write is journaled, lands once and in order; no mark vanishes and returns | `replica-cluster-e2e` R24, `journal-v2-twins` |
| R25 | old or rolled-back Mac drains a mixed v1 and v2 journal | v1 records apply; no v2 record is handed out, acked or lost; a newer Mac drains them later | `replica-old-mac-e2e`, `offline-host-v1-parity` |
| R26 | `/bridge/replica` and `/git/data` through the public tunnel port | 404, no file changes | `tests/replica/leader-door.test.ts`, adversarial (1) |
| R27 | phone paired from a QR, Mac SIGSTOPped within 1 s | the phone works away (device round fired on create) | `replica-cluster-e2e` R27 |
| R28 | a device revokes itself away; device unpaired on the Mac just before sleep | the revoke applies on the replica at once (another device's needs the Mac: WP10 decision); that device's queued records refused and lettered on drain | `replica-cluster-e2e` ("a device revoke while away is that device's own sign-out only"), `tests/replica/away-writes.test.ts`, `task-fields.test.ts` |
| R29 | the iOS app's `/api/v1` calls with the Mac asleep | every call answered from copies or `needs_leader`, none 5xx | `replica-api-v1-away`, iOS stub flows once |
| R30 | daemon downgrade then upgrade while away writes happen | every v1 record written by the old daemon is migrated at the next boot | `journal-v2-twins` |
| R31 | two daemon processes on one journal root | unique seqs, no lost line; the non-owner refuses writes | `journal-v2-twins` |
| R32 | a replica build that crashes only when away | the daemon switches to `host-server` by itself, the front door answers | `replica-front-twins`, `host-server-core` |

Write rows W1 to W14 in `replica-cluster-e2e` (both twins): in-flight write (504), task edit, create,
complete, reopen, move, board post, send to a host session, prompt answer, note edit, duplicate drain,
a refused parent link lettered, W13 a write with one non-queueable field refused whole, W14 a failing
record that later succeeds on retry keeps the later records of the same task. Each ends with `stores()`
compared to the expected Mac rows.

## 11. Large local run

`tests/setup/large-run.sh` runs, one suite after another (check `scripts/pw-cleanup.sh status` and the load first; never in parallel with
another agent's load-generating probe), with `WALNUT_SIM_RUNS` raised and a fresh seed list:

| Suite | Default runs (quick tier) | Large run | Seeds |
|---|---|---|---|
| `kind-property` (replication transport faults) | 200 | 20,000 | printed on failure, replayed with `WALNUT_SIM_SEED` |
| `offline-host-journal-property` (append, drain, ack, crash, compaction) | 500 | 20,000 | same |
| `task-fields-property` (per-field merge, skew, duplicate drains) | 1,000 | 50,000 | same |
| `three-way-merge-property` | 2,000 | 100,000 | same |
| `notes-property` (coalesce, drain, conflict copies) | 1,000 | 20,000 | same |
| `replica-cluster-e2e` both twins | 1 pass | 10 passes back to back (flake hunt) | n/a |
| `replica-scale-e2e` (6,500 tasks, 5,000 sessions, 3,000 notes, 1 MB notes) | skipped in quick | 3 passes | fixed data generator, neutral names |

Rules: seeded mulberry32 only (pattern `tests/core/session-snapshot-sim.test.ts:1-23`), no `Math.random`,
no new dependency; every property file states its invariants in English at the top; a found failure
becomes a fixed-seed regression case in the same file. Generators include Unicode by `\u` escapes,
CRLF, empty files, a final line without a newline, duplicated lines, and moves of whole blocks.

## 12. Verification

Real processes, both twins: every `tests/integration/*-twins.test.ts` and `replica-cluster-e2e` is
`describe.each` over `source` (node) and `standalone` (bun); a missing bun FAILS the large run instead
of skipping (`tests/integration/host-replica-twins.test.ts:215` skips today), the quick tier may skip.

Browser: `tests/e2e/browser/replica.config.ts` runs chromium and webkit projects at 390x844 and
1280x800 through the fake tunnel; WebKit first (the Mac app is WebKit). Dedicated configs do not run
in CI (`.github/workflows/ci.yml:504`), so CI covers the path through ONE chromium spec in the main
config (`replica-smoke.spec.ts`, away read and one away write), and the full two-engine matrix is a local
gate the main agent runs and reviews: real clicks only, no `page.goto` after the first load,
screenshots at <= 1280 px under `/tmp/replica-plan/<spec>/`, each read once. The iOS app: the `/api/v1`
away contract test, and the existing iOS stub server flows (`ios-native/tests/ui`) run once against a
replica fixture.

Adversarial verification (after WP14 code freeze, a separate reviewer per area, opus): (1) security:
try to read another home's session through every follower command, send an argv injection through
`follower.start`, use a machine token on the replica's `/api`, reach the replica from a non-loopback
address, post every copy kind (devices first) to `/bridge/replica` through the public port, read the
follower token from a child the replica spawns, read a copy file as another local user (modes);
(2) data loss: kill each process at every step of a drain (scripted `kill -9` points), fill the disk,
corrupt one journal line, truncate a copy file, a Mac manifest that removes every row, two daemons on
one journal root, a daemon downgrade then upgrade, an old-Mac drain over a mixed journal, a coalesce
between drain and ack, a crash after ack and before the letter; (3) double apply: retry storms from the
phone during sleep and wake, a write forwarded into a frozen Mac then retried, two phones, a session and
a phone on the same task; (4) compatibility: every R8 to R11 and R25 row by hand on builds from the
archive.

Against the plan: a checklist file (kept by the implementer, not committed) maps each section 3 to 8
rule to the test that pins it; any rule without a test is a blocker. `tests/setup/wp-ref-lint.mjs` checks
that every `WPn` mention in the plan and the checklist matches the package that owns the item.

## 13. Rollout and compatibility

Capabilities (both twins, advertised in `src/providers/daemon-capabilities.ts`): `replica-host-v1`
(quiet window knob, the manager may run `web --replica`), `replica-reads-v1` (owner-scoped reads and
`replica.*` reads), `journal-v2`, `replica-ops-v1` (`follower.op`), `note-journal-v1`, `replica-start-v1`,
`bridge-stream-v1`, `replica-logs-v1`. Each feature checks its own cap; a missing cap degrades that
feature only. While an old daemon runs (before auto-deploy, or after a downgrade), v2-only writes answer
`needs_leader` and any v2 records already on disk wait untouched; the next new daemon boot migrates the
v1 records the old one wrote (section 5), so nothing is lost either way.

| Fleet | Behaviour |
|---|---|
| new Mac, old daemon | the Mac auto-deploys the daemon on version mismatch (CLAUDE.md "Auto-deploy"); until then `host-server` program and v1 journal |
| new Mac, new daemon | `host-server` unless the host opted in (until the WP14 gate flips the default); then `web --replica`; features by cap |
| old Mac, new daemon | old Mac installs `host-server` (spec per home, unchanged); daemon writes v1 kinds only (no `drains`); owner scoping applies to old host servers too (they use only own-home commands) |
| old companion | untouched; host routes to it as today; v1 forward |
| replica older than the daemon | cannot happen for long: the Mac installs its own build; a runKey change restarts it |

How the Mac upgrades the host: unchanged package path (`src/core/host-server/package.ts:56-94`): the
Mac's dist id changes, install to `~/.open-walnut-host/app/<id>`, `server.configure` with the new args,
the supervisor restarts with a new token; the replica's copies in `~/.open-walnut-host/data` carry over.
Rollback: a Mac setting `hosts.<alias>.server_program: 'host-server'` forces the old program; it takes
effect only while the Mac answers. While the Mac sleeps the daemon's own fallback (section 1) is the
rollback: 3 exits in 10 min switch to `host-server` with no Mac involved. A host reboot needs the managed
systemd user service with linger to bring the daemon back (section 1 reboot row).

Safe check on the real dev box (never the user's prod data, never port 3456, never the prod daemon):
1. On the dev box, start an ISOLATED daemon from the candidate build: its own `WALNUT_DAEMON_DIR`
   (`/tmp/walnut-replica-check/run`), its own `WALNUT_JOURNAL_DIR`, its own port; the prod daemon and its
   dirs are never touched.
2. `npm run dev:ephemeral` on the Mac with `WALNUT_EPHEMERAL_REMOTE_HOSTS=1` and a host entry that points
   at the isolated daemon's dir. An ephemeral server is `isReadOnlyRemote` for every non-local host (C10),
   so WP14 adds a narrow opt-in `WALNUT_EPHEMERAL_REPLICA_HOST=<alias>` that lifts `isReadOnlyRemote`
   ONLY for that host and ONLY when its daemon dir is not the prod dir (refused otherwise,
   with a test). A host entry names no daemon dir (the connection probes for one), so the isolated
   dir is given beside the alias: `WALNUT_EPHEMERAL_REPLICA_DIR=<abs dir>`, refused when it is
   `/tmp/open-walnut`, `~/.cache/open-walnut`, `~/.open-walnut` or inside one; the lifted host
   uses that dir and its own streams dir (`src/providers/ephemeral-replica-host.ts`). The lift is also
   refused for the companion's box (it comes through its tunnel, not ssh) and unless step 3's
   `WALNUT_HOST_SERVER_ROOT` is set to a root other than `~/.open-walnut-host`; a lifted host never
   probes or updates the box's service daemon.
3. The ephemeral Walnut has its own home, so the copies, journal, leader book and host server live under a
   different home key (`src/providers/host-server-core.ts:130`); its host-server manager installs to
   `WALNUT_HOST_SERVER_ROOT=~/.open-walnut-host-eph` (WP2 knob). Verify with `follower.status` that the
   home differs.
4. Pair a test device through the dev box tunnel, run the R2, R4, W2, W3, R23 and R13c flows with the
   ephemeral server SIGSTOPped (R13c: reboot not possible on a shared box, so restart the isolated daemon
   through a test systemd user unit), then SIGCONT and check its stores; delete the test tasks and
   notes on the ephemeral server; stop it and the isolated daemon, remove their dirs.

Observability: structured lines `replica presence`, `replica forward {outcome, ms, bytes}`,
`replica away answer {route, cls}`, `journal append {kind, opId, actor}`, `journal drain {records,
applied, merged, conflicts, failed}`, `replica copy round {kind, target, need, held, removed, ms}`,
`offline merge conflict {kind, id}`, `journal lock {home, owner}`, `drain record failed {seq, kind,
attempt, nextRetryMs}`, `forward stale refused {opId, ageMs}`; `GET /api/replicas/status` and the host row
in Settings show copy ages, journal size, drainable and parked counts and oldest record, the program
running and any fallback. Host-side lines (presence, forwards, appends) live on the host; the Mac reads
them through `logs.tail` (`walnut-logs.sh replica --host <alias>`). The replica prunes its log dir daily
and the supervisor caps its stdout log by size, so a long-running replica never grows logs without bound.

## 14. Decisions taken (no user input needed)

D1 Notes writable away when the host holds the base (C2). D2 Conflict copy plus newer-wins-per-hunk.
D3 One letter per host drain, conflicts only. D4 Companion queues kept (C3). D5 One quiet window,
default 30 s (C4). D6 Journal v2 append-only in the host's one journal root (C7). D7 Replica never writes its copies
directly; overlay from the daemon. D8 The daemon builds a host ask's argv from fields. D9 No task delete
while away. D10 The replica refuses to start with a shared daemon dir or the user's data dir. D11
`/ws` is spliced to the Mac while it answers; the replica's own WS serves away mode only, so live
session streams stay forwarded while the Mac answers and only HTTP history/transcript/file reads are
`local`; the replica closes spliced sockets with 4001 on a flip to away and its own with 4002 on return,
and the terminal is `leader` (needs the Mac).
D12 Search on a host replica while away is keyword only: the installer omits optional deps on purpose
(`src/core/host-server/install.ts:68`) and the model needs 2.3 to 2.6 GB (`docs/plan/walnut-control-plane.md:431-434`).
D13 `web --replica` is a per-host opt-in until the WP14 release gate passes, then the default on any host
whose daemon has `replica-host-v1`; the per-host setting `server_program: 'host-server'` is the rollback
while the Mac answers, the daemon's fallback while it sleeps.
D14 After a daemon restart the FOLLOWER VIEW counts the Mac as unheard until its first frame
(`heardSinceBoot`); the companion's takeover keeps the boot grace `primaryAgeMs`
(`src/providers/leader-core.ts:113-115,159-164,179-180`), so a daemon restart or auto-deploy never lets
the companion claim the lead at once.
D15 Conflict copies are ordinary notes beside the original, so they sync, search and back up like any note.
D16 Ack names exact seqs (v2); old Macs get only the prefix before the first parked record.
D17 Coalescing appends; a record handed to a drain is frozen until acked; the ledger key includes `rev`.
D18 v2 records use new kind names; `op` stays v1 only.
D19 A drain stops at the first throwing record and retries with backoff; conflicts go to a durable log
before ack; the letter is built from it.
D20 A replay stamps the record's shifted time, never the drain's clock, so drain order never decides.
D21 One op id per user action from the client to the ledger; the Mac refuses forwarded writes older than 20 s.
D22 The replica stays away while the current leader has drainable records; the daemon takes follower
writes during a drain.
D23 Letter push is off on a replica; the away line states the limit.
D24 A host ask spawns from a Mac-built template; the daemon fills validated fields only.
D25 Inbox bodies are not copied by default; a per-host choice turns copying on.

## 14b. Rejected or changed from the review

- "Clear the handed-out watermark on reconnect" (coalescing P0): CHANGED. Frozen records stay frozen until
  acked, persisted across restarts. Clearing on reconnect would let a redrain after a crash see new
  content under a ledger entry for the old, which is the loss the rule exists to prevent.
- "Route the host replica's away writes to the companion when it is reachable" (R7): REJECTED. A
  companion the user did not allow to stand in must not become a writer. The other half of that fix is
  taken: companion queue records carry `{base, value, at}` and merge by the same rules (WP13).
- "Persona passed by path, not argv": TAKEN WITH A LIMIT. The template passes a file path only where the
  CLI has a file flag for the appended prompt; otherwise the string stays on argv under the 120 KB cap.
  No new CLI flag is assumed (the CLI's source is never modified).
- "Blob budget 256 MB" vs "200 MB": 200 MB taken (the smaller of the two).
- "Apply creates through addTasksBulk" was replaced, not kept: `addTask` with an explicit id.

## 15. Needs the user

Q1 The live dev box check (section 13) runs an isolated daemon on the dev box and needs
`WALNUT_EPHEMERAL_REMOTE_HOSTS=1` plus the new `WALNUT_EPHEMERAL_REPLICA_HOST` opt-in on the Mac. The prod
daemon is not touched, but the check uses the dev box's CPU and a tunnel. The user picks a time when no
important session runs on that dev box. Everything before it (WP1 to WP14 tests) runs with no access to
the dev box.
Q2 Requirement 1 after a host REBOOT with the Mac asleep needs the daemon as a systemd user service with
linger. Enabling linger on a managed or shared dev box may need the user's (or an admin's) consent. The
plan offers it and defaults it on for hosts with the replica; the user confirms that default.
Q3 Copying inbox bodies to a dev box: the plan defaults to index only (bodies on demand while the Mac
answers), so away the phone sees letter titles but not bodies. The user may prefer bodies copied by
default on a host they own.
