/**
 * AcpSession — Walnut session backed by an ACP worker (engine='codex').
 *
 * Parallel to ClaudeCodeSession but a fraction of its surface: the daemon's
 * acp* command family owns process lifecycle (acp-daemon.ts), the worker owns
 * the ACP connection, and this class only:
 *   - issues acpStart / acpSend / acpCancel / acpRespond / acpStop RPCs
 *   - consumes 'jsonl' push frames for its runtimeId (journal records),
 *     normalizes them via the PURE acp-stream-normalizer, and re-emits them
 *     as the existing Walnut session bus events
 *   - implements lazy resume: no live worker → acpStart(providerSessionId)
 *     → retry prompt (fallback newSession with a visible warning)
 *
 * Identity: `runtimeId` (immutable, keys journal + daemon worker) vs
 * `providerSessionId` (ACP session id, learned from session/new, persisted in
 * the legacy `claudeSessionId` record field). Never renamed, never conflated.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import fsModule from 'node:fs'
import { fileURLToPath } from 'node:url'
import { log } from '../logging/index.js'
import { bus, EventNames } from '../core/event-bus.js'
import type { SessionMode } from '../core/types.js'
import { localDaemon } from './local-daemon.js'
import { getDirectDaemonConnection, DaemonConnection, type DaemonEvent } from './daemon-connection.js'
import { AcpJournalProjector } from './acp-journal-projector.js'
import { AcpStreamNormalizer } from './acp-stream-normalizer.js'
import type {
  AcpCapabilitySnapshot,
  AcpConfigOption,
  AcpMcpServer,
  AcpModelCatalog,
  JournalRecord,
  WorkerStateSnapshot,
} from './acp-worker/protocol.js'
import {
  resolveWalnutMcpServers,
  snapshotAcpConfigOptions,
  snapshotAcpModels,
} from './acp-worker/protocol.js'
import {
  acceptAcpPrompt,
  createSessionRecord,
  deleteSessionRecords,
  emitSessionStatusChanged,
  getSessionByClaudeId,
  rollbackAcpSessionIdMigration,
  stageAcpSessionIdMigration,
  updateSessionRecord,
} from '../core/session-tracker.js'
import {
  migrateSessionQueue,
  rollbackSessionQueueMigration,
} from '../core/session-message-queue.js'

/** Locate the worker bundle + adapter entry within this walnut install (MVP: local host). */
export function resolveAcpArtifacts(): { workerCmd: string[]; adapterCmd: string[] } {
  // This module's depth differs by build: src/providers/ in source (tests),
  // dist/ when bundled into cli.js. A fixed '../..' overshoots for the bundle,
  // so walk up to the first ancestor that actually contains the worker bundle
  // (built by scripts/build-daemon.sh into dist/daemon-binaries).
  let root = path.dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 5; up++) {
    if (fsModule.existsSync(path.join(root, 'dist/daemon-binaries/acp-worker.js'))) break
    root = path.dirname(root)
  }
  const workerJs = path.join(root, 'dist/daemon-binaries/acp-worker.js')
  const adapterJs = path.join(root, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')
  return {
    workerCmd: [process.execPath, workerJs],
    adapterCmd: [process.execPath, adapterJs],
  }
}

export type SystemCodexPathErrorReason =
  | 'override_missing'
  | 'override_not_file'
  | 'override_not_executable'
  | 'override_forbidden'
  | 'not_found'

/** Fail-closed startup error for Codex executable selection. */
export class SystemCodexPathError extends Error {
  readonly code = 'SYSTEM_CODEX_UNAVAILABLE'
  readonly kind = 'provider_missing'

  constructor(
    readonly reason: SystemCodexPathErrorReason,
    message: string,
    readonly candidate?: string,
  ) {
    super(message)
    this.name = 'SystemCodexPathError'
  }
}

export interface ResolveSystemCodexPathOptions {
  /** Dependency injection for deterministic tests; production uses process.env. */
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Extra fixed probes after PATH and home directories. */
  systemDirectories?: readonly string[]
}

interface CodexCandidateResult {
  executable?: string
  failure?: Exclude<SystemCodexPathErrorReason, 'not_found'>
  canonicalPath?: string
}

const DEFAULT_CODEX_SYSTEM_DIRS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * Resolve the SYSTEM `codex` executable for the adapter's CODEX_PATH.
 *
 * codex-acp deliberately falls back to its @openai/codex dependency when
 * CODEX_PATH is absent. Walnut must never take that path: npm prepends
 * node_modules/.bin to PATH, and the bundled executable can use a different
 * auth chain from the user's system installation.
 */
export function resolveSystemCodexPath(options: ResolveSystemCodexPathOptions = {}): string {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const override = env.WALNUT_CODEX_PATH

  if (override !== undefined) {
    const result = inspectCodexCandidate(override, cwd)
    if (result.executable) return result.executable
    throw invalidOverrideError(override, result, cwd)
  }

  const directories: string[] = []
  directories.push(...(env.PATH ?? '').split(path.delimiter).filter(Boolean))
  const home = env.HOME || env.USERPROFILE
  if (home) {
    directories.push(path.join(home, '.toolbox/bin'))
    directories.push(path.join(home, '.local/bin'))
  }
  directories.push(...(options.systemDirectories ?? DEFAULT_CODEX_SYSTEM_DIRS))

  const executableNames = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
    : ['codex']
  const seen = new Set<string>()
  for (const directory of directories) {
    for (const executableName of executableNames) {
      const candidate = path.resolve(cwd, directory, executableName)
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const result = inspectCodexCandidate(candidate, cwd)
      if (result.executable) return result.executable
    }
  }

  throw new SystemCodexPathError(
    'not_found',
    'No system Codex executable was found. Install Codex and make it executable on PATH, '
      + 'or set WALNUT_CODEX_PATH to an executable outside node_modules. '
      + 'Walnut will not use the bundled node_modules Codex.',
  )
}

function inspectCodexCandidate(candidate: string, cwd: string): CodexCandidateResult {
  const executable = path.resolve(cwd, candidate)
  if (isNodeModulesPath(executable)) {
    return { failure: 'override_forbidden' }
  }

  let canonicalPath: string
  try {
    canonicalPath = fsModule.realpathSync(executable)
  } catch {
    return { failure: 'override_missing' }
  }
  if (isNodeModulesPath(canonicalPath)) {
    return { failure: 'override_forbidden', canonicalPath }
  }

  try {
    if (!fsModule.statSync(canonicalPath).isFile()) {
      return { failure: 'override_not_file', canonicalPath }
    }
    fsModule.accessSync(executable, fsModule.constants.X_OK)
  } catch {
    return { failure: 'override_not_executable', canonicalPath }
  }

  // Keep the requested symlink path: dispatch wrappers may depend on argv[0].
  return { executable, canonicalPath }
}

function isNodeModulesPath(candidate: string): boolean {
  return path.resolve(candidate).split(path.sep)
    .some((segment) => segment.toLowerCase() === 'node_modules')
}

function invalidOverrideError(
  override: string,
  result: CodexCandidateResult,
  cwd: string,
): SystemCodexPathError {
  const absolute = path.resolve(cwd, override)
  switch (result.failure) {
    case 'override_forbidden': {
      const canonical = result.canonicalPath && result.canonicalPath !== absolute
        ? `; it resolves inside node_modules (${result.canonicalPath})`
        : ''
      return new SystemCodexPathError(
        'override_forbidden',
        `WALNUT_CODEX_PATH must point outside node_modules: ${absolute}${canonical}. `
          + 'Choose a system Codex executable or unset the override to use discovery.',
        absolute,
      )
    }
    case 'override_not_file':
      return new SystemCodexPathError(
        'override_not_file',
        `WALNUT_CODEX_PATH is not a file: ${absolute}. Set it to the Codex executable.`,
        absolute,
      )
    case 'override_not_executable':
      return new SystemCodexPathError(
        'override_not_executable',
        `WALNUT_CODEX_PATH is not executable: ${absolute}. Fix its permissions or choose another system Codex executable.`,
        absolute,
      )
    default:
      return new SystemCodexPathError(
        'override_missing',
        `WALNUT_CODEX_PATH does not exist: ${absolute}. Fix it or unset the override to use system discovery.`,
        absolute,
      )
  }
}

/**
 * Bus destinations per normalized event — mirrors the native emitter exactly
 * (claude-code-session.ts): streaming/display events → 'main-ai' only (its
 * server.ts subscriber is the single buffer+broadcast path to the browser);
 * result/error additionally → 'session-runner' (status persistence + queue
 * drain via processNext); permission events → 'main-ai' (urgent).
 * The old blanket ['*'] double-delivered every delta (web-ui subscriber
 * re-broadcast what main-ai already sent) — text rendered twice per chunk.
 */
const ACP_EVENT_DESTINATIONS: Record<string, string[]> = {
  'session:text-delta': ['main-ai'],
  'session:thinking-delta': ['main-ai'],
  'session:tool-use': ['main-ai'],
  'session:tool-result': ['main-ai'],
  'session:system-event': ['main-ai'],
  'session:usage-update': ['main-ai'],
  'session:result': ['main-ai', 'session-runner'],
  'session:error': ['main-ai', 'session-runner'],
  'session:permission-request': ['main-ai'],
  'session:permission-resolved': ['main-ai'],
}

export function acpEventDestinations(eventName: string): string[] {
  return [...(ACP_EVENT_DESTINATIONS[eventName] ?? ['main-ai'])]
}

export function emitAcpIdentityBoundary(
  taskId: string,
  previousSessionId: string,
  newSessionId: string,
): void {
  bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
    sessionId: previousSessionId,
    taskId,
    variant: 'error',
    message: 'Could not resume the previous Codex thread. A fresh provider thread was started; earlier history remains visible in this transcript.',
    previousSessionId,
    newSessionId,
  } as never, ['main-ai'])
}

export interface AcpSessionConfig {
  taskId: string
  project: string
  cwd: string
  mode: SessionMode
  /** Lane binding (Personal AI chat conversation) — persisted on the record at
   * establish so getSessionByLane finds the codex session (capacity/list
   * exemptions ride the same field). */
  lane?: string
  /** Existing provider session to resume (lazy resume path). */
  providerSessionId?: string
  /** Existing runtimeId (resume) — fresh one generated when absent. */
  runtimeId?: string
  /** Last terminal journal offset persisted on the session record. */
  consumedOffset?: number
  acpJournalPath?: string
  acpConfig?: Record<string, string>
  /** Test override: direct daemon ws URL (MockDaemon / ephemeral daemon). */
  directWsUrl?: string
  /** Test override: worker/adapter command vectors. */
  artifacts?: { workerCmd: string[]; adapterCmd: string[] }
  /** Called when the daemon reports the worker dead. The worker does NOT write
   * a terminal journal fact at death (tail repair happens on the NEXT acpStart),
   * so no session:result fires and queued messages would wait for an unrelated
   * poke — the runner uses this to schedule a queue drain (lazy resume). */
  onWorkerDead?: (session: AcpSession) => void
}

/**
 * `acpStart` is the cold-resume path: the daemon spawns a worker, then runs
 * `initialize` + `session/load` (or `session/new`) against a real provider.
 * The worker budgets each of those provider ops at 120s (acp-daemon.ts
 * OP_TIMEOUT_MS), so the daemon can legitimately hold this RPC open well past
 * the default 30s command timeout — a cold Codex app-server startup replaying a
 * long thread is inherently slow, exactly like a native cold `--resume`. Give
 * the RPC a budget that clears the worker's own initialize + load ceiling with
 * headroom, so a slow-but-healthy resume is NOT killed and reported as a
 * spurious `acpStart (30000ms)` timeout (which cascaded into re-attach /
 * processNext / restore-permission failures). Every other acp* RPC (send,
 * cancel, respond) is bounded on the worker side and ACKs immediately, so they
 * keep the default timeout.
 */
const ACP_COLD_RESUME_TIMEOUT_MS = 5 * 60_000

interface PendingSelfReport {
  commandId: string
  chunks: string[]
  promise: Promise<string>
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPermission {
  requestId: string
  toolName: string
  input?: Record<string, unknown>
  options: Array<{ optionId?: string; kind?: string }>
}

export class AcpSession {
  readonly runtimeId: string
  readonly taskId: string
  readonly project: string
  private cfg: AcpSessionConfig
  private conn: DaemonConnection | null = null
  private offEvent: (() => void) | null = null
  private _providerSessionId: string | null
  private _mode: SessionMode
  private _active = false
  private _turnActive = false
  /** Latest line consumed by this in-memory instance (survives reconnects). */
  private _seenV: number
  /** Last terminal offset durably committed to SessionRecord. */
  private _committedV: number
  private _cursorSeeded = false
  private _cursorCommit: Promise<void> = Promise.resolve()
  private _establishing: Promise<string> | null = null
  private _turnHadError = false
  /** Commands with an observed terminal fact. Recovery may append a missing
   * prompt-accepted fact after daemon repair already closed the turn. */
  private _terminalCommands = new Set<string>()
  private _lastActivityTs = Date.now()
  private _journalPath: string | undefined
  private _capabilities: AcpCapabilitySnapshot | undefined
  private _models: AcpModelCatalog = { availableModels: [] }
  private _configOptions: AcpConfigOption[] = []
  /** requestId → pending permission. A Map, not a single slot: codex can hold
   * several outstanding requests at once (observed perm-2 + perm-3 in the
   * 2026-08-10 incident; the single slot could only track one and the other
   * died unanswerable). */
  private readonly _pendingPermissions = new Map<string, PendingPermission>()
  private readonly _emittedPermissionRequestIds = new Set<string>()
  private _selfReport: PendingSelfReport | null = null
  private readonly normalizer: AcpStreamNormalizer

  constructor(cfg: AcpSessionConfig) {
    this.cfg = cfg
    this.taskId = cfg.taskId
    this.project = cfg.project
    this.runtimeId = cfg.runtimeId ?? `acp-${crypto.randomBytes(8).toString('hex')}`
    this._providerSessionId = cfg.providerSessionId ?? null
    this._mode = cfg.mode
    const initialOffset = validOffset(cfg.consumedOffset) ? cfg.consumedOffset : 0
    this._seenV = initialOffset
    this._committedV = initialOffset
    this._cursorSeeded = cfg.consumedOffset !== undefined
    this._journalPath = cfg.acpJournalPath
    this.normalizer = new AcpStreamNormalizer(new AcpJournalProjector(this.runtimeId))
  }

  // ── Contract getters (subset of ClaudeCodeSession's surface) ──
  get sessionId(): string | null { return this._providerSessionId }
  get active(): boolean { return this._active }
  get mode(): SessionMode { return this._mode }
  get cwd(): string { return this.cfg.cwd }
  get host(): string { return '__local__' }
  get activity(): 'processing' | 'idle' { return this._turnActive ? 'processing' : 'idle' }
  get hasPendingPermission(): boolean { return this._pendingPermissions.size > 0 }
  /** True while we hold a live daemon connection and an established worker —
   * i.e. `activity === 'processing'` is trustworthy, not a stale flag. */
  get workerLive(): boolean { return this._active && (this.conn?.connected ?? false) }
  get modelCatalog(): AcpModelCatalog {
    return {
      ...this._models,
      availableModels: this._models.availableModels.map((model) => ({ ...model })),
    }
  }
  get sessionControls(): AcpConfigOption[] {
    return this._configOptions.map((control) => ({
      ...control,
      options: control.options.map((option) => ({ ...option })),
    }))
  }

  /** Get pending permission requests in the provider-neutral API/UI shape. */
  getPendingPermissionRequests(): Array<{
    requestId: string
    toolName?: string
    input?: Record<string, unknown>
    reason?: string
    acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>
  }> {
    return [...this._pendingPermissions.values()].map(({ requestId, toolName, input, options }) => ({
      requestId, toolName, input, acpOptions: options,
    }))
  }

  // ── Connection ──

  private async ensureConn(): Promise<DaemonConnection> {
    if (this.conn?.connected) return this.conn
    const wsUrl = this.cfg.directWsUrl || localDaemon.wsUrl
    if (!wsUrl) {
      await localDaemon.ensureRunning()
    }
    const finalUrl = this.cfg.directWsUrl || localDaemon.wsUrl
    if (!finalUrl) throw new Error('AcpSession: local daemon not running')
    const conn = await getDirectDaemonConnection('__local__', finalUrl)
    // Daemon restart replaces the pooled connection — re-register the event
    // handler on the NEW instance or journal frames never reach us again.
    if (conn !== this.conn) {
      this.offEvent?.()
      this.offEvent = conn.onEvent((ev) => this.handleDaemonEvent(ev))
      this.conn = conn
    }
    return this.conn!
  }

  /** Re-subscribe the current daemon WebSocket after an in-place reconnect. */
  async reattachWatcher(): Promise<boolean> {
    try {
      const conn = await this.ensureConn()
      // The pooled DaemonConnection survives ordinary WS flaps. Rebind even
      // when its identity is unchanged so this listener follows the new socket.
      this.offEvent?.()
      this.offEvent = conn.onEvent((ev) => this.handleDaemonEvent(ev))
      this.conn = conn

      const result = await conn.send('acpSubscribe', {
        sid: this.runtimeId,
        fromOffset: this._seenV,
      })
      if (result.ok) {
        log.session.info('acp: re-subscribed journal after reconnect', {
          sessionId: this.trackingId(),
          runtimeId: this.runtimeId,
          fromOffset: this._seenV,
        })
        return true
      }
      log.session.warn('acp: journal re-subscribe failed', {
        sessionId: this.trackingId(),
        runtimeId: this.runtimeId,
        fromOffset: this._seenV,
        error: result.error,
      })
      return false
    } catch (error) {
      log.session.warn('acp: journal re-subscribe threw', {
        sessionId: this.trackingId(),
        runtimeId: this.runtimeId,
        fromOffset: this._seenV,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  private handleDaemonEvent(ev: DaemonEvent): void {
    if (ev.sid !== this.runtimeId) return
    if (ev.ev === 'jsonl' && typeof ev.line === 'string') {
      const v = typeof ev.v === 'number' ? ev.v : 0
      if (v <= this._seenV) return
      this._seenV = v
      this.consumeJournalLine(ev.line, v)
      return
    }
    if (ev.ev === 'acp_state' && ev.state === 'dead') {
      this._active = false
      this._turnActive = false
      this.cfg.onWorkerDead?.(this)
    }
  }

  /** Normalize one journal record → re-emit as Walnut bus events. */
  private consumeJournalLine(line: string, v: number): void {
    let record: JournalRecord
    try { record = JSON.parse(line) as JournalRecord } catch { return }
    this._lastActivityTs = Date.now()
    this.consumeSelfReportRecord(record)

    // Track turn/pending state from meta facts (worker-observed, authoritative).
    if (record.kind === 'meta') {
      const t = record.event.type
      if (t === 'prompt-accepted') {
        const terminalAlreadyObserved = this._terminalCommands.has(record.event.commandId)
        if (!terminalAlreadyObserved) this._turnActive = true
        void this.commitPromptAcceptance(
          record.event.commandId,
          terminalAlreadyObserved,
        ).catch(() => {})
      }
      if (t === 'turn-started'
        && !this._terminalCommands.has(record.event.commandId)) {
        this._turnActive = true
      }
      if (t === 'turn-ended' || t === 'turn-interrupted') {
        if (record.event.commandId) {
          this._terminalCommands.add(record.event.commandId)
        }
        this._turnActive = false
      }
      if (t === 'error') this._turnHadError = true
      if (t === 'permission-answered' || t === 'permission-auto-cancelled') {
        this._pendingPermissions.delete(record.event.providerRequestId)
      }
    }

    for (const { name, payload } of this.normalizer.normalize(record)) {
      const full: Record<string, unknown> = { ...payload, sessionId: this.trackingId(), taskId: this.taskId }
      if (name === 'session:permission-request') {
        const requestId = full.requestId as string
        this._pendingPermissions.set(requestId, {
          requestId,
          toolName: full.toolName as string,
          input: full.input as Record<string, unknown> | undefined,
          options: (full.acpOptions as Array<{ optionId?: string; kind?: string }>) ?? [],
        })
        this._emittedPermissionRequestIds.add(requestId)
      }
      // Bus event names line up with EventNames values — emit directly.
      // Destinations MUST mirror the native emit contract: streaming events go
      // to 'main-ai' ONLY (the sole browser broadcast path). '*' would ALSO hit
      // the 'web-ui' subscriber's broadcastEvent → every delta reaches the
      // browser twice → each chunk renders doubled ("II'm'm Cod Codexex").
      const destinations = acpEventDestinations(name)
      bus.emit(name as Parameters<typeof bus.emit>[0], full as never, destinations,
        name === 'session:permission-request' ? { urgency: 'urgent' } : undefined)
    }

    if (record.kind === 'meta'
      && (record.event.type === 'turn-ended' || record.event.type === 'turn-interrupted')) {
      this.commitTerminal(v, record)
    }
  }

  /** Records/API key: providerSessionId once known, else runtimeId (pending phase). */
  private trackingId(): string { return this._providerSessionId ?? this.runtimeId }

  // ── Lifecycle ops ──

  /**
   * Start or attach the worker and establish the provider thread without
   * sending a user prompt. Safe to call repeatedly and concurrently.
   */
  async establish(): Promise<string> {
    if (this._active && this._providerSessionId) return this._providerSessionId
    if (this._establishing) return this._establishing
    const establishing = this.establishProviderSession()
    this._establishing = establishing
    try {
      return await establishing
    } finally {
      if (this._establishing === establishing) this._establishing = null
    }
  }

  /**
   * MCP servers to mount on the provider session. Currently only the walnut
   * task tools (`open-walnut mcp`), gated on config `session.acp_walnut_mcp`.
   *
   * OPT-IN and default-off on purpose: the provider spawns the mount on the
   * EXECUTION host, where `open-walnut` may not be on PATH (remote dev boxes,
   * or a walnut installed outside the provider's PATH). A default-on mount
   * would make every such session report a dead MCP server. Config read is
   * best-effort — an unreadable config means no mounts, never a failed start.
   *
   * DELIBERATE: the flag is read at every provider-session establish, so flipping
   * it mid-conversation changes the mount set on the NEXT cold resume (ACP treats
   * `mcpServers` as the complete set). Tool calls referencing an unmounted tool
   * just error individually — acceptable for an opt-in flag; pinning the mount
   * set per-session would need record-level persistence like SessionProfile.
   */
  private async resolveMcpServers(): Promise<AcpMcpServer[]> {
    try {
      const { getConfig } = await import('../core/config-manager.js')
      const config = await getConfig()
      // Read structurally: the field is optional and additive in Config.
      return resolveWalnutMcpServers(
        config.session as { acp_walnut_mcp?: boolean } | undefined,
      )
    } catch (error) {
      log.session.debug('acp: MCP mount config unreadable — mounting none', {
        runtimeId: this.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  private async establishProviderSession(): Promise<string> {
    await this.seedReplayCursor()
    const { workerCmd, adapterCmd } = this.cfg.artifacts ?? resolveAcpArtifacts()

    // Production always passes a validated system Codex path. Omitting
    // CODEX_PATH would make codex-acp silently use its bundled dependency.
    // Tests that inject a mock adapter do not need a Codex executable.
    const systemCodex = this.cfg.artifacts ? undefined : resolveSystemCodexPath()
    // Concurrent with ensureConn: the mount list is a small config read and must
    // not add serial latency to the cold-resume path, which is already the
    // slowest thing walnut does (worker spawn + provider initialize + load).
    const [mcpServers, conn] = await Promise.all([
      this.resolveMcpServers(),
      this.ensureConn(),
    ])
    const startResp = await conn.send('acpStart', {
      sid: this.runtimeId,
      cwd: this.cfg.cwd,
      workerCmd,
      adapterCmd,
      env: systemCodex ? { CODEX_PATH: systemCodex } : undefined,
      providerSessionId: this._providerSessionId ?? undefined,
      fromOffset: this._seenV,
      mcpServers,
    }, ACP_COLD_RESUME_TIMEOUT_MS)
    try {
      if (!startResp.ok) {
        if ((startResp as { errorKind?: string }).errorKind === 'load_failed') {
          // Provider thread unrecoverable — fall back to a fresh session with a
          // visible warning (plan: never silently lose history claims).
          const previousSessionId = this.trackingId()
          log.session.warn('acp: session/load failed, falling back to new session', {
            sessionId: previousSessionId, runtimeId: this.runtimeId,
          })
          const fresh = await conn.send('acpNewSession', {
            sid: this.runtimeId,
            cwd: this.cfg.cwd,
            mcpServers,
          }, ACP_COLD_RESUME_TIMEOUT_MS)
          if (!fresh.ok) throw new Error('acp newSession fallback failed: ' + fresh.error)
          await this.publishSessionResponse((fresh as { result?: unknown }).result)
          const newSessionId = this.trackingId()
          emitAcpIdentityBoundary(this.taskId, previousSessionId, newSessionId)
        } else {
          throw new Error('acpStart failed: ' + startResp.error)
        }
      } else {
        const result = startResp as {
          session?: unknown
          alive?: boolean
          state?: unknown
          journalPath?: string
        }
        if (result.journalPath) this._journalPath = result.journalPath
        const state = result.state as WorkerStateSnapshot | undefined
        if (state?.capabilities) this._capabilities = state.capabilities
        if (result.session) await this.publishSessionResponse(result.session)
        if (state) await this.adoptStateSnapshot(state)
      }
    } catch (error) {
      await this.discardUnpublishedWorker()
      throw error
    }
    if (!this._providerSessionId) {
      throw new Error('ACP session established without a provider session ID')
    }
    await this.replayPersistedConfig(conn)
    this._active = true
    return this._providerSessionId
  }

  /**
   * Re-apply user-chosen config (mode / collaboration_mode / model …) after a
   * worker (re)spawn. Codex config lives in the app-server process, NOT the
   * durable thread — a replacement worker silently reverts to defaults, which
   * is how "Agent (full access)" turned back into approval prompts after a
   * crash. Sends raw acpSetConfigOption (calling setConfigOption() here would
   * deadlock on _establishing). Only differing keys are sent; normal warm
   * attaches send nothing.
   */
  private async replayPersistedConfig(conn: DaemonConnection): Promise<void> {
    const record = await getSessionByClaudeId(this.trackingId()).catch(() => undefined)
    const wanted = record?.acpConfig ?? this.cfg.acpConfig
    if (!wanted || this._configOptions.length === 0) return
    for (const [configId, value] of Object.entries(wanted)) {
      const control = this._configOptions.find((c) => c.id === configId)
      if (!control || control.currentValue === value) continue
      if (!control.options.some((o) => o.value === value)) continue
      const resp = await conn.send('acpSetConfigOption', {
        sid: this.runtimeId,
        commandId: `acp-config-replay-${crypto.randomBytes(8).toString('hex')}`,
        configId,
        value,
      }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      if (resp.ok) {
        this._configOptions = this._configOptions.map((c) =>
          c.id === configId ? { ...c, currentValue: value } : c)
        if (configId === 'model') this._models = { ...this._models, currentModelId: value }
        log.session.info('acp: replayed persisted config after worker spawn', {
          runtimeId: this.runtimeId, configId, value,
        })
      } else {
        log.session.warn('acp: config replay failed', {
          runtimeId: this.runtimeId, configId, value,
          error: (resp as { error?: string }).error,
        })
      }
    }
  }

  /**
   * Start (or lazily resume) the worker and send a prompt.
   * The daemon replays journal history from `fromOffset` on start; we pass our
   * consumed watermark so reconnects are gap-free without duplication.
   */
  async send(message: string, walnutMessageId?: string): Promise<void> {
    return this.sendAccepted(message, walnutMessageId)
  }

  async sendAccepted(
    message: string,
    walnutMessageId = `qm-acp-${crypto.randomBytes(8).toString('hex')}`,
  ): Promise<void> {
    // A user prompt always wins over a hidden report. Hard-abort the control
    // turn, lazily reload the same provider thread, then accept this queue item.
    await this.cancelSelfReport('self-report superseded by user prompt')
    await this.establish()
    const conn = await this.ensureConn()

    const commandId = `acp-prompt:${walnutMessageId}`
    const sendResp = await conn.send('acpSend', {
      sid: this.runtimeId,
      commandId,
      walnutMessageId,
      text: message,
    })
    if (!sendResp.ok) {
      const kind = (sendResp as { errorKind?: string }).errorKind
      if (kind === 'no_worker') {
        // Worker died between start and send (or idle-reaped): one lazy-resume retry.
        this._active = false
        log.session.info('acp: worker gone on send — lazy resume retry', { runtimeId: this.runtimeId })
        return this.sendAccepted(message, walnutMessageId)
      }
      throw new Error('acpSend failed: ' + sendResp.error)
    }
    // Journal delivery can beat this RPC response, including a complete fast
    // turn. Acceptance and terminal persistence share one ordered commit chain;
    // never reopen local state after a terminal fact has already arrived.
    await this.commitPromptAcceptance(
      commandId,
      this._terminalCommands.has(commandId),
    )
  }

  private async publishSessionResponse(sessionResp: unknown): Promise<void> {
    try {
      await this.adoptSessionResponse(sessionResp)
    } catch (error) {
      await this.discardUnpublishedWorker()
      throw error
    }
  }

  private async adoptSessionResponse(sessionResp: unknown): Promise<void> {
    const resp = sessionResp as { sessionId?: string } | undefined
    const models = snapshotAcpModels(sessionResp)
    if (models.availableModels.length > 0 || models.currentModelId) {
      this._models = models
    }
    const configOptions = snapshotAcpConfigOptions(sessionResp)
    if (configOptions.length > 0) this._configOptions = configOptions
    if (resp?.sessionId && resp.sessionId !== this._providerSessionId) {
      const previousSessionId = this._providerSessionId
      if (!previousSessionId) {
        // Record convention: LOCAL sessions persist host as undefined (never the
        // '__local__' sentinel) — the health monitor treats any truthy host as
        // remote and would probe the daemon CLI registry (which has no ACP
        // workers), mis-marking the session 'remote_unreachable'.
        await createSessionRecord(resp.sessionId, this.taskId, this.project, this.cfg.cwd, {
          mode: this._mode,
          initialProcessStatus: 'idle',
          messageCount: 0,
          engine: 'codex',
          ...(this.cfg.lane ? { lane: this.cfg.lane } : {}),
          acpRuntimeId: this.runtimeId,
          acpJournalPath: this._journalPath,
          acpCapabilities: this._capabilities,
        })
      } else {
        const replacementId = resp.sessionId
        let existingReplacement = await getSessionByClaudeId(replacementId)
        if (existingReplacement && !this.isSameDurableIdentity(existingReplacement)) {
          throw new Error(
            `ACP provider session ID ${replacementId} already belongs to another session`,
          )
        }

        let staged = false
        if (!existingReplacement) {
          staged = Boolean(await stageAcpSessionIdMigration(previousSessionId, replacementId, {
            acpRuntimeId: this.runtimeId,
            acpJournalPath: this._journalPath,
            acpCapabilities: this._capabilities,
          }))
          if (!staged) {
            // A concurrent migration may have won after the preflight read.
            existingReplacement = await getSessionByClaudeId(replacementId)
            if (!existingReplacement || !this.isSameDurableIdentity(existingReplacement)) {
              throw new Error(
                `ACP provider session changed from ${previousSessionId} to ${replacementId}, but its durable record could not be migrated`,
              )
            }
          }
        }

        const { replaceSessionIdLinks } = await import('../core/task-manager.js')
        let queueMigration: Awaited<ReturnType<typeof migrateSessionQueue>> | null = null
        try {
          if (this.taskId) {
            await replaceSessionIdLinks(this.taskId, previousSessionId, replacementId)
          }
          queueMigration = await migrateSessionQueue(previousSessionId, replacementId)
          // The old row remains as an archived redirect until task links point
          // at the replacement AND every queue row is durably reachable through
          // the new identity. Reattach can finish this protocol after a crash.
          const previousRecord = await getSessionByClaudeId(previousSessionId)
          if (previousRecord) {
            if (!this.isSameDurableIdentity(previousRecord)) {
              throw new Error(
                `ACP prior session ID ${previousSessionId} no longer belongs to this runtime`,
              )
            }
            const removed = await deleteSessionRecords(new Set([previousSessionId]), 'acp-identity-replaced')
            if (removed !== 1 && await getSessionByClaudeId(previousSessionId)) {
              throw new Error(`ACP prior session record ${previousSessionId} could not be retired`)
            }
          }
        } catch (error) {
          const rollbackErrors: string[] = []
          if (queueMigration?.movedIds.length) {
            try {
              await rollbackSessionQueueMigration(
                previousSessionId,
                replacementId,
                queueMigration.movedIds,
              )
            } catch (rollbackError) {
              rollbackErrors.push(`message queue: ${errorText(rollbackError)}`)
            }
          }
          // If queue compensation failed, keep the staged redirect/replacement
          // records and task links. Startup can still resolve either queue key;
          // rolling the database back now would orphan the queue under newId.
          if (rollbackErrors.length > 0) {
            throw new Error(
              `${errorText(error)}; ACP identity rollback also failed (${rollbackErrors.join('; ')})`,
            )
          }
          if (this.taskId) {
            try {
              await replaceSessionIdLinks(this.taskId, replacementId, previousSessionId)
            } catch (rollbackError) {
              rollbackErrors.push(`task links: ${errorText(rollbackError)}`)
            }
          }
          // Keep the staged redirect if task rollback failed. It is the only
          // durable resolver for links that may still point at replacementId.
          if (staged && rollbackErrors.length === 0) {
            try {
              const restored = await rollbackAcpSessionIdMigration(
                previousSessionId,
                replacementId,
              )
              if (!restored) rollbackErrors.push('session record: rollback returned false')
            } catch (rollbackError) {
              rollbackErrors.push(`session record: ${errorText(rollbackError)}`)
            }
          }
          if (rollbackErrors.length > 0) {
            throw new Error(
              `${errorText(error)}; ACP identity rollback also failed (${rollbackErrors.join('; ')})`,
            )
          }
          throw error
        }
        const migratedRecord = await getSessionByClaudeId(replacementId)
        if (!migratedRecord) {
          throw new Error(`ACP replacement record ${replacementId} disappeared after migration`)
        }
        emitSessionStatusChanged(
          migratedRecord,
          { previousSessionId },
          ['*'],
          { source: 'session-runner', urgency: 'urgent' },
        )
      }
      this._providerSessionId = resp.sessionId
    }
    if (this._providerSessionId && this._models.currentModelId) {
      await updateSessionRecord(this._providerSessionId, {
        acpModel: this._models.currentModelId,
      }).catch(() => {})
    }
  }

  private isSameDurableIdentity(record: {
    engine?: string
    taskId?: string
    acpRuntimeId?: string
  }): boolean {
    return record.engine === 'codex'
      && record.acpRuntimeId === this.runtimeId
      && (record.taskId ?? '') === this.taskId
  }

  private async adoptStateSnapshot(state: WorkerStateSnapshot): Promise<void> {
    if (state.providerSessionId) {
      await this.publishSessionResponse({ sessionId: state.providerSessionId })
    }
    this._capabilities = state.capabilities
    this._models = state.models ?? snapshotAcpModels(state.sessionResponse)
    this._configOptions = state.configOptions ?? snapshotAcpConfigOptions(state.sessionResponse)
    this._turnActive = state.turnActive
    // Adopt EVERY worker-reported pending permission, not just the first —
    // codex can hold several outstanding requests (2026-08-10 incident:
    // perm-2 + perm-3 concurrently; the untracked one died unanswerable).
    for (const p of state.pendingPermissions) {
      const toolCall = p.toolCall as {
        title?: unknown
        kind?: unknown
        rawInput?: unknown
      } | undefined
      const toolName = typeof toolCall?.title === 'string'
        ? toolCall.title
        : typeof toolCall?.kind === 'string' ? toolCall.kind : 'tool'
      const input = toolCall?.rawInput
        && typeof toolCall.rawInput === 'object'
        && !Array.isArray(toolCall.rawInput)
        ? toolCall.rawInput as Record<string, unknown>
        : undefined
      const options = (p.options as Array<{ optionId?: string; kind?: string }>) ?? []
      this._pendingPermissions.set(p.providerRequestId, {
        requestId: p.providerRequestId,
        toolName,
        input,
        options,
      })
      if (!this._emittedPermissionRequestIds.has(p.providerRequestId)) {
        this._emittedPermissionRequestIds.add(p.providerRequestId)
        bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
          sessionId: this.trackingId(),
          taskId: this.taskId,
          requestId: p.providerRequestId,
          toolName,
          input,
          acpOptions: options,
        }, ['*'], { urgency: 'urgent' })
      }
    }
    if (this._providerSessionId) {
      await updateSessionRecord(this._providerSessionId, {
        acpJournalPath: this._journalPath,
        acpCapabilities: state.capabilities,
        ...(this._models.currentModelId ? { acpModel: this._models.currentModelId } : {}),
      }).catch(() => {})
    }
  }

  /** Apply any provider-advertised session option through standard ACP config. */
  async setConfigOption(configId: string, value: string): Promise<boolean> {
    if (!configId || !value) return false
    await this.establish()
    const conn = await this.ensureConn()
    const resp = await conn.send('acpSetConfigOption', {
      sid: this.runtimeId,
      commandId: `acp-config-${crypto.randomBytes(8).toString('hex')}`,
      configId,
      value,
    })
    if (!resp.ok) return false
    this._configOptions = this._configOptions.map((control) =>
      control.id === configId ? { ...control, currentValue: value } : control)
    if (configId === 'model') this._models = { ...this._models, currentModelId: value }
    const record = await getSessionByClaudeId(this.trackingId())
    await updateSessionRecord(this.trackingId(), {
      ...(configId === 'model' ? { acpModel: value } : {}),
      acpConfig: { ...(record?.acpConfig ?? this.cfg.acpConfig ?? {}), [configId]: value },
    })
    // Codex applies approvalPolicy per-turn (adapter passes it to runTurn), so
    // switching to full access mid-turn cannot unblock approvals codex already
    // asked for — they'd dangle until the turn dies. Match the user's intent:
    // "full access" means stop asking, so answer anything pending with allow.
    if (configId === 'mode' && value === 'agent-full-access' && this._pendingPermissions.size > 0) {
      const pending = [...this._pendingPermissions.keys()]
      log.session.info('acp: full access selected — auto-allowing pending permissions', {
        sessionId: this.trackingId(), requestIds: pending,
      })
      for (const requestId of pending) {
        await this.resolvePermissionRequest(requestId, true).catch(() => false)
      }
    }
    return true
  }

  /** Switch the model for the next Codex turn through standard ACP config.
   *  Catalog ids are effort-qualified ("base[effort]") but the adapter's
   *  model config option only accepts the BASE id (applyModelChange matches
   *  availableModels by base id and throws invalidParams otherwise) — split
   *  and apply model + reasoning_effort as two config ops. */
  async setModel(modelId: string): Promise<boolean> {
    const match = /^(.*?)\[([^\]]+)\]$/.exec(modelId)
    const base = match ? match[1] : modelId
    const effort = match ? match[2] : undefined
    if (!await this.setConfigOption('model', base)) return false
    if (effort && !await this.setConfigOption('reasoning_effort', effort)) {
      log.session.warn('acp: model applied but reasoning_effort rejected', {
        sessionId: this.trackingId(), modelId, effort,
      })
    }
    // Persist the requested (qualified) id so the pill shows what was chosen.
    this._models = { ...this._models, currentModelId: modelId }
    await updateSessionRecord(this.trackingId(), { acpModel: modelId }).catch(() => {})
    return true
  }

  /**
   * A provider thread exists but its durable Walnut identity did not publish.
   * Tear the worker down so a later getState cannot smuggle the new provider
   * ID past the migration protocol. The next prompt cold-loads the last
   * committed providerSessionId.
   */
  private async discardUnpublishedWorker(): Promise<void> {
    this._active = false
    this._turnActive = false
    this._pendingPermissions.clear()
    if (!this.conn?.connected) return
    await this.conn.send('acpStop', { sid: this.runtimeId }).catch(() => {})
  }

  /** Answer a pending ACP permission request. `allow=false` → cancelled outcome
   *  unless a reject-kind option exists (ACP wants an explicit option id).
   *  `selectedOptionId` (from the UI's option buttons, e.g. codex's
   *  "Allow for Session") wins over the allow-boolean heuristic. */
  async resolvePermissionRequest(requestId: string, allow: boolean, selectedOptionId?: string): Promise<boolean> {
    const conn = await this.ensureConn()
    let optionId: string | null = null
    const options = this._pendingPermissions.get(requestId)?.options ?? []
    if (selectedOptionId && options.some((o) => o.optionId === selectedOptionId)) {
      optionId = selectedOptionId
    } else if (allow) {
      optionId = options.find((o) => o.kind === 'allow_once')?.optionId
        ?? options.find((o) => o.kind?.startsWith('allow'))?.optionId
        ?? null
      if (!optionId) {
        // Unknown requestId (stale card / replaced worker) — refuse loudly.
        // NEVER fall back to options[0]: on codex that could silently select
        // an allow_always kind the user did not choose.
        log.session.warn('acp: permission approve refused — request unknown to this session', {
          sessionId: this.trackingId(), requestId,
          pendingRequestIds: [...this._pendingPermissions.keys()],
        })
        return false
      }
    } else {
      optionId = options.find((o) => o.kind === 'reject_once')?.optionId
        ?? options.find((o) => o.kind?.startsWith('reject'))?.optionId
        ?? null // no reject option → cancelled outcome
    }
    const resp = await conn.send('acpRespond', {
      sid: this.runtimeId,
      commandId: `qp-${crypto.randomBytes(6).toString('hex')}`,
      providerRequestId: requestId,
      optionId,
    })
    // The worker answers `{answered:false, reason:'no_pending_request'}` when it
    // doesn't know the id (already answered, auto-cancelled, or a replacement
    // worker that never saw it). Treating that as success returned HTTP 200 for
    // approvals that never reached codex (2026-08-10 incident) — surface it.
    const answered = (resp as { result?: { answered?: boolean } }).result?.answered !== false
    if (resp.ok && answered) {
      this._pendingPermissions.delete(requestId)
      log.session.info('acp: permission answered', {
        sessionId: this.trackingId(), requestId, optionId, allow,
      })
      return true
    }
    log.session.warn('acp: permission response was a no-op', {
      sessionId: this.trackingId(), requestId, optionId,
      ok: resp.ok, error: (resp as { error?: string }).error,
      reason: (resp as { result?: { reason?: string } }).result?.reason,
    })
    if (resp.ok && !answered) {
      // Worker no longer tracks it — drop our stale copy so the UI stops
      // offering a dead card.
      this._pendingPermissions.delete(requestId)
    }
    return false
  }

  /** Backward-compatible interruption alias for the hard-abort contract. */
  async interrupt(): Promise<void> {
    return this.abortTurn()
  }

  /**
   * Hard-abort the active worker process group. The next prompt lazily loads
   * the durable provider thread in a replacement worker.
   */
  async abortTurn(): Promise<void> {
    if (this._selfReport) {
      await this.cancelSelfReport('self-report aborted')
      return
    }
    if (!this._active) {
      this._turnActive = false
      return
    }
    const conn = await this.ensureConn()
    const resp = await conn.send('acpCancel', {
      sid: this.runtimeId,
      commandId: `qx-${crypto.randomBytes(6).toString('hex')}`,
    })
    if (!resp.ok && (resp as { errorKind?: string }).errorKind !== 'no_worker') {
      throw new Error('acpCancel failed: ' + resp.error)
    }
    this._active = false
    this._turnActive = false
    this._pendingPermissions.clear()
  }

  /**
   * Ask the provider thread for the deterministic turn-complete report without
   * adding it to the visible transcript. Control-tagged frames are collected
   * privately and ignored by the canonical live/history projector.
   */
  async requestTurnCompleteSelfReport(prompt: string, timeoutMs: number): Promise<string> {
    await this.establish()
    if (this._turnActive) throw new Error('cannot request ACP self-report during an active user turn')
    if (this._selfReport) return this._selfReport.promise

    const conn = await this.ensureConn()
    const commandId = `acp-self-report:${crypto.randomBytes(8).toString('hex')}`
    let resolveReport!: (text: string) => void
    let rejectReport!: (error: Error) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveReport = resolve
      rejectReport = reject
    })
    // The daemon event can arrive before the accepted RPC response.
    void promise.catch(() => {})
    const timer = setTimeout(() => {
      void this.cancelSelfReport(`self-report timed out after ${timeoutMs}ms`).catch((error) => {
        log.session.warn('acp: timed-out self-report abort failed', {
          sessionId: this.trackingId(),
          runtimeId: this.runtimeId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, Math.max(1, timeoutMs))
    this._selfReport = {
      commandId,
      chunks: [],
      promise,
      resolve: resolveReport,
      reject: rejectReport,
      timer,
    }

    try {
      const resp = await conn.send('acpSend', {
        sid: this.runtimeId,
        commandId,
        control: 'self-report',
        text: prompt,
      })
      if (!resp.ok) {
        this.settleSelfReport(commandId, new Error('ACP self-report prompt failed: ' + resp.error))
      }
    } catch (error) {
      this.settleSelfReport(
        commandId,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
    return promise
  }

  /** Graceful stop: shut the worker down (journal meta → adapter teardown). */
  async gracefulStop(): Promise<void> {
    if (this._selfReport) {
      await this.cancelSelfReport('session stopped')
      return
    }
    if (!this.conn?.connected) return
    await this.conn.send('acpStop', { sid: this.runtimeId }).catch(() => {})
    this._active = false
    this._turnActive = false
  }

  async kill(): Promise<void> { return this.gracefulStop() }

  /** Detach event handling without touching the worker (server shutdown path). */
  detach(): void {
    if (this._selfReport) {
      this.settleSelfReport(this._selfReport.commandId, new Error('ACP session detached'))
    }
    this.offEvent?.()
    this.offEvent = null
    this._active = false
  }

  private async seedReplayCursor(): Promise<void> {
    if (this._cursorSeeded) return
    this._cursorSeeded = true
    if (!this._providerSessionId) return
    const record = await getSessionByClaudeId(this._providerSessionId).catch(() => null)
    if (!record || !validOffset(record.consumedOffset)) return
    this._committedV = record.consumedOffset
    this._seenV = Math.max(this._seenV, record.consumedOffset)
    if (!this._journalPath) this._journalPath = record.acpJournalPath
    if (!this._capabilities) this._capabilities = record.acpCapabilities
  }

  private commitTerminal(
    v: number,
    record: Extract<JournalRecord, { kind: 'meta' }>,
  ): void {
    const event = record.event
    if (event.type !== 'turn-ended' && event.type !== 'turn-interrupted') return
    const isInterrupted = event.type === 'turn-interrupted'
      || (event.type === 'turn-ended' && event.stopReason === 'cancelled')
    const isError = this._turnHadError
      || (event.type === 'turn-interrupted' && event.reason === 'worker-crash')
    this._turnHadError = false

    this._cursorCommit = this._cursorCommit.then(async () => {
      if (v <= this._committedV) return
      const sessionId = this.trackingId()
      const processStatus = isError ? 'error' : 'idle'
      const updated = await updateSessionRecord(sessionId, {
        consumedOffset: v,
        process_status: processStatus,
        activity: undefined,
        last_status_change: new Date().toISOString(),
        status_reason: isError ? 'api_error' : (isInterrupted ? 'turn_interrupted' : 'turn_completed'),
        status_changed_by: 'session-runner',
      })
      this._committedV = updated.consumedOffset ?? this._committedV
      emitSessionStatusChanged(updated, {}, ['*'], { source: 'session-runner' })
    }).catch((error) => {
      log.session.warn('acp: terminal cursor commit failed', {
        sessionId: this.trackingId(),
        runtimeId: this.runtimeId,
        offset: v,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private commitPromptAcceptance(
    commandId: string,
    preserveTerminalState = false,
  ): Promise<void> {
    const sessionId = this.trackingId()
    const commit = this._cursorCommit.then(async () => {
      // Acceptance can commit after the turn's terminal state on instantaneous
      // turns. A late 'running' write would cancel the stream buffer's deferred
      // clear and wedge isStreaming, so the execution-time check is authoritative.
      const terminalAlreadyObserved = preserveTerminalState
        || this._terminalCommands.has(commandId)
      const acceptance = await acceptAcpPrompt(sessionId, commandId, {
        preserveTerminalState: terminalAlreadyObserved,
      })
      if (!acceptance.accepted) return
      if (terminalAlreadyObserved) return
      emitSessionStatusChanged(
        acceptance.record,
        { phase: 'IN_PROGRESS' },
        ['*'],
        { source: 'session-runner' },
      )
    })
    this._cursorCommit = commit.catch((error) => {
      log.session.warn('acp: prompt acceptance commit failed', {
        sessionId,
        runtimeId: this.runtimeId,
        commandId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return commit
  }

  private consumeSelfReportRecord(record: JournalRecord): void {
    const pending = this._selfReport
    if (!pending) return
    if (record.kind === 'acp' && record.source === 'control') {
      const text = controlFrameText(record.frame)
      if (text) pending.chunks.push(text)
      return
    }
    if (record.kind !== 'meta'
      || record.event.type !== 'control-ended'
      || record.event.commandId !== pending.commandId) return
    if (record.event.error) {
      this.settleSelfReport(pending.commandId, new Error(record.event.error))
    } else if (record.event.stopReason === 'cancelled'
      || record.event.stopReason === 'worker-crash'
      || record.event.stopReason === 'daemon-restart'
      || record.event.stopReason === 'shutdown') {
      this.settleSelfReport(
        pending.commandId,
        new Error(`ACP self-report ended: ${record.event.stopReason}`),
      )
    } else {
      this.settleSelfReport(pending.commandId, undefined, pending.chunks.join(''))
    }
  }

  private settleSelfReport(commandId: string, error?: Error, text = ''): void {
    const pending = this._selfReport
    if (!pending || pending.commandId !== commandId) return
    this._selfReport = null
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(text)
  }

  private async cancelSelfReport(reason: string): Promise<void> {
    const pending = this._selfReport
    if (!pending) return
    this.settleSelfReport(pending.commandId, new Error(reason))
    if (!this._active) return
    const conn = await this.ensureConn()
    const resp = await conn.send('acpCancel', {
      sid: this.runtimeId,
      commandId: `qx-control-${crypto.randomBytes(6).toString('hex')}`,
    })
    this._active = false
    this._turnActive = false
    this._pendingPermissions.clear()
    if (!resp.ok && (resp as { errorKind?: string }).errorKind !== 'no_worker') {
      throw new Error('ACP self-report abort failed: ' + resp.error)
    }
  }
}

function controlFrameText(frame: unknown): string {
  if (!frame || typeof frame !== 'object') return ''
  const root = frame as {
    method?: string
    params?: {
      update?: {
        sessionUpdate?: string
        content?: { type?: string; text?: string }
      }
    }
  }
  const update = root.params?.update
  return root.method === 'session/update'
    && update?.sessionUpdate === 'agent_message_chunk'
    && update.content?.type === 'text'
    && typeof update.content.text === 'string'
    ? update.content.text
    : ''
}

function validOffset(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value < Number.MAX_SAFE_INTEGER
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
