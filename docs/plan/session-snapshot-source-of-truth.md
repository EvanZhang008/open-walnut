# Session Snapshot — Daemon as Source of Truth (C1+C2 contract)

This is the **binding contract** for the C1+C2 implementation. Every agent working on
this feature reads this file first. Design rationale lives in the planning history;
this file is the *what*, precisely.

Background: session `process_status` today is written by ~25 scattered sites reacting
to a lossy event stream (5 hops, tunnel drops, replays). Any lost event = permanent
status mismatch. The fix: the daemon (which reads the CLI stream file losslessly on
the same machine) folds the stream into an authoritative per-session snapshot; walnut
reduces all its writers to ONE pure projection, `applySnapshot()`, fed by push (on
change) + pull (30s + reconnect). Lost events degrade from "permanent lie" to
"self-heals within one pull cycle".

## 1. SessionSnapshot (wire + TS)

Defined in `src/providers/daemon-fold.ts` (new file, zero imports — see §3):

```ts
export interface SessionSnapshot {
  v: number                    // byte offset in the stream file AFTER the last folded line
                               // (same formula as L1 jsonl events: lineStart + byteLength + 1).
                               // Monotonic per session. THE idempotency coordinate.
  cliState: 'running' | 'idle' | 'waiting' | 'dead'
  turnActive: boolean          // a turn anchor was seen and the turn has not settled
  pendingPermission: { requestId: string; toolName?: string; sinceTs?: number } | null
  gatingBgCount: number        // non-backgrounded, non-terminal background tasks (#870 semantics)
  teamActive: boolean
  lastResult: { isError: boolean; numTurns?: number; endOffset: number } | null
  pid: number | null
  exitCode: number | null      // normalized via isTurnCompleteExit when dead
}
```

`cliState` derivation (in `assembleSnapshot`, §4):
- process dead (reaped / orphan-poll miss) → `'dead'`
- `pendingCtrl` present → `'waiting'`
- `turnActive` → `'running'`
- else → `'idle'`

## 2. foldLine reducer — pure, incremental

```ts
export interface FoldState {
  v: number                     // offset after last folded line
  turnActive: boolean
  sawAnchor: boolean            // ever saw a turn anchor since (re)build
  lastResult: SessionSnapshot['lastResult']
  trailingIdle: boolean         // session_state_changed{idle} seen after lastResult
  bgTasks: Record<string, { terminal: boolean; isBackgrounded: boolean }>
  teamActive: boolean
}
export function initialFoldState(baseV?: number): FoldState
export function foldLine(state: FoldState, rawLine: string, lineEndV: number): FoldState
```

Rules — port EXACTLY the semantics of `foldSessionTail` (`src/core/session-reconcile.ts:203-415`,
55 green tests define the behavior). Batch fold ≡ `lines.reduce(foldLine, initialFoldState())`.

- **Turn anchor** (→ `turnActive=true`, clear `lastResult`/`trailingIdle`): a *real* user
  line per `isRealUserLine` semantics (accepts `walnut-injected` markers; rejects
  tool_result echoes and lines with `parent_tool_use_id`), or a `system/init` line.
  DELIBERATE divergence from foldSessionTail (whose anchor is ONLY a real user line):
  init and `state:running` also count as turn-start evidence here, because a legacy
  marker-less FIFO send leaves no user line, and the daemon folds from byte 0 (every
  stream starts with init) rather than backward-scanning a tail window. C2's shadow
  divergence counter must expect this class, not flag it.
- **A REAL USER anchor ALSO RESETS the bg/team universe** — `bgTasks = {}`,
  `seenInLevel = {}`, `teamActive = false` (adjudicated 2026-08-06). Rationale:
  foldSessionTail's window STARTS at the last real user line, so pre-anchor bg/team
  state is invisible to it by design. Retaining it forward made the daemon strictly
  MORE gated than the reference, and one shape could never heal: a bg task with no
  terminal bookend that was ALSO never listed by a `background_tasks_changed`
  payload. The level-reconcile universe guard refuses to absent-mark a never-listed
  id (deliberately — a sync subagent is legitimately absent from every level
  payload), so that task wedged `turnActive=true` for EVERY FUTURE TURN of the
  session (executed repro: an orphan `task_started` in turn 3 kept turn 4's clean
  result+idle from settling). Safety: a genuinely-running cross-turn bg task
  re-enters the fold on its next `task_progress`/`task_updated`/
  `background_tasks_changed` line, so gating self-heals within one event — whereas
  the wedge never healed. **Only a real user line resets**: NOT `init`
  (auto-continuation of the same work) and NOT `state:running` (mid-turn
  re-activation) — both stay anchor-EQUIVALENT for `sawAnchor` but must not drop the
  gate on work that is still the same turn's. Consequence for the property test:
  batch fold ≡ foldSessionTail now holds for MULTI-anchor content, not just
  single-anchor content.
- **Prefilter before `JSON.parse`** (P6, perf-only, semantics-preserving): `foldLine`
  first substring-checks the raw line for `'"type":"user"'`, `'"type":"system"'`,
  `'"type":"result"'`, `'TeamCreate'`, `'TeamDelete'` and returns a v-only advance
  when none is present (gated on the line containing `'"type":"'` at all, so an
  oddly-spaced producer still falls through to the parse). A whale turn is ~99%
  `stream_event` deltas plus multi-KB tool_result lines, and parsing each made the
  fold the tailer's dominant cost (the L2 task-state feed has always used the same
  trick). The team names are matched DIRECTLY because team markers live inside
  `assistant` `tool_use` lines — a `'"type":"assistant"'` needle would match every
  assistant line and defeat the filter.
- `session_state_changed{running}` → `turnActive=true`; **invalidates** a prior
  `lastResult` (new turn started).
- `session_state_changed{idle}` → if `lastResult` present, `trailingIdle=true`.
  Does NOT by itself end a turn (idle-gated settle needs result+idle+no-gating).
- `result` (not notification-origin) → `lastResult={...， endOffset:lineEndV}`.
- `task_started/task_progress` → bg map upsert; terminal-is-terminal for THESE
  two only (a late/replayed start or progress must not revive a task).
  `task_updated`/`task_notification` take the patched status VERBATIM — a
  non-terminal status after a terminal one DOES revive the task and re-gates
  the turn (matches foldSessionTail :322/:331/:338 and the live handler;
  adjudicated 2026-08-05: premature settle is the unsafe direction).
  `isBackgrounded` is sticky.
- `background_tasks_changed` → level reconciliation (endedPerLevel semantics,
  `session-reconcile.ts:341-363`).
- Team markers (TeamCreate/TeamDelete tool_use) → `teamActive` set/clear.
- Unknown/other lines: update `v` only. Torn/unparseable line: update `v` only (the
  daemon feeds whole lines, so this is belt-and-suspenders).
- **Turn settle** (→ `turnActive=false`): `lastResult && trailingIdle &&
  gatingBg===0 && !teamActive` — evaluated inside foldLine after each transition.
- `gatingBgCount` = count of bg tasks with `!terminal && !isBackgrounded`.

`requires_action` is NOT folded here — `pendingCtrl` is intercepted imperatively by
the daemon tailer (existing code) and joins in `assembleSnapshot`.

## 3. Self-contained twin-safe module

`src/providers/daemon-fold.ts`:
- **ZERO imports. ZERO closure captures. Types only via local interfaces.** The whole
  module must survive `fn.toString()` round-trips.
- Style: single top-level exported functions; inner helpers as `const f = (…) => …`
  INSIDE the function bodies (avoids bundler `__name` helper injection).
- Consumed three ways:
  1. `daemon-standalone.ts` imports it directly (bun compiles it in).
  2. `daemon-source.ts` template gains placeholders `__FOLD_LINE__`,
     `__INITIAL_FOLD_STATE__`, `__ASSEMBLE_SNAPSHOT__`, `__SNAPSHOT_DIFFERS__`;
     `getDaemonSource()` injects `foldLine.toString()` etc. (same mechanism as
     `__DAEMON_VERSION__`).
  3. Walnut tests import it directly.
- `snapshotDiffers` (the push change-compare that ignores a bare `v` advance) joined
  this module 2026-08-06. It is pure + zero-dep, and it used to be hand-duplicated in
  BOTH twins where a one-sided edit — dropping a field from the compare, i.e. a
  permanently suppressed push for that field's transitions — had no byte-level guard.
  `validateFoldInjection` smoke-tests it in both directions (a bare `v` advance must
  NOT differ; a running → idle flip MUST differ).
- Still twin-LOCAL (they touch `fs` + the adapter's session object, so they cannot
  live in the zero-dep module): `assembleSessionSnapshot`, `rebuildFoldStateFromJsonl`,
  `drainSessionFold`, `drainFoldRange`. Their anti-drift guard is a normalized
  whole-body byte comparison in the parity suite (same technique as
  `decideBridgeRestart`).
- **Deploy-time validation** in `getDaemonSource()`: `new Function('return ' +
  foldLine.toString())()` + run one smoke fold; on failure THROW (fail fast, never
  deploy a corrupt daemon). A dedicated test also validates the tsup `dist/` bundle.
- Fallback if toString proves unworkable under the bundler: hand-mirror into the
  template + parity regex asserting the function bodies are byte-identical.
- Add the new file to the version-hash list in `scripts/build-daemon.sh` (:40-49).

## 4. Daemon integration (C1)

Per-session: `foldState: FoldState` on the session object (standalone `SessionData`,
source-template session literal, `daemon-core.ts` if shared).

- **Feed**: the existing tailer loop (standalone `ensureWatcher` ~:1342, source
  ~:1435) calls `foldLine` for EVERY complete line (cheap substring pre-checks may
  skip obviously irrelevant lines ONLY if `v` is still advanced).
  **Torn-tail carry (adjudicated 2026-08-05)**: the tailer must NEVER process a
  non-newline-terminated tail fragment — neither fold it nor fan it out. Keep an
  in-memory byte carry per watcher (same pattern as foldJsonlRange): offset
  advances past all read bytes, the torn tail waits in the carry until its
  newline arrives, complete lines get their usual v (lineStart+byteLength+1).
  Cap the carry (32MB) with an error log on overflow. Rationale: a torn
  result/idle line folded as two unparseable fragments advances foldState.v past
  the real line end and the line is lost forever — snapshot stuck turnActive
  (executed repro; whale tool_result lines >64KB tear across 100ms polls in
  practice). This also fixes the pre-existing fan-out tear.
  The carry is a **part LIST, not one Buffer** (2026-08-06): a whale line arrives
  across many polls, and concatenating (carry + new bytes) then searching for a
  newline from byte 0 each tick re-copied and re-scanned the same megabytes
  (quadratic). Rule: if the NEW chunk holds no newline, nothing can complete —
  append to the list and skip the concat + scan entirely; when a newline does
  appear, concat once and start the search at the carry length (the carry holds no
  newline by invariant).
  `appendUserMarker` (`daemon-core.ts:621-643`) ALSO folds the marker line
  immediately on write, **at the CURRENT foldState.v (no v advance)** — a pure
  optimistic overlay. Do NOT compute the marker's file offset (post-append stat
  races the concurrently-appending CLI — executed repro) and do NOT gap-catch-up.
  The tailer re-folds the marker later at its true v; the double-fold is safe:
  re-anchoring an anchored state is idempotent, and if gap lines (older than the
  marker) fold in between, file order still ends with the marker re-anchor, so
  the final state is correct in every interleaving (including mid-turn
  injection, where the previous turn's result+idle briefly settle the fold
  before the new turn's running re-activates — a true "idle with queued message"
  window; phase-level handling of that window is C3's business).
- **Rebuild**: on daemon start / adopt / attach-discover / resume / unknown-sid
  getState, rebuild `foldState` by streaming the whole stream file through `foldLine`
  (same pattern as `rebuildTaskStateFromJsonl`). Whale files are fine — local
  sequential read. Same 32MB carry cap + skip-to-next-newline realign as the live
  tailer: without it a single >32MB line (which the tailer deliberately DROPS) got
  re-materialized by repeated `Buffer.concat`, O(n²) copying on every rebuild.
  **Rebuild boundary rule (adjudicated 2026-08-06)**: the rebuild must NOT fold a
  trailing unterminated fragment, and it RETURNS the byte offset of the last
  complete-line boundary (`{ state, boundary }`). Every adopt/attach/resume site
  seeds BOTH `foldState` and the watcher `offset` from that same rebuild — never from
  a raw `stat().size`. Otherwise, when the CLI is mid-write at adopt time, the
  rebuild consumes the fragment's first half (advancing `foldState.v` past the real
  line end) AND the watcher starts mid-line, so the completed line is read from its
  middle, fails to parse, and is dropped by the `v > foldState.v` guard — the
  torn-line wedge, reintroduced at the adopt boundary. Corollary: every offset the
  daemon hands a CLIENT (`attach` reply `currentOffset`, `addSubscriber` replay
  start, the adopted-live `cmdStart` reply) must also be a complete-line boundary —
  the live watcher publishes `carryStartV` for exactly this reason.
- **Pre-death drain (C18)**: `reapSession` sets `state='dead'` FIRST, and the tailer's
  poll returns early once `state !== 'running'` — so the final `result` + companion
  `idle` the CLI wrote microseconds before exiting were never folded. The death
  snapshot, and every later `getState` pull (which just re-assembles the same frozen
  fold), then reported `turnActive=true` for a turn that provably ended on disk.
  `reapSession` now DRAINS synchronously before assembling: read from the watcher's
  published boundary to EOF, fold every COMPLETE line (same carry cap, same
  `v > foldState.v` guard), re-publish the new boundary, THEN push. Ordering is
  load-bearing: drain → assemble → push → exit fan-out.
- **assembleSnapshot(session)**: combines foldState + `pendingCtrl` + process
  liveness (`state === 'dead'`, pid, exitCode normalized by `isTurnCompleteExit`).
- **Push**: after each tailer batch (and on pendingCtrl / process-death changes),
  if the assembled snapshot *differs* from the last pushed one (`snapshotDiffers`:
  compare all fields, ignore bare `v` advance), emit `{ev:'snapshot', sid, snapshot}`
  to subscribers. Coalesce within a 50ms window. Process death always pushes
  immediately. **A pending coalesced push must be FLUSHED before any operation that
  re-keys the session** — `cmdRename` does `sessions.delete(oldSid)`/`set(newSid)`,
  after which the 50ms timer's generation guard (`sessions.get(sid) !== session`,
  keyed on the OLD sid) can never match and the queued change dies silently. The
  transition that never self-heals here is a `pendingCtrl` clear: `waiting` lives only
  in daemon memory, so with nothing further written to the stream file there is no
  next tailer batch to re-push it, and walnut stays on `waiting` until the 30s pull.
  `cleanup()` flushes for the same reason.
- **Pull**: `getState` response gains `snapshot: assembleSnapshot(session)`.
  Unknown-sid getState rebuilds from disk (existing behavior) and includes snapshot.
- **Capability**: add `'snapshot-v1'` to daemon capabilities; walnut treats hosts
  without it as legacy (no snapshot flow, old writers stay authoritative).
- Twins: standalone + source must stay in lockstep; extend
  `tests/providers/daemon-standalone-vs-source-parity.test.ts` with wiring
  assertions (feed points, event name, getState field, capability string).

## 5. Walnut projection (C2)

New module `src/core/session-snapshot-apply.ts`:

```ts
export function projectProcessStatus(s: SessionSnapshot): ProcessStatus {
  if (s.cliState === 'dead') return s.lastResult?.isError || (s.exitCode ?? 0) !== 0 ? 'error' : 'stopped'
  if (s.cliState === 'waiting') return 'running' // paused mid-turn on a prompt; 'waiting' stays display-layer (frozen v1 enum)
  if (s.turnActive) return 'running'
  if (s.lastResult?.isError) return 'error'      // matches reconcileProcessStatus target semantics
  return 'idle'
}
export async function applySnapshot(sessionId: string, snapshot: SessionSnapshot, source: string): Promise<ApplyOutcome>
```

`applySnapshot` steps (all idempotent):
1. **Terminal user-intent veto** (adjudicated 2026-08-06, C4): when
   `record.status_changed_by === 'user'` AND `record.process_status ∈
   {stopped, error}`, a snapshot that ALSO projects terminal is REFUSED
   **regardless of `v`** (`outcome:'skipped', reason:'user-terminal-intent'`).
   The user clicked Stop; the reap that follows produces a death snapshot with
   `exitCode ≠ 0` and a `v` BEYOND the watermark, so a v-only gate relabels the
   deliberate stop as a red `error`. Terminal→terminal carries only a *label*,
   and the user's label wins. Only a projection that CONTRADICTS the verdict
   (`running`/`idle` — "the stop did not take") may supersede a user-terminal
   record, and only with `v` beyond `record.consumedOffset`.
2. **v-gate**: per-session `appliedV`, floored by `record.consumedOffset`
   (`gate = max(appliedV ?? 0, consumedOffset ?? 0)` — the durable watermark is
   always a valid floor and is the ONLY floor on first sight this process
   lifetime). `snapshot.v < gate` → drop (`outcome:'stale'`), WITHOUT granting
   coverage (a stale snapshot is not evidence). Equal v with identical
   projection → drop (`noop`).
   `appliedV` lives in the SAME bounded registry as coverage
   (`session-snapshot-gate.ts`: `Map<sid, appliedV>`, `has` = covered) — one
   entry, one cap, one eviction path, and every write (including the
   first-sight seed) goes through `markSnapshotCovered` so the cap actually
   fires.
3. Project → compare with `record.process_status`.
4. Mode dispatch (flag, §6): shadow → divergence log only (**rate limited**:
   warn on the first sighting per sid and on every change of the
   (projected, actual) pair, then at most once per 10 min with the accumulated
   count — a persistent divergence is re-observed on every push AND every pull,
   and shadow mode runs for days); enforce → conditional write via
   `updateSessionRecordConditionally` (+ watermark adoption per step 5, terminal
   PID clear — reuse session-tracker arbitration) + emit
   `session:status-changed` + sync live runner memory via the
   `setProcessStatusFromReconciler` precedent (`claude-code-session.ts:1114`).
   The write predicate runs UNDER the tracker's write lock and is where the
   gate is actually ENFORCED (the check-then-act above spans awaits). It
   refuses when:
   - `current.consumedOffset > snapshot.v` — **v monotonicity** (C5). Without
     this the predicate never required forward motion, so a lower-v snapshot
     racing in could overwrite a newer projection.
   - `current.consumedOffset === snapshot.v` and the snapshot's evidence is
     stream-derived — **equal-v tiebreaker** (C16). At an unchanged watermark
     there are no new bytes, so a stream-derived projection carries nothing the
     record has not consumed; this is what stops a same-v `running` from
     resurrecting a dead record. `cliState ∈ {dead, waiting}` is OUT-OF-BAND
     evidence (process liveness / an intercepted permission request reach the
     daemon without stream bytes) and passes at equal v.
   - nothing would change.
5. **`consumedOffset` is a TURN-END watermark, never a per-status cursor**
   (C15). It is adopted ONLY from a snapshot that is `cliState === 'dead'`
   (nothing can append any more) or a SETTLED fold (`turnActive === false` and
   `cliState !== 'waiting'`). A mid-turn `running` — and `waiting`, which at
   `turnActive === false` is the post-settle permission race, i.e. a turn still
   coming — writes `process_status` WITHOUT touching the watermark; the
   in-memory `appliedV` is the ordering gate for those. Rationale:
   `foldSessionTail` synthesizes its whale-turn anchor AT `consumedOffset` and
   the live/replay guards read `v <= consumedOffset` as "already fully
   processed", so a mid-turn watermark plants that anchor inside an open turn
   and makes the turn's real result look like a replay.
6. Never touches `task.phase` (C3). Never touches ACP (`engine:'codex'`),
   embedded-subagent, or `awaiting_spawn`-seeded pre-spawn records.

**Flag** `WALNUT_SNAPSHOT_STATUS = 'off' | 'shadow' (default) | 'enforce'` (env).
- off: nothing runs.
- shadow: snapshots flow, projections computed, divergences logged
  (`log.session.warn('snapshot-shadow divergence', {sessionId, projected, actual,
  v, consumedOffset, statusReason, source})`), records untouched.
- enforce: applySnapshot is the sole writer for daemon-backed native sessions.
  Legacy writers are neutralized at ONE gate inside
  `session-tracker.applyUpdateToSession`, active only when enforce AND the patch
  touches `process_status` AND the session is snapshot-covered (see below). TWO
  shapes are gated, with deliberately different blast radius:
  - **category-① pairs** (the table below) → the **WHOLE patch is dropped**
    (adjudicated 2026-08-06, C10). These writers exist only to publish a status
    verdict; stripping just the status trio let `pid: undefined`,
    `consumedOffset`, `activity: undefined` and `last_status_change` land — a
    half-applied state no writer intended (a cleared PID on a session the
    snapshot still reports running forces the next send onto the cold `--resume`
    path). All-or-nothing is the only coherent choice.
  - **un-stamped status writes** (NEITHER `status_changed_by` NOR
    `status_reason` present) → **strip only the status fields**, keep the rest
    (C30). This shape is the session runner's stream projector
    (`ClaudeCodeSession.emitStatusChanged` + its spawn/turn-start persists) —
    the highest-volume status writer in the system and previously un-gateable
    because it carries no pair to match, so "sole writer" was unenforced for
    exactly the writer that mattered most. Its patches DO carry load-bearing
    non-status facts (`pid`/`host` — the orphan-dead-pool fix — plus
    `outputFile`, `mode`, `activity`, `planCompleted`), so the whole patch must
    not be dropped. Verified by a repo-wide survey of `updateSessionRecord*`
    callers that touch `process_status`: every user/system/reconciler/daemon
    writer stamps identity; the only other un-stamped ones are the runner's own
    resume/turn-start persists (same class) and `session-server-client` /
    `subagent-runner`, whose sessions are `provider: 'sdk' | 'embedded'` and
    therefore excluded by `applySnapshot` — they never become covered and never
    reach this gate.
  - Anything else — a stamped-but-unlisted pair, or a PARTIALLY stamped patch —
    passes through untouched (contract's PASS-THROUGH-when-unsure tiebreak).
  - **Log churn**: a suppressed writer keeps refiring (the health monitor retries
    the same gated write every 30s while the divergence lasts). The gate logs
    `info` on the FIRST suppression per sid and `debug` thereafter, always with a
    running `suppressedCount` (C17).
- **snapshot-covered** = `has(sid)` on the ONE bounded registry in
  `session-snapshot-gate.ts` (`Map<sid, appliedV>` — see step 2), populated for
  sids whose host advertises `snapshot-v1` and for which a snapshot has been
  applied/shadow-observed this process lifetime. Uncovered sessions (old daemon,
  pre-spawn) always use legacy writers — this IS the version-skew fallback.
  `unmarkSnapshotCovered` is the capability-downgrade escape hatch (see the
  doc comment on it) and clears that sid's `appliedV` + suppression counter too.

Category-① reasons/changed_by to gate (from the writer inventory): `session-runner`
statuses driven by stream events (`message_sent` from state-changed persist,
`turn_completed`, `daemon_reported_exit`, `liveness_check_failed`,
`remote_unreachable`, `process_exited_no_result`, `normal_completion` from
health-monitor, `idle_timeout`, `auto_recovered`, `auto_recovered_dead`,
`daemon_reconnected`, `reconciled_authoritative`, `streaming_evidence_self_heal`,
`server_restart`, `idle_eviction`, `orphan_no_pid`).
Category-② (never gate): `awaiting_spawn`, `user_stopped`, `user_terminated`,
`retry_reconnect`, `restart_reinitialize`, `message_sent` when written by
`handleSend`/FIFO-write path… — implementers: gate by exact
(changed_by, reason) pairs, defaulting to PASS-THROUGH when unsure (a duplicate
legit write is harmless; a blocked legit write is not).

**Intake**: `RemoteSessionManager.handleDaemonEvent` gains `case 'snapshot'` →
`applySnapshot(sid, snapshot, 'daemon-push')`. Unknown `ev` types remain ignored
(old-walnut compat).

**Pull channel**:
- Health-monitor 30s tick: for every session record with `process_status` in
  {running, idle}, native engine, whose host has a **pooled, connected**
  DaemonConnection advertising `snapshot-v1` (NEVER dial a new connection for
  this) → `getState` → `applySnapshot(sid, resp.snapshot, 'pull-30s')`.
  Sequential, ≤10 sids/tick, skip if a pull for that sid ran <25s ago, PLUS two
  properties the loop must keep (adjudicated 2026-08-06, C8/C9/C12/C29):
  - it takes the `TickContext` and checks `ctx.overBudget()` **inside** the loop
    (same discipline as `checkHungSessions`): each iteration is a real daemon RPC
    with a probe-timeout ceiling, so 10 slow hosts could burn 10 × that timeout
    sequentially BEFORE the authoritative reconcile phases that run after it.
    Abandoning mid-loop is safe — every pull is idempotent and the rest come
    first on the next tick.
  - candidates are sorted by `lastPullAt` **ascending** (never-pulled first), so
    the 10/tick cap becomes a round-robin. In list order the same first ten sids
    were pulled every tick and — because the 25s spacing is shorter than the 30s
    cadence — sids 11+ were **never** pulled: the pull channel silently did not
    exist for them.
- `DaemonConnection.recoverDisconnectedSessions` (reconnect path): include
  `snapshot` from its `getState`/status probes → `applySnapshot(sid, …,
  'reconnect-pull')`.
- `DaemonConnection.connectDirect` runs the same `hello` handshake as
  `connect()`/`reconnect()` (C31). Without it `_capabilities` stayed null on every
  direct connection, so `supportsSnapshots` was false for the **local** daemon
  (which reaches the pool via `getDirectDaemonConnection` → `connectDirect`),
  `getPooledSnapshotConnection('__local__')` never matched, and the whole pull
  channel was dead for every local session. A failed handshake is non-fatal there
  (nothing to redeploy on a direct link) — it only leaves optional capabilities
  unadvertised. Test fixtures that model a CURRENT daemon must answer `hello`
  with `ADVERTISED_DAEMON_CAPABILITIES`; answering with `REQUIRED` only models a
  rolled-back daemon and silently gates the snapshot flow off.

## 6. Testing layers (all must exist; this is the acceptance bar)

1. **Unit** (`tests/providers/daemon-fold.test.ts`): every foldLine rule + property
   test: for random line sequences, `reduce(foldLine)` ≡ `foldSessionTail` verdict
   on the same content (the 55 existing tests define truth).
2. **Golden incident replays** (`tests/providers/daemon-fold-golden.test.ts`):
   shape-replicas of each historical incident (whale turn, requires_action 15h,
   queued-send race, restart-in-result-window, premature-idle/bg-gating, replay
   storm). SYNTHETIC data only — public repo, never copy real conversation content.
3. **Self-containedness** (`tests/providers/daemon-fold-injection.test.ts`):
   `new Function` reconstruction of all injected fns runs the golden set with
   identical outputs; plus a dist-bundle variant if dist exists.
4. **applySnapshot unit** (`tests/core/session-snapshot-apply.test.ts`): v-gate
   (stale drop, equal-v idempotence), projection table, shadow-vs-enforce, gate
   table (category ① stripped, ② passes), uncovered-session fallback.
5. **Fault-injection interleaving simulator**
   (`tests/core/session-snapshot-sim.test.ts`): seeded PRNG (seed logged, fixed
   default); generate scripted true timelines (turns, bg tasks, permissions,
   process death), deliver snapshots through a lossy channel (drop p, duplicate p,
   reorder window, daemon-restart resnapshots, walnut-restart appliedV reseed);
   INVARIANT: after quiescence + one simulated pull, projected record status ===
   the true terminal state. Hundreds of seeded runs, milliseconds each (pure, no IO).
6. **High-fidelity E2E** (`tests/e2e/` + mock CLI `tests/providers/mock-claude.mjs`,
   real server via `startServer({port:0, dev:true})`, real local daemon binary):
   send → snapshot push → record converges; kill CLI mid-turn → dead snapshot;
   permission pause → waiting; daemon restart → rebuild converges; pull heals a
   suppressed push.
7. **Stress** (`tests/e2e/session-snapshot-stress.test.ts`): ~20 concurrent mock
   sessions × rapid multi-KB line bursts + whale-sized single turn; assert all
   converge, no event-loop stall >250ms (event-loop monitor exists), memory sane.
   BOUNDED: respect the 2-worker vitest budget, clean up every daemon/tmp dir in
   afterAll (leaked daemons have wedged this machine before).
8. **Shadow soak** (post-deploy, not a test file): divergence log = continuous
   production self-check; zero-divergence streak gates C4.

Machine-safety rules for ALL test agents: never touch port 3456 or
`~/.open-walnut`; isolated `OPEN_WALNUT_HOME`/tmp dirs; kill spawned daemons in
teardown; never raise worker budgets; heavy suites run serially.

## 6b. Deferred cleanups (C4 scope, from the 2026-08-06 review)

- FoldState stores derived `turnActive` while assembleSnapshot re-derives gating with a
  duplicate predicate — consider raw-facts-only FoldState + one derive site.
- Rebuild paths read the same jsonl twice (task-state slurp + fold chunked read) —
  unify into one chunked pass feeding both folds.

## 7. Out of scope (do NOT implement here)

- `task.phase` projection (C3, blocked on a product decision).
- ACP/codex, embedded-subagent, SDK session-server adapters (C3).
- pendingPermission record reconciliation via snapshot (C3; Fix B display flow
  already works off the existing record field).
- Deleting legacy writers (C4, gated on shadow soak).
- Frozen `/api/v1`: `process_status` stays the 4-value enum on the wire.
