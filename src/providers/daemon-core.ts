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
      if (result === 'ok') return { ok: true }
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
