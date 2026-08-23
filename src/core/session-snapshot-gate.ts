/**
 * session-snapshot-gate — tiny shared state for the C2 snapshot projection
 * (docs/plan/session-snapshot-source-of-truth.md §5).
 *
 * ZERO imports on purpose: session-tracker (imported by nearly everything)
 * consults this module synchronously inside applyUpdateToSession, and
 * session-snapshot-apply populates it. Keeping the gate dependency-free breaks
 * the tracker ↔ apply circular-dependency knot — the tracker never has to know
 * the apply module exists.
 */

export type SnapshotStatusMode = 'off' | 'shadow' | 'enforce'

function readModeFromEnv(): SnapshotStatusMode {
  const raw = process.env.WALNUT_SNAPSHOT_STATUS
  // Default flipped shadow → enforce (C4, 2026-08-13) after the shadow soak:
  // 4 days, 1880 divergence logs across 28 sessions, and in EVERY investigated
  // incident (019a7fe5, 936b0a44, a172ce49, 176935b9) the snapshot side was
  // correct while the record was stale — shadow could see it but not write it,
  // so "finished but still shows Running" kept recurring. Enforce is bounded:
  // it gates legacy writers ONLY for sessions actively covered by snapshots
  // (isSnapshotCovered); uncovered sessions keep legacy writers as fallback.
  // Revert switch: WALNUT_SNAPSHOT_STATUS=shadow.
  return raw === 'off' || raw === 'shadow' ? raw : 'enforce'
}

/** Read ONCE at module init (contract §6 flag semantics); tests may override. */
let snapshotStatusMode: SnapshotStatusMode = readModeFromEnv()

export function getSnapshotStatusMode(): SnapshotStatusMode {
  return snapshotStatusMode
}

/** Test escape hatch. Pass null to re-derive from the environment. */
export function setSnapshotModeForTests(mode: SnapshotStatusMode | null): void {
  snapshotStatusMode = mode ?? readModeFromEnv()
}

/** Shared cap for every per-session registry in the snapshot layer. */
export const SNAPSHOT_REGISTRY_CAP = 10_000

/**
 * The ONE cap-evict implementation for the snapshot layer's per-session maps
 * (this module's registries + session-snapshot-apply's divergence rate-limiter).
 * Insertion-ordered eviction: re-setting an existing key keeps its position, so
 * the oldest FIRST-SEEN sid is dropped when the cap is reached.
 */
export function putBoundedEntry<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  if (map.size >= cap && !map.has(key)) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

// ── Snapshot registry: coverage AND the applied-v watermark, in ONE map ───────
// Sids for which a snapshot has been applied (or shadow-observed) THIS process
// lifetime → the highest `snapshot.v` seen for that sid. Two facts, one entry:
//
//   coverage  = map.has(sid)   — only covered sessions have their legacy
//               category-① status writers suppressed in enforce mode. Uncovered
//               sessions (old daemon without snapshot-v1, pre-spawn records)
//               always keep the legacy writers. This IS the version-skew
//               fallback (contract §5 "snapshot-covered").
//   appliedV  = map.get(sid)   — the in-memory ordering gate: a snapshot older
//               than what we already consumed is dropped (contract §5 step 1).
//
// They were two parallel structures (a Set here + a Map in the apply module)
// with duplicated cap-evict boilerplate, and the apply module's "first sight"
// seed bypassed the evicting setter entirely, so the cap could never fire
// (unbounded growth). One registry, one entry point, one cap.
const snapshotRegistry = new Map<string, number>()

/**
 * Mark a sid snapshot-covered and (optionally) advance its applied-v watermark.
 * Monotonic: `v` never moves backwards. Called for EVERY coverage event
 * including the first-sight seed, so the cap always applies.
 */
export function markSnapshotCovered(sessionId: string, v?: number): void {
  const prev = snapshotRegistry.get(sessionId)
  const hasV = typeof v === 'number' && Number.isFinite(v)
  const next = hasV
    ? (prev === undefined ? (v as number) : Math.max(prev, v as number))
    : (prev ?? 0)
  putBoundedEntry(snapshotRegistry, sessionId, next, SNAPSHOT_REGISTRY_CAP)
}

export function isSnapshotCovered(sessionId: string): boolean {
  return snapshotRegistry.has(sessionId)
}

/** Highest snapshot.v applied/observed for a sid, or undefined on first sight. */
export function getAppliedV(sessionId: string): number | undefined {
  return snapshotRegistry.get(sessionId)
}

/** Registry size — bounded-growth assertions. */
export function _snapshotRegistrySizeForTests(): number {
  return snapshotRegistry.size
}

/**
 * Drop a sid's coverage — the CAPABILITY-DOWNGRADE escape hatch.
 *
 * Coverage is a promise that "a snapshot will keep this record honest". When a
 * daemon is redeployed/rolled back to a build that no longer advertises
 * `snapshot-v1`, that promise is broken: no snapshot will ever arrive again, yet
 * the sid stays covered, so in enforce mode the gate keeps stripping the legacy
 * category-① writers that are now the ONLY writers left. The record freezes at
 * whatever status it last held (status-bricked).
 *
 * Callers that discover a session's transport no longer speaks snapshot-v1 MUST
 * unmark it BEFORE falling back to legacy record patching (see
 * DaemonConnection.recoverDisconnectedSessions). Re-marking is automatic — the
 * next applySnapshot for that sid marks it covered again.
 */
export function unmarkSnapshotCovered(sessionId: string): void {
  snapshotRegistry.delete(sessionId)
  suppressedStatusWrites.delete(sessionId)
  // Coverage is gone, so the legacy writer will land its own reason from now on —
  // a stashed diagnosis has no consumer and would only leak.
  suppressedErrorReasons.delete(sessionId)
}

/** Registry-only reset (coverage + watermarks + suppression counters). Keeps
 *  the mode flag as the test set it — a walnut restart loses memory, not env. */
export function _clearSnapshotRegistryForTests(): void {
  snapshotRegistry.clear()
  suppressedStatusWrites.clear()
  suppressedErrorReasons.clear()
}

export function _resetSnapshotGateForTests(): void {
  _clearSnapshotRegistryForTests()
  snapshotStatusMode = readModeFromEnv()
}

// ── Suppressed-write counters (log-churn control) ─────────────────────────────
// A suppressed writer does not stop trying: the health monitor re-fires the same
// gated write every 30s for as long as the divergence persists. Logging it at
// info each time buried the log. Count per sid: info on the FIRST suppression,
// debug afterwards, always with the running count.
const suppressedStatusWrites = new Map<string, number>()

/** Record one suppression for a sid and return the new count (1 = first). */
export function noteSuppressedStatusWrite(sessionId: string): number {
  const next = (suppressedStatusWrites.get(sessionId) ?? 0) + 1
  putBoundedEntry(suppressedStatusWrites, sessionId, next, SNAPSHOT_REGISTRY_CAP)
  return next
}

export function getSuppressedStatusWriteCount(sessionId: string): number {
  return suppressedStatusWrites.get(sessionId) ?? 0
}

// ── Suppressed ERROR reason hand-off ─────────────────────────────────────────
// The gate drops a category-① error write WHOLE (all-or-nothing, see
// applyUpdateToSession). That writer is usually the only one that knows WHY the
// session died: the health monitor's ('health-monitor','remote_unreachable')
// pair carries the diagnosis, while the snapshot projection that wins carries
// no message and explicitly declines to invent one. Net effect before this
// hand-off: a bare red "Error" with `errorMessage: null` — unreadable for the
// human AND unrecoverable, because both recovery paths classified a message-less
// error as "a real user-visible error, don't auto-recover" (2026-08-22 incident
// inc-1787439819342: a host patch-reboot left 51 sessions permanently stuck).
//
// So the dropped write's diagnosis is stashed here and consumed by
// session-snapshot-apply the next time it projects 'error' for that sid. The
// STATUS verdict still belongs to the snapshot alone — only the explanation
// travels.
export interface SuppressedErrorReason {
  reason: string
  message?: string
  kind?: 'infra' | 'terminal'
  /** ms epoch — a stale diagnosis must not label a much later, unrelated error. */
  at: number
}

/** How long a stashed diagnosis stays valid. The health monitor re-fires its
 *  gated write every 30s while the divergence lasts, so anything older than a
 *  few minutes belongs to an outage the projection has already moved past. */
export const SUPPRESSED_REASON_TTL_MS = 10 * 60 * 1000

const suppressedErrorReasons = new Map<string, SuppressedErrorReason>()

/** Stash the diagnosis from a dropped category-① error write. Last one wins:
 *  the freshest gated attempt is the closest to the truth. */
export function noteSuppressedErrorReason(sessionId: string, entry: SuppressedErrorReason): void {
  putBoundedEntry(suppressedErrorReasons, sessionId, entry, SNAPSHOT_REGISTRY_CAP)
}

/**
 * Consume a stashed diagnosis (single use — it explains ONE transition).
 * Returns null when absent or older than the TTL.
 */
export function takeSuppressedErrorReason(sessionId: string, now = Date.now()): SuppressedErrorReason | null {
  const entry = suppressedErrorReasons.get(sessionId)
  if (!entry) return null
  suppressedErrorReasons.delete(sessionId)
  if (now - entry.at > SUPPRESSED_REASON_TTL_MS) return null
  return entry
}

/** Drop a sid's stashed diagnosis without consuming it — called when the record
 *  converges to a NON-error status, so an old outage can't label a future one. */
export function clearSuppressedErrorReason(sessionId: string): void {
  suppressedErrorReasons.delete(sessionId)
}

/** Stash size — bounded-growth assertions. */
export function _suppressedReasonSizeForTests(): number {
  return suppressedErrorReasons.size
}

// ── Category-① legacy writer table ──────────────────────────────────────────
// Exact (status_changed_by, status_reason) pairs whose process_status writes
// are stream-event-driven duplicates of what the snapshot projection derives
// authoritatively. In enforce mode, for snapshot-covered sessions, these are
// stripped at the applyUpdateToSession choke point.
//
// Category-② (NEVER gated — user intent, spawn seeds, migrations, on-stop
// hook): 'awaiting_spawn', ('user','user_stopped'), ('user','user_terminated'),
// ('user','retry_reconnect'), ('user','restart_reinitialize').
// DELIBERATE OMISSION: ('session-runner','message_sent') appears in BOTH the
// category-① inventory (state-changed persist) and category-② (handleSend /
// FIFO-write turn-start persist) with the same pair. The contract's tiebreak is
// explicit: default to PASS-THROUGH when unsure — a duplicate legit write is
// harmless; a blocked legit write is not. So it is NOT in this table.
export const LEGACY_GATED_STATUS_PAIRS: ReadonlyArray<readonly [changedBy: string, reason: string]> = [
  ['session-runner', 'turn_completed'],
  ['session-runner', 'normal_completion'],
  ['health-monitor', 'normal_completion'],
  ['system', 'daemon_reported_exit'],
  ['daemon', 'daemon_reported_exit'],
  ['health-monitor', 'liveness_check_failed'],
  ['system', 'liveness_check_failed'],
  ['health-monitor', 'remote_unreachable'],
  ['health-monitor', 'process_exited_no_result'],
  ['health-monitor', 'idle_timeout'],
  ['health-monitor', 'auto_recovered'],
  ['health-monitor', 'auto_recovered_dead'],
  ['daemon', 'daemon_reconnected'],
  ['reconciler', 'reconciled_authoritative'],
  ['system', 'streaming_evidence_self_heal'],
  ['reconciler', 'server_restart'],
  ['system', 'idle_eviction'],
  ['health-monitor', 'orphan_no_pid'],
] as const

const GATED_PAIR_KEYS = new Set(LEGACY_GATED_STATUS_PAIRS.map(([by, reason]) => `${by} ${reason}`))

/**
 * True when a process_status write carries a category-① (changed_by, reason)
 * pair. Anything untyped/unknown returns false — PASS-THROUGH when unsure.
 */
export function isLegacyGatedStatusWrite(changedBy: unknown, reason: unknown): boolean {
  if (typeof changedBy !== 'string' || typeof reason !== 'string') return false
  return GATED_PAIR_KEYS.has(`${changedBy} ${reason}`)
}

/**
 * True when a process_status write carries NO writer identity at all — neither
 * `status_changed_by` nor `status_reason`.
 *
 * This shape is the session runner's stream projector (ClaudeCodeSession's
 * emitStatusChanged and its spawn/turn-start record persists): it pushes
 * `this._processStatus` — derived from the SAME lossy event stream the snapshot
 * replaces — with no reason and no changed_by, and it is by far the
 * highest-volume status writer in the system. Matching it by pair was
 * impossible (it has no pair), so 'sole writer' was unenforced for the one
 * writer that mattered most (C30).
 *
 * Genuine user/system/reconciler/daemon writers all stamp identity (verified by
 * a repo-wide survey of updateSessionRecord* callers that touch
 * process_status), so "un-stamped" is a reliable signature. The two other
 * un-stamped native writers found by that survey are the runner's own
 * resume/turn-start persists, which carry pid/host/outputFile alongside the
 * status — which is why the tracker strips ONLY the status labeling for this
 * shape instead of dropping the whole patch (see applyUpdateToSession).
 * The remaining un-stamped writers live on provider 'sdk' / 'embedded'
 * sessions, which applySnapshot excludes outright, so they never become
 * covered and never reach this gate.
 */
export function isUnstampedStatusWrite(changedBy: unknown, reason: unknown): boolean {
  return (changedBy === undefined || changedBy === null)
    && (reason === undefined || reason === null)
}
