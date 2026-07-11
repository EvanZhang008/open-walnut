/**
 * Authoritative session-truth convergence — the horizontal reconcile channel.
 *
 * NOT the same as session-reconciler.ts (startup-only zombie sweep). This module
 * is the runtime convergence primitive: an idempotent function that compares a
 * session's recorded process_status AND its task's phase against the AUTHORITATIVE
 * source and force-converges both when the source proves the turn already ended.
 *
 * ── THE authoritative source is the daemon STREAM file, not the canonical JSONL ──
 * The CLI's turn-lifecycle events (`result`, `session_state_changed`, `task_*`)
 * are STDOUT stream-json output. They are captured ONLY into the daemon's stream
 * file (STREAMS_DIR/<sid>.jsonl); the canonical ~/.claude/projects JSONL contains
 * ZERO of them (verified across all four incidents + 10 live sessions). A v1 of
 * this module read the canonical JSONL via recoverStateFromJsonl() — its
 * workStatus was therefore ALWAYS undefined on real data and the convergence
 * never fired. Do not regress to a canonical-JSONL evidence source.
 *
 * ── The stream file is authoritative for turn ENDS, but BLIND to turn STARTS ──
 * The CLI never echoes stdin user messages to its stream-json stdout, so a turn
 * started by a plain-text FIFO send leaves NO anchor line. Two compensations,
 * both required (this module's SECOND incomplete-evidence incident — the first
 * was the canonical-JSONL regression above; inc-1783644415695 was this one:
 * the backward anchor scan landed on a PREVIOUS turn and force-converged a
 * working session to a day-old error, three times in one day):
 *   1. The daemon appends a walnut-injected marker line at every FIFO delivery
 *      (appendUserMarker RPC) — isRealUserLine ACCEPTS those as anchors.
 *   2. Positional veto for legacy/marker-less sessions: a result whose byte
 *      offset is ≤ record.consumedOffset was already consumed by the live path
 *      and belongs to a previous turn ('result-already-consumed'), and a fold
 *      that sees init / state:running AFTER a result discards that result
 *      (a new turn began — it cannot be the current turn's verdict).
 *
 * Why this exists (incident-driven — see plan session-process-status-reconcile.md):
 * every status write is one-directional and event-driven. Losing a single result
 * event (daemon tailer freeze — 6c8428ac; server restart landing in the result
 * window — ed81e36d), or swallowing a replayed real result behind a boolean guard
 * (10e7df54), wedges the record at 'running' or the task at IN_PROGRESS forever —
 * no path ever re-checks them against ground truth. This function is that path.
 *
 * R1 evidence rule (all must hold to converge; missing evidence = no-op, never
 * manufacture completion):
 *   real result after the last real user message  — turn provably terminated
 *   trailing idle after that result               — CLI settled (skipped for error results)
 *   gatingBgCount === 0                           — no non-backgrounded bg task in flight
 *   !teamActive                                   — no team poll loop holding the lead
 * Target mirrors what the lost result event would have produced live:
 *   error result            → 'error'
 *   process alive (FIFO up) → 'idle'
 *   process dead            → 'stopped'
 * Task phase target: IN_PROGRESS → AGENT_COMPLETE (or AWAIT_HUMAN_ACTION on error);
 * later phases are never regressed.
 *
 * Callers: attachToExisting() (restart recovery) and SessionHealthMonitor
 * (periodic). Idempotent by construction: only acts on genuine debt (record
 * stuck 'running', or task stuck IN_PROGRESS behind a settled record — the
 * incident-C shape), and the conditional write re-checks under the write lock.
 */

import { log } from '../logging/index.js'
import { bus, EventNames } from './event-bus.js'
import type { SessionRecord, ProcessStatus, TaskPhase } from './types.js'

// ── Stream-file tail fold (pure) ──

/** Terminal bg-task statuses — mirrors ClaudeCodeSession._BG_TERMINAL_STATUSES. */
const BG_TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled'])

export interface SessionTailFold {
  /** A real (non-tool-result, non-subagent) user line was found in the window.
   *  Includes daemon-appended walnut-injected delivery markers — they are the
   *  only trace a plain-text FIFO send leaves in the stream file.
   *  Without one there is no turn anchor and no verdict can be reached. */
  foundTurnAnchor: boolean
  /** Last REAL result (task-notification-origin results are bookkeeping, not turn-over).
   *  `endOffset` is the absolute byte position of the line's end in the stream
   *  file (the daemon's `v` coordinate) when the caller supplied a base offset;
   *  undefined otherwise. */
  lastResult: { isError: boolean; numTurns?: number; endOffset?: number } | null
  /** idle observed after lastResult with no 'running' since (the CLI settled). */
  trailingIdle: boolean
  /** Last observed CLI session state in the window. */
  cliState?: 'running' | 'idle' | 'requires_action'
  /** Background tasks folded from the window (terminal-is-terminal, is_backgrounded sticky). */
  bgTasks: Record<string, { status: string; isBackgrounded?: boolean }>
  /** In-flight bg tasks that GATE turn-over (non-terminal AND not backgrounded). */
  gatingBgCount: number
  /** TeamCreate seen after the anchor without a closing TeamDelete. */
  teamActive: boolean
  /** R1 verdict: the turn provably ended. */
  turnEnded: boolean
  /** Set only when turnEnded: 'error' | 'agent_complete'. */
  workStatus?: 'error' | 'agent_complete'
}

/** True for a user line that starts a turn: not an inline subagent line, and
 *  carrying actual user content (a string, or an array with any
 *  non-tool_result block).
 *  walnut-injected marker lines ARE accepted: the daemon appends one at every
 *  FIFO delivery (appendUserMarker) precisely because the CLI never echoes
 *  stdin user messages to its stream-json stdout — without the marker, a turn
 *  started by a plain-text send has NO anchor in the stream file, so Pass 1's
 *  backward scan lands on a PREVIOUS turn's user line and adopts that turn's
 *  stale result as the current turn's verdict (incident inc-1783644415695:
 *  agent working fine, reconciler force-converged it to a day-old error).
 *  Stream files are full of `user` lines that are tool_result echoes emitted
 *  MID-turn — anchoring on one of those would fold from inside the turn and
 *  miss earlier task_started lines, wrongly zeroing the gating count.
 *  Newer CLI builds also inline a Task-tool subagent's own conversation into
 *  the SAME main stream file: those `user` lines carry `parent_tool_use_id`
 *  set to the parent tool_use id and real text content (the subagent's own
 *  system/user prompt), so they'd otherwise pass every check above. They are
 *  emitted mid-turn (via the Task tool) and can land AFTER the true main-turn
 *  anchor, so accepting one would walk Pass 1's backward scan onto the wrong
 *  line and fold from inside the turn — the same "inline subagent interleave"
 *  class of bug as the main-stream text-fragmentation incident. Reject them
 *  the same way tool_result echoes are rejected. */
function isRealUserLine(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== 'user') return false
  if (parsed.subtype === 'walnut-injected') return true
  if (parsed.parent_tool_use_id) return false
  const content = (parsed.message as Record<string, unknown> | undefined)?.content
  if (typeof content === 'string') return true
  if (Array.isArray(content)) {
    return content.some((b) => b && typeof b === 'object' && (b as { type?: string }).type !== 'tool_result')
  }
  return false
}

/**
 * Fold the TAIL of a session's stream file into a turn-state verdict.
 * Pure function over content — shared semantics with the live event handlers
 * in claude-code-session.ts (terminal-is-terminal, backgrounded excluded from
 * gating, notification-origin results never end a turn, idle only counts after
 * a real result).
 *
 * The content is expected to be a tail window: a partial first line is skipped
 * (everything before the first '\n' is dropped by the line filter's JSON.parse
 * failure — a torn line never parses).
 *
 * `baseOffset` is the absolute byte position of `content`'s first character in
 * the stream file. When provided, `lastResult.endOffset` carries the result
 * line's end position in the daemon's `v` coordinate, letting the caller test
 * it against the record's consumedOffset (a result at or below the watermark
 * was already consumed by the live path — it is a PREVIOUS turn's evidence).
 */
export function foldSessionTail(content: string, baseOffset?: number): SessionTailFold {
  const fold: SessionTailFold = {
    foundTurnAnchor: false,
    lastResult: null,
    trailingIdle: false,
    bgTasks: {},
    gatingBgCount: 0,
    teamActive: false,
    turnEnded: false,
  }

  const lines = content.split('\n')
  // Pass 1: locate the turn anchor — the LAST real user line in the window.
  let anchorIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"type":"user"')) continue
    try {
      if (isRealUserLine(JSON.parse(line) as Record<string, unknown>)) { anchorIdx = i; break }
    } catch { /* torn/partial line */ }
  }
  if (anchorIdx === -1) return fold
  fold.foundTurnAnchor = true

  // Byte-offset cursor (daemon `v` coordinate): end position of the line being
  // folded. Seeded over the pre-anchor prefix, advanced per line in Pass 2.
  // split('\n') strips exactly one byte per line, so byteLength(line)+1 restores it.
  let lineEndOffset: number | undefined
  if (baseOffset !== undefined) {
    lineEndOffset = baseOffset
    for (let i = 0; i <= anchorIdx; i++) lineEndOffset += Buffer.byteLength(lines[i], 'utf8') + 1
  }

  // Pass 2: fold everything after the anchor.
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (lineEndOffset !== undefined) lineEndOffset += Buffer.byteLength(line, 'utf8') + 1
    if (!line.trim()) continue
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const type = parsed.type as string | undefined

    if (type === 'system') {
      const subtype = parsed.subtype as string | undefined
      const taskId = parsed.task_id as string | undefined
      if (subtype === 'init') {
        // A new init after a result means a NEW turn (or auto-continuation)
        // began after that result — the result cannot be the current turn's
        // verdict. Without this, a turn started by a plain-text FIFO send
        // (invisible in legacy stream files without delivery markers) gets
        // judged by the PREVIOUS turn's stale result (inc-1783644415695).
        if (fold.lastResult) { fold.lastResult = null; fold.trailingIdle = false }
      } else if (subtype === 'session_state_changed') {
        const s = parsed.state as SessionTailFold['cliState']
        fold.cliState = s
        if (s === 'idle') { if (fold.lastResult) fold.trailingIdle = true }
        else if (s === 'running') {
          // Same invalidation as init: the CLI went back to work after that
          // result, so it did not end the turn. Mid-turn workflow results
          // (one per subagent) are naturally superseded by the final result.
          fold.trailingIdle = false
          fold.lastResult = null
        }
      } else if (taskId && (subtype === 'task_started' || subtype === 'task_progress')) {
        const prev = fold.bgTasks[taskId]
        // Terminal is terminal: a late/replayed start or progress can't revive a task.
        fold.bgTasks[taskId] = {
          status: prev && BG_TERMINAL.has(prev.status) ? prev.status : 'running',
          isBackgrounded: prev?.isBackgrounded,
        }
      } else if (taskId && subtype === 'task_updated') {
        const prev = fold.bgTasks[taskId]
        const patch = parsed.patch as Record<string, unknown> | undefined
        fold.bgTasks[taskId] = {
          status: (patch?.status as string | undefined) ?? prev?.status ?? 'running',
          // Sticky: is_backgrounded=true detaches the task from gating forever.
          isBackgrounded: patch?.is_backgrounded === true || prev?.isBackgrounded,
        }
      } else if (taskId && subtype === 'task_notification') {
        const prev = fold.bgTasks[taskId]
        fold.bgTasks[taskId] = {
          status: (parsed.status as string | undefined) ?? 'completed',
          isBackgrounded: prev?.isBackgrounded,
        }
      }
    } else if (type === 'result') {
      const origin = (parsed as { origin?: { kind?: string } }).origin
      if (origin?.kind === 'task-notification') continue // bookkeeping, never turn-over
      fold.lastResult = {
        isError: parsed.is_error === true,
        numTurns: parsed.num_turns as number | undefined,
        ...(lineEndOffset !== undefined ? { endOffset: lineEndOffset } : {}),
      }
      fold.trailingIdle = false // this result's own companion idle must still arrive
    } else if (type === 'assistant') {
      const blocks = (parsed.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (!b || typeof b !== 'object' || (b as { type?: string }).type !== 'tool_use') continue
          const name = (b as { name?: string }).name
          if (name === 'TeamCreate') fold.teamActive = true
          else if (name === 'TeamDelete') fold.teamActive = false
        }
      }
    }
  }

  for (const t of Object.values(fold.bgTasks)) {
    if (!t.isBackgrounded && !BG_TERMINAL.has(t.status)) fold.gatingBgCount++
  }

  if (fold.lastResult) {
    if (fold.lastResult.isError) {
      // An error result may not get a companion idle (the CLI can bail) — the
      // error itself is terminal evidence.
      fold.turnEnded = true
      fold.workStatus = 'error'
    } else if (fold.trailingIdle && fold.gatingBgCount === 0 && !fold.teamActive) {
      fold.turnEnded = true
      fold.workStatus = 'agent_complete'
    }
  }
  return fold
}

// ── Stream-file tail read (daemon-uniform) ──

/** Initial tail window; expanded once to the cap when no turn anchor is found. */
const TAIL_WINDOW_BYTES = 256 * 1024
/** Hard cap — a turn whose last user message is further back than this is a
 *  whale; give up this tick rather than dragging megabytes over the tunnel. */
const TAIL_WINDOW_MAX_BYTES = 2 * 1024 * 1024

/** Daemon stream-file path for a session. Mirrors the daemon's own derivation
 *  (daemon-standalone.ts): STREAMS_DIR = WALNUT_STREAMS_DIR ||
 *  (WALNUT_DAEMON_DIR || '/tmp/open-walnut') + '-streams'. Remote daemons are
 *  always started with default env, so the remote path is fixed. */
export function daemonStreamPath(sessionId: string, host?: string | null): string {
  if (host && host !== '__local__') return `/tmp/open-walnut-streams/${sessionId}.jsonl`
  const dir = process.env.WALNUT_STREAMS_DIR
    || `${process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'}-streams`
  return `${dir}/${sessionId}.jsonl`
}

/** Read the stream-file tail and fold it. Returns the fold + file size, or a
 *  string reason when no verdict-capable evidence could be obtained (R1: the
 *  caller must treat every string as "do not converge"). Exported so
 *  attachToExisting can fetch the evidence ONCE and share it with both the
 *  resultEmitted seeding and the reconcile call. */
export async function fetchStreamTailFold(
  sessionId: string,
  host: string | null | undefined,
): Promise<{ fold: SessionTailFold; fileSize: number } | string> {
  const { DaemonFileReader } = await import('./daemon-file-reader.js')
  const reader = new DaemonFileReader(host ?? '__local__')
  const streamPath = daemonStreamPath(sessionId, host)

  let size: number
  try {
    const st = await reader.stat(streamPath)
    if (st === null) return 'no-stream-file'
    size = st.size
  } catch (err) {
    log.session.debug('reconcile: stream stat failed', {
      sessionId, host: host ?? '__local__',
      error: err instanceof Error ? err.message : String(err),
    })
    return 'stream-stat-failed'
  }
  if (size === 0) return 'no-stream-file'

  let window = TAIL_WINDOW_BYTES
  for (;;) {
    const start = Math.max(0, size - window)
    let content: string
    try {
      const res = await reader.readFileRange(streamPath, start)
      if (res === null) return 'no-stream-file' // deleted between stat and read
      content = res.content
    } catch (err) {
      log.session.debug('reconcile: stream tail read failed', {
        sessionId, host: host ?? '__local__',
        error: err instanceof Error ? err.message : String(err),
      })
      return 'stream-read-failed'
    }
    // A tail window starts mid-line; drop the torn prefix so the fold sees whole lines.
    let base = start
    if (start > 0) {
      const nl = content.indexOf('\n')
      base = nl >= 0 ? start + Buffer.byteLength(content.slice(0, nl + 1), 'utf8') : size
      content = nl >= 0 ? content.slice(nl + 1) : ''
    }
    const fold = foldSessionTail(content, base)
    if (fold.foundTurnAnchor) return { fold, fileSize: size }
    if (start === 0) return 'no-turn-anchor'                 // whole file, still no real user line
    if (window >= TAIL_WINDOW_MAX_BYTES) return 'tail-window-exhausted'
    window = TAIL_WINDOW_MAX_BYTES
  }
}

// ── Convergence ──

export interface ReconcileProcessStatusInputs {
  /** Pre-fetched stream-tail evidence (attach path already has it — avoids a
   *  second tail read). Pass a string reason to mean "evidence unavailable". */
  evidence?: { fold: SessionTailFold; fileSize: number } | string
  /** Pre-computed process liveness. Omit to compute via isSessionProcessAlive(). */
  isAlive?: boolean
  /** Skip records whose last_status_change is younger than this — protects the
   *  just-sent race where the record flipped 'running' but the CLI hasn't
   *  emitted anything for the new turn yet. */
  minAgeMs?: number
  /** Caller-known team state (e.g. attach recovery already scanned the canonical
   *  JSONL for TeamCreate/TeamDelete). ORed with the fold's own detection — the
   *  tail window can miss a team created in an earlier turn. */
  teamActiveHint?: boolean
}

export type ReconcileOutcome =
  | { converged: false; reason: string }
  | { converged: true; from: ProcessStatus; to: ProcessStatus; phaseSynced?: boolean }

/**
 * Compare the session's recorded status + its task's phase against the daemon
 * stream file and converge both when the turn is provably over. Safe to call
 * repeatedly (no-op when consistent); never revives a session, never upgrades
 * toward 'running', never regresses a task phase past IN_PROGRESS.
 *
 * Handles two debt shapes:
 *   record debt — process_status stuck 'running' (incidents 6c8428ac / ed81e36d / 07fffbe5)
 *   phase debt  — record settled but task stuck IN_PROGRESS (incident 10e7df54:
 *                 the real result was swallowed by the replay guard, so the phase
 *                 never advanced even though the record reached 'idle')
 */
export async function reconcileProcessStatus(
  record: SessionRecord,
  inputs: ReconcileProcessStatusInputs = {},
): Promise<ReconcileOutcome> {
  const sid = record.claudeSessionId
  if (record.archived) return { converged: false, reason: 'archived' }

  if (inputs.minAgeMs && inputs.minAgeMs > 0) {
    const last = new Date(record.last_status_change ?? record.startedAt ?? 0).getTime()
    if (Date.now() - last < inputs.minAgeMs) return { converged: false, reason: 'too-young' }
  }

  const recordDebt = record.process_status === 'running'

  // Phase debt (the incident-C shape): record already settled, task left behind.
  let phaseDebt = false
  if (!recordDebt && record.taskId
    && (record.process_status === 'idle' || record.process_status === 'stopped' || record.process_status === 'error')) {
    try {
      const { getTask } = await import('./task-manager.js')
      const task = await getTask(record.taskId)
      phaseDebt = task?.phase === 'IN_PROGRESS'
    } catch { /* task gone — no phase to sync */ }
  }
  if (!recordDebt && !phaseDebt) return { converged: false, reason: 'not-running' }

  // Snapshot BEFORE the (potentially slow) tail read so the conditional write
  // below can detect any concurrent record change and skip the stale update.
  const startedAtIso = new Date().toISOString()

  // ── Signal 1: the daemon stream file (the ONLY file containing result/idle events) ──
  const evidence = inputs.evidence !== undefined
    ? inputs.evidence
    : await fetchStreamTailFold(sid, record.host)
  if (typeof evidence === 'string') return { converged: false, reason: evidence }
  const { fold } = evidence

  if (!fold.turnEnded) return { converged: false, reason: 'turn-not-terminal' }
  if (inputs.teamActiveHint && fold.workStatus !== 'error') {
    return { converged: false, reason: 'team-active' }
  }
  // Positional veto: a result at or below the consumed watermark was already
  // processed by the live path — it ended a PREVIOUS turn, not this one. Same
  // yardstick as the live replay check (v <= consumedOffset ⇒ replay). This is
  // what stops a stale error result from being re-adopted as the current
  // turn's verdict when the turn's own anchor is missing (legacy sessions
  // without delivery markers — inc-1783644415695).
  if (typeof fold.lastResult?.endOffset === 'number'
    && typeof record.consumedOffset === 'number'
    && fold.lastResult.endOffset <= record.consumedOffset) {
    return { converged: false, reason: 'result-already-consumed' }
  }
  const workStatus = fold.workStatus! // set whenever turnEnded

  // ── Signal 2: daemon L2 veto — its taskState is rebuilt from the FULL jsonl,
  // so it sees non-backgrounded bg tasks started before our tail window. ──
  try {
    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')
    const mgr = getRegisteredSessionManager(sid)
    if (mgr?.getState) {
      const st = await mgr.getState()
      if (st && st.derivedRunning > 0) return { converged: false, reason: 'daemon-bg-running' }
    }
  } catch { /* daemon unreachable — the stream tail alone is authoritative */ }

  // ── Target state: mirror what the lost result event would have set live ──
  let alive = inputs.isAlive
  if (alive === undefined) {
    try {
      const { isSessionProcessAlive } = await import('../utils/session-liveness.js')
      alive = await isSessionProcessAlive(record)
    } catch { alive = false }
  }
  const to: ProcessStatus = workStatus === 'error' ? 'error' : (alive ? 'idle' : 'stopped')

  let convergedRecord = false
  if (recordDebt) {
    // ── Converge the record (conditional: skip if it changed since our snapshot) ──
    const { updateSessionRecordConditionally } = await import('./session-tracker.js')
    const updated = await updateSessionRecordConditionally(
      sid,
      {
        process_status: to,
        activity: undefined,
        last_status_change: new Date().toISOString(),
        status_reason: 'reconciled_authoritative',
        status_changed_by: 'reconciler',
        // R2: the verdict accounts for everything up to the file size we folded —
        // adopt it as the consumed watermark so replays of this ended turn are
        // positionally suppressed. Monotonic arbitration in the tracker drops
        // this silently if a newer position is already in place.
        consumedOffset: evidence.fileSize,
        ...(to === 'error'
          ? { errorMessage: 'Turn ended with error — reconciled from daemon stream file' }
          : {}),
        // Clear the PID only when the process is confirmed DEAD (recycled-PID
        // orphan-kill defense). While alive — including an error verdict with
        // a live CLI + FIFO — keep it: clearing forced the next send onto the
        // cold --resume path, spawning a SECOND CLI against the same session
        // (split-brain, inc-1783644415695). The live error path keeps pid too.
        ...(alive ? {} : { pid: undefined }),
      },
      (current) => {
        if (current.process_status !== 'running') return false
        if (current.last_status_change && current.last_status_change > startedAtIso) return false
        return true
      },
    )
    if (!updated) return { converged: false, reason: 'record-changed-concurrently' }
    convergedRecord = true

    log.session.warn('reconcileProcessStatus: converged stuck running record to authoritative state', {
      sessionId: sid,
      taskId: record.taskId,
      to,
      workStatus,
      alive,
      gatingBgCount: fold.gatingBgCount,
      host: record.host ?? '__local__',
    })

    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: sid,
      taskId: record.taskId,
      process_status: to,
      activity: undefined,
    }, ['*'], { source: 'session-reconcile', urgency: 'urgent' })
  }

  // ── Phase sync: deliver what the lost result would have delivered ──
  // ONLY when the task is still IN_PROGRESS (i.e. the phase never saw the result).
  // Later phases (AGENT_COMPLETE / AWAIT_HUMAN_ACTION / terminal) are never
  // regressed — a stale reconcile must not re-trigger triage or notifications.
  let phaseSynced = false
  if (record.taskId) {
    try {
      const { getTask } = await import('./task-manager.js')
      const task = await getTask(record.taskId)
      if (task?.phase === 'IN_PROGRESS') {
        const { applySessionPhase } = await import('./phase.js')
        const newPhase: TaskPhase = workStatus === 'error' ? 'AWAIT_HUMAN_ACTION' : 'AGENT_COMPLETE'
        const res = await applySessionPhase(record.taskId, 'reconciler', 'session-reconcile', {
          sessionId: sid,
          newPhase,
        })
        phaseSynced = res.changed
        if (phaseSynced) {
          log.session.warn('reconcileProcessStatus: synced stuck task phase from stream evidence', {
            sessionId: sid, taskId: record.taskId, newPhase, workStatus,
          })
        }
      }
    } catch (err) {
      log.session.warn('reconcileProcessStatus: phase sync failed', {
        sessionId: sid, taskId: record.taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!convergedRecord && !phaseSynced) {
    // Phase-debt path where the phase moved on concurrently — honest no-op.
    return { converged: false, reason: 'phase-already-settled' }
  }
  return {
    converged: true,
    from: record.process_status as ProcessStatus,
    to: convergedRecord ? to : (record.process_status as ProcessStatus),
    ...(phaseSynced ? { phaseSynced } : {}),
  }
}
