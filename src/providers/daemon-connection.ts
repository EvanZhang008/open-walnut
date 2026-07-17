/**
 * DaemonConnection — WebSocket client + SSH tunnel to remote walnut-daemon.
 *
 * ARCHITECTURE:
 * One DaemonConnection per remote host. Manages:
 *   1. Deploying daemon.cjs to the remote host
 *   2. Starting the daemon (or connecting to existing)
 *   3. SSH tunnel (localhost:localPort → remote:daemonPort)
 *   4. WebSocket connection through the tunnel
 *   5. Automatic reconnection on tunnel/connection failure
 *
 * LIFECYCLE:
 *   connect() → [send() commands] → disconnect()
 *   On tunnel death: auto-reconnect (daemon survives)
 *   On daemon death: auto-redeploy + restart
 *
 * PROTOCOL:
 *   Commands: { id, cmd, ...params }
 *   Responses: { id, ok, ...data }
 *   Events: { ev, ...data } (no id — unsolicited)
 */

import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { log } from '../logging/index.js'
import { getDaemonSource } from './daemon-source.js'
import { computeExpectedDaemonVersion } from './daemon-version-check.js'
import { REQUIRED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { DAEMON_BINARIES_DIR, IS_EPHEMERAL } from '../constants.js'
import { buildRemotePreamble } from './session-io.js'
import type { SshTarget } from './session-io.js'
import { localDaemon } from './local-daemon.js'

const execFileAsync = promisify(execFileCb)

// ── Types ──

export interface DaemonCommandResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/** L2: daemon-authoritative per-session background-task state, returned by the `getState` RPC.
 *  The daemon materializes this from the same task_* events Walnut sees, so Walnut can PULL it
 *  to reconcile a lost-terminal event without guessing liveness. `resourceVersion` = the byte
 *  offset of the latest applied event (monotonic, rebuilt from the jsonl after a daemon restart). */
export interface DaemonTaskStateEntry { status: string; v: number; t: number; description?: string; isBackgrounded?: boolean }
export interface DaemonTaskState {
  tasks: Record<string, DaemonTaskStateEntry>
  resourceVersion: number
  updatedAt: number
  derivedRunning: number
  recentTransitions: Array<{ taskId: string; status: string; v: number; t: number }>
}
/** Reply shape of the `getState` RPC. `exists:false` = daemon has no record (treat as no bg work).
 *  Extends DaemonCommandResult so a `conn.send()` result casts cleanly (carries `ok`). */
export interface DaemonGetStateResult extends DaemonCommandResult {
  exists?: boolean
  alive?: boolean
  state?: 'running' | 'dead'
  taskState?: DaemonTaskState
}

export interface DaemonEvent {
  ev: string
  sid?: string
  line?: string
  lines?: string[]
  /** L1 versioned events: monotonic per-session byte offset (end of this line in the
   *  append-only jsonl). Identical whether the line is delivered live or via replay, so the
   *  client orders + dedupes by `v` alone. Absent from old daemons — RSM falls back to uuid dedup. */
  v?: number
  agent?: string
  code?: number
  /** Stderr content from the process (only present on exit events with non-zero code) */
  stderr?: string
  /** Authoritative lifecycle state broadcast ('running' | 'dead' | 'spawning') */
  state?: string
  /** Exit code on session_state=dead */
  exitCode?: number
  /** Reason string on session_state=dead (e.g. 'proc-exit', 'send-enxio', 'idle-scan-missed-exit') */
  reason?: string
  [key: string]: unknown
}

type EventHandler = (event: DaemonEvent) => void

interface PendingCommand {
  resolve: (result: DaemonCommandResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Command name + dispatch time, used to log the round-trip RTT when the
   *  daemon's response resolves this command. Lets `debug` logs surface
   *  SSH-tunnel/daemon latency that the enqueue→delivered `deliveryMs` misses. */
  cmd?: string
  startedAt?: number
  traceId?: string
}

// ── DaemonConnection ──

export class DaemonConnection {
  private ws: WebSocket | null = null
  private tunnel: ChildProcess | null = null
  private sshTarget: SshTarget | null
  private hostKey: string
  private localPort: number | null = null
  private remotePort: number | null = null
  private _connected = false
  private _connecting = false
  private _destroyed = false
  private _disconnectedSince: number | null = null
  private cmdCounter = 0
  private pendingCommands = new Map<number, PendingCommand>()
  private eventHandlers: EventHandler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Timestamp of last pong received — used for stale connection detection. */
  private lastPongAt = 0
  /** Counter of consecutive reconnect attempts since last successful connect. Reset in setConnected(true). */
  private _reconnectAttempts = 0
  /** Last WebSocket URL opened — logged on close for troubleshooting. */
  private _lastWsUrl: string | null = null
  /**
   * Daemon instance ID from the most recent successful `hello`. Null until the
   * first handshake. Comparing against the daemon.instance file (or a later
   * hello) detects the "you reconnected to a different daemon" scenario that
   * previously surfaced as stale-state bugs.
   */
  private _daemonInstanceId: string | null = null
  /** Daemon start timestamp from the most recent successful `hello`. */
  private _daemonStartedAt: number | null = null

  /**
   * Last upgrade attempt (expected version + timestamp). Circuit breaker for
   * shouldUpgradeDaemon: if a just-upgraded daemon still reports a mismatch,
   * the stamping/deploy pipeline is broken and killing it again won't help.
   */
  private _lastUpgradeAttempt: { expected: string, at: number } | null = null

  /** Command timeout in ms. Generous for initial deploy operations. */
  private static COMMAND_TIMEOUT_MS = 30_000
  /** Within this window, refuse a second upgrade toward the same expected version. */
  private static UPGRADE_RETRY_COOLDOWN_MS = 10 * 60_000
  /** Initial reconnect delay after connection loss (doubles each attempt, caps at MAX). */
  private static RECONNECT_DELAY_MS = 2_000
  /** Maximum reconnect delay — retries forever at this interval. */
  private static RECONNECT_MAX_DELAY_MS = 30_000
  /** Ping interval for keepalive. */
  private static PING_INTERVAL_MS = 15_000

  /** Cached remote arch (detected once per connection). */
  private _remoteArch: string | null = null
  /** SSH ControlMaster socket path — all SSH commands multiplex through one connection. */
  private _controlPath: string | null = null
  /** ControlMaster SSH process — kept alive for the lifetime of this DaemonConnection. */
  private _controlMaster: ChildProcess | null = null
  /** Tracks whether the last deploy used source (not binary) — affects startDaemon() command. */
  private _deployedViaSource = false
  /** Resolved path to bun on the remote host, or null if unavailable / not yet probed. */
  private _bunPath: string | null = null

  constructor(hostKey: string, sshTarget: SshTarget | null) {
    this.hostKey = hostKey
    this.sshTarget = sshTarget
  }

  /**
   * Access sshTarget with non-null assertion. Only call from SSH-only code paths
   * (connect, deploy, tunnel) — never from connectDirect.
   */
  private get ssh(): SshTarget {
    if (!this.sshTarget) {
      throw new Error(
        `DaemonConnection(${this.hostKey}): SSH path taken but sshTarget is null. ` +
        `This is a bug — local connections should not reach SSH code. ` +
        `Use connectDirect() and reconnect's __local__ branch instead.`
      )
    }
    return this.sshTarget
  }

  /**
   * True when this connection must run read-only against a SHARED remote daemon:
   * an ephemeral server connecting to a real (non-__local__) host. Ephemeral servers
   * run over a snapshot of production data and may ATTACH to an already-running remote
   * daemon to debug live sessions — but they must NEVER deploy, start, stop, or redeploy
   * it. The remote daemon is a singleton (fixed /tmp/open-walnut/daemon.*); two servers
   * deploying/restarting it is what caused the crash loop. Local daemons are exempt:
   * same machine + same binary version means ensureRunning() reuses rather than fights.
   */
  private get isReadOnlyRemote(): boolean {
    return IS_EPHEMERAL && this.hostKey !== '__local__'
  }

  // ── Binary deployment helpers ──

  /**
   * Detect the remote host's architecture via `uname -m`.
   * Cached per connection — only one SSH round-trip.
   */
  private async detectRemoteArch(): Promise<string> {
    if (this._remoteArch) return this._remoteArch
    const raw = (await this.sshExec('uname -m')).trim()
    this._remoteArch = raw === 'aarch64' ? 'arm64' : 'x64'
    return this._remoteArch
  }

  /** Binary name for the detected remote arch. */
  private async getRemoteBinaryName(): Promise<string> {
    return `daemon-linux-${await this.detectRemoteArch()}`
  }

  /** Full remote path where the binary is deployed. */
  private async getRemoteDaemonPath(): Promise<string> {
    return `/tmp/open-walnut/${await this.getRemoteBinaryName()}`
  }

  /**
   * Check if pre-compiled daemon binaries exist locally.
   * Returns the local binary path if available, null otherwise.
   */
  private async getLocalBinaryPath(): Promise<string | null> {
    const binaryPath = path.join(DAEMON_BINARIES_DIR, await this.getRemoteBinaryName())
    try {
      if (fs.statSync(binaryPath).isFile()) return binaryPath
    } catch { /* not built yet */ }
    return null
  }

  get connected(): boolean { return this._connected }
  get disconnectedSince(): number | null { return this._disconnectedSince }
  get daemonInstanceId(): string | null { return this._daemonInstanceId }
  get daemonStartedAt(): number | null { return this._daemonStartedAt }

  /**
   * Centralized setter for _connected — fires the pool-level callback
   * whenever the connection state actually changes, so the server can
   * broadcast the new daemon status to the frontend.
   */
  private setConnected(value: boolean): void {
    const changed = this._connected !== value
    this._connected = value
    if (value) {
      this._disconnectedSince = null
      this._reconnectAttempts = 0
    } else if (changed) {
      this._disconnectedSince = Date.now()
    }
    if (changed && onPoolStatusChange) {
      try {
        const result: void | Promise<void> = onPoolStatusChange()
        // Handle async callbacks: swallow unhandled rejection warnings.
        // The registered callback already has its own inner try/catch for logging.
        if (result instanceof Promise) {
          result.catch(() => {})
        }
      } catch {}
    }
    // Host (re)connected — let SessionRunner redeliver stranded pending messages.
    if (changed && value) notifyHostConnected(this.hostKey)
    // Push the cloud-bridge config on every (re)connect. Single choke point:
    // connect(), reconnect() and forceRedeployAndReconnect() all land here.
    // Fire-and-forget — bridge provisioning must never block or fail a connect.
    if (changed && value) this.pushBridgeConfig()
  }

  /**
   * Tell the daemon where to dial for the phone→cloud→daemon path (see
   * bridge.configure in daemon-standalone.ts). Ephemeral sandboxes skip:
   * they attach to production daemons and must not rewire them.
   */
  private pushBridgeConfig(): void {
    if (this.isReadOnlyRemote) return
    void (async () => {
      try {
        const { getBridgeConfigForHost } = await import('../integrations/cloud-bridge-config.js')
        const cfg = await getBridgeConfigForHost(this.hostKey)
        // Push disabled too — an operator turning the bridge off must reach
        // daemons that already hold a persisted bridge.json.
        await this.send('bridge.configure', cfg as unknown as Record<string, unknown>)
        log.session.info('DaemonConnection: bridge config pushed', {
          host: this.hostKey, enabled: cfg.enabled,
        })
      } catch (err) {
        log.session.warn('DaemonConnection: bridge config push failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  // ── Event subscription ──

  /**
   * Subscribe to unsolicited daemon events (jsonl, exit, agent).
   * Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void {
    // Defensive: never register the same handler reference twice. A double
    // registration makes every daemon event dispatch to that handler twice in
    // a single tick — the root cause of streamed text doubling. RSM routes all
    // (re)subscribes through rebindEventListener() (which unsubscribes first),
    // so this is a belt-and-suspenders guard against any future leaking path.
    if (this.eventHandlers.includes(handler)) {
      return () => {
        const idx = this.eventHandlers.indexOf(handler)
        if (idx >= 0) this.eventHandlers.splice(idx, 1)
      }
    }
    this.eventHandlers.push(handler)
    // DUP-DEBUG: handler count > 1 means multiple subscribers on the same conn —
    // every daemon-pushed event will fan out to all of them, doubling downstream
    // processing. Used to diagnose tool_use rendered twice in remote sessions.
    log.session.info('DaemonConnection.onEvent registered', {
      host: this.hostKey,
      daemonInstanceId: this._daemonInstanceId,
      handlerCount: this.eventHandlers.length,
    })
    return () => {
      const idx = this.eventHandlers.indexOf(handler)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
      log.session.info('DaemonConnection.onEvent unsubscribed', {
        host: this.hostKey,
        daemonInstanceId: this._daemonInstanceId,
        handlerCount: this.eventHandlers.length,
      })
    }
  }

  // ── Connection ──

  /**
   * Connect to the remote daemon. If no daemon is running, deploy and start one.
   * Sets up SSH tunnel and WebSocket connection.
   */
  async connect(): Promise<void> {
    if (this._connected || this._connecting) return
    this._connecting = true
    // Reset destroyed flag — allows reconnection after a previous disconnect().
    // Without this, handleConnectionLost() and scheduleReconnect() silently abort
    // (they gate on _destroyed), so any future connection loss would be permanent.
    this._destroyed = false

    try {
      // Local daemon fast-path: no SSH deploy/tunnel. Ensure the in-process
      // local daemon is running and connect its WebSocket directly. Mirrors
      // reconnect()'s __local__ branch. WITHOUT this, DaemonFileReader('__local__')
      // — used for ALL local session-data reads under the daemon-uniform model —
      // would fall into the SSH path below and try to `ssh __local__` (a literal,
      // unresolvable hostname), failing every local history read whenever the
      // connection pool hadn't already been warmed by an attached session. The
      // pool is only warmed lazily by RemoteSessionManager.connectDirect(), so a
      // history fetch that raced ahead of any session attach (e.g. right after a
      // server restart) returned 0 messages. Self-warming here removes that
      // ordering dependency entirely.
      if (this.hostKey === '__local__') {
        const { localDaemon } = await import('./local-daemon.js')
        await localDaemon.ensureRunning()
        const wsUrl = localDaemon.wsUrl
        if (!wsUrl) throw new Error('Local daemon has no wsUrl after ensureRunning')
        await this.connectWebSocket(wsUrl)
        const ok = await this.verifyCapabilities()
        if (!ok) {
          log.session.warn('DaemonConnection: local connect hello failed — proceeding anyway', {
            host: this.hostKey,
          })
        }
        this.setConnected(true)
        this.startPing()
        this._connecting = false
        log.session.info('DaemonConnection: local connected (direct)', {
          host: this.hostKey, wsUrl, instanceId: this._daemonInstanceId,
        })
        return
      }

      // Step 0: Establish SSH ControlMaster (one connection for all subsequent commands)
      await this.ensureControlMaster()

      // Step 1: Check if daemon is already running
      let daemonPort = await this.checkDaemonRunning()

      if (daemonPort === null) {
        if (this.isReadOnlyRemote) {
          // Ephemeral: attach-only. If no daemon is already running on the shared
          // remote host, do NOT deploy/start one — that would let the throwaway
          // sandbox fight the production server over the singleton daemon.
          throw new Error(
            `ephemeral server: no daemon running on '${this.hostKey}' and ephemeral ` +
            `sandboxes do not deploy/start remote daemons (attach-only)`,
          )
        }
        // Step 2: Deploy daemon
        await this.deployDaemon()

        // Step 3: Start daemon
        daemonPort = await this.startDaemon()
      }

      this.remotePort = daemonPort

      // Step 4: Create SSH tunnel
      this.localPort = await this.createTunnel(daemonPort)

      // Step 5: Connect WebSocket
      await this.connectWebSocket(this.localPort)

      // Step 6: Capability handshake — final guard against protocol drift.
      // Run BEFORE setConnected(true) so the pool-status broadcast doesn't let
      // external callers send real commands (e.g. sendRaw) through a stale
      // daemon. verifyCapabilities uses _sendHandshake() which bypasses the
      // _connected gate in send().
      //
      // Even if version strings match (Layers 1-3 happy), the binary could be
      // corrupted or hand-swapped. An old daemon without `hello` returns
      // `unknown command: hello` → redeploy. A newer daemon that's somehow
      // missing a capability → redeploy. See daemon-capabilities.ts for the
      // required list.
      const handshakeOk = await this.verifyCapabilities()
      if (!handshakeOk) {
        if (this.isReadOnlyRemote) {
          // Ephemeral attach-only: a capability mismatch must NOT trigger a redeploy
          // (that would restart the production daemon). The running daemon belongs to
          // production and is almost certainly fine; bail instead of fighting it.
          throw new Error(
            `ephemeral server: capability handshake failed on '${this.hostKey}' and ` +
            `ephemeral sandboxes do not redeploy remote daemons (attach-only)`,
          )
        }
        log.session.warn('DaemonConnection: capability handshake failed — forcing redeploy', {
          host: this.hostKey,
        })
        // Tear down tunnel + WS, stop remote daemon, redeploy, reconnect.
        // forceRedeployAndReconnect handles its own setConnected(true) on
        // success; on failure it throws, caught by the outer try/catch.
        await this.forceRedeployAndReconnect()
      } else {
        this.setConnected(true)
      }
      this._connecting = false

      // Start ping keepalive
      this.startPing()

      log.session.info('DaemonConnection: connected', {
        host: this.hostKey,
        localPort: this.localPort,
        remotePort: daemonPort,
      })

      // Initial connection: recover any sessions that were left in error state
      // from a previous server run (e.g. server restart while sessions were error).
      this.recoverDisconnectedSessions().catch(() => {})
    } catch (err) {
      this._connecting = false
      throw err
    }
  }

  /**
   * Send a command to the daemon and wait for a response.
   *
   * Auto-injects a `traceId` into the payload when the caller hasn't supplied
   * one. This lets `grep <traceId>` stitch together a turn across walnut logs,
   * daemon logs, and (via --debug) Claude CLI logs. Callers who want a trace
   * ID that outlives one `send()` (e.g. the whole turn — send → jsonl → result)
   * should supply their own.
   */
  async send(cmd: string, params: Record<string, unknown> = {}): Promise<DaemonCommandResult> {
    if (!this._connected || !this.ws) {
      throw new Error(`DaemonConnection not connected to ${this.hostKey}`)
    }

    const id = ++this.cmdCounter
    const traceId = typeof params.traceId === 'string' && params.traceId
      ? params.traceId
      : crypto.randomBytes(4).toString('hex')
    const payload = { id, cmd, ...params, traceId }
    const message = JSON.stringify(payload)

    // Per-command send log — paired with daemon's cmd_recv log (same traceId).
    // Skip `ping` to avoid spamming the logs (it fires every 15s, adds nothing
    // we can't infer from the pong gap timer).
    if (cmd !== 'ping') {
      log.session.debug('DaemonConnection: send', {
        host: this.hostKey,
        cmd,
        id,
        traceId,
        sid: typeof params.sid === 'string' ? params.sid : undefined,
        daemonInstanceId: this._daemonInstanceId,
      })
    }

    const startedAt = Date.now()
    return new Promise<DaemonCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        reject(new Error(`daemon command timeout: ${cmd} (${DaemonConnection.COMMAND_TIMEOUT_MS}ms) [traceId=${traceId}]`))
      }, DaemonConnection.COMMAND_TIMEOUT_MS)

      this.pendingCommands.set(id, { resolve, reject, timer, cmd, startedAt, traceId })
      this.ws!.send(message)
    })
  }

  /**
   * Answer a daemon-relayed STT request (phone voice input arriving over the
   * cloud bridge while this box holds the transcription engine). Runs the
   * configured local engine and replies with an `stt-result` carrying the
   * relayId. Errors are reported back (not thrown) so the daemon can fail the
   * bridge request and let the cloud box fall back to OpenAI. The audio
   * payload is never logged.
   */
  private async handleSttRequest(event: DaemonEvent): Promise<void> {
    const relayId = event.relayId
    const audio = event.audio
    const format = event.format
    if (typeof relayId !== 'number' || typeof audio !== 'string' || typeof format !== 'string') return
    let reply: Record<string, unknown>
    try {
      const { getConfig } = await import('../core/config-manager.js')
      const { transcribeAudio } = await import('../core/stt/index.js')
      const result = await transcribeAudio(await getConfig(), {
        audio, format,
        language: typeof event.language === 'string' && event.language !== '' ? event.language : undefined,
      })
      log.session.info('DaemonConnection: stt relay transcribed', {
        host: this.hostKey, relayId, chars: result.text.length, durationMs: result.durationMs,
      })
      reply = { relayId, text: result.text, durationMs: result.durationMs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: stt relay failed', { host: this.hostKey, relayId, message })
      reply = { relayId, error: message }
    }
    try {
      await this.send('stt-result', reply)
    } catch (err) {
      log.session.warn('DaemonConnection: stt-result send failed', {
        host: this.hostKey, relayId, message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Disconnect from the daemon and clean up SSH tunnel.
   * Does NOT stop the daemon — it continues running independently.
   *
   * WARNING: Sets _destroyed=true, which permanently disables auto-reconnect
   * (handleConnectionLost and scheduleReconnect both gate on this flag).
   * Only use for intentional teardown (e.g. disconnectAllDaemons on server shutdown).
   * NEVER call on a shared pool connection from error-recovery paths — use
   * `this.conn = null` instead to drop the local reference safely.
   */
  disconnect(): void {
    this._destroyed = true
    this.setConnected(false)
    this._connecting = false

    // Cancel reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Stop ping
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    // Reject pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer)
      pending.reject(new Error('connection closed'))
    }
    this.pendingCommands.clear()

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    // Kill SSH tunnel
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }

    // Stop SSH ControlMaster (fire-and-forget — cleanup only)
    this.stopControlMaster().catch(() => {})

    log.session.info('DaemonConnection: disconnected', { host: this.hostKey })
  }

  // ── Private: SSH helpers ──

  private get sshHostString(): string {
    return this.ssh.user
      ? `${this.ssh.user}@${this.ssh.hostname}`
      : this.ssh.hostname
  }

  private get baseSshArgs(): string[] {
    return this.buildSshArgs({ useControlMaster: true })
  }

  /**
   * Build SSH args. ControlMaster muxing forwards stdin fine on OpenSSH ≥9; the
   * `useControlMaster: false` opt-out remains for callers that explicitly want a
   * fresh TCP connection (e.g. chunked retry path that tries to dodge a flaky
   * mux session on transient proxy errors).
   */
  private buildSshArgs(opts: { useControlMaster: boolean } = { useControlMaster: true }): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
    if (this.ssh.port) args.push('-p', String(this.ssh.port))
    if (opts.useControlMaster && this._controlPath) {
      args.push('-o', `ControlPath=${this._controlPath}`)
    }
    return args
  }

  /**
   * Start an SSH ControlMaster — a persistent background SSH connection that
   * all subsequent SSH commands multiplex through. This avoids opening 5-7
   * separate SSH connections during connect(), which triggers rate-limiting
   * on corporate hosts.
   */
  private async ensureControlMaster(): Promise<void> {
    if (this._controlMaster) return
    const socketPath = path.join(os.tmpdir(), `walnut-ssh-${this.hostKey}-${process.pid}`)
    this._controlPath = socketPath

    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ControlPath=${socketPath}`,
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPersist=300',  // keep alive 5 min after last use
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.ssh.port) args.push('-p', String(this.ssh.port))
    args.push('-fN', this.sshHostString)  // -f: background, -N: no command

    try {
      await execFileAsync('ssh', args, { timeout: 15_000 })
      // execFileAsync resolves when -f backgrounds. ControlMaster is now running.
      log.session.info('DaemonConnection: SSH ControlMaster started', {
        host: this.hostKey, socketPath,
      })
    } catch (err) {
      log.session.warn('DaemonConnection: ControlMaster failed, falling back to individual connections', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      this._controlPath = null
    }
  }

  /**
   * Stop the SSH ControlMaster connection.
   */
  private async stopControlMaster(): Promise<void> {
    if (this._controlPath) {
      try {
        await execFileAsync('ssh', ['-o', `ControlPath=${this._controlPath}`, '-O', 'exit', this.sshHostString], {
          timeout: 5_000,
        })
      } catch { /* already gone */ }
      this._controlPath = null
    }
    this._controlMaster = null
  }

  /**
   * Stream a single buffer to a remote file in one SSH connection.
   * Uses ControlMaster mux when available so we don't pay handshake cost.
   * Verifies remote sha256 + size before resolving — some corporate SSH proxies
   * sometimes truncate mid-stream while still exiting code 0.
   * Returns true on success, false on any failure (caller decides whether to fall back).
   */
  private async pipeSingleStream(data: Buffer, remotePath: string, expectedSha256: string): Promise<boolean> {
    const args = [
      ...this.baseSshArgs,
      this.sshHostString,
      `cat > ${remotePath} && sha256sum ${remotePath} | awk '{print $1}' && wc -c < ${remotePath}`,
    ]
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdin!.on('error', () => {})

    let stdout = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })

    const ok = await new Promise<boolean>((resolve) => {
      proc.on('error', () => resolve(false))
      // Generous timeout — 100MB at ~5MB/s = 20s; allow 3min for headroom.
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(false) }, 180_000)
      proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
      proc.stdin!.end(data)
    })

    if (!ok) return false

    const lines = stdout.trim().split(/\s+/).filter(Boolean)
    const remoteSha = lines[0]
    const remoteSize = parseInt(lines[1] ?? '0', 10)
    if (remoteSize !== data.length || remoteSha !== expectedSha256) {
      log.session.warn('DaemonConnection: single-stream upload verification failed', {
        host: this.hostKey, expectedBytes: data.length, gotBytes: remoteSize,
        expectedSha: expectedSha256.slice(0, 12), gotSha: remoteSha?.slice(0, 12),
      })
      return false
    }
    return true
  }

  /**
   * Pipe a data chunk to a remote file via SSH stdin.
   * Writes to a per-chunk file (overwrite, not append) so retries don't produce duplicates.
   * Verifies the remote file size matches the data length.
   * Returns true on success, false if the connection was killed or data was truncated.
   */
  private async pipeChunk(data: Buffer, remoteDir: string, chunkIndex: number): Promise<boolean> {
    const chunkFile = `${remoteDir}/chunk_${String(chunkIndex).padStart(4, '0')}`
    // Write data then echo the byte count for verification
    const args = [...this.buildSshArgs({ useControlMaster: false }), this.sshHostString, `cat > ${chunkFile} && wc -c < ${chunkFile}`]
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdin!.on('error', () => {})  // swallow EPIPE if SSH dies mid-write

    let stdout = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })

    const ok = await new Promise<boolean>((resolve) => {
      proc.on('error', () => resolve(false))
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(false) }, 30_000)
      proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
      proc.stdin!.end(data)
    })

    if (!ok) return false

    // Verify size — proxy can kill mid-write but SSH may still exit 0
    const remoteSize = parseInt(stdout.trim(), 10)
    if (remoteSize !== data.length) {
      log.session.warn('DaemonConnection: chunk size mismatch', {
        host: this.hostKey, chunkIndex, expected: data.length, got: remoteSize,
      })
      return false
    }
    return true
  }

  /**
   * Execute a command on the remote host via SSH and return stdout.
   * Uses ControlMaster if available (single TCP connection for all commands).
   */
  private async sshExec(remoteCmd: string, timeoutMs = 10_000): Promise<string> {
    const args = [...this.baseSshArgs, this.sshHostString, remoteCmd]
    const { stdout } = await execFileAsync('ssh', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
    })
    return stdout.trim()
  }

  // ── Private: Daemon management ──

  /**
   * Check if daemon is already running on the remote host.
   * Returns the port number if running, null otherwise.
   *
   * Tries the binary first, then falls back to the old node-based daemon
   * (in case a previous source-deploy daemon is still running).
   */
  private async checkDaemonRunning(opts: { strict?: boolean } = {}): Promise<number | null> {
    // Shell uses `|| true` so sshExec only rejects on real SSH failures (dead
    // ControlMaster, tunnel, network). A missing daemon just returns empty stdout.
    // Without this, a dead ControlMaster is indistinguishable from a dead daemon
    // and triggers a wasteful redeploy on every tunnel hiccup.
    let binarySshErr: unknown = null
    try {
      const remotePath = await this.getRemoteDaemonPath()
      const result = await this.sshExec(`${remotePath} --status 2>/dev/null || true`)
      if (result) {
        const status = JSON.parse(result)
        if (status.running && status.port) {
          if (await this.shouldUpgradeDaemon(remotePath)) {
            return null
          }
          log.session.info('DaemonConnection: daemon already running (binary)', {
            host: this.hostKey, port: status.port, pid: status.pid,
          })
          return status.port
        }
      }
    } catch (err) {
      binarySshErr = err
    }

    // Fallback: runtime-agnostic file probe. Whichever runtime started the
    // daemon (node, bun, binary), it wrote daemon.pid + daemon.port. Reading
    // those + `kill -0` works without knowing which runtime we used last time
    // — important when this DaemonConnection was just constructed and
    // _bunPath isn't populated yet, but a bun-started daemon is still alive
    // from a previous server run.
    let fileSshErr: unknown = null
    try {
      const result = await this.sshExec(
        'PID=$(cat /tmp/open-walnut/daemon.pid 2>/dev/null); ' +
        'PORT=$(cat /tmp/open-walnut/daemon.port 2>/dev/null); ' +
        '[ -n "$PID" ] && [ -n "$PORT" ] && kill -0 "$PID" 2>/dev/null && ' +
        'echo "{\\"running\\":true,\\"pid\\":$PID,\\"port\\":$PORT}" || true',
        5_000,
      )
      if (result) {
        const status = JSON.parse(result)
        if (status.running && status.port) {
          // Same staleness check as the binary arm — a source/bun daemon can
          // be outdated too (it writes daemon.version at startup just like the
          // binary). Without this, hosts where the binary probe fails would
          // keep an old source daemon alive forever.
          const remotePath = await this.getRemoteDaemonPath()
          if (await this.shouldUpgradeDaemon(remotePath)) {
            return null
          }
          log.session.info('DaemonConnection: daemon already running (source/bun)', {
            host: this.hostKey, port: status.port, pid: status.pid,
          })
          return status.port
        }
      }
    } catch (err) {
      fileSshErr = err
    }

    // Both probes reached SSH but got back empty → daemon genuinely absent.
    if (!binarySshErr && !fileSshErr) return null

    // Strict mode (reconnect path): SSH itself failed — propagate so callers can
    // retry/rebuild ControlMaster instead of misdiagnosing as "daemon died".
    if (opts.strict) {
      throw (binarySshErr ?? fileSshErr) as Error
    }
    // Non-strict (initial connect): treat SSH failure as absent → deploy.
    return null
  }

  /**
   * Decide whether the RUNNING remote daemon is stale and must be replaced.
   * If stale, stop it and return true (caller should redeploy).
   *
   * Probes /tmp/open-walnut/daemon.version — written at startup by whichever
   * daemon is actually running (compiled binary or source daemon.cjs).
   *
   * MUST NOT probe by executing the on-disk binary's --version: deployDaemon
   * prefers source deploys (bun + daemon.cjs) and never refreshes the binary
   * file, so the binary on disk can be permanently stale while the running
   * daemon is current. Probing the binary made the mismatch unresolvable —
   * every reconnect cycle --stop'ed the healthy daemon, redeployed source,
   * and 30s later found the same stale binary again (infinite kill loop,
   * surfaced as ECONNRESET on every in-flight session).
   */
  private async shouldUpgradeDaemon(remotePath: string): Promise<boolean> {
    // Ephemeral attach-only: never upgrade (which would --stop the production
    // daemon). Version skew between the ephemeral's binary and production's is
    // expected and must not trigger a restart of the shared singleton.
    if (this.isReadOnlyRemote) return false
    try {
      const expected = this.getExpectedDaemonVersion()
      if (!expected) return false

      const remoteVersion = (await this.sshExec(
        'cat /tmp/open-walnut/daemon.version 2>/dev/null || true', 5_000,
      )).trim()

      if (remoteVersion === expected) {
        this._lastUpgradeAttempt = null
        return false
      }

      // Circuit breaker: if we already upgraded toward this same expected
      // version moments ago and the daemon STILL reports a mismatch, the
      // upgrade pipeline itself is broken (e.g. version stamping regressed).
      // Killing the daemon again won't converge — keep the running daemon
      // alive and scream instead of looping.
      if (
        this._lastUpgradeAttempt
        && this._lastUpgradeAttempt.expected === expected
        && Date.now() - this._lastUpgradeAttempt.at < DaemonConnection.UPGRADE_RETRY_COOLDOWN_MS
      ) {
        log.session.error('DaemonConnection: daemon version still mismatched after recent upgrade — refusing to loop', {
          host: this.hostKey, expected, remoteVersion: remoteVersion || '(missing)',
          lastAttemptAgoMs: Date.now() - this._lastUpgradeAttempt.at,
        })
        return false
      }

      // Mismatch (or legacy daemon that predates daemon.version) → upgrade.
      log.session.info('DaemonConnection: daemon version mismatch — stopping for upgrade', {
        host: this.hostKey, expected, remoteVersion: remoteVersion || '(missing)',
      })
      this._lastUpgradeAttempt = { expected, at: Date.now() }
      // Stop both runtimes: binary --stop kills via pid file; the explicit
      // pid-file kill covers hosts where the binary was never deployed.
      try { await this.sshExec(`${remotePath} --stop 2>/dev/null || true`, 5_000) } catch {}
      try {
        await this.sshExec(
          'PID=$(cat /tmp/open-walnut/daemon.pid 2>/dev/null); ' +
          '[ -n "$PID" ] && kill "$PID" 2>/dev/null; ' +
          'rm -f /tmp/open-walnut/daemon.pid /tmp/open-walnut/daemon.port /tmp/open-walnut/daemon.version; true',
          5_000,
        )
      } catch {}
      return true
    } catch {
      // Version check failed — don't block, just reuse existing daemon
      return false
    }
  }

  /**
   * The daemon version this server expects on the remote host.
   * Source-of-truth: hash of the daemon source tree (identical to what
   * build-daemon.sh bakes into binaries AND what getDaemonSource() stamps
   * into source deploys). Sidecar fallback covers installs without src/.
   */
  private getExpectedDaemonVersion(): string | null {
    const computed = computeExpectedDaemonVersion()
    if (computed) return computed
    try {
      const localBinary = path.join(DAEMON_BINARIES_DIR, 'daemon-linux-x64')
      const v = fs.readFileSync(localBinary + '.version', 'utf-8').trim()
      return v || null
    } catch {
      return null
    }
  }

  /**
   * Send one command directly on this.ws, bypassing the _connected gate that
   * send() enforces. Used exclusively by verifyCapabilities() during the
   * pre-connect handshake window, when the ws is open but _connected has not
   * yet been flipped true.
   */
  private _sendHandshake(cmd: string, params: Record<string, unknown> = {}): Promise<DaemonCommandResult> {
    if (!this.ws) {
      return Promise.reject(new Error(`DaemonConnection: ws not open for ${this.hostKey}`))
    }
    const id = ++this.cmdCounter
    const message = JSON.stringify({ id, cmd, ...params })
    return new Promise<DaemonCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        reject(new Error(`daemon command timeout: ${cmd} (${DaemonConnection.COMMAND_TIMEOUT_MS}ms)`))
      }, DaemonConnection.COMMAND_TIMEOUT_MS)
      this.pendingCommands.set(id, { resolve, reject, timer })
      this.ws!.send(message)
    })
  }

  /**
   * Send `hello` to the daemon and verify it advertises every required
   * capability. Returns true on full match, false on any mismatch (including
   * "unknown command: hello" from pre-hello daemons).
   *
   * Called right after the WS opens, before any real commands are sent.
   *
   * Pre-hello daemons may not respond at all (they don't even return
   * 'unknown command') — the send() timeout is what catches that case, so
   * timeout == drift.
   */
  private async verifyCapabilities(): Promise<boolean> {
    try {
      const res = await this._sendHandshake('hello', {})
      if (!res.ok) {
        log.session.warn('DaemonConnection: hello returned !ok', {
          host: this.hostKey, reason: res.reason, error: res.error,
        })
        return false
      }
      const caps = Array.isArray(res.capabilities) ? res.capabilities as string[] : []
      const missing = REQUIRED_DAEMON_CAPABILITIES.filter(c => !caps.includes(c))
      if (missing.length > 0) {
        log.session.warn('DaemonConnection: daemon missing capabilities', {
          host: this.hostKey,
          version: res.version,
          missing,
          got: caps,
        })
        return false
      }
      // Capture instance ID — if this differs from a prior value, the daemon
      // was swapped out from under us. We don't fail here (could be the first
      // handshake, or a deliberate restart), but downstream reconnect logic
      // can compare and decide whether to invalidate per-session state.
      const newInstanceId = typeof res.instanceId === 'string' ? res.instanceId : null
      const newStartedAt = typeof res.startedAt === 'number' ? res.startedAt : null
      const changed =
        this._daemonInstanceId !== null &&
        newInstanceId !== null &&
        this._daemonInstanceId !== newInstanceId
      if (changed) {
        log.session.warn('DaemonConnection: daemon instance changed across reconnect', {
          host: this.hostKey,
          priorInstanceId: this._daemonInstanceId,
          newInstanceId,
          newStartedAt,
        })
      }
      this._daemonInstanceId = newInstanceId
      this._daemonStartedAt = newStartedAt
      log.session.info('DaemonConnection: capability handshake OK', {
        host: this.hostKey,
        version: res.version,
        capCount: caps.length,
        instanceId: newInstanceId,
        uptimeSec: typeof res.uptimeSec === 'number' ? res.uptimeSec : undefined,
      })
      return true
    } catch (err) {
      // Timeout or WS closed mid-hello — treat as drift, force redeploy
      log.session.warn('DaemonConnection: hello failed', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /**
   * Tear down the current connection, stop the remote daemon, redeploy, and
   * reconnect. Used when the capability handshake reveals a stale binary.
   *
   * Throws if redeploy/reconnect fails or the post-redeploy handshake still
   * fails — caller (connect()) will catch and surface the error. The internal
   * try/catch ensures a mid-helper throw still leaves the object in a clean
   * disconnected state (ws/tunnel nulled, _connected=false) so reconnect
   * logic can retry.
   */
  private async forceRedeployAndReconnect(): Promise<void> {
    // Backstop: ephemeral attach-only must never redeploy/restart a shared remote
    // daemon. Callers (connect, reconnect) already guard, but this is the single
    // method that performs the destructive --stop + deploy + start, so refuse here
    // too — defense in depth against any future caller.
    if (this.isReadOnlyRemote) {
      throw new Error(
        `ephemeral server: refusing forceRedeployAndReconnect on '${this.hostKey}' (attach-only)`,
      )
    }
    log.session.info('DaemonConnection: forcing redeploy due to capability drift', {
      host: this.hostKey,
    })

    // Close WS + tunnel, but keep ControlMaster (we'll reuse it).
    try { this.ws?.close() } catch {}
    this.ws = null
    this.setConnected(false)

    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }
    this.localPort = null

    try {
      // Stop BOTH the binary daemon AND the source daemon — a previous connect
      // may have fallen back to source deploy (corp SSH proxy kills large
      // binary transfers), leaving a node daemon running. On a fresh binary
      // deploy the port-binding and pid-file would clash if we don't also kill
      // the source daemon first.
      try {
        const remotePath = await this.getRemoteDaemonPath()
        await this.sshExec(`${remotePath} --stop 2>/dev/null || true`, 5_000)
      } catch {}
      // Runtime-agnostic stop for source/bun daemons — kill by pid file.
      // Avoids needing to know whether the running daemon was launched under
      // node or bun (the --stop subcommand is symmetric in source).
      try {
        await this.sshExec(
          'PID=$(cat /tmp/open-walnut/daemon.pid 2>/dev/null); ' +
          '[ -n "$PID" ] && kill "$PID" 2>/dev/null; ' +
          'rm -f /tmp/open-walnut/daemon.pid /tmp/open-walnut/daemon.port; true',
          5_000,
        )
      } catch {}

      // Redeploy + start + tunnel + reconnect
      await this.deployDaemon()
      const daemonPort = await this.startDaemon()
      this.remotePort = daemonPort
      this.localPort = await this.createTunnel(daemonPort)
      await this.connectWebSocket(this.localPort)

      // Re-verify BEFORE flipping _connected so external sends can't slip
      // through if the new binary is also broken.
      const ok = await this.verifyCapabilities()
      if (!ok) {
        log.session.error('DaemonConnection: capability handshake STILL failing after redeploy', {
          host: this.hostKey,
        })
        throw new Error('DaemonConnection: capability handshake still failing after forced redeploy — giving up')
      }
      this.setConnected(true)
    } catch (err) {
      // Ensure clean teardown so the outer reconnect machinery can retry.
      // Casts are needed because TS control-flow has narrowed this.ws /
      // this.tunnel to `never` after the pre-try assignments to null above;
      // connectWebSocket and createTunnel re-populate them via side effects
      // that TS can't track through an async call boundary.
      const currentWs = this.ws as WebSocket | null
      try { currentWs?.close() } catch {}
      this.ws = null
      const currentTunnel = this.tunnel as ChildProcess | null
      if (currentTunnel) {
        try { currentTunnel.kill('SIGTERM') } catch {}
        this.tunnel = null
      }
      this.localPort = null
      this.setConnected(false)
      throw err
    }
  }

  /**
   * Deploy daemon to the remote host.
   *
   * Prefers binary deployment (fast, no runtime deps) when pre-compiled binaries
   * are available. Falls back to source-based deploy (node + npm install ws) when
   * binaries haven't been built yet (dev workflow).
   */
  private async deployDaemon(): Promise<void> {
    // Preferred path: bun + ~63KB JS source. Bypasses corporate-proxy bulk-transfer kills
    // entirely (binary is 37MB compressed; source is gzipped to ~17KB on the
    // wire). Bun is a single static binary so probe-or-install completes in a
    // few seconds when missing. Falls through to binary on probe/install
    // failure (offline hosts, restrictive networks, glibc-too-old for bun).
    const bunPath = await this.probeOrInstallBun()
    if (bunPath) {
      try {
        await this.deploySource()
        this._bunPath = bunPath
        this._deployedViaSource = true
        return
      } catch (err) {
        log.session.warn('DaemonConnection: bun source deploy failed, falling back to binary', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
        this._bunPath = null
      }
    }

    const localBinary = await this.getLocalBinaryPath()

    if (localBinary) {
      try {
        await this.deployBinary(localBinary)
        this._deployedViaSource = false
        return
      } catch (err) {
        // Binary deploy failed (e.g. SSH proxy killed the transfer).
        // Fall back to lightweight source deploy (~44KB, always passes).
        log.session.warn('DaemonConnection: binary deploy failed, falling back to source deploy', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      log.session.info('DaemonConnection: no binary found, falling back to source deploy', {
        host: this.hostKey, binaryDir: DAEMON_BINARIES_DIR,
      })
    }

    await this.deploySource()
    this._deployedViaSource = true
  }

  /**
   * Probe for bun on the remote host. If absent, attempt one-shot install via
   * the official curl|bash script (which fetches from bun.sh — egress from the
   * remote, NOT through the corporate proxy). Returns the resolved bun executable path, or
   * null if probe and install both failed.
   */
  private async probeOrInstallBun(): Promise<string | null> {
    // Probe: PATH first, then the install script's default location. Returning
    // an absolute path lets startDaemon() exec bun without depending on shell_setup.
    const probeCmd =
      `if command -v bun >/dev/null 2>&1; then command -v bun; ` +
      `elif [ -x "$HOME/.bun/bin/bun" ]; then echo "$HOME/.bun/bin/bun"; ` +
      `else echo MISSING; fi`
    let path: string
    try {
      path = (await this.sshExec(probeCmd, 10_000)).trim().split('\n').pop()?.trim() || ''
    } catch (err) {
      log.session.warn('DaemonConnection: bun probe failed', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    if (path && path !== 'MISSING') {
      log.session.info('DaemonConnection: bun present', { host: this.hostKey, path })
      return path
    }

    // Install. The install script writes to ~/.bun/bin/bun and downloads ~30MB
    // straight from bun.sh — that's a remote-host outbound HTTPS connection,
    // bypassing the corporate proxy entirely. 90s budget covers slow corporate egress.
    log.session.info('DaemonConnection: bun absent, attempting one-shot install', {
      host: this.hostKey,
    })
    try {
      await this.sshExec('curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1', 90_000)
    } catch (err) {
      log.session.warn('DaemonConnection: bun install failed — will fall back to binary', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    try {
      const after = (await this.sshExec(probeCmd, 5_000)).trim().split('\n').pop()?.trim() || ''
      if (after && after !== 'MISSING') {
        log.session.info('DaemonConnection: bun installed', { host: this.hostKey, path: after })
        return after
      }
    } catch {}

    log.session.warn('DaemonConnection: bun install reported success but probe still missing', {
      host: this.hostKey,
    })
    return null
  }

  /**
   * Deploy a pre-compiled binary to the remote host.
   * Much faster than source deploy — no npm install, no node PATH discovery.
   */
  private async deployBinary(localBinaryPath: string): Promise<void> {
    const t0 = Date.now()
    const binarySize = fs.statSync(localBinaryPath).size

    try {
      // Create directory
      await this.sshExec('mkdir -p /tmp/open-walnut')

      // Check if remote binary is already up to date by comparing version strings.
      // The binary embeds a version via --define at build time.
      // We read the local version from a sidecar .version file (written by build script)
      // because the binary is cross-compiled for Linux and can't run on the local host.
      let needsDeploy = true
      try {
        const versionFile = localBinaryPath + '.version'
        const localVersion = fs.readFileSync(versionFile, 'utf-8').trim()
        const remoteDaemonPath = await this.getRemoteDaemonPath()
        const remoteVersion = await this.sshExec(`${remoteDaemonPath} --version 2>/dev/null`, 5_000)
        if (localVersion && remoteVersion && localVersion === remoteVersion) {
          needsDeploy = false
          log.session.info('DaemonConnection: binary already up to date', {
            host: this.hostKey, version: localVersion,
          })
        }
      } catch { /* version check failed — deploy fresh */ }

      if (needsDeploy) {
        // Strategy: stream the whole gzipped binary in one SSH connection (mux'd
        // through ControlMaster). Empirically ~5s on success for our 37MB binary,
        // sha256-verified end-to-end. some corporate SSH proxies kill large
        // transfers *probabilistically* — at 37MB roughly 60% succeed; at 40MB+
        // success rate drops sharply (measured 0/2 at 40MB, 0/2 at 45MB). The
        // proxy decision isn't deterministic on size alone, so we always try
        // single-stream first (huge win when it works), then fall back to a
        // chunked path (256KB × N over individual SSH connections) which
        // survives proxy interference at the cost of being ~10x slower.
        const remotePath = await this.getRemoteDaemonPath()
        const gzPath = localBinaryPath + '.gz'

        // Compress if needed (cached alongside binary)
        if (!fs.existsSync(gzPath)) {
          await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(gzPath)
            const gzip = spawn('gzip', ['-c', localBinaryPath], { stdio: ['pipe', 'pipe', 'pipe'] })
            gzip.stdout!.pipe(out)
            out.on('finish', resolve)
            gzip.on('error', reject)
            out.on('error', reject)
          })
        }

        const gzData = fs.readFileSync(gzPath)
        const gzSize = gzData.length
        const gzSha256 = crypto.createHash('sha256').update(gzData).digest('hex')

        // Try single-stream first.
        const singleOk = await this.pipeSingleStream(gzData, `${remotePath}.gz`, gzSha256)
        if (singleOk) {
          const unpackResult = await this.sshExec(
            `gunzip -f ${remotePath}.gz && chmod +x ${remotePath} && ${remotePath} --version`,
            30_000,
          )
          const remoteBinaryName = await this.getRemoteBinaryName()
          log.session.info('DaemonConnection: binary deployed via single SSH stream', {
            host: this.hostKey, deployMs: Date.now() - t0,
            bytes: binarySize, gzBytes: gzSize, binary: remoteBinaryName,
            remoteVersion: unpackResult.trim(),
          })
          return
        }

        log.session.warn('DaemonConnection: single-stream deploy failed, falling back to chunked', {
          host: this.hostKey, gzBytes: gzSize,
        })
        // Fall through to chunked path below.
        // 256KB — deep under the corporate proxy’s ~5MB kill threshold AND any per-connection
        // byte-rate throttling. Larger chunks (1MB) were the main failure mode
        // pre-2026-05-05: corp proxies would kill ~half the chunks on a ~40MB
        // binary, blowing past MAX_RETRIES=2, falling back to source deploy,
        // which then failed on old-glibc hosts — leaving the daemon dead.
        //
        // Tune by observation, not theory — too small wastes SSH setup overhead
        // (per-chunk connection cost dominates); too large hits proxy kills.
        // 256KB was chosen after observing proxy kills consistently at ~1MB and
        // confirming 256KB survives reliably across proxy variants.
        const CHUNK_SIZE = 262_144
        const totalChunks = Math.ceil(gzSize / CHUNK_SIZE)
        const chunkDir = '/tmp/open-walnut/deploy_chunks'

        // Clean any partial previous transfer
        await this.sshExec(`rm -rf ${chunkDir} && mkdir -p ${chunkDir}`, 5_000).catch(() => {})

        // Per-chunk retry budget: proxy kills are transient. 5 attempts per
        // chunk with exponential backoff (3s → 5s → 10s → 15s → 20s) gives
        // us ~53s per bad chunk before accepting defeat.
        //
        // Total failure cap: ~5 min worst case under sustained proxy
        // interference (30 failures × mixed backoffs + per-chunk SSH cost).
        // Source-deploy fallback is still faster than giving up on upgrade
        // permanently, so err on the robust side here.
        //
        // Values chosen empirically — 5 retries per chunk handled the observed
        // proxy transient kills on 40MB deploys during the 2026-05-05 incident.
        // Tune downward only with data; the cost of failing the deploy is
        // ~30min of blocked remote sessions until the user notices.
        const MAX_CHUNK_RETRIES = 5
        const BACKOFF_MS = [3_000, 5_000, 10_000, 15_000, 20_000]
        const MAX_TOTAL_FAILURES = 30
        let totalFailures = 0

        for (let i = 0; i < totalChunks; i++) {
          // Abort fast if the connection was torn down mid-deploy — user should
          // not have to wait out retries/backoff after a destroy().
          if (this._destroyed) throw new Error('deploy aborted: connection destroyed')

          const offset = i * CHUNK_SIZE
          const chunk = gzData.subarray(offset, offset + CHUNK_SIZE)

          let chunkAttempt = 0
          // Each chunk writes to its own file (overwrite) — retries are safe
          let ok = await this.pipeChunk(chunk, chunkDir, i)
          while (!ok) {
            chunkAttempt++
            totalFailures++
            if (totalFailures > MAX_TOTAL_FAILURES) {
              throw new Error(
                `binary deploy failed: ${totalFailures} total chunk failures across ${totalChunks} chunks — proxy actively blocking, will fall back to source deploy`,
              )
            }
            if (chunkAttempt > MAX_CHUNK_RETRIES) {
              throw new Error(
                `binary deploy failed: chunk ${i + 1}/${totalChunks} killed ${chunkAttempt} times — will fall back to source deploy`,
              )
            }
            // ±20% jitter prevents lockstep retry collision when multiple
            // Walnut instances happen to be deploying to the same host.
            const baseDelay = BACKOFF_MS[Math.min(chunkAttempt - 1, BACKOFF_MS.length - 1)]
            const delayMs = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
            log.session.info('DaemonConnection: chunk transfer killed by proxy, retrying', {
              host: this.hostKey, chunk: i + 1, totalChunks,
              chunkAttempt, totalFailures, delayMs,
            })
            // Second abort gate: don't burn the full backoff if we're being torn down.
            if (this._destroyed) throw new Error('deploy aborted: connection destroyed')
            await new Promise(r => setTimeout(r, delayMs))
            ok = await this.pipeChunk(chunk, chunkDir, i)
          }

          // Progress log every 16 chunks (~4MB) so a 160-chunk (~40MB) upload
          // shows ~10 progress markers without log spam.
          if (i % 16 === 0 || i === totalChunks - 1) {
            log.session.info('DaemonConnection: binary deploy progress', {
              host: this.hostKey, chunk: i + 1, totalChunks,
              percent: Math.round(((i + 1) / totalChunks) * 100),
            })
          }

          // Brief pause between chunks to avoid triggering rate limits.
          // 250ms (vs old 1000ms) because 256KB chunks = 4x as many chunks;
          // keep total deploy wall-clock roughly constant.
          if (i < totalChunks - 1) {
            await new Promise(r => setTimeout(r, 250))
          }
        }

        // Reassemble chunks and verify size before unpacking
        const remoteSize = parseInt(
          await this.sshExec(`cat ${chunkDir}/chunk_* > ${remotePath}.gz && wc -c < ${remotePath}.gz`, 30_000),
          10,
        )
        if (remoteSize !== gzSize) {
          await this.sshExec(`rm -rf ${chunkDir} ${remotePath}.gz`, 5_000).catch(() => {})
          throw new Error(`binary deploy size mismatch: remote=${remoteSize} local=${gzSize}`)
        }

        // Unpack and make executable
        const unpackResult = await this.sshExec(
          `rm -rf ${chunkDir} && gunzip -f ${remotePath}.gz && chmod +x ${remotePath} && ${remotePath} --version`,
          30_000,
        )

        const remoteBinaryName = await this.getRemoteBinaryName()
        log.session.info('DaemonConnection: binary deployed via chunked pipe', {
          host: this.hostKey, deployMs: Date.now() - t0,
          bytes: binarySize, gzBytes: gzSize, chunks: totalChunks,
          totalFailures, binary: remoteBinaryName, remoteVersion: unpackResult.trim(),
        })
      }
    } catch (err) {
      throw new Error(`Failed to deploy daemon binary to ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Source-based deploy: pipe daemon.cjs (~44KB) + npm install ws.
   * Primary fallback when binary deploy fails (e.g. SSH proxy kills large transfers).
   */
  private async deploySource(): Promise<void> {
    const source = getDaemonSource()
    const t0 = Date.now()
    const preamble = buildRemotePreamble(this.ssh.shell_setup)

    try {
      // Create directory and clean up legacy daemon.js (which breaks under "type":"module")
      await this.sshExec('mkdir -p /tmp/open-walnut && rm -f /tmp/open-walnut/daemon.js')

      const args = [...this.baseSshArgs, this.sshHostString, 'cat > /tmp/open-walnut/daemon.cjs']
      const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      proc.stdin!.on('error', () => {})  // prevent EPIPE crash if SSH dies

      await new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`daemon source deploy failed with code ${code}`))
        })
        proc.on('error', reject)
        proc.stdin!.end(source)
      })

      // Ensure 'ws' package is available for the daemon's WebSocket server.
      // When bun is the runtime we skip this entirely — daemon-source.ts has a
      // raw HTTP-upgrade fallback (createManualWsServer) that kicks in when
      // require('ws') fails, and that's what serves WS under bun. Skipping
      // saves 5-30s and avoids EBADPLATFORM on hosts without npm.
      if (!this._bunPath) {
        try {
          await this.sshExec(`${preamble}; cd /tmp/open-walnut && node -e "require('ws')" 2>/dev/null || (rm -f package.json && npm install --prefix /tmp/open-walnut ws 2>/dev/null)`, 30_000)
        } catch {
          log.session.debug('DaemonConnection: ws install skipped', { host: this.hostKey })
        }
      }

      log.session.info('DaemonConnection: daemon source deployed', {
        host: this.hostKey, deployMs: Date.now() - t0, bytes: source.length,
      })
    } catch (err) {
      throw new Error(`Failed to deploy daemon source to ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Start the daemon on the remote host. Returns the listening port.
   *
   * Uses the binary directly when deployed (no PATH discovery needed).
   * Falls back to node + preamble for source-based deployments.
   */
  private async startDaemon(): Promise<number> {
    try {
      // Determine the start command based on what was deployed.
      // Binary: direct execution. Source: needs node PATH discovery.
      //
      // Why `--status` AFTER `cat daemon.port`: the port file can linger from
      // a previous daemon that crashed, making `cat daemon.port` look like
      // success while the current spawn is already dead. `--status` (binary)
      // or `kill -0 <pid>` (source) confirms a running process, not just a
      // leftover port file. Without this, pre-2026-05-05 startup reported
      // "success" while a glibc-crashed node left the daemon dead — caller
      // happily tunneled to a port nobody was listening on.
      // Binary has `--status` subcommand; source daemon doesn't, so use `kill -0`
      // on its PID file instead. See daemon-source.ts — no --status handler.
      // Readiness probe: POLL for the port file + live pid, up to ~45s.
      // A fixed `sleep 2` raced daemon boot on loaded hosts (a busy dev box
      // took ~20s from nohup to port write) — the probe declared failure
      // while the daemon was still booting, connect() threw, and overlapping
      // retries then stop-for-upgrade'd each other's half-booted daemons in a
      // loop. Net effect: a 43-minute host outage that only self-healed when
      // a retry landed after some earlier spawn finished booting. The poll
      // breaks the loop by letting the FIRST attempt succeed.
      const waitReady =
        'for i in $(seq 1 22); do ' +
        'DPID=$(cat /tmp/open-walnut/daemon.pid 2>/dev/null); ' +
        '[ -s /tmp/open-walnut/daemon.port ] && [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null && break; ' +
        'sleep 2; done'
      const confirmRunning =
        'cat /tmp/open-walnut/daemon.port && echo && ' +
        'DPID=$(cat /tmp/open-walnut/daemon.pid 2>/dev/null) && ' +
        '[ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null && echo "{\\"running\\":true}"'

      let startCmd: string
      if (this._deployedViaSource && this._bunPath) {
        // Source deployed under bun — exec bun by absolute path (no preamble).
        // The daemon source itself sources ~/.zshrc / ~/.bashrc on startup to
        // populate process.env.PATH so cmdStart's spawn('claude', ...) finds the
        // CLI. See daemon-source.ts "PATH setup" block.
        startCmd = `nohup ${this._bunPath} /tmp/open-walnut/daemon.cjs --start > /tmp/open-walnut/daemon-start.log 2>&1 & ` +
          `${waitReady}; ${confirmRunning}`
      } else if (!this._deployedViaSource && await this.getLocalBinaryPath()) {
        // Binary deploy — run directly, no PATH setup needed
        const remotePath = await this.getRemoteDaemonPath()
        startCmd = `nohup ${remotePath} --start > /tmp/open-walnut/daemon-start.log 2>&1 & ` +
          `${waitReady}; cat /tmp/open-walnut/daemon.port && echo && ${remotePath} --status`
      } else {
        // Source deploy under node — needs node PATH discovery.
        // `[ -n "$DPID" ]` guards against empty pid file (cat succeeds but
        // yields empty → `kill -0 ""` behavior is shell-dependent; some emit
        // the current shell's pid).
        const preamble = buildRemotePreamble(this.ssh.shell_setup)
        startCmd = `${preamble}; nohup node /tmp/open-walnut/daemon.cjs --start > /tmp/open-walnut/daemon-start.log 2>&1 & ` +
          `${waitReady}; ${confirmRunning}`
      }

      const output = await this.sshExec(startCmd, 60_000)

      // Parse out port + status confirmation. Defensive against preamble noise:
      // the source-deploy branch runs shell_setup which may source rc files
      // that print banners, MOTDs, or nvm/pyenv init lines. Match by shape:
      // port = pure digits, status = contains "running":true.
      const lines = output.trim().split('\n').map(l => l.trim()).filter(Boolean)
      // Extract port: prefer a pure-digit line, fall back to leading digits of
      // any line (handles cases where port file has no trailing newline and
      // concatenates with the next command's output, e.g. "32899{\"running\":true}").
      let portStr = lines.find(l => /^\d+$/.test(l)) || ''
      if (!portStr) {
        for (const l of lines) {
          const m = l.match(/^(\d+)/)
          if (m) { portStr = m[1]; break }
        }
      }
      const statusLine = lines.find(l => l.includes('"running":true')) || ''
      const port = parseInt(portStr, 10)

      if (isNaN(port) || port < 1 || port > 65535 || !statusLine.includes('"running":true')) {
        // Read the startup log for diagnostics and detect the specific failure
        // modes we've seen in production.
        let startLog = ''
        try { startLog = await this.sshExec('cat /tmp/open-walnut/daemon-start.log 2>/dev/null', 5_000) } catch {}

        let hint = ''
        if (/GLIBC_\d/.test(startLog)) {
          hint = ' [glibc mismatch: the node binary on PATH requires newer glibc than this host has. '
            + 'Check `node -v` on the remote — if it errors, install an older nvm-managed node (v16 on AL2/RHEL7). '
            + 'Prefer binary daemon deploy which avoids node entirely.]'
        } else if (startLog.includes('EADDRINUSE')) {
          hint = ' [port in use: another daemon already running — try `daemon --stop` first]'
        } else if (startLog.includes('Permission denied')) {
          hint = ' [permission denied: /tmp/open-walnut may be owned by a different user]'
        }

        throw new Error(
          `daemon failed to start (port='${portStr}', status='${statusLine}')${hint}. `
          + `Startup log: ${startLog.slice(0, 500)}`,
        )
      }

      log.session.info('DaemonConnection: daemon started', { host: this.hostKey, port })
      return port
    } catch (err) {
      throw new Error(`Failed to start daemon on ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Create an SSH tunnel from localPort to remote daemonPort.
   * Returns the local port number.
   */
  private async createTunnel(remotePort: number): Promise<number> {
    // Find a free local port
    const { createServer } = await import('node:net')
    const localPort = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })

    // Create SSH tunnel (ssh -L localPort:localhost:remotePort -N host)
    const args = [
      ...this.baseSshArgs,
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      '-N',  // No remote command — just tunnel
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      this.sshHostString,
    ]

    this.tunnel = spawn('ssh', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.tunnel.unref()

    // Monitor tunnel death for auto-reconnect
    this.tunnel.on('exit', (code) => {
      log.session.warn('DaemonConnection: SSH tunnel died', {
        host: this.hostKey, code, localPort, remotePort,
      })
      this.tunnel = null
      this.handleConnectionLost()
    })

    // Wait for tunnel to be ready — poll until the local port accepts connections.
    // SSH tunnel needs time to establish the port forwarding. Fixed sleeps are unreliable.
    const tunnelReady = await this.waitForTunnel(localPort, 10_000)
    if (!tunnelReady) {
      throw new Error(`SSH tunnel created but port ${localPort} not accepting connections after 10s`)
    }

    log.session.info('DaemonConnection: SSH tunnel created', {
      host: this.hostKey, localPort, remotePort,
    })

    return localPort
  }

  /**
   * Wait for the SSH tunnel local port to accept TCP connections.
   * Polls every 200ms up to timeoutMs.
   */
  private async waitForTunnel(localPort: number, timeoutMs: number): Promise<boolean> {
    const { createConnection } = await import('node:net')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port: localPort }, () => {
          sock.destroy()
          resolve(true)
        })
        sock.on('error', () => { sock.destroy(); resolve(false) })
        sock.setTimeout(500, () => { sock.destroy(); resolve(false) })
      })
      if (ok) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  /**
   * Connect directly to a WebSocket URL, bypassing SSH deploy/tunnel.
   * Used by tests to connect RemoteSessionManager to a local MockDaemon.
   */
  async connectDirect(wsUrl: string): Promise<void> {
    if (this._connected) return
    await this.connectWebSocket(wsUrl)
    this.setConnected(true)
    this.startPing()
  }

  /**
   * Connect WebSocket through the SSH tunnel (or directly via URL).
   */
  private connectWebSocket(urlOrPort: number | string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = typeof urlOrPort === 'string' ? urlOrPort : `ws://127.0.0.1:${urlOrPort}`
      this._lastWsUrl = url
      // maxPayload stays at the ws default (100MB) DELIBERATELY — it is the
      // tripwire that caught inc-1783842393500 (134MB one-frame fs.read of a
      // whale JSONL → "Max payload size exceeded"). DaemonFileReader chunks all
      // big file reads to 1MB frames now; the largest remaining legit frame is
      // a git.diff response (git stdout capped at 64MB in cmdGitDiff), so do
      // NOT lower this without chunking git.diff first.
      const ws = new WebSocket(url, { handshakeTimeout: 10_000 })

      ws.on('open', () => {
        this.ws = ws
        this.lastPongAt = Date.now()
        resolve()
      })

      ws.on('error', (err) => {
        if (!this._connected) {
          const errDetails = (err as Error & { code?: string }).code || err.message || 'no details'
          reject(new Error(
            `WebSocket connection failed: ${errDetails} (host=${this.hostKey}, url=${url})`
          ))
        } else {
          log.session.warn('DaemonConnection: WebSocket error', {
            host: this.hostKey, error: err.message,
          })
        }
      })

      ws.on('close', () => {
        if (this._connected) {
          let localDaemonPidAlive: boolean | null = null
          if (this.hostKey === '__local__') {
            try {
              const pid = localDaemon.pid
              if (pid !== null && pid !== undefined) {
                try { process.kill(pid, 0); localDaemonPidAlive = true }
                catch { localDaemonPidAlive = false }
              }
            } catch {}
          }
          log.session.warn('DaemonConnection: WebSocket closed', {
            host: this.hostKey,
            wsUrl: this._lastWsUrl,
            localDaemonPidAlive,
          })
          this.handleConnectionLost()
        }
      })

      ws.on('message', (data) => {
        this.handleMessage(typeof data === 'string' ? data : data.toString())
      })

      ws.on('pong', () => {
        this.lastPongAt = Date.now()
      })

      // Timeout
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timeout'))
      }, 10_000)

      ws.on('open', () => clearTimeout(timer))
    })
  }

  // ── Private: Message handling ──

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }

    // Command response (has 'id' field)
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingCommands.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingCommands.delete(msg.id)
        // Per-command round-trip RTT — paired with the `DaemonConnection: send`
        // dispatch log by traceId. This is the SSH-tunnel/daemon hop that the
        // enqueue→delivered `deliveryMs` field omits; on a slow tunnel a `send`
        // RTT spike here is the smoking gun for "message send is slow". Skip
        // `ping` (fires every 15s, adds noise). Gated at debug (zero overhead by
        // default); enable with WALNUT_LOG_LEVEL=debug.
        if (pending.cmd && pending.cmd !== 'ping' && pending.startedAt != null) {
          log.session.debug('DaemonConnection: recv (rtt)', {
            host: this.hostKey,
            cmd: pending.cmd,
            id: msg.id,
            traceId: pending.traceId,
            rttMs: Date.now() - pending.startedAt,
            ok: (msg as { ok?: boolean }).ok ?? null,
          })
        }
        pending.resolve(msg as unknown as DaemonCommandResult)
      }
      return
    }

    // Unsolicited event (has 'ev' field)
    if ('ev' in msg) {
      const event = msg as unknown as DaemonEvent
      // STT relay (cloud voice input): the daemon forwards phone audio from
      // its bridge here because this box has the transcription engine. Handled
      // internally — session-level eventHandlers never see it.
      if (event.ev === 'stt-request') {
        void this.handleSttRequest(event)
        return
      }
      // DUP-DEBUG: if handlerCount > 1, every event below fans out N times.
      // jsonl events are high-frequency — only log when something is off
      // (multiple handlers) or for low-frequency event types.
      if (this.eventHandlers.length !== 1 || event.ev !== 'jsonl') {
        log.session.debug('DaemonConnection: dispatch event', {
          host: this.hostKey,
          ev: event.ev,
          sid: (event as { sid?: string }).sid,
          handlerCount: this.eventHandlers.length,
        })
      }
      for (const handler of this.eventHandlers) {
        try { handler(event) } catch {}
      }
    }
  }

  // ── Private: Reconnection ──

  private handleConnectionLost(): void {
    if (this._destroyed || !this._connected) return

    this.setConnected(false)

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    // Stop ping
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    log.session.info('DaemonConnection: connection lost, scheduling reconnect', {
      host: this.hostKey, delayMs: DaemonConnection.RECONNECT_DELAY_MS,
    })

    // Schedule reconnect with exponential backoff (2s → 4s → 8s → … → 60s max), forever
    this.scheduleReconnect(DaemonConnection.RECONNECT_DELAY_MS)
  }

  private scheduleReconnect(delayMs: number): void {
    if (this._destroyed || this._connected || this.reconnectTimer) return

    // Auto-reconnect for __local__ is a pool-instance privilege. A __local__
    // connection outside the pool is an orphan from the pre-pool leak (or a
    // future bypass construction site) — letting it keep a permanent backoff
    // loop is exactly how the 100-instance reconnect storm formed. Scoped to
    // __local__: tests legitimately hold private direct-ws connections to
    // per-test MockDaemons under other host keys. WALNUT_LOCAL_CONN_POOL=0
    // (legacy private-connection mode) disables the guard too.
    if (this.hostKey === '__local__' && process.env.WALNUT_LOCAL_CONN_POOL !== '0' && !isPooledConnection(this)) {
      log.session.warn('DaemonConnection: skipping auto-reconnect for non-pooled __local__ instance', {
        host: this.hostKey,
      })
      this.disconnect()
      return
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this._destroyed || this._connected) return
      this._reconnectAttempts += 1
      try {
        await this.reconnect()
      } catch (err) {
        log.session.warn('DaemonConnection: reconnect failed, will retry', {
          host: this.hostKey,
          attempt: this._reconnectAttempts,
          stuckForMs: this._disconnectedSince ? Date.now() - this._disconnectedSince : null,
          error: err instanceof Error ? err.message : String(err),
          nextDelayMs: Math.min(delayMs * 2, DaemonConnection.RECONNECT_MAX_DELAY_MS),
        })
        this.scheduleReconnect(Math.min(delayMs * 2, DaemonConnection.RECONNECT_MAX_DELAY_MS))
      }
    }, delayMs)
  }

  /**
   * Reconnect to the daemon after connection loss.
   * The daemon is still running — we just need a new tunnel + WebSocket.
   */
  private async reconnect(): Promise<void> {
    if (this._destroyed) return

    log.session.info('DaemonConnection: attempting reconnect', { host: this.hostKey })

    // Local daemon path: no SSH tunnel / ControlMaster — just re-ensure the
    // in-process daemon is running and reconnect the WebSocket. Going through
    // the SSH branch would dereference sshTarget (null for __local__) and loop
    // forever in backoff.
    if (this.hostKey === '__local__' || !this.sshTarget) {
      const { localDaemon } = await import('./local-daemon.js')
      await localDaemon.ensureRunning()
      const wsUrl = localDaemon.wsUrl
      if (!wsUrl) throw new Error('Local daemon has no wsUrl after ensureRunning')
      await this.connectWebSocket(wsUrl)
      // Re-verify capabilities + refresh instance ID. Skipping this leaves
      // _daemonInstanceId pointing at the pre-crash daemon; downstream
      // instance-change detection would then silently miss restarts.
      const ok = await this.verifyCapabilities()
      if (!ok) {
        log.session.warn('DaemonConnection: local reconnect hello failed — proceeding anyway', {
          host: this.hostKey,
        })
      }
      this.setConnected(true)
      this.startPing()
      log.session.info('DaemonConnection: local reconnected', {
        host: this.hostKey, wsUrl, instanceId: this._daemonInstanceId,
      })
      this.recoverDisconnectedSessions().catch(() => {})
      return
    }

    // Reset deploy flags — if daemon is still alive we skip deploy entirely;
    // if daemon died, deployDaemon() will set these correctly.
    this._deployedViaSource = false
    this._bunPath = null

    // Kill old tunnel if any
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }

    // When the WebSocket/tunnel drops, the ControlMaster usually died with it.
    // Tear it down and rebuild before probing — otherwise every SSH command
    // silently fails through a dead socket and we misdiagnose a live daemon
    // as dead, burning ~10s on a pointless redeploy.
    await this.stopControlMaster().catch(() => {})
    await this.ensureControlMaster()

    // Check if daemon is still running. Strict mode: an SSH failure now means
    // the link is still broken (not that the daemon died) — surface it so the
    // outer reconnect loop retries with backoff instead of redeploying.
    let daemonPort: number | null
    try {
      daemonPort = await this.checkDaemonRunning({ strict: true })
    } catch (err) {
      log.session.warn('DaemonConnection: daemon status probe failed via SSH — will retry reconnect', {
        host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    if (daemonPort === null) {
      if (this.isReadOnlyRemote) {
        // Ephemeral attach-only: the shared remote daemon is genuinely gone. Do NOT
        // redeploy/restart it (that race is the crash loop). Surface so the reconnect
        // loop backs off; if production restarts the daemon, a later attach succeeds.
        throw new Error(
          `ephemeral server: daemon absent on '${this.hostKey}' — attach-only, not redeploying`,
        )
      }
      // Daemon genuinely absent — redeploy and restart
      log.session.info('DaemonConnection: daemon not running, redeploying', { host: this.hostKey })
      await this.deployDaemon()
      daemonPort = await this.startDaemon()
    }

    this.remotePort = daemonPort

    // Create new tunnel
    this.localPort = await this.createTunnel(daemonPort)

    // Connect WebSocket
    await this.connectWebSocket(this.localPort)

    // Re-verify capabilities + refresh daemon instance ID. If instance
    // changed (daemon was restarted out-of-band), verifyCapabilities logs
    // the transition — downstream session probes then resume via --resume
    // naturally, but the log line is the critical diagnostic.
    const priorInstanceId = this._daemonInstanceId
    const handshakeOk = await this.verifyCapabilities()
    if (!handshakeOk) {
      if (this.isReadOnlyRemote) {
        // Ephemeral attach-only: don't redeploy on reconnect handshake failure.
        throw new Error(
          `ephemeral server: reconnect handshake failed on '${this.hostKey}' — attach-only, not redeploying`,
        )
      }
      log.session.warn('DaemonConnection: reconnect hello failed — forcing redeploy', {
        host: this.hostKey,
      })
      await this.forceRedeployAndReconnect()
      // forceRedeploy handles setConnected(true). recoverDisconnectedSessions
      // still needs to run even on forced-redeploy path.
      this.recoverDisconnectedSessions().catch(() => {})
      return
    }
    this.setConnected(true)
    this.startPing()

    log.session.info('DaemonConnection: reconnected', {
      host: this.hostKey,
      localPort: this.localPort,
      remotePort: daemonPort,
      instanceId: this._daemonInstanceId,
      instanceChanged: priorInstanceId !== null && priorInstanceId !== this._daemonInstanceId,
    })

    // Auto-recover sessions that were marked error due to disconnect
    this.recoverDisconnectedSessions().catch(() => {})
  }

  /** After successful reconnect, recover sessions marked error due to connection loss. */
  private async recoverDisconnectedSessions(): Promise<void> {
    try {
      const { listSessions, updateSessionRecord } = await import('../core/session-tracker.js')
      const { bus, EventNames } = await import('../core/event-bus.js')
      const sessions = await listSessions()

      for (const s of sessions) {
        // Normalize host before comparing: local sessions persist no `host`
        // field (host=null/undefined), but the local connection's hostKey is
        // '__local__'. A raw `s.host !== this.hostKey` is therefore ALWAYS true
        // for local sessions, so every local session was silently skipped here
        // — after any local-daemon WS flap their daemon-side subscriber was
        // never re-added, the JSONL watcher fan'd new output to a dead
        // subscriber set, and the UI froze ("running, no output") until a manual
        // refresh re-subscribed. Mirror the canonical `host ?? '__local__'`
        // normalization used elsewhere (e.g. frequent-dirs.ts).
        if ((s.host ?? '__local__') !== this.hostKey) continue
        if (s.archived) continue

        // Reattach any non-terminal session. Both `running` (mid-turn) and
        // `idle` (FIFO session between turns, CLI alive waiting for stdin) must
        // be re-subscribed: on ws close the daemon's handleDisconnect removes
        // us from session.subscribers, but the session-bound JSONL watcher
        // keeps running — any new CLI output after reconnect is fan'd out to a
        // dead subscriber set and lost. Skipping `idle` here was the cause of
        // "messages deliver but Claude never replies in UI" after any WS flap.
        // `stopped` is terminal (CLI dead); `error` without "Connection lost"
        // is a real user-visible error, don't auto-recover — let the next
        // user message trigger a fresh --resume spawn.
        const isTerminal = s.process_status === 'stopped'
        const isNonRecoverableError = s.process_status === 'error'
          && !s.errorMessage?.includes('Connection lost')
        if (isTerminal || isNonRecoverableError) continue

        // Ask daemon if this session's process is still alive
        try {
          const result = await this.send('status', { sid: s.claudeSessionId })
          if (result.ok && result.alive) {
            // Preserve 'idle' if that's what the session was before reconnect —
            // FIFO sessions sit in 'idle' between turns and forcing 'running'
            // would lie to the UI (no turn actually in flight).
            const recoveredStatus = s.process_status === 'idle' ? 'idle' : 'running'
            await updateSessionRecord(s.claudeSessionId, {
              process_status: recoveredStatus,
              errorMessage: undefined,
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'daemon_reconnected',
              status_changed_by: 'daemon',
            } as any)
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: s.claudeSessionId,
              taskId: s.taskId,
              process_status: recoveredStatus,
            }, ['*'], { source: 'daemon-reconnect', urgency: 'urgent' })
            log.session.info('DaemonConnection: auto-recovered session after reconnect', {
              sessionId: s.claudeSessionId, host: this.hostKey,
              priorStatus: s.process_status,
              recoveredStatus,
            })

            // Re-subscribe this new ws to the session's push stream. Under
            // the new session-bound watcher model the daemon's file tailer
            // never stopped — but ws.close removed us from the subscribers
            // Set. send('attach') re-adds us and replays any bytes we missed
            // (catch-up from our tracked fromOffset). Under the old per-ws
            // watcher model this was the only way to get push back at all,
            // since the tailer was destroyed on ws.close. Either way, calling
            // reattachWatcher is correct and idempotent.
            try {
              const { getRegisteredSessionManager } = await import('./session-manager.js')
              const mgr = getRegisteredSessionManager(s.claudeSessionId)
              type Reattachable = { reattachWatcher?: () => Promise<boolean> }
              const reattachable = mgr as unknown as Reattachable | undefined
              if (reattachable?.reattachWatcher) {
                await reattachable.reattachWatcher()
              } else {
                log.session.debug('DaemonConnection: no manager to reattach — session has no active subscriber', {
                  sessionId: s.claudeSessionId, host: this.hostKey,
                })
              }
            } catch (err) {
              log.session.warn('DaemonConnection: reattach watcher failed (recovery continued)', {
                sessionId: s.claudeSessionId, host: this.hostKey,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          } else {
            // Process died during disconnect — mark stopped so session is resumable.
            // Don't inject a message; user's next message will trigger --resume naturally.
            // For stuck-running case: emitting 'stopped' triggers server.ts
            // belt-and-suspenders → sessionStreamBuffer.markDone+clear → UI Streaming
            // badge clears. JSONL history API serves full turn content independently.
            await updateSessionRecord(s.claudeSessionId, {
              process_status: 'stopped',
              errorMessage: undefined,
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'daemon_reported_exit',
              status_changed_by: 'daemon',
            } as any)
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: s.claudeSessionId,
              taskId: s.taskId,
              process_status: 'stopped',
            }, ['*'], { source: 'daemon-reconnect', urgency: 'urgent' })
            log.session.info('DaemonConnection: cleared error on dead session after reconnect', {
              sessionId: s.claudeSessionId, host: this.hostKey,
              priorStatus: s.process_status,
            })
          }
        } catch (err) {
          log.session.debug('DaemonConnection: failed to probe session during recovery', {
            sessionId: s.claudeSessionId, host: this.hostKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log.session.warn('DaemonConnection: recoverDisconnectedSessions failed', {
        host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      // Detect stale connection: if no pong received for 3 ping intervals, connection is dead.
      // 3x (45s) instead of 2x absorbs transient event-loop stalls at boot (QMD rebuild,
      // session recovery) that previously cascaded into disconnect→reconnect→mass reattach.
      if (this.lastPongAt > 0 && Date.now() - this.lastPongAt > DaemonConnection.PING_INTERVAL_MS * 3) {
        log.session.warn('DaemonConnection: no pong received, connection stale', {
          host: this.hostKey,
          lastPongAgoMs: Date.now() - this.lastPongAt,
        })
        this.handleConnectionLost()
        return
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      }
    }, DaemonConnection.PING_INTERVAL_MS)
  }
}

// ── Pool-level status change callback ──

let onPoolStatusChange: (() => void | Promise<void>) | null = null

/**
 * Register a callback that fires whenever any DaemonConnection's
 * connected state changes.  Used by server.ts to broadcast daemon
 * status to the frontend via WebSocket. May be async — the caller
 * swallows the returned promise's rejection.
 */
export function setOnDaemonStatusChange(cb: () => void | Promise<void>): void {
  onPoolStatusChange = cb
}

// ── Pool-level reconnect callback (event-driven message redelivery) ──

let onHostConnected: ((hostKey: string) => void) | null = null

/**
 * Register a callback fired when a host's daemon connection transitions to
 * connected. SessionRunner uses this to redeliver queue messages that were
 * stranded in 'pending' by a delivery failure (SSH outage) — the event-driven
 * replacement for the old behavior of spin-retrying after every SESSION_ERROR.
 *
 * Single-subscriber by design: a second registration silently clobbers the
 * previous callback. Registering anything other than SessionRunner's
 * redelivery hook would strand pending messages on reconnect, reintroducing
 * the 2026-06-10 message-loss bug.
 */
export function setOnDaemonHostConnected(cb: (hostKey: string) => void): void {
  onHostConnected = cb
}

/** Internal: invoked by DaemonConnection.setConnected(true) transitions. */
function notifyHostConnected(hostKey: string): void {
  // The host is provably reachable — drop any stale failure-cache entry NOW.
  // setConnected(true) fires inside connect(), BEFORE getDaemonConnection's
  // .then() clears the cache; without this, an immediate redelivery would
  // fast-fail against the stale entry.
  failureCache.delete(hostKey)
  if (!onHostConnected) return
  try { onHostConnected(hostKey) } catch { /* redelivery must never break connect */ }
}

// ── Connection Pool ──

/** Pool of DaemonConnections — one per remote host. */
const connectionPool = new Map<string, DaemonConnection>()
/** Pending connection promises — prevents concurrent connect() races. */
const connectingPromises = new Map<string, Promise<DaemonConnection>>()
/** Cache recent connection failures to avoid repeated 42s SSH timeouts. */
const failureCache = new Map<string, { time: number; error: string }>()
const FAILURE_CACHE_TTL_MS = 60_000  // 60s — longer than the worst-case SSH timeout (~42s) to avoid retrying mid-failure

/**
 * Get or create a DaemonConnection for a remote host.
 * Returns a connected connection ready for commands.
 * Thread-safe: concurrent callers share the same connect() promise.
 *
 * Caches connection failures for 60s to avoid blocking the event loop
 * with repeated SSH timeout attempts when a host is unreachable.
 */
export async function getDaemonConnection(hostKey: string, sshTarget: SshTarget): Promise<DaemonConnection> {
  // Fast path: already connected
  const existing = connectionPool.get(hostKey)
  if (existing?.connected) return existing

  // Check failure cache — avoid retrying a recently-failed host
  const cached = failureCache.get(hostKey)
  if (cached && Date.now() - cached.time < FAILURE_CACHE_TTL_MS) {
    throw new Error(`Connection to ${hostKey} failed recently (${Math.round((Date.now() - cached.time) / 1000)}s ago): ${cached.error}`)
  }

  // Dedup: if another caller is already connecting, wait for their result
  const pending = connectingPromises.get(hostKey)
  if (pending) return pending

  // Create and connect
  let conn = connectionPool.get(hostKey)
  if (!conn) {
    conn = new DaemonConnection(hostKey, sshTarget)
    connectionPool.set(hostKey, conn)
  }

  const promise = conn.connect().then(() => {
    connectingPromises.delete(hostKey)
    failureCache.delete(hostKey)  // Clear failure cache on success
    return conn!
  }).catch((err) => {
    connectingPromises.delete(hostKey)
    // Cache the failure so subsequent requests fail fast
    failureCache.set(hostKey, {
      time: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  })

  connectingPromises.set(hostKey, promise)
  return promise
}

/**
 * Pooled variant of connectDirect() — ONE shared connection per WebSocket URL.
 *
 * Before this existed, every local session's RemoteSessionManager did a private
 * `new DaemonConnection(...).connectDirect(wsUrl)`, bypassing the pool. Those
 * instances were never destroyed (kill()/cleanup() deliberately leave the conn
 * alone, assuming it's shared) — so a server that had started 100+ local
 * sessions held 100+ live connections, each with its own ping timer and its own
 * permanent exponential-backoff reconnect loop. One local-daemon restart then
 * produced 100+ simultaneous reconnects (the observed reconnect storm) and the
 * daemon carried 100+ useless WS clients.
 *
 * Pool key is the wsUrl (`direct:<wsUrl>`), not the hostKey: tests spin up
 * per-test MockDaemons on distinct ports and must not share connections.
 *
 * Rollback: WALNUT_LOCAL_CONN_POOL=0 restores the private-connection behavior
 * at the call site (remote-session-manager.ts).
 */
export async function getDirectDaemonConnection(hostKey: string, wsUrl: string): Promise<DaemonConnection> {
  const poolKey = `direct:${wsUrl}`
  const existing = connectionPool.get(poolKey)
  if (existing?.connected) return existing

  const pending = connectingPromises.get(poolKey)
  if (pending) return pending

  let conn = connectionPool.get(poolKey)
  if (!conn) {
    conn = new DaemonConnection(hostKey, null)
    connectionPool.set(poolKey, conn)
  }

  const promise = conn.connectDirect(wsUrl).then(() => {
    connectingPromises.delete(poolKey)
    return conn!
  }).catch((err) => {
    connectingPromises.delete(poolKey)
    throw err
  })

  connectingPromises.set(poolKey, promise)
  return promise
}

/**
 * True when this instance is (still) the pooled connection for some key.
 * Auto-reconnect is a pool-instance privilege — see scheduleReconnect.
 */
export function isPooledConnection(conn: DaemonConnection): boolean {
  for (const pooled of connectionPool.values()) {
    if (pooled === conn) return true
  }
  return false
}

/**
 * Forget a cached connection failure so the next getDaemonConnection() retries
 * immediately instead of fast-failing for up to 60s. Call this on a user-initiated
 * retry (e.g. after they run mwinit) — the 60s cache is meant to throttle automatic
 * reconnects, not to block a deliberate human retry.
 */
export function clearDaemonFailureCache(hostKey?: string): void {
  if (hostKey) failureCache.delete(hostKey)
  else failureCache.clear()
}

/**
 * Disconnect all daemon connections. Called on server shutdown.
 */
export function disconnectAllDaemons(): void {
  for (const [key, conn] of connectionPool) {
    conn.disconnect()
  }
  connectionPool.clear()
}

/** Status of a single daemon connection. */
export interface DaemonStatus {
  host: string
  connected: boolean
}

/**
 * Get status of all daemon connections.
 * Used by the health notification panel to show remote host connectivity.
 */
/**
 * Check if a daemon connection for the given host is alive.
 * Used by the unified session liveness check.
 */
export function isDaemonConnected(hostKey: string): boolean {
  return connectionPool.get(hostKey)?.connected ?? false
}

export function getDaemonDisconnectedSince(hostKey: string): number | null {
  return connectionPool.get(hostKey)?.disconnectedSince ?? null
}

export function getDaemonPoolStatus(): DaemonStatus[] {
  const result: DaemonStatus[] = []
  for (const [host, conn] of connectionPool) {
    result.push({ host, connected: conn.connected })
  }
  return result
}

/**
 * Probe a remote daemon to check if a session's process is still alive.
 * Returns { alive: true/false } if daemon is reachable, null if not connected.
 * Used by session-health-monitor to auto-recover connection-lost sessions.
 */
export async function probeDaemonSession(
  hostKey: string,
  sessionId: string,
): Promise<{ alive: boolean } | null> {
  const conn = connectionPool.get(hostKey)
  if (!conn?.connected) return null
  try {
    const result = await conn.send('status', { sid: sessionId })
    // result.ok = daemon recognized the session; result.alive = OS process is still running. Both required.
    return { alive: !!(result.ok && result.alive) }
  } catch (err) {
    log.session.debug('probeDaemonSession: status probe failed', {
      hostKey, sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
