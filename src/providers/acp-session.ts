/**
 * AcpSession — Walnut session backed by an ACP worker (every engine whose
 * registry runtimeKind is 'acp': codex, gemini, opencode, goose, custom).
 *
 * The transport is engine-neutral: the daemon's acp* family and the worker only
 * ever see `workerCmd` / `adapterCmd` / `env`. What differs per engine is how
 * the adapter argv is obtained (registry `acpAdapter`) and the codex-specific
 * adapter env contract, which stays gated on `engineId === 'codex'`.
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
import { renderSelfKnowledgeContract } from '../core/self-knowledge-contract.js'
import type { SessionEngine, SessionMode } from '../core/types.js'
import {
  engineCaps,
  isAcpEngine,
  normalizeEngine,
  resolveEngine,
} from '../core/agents/engine-registry.js'
// ONE selection policy for "which executable may we launch", shared with the
// engine catalog probe. Leaf-ish module (registry + claude-cli-detect + node
// builtins); it never imports providers, so there is no cycle.
import {
  enginePathOverrideVar,
  findEngineBinary,
  inspectExecutable,
} from '../core/agents/engine-probe.js'
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
  updateSessionRecordConditionally,
} from '../core/session-tracker.js'
import {
  migrateSessionQueue,
  rollbackSessionQueueMigration,
} from '../core/session-message-queue.js'

/** node_modules adapter entry per 'bundled' engine (only codex ships one today). */
const BUNDLED_ADAPTER_ENTRIES: Partial<Record<SessionEngine, string>> = {
  codex: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
}

export interface ResolveAcpArtifactsOptions {
  /** argv for a `source: 'config'` engine (walnut config engines.<id>.adapter_cmd). */
  configuredAdapterCmd?: readonly string[]
  /** Executable-probe DI (tests); production reads process.env / process.cwd(). */
  executable?: EngineExecutableProbeOptions
}

/**
 * Locate the worker bundle + this engine's adapter command within this walnut
 * install (MVP: local host). The worker bundle is engine-neutral; the adapter
 * comes from the registry's `acpAdapter` descriptor:
 *   bundled → node + a package under node_modules (codex)
 *   cli     → the provider's own CLI speaks ACP (`gemini --experimental-acp`)
 *   config  → argv the user supplied in walnut config (custom)
 */
export function resolveAcpArtifacts(
  engine: SessionEngine = 'codex',
  options: ResolveAcpArtifactsOptions = {},
): { workerCmd: string[]; adapterCmd: string[] } {
  // This module's depth differs by build: src/providers/ in source (tests),
  // dist/ when bundled into cli.js. A fixed '../..' overshoots for the bundle,
  // so walk up to the first ancestor that actually contains the worker bundle
  // (built by scripts/build-daemon.sh into dist/daemon-binaries).
  let root = path.dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 5; up++) {
    if (fsModule.existsSync(path.join(root, 'dist/daemon-binaries/acp-worker.js'))) break
    root = path.dirname(root)
  }
  const workerCmd = [process.execPath, path.join(root, 'dist/daemon-binaries/acp-worker.js')]
  const caps = engineCaps(engine)
  const adapter = caps.acpAdapter
  if (!adapter) {
    throw new Error(`Engine '${engine}' has no ACP adapter: it does not run on the ACP worker`)
  }
  if (adapter.source === 'bundled') {
    const entry = BUNDLED_ADAPTER_ENTRIES[caps.id]
    if (!entry) throw new Error(`No bundled ACP adapter is packaged for ${caps.displayName}`)
    return { workerCmd, adapterCmd: [process.execPath, path.join(root, entry)] }
  }
  if (adapter.source === 'cli') {
    const executable = resolveEngineExecutable({
      ...options.executable,
      engine: caps.id,
      binaryName: adapter.binary ?? caps.id,
    })
    return { workerCmd, adapterCmd: [executable, ...(adapter.args ?? [])] }
  }
  const configured = (options.configuredAdapterCmd ?? []).filter((arg) => typeof arg === 'string' && arg !== '')
  if (configured.length === 0) {
    throw new Error(
      `${caps.displayName} has no adapter command: set engines.${caps.id}.adapter_cmd in the walnut `
        + 'config to the argv that speaks ACP on stdio (for example ["/usr/local/bin/my-agent", "acp"]).',
    )
  }
  return { workerCmd, adapterCmd: [...configured] }
}

export type EngineExecutableErrorReason =
  | 'override_missing'
  | 'override_not_file'
  | 'override_not_executable'
  | 'override_forbidden'
  | 'not_found'

/** Back-compat alias for the codex-era name (imported by tests + live specs). */
export type SystemCodexPathErrorReason = EngineExecutableErrorReason

/** Fail-closed startup error for an engine's system executable selection. */
export class EngineExecutableError extends Error {
  /** `SYSTEM_CODEX_UNAVAILABLE` for codex, same shape for every other engine. */
  readonly code: string
  readonly kind = 'provider_missing'

  constructor(
    readonly engine: SessionEngine,
    readonly reason: EngineExecutableErrorReason,
    message: string,
    readonly candidate?: string,
  ) {
    super(message)
    this.name = 'EngineExecutableError'
    this.code = `SYSTEM_${engine.toUpperCase()}_UNAVAILABLE`
  }
}

/** Back-compat alias: the codex-era class name existing imports still use. */
export { EngineExecutableError as SystemCodexPathError }

/** Probe inputs shared by every engine (dependency injection for tests). */
export interface EngineExecutableProbeOptions {
  /** Dependency injection for deterministic tests; production uses process.env. */
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Extra fixed probes after PATH and home directories. */
  systemDirectories?: readonly string[]
}

export interface ResolveEngineExecutableOptions extends EngineExecutableProbeOptions {
  /** Engine being resolved: drives the error code, prose label and default names. */
  engine?: SessionEngine
  /** Binary base name to look for; defaults to the registry's acpAdapter.binary. */
  binaryName?: string
  /** Override env var; defaults to `WALNUT_<ENGINE>_PATH`. */
  overrideEnvVar?: string
}

/** Options shape kept identical to the codex-era resolver (tests inject these). */
export type ResolveSystemCodexPathOptions = EngineExecutableProbeOptions

interface ExecutableCandidateResult {
  executable?: string
  failure?: Exclude<EngineExecutableErrorReason, 'not_found'>
  canonicalPath?: string
}

/**
 * Resolve the SYSTEM executable for an engine's CLI (codex's CODEX_PATH, the
 * `gemini` / `opencode` / `goose` adapter binaries).
 *
 * Fail-closed: codex-acp falls back to its bundled @openai/codex dependency when
 * CODEX_PATH is absent, and npm prepends node_modules/.bin to PATH, so walnut
 * must pick the user's own installation explicitly. The node_modules ban is
 * SCOPED (see engine-probe.inspectExecutable): an npm-injected PATH entry or a
 * realpath inside THIS walnut install is refused, but a foreign node_modules
 * realpath is fine — that is exactly what a homebrew / `npm i -g` node CLI
 * looks like (/opt/homebrew/bin/gemini realpaths into a Cellar node_modules).
 */
export function resolveEngineExecutable(options: ResolveEngineExecutableOptions = {}): string {
  const engine = resolveEngine(options.engine ?? 'codex')
  const caps = engineCaps(engine)
  const binaryName = options.binaryName ?? caps.acpAdapter?.binary ?? engine
  const overrideEnvVar = options.overrideEnvVar ?? enginePathOverrideVar(engine)
  const label = caps.displayName
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const override = env[overrideEnvVar]

  if (override !== undefined) {
    const result = inspectExecutableCandidate(override, cwd)
    if (result.executable) return result.executable
    throw invalidOverrideError(engine, label, overrideEnvVar, override, result, cwd)
  }

  // Discovery is the catalog probe's own search (PATH → per-user install dirs →
  // fixed system dirs), so "the catalog says installed" and "the launcher can
  // find it" can never disagree.
  const discovered = findEngineBinary(binaryName, {
    env,
    cwd,
    ...(options.systemDirectories ? { systemDirectories: options.systemDirectories } : {}),
  })
  if (discovered) return discovered

  throw new EngineExecutableError(
    engine,
    'not_found',
    `No system ${label} executable was found. Install ${label} and make it executable on PATH, `
      + `or set ${overrideEnvVar} to an executable outside node_modules. `
      + `Walnut will not use a ${label} bundled inside its own node_modules.`,
  )
}

/** Codex-specific entry point, kept so existing imports and tests are unchanged. */
export function resolveSystemCodexPath(options: ResolveSystemCodexPathOptions = {}): string {
  return resolveEngineExecutable({
    ...options,
    engine: 'codex',
    binaryName: 'codex',
    overrideEnvVar: 'WALNUT_CODEX_PATH',
  })
}

/**
 * Selection policy lives in ONE place (engine-probe.inspectExecutable) so the
 * catalog's "installed?" answer and this launch-time resolution can never
 * disagree. This wrapper only turns a rejection into the granular reason the
 * override error messages need.
 */
function inspectExecutableCandidate(candidate: string, cwd: string): ExecutableCandidateResult {
  const executable = path.resolve(cwd, candidate)
  const verdict = inspectExecutable(executable)
  if (verdict.executable) return { executable: verdict.executable }
  // A PATH entry inside node_modules is the npm-injected-shim hazard: forbidden
  // outright, no filesystem detail worth reporting.
  if (verdict.rejection === 'npm_injected_path') return { failure: 'override_forbidden' }

  let canonicalPath: string
  try {
    canonicalPath = fsModule.realpathSync(executable)
  } catch {
    return { failure: 'override_missing' }
  }
  if (verdict.rejection === 'walnut_bundled') {
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

function invalidOverrideError(
  engine: SessionEngine,
  label: string,
  overrideEnvVar: string,
  override: string,
  result: ExecutableCandidateResult,
  cwd: string,
): EngineExecutableError {
  const absolute = path.resolve(cwd, override)
  switch (result.failure) {
    case 'override_forbidden': {
      const canonical = result.canonicalPath && result.canonicalPath !== absolute
        ? `; it resolves inside node_modules (${result.canonicalPath})`
        : ''
      return new EngineExecutableError(
        engine,
        'override_forbidden',
        `${overrideEnvVar} must point outside node_modules: ${absolute}${canonical}. `
          + `Choose a system ${label} executable or unset the override to use discovery.`,
        absolute,
      )
    }
    case 'override_not_file':
      return new EngineExecutableError(
        engine,
        'override_not_file',
        `${overrideEnvVar} is not a file: ${absolute}. Set it to the ${label} executable.`,
        absolute,
      )
    case 'override_not_executable':
      return new EngineExecutableError(
        engine,
        'override_not_executable',
        `${overrideEnvVar} is not executable: ${absolute}. Fix its permissions or choose another system ${label} executable.`,
        absolute,
      )
    default:
      return new EngineExecutableError(
        engine,
        'override_missing',
        `${overrideEnvVar} does not exist: ${absolute}. Fix it or unset the override to use system discovery.`,
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
  engine?: SessionEngine,
): void {
  bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
    sessionId: previousSessionId,
    taskId,
    variant: 'error',
    message: `Could not resume the previous ${engineCaps(engine ?? 'codex').displayName} thread. `
      + 'A fresh provider thread was started; earlier history remains visible in this transcript.',
    previousSessionId,
    newSessionId,
  } as never, ['main-ai'])
}

export function sessionMcpServerToAcp(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
): AcpMcpServer {
  return {
    name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
  }
}

export function parseCodexBaseConfig(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`CODEX_CONFIG must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CODEX_CONFIG must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Environment for the ACP worker + adapter (and therefore for every shell the
 * provider spawns inside the session).
 *
 * `WALNUT_SESSION_ID` is the managed-session identity the in-session `walnut` CLI
 * reads to resolve its own sid against the daemon gateway. The native `claude`
 * spawn sets it in daemon-standalone.ts / daemon-source.ts; without it here, a
 * Codex session has no managed identity at all. We deliberately do NOT set
 * `WALNUT_AGENT_SOCKET`: the
 * daemon's gateway resolves caller sids against its native-CLI session map,
 * which does not track ACP runtime ids, so advertising the socket would only
 * turn "not a managed session" into a confusing `unknown_caller`.
 */
/**
 * Initial approval preset for a codex session, resolved from the user's OWN
 * codex configuration — configure once in codex, every client respects it.
 *
 * Priority: `~/.codex/config.toml` (`approval_policy` + `sandbox_mode`,
 * top-level keys only) → walnut config.yaml `session.codex_default_mode` →
 * undefined (adapter default: 'agent'). Mapping mirrors the adapter's three
 * presets: sandbox danger-full-access → agent-full-access, read-only →
 * read-only, workspace-write → agent; a bare `approval_policy = "never"`
 * only fits the full-access preset (it is the sole preset that never asks).
 */
export function resolveCodexInitialMode(
  options: { env?: NodeJS.ProcessEnv; walnutDefault?: string } = {},
): string | undefined {
  const env = options.env ?? process.env
  const home = env.HOME || env.USERPROFILE
  if (home) {
    try {
      const raw = fsModule.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')
      let approval: string | undefined
      let sandbox: string | undefined
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        // Top-level keys only — [projects."…"] tables can carry unrelated keys.
        if (trimmed.startsWith('[')) break
        const m = trimmed.match(/^(approval_policy|sandbox_mode)\s*=\s*"([^"]+)"/)
        if (!m) continue
        if (m[1] === 'approval_policy') approval = m[2]
        else sandbox = m[2]
      }
      if (sandbox === 'danger-full-access') return 'agent-full-access'
      if (sandbox === 'read-only') return 'read-only'
      if (sandbox === 'workspace-write') return 'agent'
      if (approval === 'never') return 'agent-full-access'
    } catch { /* no config.toml — fall through to the walnut default */ }
  }
  const w = options.walnutDefault
  if (w === 'read-only' || w === 'agent' || w === 'agent-full-access') return w
  return undefined
}

export function buildAcpAdapterEnv(
  systemCodex: string | undefined,
  options: {
    disableProjectInstructions?: boolean
    developerInstructions?: string
    baseConfig?: Record<string, unknown>
    sessionId?: string
    /** Startup approval preset (adapter env INITIAL_AGENT_MODE). */
    initialAgentMode?: string
  } = {},
): Record<string, string> | undefined {
  const existingInstructions = typeof options.baseConfig?.developer_instructions === 'string'
    ? options.baseConfig.developer_instructions.trim()
    : ''
  const walnutInstructions = options.developerInstructions?.trim() ?? ''
  const developerInstructions = [existingInstructions, walnutInstructions].filter(Boolean).join('\n\n')
  const config = {
    ...(options.baseConfig ?? {}),
    ...(options.disableProjectInstructions ? { project_doc_max_bytes: 0 } : {}),
    ...(developerInstructions ? { developer_instructions: developerInstructions } : {}),
  }
  const env = {
    ...(systemCodex ? { CODEX_PATH: systemCodex } : {}),
    ...(Object.keys(config).length > 0 ? { CODEX_CONFIG: JSON.stringify(config) } : {}),
    ...(options.sessionId ? { WALNUT_SESSION_ID: options.sessionId } : {}),
    ...(options.initialAgentMode ? { INITIAL_AGENT_MODE: options.initialAgentMode } : {}),
  }
  return Object.keys(env).length > 0 ? env : undefined
}

export interface AcpSessionConfig {
  taskId: string
  project: string
  cwd: string
  mode: SessionMode
  /** Which ACP engine backs this session. Defaults to codex (back-compat). */
  engine?: SessionEngine
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
  /** Disable cwd AGENTS.md discovery for chat lanes rooted in Walnut's data directory. */
  disableProjectInstructions?: boolean
  /** Walnut-owned developer instructions for a Main Agent lane. */
  developerInstructions?: string
  /** Walnut MCP command for a Main Agent lane, independent of the global ACP opt-in. */
  walnutMcpServer?: AcpMcpServer
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

/**
 * Split an ACP catalog model id into its base id and reasoning effort.
 * The catalog advertises effort-qualified ids ("base[effort]") while the
 * adapter's `model` config option only accepts the BASE id, so both halves are
 * needed — and the persisted `acpModel` may be either shape (setModel sends the
 * base but persists the qualified id). ONE parser so the record write and the
 * config write can never disagree about where the split is.
 */
export function splitAcpModelId(modelId: string): { base: string; effort?: string } {
  const match = /^(.*?)\[([^\]]+)\]$/.exec(modelId)
  return match ? { base: match[1], effort: match[2] } : { base: modelId }
}

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
  options: Array<{ optionId?: string; kind?: string; name?: string }>
  receivedAt: number
}

export class AcpSession {
  readonly runtimeId: string
  readonly taskId: string
  readonly project: string
  /** Effective engine. Always an ACP engine: an AcpSession IS the ACP runtime,
   *  so a missing/native/unknown request degrades to codex rather than to the
   *  default engine (which would make every capability lookup answer 'native'). */
  readonly engineId: SessionEngine
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
  private _pendingPermissionCommit: Promise<void> = Promise.resolve()
  private _selfReport: PendingSelfReport | null = null
  private readonly normalizer: AcpStreamNormalizer

  constructor(cfg: AcpSessionConfig) {
    this.cfg = cfg
    this.taskId = cfg.taskId
    this.project = cfg.project
    const requestedEngine = resolveEngine(cfg.engine ?? 'codex')
    this.engineId = isAcpEngine(requestedEngine) ? requestedEngine : 'codex'
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
  get engine(): SessionEngine { return this.engineId }
  /** Storage shape for the record's `engine` field: ACP records ALWAYS carry an
   *  explicit engine (only the default engine persists as undefined). */
  private get persistedEngine(): SessionEngine {
    return normalizeEngine(this.engineId) ?? 'codex'
  }
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

  /**
   * Record patch carrying the provider-advertised display name for `modelId`.
   *
   * Qualified id first, then the base id: setModel applies the base to the
   * adapter but persists the qualified id, so either shape can be the current
   * model. Empty patch when the catalog isn't loaded yet — a blind write there
   * would erase a good name an earlier turn persisted.
   */
  private acpModelNamePatch(modelId: string): { acpModelName?: string } {
    if (this._models.availableModels.length === 0) return {}
    const { base } = splitAcpModelId(modelId)
    const hit = this._models.availableModels.find((m) => m.modelId === modelId)
      ?? this._models.availableModels.find((m) => m.modelId === base)
    // KEEP the `name !== modelId` guard: snapshotAcpModels defaults a missing
    // `name` to the modelId, so equality means "the adapter advertised no name".
    // Storing it would let the raw qualified id beat the client-side prettifier.
    // undefined is a deliberate CLEAR of a stale name from the previous model.
    return { acpModelName: hit && hit.name !== hit.modelId ? hit.name : undefined }
  }

  /** Get pending permission requests in the provider-neutral API/UI shape. */
  getPendingPermissionRequests(): Array<{
    requestId: string
    toolName?: string
    input?: Record<string, unknown>
    reason?: string
    acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>
  }> {
    if (this.isFullAccessMode()) return []
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
      this._pendingPermissions.clear()
      this.persistPendingPermission(true)
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
        if (this._pendingPermissions.delete(record.event.providerRequestId)) {
          this.persistPendingPermission()
        }
      }
    }

    for (const { name, payload } of this.normalizer.normalize(record)) {
      const full: Record<string, unknown> = { ...payload, sessionId: this.trackingId(), taskId: this.taskId }
      if (name === 'session:permission-request') {
        const requestId = full.requestId as string
        const options = (full.acpOptions as Array<{ optionId?: string; kind?: string; name?: string }>) ?? []
        this._pendingPermissions.set(requestId, {
          requestId,
          toolName: full.toolName as string,
          input: full.input as Record<string, unknown> | undefined,
          options,
          receivedAt: record.ts,
        })
        this._emittedPermissionRequestIds.add(requestId)
        // Codex snapshots approvalPolicy per turn: a mid-turn switch to full
        // access leaves the CURRENT turn still asking (2026-08-11 incident:
        // 6 more asks after the switch; 2 unanswered ones wedged the turn for
        // ~3min). Full access means "stop asking" — auto-allow EVERY incoming
        // request while the mode is active, and don't render a card at all.
        if (this.isFullAccessMode()) {
          log.session.info('acp: full access active — auto-allowing incoming permission', {
            sessionId: this.trackingId(), requestId,
          })
          void this.resolvePermissionRequest(requestId, true).catch(() => false)
          continue
        }
        this.persistPendingPermission()
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

  /** True while the session's approval preset is Agent (full access). */
  private isFullAccessMode(): boolean {
    return this._configOptions.find((c) => c.id === 'mode')?.currentValue === 'agent-full-access'
  }

  private persistPendingPermission(forceClear = false): void {
    const sessionId = this.trackingId()
    const pending = forceClear || this.isFullAccessMode()
      ? undefined
      : [...this._pendingPermissions.values()]
          .sort((left, right) => left.receivedAt - right.receivedAt)[0]
    const durable = pending
      ? {
          requestId: pending.requestId,
          subtype: 'can_use_tool',
          toolName: pending.toolName,
          input: pending.input,
          acpOptions: pending.options,
          receivedAt: new Date(pending.receivedAt).toISOString(),
        }
      : undefined
    this._pendingPermissionCommit = this._pendingPermissionCommit.then(async () => {
      if (durable) {
        await updateSessionRecordConditionally(
          sessionId,
          { pendingPermission: durable },
          // Compare against THIS session's engine, not a vendor literal: a
          // gemini record would never satisfy `=== 'codex'` and every pending
          // permission write would be silently dropped.
          (record) => resolveEngine(record.engine) === this.engineId
            && record.process_status !== 'stopped'
            && record.process_status !== 'error',
        )
      } else {
        await updateSessionRecord(sessionId, { pendingPermission: undefined })
      }
    }).catch((error) => {
      log.session.warn('acp: failed to persist pending permission', {
        sessionId,
        requestId: pending?.requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

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
    if (this.cfg.walnutMcpServer) {
      return [{
        ...this.cfg.walnutMcpServer,
        args: [...this.cfg.walnutMcpServer.args],
        env: this.cfg.walnutMcpServer.env.map((entry) => ({ ...entry })),
      }]
    }
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

  /**
   * argv for engines whose adapter comes from walnut config (source 'config').
   * Resolved HERE, where config is already loaded on this path, so
   * resolveAcpArtifacts stays synchronous for every other engine.
   */
  private async resolveConfiguredAdapterCmd(): Promise<string[] | undefined> {
    if (engineCaps(this.engineId).acpAdapter?.source !== 'config') return undefined
    try {
      const { getConfig } = await import('../core/config-manager.js')
      const config = await getConfig()
      // Read structurally: engines.* is an optional additive config section.
      const raw = (config as { engines?: Record<string, { adapter_cmd?: unknown } | undefined> })
        .engines?.[this.engineId]?.adapter_cmd
      if (!Array.isArray(raw)) return undefined
      return raw.filter((arg): arg is string => typeof arg === 'string' && arg !== '')
    } catch {
      // Unreadable config reads as "not configured" — resolveAcpArtifacts then
      // throws the actionable error naming the config key.
      return undefined
    }
  }

  /**
   * Environment for the adapter process.
   *
   * Everything except WALNUT_SESSION_ID is CODEX-SPECIFIC by contract:
   * CODEX_PATH / CODEX_CONFIG / INITIAL_AGENT_MODE are codex-acp's own variable
   * names, and CODEX_CONFIG is how walnut delivers developer instructions and
   * the startup approval preset to THAT adapter. Handing them to another
   * adapter would at best be ignored and at worst leak codex config JSON into
   * a gemini session, so they stay gated on the engine id (transport layer,
   * adapter-specific env contract — the allowed zone for a vendor check).
   * Other ACP engines get only walnut's managed-session identity; per-engine
   * env contracts get their own gate here when they are actually needed.
   */
  private async buildAdapterEnv(systemCodex: string | undefined): Promise<Record<string, string> | undefined> {
    if (this.engineId !== 'codex') {
      return buildAcpAdapterEnv(undefined, { sessionId: this.runtimeId })
    }
    const parsedBaseConfig = parseCodexBaseConfig(process.env.CODEX_CONFIG)
    // Startup approval preset: the session's OWN persisted choice wins (it is
    // replayed post-establish by replayPersistedConfig); only a session with
    // no saved mode inherits the default from ~/.codex/config.toml (respect
    // what the user configured in codex itself) or walnut config.yaml
    // session.codex_default_mode.
    let initialAgentMode: string | undefined
    const record = await getSessionByClaudeId(this.trackingId()).catch(() => undefined)
    const persistedMode = record?.acpConfig?.mode ?? this.cfg.acpConfig?.mode
    if (persistedMode) {
      initialAgentMode = persistedMode
    } else {
      let walnutDefault: string | undefined
      try {
        const { getConfig } = await import('../core/config-manager.js')
        const config = await getConfig()
        walnutDefault = (config.session as { codex_default_mode?: string } | undefined)?.codex_default_mode
      } catch { /* config unreadable — codex config.toml still applies */ }
      initialAgentMode = resolveCodexInitialMode({ walnutDefault })
    }
    // Non-lane codex sessions get the same walnut context every native claude
    // session gets (wn gateway + skill pointer); lanes get the self-knowledge
    // contract instead (they ARE the personal AI — the hint would be circular).
    let defaultInstructions: string | undefined
    if (this.cfg.lane) {
      defaultInstructions = renderSelfKnowledgeContract()
    } else {
      try {
        const { buildSessionContext } = await import('../agent/session-context.js')
        defaultInstructions = (await buildSessionContext(this.taskId, this.cfg.cwd)).systemPrompt || undefined
      } catch { /* context is additive — never block establish */ }
    }
    return buildAcpAdapterEnv(systemCodex, {
      disableProjectInstructions: this.cfg.disableProjectInstructions,
      developerInstructions: this.cfg.developerInstructions ?? defaultInstructions,
      baseConfig: parsedBaseConfig,
      sessionId: this.runtimeId,
      initialAgentMode,
    })
  }

  private async resolveArtifacts(): Promise<{ workerCmd: string[]; adapterCmd: string[] }> {
    if (this.cfg.artifacts) return this.cfg.artifacts
    return resolveAcpArtifacts(this.engineId, {
      configuredAdapterCmd: await this.resolveConfiguredAdapterCmd(),
    })
  }

  private async establishProviderSession(): Promise<string> {
    await this.seedReplayCursor()
    const { workerCmd, adapterCmd } = await this.resolveArtifacts()
    // Fail closed BEFORE touching the daemon: a missing provider executable is
    // a configuration error, not a transport one. 'cli' engines already got
    // this check inside resolveArtifacts; codex needs its own because the path
    // travels as adapter env (CODEX_PATH), not as argv.
    // Production always passes a validated system Codex path — omitting
    // CODEX_PATH would make codex-acp silently use its bundled dependency.
    // Tests that inject a mock adapter do not need a Codex executable.
    const systemCodex = this.engineId === 'codex' && !this.cfg.artifacts
      ? resolveSystemCodexPath()
      : undefined

    // Concurrent with ensureConn: the mount list is a small config read and must
    // not add serial latency to the cold-resume path, which is already the
    // slowest thing walnut does (worker spawn + provider initialize + load).
    const [mcpServers, conn] = await Promise.all([
      this.resolveMcpServers(),
      this.ensureConn(),
    ])
    const adapterEnv = await this.buildAdapterEnv(systemCodex)
    // Adapters that answer `loadSession: false` (gemini) can NEVER resume a
    // provider thread: acpStart would run session/load, get load_failed, and
    // fall back to a fresh session on EVERY worker respawn. Pre-empt that round
    // trip and take the fresh-session path directly, announcing the identity
    // boundary exactly like the load_failed handler below does. A warm worker
    // ignores providerSessionId entirely, so this is a no-op when nothing died.
    const preemptFreshSession = Boolean(this._providerSessionId)
      && this._capabilities?.loadSession === false
    const boundaryFrom = preemptFreshSession ? this.trackingId() : undefined
    if (preemptFreshSession) {
      log.session.info('acp: adapter cannot load sessions — starting a fresh provider thread', {
        sessionId: boundaryFrom, runtimeId: this.runtimeId, engine: this.engineId,
      })
    }
    const startResp = await conn.send('acpStart', {
      sid: this.runtimeId,
      cwd: this.cfg.cwd,
      workerCmd,
      adapterCmd,
      env: adapterEnv,
      providerSessionId: preemptFreshSession ? undefined : (this._providerSessionId ?? undefined),
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
          emitAcpIdentityBoundary(this.taskId, previousSessionId, newSessionId, this.engineId)
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
        // Pre-empted resume: the worker minted a new provider thread, so tell
        // the transcript once (same message the load_failed fallback emits). A
        // warm attach keeps the same id and stays silent.
        if (boundaryFrom && this.trackingId() !== boundaryFrom) {
          emitAcpIdentityBoundary(this.taskId, boundaryFrom, this.trackingId(), this.engineId)
        }
      }
    } catch (error) {
      await this.discardUnpublishedWorker()
      throw error
    }
    if (!this._providerSessionId) {
      throw new Error('ACP session established without a provider session ID')
    }
    await this.replayPersistedConfig(conn)
    this.persistPendingPermission()
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
        // Pending permissions adopted from the worker snapshot predate this
        // replay — under restored full access they must not wait for a click.
        if (configId === 'mode' && value === 'agent-full-access') {
          for (const requestId of [...this._pendingPermissions.keys()]) {
            await this.resolvePermissionRequest(requestId, true).catch(() => false)
          }
        }
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

  /** True when this worker's adapter advertised mid-turn steering support. */
  get canSteer(): boolean { return this._capabilities?.steering === true }

  /**
   * Inject a message into the RUNNING turn (codex `turn/steer` via the
   * adapter's `_session/steering`). Returns true when the text joined the
   * live turn — delivered, no queue wait. Returns false when steering could
   * not apply (no live turn / unsupported adapter / turn ended mid-flight):
   * the caller keeps the message queued and drains it at turn end as before.
   * Never throws for steer-shaped failures; only infrastructure errors
   * (daemon RPC transport) propagate.
   */
  async steer(message: string, walnutMessageId: string): Promise<boolean> {
    if (!this._active || !this._turnActive) return false
    if (this._capabilities && !this._capabilities.steering) return false
    const conn = await this.ensureConn()
    const commandId = `acp-steer:${walnutMessageId}`
    const resp = await conn.send('acpSteer', {
      sid: this.runtimeId,
      commandId,
      walnutMessageId,
      text: message,
    })
    if (resp.ok) return true
    const kind = (resp as { errorKind?: string }).errorKind
    // Anything steer-shaped (no live turn, unsupported, race, old daemon
    // without the acpSteer command) degrades to the queue path silently.
    log.session.info('acp: steer not applied — message stays queued', {
      runtimeId: this.runtimeId, walnutMessageId, errorKind: kind ?? 'unknown',
    })
    return false
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
          engine: this.persistedEngine,
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
        ...this.acpModelNamePatch(this._models.currentModelId),
      }).catch(() => {})
    }
  }

  private isSameDurableIdentity(record: {
    engine?: string
    taskId?: string
    acpRuntimeId?: string
  }): boolean {
    // Engine EQUALITY against this session's own engine (ACP records always
    // persist an explicit engine, so resolveEngine is just defensive here).
    // A literal 'codex' would make every non-codex record fail to match its
    // OWN session and turn every identity migration into a thrown error.
    return resolveEngine(record.engine) === this.engineId
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
      const options = (p.options as Array<{ optionId?: string; kind?: string; name?: string }>) ?? []
      this._pendingPermissions.set(p.providerRequestId, {
        requestId: p.providerRequestId,
        toolName,
        input,
        options,
        receivedAt: p.receivedAt,
      })
      // Under full access an adopted pending request is answered, not shown.
      if (this.isFullAccessMode()) {
        this._emittedPermissionRequestIds.add(p.providerRequestId)
        log.session.info('acp: full access active — auto-allowing adopted permission', {
          sessionId: this.trackingId(), requestId: p.providerRequestId,
        })
        void this.resolvePermissionRequest(p.providerRequestId, true).catch(() => false)
        continue
      }
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
        ...(this._models.currentModelId
          ? {
            acpModel: this._models.currentModelId,
            ...this.acpModelNamePatch(this._models.currentModelId),
          }
          : {}),
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
      ...(configId === 'model'
        ? { acpModel: value, ...this.acpModelNamePatch(value) }
        : {}),
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
    const { base, effort } = splitAcpModelId(modelId)
    if (!await this.setConfigOption('model', base)) return false
    if (effort && !await this.setConfigOption('reasoning_effort', effort)) {
      log.session.warn('acp: model applied but reasoning_effort rejected', {
        sessionId: this.trackingId(), modelId, effort,
      })
    }
    // Persist the requested (qualified) id so the pill shows what was chosen.
    this._models = { ...this._models, currentModelId: modelId }
    await updateSessionRecord(this.trackingId(), {
      acpModel: modelId,
      ...this.acpModelNamePatch(modelId),
    }).catch(() => {})
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
    this.persistPendingPermission(true)
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
      // Amendment options (accept_execpolicy_amendment, apply_network_policy_
      // amendment:*) also carry kind allow_always but mean "change durable
      // policy", not "approve this call" — a kind-based picker must never
      // select one implicitly (reference study 2026-08-12; KiRoom has this
      // hole and is saved only by codex's option ordering).
      const isAmendment = (o: { optionId?: string }) =>
        typeof o.optionId === 'string' && o.optionId.includes('amendment')
      optionId = options.find((o) => o.kind === 'allow_once')?.optionId
        ?? options.find((o) => o.kind?.startsWith('allow') && !isAmendment(o))?.optionId
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
      this.persistPendingPermission()
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
      this.persistPendingPermission()
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
      this._pendingPermissions.clear()
      this.persistPendingPermission(true)
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
    this.persistPendingPermission(true)
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
    if (this.conn?.connected) {
      await this.conn.send('acpStop', { sid: this.runtimeId }).catch(() => {})
    }
    this._active = false
    this._turnActive = false
    this._pendingPermissions.clear()
    this.persistPendingPermission(true)
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
    if (!record) return
    // Adapter facts come back FIRST: they are independent of the turn cursor,
    // and gating them on consumedOffset hid the capability snapshot from any
    // record whose cursor was never committed — including from the check that
    // decides whether this thread can be resumed at all (loadSession).
    if (!this._journalPath) this._journalPath = record.acpJournalPath
    if (!this._capabilities && record.acpCapabilities) {
      // Records persisted before the steering feature lack the flag → false.
      this._capabilities = { steering: false, ...record.acpCapabilities }
    }
    if (!validOffset(record.consumedOffset)) return
    this._committedV = record.consumedOffset
    this._seenV = Math.max(this._seenV, record.consumedOffset)
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
    this.persistPendingPermission(true)
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
