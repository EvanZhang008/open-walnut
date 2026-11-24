/**
 * A session's folds over its stream file: the L2 task state (the background tasks a session's
 * lines report), the fold checkpoints both rebuilds resume from, the rebuilds of the fold and
 * the task state from a stream (C1), the size bounds the tailer and every fold share, and the
 * fold prewarm (`--prewarm-folds`) a new binary runs before it replaces a daemon.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; the tailer, the snapshot, the stream compaction, attach and resume, the idle
 * scan and Main read it through what it returns. The code is the runtime's as it was; deps carry
 * the runtime's own names.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { foldLine, initialFoldState, type FoldState } from './daemon-fold.js'
import { createFoldCheckpoint } from './fold-checkpoint-core.js'
import type { SessionData, TaskState, TaskStateEntry } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog } from './daemon-module-deps.js'

// Result of a fold rebuild: the folded state PLUS the byte offset of the last
// COMPLETE-line boundary it stopped at. Every adopt/attach/resume site must seed
// the watcher from `boundary`, never from a raw stat().size (contract §4
// "Rebuild boundary rule").
export interface FoldRebuild {
  state: FoldState
  /** Absolute offset after the last complete (newline-terminated) line. */
  boundary: number
}

export interface DaemonSessionFoldDeps {
  daemonEnv: DaemonEnv
  /** The session registry on disk (daemon-core.ts; made further down, so asked on use). */
  readRegistry: () => Record<string, { jsonlPath?: string } | undefined>
  /** The stream file's identity a checkpoint is written with (daemon-session-snapshot.ts; made further down). */
  streamEpochOf: (session: SessionData) => string | null
  logMsg: DaemonLog
}

export function createDaemonSessionFold(deps: DaemonSessionFoldDeps) {
  const { daemonEnv, readRegistry, streamEpochOf, logMsg } = deps

  // ── L2: daemon-authoritative per-session task state (the k8s `.status` object) ──
  // The daemon sits closest to the CLI and persists every event in the append-only jsonl, so
  // it is the natural source of truth for background-task state. It materializes `taskState`
  // by applying task_* events with the SAME idempotent, terminal-is-terminal rules Walnut uses
  // (so the two never disagree), and serves it on the `getState` RPC. Walnut PULLs it to
  // reconcile a lost-terminal event WITHOUT guessing liveness. `resourceVersion` = the event's
  // byte offset `v` — monotonic, and rebuildable from the jsonl after a daemon restart.
  // See docs/plan/daemon-source-of-truth-versioned-events.md.
  const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed'])
  const BG_TRANSITION_CAP = 50 // recentTransitions ring buffer bound

  function emptyTaskState(): TaskState {
    return { tasks: {}, resourceVersion: 0, updatedAt: 0, derivedRunning: 0, recentTransitions: [] }
  }

  // GATING count: tasks the CLI flagged is_backgrounded are excluded — the CLI's own
  // turn-end does not wait for them (it emits result+idle while they run), so a daemon
  // derivedRunning that counted one would veto Walnut's turn-over convergence for the
  // task's whole lifetime (incident 07fffbe5: a 16-min backgrounded grep).
  function runningTaskCount(ts: TaskState): number {
    let n = 0
    for (const id in ts.tasks) {
      if (ts.tasks[id].isBackgrounded) continue
      if (!BG_TERMINAL_STATUSES.has(ts.tasks[id].status)) n++
    }
    return n
  }

  // Apply one parsed jsonl line to the task state. Idempotent: duplicate / out-of-order /
  // new-kind events all converge. `v` is the line's byte-offset version; `now` is wall-clock.
  // Returns true if a task transition was recorded (for logging). Mirrors Walnut's four handlers.
  function applyTaskEvent(ts: TaskState, parsed: Record<string, unknown>, v: number, now: number): boolean {
    if (parsed.type !== 'system') return false
    const subtype = parsed.subtype as string | undefined
    const taskId = parsed.task_id as string | undefined
    if (!subtype || !taskId) return false
    const existing = ts.tasks[taskId]
    const toolUseId = typeof parsed.tool_use_id === 'string' && parsed.tool_use_id.length > 0 ? parsed.tool_use_id : undefined
    const differentInvocation = !!(toolUseId && existing?.toolUseId && existing.toolUseId !== toolUseId)
    if (differentInvocation && subtype !== 'task_started') return false
    const prev = differentInvocation ? undefined : existing
    let nextStatus: string | undefined
    let isBackgrounded = prev ? prev.isBackgrounded === true : false
    if (subtype === 'task_started') {
      if (parsed.is_backgrounded === true) isBackgrounded = true
      // Terminal is terminal: a late/duplicate start can't revive a finished task, except the CLI
      // starting the same call again (a parked background subagent goes on: bg-task-resume.ts).
      const resumed = parsed.is_backgrounded === true && !!toolUseId && toolUseId === prev?.toolUseId
      nextStatus = !resumed && prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
    } else if (subtype === 'task_progress') {
      nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
    } else if (subtype === 'task_updated') {
      const patch = parsed.patch as Record<string, unknown> | undefined
      const ps = patch?.status as string | undefined
      nextStatus = ps ?? prev?.status ?? 'running'
      // Sticky: is_backgrounded=true detaches the task from turn-over gating forever
      // (no CLI path un-backgrounds a task). See runningTaskCount.
      if (patch?.is_backgrounded === true) isBackgrounded = true
    } else if (subtype === 'task_notification') {
      nextStatus = (parsed.status as string | undefined) ?? prev?.status ?? 'running'
    } else {
      return false
    }
    const wasTerminal = prev ? BG_TERMINAL_STATUSES.has(prev.status) : false
    const isTerminal = BG_TERMINAL_STATUSES.has(nextStatus)
    ts.tasks[taskId] = { status: nextStatus, v, t: now, description: (parsed.description as string | undefined) ?? prev?.description, isBackgrounded: isBackgrounded || undefined, toolUseId: toolUseId ?? prev?.toolUseId }
    if (v > ts.resourceVersion) ts.resourceVersion = v
    ts.updatedAt = now
    // Only this entry changed, so the count moves by its own change: the same
    // number as a recount, without walking every task the session ever ran. The
    // recount per event made a rebuild quadratic in a long session's tasks
    // (2026-10-27: a 2.5 GB resume held the daemon for 214 s).
    // runningTaskCount's rule, for one entry.
    const gates = (t: TaskStateEntry | undefined): number => (t && !t.isBackgrounded && !BG_TERMINAL_STATUSES.has(t.status) ? 1 : 0)
    ts.derivedRunning = (ts.derivedRunning || 0) + gates(ts.tasks[taskId]) - gates(existing)
    // Record only genuine transitions into a terminal state (the bookend that matters for recovery).
    if (!wasTerminal && isTerminal) {
      ts.recentTransitions.push({ taskId, status: nextStatus, v, t: now })
      if (ts.recentTransitions.length > BG_TRANSITION_CAP) ts.recentTransitions.shift()
      return true
    }
    return false
  }

  // Rebuild task state from scratch by replaying the whole jsonl. Used on adopt/discover (a new
  // daemon generation has no in-memory state) — the jsonl is the durable log, so this recovers
  // the exact state the previous generation held, including any terminal events Walnut's live
  // stream missed. `v` is computed identically to the watcher (end-of-line byte offset).
  //
  // STREAMED, never readFileSync: the old whole-file read materialized a whale
  // jsonl (156MB observed) as one string + a split() array on every
  // attach/resume/adopt — RSS 104MB→789MB in ~30s before a silent Bun death
  // (the 2026-08-13 phone-send data-loss family). Same 1MB-chunk + byte-carry
  // shape as rebuildFoldStateFromJsonl; the '"task_' substring pre-filter means
  // almost no line is ever decoded.
  const TASK_LINE_MARKER = Buffer.from('"task_')

  // Fold checkpoints (fold-checkpoint-core.ts): both rebuilds below resume from
  // one, so a restart does not replay a whale stream from byte 0 before the
  // daemon listens.
  const foldCheckpoint = createFoldCheckpoint({
    fs, createHash: crypto.createHash, pid: process.pid,
    log: (level, msg, meta) => logMsg(level, msg, meta),
  })
  // A live session re-checkpoints after this much growth (see checkpointFolds).
  const FOLD_CHECKPOINT_EVERY_BYTES = 32 * 1024 * 1024
  const FOLD_CHECKPOINT_SWEEP_MS = 5 * 60_000

  /** Checkpoint where this session's fold stands. `force` skips the growth
   *  threshold (shutdown, death) and skips an unchanged fold only while its
   *  checkpoint is still on disk (something else may have deleted it). */
  function checkpointSessionFold(session: SessionData, force: boolean): void {
    const v = session.foldState.v
    const last = session.foldCheckpointV ?? 0
    if (v <= last && (!force || fs.existsSync(foldCheckpoint.pathFor(session.jsonlPath)))) return
    if (!force && v - last < FOLD_CHECKPOINT_EVERY_BYTES) return
    if (foldCheckpoint.write(session.jsonlPath, session.foldState, session.taskState, streamEpochOf(session))) {
      session.foldCheckpointV = v
    }
  }

  function rebuildTaskStateFromJsonl(jsonlPath: string, now: number): TaskState {
    // Resume from the fold checkpoint when it still describes this file.
    const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
    const ts = ck?.task ? foldCheckpoint.restampTaskState(ck.task, now) : emptyTaskState()
    let fd: number
    try { fd = fs.openSync(jsonlPath, 'r') } catch { return ts }
    try {
      const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
      let filePos = ck?.task ? ck.boundary : 0
      let v = filePos
      let carry: Buffer = Buffer.alloc(0)
      let discardThroughNextNewline = false
      for (;;) {
        const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
        if (n <= 0) break
        filePos += n
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        let start = 0
        for (;;) {
          const nl = chunk.indexOf(10, start)
          if (nl === -1) break
          v += (nl - start) + 1
          if (discardThroughNextNewline) discardThroughNextNewline = false
          // Byte-level pre-filter on JUST this line's slice (no copy): only
          // task_* lines are ever decoded to a string.
          else if (chunk.subarray(start, nl).includes(TASK_LINE_MARKER)) {
            const line = chunk.subarray(start, nl).toString('utf-8')
            if (line.trim() && line.includes('"task_')) {
              try { applyTaskEvent(ts, JSON.parse(line), v, now) } catch {}
            }
          }
          start = nl + 1
        }
        carry = Buffer.from(chunk.subarray(start))
        if (carry.length > TAILER_CARRY_MAX) {
          logMsg('error', 'task rebuild carry overflow — dropping oversized partial line', {
            jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
          })
          v = filePos
          carry = Buffer.alloc(0)
          discardThroughNextNewline = true
        }
      }
    } catch { /* partial rebuild is still safe — recent state wins on the live stream */ } finally {
      try { fs.closeSync(fd) } catch {}
    }
    return ts
  }

  // ── C1: session-snapshot fold (docs/plan/session-snapshot-source-of-truth.md §4) ──
  // The daemon folds the stream file line-by-line into an authoritative
  // SessionSnapshot (foldLine/assembleSnapshot from daemon-fold.ts) and pushes
  // {ev:'snapshot'} to subscribers on change. Coexists with taskState L2 —
  // retirement of L2 is C4's call.
  const SNAPSHOT_COALESCE_MS = 50

  // Upper bound on the tailer's in-memory torn-tail carry (see ensureWatcher).
  // A single stream line larger than this cannot be assembled, so we log and
  // realign rather than growing the buffer without limit.
  const TAILER_CARRY_MAX = 32 * 1024 * 1024
  // At most this much is read in one tailer tick. A large gap (a stalled loop, a
  // session that wrote while no tailer ran) is then read over several ticks instead
  // of in one allocation: stream files reach 3 GB, and the whole gap was one Buffer.
  const TAILER_TICK_READ_MAX = 8 * 1024 * 1024

  // Stream the whole jsonl through foldLine, from byte 0. Used by every rebuild
  // site (daemon start / adopt / attach-discover / resume / unknown-sid getState).
  // Reads in 1MB chunks and carries the torn tail as BYTES (a UTF-8 char split
  // across chunks must not be decoded twice) so whale files never materialize as
  // one string.
  //
  // A final unterminated segment (the CLI was mid-write when we read) is NOT
  // folded and NOT counted in `boundary` — same rule as the live tailer's carry.
  // Folding it would (a) parse a fragment as a whole line and (b) advance `v` past
  // the real line end, so when the newline finally arrives the tailer's
  // `v > foldState.v` guard skips the COMPLETE line forever. Reporting `boundary`
  // (rather than stat().size) is what lets the caller start the watcher on a line
  // boundary so the torn region is simply re-read.
  //
  // Carry cap: identical to the tailer's. A single line larger than the cap can't
  // be assembled, so we drop it and realign on the next newline instead of
  // re-concatenating an unbounded buffer (the old loop grew it with O(n²) copying).
  const FOLD_REBUILD_CHUNK = 1024 * 1024
  function rebuildFoldStateFromJsonl(jsonlPath: string): FoldRebuild {
    // A valid checkpoint IS the fold of every byte before its boundary, so the
    // rebuild continues from there (fold-checkpoint-core.ts).
    const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
    let state = ck ? ck.fold : initialFoldState(0)
    let fd: number
    // Running end-of-line byte offset — same coordinate as the tailer's v. Only
    // ever advanced past COMPLETE lines, so it doubles as the boundary.
    let v = ck ? ck.boundary : 0
    try { fd = fs.openSync(jsonlPath, 'r') } catch { return { state: initialFoldState(0), boundary: 0 } }
    try {
      const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
      let filePos = v
      let carry: Buffer = Buffer.alloc(0)
      let discardThroughNextNewline = false
      for (;;) {
        const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
        if (n <= 0) break
        filePos += n
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        let start = 0
        for (;;) {
          const nl = chunk.indexOf(10, start) // '\n'
          if (nl === -1) break
          v += (nl - start) + 1
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else {
            const line = chunk.subarray(start, nl).toString('utf-8')
            if (line.trim()) state = foldLine(state, line, v)
          }
          start = nl + 1
        }
        // Copy the torn tail — `buf` is reused by the next readSync.
        carry = Buffer.from(chunk.subarray(start))
        if (carry.length > TAILER_CARRY_MAX) {
          logMsg('error', 'fold rebuild carry overflow — dropping oversized partial line', {
            jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
          })
          v = filePos
          carry = Buffer.alloc(0)
          discardThroughNextNewline = true
        }
      }
      // A trailing unterminated fragment is deliberately left unfolded — see above.
    } catch { /* partial fold is still monotone-safe — serve what we have */ } finally {
      try { fs.closeSync(fd) } catch {}
    }
    return { state, boundary: v }
  }

  // ── Fold prewarm (`--prewarm-folds`, fold-checkpoint-core.ts) ──
  // Run by the server with the NEW binary before it replaces a running daemon of
  // another version, while that daemon still serves. Each registered session's
  // stream is folded once (both states in one pass, from the best checkpoint) and
  // saved as `<stream>.jsonl.fold.next`, so the new daemon's adopt folds only what
  // was written since. 2026-10-26: a checkpoint format change made the new daemon
  // fold 8.8 GB before it listened (7 min with no local sessions). Never touches a
  // session, the instance lock or a port.
  //
  // Progress is saved every FOLD_PREWARM_PROGRESS_BYTES and at the deadline the
  // server passes (WALNUT_FOLD_PREWARM_DEADLINE, epoch ms), so a run cut short
  // still leaves the next one, or the new daemon's adopt, less to fold.
  const FOLD_PREWARM_PROGRESS_BYTES = parseInt(daemonEnv.WALNUT_FOLD_PREWARM_PROGRESS_BYTES || '', 10) || 256 * 1024 * 1024
  const foldPrewarmDeadline = (): number => parseInt(daemonEnv.WALNUT_FOLD_PREWARM_DEADLINE || '', 10) || Infinity
  /** 'done' at the end of the file, 'cut' at the deadline (progress saved), 'failed' otherwise. */
  function prewarmFoldOne(jsonlPath: string, now: number): 'done' | 'cut' | 'failed' {
    const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
    const resume = ck && ck.task ? ck : null
    let state = resume ? resume.fold : initialFoldState(0)
    const ts = resume && resume.task ? foldCheckpoint.restampTaskState(resume.task, now) : emptyTaskState()
    let fd: number
    try { fd = fs.openSync(jsonlPath, 'r') } catch { return 'failed' }
    // The epoch of the file actually folded: a stream recreated meanwhile under
    // the same path must not be described by this fold.
    let epoch: string
    try {
      const st = fs.fstatSync(fd)
      epoch = st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs)
    } catch { try { fs.closeSync(fd) } catch {} return 'failed' }
    const deadline = foldPrewarmDeadline()
    let cut = false
    try {
      const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
      let filePos = resume ? resume.boundary : 0
      let v = filePos
      let saved = filePos
      let carry: Buffer = Buffer.alloc(0)
      let discardThroughNextNewline = false
      for (;;) {
        if (state.v - saved >= FOLD_PREWARM_PROGRESS_BYTES || Date.now() >= deadline) {
          if (foldCheckpoint.write(jsonlPath, state, ts, epoch, { next: true })) saved = state.v
          if (Date.now() >= deadline) { cut = true; break }
        }
        const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
        if (n <= 0) break
        filePos += n
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        let start = 0
        for (;;) {
          const nl = chunk.indexOf(10, start)
          if (nl === -1) break
          v += (nl - start) + 1
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else {
            const line = chunk.subarray(start, nl).toString('utf-8')
            if (line.trim()) {
              state = foldLine(state, line, v)
              if (line.includes('"task_')) {
                try { applyTaskEvent(ts, JSON.parse(line), v, now) } catch {}
              }
            }
          }
          start = nl + 1
        }
        carry = Buffer.from(chunk.subarray(start))
        if (carry.length > TAILER_CARRY_MAX) {
          logMsg('error', 'prewarm carry overflow, dropping oversized partial line', {
            jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
          })
          v = filePos
          carry = Buffer.alloc(0)
          discardThroughNextNewline = true
        }
      }
    } catch {
      // A read that failed mid-pass: keep only the progress already saved.
      return 'failed'
    } finally {
      try { fs.closeSync(fd) } catch {}
    }
    if (cut) return 'cut'
    return foldCheckpoint.write(jsonlPath, state, ts, epoch, { next: true }) ? 'done' : 'failed'
  }

  function prewarmFoldCheckpoints(): { sessions: number; written: number; cut: number; ms: number } {
    const startedAt = Date.now()
    let sessions = 0
    let written = 0
    let cut = 0
    // Largest first: a deadline then cuts the cheap ones, not the whale.
    const streams: Array<{ jsonlPath: string; size: number }> = []
    for (const entry of Object.values(readRegistry())) {
      const jsonlPath = entry && entry.jsonlPath
      if (typeof jsonlPath !== 'string' || !jsonlPath) continue
      sessions++
      try {
        const size = fs.statSync(jsonlPath).size
        if (size >= foldCheckpoint.minBytes) streams.push({ jsonlPath, size })
      } catch {}
    }
    streams.sort((a, b) => b.size - a.size)
    for (const { jsonlPath } of streams) {
      const outcome = prewarmFoldOne(jsonlPath, Date.now())
      if (outcome === 'done') written++
      else if (outcome === 'cut') { cut++; break }
    }
    const result = { sessions, written, cut, ms: Date.now() - startedAt }
    logMsg('info', 'fold prewarm done', result)
    return result
  }

  return { BG_TERMINAL_STATUSES, emptyTaskState, applyTaskEvent, TASK_LINE_MARKER, foldCheckpoint, FOLD_CHECKPOINT_SWEEP_MS, checkpointSessionFold, rebuildTaskStateFromJsonl, SNAPSHOT_COALESCE_MS, TAILER_CARRY_MAX, TAILER_TICK_READ_MAX, FOLD_REBUILD_CHUNK, rebuildFoldStateFromJsonl, prewarmFoldCheckpoints }
}
