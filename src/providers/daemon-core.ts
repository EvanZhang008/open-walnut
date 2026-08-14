/**
 * Daemon core primitives — pure functions with dependency injection.
 *
 * This module contains the lifecycle primitives (P1..P5 in the plan):
 *   P1  reapSession          — idempotent single death funnel
 *   P2  readRegistry / persistRegistry — write-ahead inventory
 *   P3  startOrphanPoll      — 1s adopted-session watchdog
 *   P4  reconcileRegistry    — startup adopt/reap sweep
 *   P5  broadcastSessionState — authoritative state channel
 *
 * All I/O + clock + process calls flow through the injected `deps` so the
 * functions are unit-testable in vitest without a real FIFO, SIGCHLD, or
 * /proc. The Bun adapter (daemon-standalone.ts) constructs this with real
 * deps; the embedded source template (daemon-source.ts) mirrors the same
 * behaviour for SSH-deployed daemons.
 */

import { execSync } from 'node:child_process'
import { join as pathJoin } from 'node:path'

// ── Shared types ──

/**
 * Permission modes. Mirrors core/types.ts SessionMode — the daemon can't import
 * from core/ (it ships as a standalone bun binary), so this is a deliberate
 * duplicate kept in sync by tests/providers/daemon-standalone-vs-source-parity.
 */
export type SessionMode = 'bypass' | 'plan' | 'accept' | 'default' | 'auto' | 'dontAsk'

/** Walnut mode id → `claude --permission-mode` value. Mirrors SESSION_MODE_CLI_MAP. */
export const MODE_CLI: Readonly<Record<SessionMode, string>> = {
  bypass: 'bypassPermissions',
  accept: 'acceptEdits',
  plan: 'plan',
  default: 'default',
  auto: 'auto',
  dontAsk: 'dontAsk',
}

export interface RegistryEntry {
  pid: number
  startTime: string | null
  pipePath: string
  jsonlPath: string
  pgidPath: string
  cwd: string
  args: string[]
  spawnedAt: string
  parented: boolean
  mode?: SessionMode
  pendingCtrl?: PendingCtrl | null
  /** Turn-retry streak (see decideTurnRetry). Persisted so a daemon restart
   *  mid-outage RESUMES the same 12h budget instead of granting a fresh one —
   *  otherwise a restart loop would make the budget unbounded. */
  turnRetry?: TurnRetryState | null
}

/**
 * The subset of session fields that core primitives read/write. The Bun
 * adapter's SessionData extends this with `proc`, `watchers`, and `offset`
 * fields that core doesn't need to know about.
 */
export interface PendingCtrl {
  reqId: string
  toolName: string
  request: Record<string, unknown>
  receivedAt: number
}

export interface CoreSessionData {
  pipePath: string
  jsonlPath: string
  pgidPath: string
  pid: number | null
  state: 'running' | 'dead'
  exitCode: number | null
  exitReason: string | null
  exitedAt: number | null
  parented: boolean
  startTime: string | null
  cwd: string
  args: string[]
  orphanPollTimer: ReturnType<typeof setInterval> | null
  mode: SessionMode
  pendingCtrl: PendingCtrl | null
  /** Turn-retry streak — see decideTurnRetry. Optional so adapters that don't
   *  implement the retry policy stay type-compatible. */
  turnRetry?: TurnRetryState
  /** ── TTFT instrumentation (inc-1786665503510) ──
   *  Epoch ms of the last FIFO send; the tailer logs "first stream_event after
   *  send" and "first text_delta after send" latencies against it, then clears
   *  it. This is the CLI-side half of the text-latency attribution: a big gap
   *  HERE is Bedrock TTFB / model behavior, not walnut's pipeline. Optional so
   *  test fixtures stay type-compatible. */
  ttftSendTs?: number | null
  /** One-shot flag: first stream_event line since ttftSendTs already logged. */
  ttftSawFirstLine?: boolean
}

export interface DaemonCoreDeps<S extends CoreSessionData = CoreSessionData> {
  fs: typeof import('node:fs')
  clock: () => number
  /** `process.kill(pid, sig)` — throws on ESRCH/EPERM. sig===0 is a liveness probe. */
  killFn: (pid: number, sig: number | string) => void
  /** Read /proc/<pid>/stat field 22 on Linux. Returns null on non-Linux or error. */
  readStartTimeFn: (pid: number) => string | null
  /** Send signal to an entire process group (pgid===pid for detached spawns). */
  killProcessGroupFn: (pid: number, signal: string) => boolean
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  setTimeoutFn?: typeof setTimeout
  streamsDir: string
  registryFile: string
  orphanPollIntervalMs?: number
  logger: (level: string, msg: string, meta?: Record<string, unknown>) => void
  /** Broadcasts `{ev:'session_state', sid, state, ...extra}` to all wsClients. */
  broadcastSessionStateFn: (payload: Record<string, unknown>) => void
  /**
   * Legacy exit fan-out to per-session watchers. Gets the session so adapter
   * can iterate `watchers`. Core doesn't know the watcher type.
   */
  broadcastExitToWatchersFn: (session: S, code: number, stderrTail: string | undefined) => void
  /** The live in-memory session map. Core reads/writes this directly. */
  sessions: Map<string, S>
  /**
   * Factory for materializing an adopted (orphan) session. Core calls this
   * during reconcileRegistry so the adapter can fill in its own extra fields
   * (watchers: new Map(), proc: null, offset: 0, ...).
   */
  createAdoptedSession: (sid: string, entry: RegistryEntry) => S
  /**
   * C1 session-snapshot hooks (docs/plan/session-snapshot-source-of-truth.md §4).
   * Optional so unit-test fixtures and pre-C1 adapters keep working unchanged.
   *
   * foldAppendedLineFn — fold a line the DAEMON just appended to the stream
   * file (appendUserMarker) into the session's fold state as a pure OPTIMISTIC
   * OVERLAY: folded at the CURRENT foldState.v with NO v advance, so the daemon
   * knows the turn started before the CLI echoes anything, yet no unread byte
   * range is ever skipped. Deliberately takes no offset — see
   * handleAppendUserMarker for why a post-append stat is unusable.
   */
  foldAppendedLineFn?: (session: S, rawLine: string) => void
  /**
   * pushSnapshotFn — assemble + push the session's snapshot to subscribers.
   * `immediate=true` skips the 50ms coalesce window (death paths). Core calls
   * it on reapSession (immediate), after appendUserMarker's fold, and when
   * handleSendRawCommand clears pendingCtrl; the adapter's tailer calls it
   * after each batch.
   */
  pushSnapshotFn?: (sid: string, immediate: boolean) => void
  /**
   * drainFoldFn (C18) — synchronously fold every COMPLETE line the tailer
   * hasn't reached yet, from the watcher's published boundary to EOF. Called by
   * reapSession BEFORE assembling the death snapshot: the CLI writes its final
   * `result` + companion `idle` microseconds before exiting, and the tailer's
   * poll does nothing once `state !== 'running'` — so without the drain the
   * death push (and every later getState pull, which re-assembles the same
   * frozen fold) reports turnActive=true for a turn that provably ended on
   * disk. Bounded by the tailer carry cap in the adapter.
   */
  drainFoldFn?: (session: S) => void
}

/** Outcome of a cmdSend attempt — mirrors the wire envelope sent to clients. */
export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'session_dead'; exitCode: number | null }
  | { ok: false; reason: 'ENXIO'; exitCode: number | null }
  | { ok: false; reason: 'EAGAIN'; retriable: true }
  | { ok: false; reason: 'partial_write' }
  | { error: string }  // missing sid/message or non-classified write failure

export interface DaemonCore<S extends CoreSessionData = CoreSessionData> {
  readRegistry: () => Record<string, RegistryEntry>
  persistRegistry: () => void
  readStartTime: (pid: number) => string | null
  reapSession: (sid: string, code: number, reason: string) => void
  startOrphanPoll: (sid: string) => void
  reconcileRegistry: () => void
  broadcastSessionState: (sid: string, state: 'running' | 'dead', extra?: Record<string, unknown>) => void
  /**
   * Strict-ack send handler. Takes sid + message, returns the SendResult the
   * client should receive. Side-effects: may call reapSession on precheck-dead
   * or ENXIO to converge the death funnel synchronously with the request.
   */
  handleSendCommand: (sid: string | undefined, message: string | undefined) => SendResult
  /**
   * Same as handleSendCommand but writes `raw` to the FIFO verbatim without
   * the `{type:"user",...}` wrapping. Used for control_response messages from
   * the --permission-prompt-tool stdio protocol — the CLI expects its own
   * control envelope and rejects anything wrapped in user-message shape.
   */
  handleSendRawCommand: (sid: string | undefined, raw: string | undefined) => SendResult
  /**
   * Append a walnut-injected user marker line to the session's stream file.
   * The CLI never echoes stdin user messages to its stream-json stdout, so
   * without this line the stream file records every turn's END (result) but
   * no turn's START — the reconciler's backward anchor scan then lands on a
   * PREVIOUS turn's user line and adopts that turn's stale result as the
   * current turn's verdict (incident inc-1783644415695). The daemon owns the
   * stream file, so it is the one writer that can place the marker at the
   * true delivery point. Returns the post-append file size (the delivery
   * watermark in the same byte coordinate as `v`/consumedOffset).
   */
  handleAppendUserMarker: (
    sid: string | undefined,
    message: string | undefined,
    messageId: string | undefined,
  ) => { ok: true; size: number } | { ok: false; reason: 'not_found' } | { error: string }
}

export function createDaemonCore<S extends CoreSessionData = CoreSessionData>(
  deps: DaemonCoreDeps<S>,
): DaemonCore<S> {
  const {
    fs,
    clock,
    killFn,
    readStartTimeFn,
    killProcessGroupFn,
    streamsDir,
    registryFile,
    logger,
    broadcastSessionStateFn,
    broadcastExitToWatchersFn,
    sessions,
    createAdoptedSession,
    foldAppendedLineFn,
    pushSnapshotFn,
    drainFoldFn,
  } = deps
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const orphanPollIntervalMs = deps.orphanPollIntervalMs ?? 1000

  /**
   * Read the last line of the JSONL output and decide whether the CLI
   * completed a turn cleanly. `claude -p --input-format stream-json` writes
   * a final {"type":"result","stop_reason":"end_turn"} line and then exits 0
   * at the end of every turn — so "last line is a result with stop_reason"
   * is the authoritative signal that the process died because the turn was
   * over, not because of a crash, OOM, or other failure.
   */
  function isTurnCompleteExit(jsonlPath: string): boolean {
    try {
      const stat = fs.statSync(jsonlPath)
      if (stat.size === 0) return false
      const readLen = Math.min(stat.size, 8192)
      const start = Math.max(0, stat.size - readLen)
      const fd = fs.openSync(jsonlPath, 'r')
      const buf = Buffer.alloc(readLen)
      fs.readSync(fd, buf, 0, readLen, start)
      fs.closeSync(fd)
      const text = buf.toString('utf-8')
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) return false
      const last = lines[lines.length - 1]
      const parsed = JSON.parse(last) as { type?: string; stop_reason?: string; subtype?: string }
      if (parsed.type !== 'result') return false
      // Accept any stop_reason that represents a CLI-initiated clean exit:
      // end_turn (normal), tool_use (completed after tool), max_tokens, etc.
      // Only reject if the line signals an outright error.
      if (parsed.subtype === 'error_max_turns' || parsed.subtype === 'error_during_execution') return false
      return true
    } catch {
      return false
    }
  }

  function readRegistry(): Record<string, RegistryEntry> {
    try {
      const raw = fs.readFileSync(registryFile, 'utf-8')
      const data = JSON.parse(raw)
      if (
        data
        && typeof data === 'object'
        && data.sessions
        && typeof data.sessions === 'object'
      ) {
        return data.sessions as Record<string, RegistryEntry>
      }
    } catch {}
    return {}
  }

  function persistRegistry(): void {
    const out: Record<string, RegistryEntry> = {}
    for (const [sid, s] of sessions) {
      if (s.state !== 'running' || !s.pid) continue
      out[sid] = {
        pid: s.pid,
        startTime: s.startTime,
        pipePath: s.pipePath,
        jsonlPath: s.jsonlPath,
        pgidPath: s.pgidPath,
        cwd: s.cwd,
        args: s.args,
        spawnedAt: new Date(clock()).toISOString(),
        parented: s.parented,
        mode: s.mode,
        pendingCtrl: s.pendingCtrl ?? undefined,
        // Carry the retry streak across daemon restarts (budget continuity).
        turnRetry: s.turnRetry ?? undefined,
      }
    }
    const body = JSON.stringify({ version: 1, sessions: out })
    const tmp = registryFile + '.tmp'
    try {
      fs.writeFileSync(tmp, body)
      try {
        const fd = fs.openSync(tmp, 'r+')
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } catch {}
      fs.renameSync(tmp, registryFile)
    } catch (err) {
      logger('warn', 'registry persist failed', { error: (err as Error).message })
    }
  }

  function broadcastSessionState(
    sid: string,
    state: 'running' | 'dead',
    extra: Record<string, unknown> = {},
  ): void {
    broadcastSessionStateFn({ sid, state, ...extra })
  }

  /**
   * Idempotent single death funnel. All death paths converge here:
   *   - proc.on('exit') SIGCHLD (parented sessions)
   *   - orphan poll ESRCH / pid-recycled (adopted sessions)
   *   - cmdSend ENXIO (FIFO write detected dead reader)
   *   - idle scanner missed-exit fallback
   *   - cmdStop (explicit user stop)
   *   - startup reconcile (dead pids, pid-recycled, not-ours)
   *
   * Guard `state === 'dead'` makes concurrent callers safe. Every step is
   * isolated in try/catch so an unlink race or missing file cannot wedge the
   * rest of cleanup (persist + broadcast must still run).
   */
  function reapSession(sid: string, code: number, reason: string): void {
    const session = sessions.get(sid)
    if (!session) return
    if (session.state === 'dead') return  // idempotent guard

    // Detect "clean turn completion": claude -p writes a final {"type":"result",
    // "stop_reason":"end_turn"} line then exits 0. Every death path here
    // (orphan-poll, send-precheck, send-enxio) can't see the real exit code
    // because the process was adopted (no ChildProcess handle) or died between
    // SIGCHLD and our poll. Inspect JSONL tail as the authoritative signal —
    // if the CLI finished a turn cleanly, report code=0 so the walnut client
    // treats this as a normal turn boundary, not an error.
    const cleanExit = isTurnCompleteExit(session.jsonlPath)
    // Age of JSONL matters: a fresh spawn that dies within a few seconds
    // almost certainly never wrote its own type:result, so `cleanExit=true`
    // would be reading the previous turn's residue. Log it so we can spot
    // mis-normalized deaths instead of silently changing code=-1 → 0.
    let jsonlAgeMs: number | null = null
    try { jsonlAgeMs = clock() - fs.statSync(session.jsonlPath).mtimeMs } catch {}
    if (cleanExit && code !== 0) {
      logger('info', 'reapSession: turn-complete detected, normalizing exit code', {
        sid, pid: session.pid, originalCode: code, originalReason: reason, jsonlAgeMs,
      })
      code = 0
      reason = reason + '+turn-complete'
    }

    // Emit state_transition BEFORE the mutation so any concurrent reader
    // observing logger output sees the transition intent before the fact.
    logger('info', 'state_transition', {
      sid,
      oldState: 'running',
      newState: 'dead',
      reason,
      source: 'reapSession',
      pid: session.pid,
      code,
      cleanExit,
      jsonlAgeMs,
    })
    session.state = 'dead'
    session.exitCode = code
    session.exitReason = reason
    session.exitedAt = clock()

    logger('info', 'reapSession', {
      sid, pid: session.pid, code, reason, cleanExit, jsonlAgeMs,
    })

    // Stop orphan watchdog if we were polling kill(pid,0) for this session.
    if (session.orphanPollTimer) {
      try { clearIntervalFn(session.orphanPollTimer) } catch {}
      session.orphanPollTimer = null
    }

    // Unlink FIFO — prevents future writers from thinking the session is alive.
    // kernel buffers on a readerless FIFO silently swallow writes; deleting the
    // path means next open(O_WRONLY|O_NONBLOCK) returns ENXIO instead.
    try { fs.unlinkSync(session.pipePath) } catch {}

    // ── Enforcement point 3 (opt-in, see block above isDurableCronRequest):
    // no adoptable durable crons. A durable task whose creator just died is
    // the 2026-08-09 incident in waiting: the next lock holder in this
    // directory would execute it as a bare user message. Strip our own rows
    // (never a live sibling's) — the only enforcement point the model cannot
    // decline. Gated on the same opt-in as points 1-2.
    if (session.cwd && process.env.WALNUT_ENFORCE_SESSION_CRON === '1'
      && process.env.WALNUT_ALLOW_DURABLE_CRON !== '1') {
      try {
        const tasksPath = pathJoin(session.cwd, '.claude', 'scheduled_tasks.json')
        let raw: string | null = null
        try { raw = fs.readFileSync(tasksPath, 'utf-8') } catch {}
        const strip = stripDurableTasksForSession(raw, sid)
        if (strip.changed && strip.text != null) {
          // Same-dir atomic replace (EXDEV-safe) so a concurrent CLI read never
          // sees a truncated file.
          const tmp = tasksPath + '.walnut-' + String(session.pid ?? 0) + '.tmp'
          fs.writeFileSync(tmp, strip.text, { mode: 0o600 })
          fs.renameSync(tmp, tasksPath)
          logger('warn', 'stripped dead session durable crons (Walnut policy: session-scoped only)', {
            sid, removed: strip.removed, tasksPath,
          })
        }
      } catch (err) {
        logger('warn', 'durable-cron strip failed', { sid, error: (err as Error).message })
      }
    }

    // Kill any residual process group members (MCP servers outliving claude).
    if (session.pid) {
      try { killProcessGroupFn(session.pid, 'SIGTERM') } catch {}
      setTimeoutFn(() => {
        if (session.pid) {
          try { killProcessGroupFn(session.pid, 'SIGKILL') } catch {}
        }
      }, 2000)
    }

    // Drain tail of stderr for diagnostics before broadcast.
    let stderrTail: string | undefined
    try {
      const errPath = session.jsonlPath + '.err'
      const errStat = fs.statSync(errPath)
      if (errStat.size > 0) {
        const readLen = Math.min(errStat.size, 4096)
        const start = Math.max(0, errStat.size - readLen)
        const fd = fs.openSync(errPath, 'r')
        const buf = Buffer.alloc(readLen)
        fs.readSync(fd, buf, 0, readLen, start)
        fs.closeSync(fd)
        stderrTail = buf.toString('utf-8').trim() || undefined
      }
    } catch {}

    // Persist registry change before broadcasting so a daemon crash between
    // broadcast and persist can't leave a stale entry pointing at a dead pid.
    try { persistRegistry() } catch {}

    // C18: DRAIN the tailer before assembling the death snapshot. The tailer's
    // poll returns early once state !== 'running' (set above), so the final
    // result/idle lines the CLI wrote microseconds before exiting would never be
    // folded — the death push and every later getState pull would serve a frozen
    // fold stuck at turnActive=true. Must run BEFORE pushSnapshotFn.
    if (drainFoldFn) { try { drainFoldFn(session) } catch {} }

    // C1: death snapshots push IMMEDIATELY (skip the 50ms coalesce), and MUST
    // run BEFORE the exit fan-out below — the adapter's exit broadcast clears
    // session.subscribers, so a later push would fan out to an empty set.
    // exitCode is already normalized via isTurnCompleteExit above.
    if (pushSnapshotFn) { try { pushSnapshotFn(sid, true) } catch {} }

    // Legacy exit fan-out to per-session watchers (backcompat).
    try { broadcastExitToWatchersFn(session, code, stderrTail) } catch {}

    // Authoritative session_state=dead to ALL clients.
    broadcastSessionState(sid, 'dead', { exitCode: code, reason, stderr: stderrTail })
  }

  /**
   * 1s orphan poll — adopted sessions have no ChildProcess, so SIGCHLD never
   * fires. Poll kill(pid,0) and /proc start_time instead. Parented sessions
   * don't need this (proc.on('exit') is ~0ms).
   */
  function startOrphanPoll(sid: string): void {
    const session = sessions.get(sid)
    if (!session) return
    if (session.state !== 'running') return
    if (!session.pid) return
    if (session.orphanPollTimer) return  // idempotent
    const pid = session.pid
    const capturedStartTime = session.startTime
    logger('info', 'startOrphanPoll: started', { sid, pid, startTime: capturedStartTime })
    const timer = setIntervalFn(() => {
      const s = sessions.get(sid)
      if (!s || s.state !== 'running') {
        if (s?.orphanPollTimer) {
          try { clearIntervalFn(s.orphanPollTimer) } catch {}
          s.orphanPollTimer = null
        }
        return
      }
      // Stale-timer guard: if cmdStart replaced the session under us, this
      // interval's captured `pid` no longer matches `s.pid`. Do NOT reap —
      // the newer session has its own lifecycle. Just self-terminate.
      //
      // Before this guard, a stale timer from an adopted orphan would still
      // be comparing the captured (old) pid's /proc start_time against the
      // freshly-written s.startTime (new pid), see them differ, and mis-fire
      // `reapSession(sid, -1, 'pid-recycled')` — killing the newborn CLI
      // while the old pid kept running unreaped. Symptom: every `--resume`
      // spawn died ~1s after starting with reason `pid-recycled+turn-complete`.
      if (s.pid !== pid) {
        logger('warn', 'orphan poll: stale timer detected (session replaced), self-terminating', {
          sid, capturedPid: pid, currentPid: s.pid,
        })
        try { clearIntervalFn(timer) } catch {}
        // Don't null s.orphanPollTimer — it belongs to the new session now.
        return
      }
      try { killFn(pid, 0) } catch {
        logger('info', 'orphan poll: kill(pid,0) ESRCH — reaping', { sid, pid })
        reapSession(sid, -1, 'orphan-poll-dead')
        return
      }
      // PID recycling defence: different start_time means the kernel handed
      // the pid to somebody else after the original CLI died.
      if (capturedStartTime) {
        const current = readStartTimeFn(pid)
        if (current && current !== capturedStartTime) {
          logger('warn', 'orphan poll: pid recycled (start_time drift) — reaping', {
            sid, pid, captured: capturedStartTime, current,
          })
          reapSession(sid, -1, 'pid-recycled')
        }
      }
    }, orphanPollIntervalMs)
    session.orphanPollTimer = timer
  }

  /**
   * Startup reconcile. Reads on-disk registry, probes each pid, and adopts
   * the living ones as orphans or reaps the dead/recycled/not-ours ones.
   * Also sweeps zombie FIFOs out of the streams directory.
   */
  function reconcileRegistry(): void {
    const registry = readRegistry()
    for (const [sid, entry] of Object.entries(registry)) {
      const pid = entry.pid
      if (!pid || pid <= 0) continue

      // Re-entrant safety: if a session is already in the map (previous
      // reconcile or in-flight spawn), don't overwrite it — that would leak
      // the existing orphanPollTimer and re-broadcast adopted=true.
      if (sessions.has(sid)) continue

      // Materialize session record first so reapSession has something to act
      // on. Adapter's factory fills in its own extra fields (watchers, ...).
      const session = createAdoptedSession(sid, entry)
      sessions.set(sid, session)

      // Is the pid alive and ours?
      try {
        killFn(pid, 0)
      } catch (err) {
        const errCode = (err as NodeJS.ErrnoException).code
        if (errCode === 'EPERM') {
          reapSession(sid, -1, 'reconcile-not-ours')
          continue
        }
        // ESRCH or other — dead.
        reapSession(sid, -1, 'reconcile-dead')
        continue
      }

      // Alive and ours — verify start_time to catch pid recycling.
      if (entry.startTime) {
        const current = readStartTimeFn(pid)
        if (current && current !== entry.startTime) {
          reapSession(sid, -1, 'reconcile-pid-recycled')
          continue
        }
      }

      // Genuine orphan — adopt and kick off 1s tight poll.
      logger('info', 'state_transition', {
        sid,
        oldState: 'none',
        newState: 'running',
        reason: 'reconcile-adopt',
        source: 'reconcileRegistry',
        pid,
      })
      logger('info', 'reconcile: adopted orphan session', { sid, pid })
      startOrphanPoll(sid)
      broadcastSessionState(sid, 'running', { pid, adopted: true })
    }

    // Zombie FIFO sweep — unlink *.pipe files in streams dir that don't
    // belong to a registered session. Prevents unbounded file growth across
    // crash/restart cycles.
    try {
      const files = fs.readdirSync(streamsDir)
      for (const f of files) {
        if (!f.endsWith('.pipe')) continue
        const sid = f.replace('.pipe', '')
        if (!sessions.has(sid)) {
          try { fs.unlinkSync(`${streamsDir}/${f}`) } catch {}
        }
      }
    } catch {}
  }

  /**
   * Strict-ack send handler. Core owns the branching logic (not_found /
   * session_dead / precheck-dead / ENXIO / EAGAIN / partial / OK); adapters
   * own the FIFO write path (provided via writeFifoFn) and the wire dispatch.
   */
  function handleSendCommand(sid: string | undefined, message: string | undefined): SendResult {
    if (!sid || !message) return { error: 'send: missing sid or message' }

    const session = sessions.get(sid)
    if (!session) return { ok: false, reason: 'not_found' }
    if (session.state === 'dead') {
      return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
    }

    // Pre-flight kill(pid,0) for hot-path death detection. If kill throws, the
    // process already died — reap now and return session_dead so the caller
    // doesn't try (and fail) to write the FIFO.
    if (session.pid) {
      try {
        killFn(session.pid, 0)
      } catch {
        reapSession(sid, -1, 'send-precheck-dead')
        return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
      }
    }

    // FIFO write — adapter can plug in a different writer, but the default
    // (see daemon-standalone.ts) is fs.openSync + writeSync + closeSync.
    try {
      const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: message } })
      const buf = Buffer.from(payload + '\n')
      const result = writeFifoFully(session.pipePath, buf)
      if (result === 'ok') {
        // TTFT anchor: the tailer logs send→first-line / send→first-text
        // latencies against this (CLI-side half of the text-latency attribution).
        session.ttftSendTs = clock()
        session.ttftSawFirstLine = false
        return { ok: true }
      }
      if (result === 'ENXIO') {
        reapSession(sid, -1, 'send-enxio')
        return { ok: false, reason: 'ENXIO', exitCode: session.exitCode }
      }
      if (result === 'EAGAIN') return { ok: false, reason: 'EAGAIN', retriable: true }
      // partial_write here means we wrote a prefix but couldn't finish within the
      // retry budget — pipe is now corrupted (CLI's stdin parser will choke on
      // the truncated JSON). Treat as terminal: reap so caller sees session_dead.
      reapSession(sid, -1, 'send-partial-write')
      return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
    } catch (err) {
      return { error: 'send failed: ' + (err as Error).message }
    }
  }

  /**
   * Raw FIFO write — bypasses the `{type:"user",...}` envelope. Caller provides
   * a complete JSON line (e.g. a control_response for --permission-prompt-tool).
   * Shares the pre-flight kill check, ENXIO death-funnel, and EAGAIN retry
   * semantics with handleSendCommand.
   */
  function handleSendRawCommand(sid: string | undefined, raw: string | undefined): SendResult {
    if (!sid || !raw) return { error: 'sendRaw: missing sid or raw' }

    const session = sessions.get(sid)
    if (!session) return { ok: false, reason: 'not_found' }
    if (session.state === 'dead') {
      return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
    }

    if (session.pid) {
      try {
        killFn(session.pid, 0)
      } catch {
        reapSession(sid, -1, 'sendRaw-precheck-dead')
        return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
      }
    }

    try {
      const buf = Buffer.from(raw.endsWith('\n') ? raw : raw + '\n')
      const result = writeFifoFully(session.pipePath, buf)
      if (result === 'ok') {
        // control_response travels Walnut → FIFO and is not echoed to stdout,
        // so the stream watcher cannot observe it. Clear daemon-authoritative
        // pending state here, but only after the complete line was delivered.
        if (session.pendingCtrl) {
          try {
            const parsed = JSON.parse(raw.trim()) as {
              type?: string
              response?: { request_id?: string }
            }
            if (parsed.type === 'control_response'
              && parsed.response?.request_id === session.pendingCtrl.reqId) {
              const requestId = session.pendingCtrl.reqId
              session.pendingCtrl = null
              persistRegistry()
              logger('info', 'sendRaw cleared pending control_response', { sid, requestId })
              // C1: pendingCtrl cleared → snapshot changes (waiting → running/idle).
              if (pushSnapshotFn) { try { pushSnapshotFn(sid, false) } catch {} }
            }
          } catch { /* non-JSON raw payload — nothing to acknowledge */ }
        }
        return { ok: true }
      }
      if (result === 'ENXIO') {
        reapSession(sid, -1, 'sendRaw-enxio')
        return { ok: false, reason: 'ENXIO', exitCode: session.exitCode }
      }
      if (result === 'EAGAIN') return { ok: false, reason: 'EAGAIN', retriable: true }
      reapSession(sid, -1, 'sendRaw-partial-write')
      return { ok: false, reason: 'session_dead', exitCode: session.exitCode }
    } catch (err) {
      return { error: 'sendRaw failed: ' + (err as Error).message }
    }
  }

  /**
   * Turn-start marker append — see DaemonCore interface doc. Shape matches
   * ClaudeCodeSession.writeSyntheticUserEvent's local fallback exactly, so
   * every existing dedup layer (walnutMessageId strip in session-history,
   * id-first optimistic consumption in the web UI, tailer responsive-timer
   * exclusion) applies unchanged. Deliberately does NOT touch the FIFO path.
   */
  function handleAppendUserMarker(
    sid: string | undefined,
    message: string | undefined,
    messageId: string | undefined,
  ): { ok: true; size: number } | { ok: false; reason: 'not_found' } | { error: string } {
    if (!sid || !message || !messageId) return { error: 'appendUserMarker: missing sid, message, or messageId' }
    const session = sessions.get(sid)
    if (!session) return { ok: false, reason: 'not_found' }
    try {
      const line = JSON.stringify({
        type: 'user',
        subtype: 'walnut-injected',
        message: { role: 'user', content: message },
        walnutMessageId: messageId,
        timestamp: new Date(clock()).toISOString(),
      }) + '\n'
      fs.appendFileSync(session.jsonlPath, line)
      const size = fs.statSync(session.jsonlPath).size
      // C1 (contract §4 "Feed"): fold the marker immediately as a pure
      // OPTIMISTIC OVERLAY — at the CURRENT foldState.v, with NO v advance.
      // The daemon knows the turn started before the CLI echoes anything, and
      // the tailer re-folds the same marker later at its TRUE v (a double-fold
      // is a safe re-anchor: re-anchoring an anchored state is idempotent, and
      // file order still ends with the marker, so every interleaving converges).
      //
      // Do NOT pass `size` as the marker's lineEndV: the CLI appends
      // concurrently, so a line can land between appendFileSync and statSync
      // (executed repro). `size` would then be INFLATED past the raced line, and
      // the tailer's `v > foldState.v` guard would skip that raced result/idle
      // forever → snapshot wedged at turnActive=true. No gap catch-up either:
      // with no v advance there is no gap to catch up.
      if (foldAppendedLineFn) {
        try {
          foldAppendedLineFn(session, line.slice(0, -1))
          if (pushSnapshotFn) pushSnapshotFn(sid, false)
        } catch {}
      }
      return { ok: true, size }
    } catch (err) {
      return { error: 'appendUserMarker failed: ' + (err as Error).message }
    }
  }

  /**
   * Write a full buffer to a FIFO using O_NONBLOCK + retry loop. Required for
   * payloads larger than PIPE_BUF (512 bytes on macOS): a single non-blocking
   * writeSync may return a partial count, and stopping there leaves the pipe
   * in a corrupted state (the reader's line parser will splice the truncated
   * fragment into whatever bytes arrive next, causing JSON.parse to fail and
   * the CLI to exit). We loop on partial writes and short-retry on EAGAIN so
   * either the whole buffer lands atomically or we surface ENXIO/EAGAIN.
   *
   * Returns 'ok' on full write, 'ENXIO' if reader is gone, 'EAGAIN' if the
   * pipe stayed full past the retry budget without progress, or 'partial' if
   * we made some progress but couldn't finish (caller should reap — pipe now
   * holds half a JSON line).
   */
  function writeFifoFully(pipePath: string, buf: Buffer): 'ok' | 'ENXIO' | 'EAGAIN' | 'partial' {
    let fd: number
    try {
      fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENXIO') return 'ENXIO'
      throw err
    }
    try {
      let offset = 0
      let consecutiveEagain = 0
      const MAX_EAGAIN_RETRIES = 50  // ~500ms total at 10ms per retry
      while (offset < buf.length) {
        try {
          const n = fs.writeSync(fd, buf, offset, buf.length - offset)
          if (n > 0) {
            offset += n
            consecutiveEagain = 0
            continue
          }
          // n === 0 shouldn't happen on a pipe but guard anyway
          consecutiveEagain++
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EAGAIN') {
            if (offset === 0 && consecutiveEagain === 0) return 'EAGAIN'
            consecutiveEagain++
          } else {
            throw err
          }
        }
        if (consecutiveEagain >= MAX_EAGAIN_RETRIES) {
          return offset === 0 ? 'EAGAIN' : 'partial'
        }
        // Brief sync sleep to let the reader drain. Keeps the FIFO write
        // atomic from the daemon's RPC handler perspective.
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch {}
      }
      return 'ok'
    } finally {
      try { fs.closeSync(fd) } catch {}
    }
  }

  return {
    readRegistry,
    persistRegistry,
    readStartTime: readStartTimeFn,
    reapSession,
    startOrphanPoll,
    reconcileRegistry,
    broadcastSessionState,
    handleSendCommand,
    handleSendRawCommand,
    handleAppendUserMarker,
  }
}

/**
 * Default readStartTime implementation — reads /proc/<pid>/stat field 22 on
 * Linux, returns null on macOS and anywhere /proc isn't available.
 *
 * Exposed so the Bun adapter and unit-test fixtures can share one impl.
 */
/**
 * Permission policy: should the daemon auto-respond to a control_request?
 * Returns true if daemon should write allow response directly to FIFO.
 */
export function shouldAutoRespond(mode: SessionMode, toolName: string | undefined): boolean {
  // AskUserQuestion is a requiresUserInteraction tool: the CLI emits its
  // control_request even in bypassPermissions (checkPermissions always returns
  // 'ask'), and the tool echoes its 'answers' field back out of the permission
  // response's updatedInput. Auto-allowing therefore replies with NO answers, and
  // the CLI reports a fabricated "user answered your questions" (empty) result
  // to the model. Forward it to walnut so the human actually answers.
  if (toolName === 'AskUserQuestion') return false
  if (mode === 'bypass') return true
  // ExitPlanMode is forwarded to walnut (not auto-allowed) because in `-p` mode
  // the CLI returns is_error=true for this tool, requiring interactive approval.
  // Auto-allowing would send a false "plan complete" signal.
  if (mode === 'plan') return toolName !== 'ExitPlanMode'
  // 'auto' and 'dontAsk' fall through to false ON PURPOSE. Measured on CLI
  // 2.1.220: both decide internally and emit NO control_request at all (auto
  // auto-allowed a Write and even a piped-curl Bash; dontAsk refused the Write
  // itself), so this branch is normally unreachable for them. If the auto-mode
  // classifier ever does escalate to a prompt, the user must see it — silently
  // auto-allowing would turn "safer YOLO" into full bypass.
  return false
}

/**
 * Build the control_response JSON for writing to the FIFO.
 * Format must match claude-code-session.ts respondToControlRequest().
 */
export function buildControlResponse(requestId: string, request: Record<string, unknown>, allow: boolean, message?: string): string {
  const result = allow
    ? { behavior: 'allow' as const, updatedInput: request.input ?? {} }
    : { behavior: 'deny' as const, message: message ?? 'Permission denied by daemon policy' }
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: result,
    },
  })
}

// ── Scheduled-task (Claude Code cron) fire detection ──
//
// The CLI persists recurring crons to {cwd}/.claude/scheduled_tasks.json and
// scopes the scheduler LOCK to the project directory, not the session. When
// the creating session's PID looks dead, the current lock holder ADOPTS the
// task and executes its prompt as a bare user message — with no marker in
// headless mode (incident 2026-08-09: session B ran session A's multi-hour
// production KB sync believing the human asked for it; upstream
// anthropics/claude-code#50300 / #66509, both auto-closed).
//
// The daemon can't prevent the adoption (upstream), but it CAN observe it:
// a fire bumps the task's `lastFiredAt`, and only the lock-holding session
// executes it. Detection is therefore ordering-immune — no dependence on
// stream line order, just "a task in MY cwd fired recently, I hold the lock,
// and someone else created it".
//
// Pure parse+decide; adapters read the files and act (append a
// scheduled_task_fire marker to the stream file; inject a provenance warning
// into the FIFO for foreign fires). Mirrored verbatim in daemon-source.ts —
// parity test locks the sync.

/** How far back a lastFiredAt still counts as "this just fired into us".
 *  Generous on purpose: detection runs on a 30s throttle inside the tailer,
 *  and a daemon restart mid-turn must still catch an in-flight adopted fire
 *  (the `warned` dedup map is in-memory only). */
export const CRON_FIRE_RECENT_MS = 10 * 60 * 1000

export interface DetectedCronFire {
  taskId: string
  lastFiredAt: number
  createdBySessionId: string | undefined
  /** true = created by a DIFFERENT session — the dangerous adopted case. */
  foreign: boolean
  promptPreview: string
}

export function detectCronFires(args: {
  sid: string
  /** Raw text of {cwd}/.claude/scheduled_tasks.json, or null if unreadable. */
  tasksJson: string | null
  /** Raw text of {cwd}/.claude/scheduled_tasks.lock, or null if unreadable. */
  lockJson: string | null
  nowMs: number
  /** Dedup map, mutated in place: `${taskId}:${lastFiredAt}` → nowMs. */
  warned: Record<string, number>
  recentMs?: number
}): DetectedCronFire[] {
  if (!args.tasksJson) return []
  // Only the scheduler-lock holder executes fires. Without this gate, every
  // session sharing the cwd would self-report the same fire.
  let lockSid: string | undefined
  if (args.lockJson) {
    try { lockSid = (JSON.parse(args.lockJson) as { sessionId?: string }).sessionId } catch {}
  }
  if (lockSid !== args.sid) return []
  let tasks: Array<Record<string, unknown>>
  try {
    const parsed = JSON.parse(args.tasksJson) as { tasks?: unknown }
    tasks = Array.isArray(parsed?.tasks) ? parsed.tasks as Array<Record<string, unknown>> : []
  } catch { return [] }
  const recentMs = args.recentMs ?? CRON_FIRE_RECENT_MS
  const out: DetectedCronFire[] = []
  for (const t of tasks) {
    const id = typeof t?.id === 'string' ? t.id : null
    const fired = typeof t?.lastFiredAt === 'number' ? t.lastFiredAt : null
    if (!id || !fired) continue
    // Recent past only (small future tolerance for clock skew).
    if (args.nowMs - fired > recentMs || fired > args.nowMs + 60_000) continue
    const key = id + ':' + fired
    if (args.warned[key]) continue
    args.warned[key] = args.nowMs
    const creator = typeof t?.createdBySessionId === 'string' ? t.createdBySessionId : undefined
    out.push({
      taskId: id,
      lastFiredAt: fired,
      createdBySessionId: creator,
      foreign: creator !== undefined && creator !== args.sid,
      promptPreview: typeof t?.prompt === 'string' ? (t.prompt as string).slice(0, 160) : '',
    })
  }
  return out
}

/** The CLI auto-expires recurring crons 7 days after creation (fires once
 *  more, then deletes). A task older than that is dead weight — counting it
 *  would make the idle-reaper protection immortal. lastFiredAt also counts
 *  as liveness proof: a fire resets the "still worth protecting" clock. */
export const CRON_TASK_LIVE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Disk-side cron interest for the idle reaper — the second signal beside the
 * chat-stream fold. The fold only sees CronCreate tool_use lines in THIS
 * stream file; it goes blind when the stream was wiped/rebuilt, when the cron
 * was created before a --resume respawn (history replay re-arms the CLI's
 * in-memory scheduler but emits no new CronCreate line — verified in the
 * 2026-08-10 lab, P4b), or when this session ADOPTED a foreign durable task.
 * Durable tasks live in {cwd}/.claude/scheduled_tasks.json, so read the truth
 * from disk. A session has cron interest when:
 *   - 'creator': it created a live task (createdBySessionId === sid). It will
 *     schedule its own tasks with or without the lock (lab P3).
 *   - 'lock_holder': it holds the scheduler lock while live tasks exist — it
 *     is the one that will execute (or adopt) the next fire.
 * Pure parse+decide; mirrored verbatim in daemon-source.ts (parity-tested).
 */
export function hasDiskCronInterest(args: {
  sid: string
  tasksJson: string | null
  lockJson: string | null
  nowMs: number
  liveMs?: number
}): { armed: boolean; reason: 'creator' | 'lock_holder' | null; liveTasks: number } {
  if (!args.tasksJson) return { armed: false, reason: null, liveTasks: 0 }
  let tasks: Array<Record<string, unknown>>
  try {
    const parsed = JSON.parse(args.tasksJson) as { tasks?: unknown }
    tasks = Array.isArray(parsed?.tasks) ? parsed.tasks as Array<Record<string, unknown>> : []
  } catch { return { armed: false, reason: null, liveTasks: 0 } }
  const liveMs = args.liveMs ?? CRON_TASK_LIVE_MS
  let live = 0
  let createdByMe = false
  for (const t of tasks) {
    const createdAt = typeof t?.createdAt === 'number' ? t.createdAt : 0
    const lastFiredAt = typeof t?.lastFiredAt === 'number' ? t.lastFiredAt : 0
    const freshest = Math.max(createdAt, lastFiredAt)
    if (!freshest || args.nowMs - freshest > liveMs) continue
    live++
    if (t?.createdBySessionId === args.sid) createdByMe = true
  }
  if (live === 0) return { armed: false, reason: null, liveTasks: 0 }
  if (createdByMe) return { armed: true, reason: 'creator', liveTasks: live }
  let lockSid: string | undefined
  if (args.lockJson) {
    try { lockSid = (JSON.parse(args.lockJson) as { sessionId?: string }).sessionId } catch {}
  }
  if (lockSid === args.sid) return { armed: true, reason: 'lock_holder', liveTasks: live }
  return { armed: false, reason: null, liveTasks: live }
}

// ── INVARIANT: Walnut sessions create SESSION-SCOPED crons only ──
//
// `CronCreate({durable: true})` writes the job to {cwd}/.claude/scheduled_tasks.json,
// and the CLI's scheduler LOCK is scoped to that directory — not to the session.
// Behavior model, established by controlled experiment (2026-08-10 lab, CLI
// 2.1.224, report + evidence in the incident memo):
//
//   durable:false (CLI default) — in-memory only. Dies with the process; NO other
//     session can adopt it. A `--resume` DOES revive it (history replay rebuilds
//     the in-memory schedule and immediately fires anything overdue — lab P4b), so
//     killing a process is never a reliable way to stop a cron; only CronDelete is.
//   durable:true — on disk, project-scoped. When the creator's PID looks dead, the
//     current lock holder ADOPTS the job and its model executes the prompt as a
//     bare user message with no provenance (lab P2 = the 2026-08-09 incident). The
//     creator reclaims it on resume (lab P3), but every gap is an adoption window,
//     and the weekly host patch-reboot kills all sessions at once.
//     Refinement measured live 2026-08-11: a GRACEFUL exit self-cleans — the CLI
//     logs "released scheduler lock" and drops its own rows. So the hazard is
//     specifically an UNGRACEFUL death (SIGKILL, panic, reboot), which is exactly
//     what happened on 08-09 and what the weekly patch-reboot guarantees. Point 3
//     below covers precisely that gap, and is a no-op after a clean stop.
//
// Upstream documents the opposite ("Tasks are session-scoped") and has not fixed
// it: 4 independent reports (anthropics/claude-code #50300 — labelled area:security,
// #54734, #66509, plus #84196 asking for task→session attribution) were closed by a
// stale-bot with zero maintainer replies; #50300 is locked. Walnut can enforce the
// safe subset itself: a session may create crons (that is what /loop is), but not
// durable ones, because a durable job outlives its session and lands in a stranger.
//
// The enforcement is OPT-IN (config `session.cron_policy: 'session-only'` →
// WALNUT_ENFORCE_SESSION_CRON=1 at daemon spawn; default 'unrestricted' does
// nothing). Denying tool calls, injecting corrective messages, and rewriting a
// user's .claude/scheduled_tasks.json are opinionated interventions the public
// build must not perform unasked. WALNUT_ALLOW_DURABLE_CRON=1 still overrides
// (back-compat with daemons deployed under the old enforce-by-default).
//
// THREE enforcement points, in order of how much they can be argued with:
//   1. can_use_tool control_request (permission-gated modes) → DENY with a message
//      telling the model to retry with durable:false. Pre-emptive, nothing lands.
//   2. stream tailer sees a CronCreate tool_use with durable:true (bypass mode, no
//      permission round-trip) → the job is already on disk, so FIFO-inject an
//      instruction to CronDelete + recreate non-durable. ADVISORY, and verified
//      refusable: on 2026-08-11 a live CLI read it and declined, reasoning that an
//      automated message is not user authorization. It is right to reason that way,
//      which is exactly why it cannot be the guarantee.
//   3. reapSession (death funnel) → stripDurableTasksForSession removes the dying
//      session's own rows from {cwd}/.claude/scheduled_tasks.json. The model has no
//      say here, and death is precisely when a durable row becomes adoptable, so
//      this is the point that actually holds the invariant.
// Pure predicates here; adapters own the I/O. Mirrored in daemon-source.ts.

/** Does this `can_use_tool` request (or CronCreate tool_use input) ask for a durable cron? */
export function isDurableCronRequest(toolName: string | undefined, input: unknown): boolean {
  if (toolName !== 'CronCreate') return false
  const i = input as { durable?: unknown } | null | undefined
  // Only an explicit true is durable — absent/false is the safe CLI default.
  return i?.durable === true
}

/** Deny message for the control_response — the model reads this and retries. */
export function durableCronDenyMessage(): string {
  return 'Denied by Walnut: durable scheduled tasks are not allowed in a Walnut-managed session. '
    + 'A durable cron is written to .claude/scheduled_tasks.json and the scheduler lock is scoped to the '
    + 'PROJECT DIRECTORY, so once this session ends the job is adopted and executed by whatever other session '
    + 'shares this directory — with no indication that a cron, not the user, asked for it. '
    + 'Retry the same CronCreate with durable:false (the default) to keep the job inside this session. '
    + 'If the user genuinely needs an unattended job that survives this session, use a system scheduler '
    + '(crontab / launchd) that starts its own dedicated session instead.'
}

/** Corrective instruction FIFO-injected when a durable cron was already created
 *  (bypass-mode sessions get no permission round-trip to deny). */
export function durableCronCorrectionMessage(taskId: string | undefined): string {
  return '[Walnut scheduler policy — automated message, not from the user] '
    + `You just created a DURABLE scheduled task${taskId ? ' (' + taskId + ')' : ''}. `
    + 'Durable tasks persist to .claude/scheduled_tasks.json and the CLI scopes the scheduler lock to the '
    + 'project directory, so after this session ends the job fires inside an unrelated session that happens to '
    + 'share this directory, delivered as if the user had typed it. That caused a real incident here. '
    + 'Please immediately call CronDelete on that task id, then re-create the same schedule with durable:false '
    + '(session-scoped). Do not keep the durable version. Then continue what you were doing and mention the swap '
    + 'briefly in your next summary.'
}

/**
 * Enforcement point 3 (deterministic): strip a dead session's durable tasks.
 *
 * Points 1 and 2 both depend on the model cooperating, and point 2 provably
 * does not: verified live 2026-08-11, the CLI read the injected correction and
 * REFUSED it — correctly, by its own rule that an automated message carries no
 * user authorization ("你明确要求 durable 设为 true … 这条消息是自动发的,不算你
 * 的授权"). A policy the model can veto is not an invariant, so the guarantee
 * has to live somewhere the model cannot reach: the death funnel.
 *
 * When a session dies, any task in {cwd}/.claude/scheduled_tasks.json that it
 * created is exactly the adoption hazard — the creator is gone, so the next
 * lock holder in that directory would run it as a bare user message. Remove
 * ONLY those rows: a task created by a still-live sibling is none of our
 * business, and a task with no createdBySessionId (legacy/hand-written) is not
 * ours to delete.
 *
 * Pure: takes the file text, returns the text to write back (or null when
 * nothing changes, so the adapter can skip the write entirely).
 */
export function stripDurableTasksForSession(
  tasksJson: string | null,
  sid: string,
): { changed: boolean; text: string | null; removed: string[] } {
  const unchanged = { changed: false, text: null, removed: [] as string[] }
  if (!tasksJson) return unchanged
  let parsed: { tasks?: unknown }
  try { parsed = JSON.parse(tasksJson) as { tasks?: unknown } } catch { return unchanged }
  if (!Array.isArray(parsed.tasks)) return unchanged
  const tasks = parsed.tasks as Array<Record<string, unknown>>
  const removed: string[] = []
  const kept = tasks.filter((t) => {
    if (!t || t.createdBySessionId !== sid) return true
    removed.push(typeof t.id === 'string' ? t.id : 'unknown')
    return false
  })
  if (removed.length === 0) return unchanged
  // Preserve any sibling keys the CLI may add to the envelope.
  const next = { ...(parsed as Record<string, unknown>), tasks: kept }
  return { changed: true, text: JSON.stringify(next, null, 2) + '\n', removed }
}

/**
 * Enforcement point 4: evict ONE orphaned cron by id, on the fire that hijacked us.
 *
 * Point 3 only covers crons created by a session Walnut itself reaps. The 2026-08-13
 * recurrence proved that is the minority case: the creator (e32173e4) was a bare CLI
 * started outside Walnut, so Walnut never saw it live or die, and its durable row sat
 * in a shared monorepo directory hijacking a real session every hour, 22 times.
 *
 * A FOREIGN fire is self-evident proof the row is orphaned relative to this process:
 * whoever created it is not us, so no CronDelete will ever come from here. Deleting
 * the row is the only thing that ends the loop — and unlike the warning this replaces,
 * it costs the session no turn and no context.
 */
export function stripCronTaskById(
  tasksJson: string | null,
  taskId: string,
): { changed: boolean; text: string | null } {
  if (!tasksJson || !taskId) return { changed: false, text: null }
  let parsed: { tasks?: unknown }
  try { parsed = JSON.parse(tasksJson) as { tasks?: unknown } } catch { return { changed: false, text: null } }
  if (!Array.isArray(parsed.tasks)) return { changed: false, text: null }
  const tasks = parsed.tasks as Array<Record<string, unknown>>
  const kept = tasks.filter((t) => !t || t.id !== taskId)
  if (kept.length === tasks.length) return { changed: false, text: null }
  const next = { ...(parsed as Record<string, unknown>), tasks: kept }
  return { changed: true, text: JSON.stringify(next, null, 2) + '\n' }
}

/** Human-readable marker text for the stream-file scheduled_task_fire line.
 *  This is the ONLY thing a foreign fire produces for a human to read — it lands
 *  in the session timeline as a system row. Deliberately not sent to the model. */
export function cronFireMarkerText(f: DetectedCronFire): string {
  return f.foreign
    ? `Orphaned scheduled task ${f.taskId} fired here — created by another session (${f.createdBySessionId}) that shares this directory. Walnut removed it so it cannot fire again.`
    : `Scheduled task ${f.taskId} fired (created by this session).`
}

// ── Cloud bridge: restart decision (pure) ──

/** Snapshot of bridge state at bridge.configure time. */
export interface BridgeConfigureState {
  /** next.enabled — the config being applied. */
  enabled: boolean
  /** Did the pushed config differ from the current one? */
  changed: boolean
  /** Is the outbound bridge socket currently open (adapter registered)? */
  adapterConnected: boolean
  /** Is a redial timer already pending? */
  redialPending: boolean
  /** Age of the in-flight dial in ms, or null when no dial is in flight. */
  dialAgeMs: number | null
  /** Dial timeout — a dial younger than this is still allowed to finish. */
  dialTimeoutMs: number
}

export type BridgeRestartDecision =
  | { restart: true; reason: 'configure' | 'reconcile' }
  | { restart: false }

/**
 * Should bridge.configure (re)start the bridge?
 *
 * - Config changed → always restart ('configure', pre-existing behavior).
 * - Config unchanged but the bridge SHOULD be up and nothing is working on it
 *   (no open socket, no pending redial, no young in-flight dial) → restart
 *   ('reconcile'). The Mac re-pushes an identical config on every daemon
 *   (re)connect, so this makes each push a healing opportunity for a wedged
 *   dial (a socket stuck in CONNECTING never fires onopen/onclose, so the
 *   redial loop dies silently). No restart storms: a pending redial timer or
 *   a dial still within its timeout is left alone.
 *
 * Mirrored verbatim in daemon-source.ts (template can't import) — parity test
 * locks the sync.
 */
export function decideBridgeRestart(s: BridgeConfigureState): BridgeRestartDecision {
  if (s.changed) return { restart: true, reason: 'configure' }
  if (!s.enabled) return { restart: false }
  if (s.adapterConnected) return { restart: false }
  if (s.redialPending) return { restart: false }
  if (s.dialAgeMs != null && s.dialAgeMs < s.dialTimeoutMs) return { restart: false }
  return { restart: true, reason: 'reconcile' }
}

// ── Turn-error auto-retry (upstream transient failures) ──
//
// A `claude -p` turn can die to a TRANSIENT upstream failure — a Bedrock/API
// degradation window, a stalled stream, a mid-response 5xx. The CLI exhausts
// its own finite retry budget (CLAUDE_CODE_MAX_RETRIES, ~30min) and ends the
// turn with `{"type":"result","is_error":true,"result":"API Error: ..."}`. The
// session is otherwise healthy and fully resumable: the turn just never
// finished. An unattended run (cron, background task, overnight work) then sits
// dead until a human notices — which is what happened on 2026-08-13, where the
// user hand-typed "continue" to restart a turn 12 times.
//
// WHY THE DAEMON OWNS THIS (and not the Mac's session-auto-continue.ts):
// the daemon runs ON the execution host and owns the CLI process, the FIFO, and
// the stream file. It keeps retrying while the Mac sleeps, while the SSH tunnel
// is down, and across walnut server restarts — exactly the overnight window
// where an unattended run needs to survive. The Mac-side watcher can only act
// when the Mac is awake and connected, so it cannot be the guarantee.
//
// The Mac still owns POLICY (it reads the user's config and passes the budget
// down as spawn env); the daemon owns EXECUTION.
//
// ── The retryable/terminal split is the whole safety story ──
// Retrying a TERMINAL error is an infinite loop that burns tokens forever. The
// classifier is therefore an ALLOWLIST: only errors we have positively
// identified as transient are retried, and anything unrecognized is treated as
// terminal. Adding a pattern is a deliberate act.
//
// Text corpus audited from 3 days of this machine's logs (2026-08-11..13):
//    42×  "API Error: The operation timed out."                  → RETRY
//     9×  "API Error: Server error mid-response."                → RETRY
//     8×  "API Error: Stream idle timeout - no chunks received"  → RETRY
//     2×  "API Error: Response stalled mid-stream."              → RETRY
//     1×  "API Error: The system encountered an unexpected error during processing." → RETRY
//     9×  "API Error: <model> can't help with this."             → TERMINAL (a
//         model REFUSAL. Retrying re-asks the same refused question forever —
//         the single most important non-retry in this list.)
//
// Deliberately terminal (never retried), beyond anything unrecognized:
//   - refusals / "can't help with this" / "start a new session"
//   - auth + spend-limit failures (credentials and account state won't fix
//     themselves, and a 12h hammer on a 401 is an abuse pattern)
//   - context-window overflow (the SAME prompt overflows identically on retry)
//   - user-initiated aborts and cancellations (the human said stop)
//   - invalid-request / 400-class errors (a bad request stays bad)

/** Transient upstream failures — safe to resume, the same input can succeed. */
const RETRYABLE_TURN_ERROR_PATTERNS: RegExp[] = [
  /operation timed out/i,
  /request timed out/i,
  /\bapi_timeout\b/i,
  /server error mid-response/i,
  /stream idle timeout/i,
  /no chunks received/i,
  /response stalled mid-stream/i,
  /unexpected error during processing/i,
  /\b(?:429|500|502|503|504|529)\b/,
  /too many requests/i,
  /rate limit/i,
  /overloaded/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /internal server error/i,
  /connection (?:error|reset|closed|refused)/i,
  /socket hang up/i,
  /\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEPIPE\b|\bEAI_AGAIN\b|\bENOTFOUND\b/,
  /fetch failed/i,
  /network error/i,
  /premature close/i,
  /terminated/i,
]

/**
 * Terminal signatures, checked FIRST and winning over any retryable match.
 *
 * Order matters: a refusal text ("… can't help with this. Start a new session
 * to continue.") carries no retryable token today, but a future error string
 * could carry both a refusal and the word "timeout". A retry loop on a refusal
 * is strictly worse than a missed retry, so terminal always wins.
 */
const TERMINAL_TURN_ERROR_PATTERNS: RegExp[] = [
  /can'?t help with this/i,
  /start a new session/i,
  /\brefus(?:al|ed|es)\b/i,
  /\bstop_reason["\s:]*['"]?refusal/i,
  /prompt too long/i,
  /context (?:window|length) (?:exceeded|too long)/i,
  /exceeds? the maximum/i,
  /too many tokens/i,
  /invalid[_\s-]?request/i,
  /\b400\b/,
  /\b401\b|\b403\b/,
  /unauthorized|forbidden|authentication|credential|expired token|invalid api key/i,
  /quota exceeded|insufficient (?:quota|funds|credit)|bil{2}ing/i,
  /permission denied/i,
  /not\s+found:\s*model|model .* (?:not found|does not exist|unavailable in)/i,
  /aborted by user|user (?:aborted|cancell?ed|interrupted)|request cancell?ed/i,
  /\bECANCELED\b/,
]

export type TurnErrorClass = 'retryable' | 'terminal'

/**
 * Classify a turn's error text. ALLOWLIST semantics: unrecognized → terminal.
 *
 * Exported for the parity test and for unit tests that pin every corpus string.
 */
export function classifyTurnError(text: string | null | undefined): TurnErrorClass {
  if (!text) return 'terminal'
  for (const re of TERMINAL_TURN_ERROR_PATTERNS) if (re.test(text)) return 'terminal'
  for (const re of RETRYABLE_TURN_ERROR_PATTERNS) if (re.test(text)) return 'retryable'
  return 'terminal'
}

/** Is this stream line a turn-over `result` carrying an error? */
export function parseTurnErrorLine(line: string): { isTurnError: boolean; text: string | null } {
  // Substring pre-gate keeps the hot path free — the tailer sees every line.
  // NOTE: the gate CANNOT be on `subtype`: a real timeout result carries
  // `"subtype":"success"` alongside `"is_error":true` (verified in live stream
  // files 2026-08-13). `is_error` is the only trustworthy signal.
  if (!line.includes('"type":"result"') || !line.includes('"is_error":true')) {
    return { isTurnError: false, text: null }
  }
  try {
    const parsed = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown }
    if (parsed.type !== 'result' || parsed.is_error !== true) return { isTurnError: false, text: null }
    return { isTurnError: true, text: typeof parsed.result === 'string' ? parsed.result : null }
  } catch {
    return { isTurnError: false, text: null }
  }
}

/** Per-session retry bookkeeping. In-memory + persisted in the registry so a
 *  daemon restart doesn't reset a session's 12h budget to zero. */
export interface TurnRetryState {
  /** Attempts made in the CURRENT failure streak (reset by any success). */
  attempts: number
  /** Wall-clock ms of the streak's FIRST attempt — anchors the time budget. */
  streakStartedAt: number | null
  /** ts of the last attempt (for backoff spacing + observability). */
  lastAttemptAt: number | null
  /** Stream-file offset (v) of the last result line we acted on — dedupes a
   *  re-read of the same line after a watcher heal / overlap re-read. */
  lastHandledV: number | null
}

export interface TurnRetryConfig {
  enabled: boolean
  /** Total wall-clock budget for one failure streak (default 12h). */
  budgetMs: number
  /** Hard cap on attempts inside the budget (backstop against a fast-fail loop). */
  maxAttempts: number
  /** First backoff delay; doubles per attempt up to backoffMaxMs. */
  backoffBaseMs: number
  backoffMaxMs: number
}

export const TURN_RETRY_DEFAULTS: Readonly<TurnRetryConfig> = {
  enabled: false,          // opt-in: the public build must not auto-spend tokens unasked
  budgetMs: 12 * 3600_000, // 12h — the user's ask ("at least 12h")
  maxAttempts: 200,
  backoffBaseMs: 30_000,   // 30s
  backoffMaxMs: 600_000,   // 10min ceiling: a degradation window outlasts a long backoff
}

/**
 * Resolve the retry config from daemon spawn env (set by the Mac from user
 * config — see daemon-connection.ts startDaemon).
 *
 * `WALNUT_TURN_RETRY=1` is the master switch. A 0/absent value means the daemon
 * does nothing at all, which is the default for a generic install.
 */
export function resolveTurnRetryConfig(env: Record<string, string | undefined>): TurnRetryConfig {
  const num = (raw: string | undefined, def: number, min: number, max: number): number => {
    const n = raw != null && raw !== '' ? Number(raw) : def
    if (!Number.isFinite(n)) return def
    return Math.max(min, Math.min(max, Math.trunc(n)))
  }
  return {
    enabled: env.WALNUT_TURN_RETRY === '1',
    // 0 is meaningful (disable by budget) so the floor is 0, not 60s.
    budgetMs: num(env.WALNUT_TURN_RETRY_BUDGET_MS, TURN_RETRY_DEFAULTS.budgetMs, 0, 7 * 86_400_000),
    maxAttempts: num(env.WALNUT_TURN_RETRY_MAX_ATTEMPTS, TURN_RETRY_DEFAULTS.maxAttempts, 0, 10_000),
    backoffBaseMs: num(env.WALNUT_TURN_RETRY_BACKOFF_MS, TURN_RETRY_DEFAULTS.backoffBaseMs, 1_000, 3_600_000),
    backoffMaxMs: num(env.WALNUT_TURN_RETRY_BACKOFF_MAX_MS, TURN_RETRY_DEFAULTS.backoffMaxMs, 1_000, 3_600_000),
  }
}

/**
 * The other half of the config contract: user config → daemon spawn env.
 *
 * Lives next to resolveTurnRetryConfig deliberately — the writer and the reader
 * of these env names must change together, and a silent typo here would look
 * exactly like "the feature doesn't work".
 *
 * Returns {} when disabled so a default install spawns a daemon with no retry
 * env at all. Values are converted from human units (hours/seconds in config)
 * to ms, and clamped by resolveTurnRetryConfig on the daemon side.
 */
export function buildTurnRetryEnv(cfg: {
  enabled?: boolean
  budget_hours?: number
  max_attempts?: number
  backoff_seconds?: number
  backoff_max_seconds?: number
} | undefined): Record<string, string> {
  if (!cfg?.enabled) return {}
  const env: Record<string, string> = { WALNUT_TURN_RETRY: '1' }
  const put = (key: string, value: number | undefined, mult: number) => {
    // A non-finite or negative value is a config typo: omit it and let the
    // daemon apply its own default rather than shipping NaN into the env.
    if (value == null || !Number.isFinite(value) || value < 0) return
    env[key] = String(Math.trunc(value * mult))
  }
  put('WALNUT_TURN_RETRY_BUDGET_MS', cfg.budget_hours, 3600_000)
  put('WALNUT_TURN_RETRY_MAX_ATTEMPTS', cfg.max_attempts, 1)
  put('WALNUT_TURN_RETRY_BACKOFF_MS', cfg.backoff_seconds, 1_000)
  put('WALNUT_TURN_RETRY_BACKOFF_MAX_MS', cfg.backoff_max_seconds, 1_000)
  return env
}

export type TurnRetryDecision =
  | { retry: true; attempt: number; delayMs: number; elapsedMs: number }
  | { retry: false; reason: 'disabled' | 'terminal' | 'budget-exhausted' | 'attempts-exhausted' | 'duplicate-line' }

/**
 * THE decision function: given a failed turn, should the daemon resume it?
 *
 * Pure — no clock, no I/O, no logging. `nowMs` and the current state come in,
 * the verdict comes out, so every branch is unit-testable and the two daemon
 * twins can share one behavior. The caller applies the returned attempt/delay
 * and persists the mutated state.
 *
 * Budget semantics: the 12h window is measured from the FIRST failure of the
 * current streak, NOT per attempt. A streak that has been failing for 11h59m
 * gets one more try; at 12h00m it stops and leaves the session dead for a human.
 * Any successful turn clears the streak (see clearTurnRetryStreak), so a session
 * that fails at 09:00, recovers, then fails again at 20:00 gets a FULL fresh
 * 12h — the budget bounds one outage, not the session's lifetime.
 */
export function decideTurnRetry(args: {
  errorText: string | null
  state: TurnRetryState
  cfg: TurnRetryConfig
  nowMs: number
  /** Stream offset of the result line, for the duplicate guard. */
  v?: number | null
}): TurnRetryDecision {
  const { errorText, state, cfg, nowMs } = args
  if (!cfg.enabled) return { retry: false, reason: 'disabled' }

  // Same result line seen twice (watcher heal re-read, overlap) → not a new
  // failure. Without this, one error could burn the whole attempt budget.
  if (args.v != null && state.lastHandledV != null && args.v <= state.lastHandledV) {
    return { retry: false, reason: 'duplicate-line' }
  }

  if (classifyTurnError(errorText) === 'terminal') return { retry: false, reason: 'terminal' }
  if (cfg.maxAttempts <= 0) return { retry: false, reason: 'attempts-exhausted' }

  // Budget is anchored on the streak start; the first failure of a streak
  // anchors it at `nowMs` and therefore always has elapsed 0.
  const streakStart = state.streakStartedAt ?? nowMs
  const elapsedMs = nowMs - streakStart
  if (cfg.budgetMs <= 0 || elapsedMs >= cfg.budgetMs) {
    return { retry: false, reason: 'budget-exhausted' }
  }
  if (state.attempts >= cfg.maxAttempts) return { retry: false, reason: 'attempts-exhausted' }

  const attempt = state.attempts + 1
  // Exponential backoff, capped. Attempt 1 waits backoffBaseMs: an upstream
  // degradation window is minutes-to-hours long, so an instant retry just
  // spends a spawn to hit the same wall.
  const raw = cfg.backoffBaseMs * Math.pow(2, state.attempts)
  const delayMs = Math.min(cfg.backoffMaxMs, Number.isFinite(raw) ? raw : cfg.backoffMaxMs)
  return { retry: true, attempt, delayMs, elapsedMs }
}

/** Fold an accepted retry decision into the state (caller persists). */
export function applyTurnRetry(state: TurnRetryState, nowMs: number, v: number | null | undefined): void {
  state.streakStartedAt = state.streakStartedAt ?? nowMs
  state.attempts += 1
  state.lastAttemptAt = nowMs
  if (v != null) state.lastHandledV = v
}

/**
 * Clear the streak after a CLEAN turn.
 *
 * Called on any `result` line with is_error false/absent. This is what makes the
 * budget bound "one outage" instead of "the session's whole life", and it is
 * also the reason a long-lived session doesn't slowly accumulate attempts until
 * it can never retry again.
 */
export function clearTurnRetryStreak(state: TurnRetryState): boolean {
  if (state.attempts === 0 && state.streakStartedAt == null) return false
  state.attempts = 0
  state.streakStartedAt = null
  state.lastAttemptAt = null
  return true
}

export function newTurnRetryState(): TurnRetryState {
  return { attempts: 0, streakStartedAt: null, lastAttemptAt: null, lastHandledV: null }
}

/** The message injected to resume an interrupted turn. Deliberately marked as
 *  automated so the model doesn't mistake it for a new user instruction. */
export function turnRetryMessage(attempt: number, errorText: string | null): string {
  const what = errorText ? errorText.replace(/\s+/g, ' ').trim().slice(0, 200) : 'an upstream API error'
  return '[Walnut auto-retry — automated message, not from the user] '
    + `The previous turn was interrupted by a transient upstream failure (${what}) `
    + `and did not finish. This is retry attempt ${attempt}. `
    + 'Please continue exactly where you left off. Do not restart the task from the beginning, '
    + 'and do not re-run work you already completed — check what you had already done first.'
}

/** Human-readable stream marker text (session timeline system row). */
export function turnRetryMarkerText(a: {
  attempt: number; delayMs: number; errorText: string | null; budgetMs: number; elapsedMs: number
}): string {
  const mins = Math.round(a.delayMs / 60_000)
  const wait = a.delayMs < 60_000 ? `${Math.round(a.delayMs / 1000)}s` : `${mins}min`
  const budgetH = Math.round(a.budgetMs / 3600_000)
  const usedMin = Math.round(a.elapsedMs / 60_000)
  return `Turn failed (${a.errorText ?? 'upstream error'}). Walnut is auto-retrying in ${wait} `
    + `— attempt ${a.attempt}, ${usedMin}min into the ${budgetH}h retry budget.`
}

/** Marker text when the daemon gives up (budget/attempts spent, or terminal). */
export function turnRetryGiveUpText(reason: string, errorText: string | null): string {
  const why = reason === 'budget-exhausted' ? 'the retry budget is spent'
    : reason === 'attempts-exhausted' ? 'the retry attempt cap is reached'
    : 'the error is not retryable'
  return `Turn failed (${errorText ?? 'upstream error'}) and Walnut stopped auto-retrying because ${why}. `
    + 'Send a message to resume this session manually.'
}

export function defaultReadStartTime(fs: typeof import('node:fs'), pid: number): string | null {
  // Linux: /proc/<pid>/stat field 22 (kernel start time in clock ticks)
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const rparen = raw.lastIndexOf(')')
    if (rparen < 0) return null
    // After ") ", field[0]=state, ..., start_time is at index 19.
    const fields = raw.slice(rparen + 2).split(' ')
    return fields[19] ?? null
  } catch {}
  // macOS: ps -p <pid> -o lstart= (e.g. "Thu May  6 18:59:15 2026")
  // Force LANG=C so localized day/month names don't break startTime comparisons
  // when the daemon starts under one locale but reconciles under another.
  try {
    const result = (execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 2000, env: { ...process.env, LANG: 'C' } }) as string).trim()
    return result || null
  } catch {}
  return null
}
