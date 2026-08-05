/**
 * MockDaemon — Local WebSocket server implementing the walnut-daemon protocol.
 *
 * Used by tests to exercise RemoteSessionManager without SSH.
 * Spawns mock-claude.mjs for Claude CLI simulation, polls JSONL output,
 * and streams events via WebSocket — same behavior as the real daemon.
 *
 * Usage:
 *   const daemon = await createMockDaemon()
 *   // pass `ws://localhost:${daemon.port}` as directWsUrl to RemoteSessionManager
 *   await daemon.stop()
 */

import { WebSocketServer, WebSocket } from 'ws'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createServer } from 'node:net'
import { createAcpDaemon, type AcpStartParams } from '../../src/providers/acp-daemon.js'
import { REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

interface DaemonSession {
  sid: string
  proc: ChildProcess | null
  pid: number | null
  pipePath: string
  jsonlPath: string
  pollTimer: ReturnType<typeof setInterval> | null
  offset: number
  exitCode: number | null
}

/** Types of send fault that can be injected per-session. */
export type SendFault = 'ENXIO' | 'EAGAIN' | 'session_dead' | 'not_found' | null

export interface MockDaemonOptions {
  /** Mirror CLI capture files into the server's local stream fallback directory. */
  streamsDir?: string
  /** Reuse a fixture's durable ACP journals across daemon attach/restart. */
  acpStreamsDir?: string
}

/**
 * MockDaemon — implements the daemon WebSocket protocol locally.
 */
export class MockDaemon {
  private wss: WebSocketServer | null = null
  private sessions = new Map<string, DaemonSession>()
  private tmpDir: string
  private _port = 0
  private _fault: string | null = null
  private _cliCommand = MOCK_CLI
  private _attachHistory: Array<{ sid: string; fromOffset: number }> = []
  /** Active WS client connections — for broadcasting session_state events. */
  private _wsClients = new Set<WebSocket>()
  /** Per-session injected faults for cmdSend (strict-ack envelope). */
  private _sendFaults = new Map<string, SendFault>()
  /** Spawn fault returned by every cmdStart until cleared (see injectStartFault). */
  private _startFault: string | null = null
  /** Command names to silently swallow (no reply) — one-shot each; forces a
   *  client-side command timeout (bulk-channel self-heal tests). */
  private _swallowNext = new Set<string>()
  /** Sessions flagged as dead via simulateDeath — exitCode returned in session_dead replies. */
  private _deadSessions = new Map<string, number>()
  /** Command log for test assertions. `connIndex` = arrival socket (0-based,
   *  connection order) so bulk-channel tests can assert routing. */
  private _commandHistory: Array<{ cmd: string; payload: Record<string, unknown>; timestamp: number; connIndex: number }> = []
  /** Connection-order index per live socket (never reused). */
  private _connIndices = new WeakMap<WebSocket, number>()
  private _connSeq = 0
  /** Stable instance id reported by `hello` (daemon-identity checks). */
  readonly instanceId = `mock-${crypto.randomBytes(4).toString('hex')}`
  /** When true, `hello` reports a DIFFERENT instanceId (bulk-channel identity-mismatch tests). */
  private _helloInstanceMismatch = false
  /** Bridge liveness reported by `bridge.configure` replies (Mac-side visibility tests). */
  private _bridgeConnected = false
  private readonly streamsDir: string
  /** Real ACP supervision (same module the standalone daemon embeds) so tests
   *  can drive acp* sessions through MockDaemon with real workers + mock agent. */
  private _acp: ReturnType<typeof createAcpDaemon<WebSocket>>

  get port(): number { return this._port }

  constructor(options: MockDaemonOptions = {}) {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-daemon-'))
    this.streamsDir = options.streamsDir ?? path.join(this.tmpDir, 'streams')
    fs.mkdirSync(this.streamsDir, { recursive: true })
    this._acp = createAcpDaemon<WebSocket>({
      streamsDir: options.acpStreamsDir ?? this.streamsDir,
      daemonDir: this.tmpDir,
      sendEvent: (ws, ev, data) => this.sendEvent(ws, ev, data),
      isWsOpen: (ws) => ws.readyState === WebSocket.OPEN,
      log: () => {},
      // In-process in vitest: the idle-sweep interval must not keep the
      // process alive after tests finish.
      setIntervalFn: ((fn: () => void, ms: number) => {
        const t = setInterval(fn, ms)
        t.unref()
        return t
      }) as typeof setInterval,
    })
  }

  /** Override the CLI command used for sessions (default: mock-claude.mjs) */
  setCliCommand(cmd: string): void {
    this._cliCommand = cmd
  }

  /** Control the bridge liveness reported by `bridge.configure` replies. */
  setBridgeConnected(connected: boolean): void {
    this._bridgeConnected = connected
  }

  async start(): Promise<void> {
    // Find a free port
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (typeof addr === 'object' && addr) {
          const p = addr.port
          srv.close(() => resolve(p))
        } else {
          srv.close(() => reject(new Error('Failed to get port')))
        }
      })
    })

    this._port = port
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' })

    // Wait for WS server to be listening before returning
    await new Promise<void>((resolve, reject) => {
      this.wss!.on('listening', resolve)
      this.wss!.on('error', reject)
    })

    this.wss.on('connection', (ws) => this.registerClient(ws))
  }

  private registerClient(ws: WebSocket): void {
    this._wsClients.add(ws)
    this._connIndices.set(ws, this._connSeq++)
    ws.on('close', () => this._wsClients.delete(ws))
    ws.on('error', () => this._wsClients.delete(ws))
    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString()
      this.handleMessage(ws, raw)
    })
  }

  async stop(): Promise<void> {
    // Kill all session processes
    for (const [, session] of this.sessions) {
      if (session.pollTimer) clearInterval(session.pollTimer)
      if (session.proc && session.exitCode === null) {
        try { session.proc.kill('SIGTERM') } catch { /* already dead */ }
      }
    }
    this.sessions.clear()

    // Kill ACP workers (ordinary children — SIGKILL is fine, tests don't need
    // graceful journal closure here).
    for (const [, entry] of this._acp.workers) {
      try { entry.proc.kill('SIGKILL') } catch { /* already dead */ }
    }

    // Close WebSocket server — terminate all client connections first
    if (this.wss) {
      for (const client of this.wss.clients) {
        try { client.terminate() } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve())
      })
      this.wss = null
    }

    // Clean up temp files
    try { fs.rmSync(this.tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  /** Inject a fault for testing error paths */
  injectFault(fault: 'disconnect' | 'slow' | 'crash' | null): void {
    this._fault = fault
  }

  /** Return history of all attach commands for test assertions */
  getAttachHistory(): Array<{ sid: string; fromOffset: number }> {
    return [...this._attachHistory]
  }

  // ── Protocol Handler ──

  private handleMessage(ws: WebSocket, raw: string): void {
    let cmd: Record<string, unknown>
    try { cmd = JSON.parse(raw) } catch {
      ws.send(JSON.stringify({ id: 0, ok: false, error: 'invalid JSON' }))
      return
    }

    const id = cmd.id as number

    // Record command history for test assertions
    if (typeof cmd.cmd === 'string') {
      this._commandHistory.push({
        cmd: cmd.cmd,
        payload: { ...cmd },
        timestamp: Date.now(),
        connIndex: this._connIndices.get(ws) ?? -1,
      })
    }

    // Fault injection
    if (this._fault === 'disconnect') {
      ws.close()
      return
    }
    if (typeof cmd.cmd === 'string' && this._swallowNext.has(cmd.cmd)) {
      this._swallowNext.delete(cmd.cmd)
      return // no reply — client's per-command timer fires
    }

    switch (cmd.cmd) {
      case 'start': return this.cmdStart(ws, id, cmd)
      case 'attach': return this.cmdAttach(ws, id, cmd)
      case 'send': return this.cmdSend(ws, id, cmd)
      case 'sendRaw': return this.cmdSendRaw(ws, id, cmd)
      case 'appendUserMarker': return this.cmdAppendUserMarker(ws, id, cmd)
      case 'stop': return this.cmdStop(ws, id, cmd)
      case 'status': return this.cmdStatus(ws, id, cmd)
      case 'rename': return this.cmdRename(ws, id, cmd)
      case 'ping': return this.sendOk(ws, id, { pong: true })
      // Mirrors daemon-standalone's cmdBridgeConfigure reply shape; the
      // reported liveness is test-controlled via setBridgeConnected().
      case 'bridge.configure': return this.sendOk(ws, id, {
        applied: true,
        connected: this._bridgeConnected,
      })
      // Mirrors daemon-standalone's cmdHello reply shape (instanceId is what
      // the bulk-channel dial verifies before routing to a second socket).
      case 'hello': return this.sendOk(ws, id, {
        version: 'mock',
        capabilities: [...REQUIRED_DAEMON_CAPABILITIES],
        instanceId: this._helloInstanceMismatch ? `mock-other-${this._connSeq}` : this.instanceId,
        startedAt: Date.now(),
        uptimeSec: 0,
      })
      case 'fs.read': return this.cmdFsRead(ws, id, cmd)
      case 'fs.readRange': return this.cmdFsReadRange(ws, id, cmd)
      case 'fs.readImage': return this.cmdFsReadImage(ws, id, cmd)
      case 'fs.mkdir': return this.cmdFsMkdir(ws, id, cmd)
      case 'fs.ls': return this.cmdFsLs(ws, id, cmd)
      case 'list': return this.cmdList(ws, id)
      // ── ACP command family: forwarded to the REAL createAcpDaemon module
      //    (same code the standalone daemon embeds) — real workers, mock agent.
      case 'acpStart': {
        // Response shapes mirror daemon-standalone's cmdAcpStart exactly.
        void this._acp.acpStart(ws, cmd as unknown as AcpStartParams).then((resp) => {
          if (ws.readyState !== WebSocket.OPEN) return
          if (resp.ok) this.sendOk(ws, id, resp.result ?? {})
          else ws.send(JSON.stringify({ id, ok: false, error: resp.error, errorKind: resp.errorKind }))
        })
        return
      }
      case 'acpSend': return this.cmdAcpOp(ws, id, cmd, 'prompt')
      case 'acpCancel': return this.cmdAcpOp(ws, id, cmd, 'cancel')
      case 'acpRespond': return this.cmdAcpOp(ws, id, cmd, 'permissionResponse')
      case 'acpState': return this.cmdAcpOp(ws, id, cmd, 'getState')
      case 'acpNewSession': return this.cmdAcpOp(ws, id, cmd, 'newSession')
      case 'acpSetConfigOption': return this.cmdAcpOp(ws, id, cmd, 'setConfigOption')
      case 'acpStop': {
        void this._acp.acpStop(cmd.sid as string).then(() => this.sendOk(ws, id, { stopped: true }))
        return
      }
      case 'acpSubscribe': {
        const ok = this._acp.subscribe(ws, cmd.sid as string, (cmd.fromOffset as number) ?? 0)
        if (ok) return this.sendOk(ws, id, { subscribed: true })
        ws.send(JSON.stringify({ id, ok: false, error: 'no live ACP worker for ' + cmd.sid, errorKind: 'no_worker' }))
        return
      }
      default: return this.sendError(ws, id, `unknown command: ${cmd.cmd}`)
    }
  }

  // ── Commands ──

  private cmdStart(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const args = cmd.args as string[] | undefined
    const cwd = cmd.cwd as string || this.tmpDir
    const message = cmd.message as string || ''
    const resume = cmd.resume as boolean ?? false

    // Injected spawn failure. Mirrors the real daemon's cmdStart error replies
    // (missing cwd / mkfifo failed / no pid) — envelope ok:false, no session
    // registered, so the client's transport.start() rejects. Sticky until cleared.
    if (this._startFault) {
      return this.sendError(ws, id, this._startFault)
    }

    const streamsDir = this.streamsDir
    const pipePath = path.join(streamsDir, `${sid}.pipe`)
    const jsonlPath = path.join(streamsDir, `${sid}.jsonl`)

    // Create FIFO (remove old one if exists — resume case)
    try { fs.unlinkSync(pipePath) } catch { /* didn't exist */ }
    try {
      execSync(`mkfifo ${JSON.stringify(pipePath)}`)
    } catch (err) {
      return this.sendError(ws, id, `mkfifo failed: ${(err as Error).message}`)
    }

    // Open files
    const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
    if (!resume) {
      fs.writeFileSync(jsonlPath, '')  // truncate
    }
    // Resume must stream ONLY new turn output. Mirror the real daemon
    // (daemon-standalone.ts: "Record offset before spawn"): capture the current
    // jsonl size so the poller starts past the previous turn's lines. Resetting
    // to 0 here would re-emit the whole history (e.g. a prior error `result`) as a
    // fresh event — a mock artifact the real `--resume` path never produces.
    let startOffset = 0
    if (resume) {
      try { startOffset = fs.statSync(jsonlPath).size } catch { startOffset = 0 }
    }
    const outputFd = fs.openSync(jsonlPath, resume ? 'a' : 'w')
    const stderrFd = fs.openSync(jsonlPath + '.err', resume ? 'a' : 'w')

    // Build CLI args (mimic real daemon)
    const cliArgs = args ? args.slice(1) : ['-p', '--output-format', 'stream-json', '--verbose']
    if (resume && sid) {
      cliArgs.push('--resume', sid)
    }
    if (message) {
      cliArgs.push(message)
    }

    // Spawn mock CLI (use process.execPath to avoid PATH issues in vitest)
    const proc = spawn(process.execPath, [this._cliCommand, ...cliArgs], {
      stdio: [pipeFd, outputFd, stderrFd],
      cwd,
      env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    })

    const pid = proc.pid ?? 0

    // Close file descriptors (process has them now)
    try { fs.closeSync(pipeFd) } catch { /* ignore */ }
    try { fs.closeSync(outputFd) } catch { /* ignore */ }
    try { fs.closeSync(stderrFd) } catch { /* ignore */ }

    const session: DaemonSession = {
      sid,
      proc,
      pid,
      pipePath,
      jsonlPath,
      pollTimer: null,
      offset: startOffset,
      exitCode: null,
    }

    proc.on('exit', (code) => {
      session.exitCode = code ?? 1
      // Final flush of JSONL before sending exit event.
      // Without this, the poll timer (50ms) may not have caught the last lines
      // written by mock-claude before it exited, causing a race where the test
      // receives 'exit' before the JSONL events.
      setTimeout(() => {
        this.pollJsonl(ws, session.sid, session)
        if (session.pollTimer) clearInterval(session.pollTimer)
        session.pollTimer = null
        this.sendEvent(ws, 'exit', { sid: session.sid, code: session.exitCode! })
      }, 100) // 100ms delay ensures JSONL file is fully flushed to disk
    })

    this.sessions.set(sid, session)

    // Start polling JSONL file for new lines
    session.pollTimer = setInterval(() => {
      this.pollJsonl(ws, session.sid, session)
    }, 50)  // 50ms poll (faster than real daemon's 100ms for test speed)

    this.sendOk(ws, id, { pid, outputFile: jsonlPath, offset: 0 })
  }

  private cmdAttach(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const fromOffset = (cmd.fromOffset as number) ?? 0
    const session = this.sessions.get(sid)

    // Record for test inspection
    this._attachHistory.push({ sid, fromOffset })

    if (!session) {
      return this.sendError(ws, id, `session not found: ${sid}`)
    }

    // Resume polling from the requested offset
    session.offset = fromOffset

    // Stop any existing poll timer for this session (e.g. from a previous WS connection)
    if (session.pollTimer) {
      clearInterval(session.pollTimer)
      session.pollTimer = null
    }

    // Start polling JSONL for the new WS connection
    session.pollTimer = setInterval(() => {
      this.pollJsonl(ws, session.sid, session)
    }, 50)

    this.sendOk(ws, id, {
      pid: session.pid,
      alive: session.exitCode === null,
    })
  }

  private cmdSend(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const message = cmd.message as string

    // 1. Dead session short-circuit (strict-ack envelope)
    if (this._deadSessions.has(sid)) {
      const exitCode = this._deadSessions.get(sid)!
      return this.sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode })
    }

    // 2. Injected fault takes precedence (strict-ack envelope)
    const fault = this._sendFaults.get(sid)
    if (fault) {
      // One-shot by default — clear after delivering
      this._sendFaults.delete(sid)
      switch (fault) {
        case 'not_found':
          return this.sendOk(ws, id, { ok: false, reason: 'not_found' })
        case 'session_dead':
          return this.sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: -1 })
        case 'ENXIO':
          // Daemon-level semantics: ENXIO reaps the session. Mirror that so
          // follow-up sends hit session_dead.
          this._deadSessions.set(sid, -1)
          this.broadcastSessionState(sid, 'dead', { exitCode: -1, reason: 'send-enxio' })
          return this.sendOk(ws, id, { ok: false, reason: 'ENXIO', exitCode: -1 })
        case 'EAGAIN':
          return this.sendOk(ws, id, { ok: false, reason: 'EAGAIN', retriable: true })
      }
    }

    const session = this.sessions.get(sid)
    if (!session) {
      // Real daemon replies strict-ack, not envelope error, for unknown sid.
      return this.sendOk(ws, id, { ok: false, reason: 'not_found' })
    }

    // 3. Normal path — write to FIFO
    try {
      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: message },
      })
      const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      fs.writeSync(fd, Buffer.from(payload + '\n'))
      fs.closeSync(fd)
      this.sendOk(ws, id, { ok: true })
    } catch (err) {
      this.sendError(ws, id, `write failed: ${(err as Error).message}`)
    }
  }

  /** SIMPLIFIED mirror of daemon-core.handleSendRawCommand — writes a
   *  pre-serialized JSON envelope (control_request / control_response) verbatim
   *  to the FIFO, with the same strict-ack error shape (ok:false + reason).
   *  Not mirrored: pid kill-0 precheck, pendingCtrl clearing, writeFifoFully
   *  partial-write handling — fine for the small control envelopes tests send. */
  private cmdSendRaw(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const raw = cmd.raw as string
    if (!sid || !raw) return this.sendError(ws, id, 'sendRaw: missing sid or raw')
    if (this._deadSessions.has(sid)) {
      return this.sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: this._deadSessions.get(sid)! })
    }
    const session = this.sessions.get(sid)
    if (!session) return this.sendOk(ws, id, { ok: false, reason: 'not_found' })
    try {
      const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      fs.writeSync(fd, Buffer.from(raw.endsWith('\n') ? raw : raw + '\n'))
      fs.closeSync(fd)
      this.sendOk(ws, id, { ok: true })
    } catch (err) {
      // Mirror daemon-core.handleSendRawCommand's strict-ack envelope: write
      // failures come back as {ok:false, reason} — NOT a protocol-level error —
      // so writeRaw() resolves false and callers take their no-FIFO fallback
      // exactly like production.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENXIO') return this.sendOk(ws, id, { ok: false, reason: 'ENXIO', exitCode: -1 })
      if (code === 'EAGAIN') return this.sendOk(ws, id, { ok: false, reason: 'EAGAIN', retriable: true })
      this.sendError(ws, id, `sendRaw write failed: ${(err as Error).message}`)
    }
  }

  /** Mirrors daemon-core.handleAppendUserMarker — appends the walnut-injected
   *  turn-start marker line to the session's stream file. */
  private cmdAppendUserMarker(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const message = cmd.message as string
    const messageId = cmd.messageId as string
    if (!sid || !message || !messageId) return this.sendError(ws, id, 'appendUserMarker: missing sid, message, or messageId')
    const session = this.sessions.get(sid)
    if (!session) return this.sendOk(ws, id, { ok: false, reason: 'not_found' })
    try {
      const line = JSON.stringify({
        type: 'user',
        subtype: 'walnut-injected',
        message: { role: 'user', content: message },
        walnutMessageId: messageId,
        timestamp: new Date().toISOString(),
      }) + '\n'
      fs.appendFileSync(session.jsonlPath, line)
      const size = fs.statSync(session.jsonlPath).size
      this.sendOk(ws, id, { ok: true, size })
    } catch (err) {
      this.sendError(ws, id, `appendUserMarker failed: ${(err as Error).message}`)
    }
  }

  private cmdRename(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const oldSid = cmd.oldSid as string
    const newSid = cmd.newSid as string
    const session = this.sessions.get(oldSid)
    if (!session) return this.sendOk(ws, id, {})
    this.sessions.delete(oldSid)
    session.sid = newSid
    this.sessions.set(newSid, session)
    // Rename files
    const streamsDir = this.streamsDir
    try { fs.renameSync(session.pipePath, path.join(streamsDir, `${newSid}.pipe`)); session.pipePath = path.join(streamsDir, `${newSid}.pipe`) } catch {}
    try { fs.renameSync(session.jsonlPath, path.join(streamsDir, `${newSid}.jsonl`)); session.jsonlPath = path.join(streamsDir, `${newSid}.jsonl`) } catch {}
    this.sendOk(ws, id, {})
  }

  private cmdStop(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const session = this.sessions.get(sid)

    if (!session || !session.proc) {
      return this.sendOk(ws, id, {})
    }

    try { session.proc.kill('SIGINT') } catch { /* already dead */ }

    // Fallback SIGTERM after 2s
    setTimeout(() => {
      if (session.exitCode === null && session.proc) {
        try { session.proc.kill('SIGTERM') } catch { /* ignore */ }
      }
    }, 2000)

    this.sendOk(ws, id, {})
  }

  private cmdStatus(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const sid = cmd.sid as string
    const session = this.sessions.get(sid)

    if (!session) {
      return this.sendOk(ws, id, { alive: false })
    }

    this.sendOk(ws, id, {
      alive: session.exitCode === null,
      pid: session.pid,
      exitCode: session.exitCode,
    })
  }

  private cmdFsRead(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const filePath = cmd.path as string
    const encoding = cmd.encoding as string || 'utf-8'

    try {
      if (encoding === 'base64') {
        const data = fs.readFileSync(filePath)
        this.sendOk(ws, id, { data: data.toString('base64') })
      } else {
        const data = fs.readFileSync(filePath, 'utf-8')
        this.sendOk(ws, id, { data })
      }
    } catch (err) {
      this.sendError(ws, id, `fs.read failed: ${(err as Error).message}`)
    }
  }

  /** Mirrors daemon-standalone cmdFsReadRange: base64 window + eof/fileSize. */
  private cmdFsReadRange(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const filePath = cmd.path as string
    const start = typeof cmd.start === 'number' && cmd.start >= 0 ? cmd.start : 0
    const length = typeof cmd.length === 'number' && cmd.length > 0 ? (cmd.length as number) : 1024 * 1024
    if (!filePath) return this.sendError(ws, id, 'fs.readRange: missing path')
    try {
      const st = fs.statSync(filePath)
      if (start >= st.size) {
        return this.sendOk(ws, id, { data: '', bytesRead: 0, fileSize: st.size, eof: true })
      }
      const toRead = Math.min(length, st.size - start)
      const buf = Buffer.alloc(toRead)
      const fd = fs.openSync(filePath, 'r')
      const bytesRead = fs.readSync(fd, buf, 0, toRead, start)
      fs.closeSync(fd)
      this.sendOk(ws, id, {
        data: buf.subarray(0, bytesRead).toString('base64'),
        bytesRead,
        fileSize: st.size,
        eof: start + bytesRead >= st.size,
      })
    } catch (err) {
      this.sendError(ws, id, `fs.readRange failed: ${(err as Error).message}`)
    }
  }

  /** Simplified daemon-standalone cmdFsReadImage: base64 whole-file read
   *  (skips the extension/magic-byte checks — tests control the fixture). */
  private cmdFsReadImage(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const filePath = cmd.path as string
    if (!filePath) return this.sendError(ws, id, 'fs.readImage: missing path')
    try {
      const data = fs.readFileSync(filePath)
      this.sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' })
    } catch (err) {
      this.sendError(ws, id, `fs.readImage failed: ${(err as Error).message}`)
    }
  }

  private cmdFsMkdir(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const dirPath = cmd.path as string
    if (!dirPath) return this.sendError(ws, id, 'fs.mkdir: missing path')

    try {
      fs.mkdirSync(dirPath, { recursive: true })
      this.sendOk(ws, id, { created: true, resolvedPath: dirPath })
    } catch (err) {
      this.sendError(ws, id, `fs.mkdir failed: ${(err as Error).message}`)
    }
  }

  private cmdFsLs(ws: WebSocket, id: number, cmd: Record<string, unknown>): void {
    const dirPath = cmd.path as string

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      this.sendOk(ws, id, {
        entries: entries.map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
        })),
      })
    } catch (err) {
      this.sendError(ws, id, `fs.ls failed: ${(err as Error).message}`)
    }
  }

  private cmdList(ws: WebSocket, id: number): void {
    const list: Array<{ sid: string; alive: boolean; pid: number | null }> = []
    for (const [sid, session] of this.sessions) {
      list.push({ sid, alive: session.exitCode === null, pid: session.pid })
    }
    this.sendOk(ws, id, { sessions: list })
  }

  // ── JSONL Polling ──

  private pollJsonl(ws: WebSocket, sid: string, session: DaemonSession): void {
    if (ws.readyState !== WebSocket.OPEN) {
      if (session.pollTimer) clearInterval(session.pollTimer)
      return
    }

    try {
      const stat = fs.statSync(session.jsonlPath)
      if (stat.size <= session.offset) return

      const fd = fs.openSync(session.jsonlPath, 'r')
      const buf = Buffer.alloc(stat.size - session.offset)
      fs.readSync(fd, buf, 0, buf.length, session.offset)
      fs.closeSync(fd)
      session.offset = stat.size

      const text = buf.toString('utf-8')
      for (const line of text.split('\n')) {
        if (line.trim()) {
          this.sendEvent(ws, 'jsonl', { sid, line })
        }
      }
    } catch { /* file not ready yet */ }
  }

  // ── Test Injection API ──

  /** Inject a one-shot fault that the next `cmdSend` for `sid` will return. */
  injectSendFault(sid: string, reason: SendFault): void {
    if (reason === null) this._sendFaults.delete(sid)
    else this._sendFaults.set(sid, reason)
  }

  /**
   * Inject a SPAWN failure that every `cmdStart` returns until cleared.
   *
   * The DAEMON owns the spawn, so the CLI path passed to `new ClaudeCodeSession(...)`
   * can never cause one: an unreachable binary just makes the daemon spawn its own
   * default mock-claude. This is the only way for a test to exercise
   * `transport.start()` rejecting (envelope `ok:false`), which is what real
   * spawn failures look like on the wire — `daemon-standalone.ts` cmdStart
   * sendError()s on a missing cwd, a failed mkfifo, or `!proc.pid`.
   *
   * STICKY, unlike injectSendFault's one-shot: a genuinely broken host fails
   * EVERY spawn attempt, and the loop-regression tests need each retry to keep
   * failing so a resurrected retry loop still shows up as N batch-failures.
   * Call `injectStartFault(null)` to clear.
   */
  injectStartFault(reason: string | null): void {
    this._startFault = reason
  }

  /** Broadcast a `session_state` event to all connected ws clients. */
  emitSessionState(sid: string, state: 'spawning' | 'running' | 'dead', extra: Record<string, unknown> = {}): void {
    this.broadcastSessionState(sid, state, extra)
  }

  /** Broadcast an arbitrary event (wire-level: `{ev, ...payload}`) to all clients. */
  emitEvent(ev: string, payload: Record<string, unknown>): void {
    const msg = JSON.stringify({ ev, ...payload })
    for (const ws of this._wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg) } catch { /* ignore */ }
      }
    }
  }

  /** Send an event to ONE client by connIndex — e.g. deliver stt-request on
   *  the bulk socket only (mirrors the daemon's first-client relay pick). */
  emitEventTo(connIndex: number, ev: string, payload: Record<string, unknown>): boolean {
    for (const ws of this._wsClients) {
      if (this._connIndices.get(ws) === connIndex && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ ev, ...payload })) } catch { return false }
        return true
      }
    }
    return false
  }

  /**
   * Mark a session as "dead" on the server — next cmdSend returns session_dead,
   * and a session_state=dead event is broadcast to all clients.
   */
  simulateDeath(sid: string, exitCode: number = 1): void {
    this._deadSessions.set(sid, exitCode)
    const session = this.sessions.get(sid)
    if (session) {
      session.exitCode = exitCode
      if (session.pollTimer) {
        clearInterval(session.pollTimer)
        session.pollTimer = null
      }
    }
    this.broadcastSessionState(sid, 'dead', { exitCode, reason: 'simulate-death' })
  }

  /** Seed a session entry without spawning a real CLI — for orphan/adoption tests. */
  seedSession(sid: string, opts: { pid?: number; alive?: boolean; jsonlContent?: string } = {}): void {
    const streamsDir = this.streamsDir
    const pipePath = path.join(streamsDir, `${sid}.pipe`)
    const jsonlPath = path.join(streamsDir, `${sid}.jsonl`)
    if (opts.jsonlContent) fs.writeFileSync(jsonlPath, opts.jsonlContent)
    const session: DaemonSession = {
      sid,
      proc: null,
      pid: opts.pid ?? 99999,
      pipePath,
      jsonlPath,
      pollTimer: null,
      offset: 0,
      exitCode: opts.alive === false ? 1 : null,
    }
    this.sessions.set(sid, session)
  }

  /** Restart the MockDaemon (simulating daemon crash + recovery). */
  async restart(options: { preserveRegistry?: boolean } = {}): Promise<void> {
    const preservedSessions = options.preserveRegistry ? new Map(this.sessions) : null
    const savedPort = this._port
    // Close WS cleanly
    if (this.wss) {
      for (const client of this.wss.clients) {
        try { client.terminate() } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()))
      this.wss = null
    }
    this._wsClients.clear()
    if (!preservedSessions) {
      this.sessions.clear()
    }
    // Reopen on same port
    this.wss = new WebSocketServer({ port: savedPort, host: '127.0.0.1' })
    await new Promise<void>((resolve, reject) => {
      this.wss!.on('listening', resolve)
      this.wss!.on('error', reject)
    })
    this.wss.on('connection', (ws) => this.registerClient(ws))
  }

  /** Full command history for test assertions. */
  getCommandHistory(): Array<{ cmd: string; payload: Record<string, unknown>; timestamp: number; connIndex: number }> {
    return [...this._commandHistory]
  }

  /** Absolute path of a session's stream file (for marker-line assertions). */
  streamFilePath(sid: string): string {
    return path.join(this.streamsDir, `${sid}.jsonl`)
  }

  /** Commands matching `cmd` name. */
  getCommandHistoryFor(cmd: string): Array<{ payload: Record<string, unknown>; timestamp: number; connIndex: number }> {
    return this._commandHistory
      .filter((e) => e.cmd === cmd)
      .map(({ payload, timestamp, connIndex }) => ({ payload, timestamp, connIndex }))
  }

  /** Clear recorded command history (useful between assertions in the same test). */
  clearCommandHistory(): void {
    this._commandHistory = []
  }

  /** Number of currently-open WS client connections. */
  get clientCount(): number {
    return this._wsClients.size
  }

  /** Server-side terminate the client at `connIndex` (connection order). */
  killClient(connIndex: number): boolean {
    for (const ws of this._wsClients) {
      if (this._connIndices.get(ws) === connIndex) {
        try { ws.terminate() } catch { /* ignore */ }
        return true
      }
    }
    return false
  }

  /** Make subsequent `hello` replies report a DIFFERENT instanceId —
   *  exercises the bulk channel's daemon-identity mismatch guard. */
  injectHelloInstanceMismatch(on: boolean): void {
    this._helloInstanceMismatch = on
  }

  /** Swallow (never reply to) the NEXT command named `cmd` — one-shot.
   *  Forces the client's per-command timeout to fire. */
  swallowNextCommand(cmd: string): void {
    this._swallowNext.add(cmd)
  }

  // ── Helpers ──

  /** Broadcast a session_state event to all connected ws clients. */
  private broadcastSessionState(sid: string, state: string, extra: Record<string, unknown> = {}): void {
    const payload = JSON.stringify({ ev: 'session_state', sid, state, ...extra })
    for (const ws of this._wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload) } catch { /* ignore */ }
      }
    }
  }

  /** ACP op forwarding — mirrors daemon-standalone's cmdAcpOp response shapes. */
  private cmdAcpOp(ws: WebSocket, id: number, cmd: Record<string, unknown>, op: string): void {
    const { sid, ...params } = cmd as { sid?: string }
    if (!sid) return this.sendError(ws, id, op + ': missing sid')
    delete (params as Record<string, unknown>).cmd
    delete (params as Record<string, unknown>).id
    delete (params as Record<string, unknown>).traceId
    void this._acp.acpOp(sid, op, params as Record<string, unknown>).then((resp) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (resp.ok) this.sendOk(ws, id, { result: resp.result })
      else ws.send(JSON.stringify({ id, ok: false, error: resp.error?.message ?? 'acp op failed', errorKind: resp.error?.kind }))
    })
  }

  private sendOk(ws: WebSocket, id: number, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, ok: true, ...data }))
    }
  }

  private sendError(ws: WebSocket, id: number, error: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, ok: false, error }))
    }
  }

  private sendEvent(ws: WebSocket, ev: string, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ev, ...data }))
    }
  }
}

/**
 * Create and start a MockDaemon. Caller must call stop() when done.
 */
export async function createMockDaemon(options: MockDaemonOptions = {}): Promise<MockDaemon> {
  const daemon = new MockDaemon(options)
  await daemon.start()
  return daemon
}
