# Daemon as Source of Truth + Versioned Events

> Design for making session/task state **reliable by construction** — modeled on the Kubernetes
> apiserver/etcd/informer pattern. Supersedes the earlier mtime-heuristic reconcile.
> Status: **IMPLEMENTED** (Layers 0–2, 2026-06-28). L0 derive-from-set + L1 versioned events
> (daemon stamps `v` = byte offset; RSM skips `v ≤ lastSeenV`) + L2 daemon-authoritative task
> state (`getState` RPC) with Walnut PULL reconcile. typecheck clean; 58 new/changed tests green
> + adversarial-verified (disabling version-skip → L1-2/3/4 red; disabling adopt → L2 heal red);
> daemon binary rebuilt. Uncommitted. Pre-existing unrelated failure: the session-io export chain
> (`buildRemoteCommand`/`RemoteIO`/`transferImagesForRemoteSession`) — absent in src/ on HEAD too.

---

## Executive Summary

- **Problem.** A session "finished but stayed Running forever." Root cause: Walnut keeps task state
  as a **local in-memory tally** of an event stream that can duplicate, reorder, or **drop** events.
  When a terminal event was lost (or arrived out of order), the local view desynced and never
  recovered. We already fixed the *accumulator* bug (Layer 0, derive-from-set), but the deeper
  disease remains: **Walnut treats a lossy event stream as the source of truth.**
- **Fix.** Stop trusting the local tally. Make the **daemon** the source of truth — it sits closest
  to the CLI, sees every byte, and already persists the full event log (`.jsonl`, append-only). Give
  every event a **monotonic version** (the byte offset — already tracked, free) so stale/duplicate/
  out-of-order events are skipped deterministically. Let the **server and frontend PULL authoritative
  state from the daemon** instead of each re-deriving it from a stream they might have missed.
- **Simplest first step.** Layer 0 is already done and *already fixes this incident*. The smallest
  shippable next increment is **Layer 1 (versioned events)**: the daemon stamps each forwarded event
  with its byte offset `v`; Walnut skips `v <= lastSeenV`. ~15 lines each side, replaces 3 ad-hoc
  dedup layers, and makes ordering benign forever.
- **User-visible outcome.** Sessions never get stuck "Running" after they finish. Refresh, SSH drop,
  daemon restart, Walnut restart — the displayed state always converges to the truth, because every
  client reads it from the one place that actually knows.
- **Honesty.** The daemon's parse can be wrong, but it can't *drift*: it can always re-materialize
  from the durable log. The only residual gap (CLI dies before flushing a terminal event) is already
  covered by process-death turn-completion + the 2h idle backstop.

---

## 1. The Kubernetes mapping (the whole design in one table)

The user's instinct is exactly the k8s **informer** pattern. The mapping is faithful and it is the
right model:

| Kubernetes | Walnut (this design) | Status today |
|---|---|---|
| **etcd** — durable log + global MVCC revision | the append-only **`.jsonl`** stream file + its **byte offset** | ✅ exists (append-only verified) |
| **resourceVersion** — opaque monotonic int | the **byte offset** of an event (monotonic per session, never rewritten) | ✅ tracked as `watcher.offset` / `_fileSize`, but **not stamped onto events** |
| **apiserver** — materializes objects, serves GET/WATCH, assigns versions | the **daemon** — parses `task_*`, materializes `SessionState`, serves `getState` + a version-stamped stream | ❌ daemon is a pure byte relay today |
| object **`.status`** subresource | `SessionState.tasks` (per-task status) + `derivedRunning` + `phase` | ❌ |
| **WATCH from resourceVersion** (skip stale, resume after gap) | the live `jsonl` event stream, each event stamped `v`; client skips `v ≤ seen`, reattaches `fromOffset = seen` | ⚠️ replay-by-offset exists; **version skip does not** |
| **informer cache / lister** | Walnut's `_bgTasks` Map = a local cache materialized from the watch | ✅ (Layer 0) |
| **relist / resync** | periodic or on-suspicion `getState(sid)` PULL to correct any missed watch event | ❌ (was a local mtime guess; deleted) |
| **controller reconcile loop** | health-monitor tick → `getState` → complete stuck turns | ⚠️ partially (the deterministic backstop exists) |

**The single elegant unification to highlight:** `resourceVersion == byte offset == replay cursor`.
One number does three jobs — dedup the live stream, version the state, and position a re-attach. We
do not need to invent a counter; the append-only file already gives us one for free.

---

## 2. Current architecture (what's actually true today)

Verified by source audit (file:line in §9). The daemon is a **dumb byte relay** — this is why it's
reliable across restarts, and also why it can't currently be a source of truth for *meaning*.

```
                         ┌─────────────────────── remote host (or __local__) ──────────────────────┐
                         │                                                                          │
  Walnut (Mac)           │   daemon (bun binary / JS fallback)            claude -p CLI             │
  ┌──────────────┐  RPC  │   ┌───────────────────────────────┐   spawn   ┌──────────────────────┐  │
  │ Remote       │◄─────►│   │ sessions Map: liveness only    │◄─────────►│ stdout (stream-json) │  │
  │ SessionMgr   │  ws   │   │  {state:running|dead, pid,     │           └──────────┬───────────┘  │
  │ _bgTasks Map │       │   │   offset, mode, pendingCtrl}   │   kernel pipe        │ fd            │
  │ (accumulates │       │   │                                │   ┌──────────────────▼────────────┐ │
  │  from stream)│       │   │ watcher: tail .jsonl every     │   │ <sid>.jsonl  (append-only)     │ │
  └──────┬───────┘       │   │  100ms, forward each line      │◄──┤  THE durable event log         │ │
         │               │   │  VERBATIM as {ev:'jsonl',line} │   └────────────────────────────────┘ │
         │               │   │  ── does NOT parse task_* ──   │                                        │
         │               │   └───────────────────────────────┘                                        │
         │               └────────────────────────────────────────────────────────────────────────── ┘
         ▼
  ClaudeCodeSession.handleStreamLine()  ← parses task_* HERE, in Walnut, from a stream it may miss
```

**The three facts that make this fragile:**

1. **Daemon does not parse task events.** It peeks lines only for `init` (latency), `control_*`
   (permissions), `result` (stderr tail). Every `task_started/progress/updated/notification` is
   forwarded as opaque bytes. → The one process that *can't lose* the events doesn't *understand*
   them; the process that understands them (Walnut) *can* lose them.
2. **No version on any event.** Envelope is `{ev:'jsonl', sid, line}` — no seq, no offset, no
   timestamp stamped by the daemon. Ordering is "position in the TCP byte stream," and dedup is three
   ad-hoc layers (uuid Set capped at 5000, `message.id` merge, per-turn key set). Out-of-order is
   **not handled at all** at the transport.
3. **Walnut's cursor is not durable.** `_fileSize` is in-memory; on a Walnut restart it resets to 0
   and the code deliberately subscribes *future-only* (`MAX_SAFE_INTEGER`) to avoid replaying. So
   after a restart, anything in-flight is simply not re-derived from the log.

---

## 3. The incident, and why Layer 0 already fixes *it* (but not the disease)

```
Real CLI event order for one background task:
  task_started ─► task_progress×N ─► task_updated{status:completed} ─► task_notification{completed}
                                     └──────────── NEW terminal bookend ────────────┘
```

**Old (edge-triggered) Walnut:** `notification` did `if (status==='running') count--`. But
`task_updated` had already set status to `completed`, so the guard skipped the decrement →
**counter leaked +1 forever** → `hasActiveBackgroundWork()` stuck true → turn never completes.

**Layer 0 (done):** in-flight is **derived** from the `_bgTasks` set (`count of non-terminal`),
never accumulated. Duplicate / out-of-order / new-kind events are now benign by construction. This
**deterministically fixes the incident** (all events arrived; only the local math was wrong).

**But the disease remains:** if a terminal event is genuinely *lost in transport* (SSH drop window,
daemon restart gap, Walnut restart future-only subscribe) while the CLI keeps running, the set still
holds a phantom `running` task forever. Layers 1–2 close that.

---

## 4. Target architecture

```
                         ┌─────────────────────── remote host (or __local__) ──────────────────────┐
  Walnut (Mac)           │   daemon  ( = mini apiserver + etcd )                                     │
  ┌──────────────┐       │   ┌──────────────────────────────────────────────┐                       │
  │ server +     │       │   │ tail .jsonl ─► PARSE task_* (NEW, ~30 LOC)     │   ┌────────────────┐ │
  │ frontend     │       │   │                                                │◄──┤ <sid>.jsonl    │ │
  │              │       │   │ SessionState (NEW, persisted = k8s object):    │   │ append-only    │ │
  │ _bgTasks =   │ watch │   │   tasks: {taskId → {status, v, t}}             │   │ (= etcd log)   │ │
  │  informer    │◄──────┤   │   resourceVersion: <byte offset>               │   └────────────────┘ │
  │  cache       │ each  │   │   derivedRunning: int                          │                       │
  │              │ event │   │   recentTransitions: ring buffer (history)     │   on restart:         │
  │              │stamped│   └──────────────────────┬─────────────────────────┘   re-materialize from│
  │              │  v    │              ▲            │                              jsonl @ offset 0   │
  │              │       │              │ getState   │ stamped stream {ev,line,v}                       │
  └──────┬───────┘       │   ┌──────────┴────────────▼─────────┐                                       │
         │  getState(sid)│   │ RPC: getState(sid) → SessionState│  ← NEW: the GET                       │
         └──────────────►│   └──────────────────────────────────┘                                       │
                         └─────────────────────────────────────────────────────────────────────────── ┘
```

### 4.1 What the daemon stores (the k8s object file)

A new persisted, per-session `SessionState` (sibling to the existing `sessions.json` registry; can
live in the same file or a `<sid>.state.json`):

```ts
interface SessionTaskState {
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled'
  description?: string
  subagentType?: string
  v: number          // byte offset of the event that last set this status (its resourceVersion)
  t: number          // wall-clock ms of that event
}

interface SessionState {
  sid: string
  resourceVersion: number                       // == current byte offset; monotonic per session
  updatedAt: number
  tasks: Record<string /*taskId*/, SessionTaskState>
  derivedRunning: number                        // count of tasks whose status is non-terminal
  // optional "partial history" the user asked for — bounded ring buffer for observability:
  recentTransitions?: Array<{ taskId: string; status: string; v: number; t: number }>
}
```

- **Materialized incrementally** as the daemon tails the jsonl (it's already tailing). For each line,
  if it's a `task_*`, apply it to `tasks` with the **same idempotent, terminal-is-terminal** rules
  Walnut uses today (so daemon and Walnut agree by construction).
- **`resourceVersion` = the byte offset.** Free, monotonic, append-only (verified: file opened `'a'`/
  `'w'`, never rewritten). Doubles as the replay cursor.
- **Rebuildable from the log.** On daemon restart / adopt, re-read the `.jsonl` from offset 0 and
  re-materialize. The persisted `SessionState` is a *cache/checkpoint* (like apiserver's watch cache);
  the `.jsonl` is etcd. **This is why the daemon's view can be wrong-but-never-drift** — it can always
  recompute from the durable log. (Directly answers "如果它错了那也没办法": it can self-heal.)

### 4.2 What the daemon exposes (the GET + the versioned WATCH)

- **New RPC `getState(sid) → SessionState`.** O(1), cheap. This is the "relist/GET" any client uses to
  reconcile. Replaces the deleted local mtime heuristic for *both* local and remote (both go through a
  daemon — verified `__local__` via `local-daemon.ts`).
- **Versioned event stream (WATCH).** The forwarded envelope gains one field: `{ev:'jsonl', sid,
  line, v}` where `v` is the byte offset *after* this line. Stamped in the watcher's per-line forward
  loop (one line of code; the daemon already knows the running offset).

### 4.3 What Walnut becomes (the informer)

- `_bgTasks` stays — but it's explicitly an **informer cache**, not the truth. It is fed by the
  versioned watch and **reconciled by `getState`**.
- **Version skip (kills duplicate/out-of-order at the transport):** track `lastSeenV` per session;
  on each event, `if (v <= lastSeenV) skip; else apply; lastSeenV = v`. This **replaces** the three
  ad-hoc dedup layers (uuid Set, message.id, per-turn keys) with one comparison. `lastSeenV` is also
  what we pass as `fromOffset` on re-attach.
- **Reconcile via PULL, not guess:** the health-monitor tick (and the moment a turn looks done but
  `running > 0`) calls `getState(sid)`. If the daemon says a task is terminal that Walnut still has
  `running`, Walnut adopts the daemon's truth and completes the turn. If the daemon also says
  running, it really is running (the daemon read the same durable log) — leave it.

---

## 5. End-to-end flows

### 5.1 Steady state (no loss) — the watch

```
CLI            daemon                                   Walnut (informer)
 │  task_started                                          │
 ├──jsonl line──► tail: parse → tasks[T]=running,v=1020    │
 │               persist SessionState{rv:1020}             │
 │               forward {ev:jsonl, line, v:1020} ────────►│ v=1020 > seen(0) → apply; seen=1020
 │  task_updated{completed}                                │
 ├──jsonl line──► tasks[T]=completed,v=1300; rv:1300 ──────►│ v=1300 > seen → apply (set: completed); seen=1300
 │  task_notification{completed}                            │
 ├──jsonl line──► idempotent (already completed),v=1400 ───►│ v=1400 > seen → apply (no-op); seen=1400
 │                                                          │ derivedRunning=0 → turn completes ✓
```

### 5.2 Terminal event lost in transport (the disease) — the resync

```
CLI            daemon                                   Walnut (informer)
 │  task_started                                           │
 ├──jsonl──────► tasks[T]=running, rv:1020 ───────────────►│ apply; running=1
 │  task_notification{completed}                            │
 ├──jsonl──────► tasks[T]=completed, rv:1400 ──X dropped X─►│ (SSH drop / restart future-subscribe)
 │                                                          │ still thinks running=1 ✗ (the old bug)
 │                                                          │
 │                          health-monitor tick / turn-looks-done:
 │                          getState(sid) ─────────────────►│
 │               ◄──────────  SessionState{tasks[T]:completed, rv:1400, running:0}
 │                                                          │ adopt truth → running=0 → complete ✓
```

This is the case the user pointed at: *"如果 Demon record 的话,它应该是知道的"* — yes. The daemon read
the terminal event from the durable log even though Walnut's live stream missed it. PULL fixes it.

### 5.3 Out-of-order / duplicate across a reconnect — version skip

```
reconnect replays [1020, 1400) but the live tail already delivered 1400:
  incoming v=1020 ≤ seen(1400) → SKIP
  incoming v=1300 ≤ seen(1400) → SKIP
  incoming v=1400 ≤ seen(1400) → SKIP
→ no double-apply, no revival, deterministic. (Layer 0 already made apply idempotent;
  version-skip makes it cheap and removes 3 dedup layers.)
```

### 5.4 Daemon restart — rebuild cache from etcd

```
daemon dies → new daemon → reconcileRegistry adopts sid (CLI still alive, verified pgid)
            → re-read <sid>.jsonl from offset 0 → re-materialize SessionState (rv = file size)
            → persist checkpoint. Walnut's next getState/watch sees the correct rv.
(The .jsonl is etcd; SessionState is the rebuildable watch cache. No truth is lost.)
```

---

## 6. Failure-mode coverage (honest boundary)

| Failure | Before | After this design | Final backstop |
|---|---|---|---|
| Duplicate event | could leak counter | **version skip** + idempotent set | — |
| Out-of-order (`updated` before `notification`) | **the incident** | Layer 0 idempotent + version skip | — |
| Terminal event lost in live stream (CLI alive) | **stuck Running forever** | **`getState` PULL** adopts daemon truth | health-monitor reconcile |
| Walnut restart mid-turn (future-only subscribe) | in-flight not re-derived | `getState` on attach re-materializes | — |
| Daemon restart | offset reset, possible gap | daemon **rebuilds from jsonl @0** | — |
| **CLI dies before writing terminal event to jsonl** | stuck | jsonl genuinely lacks it → daemon also can't know | **`handleProcessDeath()` completes turn in ALL branches** (verified) |
| CLI alive, task truly hung, no terminal ever emitted | stuck | not observable by anyone (CLI bug) | **2h idle-kill** |

The last two rows are the irreducible residual — and both are already covered by deterministic
backstops that don't depend on task state at all. **Every "stuck Running" path we can actually
observe is closed.**

---

## 7. Phasing (simplicity is a goal — smallest correct increments)

- **Layer 0 — derive-from-set. ✅ DONE.** Already fixes the actual incident. Must be left intact.
- **Layer 1 — versioned events.** Daemon stamps `v` (byte offset) on each forwarded line; Walnut
  `lastSeenV` skip; remove 3 dedup layers. *~15 LOC each in both daemon files + RSM.* Smallest
  shippable; makes ordering benign forever; no schema/persistence work.
- **Layer 2 — daemon as task-state source of truth.** Daemon parses `task_*` → materializes &
  persists `SessionState`; new `getState(sid)` RPC; Walnut reconciles via PULL on health-tick /
  turn-looks-done; **deletes the half-done mtime reconcile remnants** (§8). This is the user's full
  vision and the real cure for transport loss.
- **Layer 3 (optional/observability).** `recentTransitions` ring buffer surfaced in the UI /
  `walnut-logs.sh`; frontend reads `getState` directly for a always-accurate Running badge.

Each layer is independently shippable and strictly improves reliability. Ship 1, then 2.

---

## 8. Resolving the half-finished code (must compile first)

An in-flight edit deleted `reconcileBackgroundWork()` + `_subagentTranscriptMtime()` (the mtime
heuristic) and replaced them with a rationale comment, but left **5 compile-blocking references** and
2 dead symbols. The mtime instinct was right (*pull a source of truth*) but the **source was wrong**
(mtime is a lagging, local-only signal that can't tell "alive-but-quiet" from "just died" — and
doesn't exist for remote). **Layer 2's `getState` is the correct source; it replaces mtime entirely.**

**Immediate (restore green, keep Layer 0 only):**
- Delete the live call `claude-code-session.ts:4371` (`await session.reconcileBackgroundWork(...)`).
- Make `isBackgroundWorkActive()` synchronous: `return session.hasActiveBackgroundWork()`.
  (Both health-monitor call sites already `await`, so narrowing to sync is safe.)
- Delete `BG_RECONCILE_STALE_MS` (`:270`) and the now-dead `_lastBgActivityTs` (`:420` + its 5
  write sites) — written nowhere-read after the reconcile is gone.
- Remove the 4 mtime/`reconcileBackgroundWork` tests + helpers in
  `tests/providers/session-background-workflow.test.ts` (keep the 2 idempotency tests — duplicate /
  out-of-order — they validate Layer 0 and stay green). Drop `fsp.utimes` usage.
- Clean the ~6 stale doc-comments pointing at the vanished method.

**Then Layer 2 re-introduces a reconcile — but PULL-based:** `isBackgroundWorkActive()` (or a new
`reconcileFromDaemon()`) calls `getState(sid)` and adopts the daemon's terminal statuses. Same call
shape the health-monitor already uses (`await runner.isBackgroundWorkActive(...)`), so the async
signature comes back cleanly at Layer 2.

---

## 9. Source citations (so the design rests on verified facts)

**Daemon = byte relay, no task parsing:**
- Kernel pipe CLI stdout → jsonl: `src/providers/daemon-standalone.ts:629-657` (`outputFd =
  openSync(jsonlPath, resume?'a':'w')`, `stdio:[pipeFd, outputFd, stderrFd]`).
- Tail + verbatim forward: `daemon-standalone.ts:781-904`, `sendEvent(ws,'jsonl',{sid,line})` `:852`
  (mirror `daemon-source.ts:1081-1088`).
- Only peeks `init`/`control_*`/`result` (`:805`, `:813-839`, `:868`); `task_*` strings appear
  nowhere in either daemon (grep-verified).

**Append-only ⇒ monotonic offset:**
- `openSync(jsonlPath, resume ? 'a' : 'w')` `daemon-standalone.ts:630` — append on resume, truncate
  only on fresh start (once per session id). Never rewritten.
- Offset tracked as `SessionData.offset` / `watcher.offset` (`:165`, `:168`), advanced to file size
  (`:793`); mirrored Walnut-side as `RemoteSessionManager._fileSize` (`:58`, advanced `:834`).

**No version anywhere; dedup is ad-hoc:**
- Envelope `DaemonEvent {ev,sid,line}` `daemon-connection.ts:49-65` — no seq/offset/ts.
- Dedup: `_seenUuids` cap 5000 `remote-session-manager.ts:84-85,836-893`; `message.id` merge
  `session-history.ts:323-356`; per-turn keys `claude-code-session.ts:2637-2640`. Out-of-order not
  handled.

**Registry stores liveness only:**
- `RegistryEntry` `daemon-core.ts:24-36`; `persistRegistry` `:206-236`. No task/version fields.
- RPC surface 21 cmds (`daemon-standalone.ts:524-553`); no task-state query; `status`/`list`/`attach`
  return liveness/pid/offset only.

**Local sessions also go through a daemon:** `__local__` via `src/providers/local-daemon.ts:47,321`;
`daemon-connection.ts:1729-1730`. → one design covers local + remote.

**Walnut consumer (Layer 0 done) + backstop:**
- `_bgTasks` `claude-code-session.ts:416`; `_runningBgCount`/`hasActiveBackgroundWork`/
  `_BG_TERMINAL_STATUSES` `:436-465`; 4 handlers `:2434-2542`; idempotent terminal-is-terminal.
- Replay rebuild: `session-history.ts:1017-1021,1058-1059,1116-1149,1264-1267`.
- Deterministic backstop: `handleProcessDeath()` completes turn in all branches `:1751-1896`
  (remote `handleRemoteProcessExit()` `:1919`).

**Compile-blockers (half-done edit):**
- `claude-code-session.ts:4371` (call to deleted `reconcileBackgroundWork`); `:270`
  (`BG_RECONCILE_STALE_MS`); `:420` + writes `:1268,2463,2494,2496,2524` (`_lastBgActivityTs`, dead).
- Tests `tests/providers/session-background-workflow.test.ts:885,892,910,928`.
