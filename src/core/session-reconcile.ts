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

import os from 'node:os'
import path from 'node:path'
import { log } from '../logging/index.js'
import type { SessionRecord, ProcessStatus, TaskPhase } from './types.js'

// ── Stream-file tail fold (pure) ──

/** Terminal bg-task statuses — mirrors ClaudeCodeSession._BG_TERMINAL_STATUSES. */
const BG_TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed'])

export interface SessionTailFold {
  /** A real (non-tool-result, non-subagent) user line was found in the window.
   *  Includes daemon-appended walnut-injected delivery markers — they are the
   *  only trace a plain-text FIFO send leaves in the stream file.
   *  Without one there is no turn anchor and no verdict can be reached. */
  foundTurnAnchor: boolean
  /** The anchor was SYNTHESIZED at the window start (consumedOffset watermark
   *  fold — see fetchStreamTailFold's whale-turn fallback). The watermark is by
   *  construction a consumed turn-END position, so everything in the window is
   *  post-turn evidence even though no user line is visible. */
  anchorSynthetic?: boolean
  /** Synthetic mode only: the window contained turn-activity lines (any user
   *  line incl. tool_result echoes, assistant output, stream deltas, init,
   *  state running/requires_action, control_request). Activity after the
   *  watermark means a turn may be alive — the no-result synthetic verdict is
   *  withheld. */
  sawTurnActivity?: boolean
  /** Last REAL result (task-notification-origin results are bookkeeping, not turn-over).
   *  `endOffset` is the absolute byte position of the line's end in the stream
   *  file (the daemon's `v` coordinate) when the caller supplied a base offset;
   *  undefined otherwise. */
  lastResult: { isError: boolean; numTurns?: number; endOffset?: number } | null
  /** idle observed after lastResult with no 'running' since (the CLI settled). */
  trailingIdle: boolean
  /** Last observed CLI session state in the window. */
  cliState?: 'running' | 'idle' | 'requires_action'
  /** Background tasks folded from the window (terminal-is-terminal, is_backgrounded sticky).
   *  `endedPerLevel`: a `background_tasks_changed` replace-semantics snapshot omitted this
   *  task after having listed it — its terminal bookends were lost; excluded from gating
   *  (mirrors the live handler's #870 level reconciliation). */
  bgTasks: Record<string, { status: string; isBackgrounded?: boolean; endedPerLevel?: boolean }>
  /** In-flight bg tasks that GATE turn-over (non-terminal AND not backgrounded). */
  gatingBgCount: number
  /** TeamCreate seen after the anchor without a closing TeamDelete. */
  teamActive: boolean
  /** CronCreate seen in the window without a closing CronDelete. Best-effort
   *  (a create in an EARLIER turn is outside the window — the daemon's
   *  full-file fold is the authority); used to re-arm the live session's
   *  cron idle-kill protection on attach. Does NOT gate turn settle: a /loop
   *  session goes legitimately idle between fires. */
  cronActive?: boolean
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
/** Synthetic-anchor activity classifier: lines that are pure POST-turn
 *  bookkeeping (safe to see after a consumed turn-end without implying a live
 *  turn). Everything else — user/assistant/stream lines, init, state running /
 *  requires_action, control_request, unknown types — is turn activity and
 *  withholds the no-result watermark verdict. Deliberately conservative: a
 *  line we can't classify counts as activity (the failure mode is "converge
 *  later via another path", never "converge a live turn"). */
function isPostTurnBookkeeping(parsed: Record<string, unknown>, type: string | undefined): boolean {
  if (type === 'system') {
    const subtype = parsed.subtype as string | undefined
    if (subtype === 'session_state_changed') {
      return parsed.state === 'idle' // running / requires_action = CLI is live
    }
    switch (subtype) {
      // task_* / background_tasks_changed feed the bgTasks gating instead of
      // the activity flag — a still-running bg task withholds the verdict via
      // gatingBgCount, exactly like the anchored fold.
      case 'task_started': case 'task_updated': case 'task_notification':
      case 'background_tasks_changed':
      // Between-turns chatter observed in real post-turn windows (57b125ab):
      // skill/command reloads, status pings, and progress lines for
      // walnut-initiated control reads (recap/settings polling).
      case 'commands_changed': case 'status': case 'control_request_progress':
        return true
      // Everything else — init (new turn), thinking_tokens / api_retry
      // (mid-turn), and any UNKNOWN subtype — is activity. Conservative on
      // purpose: misclassifying activity as bookkeeping could converge a live
      // turn; the reverse merely postpones convergence to another path/tick.
      default:
        return false
    }
  }
  // Real results reach the R1 verdict path on their own; task-notification
  // results are bg-summary bookkeeping. Neither implies a live turn.
  if (type === 'result') return true
  // CLI's replies to WALNUT-initiated control reads (get_settings /
  // get_context_usage / recap generation). Walnut polls these between turns —
  // observed in the 57b125ab post-watermark window alongside the companion
  // idle. NOT the inverse direction: a `control_request` (CLI asking walnut
  // for permission) is a live paused turn and stays classified as activity.
  if (type === 'control_response') return true
  return false
}

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
export function foldSessionTail(
  content: string,
  baseOffset?: number,
  opts?: {
    /** Anchor the fold at the window START instead of scanning for a user line.
     *  ONLY valid when the window starts at the record's consumedOffset
     *  watermark: the watermark is advanced exclusively at turn-END positions
     *  (_advanceConsumedOffset — result processed / withheld-turn idle), so
     *  everything in the window is positionally-unconsumed post-turn evidence.
     *  This is what lets a WHALE turn (last user line further back than the
     *  tail-window cap) still reach a verdict: incident 57b125ab sat at a
     *  false 'running' for 15h because every fold returned
     *  'tail-window-exhausted' on its 55MB stream while the 19KB after the
     *  watermark held the clean turn-end. The stale-result danger the anchor
     *  scan guards against (inc-1783644415695) cannot occur here — a consumed
     *  result is by definition at/below the watermark, outside the window. */
    syntheticAnchor?: boolean
  },
): SessionTailFold {
  const fold: SessionTailFold = {
    foundTurnAnchor: false,
    lastResult: null,
    trailingIdle: false,
    bgTasks: {},
    gatingBgCount: 0,
    teamActive: false,
    turnEnded: false,
    ...(opts?.syntheticAnchor ? { anchorSynthetic: true, sawTurnActivity: false } : {}),
  }

  const lines = content.split('\n')
  // Level universe for the #870 reconciliation: ids ever listed by a
  // background_tasks_changed snapshot inside this window. Only those may be
  // absent-marked by a later snapshot (a live sync subagent is legitimately
  // absent from every level payload).
  const seenInLevel = new Set<string>()
  // Pass 1: locate the turn anchor — the LAST real user line in the window.
  // Skipped in syntheticAnchor mode: the window start IS the anchor.
  let anchorIdx = -1
  if (!opts?.syntheticAnchor) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || !line.includes('"type":"user"')) continue
      try {
        if (isRealUserLine(JSON.parse(line) as Record<string, unknown>)) { anchorIdx = i; break }
      } catch { /* torn/partial line */ }
    }
    if (anchorIdx === -1) return fold
  }
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
    try { parsed = JSON.parse(line) as Record<string, unknown> } catch {
      // Synthetic mode: an unparseable non-empty line is a torn/mid-write line —
      // the stream is being actively written, i.e. a turn is likely alive.
      // Counting it as activity withholds the no-result verdict (safe direction).
      if (opts?.syntheticAnchor) fold.sawTurnActivity = true
      continue
    }
    const type = parsed.type as string | undefined

    // Synthetic-anchor activity tracking: the no-result verdict below requires
    // that NOTHING but post-turn bookkeeping was written after the watermark.
    // Everything else — a new user line (incl. tool_result echoes), assistant
    // output, stream deltas, init, state running, control_request, unknown
    // types — means a turn began (or is streaming) after the watermark. This
    // deliberately includes lines with no turn-STARTING semantics: a legacy
    // marker-less FIFO send leaves no user line, so the first visible trace of
    // its turn may be an assistant/stream_event line.
    if (opts?.syntheticAnchor && !fold.sawTurnActivity && !isPostTurnBookkeeping(parsed, type)) {
      fold.sawTurnActivity = true
    }

    // A REAL user line after a result means a NEW turn began — that result can
    // no longer be the current turn's verdict. Unreachable in anchor mode (the
    // anchor IS the last real user line), but load-bearing in synthetic mode
    // where multiple turns can sit inside the post-watermark window.
    if (type === 'user' && isRealUserLine(parsed) && fold.lastResult) {
      fold.lastResult = null
      fold.trailingIdle = false
    }

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
      } else if (subtype === 'background_tasks_changed') {
        // #870 level reconciliation, replay flavor — same rules as the live handler:
        // replace semantics, universe guard (only ever-listed ids may be absent-marked),
        // reversible mark, terminal untouched. Heals a lost terminal bookend so the
        // reconciler's gatingBgCount can converge a wedged 'running' session.
        const levelTasks = parsed.tasks
        if (Array.isArray(levelTasks)) {
          const present = new Set<string>()
          for (const t of levelTasks) {
            const id = (t as Record<string, unknown> | null)?.task_id
            if (typeof id !== 'string') continue
            present.add(id)
            seenInLevel.add(id)
            const prev = fold.bgTasks[id]
            if (prev?.endedPerLevel) fold.bgTasks[id] = { ...prev, endedPerLevel: undefined }
            if (!prev) fold.bgTasks[id] = { status: 'running' }
          }
          for (const [id, t] of Object.entries(fold.bgTasks)) {
            if (present.has(id) || !seenInLevel.has(id)) continue
            if (BG_TERMINAL.has(t.status)) continue
            fold.bgTasks[id] = { ...t, endedPerLevel: true }
          }
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
          // Cron: window-scoped best-effort. Arm on create; only an
          // EMPTY-input-tracking delete clears (job-id matching needs the
          // full-file fold — the daemon owns that; here any delete after the
          // last create un-arms, which errs toward re-killable = the
          // direction that merely restores the old behavior).
          else if (name === 'CronCreate') fold.cronActive = true
          else if (name === 'CronDelete') fold.cronActive = false
        }
      }
    }
  }

  for (const t of Object.values(fold.bgTasks)) {
    if (!t.isBackgrounded && !t.endedPerLevel && !BG_TERMINAL.has(t.status)) fold.gatingBgCount++
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
  } else if (opts?.syntheticAnchor && !fold.sawTurnActivity
    && fold.gatingBgCount === 0 && !fold.teamActive) {
    // Watermark verdict (no result in the window): the window base IS a
    // consumed turn-end position — _advanceConsumedOffset's invariant is that
    // it only ever advances at "result processed" / "withheld-turn idle"
    // moments — and nothing but post-turn bookkeeping (companion idle,
    // control_response polling, status chatter) has been written since. The
    // turn the record still thinks is running provably ended AT the watermark.
    // Success shape by construction: an ERROR consumed at the watermark would
    // have written the record 'error' then, not left it 'running'.
    fold.turnEnded = true
    fold.workStatus = 'agent_complete'
  }
  return fold
}

// ── Stream-file tail read (daemon-uniform) ──

/** Initial tail window; expanded once to the cap when no turn anchor is found. */
const TAIL_WINDOW_BYTES = 256 * 1024
/** Hard cap — a turn whose last user message is further back than this is a
 *  whale; give up this tick rather than dragging megabytes over the tunnel. */
const TAIL_WINDOW_MAX_BYTES = 2 * 1024 * 1024

/** Daemon stream-file candidate paths for a session, PRIMARY FIRST. Mirrors the
 *  daemon's derivation (daemon-standalone.ts): prod streams now live under
 *  `~/.open-walnut/tmp/streams` (reboot-surviving; incident 019a7fe5), with the
 *  legacy `/tmp/open-walnut-streams` still a valid fallback — a live session
 *  spawned before the move keeps appending to its legacy-path file until that
 *  CLI dies (registry absolute paths; startup migration skips live pgids).
 *  Isolated envs (WALNUT_STREAMS_DIR / non-prod WALNUT_DAEMON_DIR) keep their
 *  single derived dir. Remote daemons run with default env, so the remote pair
 *  is fixed; `~` is expanded by the remote daemon's own fs RPC layer. */
export function daemonStreamPathCandidates(sessionId: string, host?: string | null): string[] {
  if (host && host !== '__local__') {
    return [
      `~/.open-walnut/tmp/streams/${sessionId}.jsonl`,
      `/tmp/open-walnut-streams/${sessionId}.jsonl`,
    ]
  }
  if (process.env.WALNUT_STREAMS_DIR) {
    return [`${process.env.WALNUT_STREAMS_DIR}/${sessionId}.jsonl`]
  }
  const daemonDir = process.env.WALNUT_DAEMON_DIR
  if (daemonDir && daemonDir !== '/tmp/open-walnut') {
    return [`${daemonDir}-streams/${sessionId}.jsonl`]
  }
  return [
    path.join(os.homedir(), '.open-walnut', 'tmp', 'streams', `${sessionId}.jsonl`),
    `/tmp/open-walnut-streams/${sessionId}.jsonl`,
  ]
}

/** Primary daemon stream-file path (see daemonStreamPathCandidates). */
export function daemonStreamPath(sessionId: string, host?: string | null): string {
  return daemonStreamPathCandidates(sessionId, host)[0]
}

/** Read the stream-file tail and fold it. Returns the fold + file size, or a
 *  string reason when no verdict-capable evidence could be obtained (R1: the
 *  caller must treat every string as "do not converge"). Exported so
 *  attachToExisting can fetch the evidence ONCE and share it with both the
 *  resultEmitted seeding and the reconcile call.
 *
 *  `opts.consumedOffset` (the record's persisted watermark) enables the
 *  WHALE-TURN fallback: when the anchor scan exhausts the tail-window cap
 *  (last real user line further back than 2 MB — a 37-min turn easily streams
 *  more), fold the region AFTER the watermark with a synthetic anchor instead.
 *  Without this, a whale turn's stuck-'running' record was unreconcilable
 *  forever (incident 57b125ab: 55 MB stream, verdict sat in the 19 KB after
 *  the watermark, every tick returned 'tail-window-exhausted' for 15h). */
export async function fetchStreamTailFold(
  sessionId: string,
  host: string | null | undefined,
  opts?: { consumedOffset?: number },
): Promise<{ fold: SessionTailFold; fileSize: number; streamEpoch?: string } | string> {
  const { DaemonFileReader } = await import('./daemon-file-reader.js')
  const reader = new DaemonFileReader(host ?? '__local__')
  // New HOME location first, legacy /tmp second (a live pre-move session keeps
  // appending at the legacy path until its CLI dies — see the candidates doc).
  let streamPath = ''
  let size = -1
  let statFailed = false
  // File-incarnation identity (dev:ino:birthtimeMs) of the stream file the
  // fold is computed over. Callers need it to durably reset a consumedOffset
  // watermark that belongs to a DEAD predecessor file (the tracker's
  // arbitration only accepts a watermark regression paired with an epoch
  // change). undefined = pre-epoch daemon.
  let streamEpoch: string | undefined
  for (const candidate of daemonStreamPathCandidates(sessionId, host)) {
    try {
      const st = await reader.stat(candidate)
      if (st === null) continue
      streamPath = candidate
      size = st.size
      streamEpoch = st.epoch
      break
    } catch (err) {
      statFailed = true
      log.session.debug('reconcile: stream stat failed', {
        sessionId, host: host ?? '__local__', candidate,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (size < 0) return statFailed ? 'stream-stat-failed' : 'no-stream-file'
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
    if (fold.foundTurnAnchor) return { fold, fileSize: size, ...(streamEpoch !== undefined ? { streamEpoch } : {}) }
    if (start === 0) return 'no-turn-anchor'                 // whole file, still no real user line
    if (window >= TAIL_WINDOW_MAX_BYTES) break               // whale turn — try the watermark fallback
    window = TAIL_WINDOW_MAX_BYTES
  }

  // ── Whale-turn fallback: synthetic anchor at the consumed watermark ──
  // The anchor scan failed because the turn's last real user line is beyond the
  // window cap. The record's consumedOffset is a turn-END position this server
  // already processed; folding what came AFTER it answers the only question the
  // reconciler asks — "did anything real happen since the last consumed
  // turn-end?" — without needing the (unreachable) turn anchor.
  const watermark = opts?.consumedOffset
  if (typeof watermark !== 'number' || !Number.isInteger(watermark)
    || watermark <= 0 || watermark >= Number.MAX_SAFE_INTEGER) {
    return 'tail-window-exhausted'
  }
  if (watermark >= size) return 'tail-window-exhausted' // sid changed / file truncated — watermark unusable
  if (size - watermark > TAIL_WINDOW_MAX_BYTES) {
    // Too much unconsumed data to drag over the tunnel — and that volume itself
    // suggests a live turn streaming. Let a later tick converge it.
    return 'tail-window-exhausted'
  }
  let content: string
  try {
    const res = await reader.readFileRange(streamPath, watermark)
    if (res === null) return 'no-stream-file'
    content = res.content
  } catch (err) {
    log.session.debug('reconcile: watermark tail read failed', {
      sessionId, host: host ?? '__local__',
      error: err instanceof Error ? err.message : String(err),
    })
    return 'stream-read-failed'
  }
  // The watermark is a line-END offset by construction (_advanceConsumedOffset
  // stores the daemon `v` of a consumed line), so content starts at a line
  // boundary; keep the torn-prefix guard anyway for robustness (a corrupted
  // watermark must not feed half a line into the fold).
  let base = watermark
  if (!content.startsWith('{')) {
    const nl = content.indexOf('\n')
    base = nl >= 0 ? watermark + Buffer.byteLength(content.slice(0, nl + 1), 'utf8') : size
    content = nl >= 0 ? content.slice(nl + 1) : ''
  }
  const fold = foldSessionTail(content, base, { syntheticAnchor: true })
  log.session.info('reconcile: whale-turn watermark fold', {
    sessionId, host: host ?? '__local__', watermark, fileSize: size,
    turnEnded: fold.turnEnded, workStatus: fold.workStatus,
    sawTurnActivity: fold.sawTurnActivity, gatingBgCount: fold.gatingBgCount,
    hasResult: fold.lastResult != null,
  })
  return { fold, fileSize: size, ...(streamEpoch !== undefined ? { streamEpoch } : {}) }
}

/** True when the record's consumedOffset provably belongs to a DEAD stream-file
 *  incarnation — i.e. the watermark is garbage for the file we are looking at
 *  and must not veto/suppress anything (incident inc-1786428350008: a session
 *  spawned pre-/tmp→HOME-move carried a 37.9 MB legacy-file watermark; its
 *  respawn wrote a fresh 6 MB HOME file whose every event sat "below" the
 *  watermark, so the real end-of-turn result was suppressed as a replay and
 *  the task never reached AGENT_COMPLETE). Two independent proofs:
 *    offset-beyond-file — a consumed line-end offset can never exceed the size
 *      of the append-only file it was measured in, so watermark > fileSize
 *      means "different file";
 *    epoch-mismatch — the file identity (dev:ino:birthtimeMs) changed. NOTE:
 *      by epoch semantics a changed identity always means new coordinates
 *      (matches session-snapshot-apply's epochChanged → consumedOffset=0);
 *      the daemon's one-time legacy→HOME copy migration technically preserved
 *      coordinates while changing inodes, but it ran before any record ever
 *      had an epoch stamped, so it can't produce a false positive here. */
export function isStaleWatermark(
  record: { consumedOffset?: number; streamEpoch?: string },
  evidence: { fileSize: number; streamEpoch?: string },
): boolean {
  if (typeof record.consumedOffset !== 'number'
    || !Number.isInteger(record.consumedOffset) || record.consumedOffset <= 0) return false
  if (record.consumedOffset > evidence.fileSize) return true
  return typeof evidence.streamEpoch === 'string' && evidence.streamEpoch.length > 0
    && typeof record.streamEpoch === 'string' && record.streamEpoch.length > 0
    && evidence.streamEpoch !== record.streamEpoch
}

// ── Convergence ──

export interface ReconcileProcessStatusInputs {
  /** Pre-fetched stream-tail evidence (attach path already has it — avoids a
   *  second tail read). Pass a string reason to mean "evidence unavailable". */
  evidence?: { fold: SessionTailFold; fileSize: number; streamEpoch?: string } | string
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
  // consumedOffset rides along to arm the whale-turn watermark fallback.
  const evidence = inputs.evidence !== undefined
    ? inputs.evidence
    : await fetchStreamTailFold(sid, record.host, { consumedOffset: record.consumedOffset })
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
  // EXCEPTION: a watermark from a DEAD file incarnation is not a position in
  // THIS file — comparing against it vetoes every real result forever
  // (inc-1786428350008). isStaleWatermark proves the mismatch (offset beyond
  // EOF, or epoch differs); then the veto must yield.
  const staleWatermark = isStaleWatermark(record, evidence)
  if (staleWatermark) {
    log.session.warn('reconcileProcessStatus: consumedOffset belongs to a dead stream-file incarnation — ignoring watermark', {
      sessionId: sid, consumedOffset: record.consumedOffset,
      fileSize: evidence.fileSize,
      recordEpoch: record.streamEpoch ?? null, fileEpoch: evidence.streamEpoch ?? null,
    })
  } else if (typeof fold.lastResult?.endOffset === 'number'
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
    const {
      emitSessionStatusChanged,
      updateSessionRecordConditionally,
    } = await import('./session-tracker.js')
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
        // Stamp the file identity alongside the watermark. When the record's
        // old watermark came from a DEAD incarnation (staleWatermark), the new
        // offset is a REGRESSION — the tracker only accepts it paired with an
        // epoch change, and first-sight stamping (record has no epoch yet) is
        // exactly that pair. Same-epoch restamps are no-ops.
        ...(evidence.streamEpoch ? { streamEpoch: evidence.streamEpoch } : {}),
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

    emitSessionStatusChanged(
      updated,
      {},
      ['*'],
      { source: 'session-reconcile', urgency: 'urgent' },
    )

    // Free the task's session slot on terminal converge (mirrors the live result path
    // in session-runner which clears on stopped/error). Without this, a reconciled
    // session holds the slot forever and blocks new sessions for the task.
    if ((to === 'stopped' || to === 'error') && record.taskId) {
      try {
        const { clearSessionSlot } = await import('./task-manager.js')
        await clearSessionSlot(record.taskId, sid)
      } catch { /* task gone or slot already cleared — harmless */ }
    }
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
