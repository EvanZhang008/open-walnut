/**
 * daemon-fold — pure, self-contained session-stream fold.
 * C1 of "daemon as source of truth" (docs/plan/session-snapshot-source-of-truth.md §1–§3).
 *
 * The daemon reads the CLI stream file losslessly on the same machine and folds
 * it, line by line, into an authoritative per-session snapshot. Semantics are a
 * faithful port of foldSessionTail (src/core/session-reconcile.ts:203-415)
 * re-expressed as an incremental reducer — the 55+ tests in
 * tests/core/session-reconcile.test.ts define the behavior. Do not "improve"
 * the rules here without changing them there first.
 *
 * TWIN-SAFE CONSTRAINTS (load-bearing — do not break):
 * - ZERO imports. ZERO module-scope values captured by the exported functions.
 *   getDaemonSource() injects foldLine/initialFoldState/assembleSnapshot/
 *   snapshotDiffers TEXTUALLY into the daemon source template via
 *   fn.toString() (same mechanism as __DAEMON_VERSION__), so each must survive
 *   a `new Function('return ' + fn.toString())()` round-trip.
 * - All helpers are declared INSIDE the function bodies (avoids bundler
 *   `__name`/`__publicField` helper injection); types are local interfaces
 *   (erased at compile time).
 * - Exception: foldLines is a TEST-ONLY convenience and deliberately calls the
 *   sibling exports; it is never injected into the daemon template.
 */

export interface SessionSnapshot {
  /** Byte offset in the stream file AFTER the last folded line
   *  (lineStart + byteLength + 1 — same formula as the L1 jsonl `v` events).
   *  Monotonic per session. THE idempotency coordinate. */
  v: number
  cliState: 'running' | 'idle' | 'waiting' | 'dead'
  /** A turn anchor was seen and the turn has not settled. */
  turnActive: boolean
  pendingPermission: { requestId: string; toolName?: string; sinceTs?: number } | null
  /** Non-backgrounded, non-terminal background tasks (#870 semantics). */
  gatingBgCount: number
  teamActive: boolean
  /** A CronCreate succeeded and no CronDelete removed it — the CLI's cron
   *  scheduler (/loop) is armed, so idle reapers must treat this session as
   *  deliberately long-running. Only the EXECUTION timer is in-process: a
   *  `durable:true` job also persists to {cwd}/.claude/scheduled_tasks.json and
   *  is directory-scoped, so it can outlive this session (see the INVARIANT
   *  block in daemon-core.ts — Walnut now denies durable creates). The disk
   *  side is a separate signal the fold cannot see: hasDiskCronInterest. */
  cronActive: boolean
  lastResult: { isError: boolean; numTurns?: number; endOffset: number } | null
  pid: number | null
  /** Normalized via isTurnCompleteExit by the daemon when dead. */
  exitCode: number | null
  /** Identity of the stream FILE the fold was computed over
   *  (`dev:ino:birthtimeMs` at open/adopt time). `v` is only comparable
   *  between snapshots of the SAME epoch: when the file is recreated (reboot
   *  wiped it, manual delete), byte offsets restart at 0 and every stored
   *  watermark from the previous incarnation is garbage — the consumer must
   *  reset its bookkeeping, not "win" with the stale higher offset
   *  (incident 019a7fe5: an 85 MB watermark from a dead file silently vetoed
   *  every snapshot of its 16 MB successor). null/absent = epoch unknown
   *  (stat failed, or the snapshot came from a pre-epoch daemon). */
  streamEpoch?: string | null
}

export interface FoldState {
  /** Offset after the last folded line. Never regresses. */
  v: number
  turnActive: boolean
  /** Ever saw turn-start evidence since (re)build: a turn anchor (real user
   *  line / init) or a session_state_changed{running}. A marker-less legacy
   *  send leaves state:running as the first visible trace of its turn, so
   *  running counts too — without it turnActive could never go true for such
   *  sessions (same blindness class as inc-1783644415695). */
  sawAnchor: boolean
  lastResult: SessionSnapshot['lastResult']
  /** session_state_changed{idle} seen after lastResult with no running since. */
  trailingIdle: boolean
  /** terminal-is-terminal for task_started/task_progress ONLY (a late/replayed
   *  start can't revive); task_updated/task_notification take their status
   *  VERBATIM, so a non-terminal status after a terminal one DOES revive the
   *  task and re-gate the turn. isBackgrounded sticky; endedPerLevel = a
   *  background_tasks_changed snapshot omitted this task after listing it
   *  (lost terminal bookend — excluded from gating, reversible). */
  bgTasks: Record<string, { terminal: boolean; isBackgrounded: boolean; endedPerLevel?: boolean }>
  /** Level universe for the #870 reconciliation: ids ever listed by a
   *  background_tasks_changed snapshot. Only these may be absent-marked
   *  (a live sync subagent is legitimately absent from every level payload). */
  seenInLevel: Record<string, 1>
  teamActive: boolean
  /** Live cron job ids: CronCreate confirmed by a non-error tool_result adds
   *  (keyed by the job id from tool_use_result, or the tool_use id when that
   *  is missing), CronDelete removes. UNLIKE bgTasks/teamActive this is NOT
   *  reset by a real user anchor — cron jobs deliberately span turns (that is
   *  the whole point of /loop). Does NOT participate in turn settle: a loop
   *  session goes legitimately idle between fires. Consumers: idle reapers,
   *  which must not kill a session whose scheduler is armed (a non-durable
   *  cron dies with the CLI process — but note `--resume` revives it from
   *  history, so a kill is never a reliable stop; only CronDelete is).
   *  Over-report is the safe
   *  direction (mirrors teamActive) — a CLI-side 7-day auto-expiry the fold
   *  cannot observe is backstopped by the reapers' extended-not-disabled
   *  threshold. */
  cronIds: Record<string, 1>
  /** CronCreate tool_use ids awaiting their tool_result (error results must
   *  not arm cronIds — a validation-rejected create schedules nothing). */
  pendingCronCreates: Record<string, 1>
}

export function initialFoldState(baseV?: number): FoldState {
  return {
    v: typeof baseV === 'number' && baseV > 0 ? baseV : 0,
    turnActive: false,
    sawAnchor: false,
    lastResult: null,
    trailingIdle: false,
    bgTasks: {},
    seenInLevel: {},
    teamActive: false,
    cronIds: {},
    pendingCronCreates: {},
  }
}

/**
 * Fold ONE complete stream-file line into the state. Pure: the input state is
 * never mutated; a new state is returned (bgTasks copied on write only).
 * `lineEndV` is the absolute byte offset after this line's trailing newline.
 * Torn/unparseable/unknown lines advance `v` only (the daemon feeds whole
 * lines, so torn handling is belt-and-suspenders).
 */
export function foldLine(state: FoldState, rawLine: string, lineEndV: number): FoldState {
  // ── helpers (declared inside: twin-safe toString round-trip, see header) ──
  // Mirrors BG_TERMINAL.has(status) in the reference — takes `unknown` on
  // purpose so a malformed non-string status behaves the same there and here
  // (Set.has of a non-member is false, i.e. non-terminal).
  const isTerminalStatus = (s: unknown): boolean =>
    s === 'completed' || s === 'failed' || s === 'stopped' || s === 'cancelled' || s === 'killed'
  // Port of isRealUserLine (session-reconcile.ts): accepts walnut-injected
  // delivery markers (the only trace a plain-text FIFO send leaves — the CLI
  // never echoes stdin user messages); rejects tool_result echoes and inline
  // Task-subagent lines (parent_tool_use_id) — both are emitted MID-turn and
  // anchoring on one folds from inside the turn (inc-1783644415695 class).
  const isRealUserLine = (p: { [k: string]: unknown }): boolean => {
    if (p.type !== 'user') return false
    if (p.subtype === 'walnut-injected') return true
    if (p.parent_tool_use_id) return false
    const msg = p.message as { content?: unknown } | undefined
    const content = msg ? msg.content : undefined
    if (typeof content === 'string') return true
    if (Array.isArray(content)) {
      return content.some((b) => b && typeof b === 'object' && (b as { type?: string }).type !== 'tool_result')
    }
    return false
  }
  const gatingCount = (bg: FoldState['bgTasks']): number => {
    let n = 0
    for (const id of Object.keys(bg)) {
      const t = bg[id]
      if (!t.terminal && !t.isBackgrounded && !t.endedPerLevel) n++
    }
    return n
  }

  // v is the idempotency coordinate — advanced for EVERY line, never regressed.
  const next: FoldState = {
    v: lineEndV > state.v ? lineEndV : state.v,
    turnActive: state.turnActive,
    sawAnchor: state.sawAnchor,
    lastResult: state.lastResult,
    trailingIdle: state.trailingIdle,
    bgTasks: state.bgTasks,
    seenInLevel: state.seenInLevel,
    teamActive: state.teamActive,
    cronIds: state.cronIds,
    pendingCronCreates: state.pendingCronCreates,
  }

  let parsed: { [k: string]: unknown }
  if (!rawLine) return next
  // Blank check WITHOUT allocating a trimmed copy: a whale tool_result line is
  // megabytes, and `rawLine.trim()` would copy all of it on every fold (the
  // tailer already trim-checks before calling us). Breaks at the first
  // non-space byte, so O(1) for real JSON lines.
  let sawContent = false
  for (let i = 0; i < rawLine.length; i++) {
    if (rawLine.charCodeAt(i) > 32) { sawContent = true; break }
  }
  if (!sawContent) return next
  // ── P6 prefilter: skip the JSON.parse for lines that cannot change fold
  // state. A whale turn is ~99% `stream_event` deltas (one per token) plus
  // multi-KB tool_result lines; parsing each one made the fold the most
  // expensive thing in the tailer (the L2 task-state feed has always used the
  // same substring trick). Only these needles can change state:
  //   '"type":"user"'   → turn anchor
  //   '"type":"system"' → init / session_state_changed / task_* / bg level
  //   '"type":"result"' → turn verdict
  //   'TeamCreate' / 'TeamDelete' → team gate. CAREFUL: team markers live
  //     INSIDE an assistant tool_use line, so an '"type":"assistant"' needle
  //     would be required otherwise — and that matches every assistant line,
  //     defeating the filter. Match the tool names directly instead.
  //   'CronCreate' / 'CronDelete' → cron gate, same in-assistant-line shape as
  //     the team markers (the CronCreate confirmation tool_result rides a
  //     '"type":"user"' line, already a needle).
  // The skip is gated on '"type":"' so it only applies to lines we positively
  // recognize as compact-typed JSON — what JSON.stringify emits, which is what
  // both the CLI's stream-json stdout and appendUserMarker write. A
  // differently-spaced line ('"type": "user"') falls through to the parse
  // rather than being silently dropped.
  if (rawLine.indexOf('"type":"') !== -1
    && rawLine.indexOf('"type":"user"') === -1
    && rawLine.indexOf('"type":"system"') === -1
    && rawLine.indexOf('"type":"result"') === -1
    && rawLine.indexOf('TeamCreate') === -1
    && rawLine.indexOf('TeamDelete') === -1
    && rawLine.indexOf('CronCreate') === -1
    && rawLine.indexOf('CronDelete') === -1) return next
  try { parsed = JSON.parse(rawLine) as { [k: string]: unknown } } catch { return next }
  if (!parsed || typeof parsed !== 'object') return next
  const type = parsed.type as string | undefined

  if (type === 'user') {
    // CronCreate confirmation: the tool_result echo (type:user) for a pending
    // CronCreate tool_use. Only a NON-error result arms cronIds — a
    // validation-rejected create (bad cron expr, job cap) schedules nothing.
    // Checked BEFORE the anchor reset below: a tool_result-only line is never
    // a real user line, and a mixed line (real text + tool_result) must both
    // arm the cron and reset the turn window.
    if (Object.keys(state.pendingCronCreates).length > 0) {
      const msg = parsed.message as { content?: unknown } | undefined
      const content = msg ? msg.content : undefined
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          const blk = b as { type?: string; tool_use_id?: string; is_error?: boolean }
          if (blk.type !== 'tool_result' || !blk.tool_use_id) continue
          if (!state.pendingCronCreates[blk.tool_use_id]) continue
          next.pendingCronCreates = { ...next.pendingCronCreates }
          delete next.pendingCronCreates[blk.tool_use_id]
          if (blk.is_error !== true) {
            // Prefer the CLI's job id (tool_use_result.id — what CronDelete
            // takes as input); fall back to the tool_use id so an armed cron
            // is never dropped just because the result shape changed.
            const tur = parsed.tool_use_result as { id?: unknown } | undefined
            const jobId = tur && typeof tur.id === 'string' ? tur.id : blk.tool_use_id
            next.cronIds = { ...next.cronIds }
            next.cronIds[jobId] = 1
          }
        }
      }
    }
    if (isRealUserLine(parsed)) {
      // Turn anchor: a new turn began — a prior result can no longer be the
      // current turn's verdict.
      next.sawAnchor = true
      next.lastResult = null
      next.trailingIdle = false
      // ── WINDOW RESET (contract §2 "Anchor resets the bg/team universe") ──
      // A REAL user line also resets the background-task map, the level
      // universe, and teamActive. Rationale: the reference foldSessionTail's
      // window STARTS at the last real user line, so pre-anchor bg/team state
      // is invisible to it by design; retaining it forward made the daemon
      // strictly MORE gated than the reference, and a bg task that never got
      // a terminal bookend AND was never listed by a background_tasks_changed
      // payload could never be healed (the level-reconcile universe guard
      // refuses to absent-mark a never-listed id — deliberately, because a
      // sync subagent is legitimately absent from every level payload). That
      // combination wedged turnActive=true for EVERY FUTURE TURN of the
      // session (executed repro: an orphan task_started in turn 3 kept turn
      // 4's clean result+idle from settling).
      // Safety of the reset: a genuinely-running cross-turn bg task re-enters
      // the fold on its next task_progress / task_updated /
      // background_tasks_changed line (the CLI emits progress for live tasks),
      // so gating self-heals within one event — whereas the wedge never healed.
      // Only a real user line resets: NOT init (auto-continuation of the same
      // work) and NOT state:running (mid-turn re-activation), both of which
      // are anchor-EQUIVALENT for sawAnchor but do not open a new user turn.
      // cronIds is deliberately NOT reset — cron jobs span turns by design.
      next.bgTasks = {}
      next.seenInLevel = {}
      next.teamActive = false
    }
    // tool_result echoes / subagent inline lines: v-only.
  } else if (type === 'system') {
    const subtype = parsed.subtype as string | undefined
    const taskId = parsed.task_id as string | undefined
    if (subtype === 'init') {
      // Anchor-equivalent: a new turn (or auto-continuation) began after that
      // result — it cannot be the current turn's verdict (inc-1783644415695).
      next.sawAnchor = true
      next.lastResult = null
      next.trailingIdle = false
    } else if (subtype === 'session_state_changed') {
      const s = parsed.state as string | undefined
      if (s === 'idle') {
        if (next.lastResult) next.trailingIdle = true
      } else if (s === 'running') {
        // Same invalidation as init: the CLI went back to work — that result
        // did not end the turn. Mid-turn workflow results (one per subagent)
        // are naturally superseded by the final result.
        next.sawAnchor = true
        next.lastResult = null
        next.trailingIdle = false
      }
      // requires_action is NOT folded here — pendingCtrl is intercepted
      // imperatively by the daemon tailer and joins in assembleSnapshot.
    } else if (taskId && (subtype === 'task_started' || subtype === 'task_progress')) {
      const prev = next.bgTasks[taskId]
      // Terminal is terminal: a late/replayed start or progress can't revive.
      next.bgTasks = { ...next.bgTasks }
      next.bgTasks[taskId] = {
        terminal: prev ? prev.terminal : false,
        isBackgrounded: prev ? prev.isBackgrounded : false,
      }
    } else if (taskId && subtype === 'task_updated') {
      const prev = next.bgTasks[taskId]
      const patch = parsed.patch as { [k: string]: unknown } | undefined
      const patchStatus = patch ? patch.status : undefined
      next.bgTasks = { ...next.bgTasks }
      next.bgTasks[taskId] = {
        // VERBATIM patch status — deliberately NOT terminal-is-terminal (that
        // stickiness belongs to task_started/task_progress only, above). The
        // reference takes `patch?.status ?? prev?.status ?? 'running'`
        // (session-reconcile.ts:331), so a non-terminal status arriving AFTER a
        // terminal one REVIVES the task and re-gates the turn. Adjudicated
        // 2026-08-05: premature settle is the unsafe direction — a revived gate
        // only holds the turn open (self-heals on the next terminal status),
        // whereas swallowing the revival wedges the record at 'idle' while the
        // CLI is still working.
        // `?? prev ?? 'running'` chain: only a null/undefined patch status
        // falls back to prev; an absent prev means 'running' → non-terminal.
        terminal: patchStatus !== undefined && patchStatus !== null
          ? isTerminalStatus(patchStatus)
          : prev ? prev.terminal : false,
        // Sticky: is_backgrounded=true detaches the task from gating forever.
        isBackgrounded: (patch ? patch.is_backgrounded === true : false) || (prev ? prev.isBackgrounded : false),
      }
    } else if (taskId && subtype === 'task_notification') {
      const prev = next.bgTasks[taskId]
      const status = (parsed.status as string | undefined) ?? 'completed'
      next.bgTasks = { ...next.bgTasks }
      next.bgTasks[taskId] = {
        // VERBATIM too, with no prev fallback at all: the reference is
        // `parsed.status ?? 'completed'` (session-reconcile.ts:338). A
        // non-terminal notification status revives a terminal task — same
        // adjudication as task_updated above.
        terminal: isTerminalStatus(status),
        isBackgrounded: prev ? prev.isBackgrounded : false,
      }
    } else if (subtype === 'background_tasks_changed') {
      // #870 level reconciliation, replay flavor — same rules as the live
      // handler: replace semantics, universe guard (only ever-listed ids may
      // be absent-marked), reversible mark, terminal untouched. Heals a lost
      // terminal bookend so gatingBgCount can settle a wedged turn.
      const levelTasks = parsed.tasks
      if (Array.isArray(levelTasks)) {
        const bg: FoldState['bgTasks'] = { ...next.bgTasks }
        const seen: FoldState['seenInLevel'] = { ...next.seenInLevel }
        const present: { [id: string]: 1 } = {}
        for (const t of levelTasks) {
          const id = (t as { task_id?: unknown } | null)?.task_id
          if (typeof id !== 'string') continue
          present[id] = 1
          seen[id] = 1
          const prev = bg[id]
          if (!prev) bg[id] = { terminal: false, isBackgrounded: false }
          else if (prev.endedPerLevel) bg[id] = { terminal: prev.terminal, isBackgrounded: prev.isBackgrounded }
        }
        for (const id of Object.keys(bg)) {
          if (present[id] || !seen[id]) continue
          const t = bg[id]
          if (t.terminal) continue
          bg[id] = { terminal: t.terminal, isBackgrounded: t.isBackgrounded, endedPerLevel: true }
        }
        next.bgTasks = bg
        next.seenInLevel = seen
      }
    }
  } else if (type === 'result') {
    // EVERY result — including origin:task-notification — is a turn verdict
    // HERE. The CLI's notification FOLLOWUP turn (bg task completes while
    // idle → CLI autonomously runs init + state:running + summary) opens an
    // anchor in this fold like any other turn, and its closing result carries
    // origin:task-notification. The previous exclusion ("bg-summary
    // bookkeeping, never turn-over" — mirroring the walnut-side handlers,
    // where it protects task-phase transitions) made the fold ASYMMETRIC:
    // anchor accepted, verdict refused → lastResult stayed null → the trailing
    // idle could never settle → turnActive=true forever. Under enforce the
    // snapshot is the sole status writer, so the record wedged at 'running'
    // for a CLI that was provably idle (incident b07ee156, 2026-08-14).
    // Safety: counting it here cannot end a LIVE turn prematurely — settle
    // still requires a trailing idle with zero gating work, and any subsequent
    // running/init resets lastResult. Walnut's live/phase handlers keep their
    // own task-notification exclusion; this fold only decides cliState.
    // endOffset rides the daemon `v` coordinate for the positional replay
    // veto downstream.
    const numTurns = parsed.num_turns
    next.lastResult = {
      isError: parsed.is_error === true,
      ...(typeof numTurns === 'number' ? { numTurns } : {}),
      endOffset: lineEndV,
    }
    next.trailingIdle = false // this result's own companion idle must still arrive
  } else if (type === 'assistant') {
    const msg = parsed.message as { content?: unknown } | undefined
    const blocks = msg ? msg.content : undefined
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (!b || typeof b !== 'object' || (b as { type?: string }).type !== 'tool_use') continue
        const name = (b as { name?: string }).name
        if (name === 'TeamCreate') next.teamActive = true
        else if (name === 'TeamDelete') next.teamActive = false
        else if (name === 'CronCreate') {
          // Arm on the tool_result confirmation (user-line branch above), not
          // here — the create can still be validation-rejected.
          const id = (b as { id?: string }).id
          if (id) {
            next.pendingCronCreates = { ...next.pendingCronCreates }
            next.pendingCronCreates[id] = 1
          }
        } else if (name === 'CronDelete') {
          // Optimistic removal on tool_use (before the result echo): the only
          // failure mode is "no such job", in which case the id was not in
          // cronIds anyway. Under-arming is acceptable here because the model
          // itself asked to cancel; the reaper resumes normal thresholds.
          const input = (b as { input?: { id?: unknown } }).input
          const id = input && typeof input.id === 'string' ? input.id : undefined
          if (id && next.cronIds[id]) {
            next.cronIds = { ...next.cronIds }
            delete next.cronIds[id]
          }
        }
      }
    }
  }

  // ── Settle — re-evaluated after EVERY line so a late un-gating transition
  // (bg task turning terminal, TeamDelete) settles the turn, and a late
  // gating one (task_started after idle) re-opens it. Matches foldSessionTail's
  // end-of-batch verdict for every prefix of the stream. An error result is
  // terminal WITHOUT a companion idle (the CLI can bail before emitting one).
  const settled = !!(next.lastResult && (next.lastResult.isError
    || (next.trailingIdle && gatingCount(next.bgTasks) === 0 && !next.teamActive)))
  next.turnActive = next.sawAnchor && !settled
  return next
}

/**
 * Combine the pure fold with imperatively-tracked daemon facts into the wire
 * snapshot. Pure over its input — the daemon wiring (pendingCtrl interception,
 * process liveness, isTurnCompleteExit normalization) happens in the caller.
 */
export function assembleSnapshot(input: {
  foldState: FoldState
  pendingCtrl: { requestId: string; toolName?: string; sinceTs?: number } | null
  dead: boolean
  pid: number | null
  exitCode: number | null
  /** Optional so pre-epoch call sites (and replayed cached inputs) stay valid. */
  streamEpoch?: string | null
}): SessionSnapshot {
  const s = input.foldState
  let gating = 0
  for (const id of Object.keys(s.bgTasks)) {
    const t = s.bgTasks[id]
    if (!t.terminal && !t.isBackgrounded && !t.endedPerLevel) gating++
  }
  const ctrl = input.pendingCtrl
  return {
    v: s.v,
    cliState: input.dead ? 'dead' : ctrl ? 'waiting' : s.turnActive ? 'running' : 'idle',
    turnActive: s.turnActive,
    pendingPermission: ctrl
      ? {
          requestId: ctrl.requestId,
          ...(ctrl.toolName !== undefined ? { toolName: ctrl.toolName } : {}),
          ...(ctrl.sinceTs !== undefined ? { sinceTs: ctrl.sinceTs } : {}),
        }
      : null,
    gatingBgCount: gating,
    teamActive: s.teamActive,
    cronActive: Object.keys(s.cronIds).length > 0,
    lastResult: s.lastResult ? { ...s.lastResult } : null,
    pid: input.pid,
    exitCode: input.exitCode,
    streamEpoch: input.streamEpoch ?? null,
  }
}

/**
 * Field compare ignoring bare `v` advance — a snapshot whose ONLY difference is
 * a bigger v carries no new state and must not be pushed (every streamed line
 * advances v; pushing on each would be a self-inflicted event storm across the
 * tunnel). Pure + zero-dep, so it lives here and is injected into the source
 * template like the fold trio — it used to be hand-duplicated in both twins,
 * where a one-sided edit (dropping a field from the compare = a silently
 * suppressed push) had no byte-level guard.
 */
export function snapshotDiffers(a: SessionSnapshot, b: SessionSnapshot): boolean {
  if (a.cliState !== b.cliState || a.turnActive !== b.turnActive
    || a.gatingBgCount !== b.gatingBgCount || a.teamActive !== b.teamActive
    || a.cronActive !== b.cronActive
    || a.pid !== b.pid || a.exitCode !== b.exitCode
    || (a.streamEpoch ?? null) !== (b.streamEpoch ?? null)) return true
  const ap = a.pendingPermission, bp = b.pendingPermission
  if (!!ap !== !!bp) return true
  if (ap && bp && (ap.requestId !== bp.requestId || ap.toolName !== bp.toolName || ap.sinceTs !== bp.sinceTs)) return true
  const ar = a.lastResult, br = b.lastResult
  if (!!ar !== !!br) return true
  if (ar && br && (ar.isError !== br.isError || ar.numTurns !== br.numTurns || ar.endOffset !== br.endOffset)) return true
  return false
}

/**
 * TEST-ONLY convenience: split complete lines and reduce with foldLine.
 * NOT injected into the daemon template (it references the sibling exports —
 * the daemon tailer feeds foldLine directly, one complete line at a time).
 * A trailing empty segment (content ending in '\n') is skipped; a final
 * unterminated segment (a torn tail) is folded as if complete but WITHOUT the
 * +1 newline byte it does not have — so `v` always equals the true byte length
 * of the consumed content. (foldSessionTail's cursor keeps the unconditional
 * +1; it is a tail-window scanner, not the `v` authority, so it is left alone.)
 */
export function foldLines(content: string, baseV?: number): FoldState {
  const byteLen = typeof Buffer !== 'undefined'
    ? (s: string): number => Buffer.byteLength(s, 'utf8')
    : (s: string): number => new TextEncoder().encode(s).length
  let state = initialFoldState(baseV)
  let v = state.v
  const parts = content.split('\n')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    const isLast = i === parts.length - 1
    if (isLast && line === '') break
    // split('\n') strips exactly one byte per terminated segment; the final
    // segment of a torn tail had no newline to strip.
    v += byteLen(line) + (isLast ? 0 : 1)
    state = foldLine(state, line, v)
  }
  return state
}
