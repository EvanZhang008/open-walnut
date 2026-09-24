/**
 * session-snapshot-apply — the C2 walnut projection layer
 * (docs/plan/session-snapshot-source-of-truth.md §5).
 *
 * The daemon folds each session's stream file into an authoritative
 * SessionSnapshot (C1) and delivers it by push (on change) + pull (30s tick,
 * reconnect). This module is the SINGLE reducer from snapshot → session record:
 * a pure projection function plus an idempotent, v-gated apply.
 *
 * Modes (WALNUT_SNAPSHOT_STATUS, read once at init via session-snapshot-gate):
 *   off     — nothing runs.
 *   shadow  — projections computed, divergences logged, records untouched.
 *   enforce — applySnapshot is the sole writer for daemon-backed native
 *             sessions; legacy category-① writers are stripped at the
 *             session-tracker choke point (see session-snapshot-gate.ts).
 *
 * Intake gates (RSM push handler / health-monitor pull / reconnect pull) only
 * feed sessions whose host advertises 'snapshot-v1' — uncovered sessions keep
 * the legacy writers, which IS the version-skew fallback.
 *
 * TWO ordering coordinates, deliberately different granularity:
 *   appliedV       (in-memory, session-snapshot-gate registry) — highest v seen
 *                  this PROCESS lifetime. Advances on every accepted snapshot,
 *                  including mid-turn 'running' ones. The fine-grained gate.
 *   consumedOffset (durable, on the record) — a TURN-END byte position only.
 *                  Adopted exclusively from settled/dead snapshots (see
 *                  `adoptWatermark` below). The coarse, restart-surviving floor.
 */

import { isWakeupArmed, type SessionSnapshot } from '../providers/daemon-fold.js'
import type { ProcessStatus, SessionRecord } from './types.js'
import { log } from '../logging/index.js'
import { bus, EventNames } from './event-bus.js'
import {
  getSnapshotStatusMode,
  markSnapshotCovered,
  unmarkSnapshotCovered,
  getAppliedV,
  putBoundedEntry,
  SNAPSHOT_REGISTRY_CAP,
  takeSuppressedErrorReason,
  clearSuppressedErrorReason,
  _clearSnapshotRegistryForTests,
} from './session-snapshot-gate.js'
import { assertsHostUnreachable } from './session-error-kind.js'
import { engineCaps } from './agents/engine-registry.js'

// Re-export the gate surface so consumers can treat this module as the C2
// entry point (the gate stays import-free for session-tracker's sake).
export {
  getSnapshotStatusMode,
  setSnapshotModeForTests,
  markSnapshotCovered,
  isSnapshotCovered,
  getAppliedV,
  getSuppressedStatusWriteCount,
  isLegacyGatedStatusWrite,
  isUnstampedStatusWrite,
  LEGACY_GATED_STATUS_PAIRS,
  _resetSnapshotGateForTests,
  _snapshotRegistrySizeForTests,
  type SnapshotStatusMode,
} from './session-snapshot-gate.js'

export interface ApplyOutcome {
  outcome: 'disabled' | 'no-record' | 'excluded' | 'stale' | 'noop' | 'shadow' | 'applied' | 'skipped' | 'error'
  /** shadow mode: projection !== record.process_status */
  diverged?: boolean
  projected?: ProcessStatus
  reason?: string
}

/**
 * Pure projection: SessionSnapshot → the 4-value frozen ProcessStatus enum.
 * Contract §5 order — dead first, waiting/turnActive map to running ('waiting'
 * stays display-layer), a trailing error result surfaces as 'error', else idle.
 */
export function projectProcessStatus(s: SessionSnapshot): ProcessStatus {
  if (s.cliState === 'dead') {
    return s.lastResult?.isError || (s.exitCode ?? 0) !== 0 ? 'error' : 'stopped'
  }
  if (s.cliState === 'waiting') return 'running' // paused mid-turn on a prompt
  if (s.turnActive) return 'running'
  // A detached (run_in_background) task is real work in flight even though the
  // CLI's turn ended around it — the session IS running (user decision
  // 2026-08-28, inc-1787893885321: an idle badge over a live 40-min STT bench).
  // Checked before the error branch: an errored turn whose background command
  // keeps working is still working; the error re-surfaces at drain. Absent
  // field (pre-field daemon) = 0 = old behavior.
  if ((s.detachedBgCount ?? 0) > 0) return 'running'
  if (s.lastResult?.isError) return 'error' // matches reconcileProcessStatus target semantics
  return 'idle'
}

const TERMINAL: ReadonlySet<ProcessStatus> = new Set<ProcessStatus>(['stopped', 'error'])

/**
 * True when the snapshot's status evidence does NOT come from stream bytes:
 * process liveness (`dead`) and an intercepted permission control request
 * (`waiting`) both reach the daemon out-of-band and can therefore be genuinely
 * NEW information at an unchanged `v`. Everything else is derived purely from
 * folded lines, so "same v" means "same evidence".
 */
function isOutOfBandEvidence(s: SessionSnapshot): boolean {
  return s.cliState === 'dead' || s.cliState === 'waiting'
}

/**
 * True when this snapshot may advance the record's durable `consumedOffset`.
 *
 * `consumedOffset` is contractually a TURN-END byte position (see
 * ClaudeCodeSession._advanceConsumedOffset): `foldSessionTail` synthesizes its
 * whale-turn anchor AT that offset, and the live/replay guards treat
 * `v <= consumedOffset` as "already fully processed". Adopting a MID-TURN
 * running snapshot's v would plant the synthetic anchor inside an open turn and
 * make the next real result look like a replay (C15). So the watermark moves for
 * exactly two shapes:
 *   - a DEAD process: nothing can append to the stream any more, so wherever the
 *     fold stopped IS the end (this holds even with turnActive true — killed
 *     mid-turn);
 *   - a SETTLED fold: result + trailing idle + no gating work.
 * Everything else — running, and notably `waiting` — writes `process_status`
 * alone and relies on the in-memory appliedV watermark for ordering within the
 * process lifetime. `waiting` is excluded even when `turnActive` is false: that
 * combination is the post-settle permission race (a FIFO-delivered message
 * starts a turn whose first stream line is not written yet, and its first tool
 * asks for permission), i.e. a turn that is very much still coming — adopting
 * its v would suppress that turn's real result as a replay.
 */
function adoptsWatermark(s: SessionSnapshot): boolean {
  if (s.cliState === 'dead') return true
  if (s.cliState === 'waiting') return false
  return s.turnActive === false
}

/** Test isolation for the per-session v watermarks + divergence rate limiter. */
export function _resetSnapshotApplyForTests(): void {
  divergenceState.clear()
  divergenceWarnTotal = 0
  divergenceSeenTotal = 0
  // The v watermarks live in the gate registry (ONE bounded map for coverage +
  // appliedV); clearing it is what "walnut restarted" means for this layer.
  _clearSnapshotRegistryForTests()
}

/** Hard exclusions per contract §5 step 4 — these session classes are C3+. */
function isExcluded(record: SessionRecord): string | null {
  // Engine-shaped exclusion, not a vendor one: ACP engines project state from
  // the journal, so there is no snapshot to pull.
  if (!engineCaps(record.engine).snapshotPull) return 'engine-no-snapshot-pull'
  if (record.provider === 'embedded' || record.provider === 'sdk') return `provider-${record.provider}`
  if (record.status_reason === 'awaiting_spawn') return 'awaiting-spawn'
  return null
}

// ── shadow divergence log rate limiting (C28) ────────────────────────────────
// A persistent divergence is re-observed on EVERY push AND every 30s pull, and
// the whole point of shadow mode is to run for days. Unrate-limited that is a
// log storm (and the storm hides the interesting transitions). Per sid: warn on
// the FIRST sighting and on every change of the (projected, actual) pair, then
// at most once per 10 minutes carrying the accumulated count.
const DIVERGENCE_WARN_INTERVAL_MS = 10 * 60 * 1000
interface DivergenceState { pair: string; lastWarnAt: number; sinceLastWarn: number; total: number }
const divergenceState = new Map<string, DivergenceState>()
let divergenceWarnTotal = 0
let divergenceSeenTotal = 0

/** Divergence counters — exported so tests can assert the rate limiter counts
 *  everything it suppresses (`seen` grows while `warned` does not). */
export function getDivergenceCounters(): { seen: number; warned: number } {
  return { seen: divergenceSeenTotal, warned: divergenceWarnTotal }
}

/**
 * Decide whether this divergence sighting should be logged, and with what
 * accumulated count. Always counts.
 */
function shouldWarnDivergence(
  sessionId: string,
  pair: string,
  now: number,
): { warn: boolean; count: number; suppressed: number } {
  divergenceSeenTotal++
  const prev = divergenceState.get(sessionId)
  if (!prev || prev.pair !== pair) {
    const next: DivergenceState = { pair, lastWarnAt: now, sinceLastWarn: 0, total: (prev?.total ?? 0) + 1 }
    putBoundedEntry(divergenceState, sessionId, next, SNAPSHOT_REGISTRY_CAP)
    divergenceWarnTotal++
    return { warn: true, count: next.total, suppressed: 0 }
  }
  prev.total++
  if (now - prev.lastWarnAt >= DIVERGENCE_WARN_INTERVAL_MS) {
    const suppressed = prev.sinceLastWarn
    prev.lastWarnAt = now
    prev.sinceLastWarn = 0
    divergenceWarnTotal++
    return { warn: true, count: prev.total, suppressed }
  }
  prev.sinceLastWarn++
  return { warn: false, count: prev.total, suppressed: prev.sinceLastWarn }
}

export function settledPhaseCutoff(record: SessionRecord): string {
  let cutoff = record.last_status_change ?? ''
  for (const entry of record.status_history ?? []) {
    if (entry.process_status === 'running') break
    if (Date.parse(entry.timestamp) < Date.parse(cutoff)) cutoff = entry.timestamp
  }
  return cutoff
}

export async function captureSnapshotReadGuard(sessionId: string): Promise<(current: Readonly<SessionRecord>) => boolean> {
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  const { sessionRunner } = await import('../providers/claude-code-session.js')
  const record = await getSessionByClaudeId(sessionId)
  const revision = record?.statusRevision
  const epoch = record?.streamEpoch
  const live = sessionRunner.findSessionByClaudeId(sessionId)
  const turn = live?.turnGen
  return (current) => !!record && !current.archived
    && current.statusRevision === revision
    && current.streamEpoch === epoch
    && sessionRunner.findSessionByClaudeId(sessionId) === live
    && live?.turnGen === turn
}

export async function applySnapshot(
  sessionId: string,
  snapshot: SessionSnapshot,
  source: string,
  canRecoverConnection?: (current: Readonly<SessionRecord>) => boolean,
): Promise<ApplyOutcome> {
  // Stream offsets cannot order every state change; see docs/decision/task-session-status.md.
  const mode = getSnapshotStatusMode()
  if (mode === 'off') return { outcome: 'disabled' }
  if (!snapshot || typeof snapshot.v !== 'number' || !Number.isFinite(snapshot.v)) {
    return { outcome: 'error', reason: 'malformed-snapshot' }
  }

  const {
    getSessionByClaudeId,
    updateSessionRecordConditionally,
    emitSessionStatusChanged,
  } = await import('./session-tracker.js')

  const { sessionRunner } = await import('../providers/claude-code-session.js')
  const observedLive = sessionRunner.findSessionByClaudeId(sessionId)
  const observedTurn = observedLive?.turnGen
  const sameTurn = () => {
    const live = sessionRunner.findSessionByClaudeId(sessionId)
    return live === observedLive && live?.turnGen === observedTurn
  }
  const record = await getSessionByClaudeId(sessionId)
  if (!record) return { outcome: 'no-record' }

  const excluded = isExcluded(record)
  if (excluded) return { outcome: 'excluded', reason: excluded }

  const projected = projectProcessStatus(snapshot)
  const actual = record.process_status

  // ── Stream-file epoch: detect "the file was recreated" ────────────────────
  // v is a byte offset INTO ONE FILE INCARNATION. When the file is recreated
  // (reboot wiped /tmp, fresh same-sid spawn), offsets restart at 0 while the
  // record still holds the previous incarnation's watermark — without this, the
  // v-gate below silently vetoes EVERY snapshot of the new file forever
  // (incident 019a7fe5: 85 MB stale watermark vs a 16 MB successor file; the
  // record showed Running for a CLI that had been idle for a day, and not one
  // divergence line was logged because the drop happened before the compare).
  // A changed epoch invalidates BOTH coordinates: the in-memory appliedV and
  // the durable consumedOffset. The reset is epoch-gated in the tracker's
  // arbitration (see applyUpdateToSession), so this is the sanctioned path.
  const bothEpochsDiffer = typeof snapshot.streamEpoch === 'string' && snapshot.streamEpoch.length > 0
    && typeof record.streamEpoch === 'string' && record.streamEpoch.length > 0
    && snapshot.streamEpoch !== record.streamEpoch
  // EPOCH-LESS RECORD + PROVABLY-STALE WATERMARK (incident 267a4b68): records
  // that predate epoch stamping have streamEpoch NULL, so the two-sided compare
  // above can never fire — and stamping only happens on an enforce WRITE, which
  // the v-gate below blocks because the stale watermark IS the gate. Chicken
  // and egg: such a record is permanently immune to the snapshot channel while
  // its live guards suppress every real result ("finished but still Running").
  // The proof staleness needs no epoch pair: a settled/dead snapshot's v is the
  // fold's EOF position, and a consumed line-end offset can never exceed the
  // EOF of the append-only file it was measured in (same argument as
  // isStaleWatermark / the spawn-path guard). `waiting` is excluded for the
  // same reason adoptsWatermark excludes it (v may predate an opening turn).
  const settledOrDead = snapshot.cliState === 'dead'
    || (snapshot.cliState !== 'waiting' && snapshot.turnActive === false)
  const epochlessStaleWatermark = !bothEpochsDiffer
    && typeof snapshot.streamEpoch === 'string' && snapshot.streamEpoch.length > 0
    && !record.streamEpoch
    && typeof record.consumedOffset === 'number'
    && settledOrDead && record.consumedOffset > snapshot.v
  const epochChanged = bothEpochsDiffer || epochlessStaleWatermark
  if (epochChanged) {
    log.session.warn('snapshot stream-epoch changed — resetting watermarks', {
      sessionId, prevEpoch: record.streamEpoch, nextEpoch: snapshot.streamEpoch,
      staleConsumedOffset: record.consumedOffset ?? null, snapshotV: snapshot.v,
      mode, source,
    })
    // In-memory gate: forget the old incarnation's appliedV in every mode —
    // shadow's divergence compare below must not be starved by a dead file's
    // coordinates. Coverage re-marks right after via markSnapshotCovered.
    unmarkSnapshotCovered(sessionId)
  }
  // First sight of an epoch (record has none yet): stamp it. Harmless in
  // shadow? No — stamping requires a record write, which shadow must not do.
  // So epoch stamping happens only on enforce-mode writes below; shadow relies
  // on the in-memory reset above within each process lifetime.

  // ── Terminal INTENT outranks snapshot labeling (C4) ───────────────────────
  // The user clicked Stop: walnut records ('user','user_stopped','stopped') and
  // kills the CLI. The reap produces a death snapshot whose v is BEYOND the
  // record's watermark and whose exitCode is non-zero (no clean result line), so
  // a v-only gate lets it through and the record flips 'stopped' → 'error' — the
  // user is shown a failure for an action they deliberately took.
  //
  // Rule: when the record's terminal state was written BY THE USER, a snapshot
  // that ALSO projects terminal ({stopped, error}) carries no decision, only a
  // label — the user's label wins, regardless of v. Only a projection that
  // contradicts the terminal verdict (running/idle, i.e. "the stop did not
  // take") may supersede it, and only with evidence beyond the watermark.
  //
  // Teardowns WALNUT requested are the same shape with a different author:
  // completing a task SIGINTs its sessions after stamping
  // ('system','expected_teardown','stopped'). The kill can land mid-turn (a
  // session that completes its OWN task dies while its tool call is still
  // running), so the death snapshot has no clean result tail and projects
  // 'error' — and the record flipped stopped → red Error for a session that
  // did exactly what it was told (2026-08-23, compare-task session). Same
  // rule: an intentional terminal label is a decision; the corpse's label is
  // not.
  const intentionalTerminal = record.status_changed_by === 'user'
    || (record.status_changed_by === 'system' && record.status_reason === 'expected_teardown')
  if (intentionalTerminal && TERMINAL.has(actual)) {
    if (TERMINAL.has(projected)) {
      return { outcome: 'skipped', reason: 'user-terminal-intent' }
    }
    // The beyond-watermark requirement only makes sense within one incarnation;
    // a new file's evidence is all "beyond" the dead file's watermark.
    if (!epochChanged && snapshot.v <= (record.consumedOffset ?? 0)) {
      return { outcome: 'skipped', reason: 'user-terminal-intent' }
    }
  }

  // ── v-gate (in-memory appliedV, floored by the durable watermark) ─────────
  // The durable turn-END watermark is ALWAYS a valid floor (it can even lead
  // appliedV: the runner's own _advanceConsumedOffset writes it without a
  // status, so that patch is never gated), and on first sight this process
  // lifetime it is the only floor we have. Deliberately NOT written back on a
  // stale drop — a stale snapshot is not evidence, so it must not grant
  // coverage either (coverage and appliedV are the same registry entry now; see
  // session-snapshot-gate.ts).
  // EPOCH EXCEPTION: a changed epoch means both floors are coordinates in a
  // DEAD file — comparing the new file's v against them is meaningless, so the
  // gate collapses to 0 (appliedV was already cleared above).
  const gate = epochChanged ? 0 : Math.max(
    getAppliedV(sessionId) ?? 0,
    typeof record.consumedOffset === 'number' ? record.consumedOffset : 0,
  )
  if (snapshot.v < gate) return { outcome: 'stale' }

  const connectionError = (current: Readonly<SessionRecord>) => current.process_status === 'error'
    && current.status_reason === 'remote_unreachable' && current.errorKind !== 'terminal'
    && current.status_changed_by !== 'user' && current.status_changed_by !== 'snapshot'
  if (connectionError(record) && canRecoverConnection && !canRecoverConnection(record)) {
    return { outcome: 'skipped', reason: 'connection-read-superseded', projected }
  }
  const recoveringConnection = connectionError(record) && canRecoverConnection?.(record) === true
  const duplicate = snapshot.v === gate && projected === actual && !recoveringConnection

  // From here the snapshot is live evidence for this session: it is covered.
  markSnapshotCovered(sessionId, snapshot.v)

  if (mode === 'shadow') {
    if (duplicate) return { outcome: 'noop', projected }
    const diverged = projected !== actual
    if (diverged) {
      const { warn, count, suppressed } = shouldWarnDivergence(
        sessionId, `${projected}<-${actual}`, Date.now(),
      )
      if (warn) {
        log.session.warn('snapshot-shadow divergence', {
          sessionId,
          projected,
          actual,
          v: snapshot.v,
          consumedOffset: record.consumedOffset ?? null,
          snapshotCliState: snapshot.cliState,
          turnActive: snapshot.turnActive,
          statusReason: record.status_reason ?? null,
          changedBy: record.status_changed_by ?? null,
          source,
          divergenceCount: count,
          ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}),
        })
      }
    }
    return { outcome: 'shadow', diverged, projected }
  }

  let reconnectActivityCleared = false
  if (!recoveringConnection && record.activity === 'Reconnecting to remote host...') {
    const cleared = await updateSessionRecordConditionally(sessionId, { activity: undefined }, (current) =>
      !current.archived && current.statusRevision === record.statusRevision
      && current.streamEpoch === record.streamEpoch
      && current.activity === record.activity
      && getAppliedV(sessionId) === snapshot.v,
    { preserveLastActiveAt: true })
    if (cleared) {
      reconnectActivityCleared = true
      emitSessionStatusChanged(cleared, {}, ['*'], { source: `snapshot:${source}`, urgency: 'urgent' })
    }
  }

  const settledTurn = ((projected === 'idle' && snapshot.cliState === 'idle' && !snapshot.lastResult?.isError)
    || (TERMINAL.has(projected) && snapshot.cliState === 'dead'))
    && !snapshot.turnActive && !!snapshot.lastResult
    && !snapshot.pendingPermission && snapshot.gatingBgCount === 0
    && (snapshot.detachedBgCount ?? 0) === 0 && !snapshot.teamActive
    && !isWakeupArmed(snapshot.wakeupAt)
  const handbackTask = settledTurn && record.taskId
    ? await import('./task-manager.js').then(({ getTask }) => getTask(record.taskId!)).catch(() => null)
    : null
  let handbackCutoff = new Date().toISOString()
  // 空闲后的进程回收不是新回合，不能覆盖空闲后的人为阶段选择。
  if (!epochChanged && (actual === 'idle' || TERMINAL.has(actual))) {
    handbackCutoff = settledPhaseCutoff(record)
  }
  const reconcileSettledPhase = async (settled: SessionRecord): Promise<void> => {
    const phaseAt = handbackTask?.phase_changed_at ?? handbackTask?.updated_at
    if (!handbackTask || handbackTask.phase !== 'IN_PROGRESS' || !handbackCutoff || !phaseAt
      || !Number.isFinite(Date.parse(phaseAt)) || !Number.isFinite(Date.parse(handbackCutoff))
      || Date.parse(phaseAt) > Date.parse(handbackCutoff)
      || settled.process_status !== projected || settled.status_reason !== 'snapshot_projection'
      || settled.pendingPermission || settled.stopRequest || settled.consumedOffset !== snapshot.v
      || (duplicate && canRecoverConnection && !canRecoverConnection(settled))) return
    const { withUndeliveredMessageGuard } = await import('./session-message-queue.js')
    const { getSessionsForTaskSync } = await import('./session-tracker.js')
    const { handBackTaskOnSessionEnd } = await import('./phase.js')
    try {
      await withUndeliveredMessageGuard(async (hasUndelivered) => {
        await handBackTaskOnSessionEnd(handbackTask.id, sessionId, `snapshot-apply:${source}`, {
          shouldApply: (current) => {
            const latest = getSessionsForTaskSync(handbackTask.id).find(member => member.claudeSessionId === sessionId)
            return !!latest && sameTurn() && getAppliedV(sessionId) === snapshot.v
              && latest.statusRevision === settled.statusRevision
              && latest.streamEpoch === settled.streamEpoch && latest.process_status === projected
              && (!duplicate || !canRecoverConnection || canRecoverConnection(latest))
              && latest.consumedOffset === snapshot.v
              && !latest.pendingPermission && !latest.stopRequest
              && !getSessionsForTaskSync(handbackTask.id).some(member =>
                !member.archived && hasUndelivered(member.claudeSessionId))
              && current.phase === handbackTask.phase
              && (current.phase_changed_at ?? current.updated_at) === phaseAt
          },
        })
      })
    } catch (error) {
      log.session.warn('snapshot settled task handback failed', {
        sessionId, taskId: handbackTask.id, error: String(error),
      })
    }
  }

  if (duplicate) {
    await reconcileSettledPhase(record)
    return { outcome: reconnectActivityCleared ? 'applied' : 'noop', projected }
  }

  // ── Turn-start phase pullback on snapshot evidence (inc-1787512825254) ──
  // The CLI emits NO session_state_changed{running} for self-woken turns (a
  // background task-notification dequeued from its internal queue starts a
  // real turn with no external send), so neither event-lane turn-start edge
  // (state-running / init-after-result) fires and the task stays on the
  // previous turn's NEED_ACTION while the CLI is visibly working. The fold
  // DOES see the new turn's bytes — this projection is the very evidence that
  // paints the green Running dot, so it must pull the phase back too, or the
  // UI ships "Running session + red handed-back row". Runs on every live
  // running projection (not just applied writes) so a boot-adopted running
  // record with a stale red phase also heals; applySessionPhase no-ops on
  // IN_PROGRESS and never overwrites terminal phases. 'waiting' / pending
  // permission are excluded: paused-on-a-prompt projects 'running' as well,
  // but that red row is the awaiting-human feature working as designed.
  if (projected === 'running' && snapshot.cliState !== 'waiting'
    && !snapshot.pendingPermission && !record.pendingPermission && record.taskId) {
    const pullbackTaskId = record.taskId
    import('./phase.js').then(({ applySessionPhase }) =>
      applySessionPhase(pullbackTaskId, 'session:turn-start', `snapshot-apply:${source}`, {
        sessionId,
      }),
    ).catch((err) => {
      log.session.warn('snapshot turn-start phase pullback failed', {
        sessionId, taskId: pullbackTaskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // ── enforce ──
  const adoptWatermark = adoptsWatermark(snapshot)
  const outOfBand = isOutOfBandEvidence(snapshot)
  const now = new Date().toISOString()
  const updates: Record<string, unknown> = {
    process_status: projected,
    last_status_change: now,
    status_reason: 'snapshot_projection',
    status_changed_by: 'snapshot',
  }
  if (recoveringConnection && record.activity === 'Reconnecting to remote host...') updates.activity = undefined
  // Turn-END watermark only (C15) — a mid-turn 'running' projection writes the
  // status WITHOUT touching consumedOffset.
  if (adoptWatermark) updates.consumedOffset = snapshot.v
  // Stamp/refresh the file identity alongside anything that references its
  // coordinate space. On an epoch CHANGE the watermark must move to the new
  // file even mid-turn (v=0 floor beats a dead file's 85 MB watermark): the
  // tracker's arbitration accepts the pair (streamEpoch change + offset) as
  // the sanctioned reset. First-sight stamping rides adoptWatermark writes.
  if (typeof snapshot.streamEpoch === 'string' && snapshot.streamEpoch.length > 0
    && (epochChanged || adoptWatermark || !record.streamEpoch)) {
    updates.streamEpoch = snapshot.streamEpoch
    if (epochChanged && !adoptWatermark) updates.consumedOffset = 0
  }
  // Clear stale error text on any non-error convergence; on 'error' adopt the
  // diagnosis from the legacy writer the gate just dropped (the snapshot itself
  // has no text to offer, and it is not allowed to invent one).
  //
  // Without this hand-off the record lands `errorMessage: null`, which the UI
  // renders as a bare red "Error" and which BOTH recovery paths read as
  // "unexplained user-visible error → leave it alone" — the session then never
  // comes back, even after the host does (inc-1787439819342, 51 sessions).
  if (projected !== 'error') {
    // Stale text always goes: whatever was there described an older episode.
    updates.errorMessage = undefined
    updates.errorKind = undefined
    // But a TERMINAL projection still deserves a cause. The writer that knew
    // why — the idle reaper's ('health-monitor','idle_timeout') + "No output for
    // N min" — is category-① and was dropped whole, so its explanation is only
    // in the stash. Adopting it is what makes the calm "Auto-stopped after N min
    // idle" banner possible; without it a routine reclamation rendered as a
    // cause-less stop (and, once the exit code was also mis-read, as a red
    // "Session ended unexpectedly"). A LIVE projection deliberately adopts
    // nothing: the session is running, so any explanation is by definition past.
    const stashedStop = projected === 'stopped' ? takeSuppressedErrorReason(sessionId) : null
    if (stashedStop?.message) {
      updates.errorMessage = stashedStop.message
      // Keep the kind too: 'idle_timeout' classifies TERMINAL, which is exactly
      // what stops the re-examination lane from re-probing a settled stop.
      if (stashedStop.kind) updates.errorKind = stashedStop.kind
      log.session.info('snapshot projection adopted suppressed stop reason', {
        sessionId, suppressedReason: stashedStop.reason,
        kind: stashedStop.kind ?? null, projected, source,
      })
    } else {
      clearSuppressedErrorReason(sessionId)
    }
  } else {
    // This snapshot IS proof of contact with the host: the fold reached us over a
    // live daemon connection. So a diagnosis claiming that host is unreachable is
    // disproven, and must not ride along on the record just because the new
    // projection also happens to be 'error' (a crashed CLI on a healthy host).
    // Dropping it is the whole point — a confident wrong answer is worse than
    // none, and the UI already has a no-cause-recorded fallback. errorKind is
    // left alone: recoverability is a separate question from what to display.
    let droppedDisproven = false
    if (assertsHostUnreachable(record)) {
      updates.errorMessage = undefined
      droppedDisproven = true
      log.session.info('snapshot projection dropped disproven unreachability diagnosis', {
        sessionId, priorReason: record.status_reason ?? null, projected, source,
      })
    }
    const stashed = takeSuppressedErrorReason(sessionId)
    if (stashed && (!recoveringConnection || stashed.reason !== 'remote_unreachable')) {
      // Only fill a BLANK message — a real message already on the record came
      // from a writer with first-hand knowledge and outranks a stash. A message
      // just dropped above counts as blank: it was disproven, not merely old.
      // (`updates.errorMessage === undefined` cannot stand in for that check —
      // an absent key reads undefined too, which would let a stash overwrite a
      // perfectly good first-hand message.)
      if ((!record.errorMessage || droppedDisproven) && stashed.message) updates.errorMessage = stashed.message
      if (!record.errorKind && stashed.kind) updates.errorKind = stashed.kind
      log.session.info('snapshot projection adopted suppressed error reason', {
        sessionId,
        suppressedReason: stashed.reason,
        kind: stashed.kind ?? null,
        filledMessage: updates.errorMessage !== undefined,
      })
    }
  }

  const updated = await updateSessionRecordConditionally(
    sessionId,
    updates as Parameters<typeof updateSessionRecordConditionally>[1],
    (current) => {
      if (current.archived) return false
      if (recoveringConnection && (!connectionError(current) || !canRecoverConnection?.(current)
        || (getAppliedV(sessionId) ?? 0) > snapshot.v)) return false
      // Re-checked UNDER the tracker's write lock — the check-then-act above
      // spans awaits, so this is the only place the decision is atomic (C5).
      const currentOffset = typeof current.consumedOffset === 'number' ? current.consumedOffset : -1

      // EPOCH RESET: the stored offset is a dead file's coordinate — none of
      // the same-incarnation ordering rules below apply. Recheck the change
      // under the lock (a concurrent applier may have already stamped it).
      if (epochChanged) {
        return typeof current.streamEpoch !== 'string'
          || current.streamEpoch !== snapshot.streamEpoch
          || current.process_status !== projected
      }

      // (1) MONOTONICITY: refuse a snapshot that predates the durable turn-END
      // watermark. Without this the write predicate never REQUIRED v to move
      // forward, so a lower-v snapshot racing in could overwrite a newer
      // projection (the old predicate's `||` made a mere status difference
      // sufficient).
      if (currentOffset > snapshot.v) return false

      // (2) EQUAL-v TIEBREAKER: at an unchanged watermark there are no new
      // stream bytes, so a stream-derived projection carries no evidence the
      // record has not already consumed — refuse it (this is what stops a
      // same-v 'running' from resurrecting a dead record, and a replayed
      // settled snapshot from regressing a live one after a walnut restart).
      // Out-of-band evidence (process death / permission pause) is genuinely
      // new at the same v and passes.
      // 连接恢复不产生新流字节，但只有读取前后的身份未变时才能推翻连接错误。
      if (currentOffset === snapshot.v && !outOfBand && !recoveringConnection) return false

      // (3) Something must actually change (a first-sight epoch stamp counts).
      return recoveringConnection || current.process_status !== projected
        || (adoptWatermark && currentOffset < snapshot.v)
        || (typeof updates.streamEpoch === 'string' && current.streamEpoch !== updates.streamEpoch)
    },
  )
  if (!updated) return reconnectActivityCleared
    ? { outcome: 'applied', projected }
    : { outcome: 'skipped', reason: 'predicate-false', projected }

  emitSessionStatusChanged(updated, {}, ['*'], { source: `snapshot:${source}`, urgency: 'urgent' })
  log.session.info('snapshot projection applied', {
    sessionId, projected, previous: actual, v: snapshot.v,
    watermarkAdopted: adoptWatermark, source,
  })

  // The projection itself ended a turn (running → idle under the lock): the
  // live runner never reported this result, or it would have written idle
  // first and the predicate would have found nothing to change. Turn-end hooks
  // derive from session:result, so tell them separately; a session the server
  // reattaches later skips replay and would otherwise never self-report this
  // turn (session 145318ca, 2026-09-19: detached 02:13, settled 02:18, tip and
  // note stayed one turn behind).
  if (actual === 'running' && updated.process_status === 'idle') {
    bus.emit(EventNames.SESSION_TURN_SETTLED, {
      sessionId, ...(updated.taskId ? { taskId: updated.taskId } : {}), source, v: snapshot.v,
    }, ['*'], { source: `snapshot:${source}` })
  }

  // Sync the live runner's in-memory status so the next writeMessage bases its
  // mid-turn decision on the converged value (setProcessStatusFromReconciler
  // precedent — see session-health-monitor.reconcileStuckRunningSessions).
  try {
    const { sessionRunner } = await import('../providers/claude-code-session.js')
    const liveSession = sessionRunner.findSessionByClaudeId(sessionId)
    if (liveSession) {
      liveSession.setProcessStatusFromReconciler(projected)
      // Epoch reset: the live CCS's in-memory _consumedOffset is the SAME dead
      // coordinate the record held — and it is what the replay guards actually
      // read ("suppressing replayed result", incident 267a4b68: the record was
      // healed but the live instance kept swallowing real results until a
      // restart). This is the one sanctioned regression path, mirroring the
      // record-side epoch arbitration.
      if (epochChanged) {
        const resetTo = typeof updates.consumedOffset === 'number' ? updates.consumedOffset : 0
        liveSession.resetConsumedOffsetFromSnapshot(resetTo)
      }
    }
  } catch { /* runner not loaded — session is attach-only */ }

  await reconcileSettledPhase(updated)
  return { outcome: 'applied', projected }
}
