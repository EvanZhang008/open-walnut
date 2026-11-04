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
import os from 'node:os'
import path from 'node:path'
import fsModule from 'node:fs'
import { fileURLToPath } from 'node:url'
import { log } from '../logging/index.js'
import { WALNUT_HOME } from '../constants.js'
import { bus, EventNames } from '../core/event-bus.js'
import { renderSelfKnowledgeContract } from '../core/self-knowledge-contract.js'
import { renderHintBlock } from '../core/hints/hint-format.js'
import type { SessionEngine, SessionMode, SessionRecord } from '../core/types.js'
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
  resolveOverridePath,
} from '../core/agents/engine-probe.js'
import { localDaemon } from './local-daemon.js'
import { getDirectDaemonConnection, DaemonConnection, type DaemonEvent } from './daemon-connection.js'
import type { AcpHostAdapterSpec } from './acp-host-artifacts.js'
import { hostAdapterSpec } from '../core/agents/host-adapter-spec.js'
import { AcpJournalProjector } from './acp-journal-projector.js'
import { AcpStreamNormalizer } from './acp-stream-normalizer.js'
import { AcpTurnSpeedMeter } from '../core/sessions/acp-turn-speed.js'
import { walnutApiEnvForSession } from '../lib/self-api-root.js'
import { requestTagOn, requestTagValue, withRequestTagHeaders } from '../core/sessions/request-tag.js'
import { singleFile, type SingleFile } from '../lib/single-file.js'
import type {
  AcpCapabilitySnapshot,
  AcpConfigOption,
  AcpMcpServer,
  AcpModelCatalog,
  JournalRecord,
  WorkerStateSnapshot,
} from './acp-worker/protocol.js'
import {
  mergeAcpSpawnEnv,
  resolveWalnutMcpServers,
  snapshotAcpConfigOptions,
  CONTROL_PROMPT_GUARD,
  walnutMcpToolSet,
  withCoreWalnutTools,
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
import { BudgetCheckingError, BudgetPausedError } from './delivery-failure.js'
import { piNodeFor } from './pi-adapter-node.js'
import {
  ACP_ASKING_MODE_VALUES,
  ACP_FULL_ACCESS_MODE_VALUES,
  AcpModeRefusedError,
  acpAutoAnswer,
  acpPostureAllowsAll,
  acpSupposedFullAccess,
  resolveCodexStartPreset,
  type AcpAutoAnswer,
} from './acp-permission-posture.js'
import { CODEX_MODEL_PREFIX_ENV, codexPickForProvider, codexRawConfig, parseCodexBaseConfig, resolveCodexEngine } from './codex-engine-config.js'
import { parseUsageLimitReset, usageLimitSentence } from './usage-limit-text.js'
import type { UsageLimitFacts } from '../core/sessions/usage-limit-model.js'

const BUNDLED_ADAPTER_ENTRIES: Partial<Record<SessionEngine, string>> = {
  codex: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
  pi: 'dist/daemon-binaries/pi-acp.js',
}

export interface ResolveAcpArtifactsOptions {
  /** argv for a `source: 'config'` engine (walnut config engines.<id>.adapter_cmd). */
  configuredAdapterCmd?: readonly string[]
  /** Executable-probe DI (tests); production reads process.env / process.cwd(). */
  executable?: EngineExecutableProbeOptions
}

/** The hint kind that carries a task session's Walnut context on an engine with no instructions channel. */
export const SESSION_CONTEXT_HINT_KIND = 'session-context'
const SESSION_CONTEXT_LEAD = 'Your standing instructions for this whole session. This engine has no system prompt, so Walnut sends them here once; they are configuration, not a message from the user, so do not reply to them.'

/**
 * Locate the worker bundle + this engine's adapter command within this walnut
 * install (MVP: local host). The worker bundle is engine-neutral; the adapter
 * comes from the registry's `acpAdapter` descriptor:
 *   bundled → node + a package under node_modules (codex)
 *   cli     → the provider's own CLI speaks ACP (`gemini --experimental-acp`)
 *   config  → argv the user supplied in walnut config (custom)
 */
/**
 * The env acpStart hands the worker and its adapter. On the compiled file their
 * commands are scripts in THIS server's runtime tree, and the file runs a script
 * only inside its own tree; the daemon may have been started by an earlier
 * deploy (dev-prod.sh gives each its own WALNUT_RUNTIME_DIR) and its children
 * inherit that one, so the tree is named here.
 */
export function acpStartEnv(env: Record<string, string> | undefined, info: SingleFile | null = singleFile()): Record<string, string> | undefined {
  if (!info) return env
  return { ...(env ?? {}), WALNUT_RUNTIME_DIR: path.dirname(info.root) }
}

/** Keys that only name this machine's files, which another host's daemon finds for itself. */
const HOST_LOCAL_ENV_KEYS = new Set(['PATH', 'HOME', 'NODE_PATH', 'CODEX_PATH', 'PI_ACP_PI_COMMAND', 'WALNUT_RUNTIME_DIR'])

/**
 * The adapter env for a session on another host: without this machine's paths
 * (the keys above, and any value inside this machine's home), so what that host's
 * daemon found (its CODEX_PATH, its PATH) is what runs.
 */
export function hostAdapterEnv(env: Record<string, string> | undefined, home: string = os.homedir()): Record<string, string> | undefined {
  if (!env) return env
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (HOST_LOCAL_ENV_KEYS.has(k)) continue
    if (typeof v === 'string' && home && (v === home || v.startsWith(home + '/'))) continue
    out[k] = v
  }
  return out
}

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
  const executable = resolveOverridePath(candidate, cwd)
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

/** Hint kind of the note a user prompt carries after a status question was cut (noteControlCut). */
export const CONTROL_CUT_HINT_KIND = 'status-question-cut'
export const CONTROL_CUT_NOTE = 'An earlier "[Walnut status question]" in this conversation was cut off before you answered it. '
  + 'Do not answer it now and do not write FOR_USER_ lines: answer only the message below.'

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

export { parseCodexBaseConfig }

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

/**
 * Add the launching server's API env to the walnut MCP mount: the provider spawns
 * MCP servers with the env list it is given, so inheriting the adapter's env is
 * not something to count on. Other mounts are left exactly as configured.
 */
export function withWalnutApiEnv(servers: AcpMcpServer[], walnutEnv: Record<string, string>): AcpMcpServer[] {
  const entries = Object.entries(walnutEnv)
  if (entries.length === 0) return servers
  return servers.map((server) => server.name !== 'walnut' ? server : {
    ...server,
    env: [
      ...server.env.filter((entry) => !(entry.name in walnutEnv)),
      ...entries.map(([name, value]) => ({ name, value })),
    ],
  })
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
    /** Env pointing in-session Walnut clients at the launching server (self-api-root.ts). */
    walnutApiEnv?: Record<string, string>
    /** engines.codex.provider.model_prefix: the patched adapter builds Codex a model catalog for those ids. */
    codexModelPrefix?: string
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
    ...(options.codexModelPrefix ? { [CODEX_MODEL_PREFIX_ENV]: options.codexModelPrefix } : {}),
    ...(options.walnutApiEnv ?? {}),
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/**
 * Operator env overlay for an engine's adapter process, from walnut config:
 *
 *   engines:
 *     goose:
 *       env:
 *         AWS_PROFILE: my-bedrock-profile   # set for the adapter
 *         AWS_BEARER_TOKEN_BEDROCK: null    # UNSET an inherited variable
 *
 * This is how a provider CLI gets its credentials when walnut launches it:
 * the adapter inherits the SERVER's env, not the user's shell, so a goose or
 * opencode that works in a terminal still fails from the UI without this.
 *
 * A YAML `null` maps to '' here; the spawn site (mergeAcpSpawnEnv) DELETES
 * empty-string entries from the merged env instead of setting them — an unset
 * must remove the inherited value (an empty AWS_BEARER_TOKEN_BEDROCK would
 * still be preferred over a profile by the AWS SDK's credential chain).
 * Values are used verbatim; anything that is not a string or null is ignored.
 */
export function engineEnvOverlayFromConfig(
  config: unknown,
  engineId: SessionEngine,
): Record<string, string> | undefined {
  const raw = (config as { engines?: Record<string, { env?: unknown } | undefined> } | null | undefined)
    ?.engines?.[engineId]?.env
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const overlay: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue
    if (value === null) overlay[key] = ''
    else if (typeof value === 'string') overlay[key] = value
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}

export interface AcpSessionConfig {
  taskId: string
  project: string
  cwd: string
  /** The Walnut permission mode (a start that names none passes DEFAULT_SESSION_MODE). */
  mode: SessionMode
  /** The start named `mode` itself: it then wins over the engine's own config file
   *  (acp-permission-posture.ts resolveCodexStartPreset). */
  modeNamed?: boolean
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
  /**
   * The host the session runs on (a key of config.hosts); absent or '__local__' =
   * this machine. On another host the host's daemon builds the worker and adapter
   * commands itself from `hostAdapterSpec` (acp-host-artifacts.ts).
   */
  host?: string
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

/** How long a cold load waits for the engine's default model before going on without it. */
const FOLLOW_DEFAULT_MODEL_WAIT_MS = 5_000
/** A cached engine default model older than this may predate the user's change. */
const FOLLOW_DEFAULT_MODEL_CACHE_MS = 60_000
/** How long a user's prompt lets a turn-end status question finish before aborting it. */
export const STATUS_QUESTION_FINISH_MS = 8_000

/**
 * Split an ACP catalog model id into its base id and reasoning effort.
 * The catalog advertises effort-qualified ids ("base[effort]") while the
 * adapter's `model` config option only accepts the BASE id, so both halves are
 * needed — and the persisted `acpModel` may be either shape (setModel sends the
 * base but persists the qualified id). ONE parser so the record write and the
 * config write can never disagree about where the split is.
 */
export function splitAcpModelId(modelId: string): { base: string; effort?: string } {
  if (modelId.startsWith('[')) {
    try { if (Array.isArray(JSON.parse(modelId))) return { base: modelId } } catch { /* An effort suffix is not JSON. */ }
  }
  const match = /^(.*?)\[([^\]]+)\]$/.exec(modelId)
  return match ? { base: match[1], effort: match[2] } : { base: modelId }
}

export { CONTROL_PROMPT_GUARD }

/** A status question ended because the model reached for a tool; `partialText` is what it wrote first. */
export class ControlToolRefusedError extends Error {
  constructor(readonly partialText: string) {
    super('the model started a tool during a status question, so the question was ended')
    this.name = 'ControlToolRefusedError'
  }
}

interface PendingSelfReport {
  commandId: string
  /** Its own control-prompt-accepted was read: frames before it are an earlier question's stragglers. */
  started: boolean
  toolRefused: boolean
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
  /** The provider's own tool kind (`execute`, `edit`, `switch_mode`…), for acpAutoAnswer. */
  kind?: string
  title?: string
  /** The request's own `_meta` (acp-permission-posture.ts reads Codex's command there). */
  meta?: Record<string, unknown>
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
  /** A provider thread this instance minted that has not read Walnut's session
   *  context yet. Only engines with no instructions channel owe it (every ACP
   *  engine but Codex): their first prompt carries it (sessionContextPrefix). */
  private _contextOwed = false
  /** A status question ended before its answer: the next user prompt says so (noteControlCut). */
  private _controlCut = false
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
  /** The provider's usage-limit words when the usage limit ended this turn (the record's errorMessage). */
  private _turnLimitText: string | null = null
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
  /** Status questions run one at a time, each for its own answer (requestTurnCompleteSelfReport). */
  private _controlTail: Promise<void> = Promise.resolve()
  /** Bumped by a user prompt, an abort, a stop or a detach: a status question still queued
   *  then is dropped, never sent after them. */
  private _controlEpoch = 0
  /** The cancel of a status question that ran out of time, while it is still in flight. */
  private _controlCancel: Promise<void> | null = null
  private readonly normalizer: AcpStreamNormalizer
  /** establish loaded an existing thread into a new worker (followEngineDefaultModel). */
  private _coldLoaded = false
  /** The composer's turn speed readout, measured from the journal (see acp-turn-speed.ts). */
  private readonly _speed = new AcpTurnSpeedMeter()
  private _speedEmitAt = 0
  /** Latest usage_update, written to the record at turn end (one write per turn). */
  private _lastContext: { used: number; size: number } | null = null
  /** The adapter `mode` preset this session chose (its record's acpConfig.mode, or a
   *  pick through the control): an asking one stands over the Walnut mode. */
  private _chosenMode: string | undefined
  /** The preset Walnut started the adapter in, persisted by the start (startAgentMode). */
  private _startAgentMode: string | undefined
  /** config `session.auto_approve_bypass` (default on), read at establish. */
  private _autoApproveBypass = true
  /** Requests Walnut is answering now: one answer each, whichever path saw it first. */
  private readonly _autoAnswering = new Set<string>()
  /** Requests Walnut could not answer: they are a person's now (autoAllow). */
  private readonly _autoFailed = new Set<string>()

  constructor(cfg: AcpSessionConfig) {
    this.cfg = cfg
    this.taskId = cfg.taskId
    this.project = cfg.project
    const requestedEngine = resolveEngine(cfg.engine ?? 'codex')
    this.engineId = isAcpEngine(requestedEngine) ? requestedEngine : 'codex'
    this.runtimeId = cfg.runtimeId ?? `acp-${crypto.randomBytes(8).toString('hex')}`
    this._providerSessionId = cfg.providerSessionId ?? null
    this._mode = cfg.mode
    this._chosenMode = cfg.acpConfig?.mode
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
  /** Its folder was gone and Walnut moved it (core/sessions/folder-gone.ts): the next worker starts here. */
  adoptCwd(cwd: string): void { this.cfg = { ...this.cfg, cwd } }
  get host(): string { return this.cfg.host && this.cfg.host !== '__local__' ? this.cfg.host : '__local__' }
  /** The session runs on another host's daemon (AcpSessionConfig.host). */
  private get remote(): boolean { return this.host !== '__local__' }
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
    // What Walnut answers itself is never shown (acp-permission-posture.ts).
    return [...this._pendingPermissions.values()].filter((p) => !this.autoAnswerOf(p)).map(({ requestId, toolName, input, options }) => ({
      requestId, toolName, input, acpOptions: options,
    }))
  }

  // ── Connection ──

  private async ensureConn(): Promise<DaemonConnection> {
    if (this.conn?.connected) return this.conn
    if (this.remote && !this.cfg.directWsUrl) return this.adoptConn(await (await import('../core/hosts/link.js')).link(this.host))
    const wsUrl = this.cfg.directWsUrl || localDaemon.wsUrl
    if (!wsUrl) {
      await localDaemon.ensureRunning()
    }
    const finalUrl = this.cfg.directWsUrl || localDaemon.wsUrl
    if (!finalUrl) throw new Error('AcpSession: local daemon not running')
    return this.adoptConn(await getDirectDaemonConnection('__local__', finalUrl))
  }

  private adoptConn(conn: DaemonConnection): DaemonConnection {
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

    this.meterTurnSpeed(record)

    // The turn's error is a usage limit: the facts ride its session:error to the usage-limit wait.
    const usageLimit = record.kind === 'meta' && record.event.type === 'error' && v > this._committedV
      ? this.usageLimitOf(record.event as { errorKind?: string; resetsAt?: number }) : undefined
    for (const { name, payload } of this.normalizer.normalize(record)) {
      const full: Record<string, unknown> = { ...payload, sessionId: this.trackingId(), taskId: this.taskId }
      if (name === 'session:error' && usageLimit) {
        full.usageLimit = usageLimit
        this._turnLimitText = usageLimit.text ?? null
      }
      if (name === 'session:permission-request') {
        const requestId = full.requestId as string
        const options = (full.acpOptions as Array<{ optionId?: string; kind?: string; name?: string }>) ?? []
        const rawParams = record.kind === 'acp'
          ? (record.frame as { params?: { toolCall?: { kind?: unknown; title?: unknown }; _meta?: unknown } } | undefined)?.params
          : undefined
        const rawCall = rawParams?.toolCall
        const rawMeta = rawParams?._meta && typeof rawParams._meta === 'object' ? rawParams._meta as Record<string, unknown> : undefined
        const pending: PendingPermission = {
          requestId,
          toolName: full.toolName as string,
          input: full.input as Record<string, unknown> | undefined,
          options,
          receivedAt: record.ts,
          ...(typeof rawCall?.kind === 'string' ? { kind: rawCall.kind } : {}),
          ...(typeof rawCall?.title === 'string' ? { title: rawCall.title } : {}),
          ...this.permissionMeta(rawMeta),
        }
        this._pendingPermissions.set(requestId, pending)
        this._emittedPermissionRequestIds.add(requestId)
        // Walnut answers what it owns (its own CLI and tools) and everything in a
        // bypass posture, and draws no card for it. Codex snapshots approvalPolicy
        // per turn: a mid-turn switch to full access leaves the CURRENT turn still
        // asking (2026-08-11 incident: 6 more asks after the switch; 2 unanswered
        // ones wedged the turn for ~3min), so "stop asking" is answered here too.
        const auto = this.autoAnswerOf(pending)
        if (auto) {
          void this.autoAllow(requestId, auto, 'incoming')
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

  /**
   * A worker error that is the subscription's usage limit: the worker names it (errorKind
   * 'usage_limit', with the reset it read on the host), or an older worker's protocol error whose
   * turn ended on the provider's limit words (codex-acp streams them as the turn's last text).
   */
  private usageLimitOf(event: { errorKind?: string; resetsAt?: number }): UsageLimitFacts | undefined {
    // Only the provider's limit words: the answer so far may hold the model's own text before them.
    const words = usageLimitSentence(this.normalizer.answerSoFar())
    if (event.errorKind !== 'usage_limit' && !(event.errorKind === 'protocol' && words)) return undefined
    const now = Date.now()
    const fromText = event.resetsAt ? undefined : parseUsageLimitReset(words, now)
    const resetsAt = event.resetsAt ?? fromText
    return {
      engine: this.engineId,
      ...(resetsAt ? { resetsAt, resetsFrom: 'text' as const } : {}),
      text: words ?? 'Usage limit reached',
    }
  }

  /** Feed one journal record to the turn speed meter; emit its readout. */
  private meterTurnSpeed(record: JournalRecord): void {
    if (record.kind === 'meta') {
      const event = record.event
      if (event.type === 'turn-started') {
        this._speed.start(record.ts, this.meterModel())
        this.emitTurnSpeed(record.ts, false)
      } else if (event.type === 'turn-ended' || event.type === 'turn-interrupted') {
        if (!this._speed.active) return
        const usage = event.type === 'turn-ended' ? event.usage : undefined
        const interrupted = event.type === 'turn-interrupted' || (event.type === 'turn-ended' && event.stopReason === 'cancelled')
        const speed = this._speed.finish(record.ts, usage, interrupted)
        this.emitTurnSpeed(record.ts, true)
        const sid = this._providerSessionId
        const context = this._lastContext
        if (sid) {
          void updateSessionRecord(sid, {
            lastTurnSpeed: speed,
            ...(context ? { contextTokens: context.used, ...(context.size > 0 ? { modelMaxWindow: context.size, modelMaxWindowSource: 'engine' as const } : {}) } : {}),
          }).catch(() => {})
        }
      }
      return
    }
    if (record.source !== undefined && record.source !== 'live') return
    const frame = record.frame as { method?: unknown; params?: { update?: Record<string, unknown> } } | null
    if (frame?.method !== 'session/update') return
    const update = frame.params?.update
    if (!update) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = update.content as { type?: unknown; text?: unknown } | undefined
        const chars = content?.type === 'text' && typeof content.text === 'string' ? content.text.length : 0
        this._speed.chunk(record.ts, chars)
        if (record.ts - this._speedEmitAt >= 400) this.emitTurnSpeed(record.ts, false)
        return
      }
      case 'tool_call':
        if (typeof update.toolCallId === 'string') this._speed.toolCall(record.ts, update.toolCallId)
        this.emitTurnSpeed(record.ts, false)
        return
      case 'tool_call_update':
        if (typeof update.toolCallId === 'string' && (update.status === 'completed' || update.status === 'failed')) {
          this._speed.toolDone(record.ts, update.toolCallId)
        }
        return
      case 'usage_update':
        this._speed.usage()
        if (typeof update.used === 'number' && typeof update.size === 'number') {
          this._lastContext = { used: update.used, size: update.size }
        }
        return
    }
  }

  /** The model the meter prices and names: the family id, without its effort. */
  private meterModel(): string | undefined {
    const current = this._models.currentModelId
    return current ? splitAcpModelId(current).base : undefined
  }

  private emitTurnSpeed(now: number, final: boolean): void {
    const sid = this._providerSessionId
    if (!sid) return
    if (!final && !this._speed.active) return
    this._speedEmitAt = now
    bus.emit(EventNames.SESSION_TURN_SPEED, {
      sessionId: sid,
      taskId: this.taskId,
      speed: this._speed.snapshot(now),
    }, ['web-ui'], { source: 'session-runner' })
  }

  /** The session a turn bills to, so the host's budget gates a restarted worker from its first turn. */
  private budgetTarget(): { budgetSid?: string } {
    return this._providerSessionId ? { budgetSid: this._providerSessionId } : {}
  }

  /** Records/API key: providerSessionId once known, else runtimeId (pending phase). */
  private trackingId(): string { return this._providerSessionId ?? this.runtimeId }

  /** True while the session answers every permission request itself (acp-permission-posture.ts). */
  private postureAllowsAll(): boolean {
    return acpPostureAllowsAll({
      walnutMode: this._mode,
      chosenMode: this._chosenMode,
      autoApproveBypass: this._autoApproveBypass,
    })
  }

  /**
   * A request's `_meta` as acpAutoAnswer reads it. codex-acp reports the command
   * it runs only there; its `rawInput.command` has the shell wrapper and outer
   * quotes stripped, which inverts the quoting. A Codex request without it (an
   * older worker's snapshot) gets an empty codex block, so its command is never
   * read from rawInput and such a request goes to a person outside bypass.
   */
  private permissionMeta(meta: Record<string, unknown> | undefined): { meta?: Record<string, unknown> } {
    if (meta) return { meta }
    return this.engineId === 'codex' ? { meta: { codex: {} } } : {}
  }

  /** Why Walnut answers this pending request itself, or undefined when a person does. */
  private autoAnswerOf(p: PendingPermission): AcpAutoAnswer | undefined {
    if (this._autoFailed.has(p.requestId)) return undefined
    return acpAutoAnswer({ kind: p.kind, title: p.title, input: p.input, meta: p.meta }, this.postureAllowsAll())
  }

  /**
   * Answer a request Walnut owns. The answer is checked: a failed or refused one
   * is tried again (AUTO_ANSWER_ATTEMPTS in all, a short wait between), and a
   * request still unanswered after that becomes an ordinary pending permission,
   * with its card, so it never blocks the turn out of sight.
   */
  private async autoAllow(requestId: string, reason: AcpAutoAnswer, origin: 'incoming' | 'adopted' | 'pending'): Promise<void> {
    if (this._autoAnswering.has(requestId) || this._autoFailed.has(requestId)) return
    this._autoAnswering.add(requestId)
    log.session.info('acp: permission answered by Walnut', {
      sessionId: this.trackingId(), requestId, reason, origin, engine: this.engineId, mode: this._mode,
    })
    let lastError: string | undefined
    try {
      for (let attempt = 1; attempt <= AcpSession.AUTO_ANSWER_ATTEMPTS; attempt++) {
        try {
          if (await this.resolvePermissionRequest(requestId, true)) return
          lastError = 'not answered'
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        }
        // The worker no longer holds it (answered elsewhere, cancelled): nothing waits on it.
        if (!this._pendingPermissions.has(requestId)) return
        if (attempt < AcpSession.AUTO_ANSWER_ATTEMPTS) await new Promise((r) => setTimeout(r, AcpSession.AUTO_ANSWER_RETRY_MS * attempt))
      }
    } finally {
      this._autoAnswering.delete(requestId)
    }
    const pending = this._pendingPermissions.get(requestId)
    if (!pending) return
    this._autoFailed.add(requestId)
    log.session.warn('acp: Walnut could not answer a permission; it goes to a person', {
      sessionId: this.trackingId(), requestId, reason, error: lastError,
    })
    this.persistPendingPermission()
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: this.trackingId(),
      taskId: this.taskId,
      requestId,
      toolName: pending.toolName,
      input: pending.input,
      acpOptions: pending.options,
    }, acpEventDestinations('session:permission-request'), { urgency: 'urgent' })
  }

  static AUTO_ANSWER_ATTEMPTS = 3
  static AUTO_ANSWER_RETRY_MS = 250

  /** Answer every pending request Walnut now owns (after a mode change). */
  private async autoAllowPending(): Promise<void> {
    for (const pending of [...this._pendingPermissions.values()]) {
      const auto = this.autoAnswerOf(pending)
      if (auto) await this.autoAllow(pending.requestId, auto, 'pending')
    }
  }

  /**
   * Read what the permission rules need before any request can arrive: config
   * `session.auto_approve_bypass`, and Walnut's op registry (the ops load
   * lazily, and walnutOpAnswered reads their read-only tags).
   */
  private async readPermissionPolicy(): Promise<void> {
    try {
      const { getConfig } = await import('../core/config-manager.js')
      this._autoApproveBypass = (await getConfig()).session?.auto_approve_bypass !== false
    } catch { /* unreadable config keeps the default (on) */ }
    await import('../ops/index.js').catch(() => { /* no registry: only the fixed write list is answered */ })
  }

  /** The Walnut mode moved (session-lifecycle.ts): the posture follows, and the
   *  adapter's own preset with it when it advertises one for that posture. */
  /**
   * The Walnut mode moved (session-lifecycle.ts): the posture follows, and the
   * adapter's own preset with it. A restrictive mode must take the adapter off
   * any full-access preset: when the adapter refuses, the change fails with
   * AcpModeRefusedError, and Walnut answers nothing for the session meanwhile
   * (its preset choice is cleared, so the restrictive Walnut mode rules).
   */
  async applyWalnutMode(mode: SessionMode): Promise<void> {
    this._mode = mode
    const control = this._configOptions.find((c) => c.id === 'mode')
    const values = control?.options.map((o) => o.value) ?? []
    if (mode === 'bypass') {
      // The newest choice rules: a bypass mode set now outranks an asking preset picked before.
      this._chosenMode = undefined
      const target = values.find((v) => ACP_FULL_ACCESS_MODE_VALUES.has(v))
      if (control && target && target !== control.currentValue && !await this.setConfigOption('mode', target).catch(() => false)) {
        log.session.warn('acp: adapter kept its preset under a bypass mode; Walnut answers its requests', { sessionId: this.trackingId(), target })
      }
    } else {
      const live = control?.currentValue
      const wasFull = (live !== undefined && ACP_FULL_ACCESS_MODE_VALUES.has(live))
        || (this._chosenMode !== undefined && ACP_FULL_ACCESS_MODE_VALUES.has(this._chosenMode))
      if (wasFull) {
        const target = ACP_ASKING_MODE_VALUES.find((v) => values.includes(v))
        const moved = target ? await this.setConfigOption('mode', target).catch(() => false) : false
        if (!moved) {
          await this.forgetChosenMode()
          await this.autoAllowPending()
          throw new AcpModeRefusedError(engineCaps(this.engineId).displayName, mode, live ?? this._chosenMode ?? 'full access')
        }
      }
    }
    await this.autoAllowPending()
  }

  /** Drop the session's adapter preset choice (in memory and on its record): its Walnut mode rules. */
  private async forgetChosenMode(): Promise<void> {
    this._chosenMode = undefined
    const record = await getSessionByClaudeId(this.trackingId()).catch(() => undefined)
    if (record?.acpConfig?.mode === undefined) return
    const { mode: _dropped, ...rest } = record.acpConfig
    await updateSessionRecord(this.trackingId(), { acpConfig: rest }).catch(() => {})
  }

  /** The preset Walnut started the adapter in: the start persists it as acpConfig.mode,
   *  so a respawn runs on it instead of re-reading the engine's config file. */
  get startAgentMode(): string | undefined { return this._startAgentMode }

  private persistPendingPermission(forceClear = false): void {
    const sessionId = this.trackingId()
    const pending = forceClear
      ? undefined
      : [...this._pendingPermissions.values()].filter((p) => !this.autoAnswerOf(p))
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
    // Both mounts are commands of this machine's install. A session on another host
    // reaches Walnut through the `walnut` CLI its daemon puts on PATH instead.
    if (this.remote) return []
    return withWalnutApiEnv(await this.resolveMcpServerSet(), walnutApiEnvForSession(this.host))
  }

  private async resolveMcpServerSet(): Promise<AcpMcpServer[]> {
    let session: { acp_walnut_mcp?: boolean; acp_walnut_tools?: unknown } | undefined
    try {
      const { getConfig } = await import('../core/config-manager.js')
      // Read structurally: both fields are optional and additive in Config.
      session = (await getConfig()).session as typeof session
    } catch (error) {
      log.session.debug('acp: MCP mount config unreadable', {
        runtimeId: this.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const toolSet = (servers: AcpMcpServer[]): AcpMcpServer[] =>
      walnutMcpToolSet(this.engineId, session) === 'core' ? servers.map(withCoreWalnutTools) : servers
    if (this.cfg.walnutMcpServer) {
      if (this.engineId === 'pi') throw new Error('Pi does not support MCP mounts; use the walnut CLI instead.')
      return toolSet([{
        ...this.cfg.walnutMcpServer,
        args: [...this.cfg.walnutMcpServer.args],
        env: this.cfg.walnutMcpServer.env.map((entry) => ({ ...entry })),
      }])
    }
    // An unreadable config means no mounts, never a failed start.
    const servers = resolveWalnutMcpServers(session)
    if (this.engineId === 'pi' && servers.length > 0) {
      log.session.warn('Pi does not support MCP mounts; the walnut CLI remains available', { runtimeId: this.runtimeId })
      return []
    }
    return toolSet(servers)
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
   *
   * On top of that, EVERY engine merges the operator's `engines.<id>.env`
   * config (credentials wiring: AWS_PROFILE for a Bedrock-backed goose,
   * GEMINI_API_KEY, …). Walnut's own managed keys win over the overlay, and a
   * YAML `null` value means "unset this inherited variable" — the daemon's
   * spawn site deletes empty-string entries instead of setting them, because a
   * stale AWS_BEARER_TOKEN_BEDROCK inherited from the server's own env
   * otherwise outranks the profile the operator configured (real failure:
   * goose sent a bearer Authorization header → IncompleteSignatureException).
   */
  private async buildAdapterEnv(
    providerExecutable: string | undefined,
    config?: { overlay?: Record<string, string> },
  ): Promise<Record<string, string> | undefined> {
    const overlay = config ? config.overlay : await this.resolveConfiguredEngineEnv()
    if (this.engineId !== 'codex') {
      const managed = buildAcpAdapterEnv(undefined, { sessionId: this.runtimeId, walnutApiEnv: walnutApiEnvForSession(this.host) })
      const provider = this.engineId === 'pi' && providerExecutable
        ? { PI_ACP_PI_COMMAND: providerExecutable }
        : undefined
      // session.tag_requests: an engine on the Anthropic SDK (dsh, say) reads ANTHROPIC_CUSTOM_HEADERS,
      // so the task's tag rides its requests beside any headers the engine's env sets.
      // A null there is '' in the overlay (engineEnvOverlayFromConfig): none of the server's lines.
      const ownHeaders = overlay?.ANTHROPIC_CUSTOM_HEADERS ?? (this.remote ? undefined : process.env.ANTHROPIC_CUSTOM_HEADERS)
      const tagged = requestTagOn(await (await import('./codex-engine-source.js')).codexWalnutConfig().catch(() => ({})))
        ? { ANTHROPIC_CUSTOM_HEADERS: withRequestTagHeaders(ownHeaders, requestTagValue(this.taskId)) }
        : undefined
      return { ...(overlay ?? {}), ...(provider ?? {}), ...(managed ?? {}), ...(tagged ?? {}) }
    }
    const record = await getSessionByClaudeId(this.trackingId()).catch(() => undefined)
    // engines.codex (provider, default model and effort) merged under the user's own
    // CODEX_CONFIG, the same for a start here and on another host (codex-engine-config.ts).
    // Off the Mac the Mac's copy says what was set, and a server that cannot tell refuses
    // (codex-engine-source.ts): never the host's own provider by default.
    const walnutConfig = await (await import('./codex-engine-source.js')).codexWalnutConfig()
    const pick = record?.acpConfig ?? this.cfg.acpConfig
    const codex = resolveCodexEngine(
      walnutConfig,
      overlay && Object.hasOwn(overlay, 'CODEX_CONFIG') ? overlay.CODEX_CONFIG : (this.remote ? undefined : process.env.CODEX_CONFIG),
      {
        pick: pick ? { model: pick.model, reasoning_effort: pick.reasoning_effort } : undefined,
        // session.tag_requests (sessions/request-tag.ts): this task's id on every request.
        ...(requestTagOn(walnutConfig) ? { tag: requestTagValue(this.taskId) } : {}),
      },
    )
    // Startup approval preset (acp-permission-posture.ts resolveCodexStartPreset): the
    // session's OWN persisted choice wins (it is replayed post-establish by
    // replayPersistedConfig), then the mode the start named, then the user's own
    // ~/.codex/config.toml or walnut config.yaml session.codex_default_mode, which
    // apply only to a start that named no mode, then Walnut's mode (bypass for a
    // start with none, as a Claude Code session of the task runs).
    const persistedMode = record?.acpConfig?.mode ?? this.cfg.acpConfig?.mode
    if (persistedMode) this._chosenMode = persistedMode
    const configured = persistedMode || this.cfg.modeNamed ? undefined : resolveCodexInitialMode({
      walnutDefault: (walnutConfig as { session?: { codex_default_mode?: string } } | undefined)?.session?.codex_default_mode,
      // ~/.codex/config.toml of THIS machine says nothing about another host's codex.
      ...(this.remote ? { env: {} } : {}),
    })
    const start = resolveCodexStartPreset({ persisted: persistedMode, modeNamed: this.cfg.modeNamed === true, walnutMode: this._mode, configured })
    this._mode = start.walnutMode
    const initialAgentMode = start.preset
    this._startAgentMode = persistedMode ? undefined : start.preset
    // Non-lane codex sessions get the same walnut context every native claude
    // session gets (walnut gateway + skill pointer); lanes get the self-knowledge
    // contract instead (they ARE the personal AI — the hint would be circular).
    let defaultInstructions: string | undefined
    if (this.cfg.lane) {
      defaultInstructions = renderSelfKnowledgeContract()
    } else {
      try {
        const { buildSessionContext } = await import('../core/sessions/session-context.js')
        defaultInstructions = (await buildSessionContext(this.taskId, this.cfg.cwd, this.remote ? this.host : undefined)).systemPrompt || undefined
      } catch { /* context is additive — never block establish */ }
    }
    const managed = buildAcpAdapterEnv(providerExecutable, {
      disableProjectInstructions: this.cfg.disableProjectInstructions,
      developerInstructions: this.cfg.developerInstructions ?? defaultInstructions,
      baseConfig: codex.baseConfig,
      sessionId: this.runtimeId,
      initialAgentMode,
      walnutApiEnv: walnutApiEnvForSession(this.host),
      codexModelPrefix: codex.prefix,
    })
    if (!overlay) return managed
    return { ...overlay, ...(managed ?? {}) }
  }

  /**
   * Codex takes Walnut's session context as developer instructions at spawn
   * (buildAdapterEnv). Every other ACP engine has no instructions channel, so a
   * task session there used to run with no Walnut prompt at all: a Main or a lead
   * on OpenCode or Goose did not know its role, the charter or its task directory.
   * Their first prompt carries it instead, the one carrier every engine has (as
   * an ask's persona does, ask-profile-prefix.ts). A lane is the Personal AI and
   * gets its persona that way already.
   */
  private contextRidesFirstPrompt(): boolean {
    return this.engineId !== 'codex' && !this.cfg.lane && !!this.taskId
  }

  /**
   * The session context as one Walnut hint block (hints/hint-format.ts), so every
   * display takes it off the person's bubble by structure and lists it under the
   * message instead. '' when there is none to send; never throws.
   */
  private async sessionContextPrefix(): Promise<string> {
    let context = this.cfg.developerInstructions?.trim() ?? ''
    if (!context) {
      try {
        const { buildSessionContext } = await import('../core/sessions/session-context.js')
        context = (await buildSessionContext(this.taskId, this.cfg.cwd, this.remote ? this.host : undefined)).systemPrompt?.trim() ?? ''
      } catch (error) {
        log.session.warn('acp: session context unavailable for the first prompt', {
          runtimeId: this.runtimeId, engine: this.engineId, error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return context ? renderHintBlock(SESSION_CONTEXT_HINT_KIND, `${SESSION_CONTEXT_LEAD}\n\n${context}`) : ''
  }

  /** Operator env overlay from `engines.<id>.env` (see engineEnvOverlayFromConfig). */
  private async resolveConfiguredEngineEnv(): Promise<Record<string, string> | undefined> {
    try {
      const { getConfig } = await import('../core/config-manager.js')
      return engineEnvOverlayFromConfig(await getConfig(), this.engineId)
    } catch {
      // Unreadable config = no overlay; the engine still launches with the
      // inherited env (same degradation as resolveConfiguredAdapterCmd).
      return undefined
    }
  }

  private async resolveArtifacts(): Promise<{ workerCmd: string[]; adapterCmd: string[] } | { hostAdapter: AcpHostAdapterSpec }> {
    if (this.cfg.artifacts) return this.cfg.artifacts
    if (this.remote) {
      // The host's daemon builds both commands from what that host has (acp-host-artifacts.ts).
      const spec = hostAdapterSpec(this.engineId)
      if (!spec) throw new Error(`${engineCaps(this.engineId).displayName} runs on this machine only: its adapter command is this machine's config`)
      return { hostAdapter: spec }
    }
    const artifacts = resolveAcpArtifacts(this.engineId, {
      configuredAdapterCmd: await this.resolveConfiguredAdapterCmd(),
    })
    // Without Bun, build-daemon.sh skips the worker bundle (Claude sessions never need
    // it). Fail here, before the daemon spawns a path that does not exist, and name the fix.
    if (!fsModule.existsSync(artifacts.workerCmd[1])) {
      throw new Error(
        `Engine '${this.engineId}' runs on the ACP worker, which is not built (${artifacts.workerCmd[1]}). `
        + 'Install Bun (https://bun.sh) and run `bun run build:daemon`, or install the released Walnut, which ships it.',
      )
    }
    return artifacts
  }

  private async establishProviderSession(): Promise<string> {
    const threadBefore = this._providerSessionId
    this._coldLoaded = false
    // Where a start's time goes, logged once it is established (a start that fails says why elsewhere).
    let last = Date.now()
    const begun = last
    const stages: Record<string, number> = {}
    const stage = (name: string): void => { const now = Date.now(); stages[name] = now - last; last = now }
    await this.seedReplayCursor()
    stage('cursorMs')
    let artifacts = await this.resolveArtifacts()
    stage('artifactsMs')
    // Fail closed BEFORE touching the daemon: a missing provider executable is
    // a configuration error, not a transport one. 'cli' engines already got
    // this check inside resolveArtifacts; codex needs its own because the path
    // travels as adapter env (CODEX_PATH), not as argv.
    // Production always passes a validated system Codex path — omitting
    // CODEX_PATH would make codex-acp silently use its bundled dependency.
    // Tests that inject a mock adapter do not need a Codex executable.
    // On another host the daemon finds the engine's CLI there and sets CODEX_PATH itself.
    const overlay = await this.resolveConfiguredEngineEnv()
    const providerExecutable = !this.cfg.artifacts && !this.remote && engineCaps(this.engineId).acpAdapter?.source === 'bundled'
      ? resolveEngineExecutable({ engine: this.engineId, cwd: this.cfg.cwd, env: mergeAcpSpawnEnv(process.env, overlay) })
      : undefined
    // pi's adapter runs on the Node that runs pi, not on a second boot of this file (pi-adapter-node.ts).
    if (this.engineId === 'pi' && providerExecutable && 'adapterCmd' in artifacts) {
      const node = await piNodeFor(providerExecutable, mergeAcpSpawnEnv(process.env, overlay))
      if (node) artifacts = { ...artifacts, adapterCmd: [node, ...artifacts.adapterCmd.slice(1)] }
    }
    stage('engineEnvMs')

    // Concurrent with ensureConn: the mount list is a small config read and must
    // not add serial latency to the cold-resume path, which is already the
    // slowest thing walnut does (worker spawn + provider initialize + load).
    const [mcpServers, conn] = await Promise.all([
      this.resolveMcpServers(),
      this.ensureConn(),
    ])
    stage('mountsMs')
    if ('hostAdapter' in artifacts && !conn.hasCapability('acp-host-v1')) {
      throw new Error(`${engineCaps(this.engineId).displayName} cannot run on ${this.host}: its daemon does not run ACP engines (it is older than this Walnut, or runs without bun)`)
    }
    // A test server's copied records name production's ACP workers, and an ACP start
    // cannot check who owns a worker yet: on a shared host it would attach to (or load
    // a second process on) production's thread. Only an isolated daemon there is safe.
    if (this.remote && conn.readOnlyRemote) {
      throw new Error(`${engineCaps(this.engineId).displayName} on ${this.host} is not started from a test server: that host's daemon is shared with the real Walnut`)
    }
    await this.readPermissionPolicy()
    const adapterEnv = await this.buildAdapterEnv(providerExecutable, { overlay })
    stage('adapterEnvMs')
    // Adapters that answer `loadSession: false` (gemini) can NEVER resume a
    // provider thread: acpStart would run session/load, get load_failed, and
    // fall back to a fresh session on EVERY worker respawn. Pre-empt that round
    // trip and take the fresh-session path directly, announcing the identity
    // boundary exactly like the load_failed handler below does. A warm worker
    // ignores providerSessionId entirely, so this is a no-op when nothing died.
    const preemptFreshSession = Boolean(this._providerSessionId)
      && this._capabilities?.loadSession === false
      && this._capabilities?.resumeSession !== true
    const boundaryFrom = preemptFreshSession ? this.trackingId() : undefined
    if (preemptFreshSession) {
      log.session.info('acp: adapter cannot load sessions — starting a fresh provider thread', {
        sessionId: boundaryFrom, runtimeId: this.runtimeId, engine: this.engineId,
      })
    }
    const startResp = await conn.send('acpStart', {
      sid: this.runtimeId,
      cwd: this.cfg.cwd,
      ...artifacts,
      // The runtime tree named here is this machine's; another host runs its own files.
      env: this.remote ? hostAdapterEnv(adapterEnv) : acpStartEnv(adapterEnv),
      providerSessionId: preemptFreshSession ? undefined : (this._providerSessionId ?? undefined),
      fromOffset: this._seenV,
      mcpServers,
      // The daemon makes the task's durable working directory and sets
      // WALNUT_TASK_DIR from it (task-dir-core.ts); an older daemon ignores it.
      ...(this.taskId ? { taskId: this.taskId, home: WALNUT_HOME } : {}),
    }, ACP_COLD_RESUME_TIMEOUT_MS)
    stage('startMs')
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
          // The transcript says the thread changed: the journal's session-created
          // after another thread is projected as a notice (acp-journal-projector.ts).
          await this.publishSessionResponse((fresh as { result?: unknown }).result)
        } else if ((startResp as { errorKind?: string }).errorKind === 'budget_paused') {
          throw new BudgetPausedError()
        } else if ((startResp as { errorKind?: string }).errorKind === 'budget_checking') {
          throw new BudgetCheckingError()
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
        // A new worker that loaded the thread (not a warm attach, not a fresh one).
        this._coldLoaded = !result.alive && !!threadBefore && !preemptFreshSession
        const state = result.state as WorkerStateSnapshot | undefined
        if (state?.capabilities) this._capabilities = state.capabilities
        if (result.session) await this.publishSessionResponse(result.session)
        if (state) await this.adoptStateSnapshot(state)
        // Pre-empted resume: the worker minted a new provider thread; the
        // transcript says so from the journal (acp-journal-projector.ts).
      }
    } catch (error) {
      await this.discardUnpublishedWorker()
      throw error
    }
    if (!this._providerSessionId) {
      throw new Error('ACP session established without a provider session ID')
    }
    await this.replayPersistedConfig(conn)
    await this.applyStartPosture(conn)
    if (this._coldLoaded) {
      this._coldLoaded = false
      await this.followEngineDefaultModel(conn)
    }
    this.persistPendingPermission()
    await this.autoAllowPending()
    stage('afterMs')
    log.session.info('acp: session established', {
      sessionId: this._providerSessionId, runtimeId: this.runtimeId, engine: this.engineId, host: this.host,
      warm: (startResp as { alive?: boolean }).alive === true, totalMs: Date.now() - begun, ...stages,
      ...((startResp as { timings?: Record<string, number> }).timings ?? {}),
    })
    // A new thread (the first one, or a fresh one after a load failure) has never
    // read the session context; a loaded or warm one has, once any prompt of it was
    // accepted. The record's count is the durable half: a server restart, or the
    // attach path's new instance, between establish and the first prompt still owes it.
    if (this.contextRidesFirstPrompt()) {
      const neverPrompted = this._providerSessionId === threadBefore
        && (await getSessionByClaudeId(this.trackingId()).catch(() => undefined))?.messageCount === 0
      if (this._providerSessionId !== threadBefore || neverPrompted) this._contextOwed = true
    }
    this._active = true
    return this._providerSessionId
  }

  /**
   * A loaded thread keeps the model it was made with: OpenCode stores it per
   * session, so a lane made before the user changed their default model ran on
   * the old one after every restart (2026-10-30: ollama/qwen3:8b after the user
   * moved to qwen3-coder:30b). Unless someone picked a model for this session
   * (acpConfig.model), a cold load moves it to the engine's current default:
   * the model a new session gets, read from a catalog probe at most a minute old
   * (the cache keeps one for 10 minutes, which may predate the user's change).
   * The probe is bounded so a slow engine never holds the send; a miss leaves
   * the model as it was.
   */
  private async followEngineDefaultModel(conn: DaemonConnection): Promise<void> {
    const record = await getSessionByClaudeId(this.trackingId()).catch(() => undefined)
    if ((record?.acpConfig ?? this.cfg.acpConfig)?.model !== undefined) return
    const current = this._models.currentModelId
    const control = this._configOptions.find((c) => c.id === 'model')
    if (!current || !control) return
    let wanted: string | undefined
    try {
      const { getEngineModelCatalog } = await import('./engine-model-probe.js')
      const catalog = await Promise.race([
        getEngineModelCatalog(this.engineId, { cwd: this.cfg.cwd, maxAgeMs: FOLLOW_DEFAULT_MODEL_CACHE_MS }),
        new Promise<undefined>((resolve) => { (setTimeout(resolve, FOLLOW_DEFAULT_MODEL_WAIT_MS) as { unref?: () => void }).unref?.() }),
      ])
      wanted = catalog?.currentModelId
    } catch { return }
    if (!wanted || wanted === current) return
    const { base } = splitAcpModelId(wanted)
    if (base === splitAcpModelId(current).base || !control.options.some((o) => o.value === base)) return
    const resp = await conn.send('acpSetConfigOption', {
      sid: this.runtimeId,
      commandId: `acp-default-model-${crypto.randomBytes(8).toString('hex')}`,
      configId: 'model',
      value: base,
    }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    if (!resp.ok) {
      log.session.warn('acp: could not move a loaded session to the default model', {
        sessionId: this.trackingId(), from: current, to: base, error: (resp as { error?: string }).error,
      })
      return
    }
    const result = (resp as { result?: { configOptions?: AcpConfigOption[]; models?: AcpModelCatalog } }).result
    this._configOptions = result?.configOptions ?? this._configOptions.map((c) => (c.id === 'model' ? { ...c, currentValue: base } : c))
    this._models = result?.models ?? { ...this._models, currentModelId: base }
    const now = this._models.currentModelId ?? base
    await updateSessionRecord(this.trackingId(), { acpModel: now, ...this.acpModelNamePatch(now) }).catch(() => {})
    log.session.info('acp: loaded session moved to the engine default model', {
      sessionId: this.trackingId(), engine: this.engineId, from: current, to: now,
    })
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
  /**
   * A Codex session's stored pick, as its thread was started on it: with
   * `engines.codex.provider` the pick rode the thread config with the provider's
   * model prefix (codex-engine-config.ts), so replaying the bare id would switch
   * the session onto the id the endpoint gives no tools.
   */
  private async codexPickAsStarted(stored: Record<string, string>): Promise<Record<string, string>> {
    if (this.engineId !== 'codex' || !stored.model) return stored
    try {
      const walnutConfig = await (await import('./codex-engine-source.js')).codexWalnutConfig()
      const { settings } = resolveCodexEngine(walnutConfig, codexRawConfig(walnutConfig, this.remote))
      const pick = codexPickForProvider({ model: stored.model, reasoning_effort: stored.reasoning_effort }, settings)
      if (!pick?.model) return stored
      return { ...stored, model: pick.model, ...(pick.reasoning_effort ? { reasoning_effort: pick.reasoning_effort } : {}) }
    } catch {
      return stored
    }
  }

  /**
   * Put the adapter in the posture of the session's Walnut mode when nothing chose
   * its preset yet (acp-permission-posture.ts): a bypass session whose adapter
   * advertises a full-access preset (gemini's yolo, codex-acp's agent-full-access
   * when it did not take INITIAL_AGENT_MODE) is switched to it, so the provider
   * itself stops asking. Raw RPC, as replayPersistedConfig (setConfigOption here
   * would wait on _establishing).
   */
  private async applyStartPosture(conn: DaemonConnection): Promise<void> {
    const control = this._configOptions.find((c) => c.id === 'mode')
    if (!control) return
    if (!acpSupposedFullAccess({ walnutMode: this._mode, chosenMode: this._chosenMode })) {
      // Only a mode someone chose (named at the start, kept on the record, or the
      // adapter's preset picked) may fail a start; any other restrictive mode is
      // tried and, refused, left as the adapter runs.
      await this.leaveFullAccess(conn, control, this.cfg.modeNamed === true || this._chosenMode !== undefined)
      return
    }
    if (this._chosenMode) return
    if (ACP_FULL_ACCESS_MODE_VALUES.has(control.currentValue)) {
      this._startAgentMode ??= control.currentValue
      return
    }
    const target = control.options.find((o) => ACP_FULL_ACCESS_MODE_VALUES.has(o.value))?.value
    if (!target) return
    const resp = await conn.send('acpSetConfigOption', {
      sid: this.runtimeId,
      commandId: `acp-config-posture-${crypto.randomBytes(8).toString('hex')}`,
      configId: 'mode',
      value: target,
    }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    if (!resp.ok) {
      log.session.warn('acp: adapter preset for the bypass posture refused; Walnut answers its requests', {
        runtimeId: this.runtimeId, engine: this.engineId, target, error: (resp as { error?: string }).error,
      })
      return
    }
    const result = (resp as { result?: { configOptions?: AcpConfigOption[] } }).result
    this._configOptions = result?.configOptions ?? this._configOptions.map((c) =>
      c.id === 'mode' ? { ...c, currentValue: target } : c)
    this._startAgentMode = target
    log.session.info('acp: adapter preset set for the bypass posture', { runtimeId: this.runtimeId, engine: this.engineId, value: target })
  }

  /**
   * A session whose mode is restrictive never runs on a full-access preset (an
   * adapter that took one from its own config, a replay that did not land): it
   * is moved to the adapter's asking preset, or, when someone chose that mode
   * (`chosen`), the worker is stopped and the start fails with AcpModeRefusedError.
   */
  private async leaveFullAccess(conn: DaemonConnection, control: AcpConfigOption, chosen: boolean): Promise<void> {
    if (!ACP_FULL_ACCESS_MODE_VALUES.has(control.currentValue)) return
    const live = control.currentValue
    const target = ACP_ASKING_MODE_VALUES.find((v) => control.options.some((o) => o.value === v))
    const resp = target
      ? await conn.send('acpSetConfigOption', {
        sid: this.runtimeId,
        commandId: `acp-config-posture-${crypto.randomBytes(8).toString('hex')}`,
        configId: 'mode',
        value: target,
      }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      : { ok: false, error: 'no asking preset advertised' }
    if ((!resp.ok || !target) && !chosen) {
      log.session.warn('acp: adapter kept full access under a mode nobody chose; it runs as it is', {
        runtimeId: this.runtimeId, engine: this.engineId, mode: this._mode, live, error: (resp as { error?: string }).error,
      })
      return
    }
    if (!resp.ok || !target) {
      log.session.error('acp: adapter refused to leave full access under a restrictive mode; stopping it', {
        runtimeId: this.runtimeId, engine: this.engineId, mode: this._mode, live, error: (resp as { error?: string }).error,
      })
      await this.discardUnpublishedWorker()
      throw new AcpModeRefusedError(engineCaps(this.engineId).displayName, this._mode, live)
    }
    const result = (resp as { result?: { configOptions?: AcpConfigOption[] } }).result
    this._configOptions = result?.configOptions ?? this._configOptions.map((c) =>
      c.id === 'mode' ? { ...c, currentValue: target } : c)
    if (!this._chosenMode) this._startAgentMode = target
    log.session.info('acp: adapter moved off full access for a restrictive mode', { runtimeId: this.runtimeId, engine: this.engineId, from: live, to: target })
  }

  private async replayPersistedConfig(conn: DaemonConnection): Promise<void> {
    const record = await getSessionByClaudeId(this.trackingId()).catch(() => undefined)
    const stored = record?.acpConfig ?? this.cfg.acpConfig
    if (stored?.mode) this._chosenMode = stored.mode
    if (!stored || this._configOptions.length === 0) return
    const wanted = await this.codexPickAsStarted(stored)
    let modelReplayed = false
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
        const result = (resp as { result?: { configOptions?: AcpConfigOption[]; models?: AcpModelCatalog } }).result
        this._configOptions = result?.configOptions ?? this._configOptions.map((c) =>
          c.id === configId ? { ...c, currentValue: value } : c)
        this._models = result?.models ?? (configId === 'model' ? { ...this._models, currentModelId: value } : this._models)
        if (configId === 'model' || configId === 'reasoning_effort') {
          modelReplayed = Boolean(result?.models?.currentModelId)
        }
        log.session.info('acp: replayed persisted config after worker spawn', {
          runtimeId: this.runtimeId, configId, value,
        })
        // Pending permissions adopted from the worker snapshot predate this
        // replay — under restored full access they must not wait for a click.
        if (configId === 'mode') await this.autoAllowPending()
      } else {
        log.session.warn('acp: config replay failed', {
          runtimeId: this.runtimeId, configId, value,
          error: (resp as { error?: string }).error,
        })
      }
    }
    if (modelReplayed && this._models.currentModelId) {
      await updateSessionRecord(this.trackingId(), {
        acpModel: this._models.currentModelId,
        ...this.acpModelNamePatch(this._models.currentModelId),
      }).catch(() => {})
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
    this._controlEpoch++
    // Except the short status question an engine takes at every turn end (statusQuestion):
    // it is let finish, for a few seconds at most, because the abort kills the worker and
    // the user's own message would pay a cold start (2026-11-02, pi).
    const asking = this._selfReport
    if (asking && engineCaps(this.engineId).statusQuestion) {
      let wait: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        asking.promise.then(() => {}, () => {}),
        new Promise<void>((resolve) => { wait = setTimeout(resolve, STATUS_QUESTION_FINISH_MS) }),
      ])
      clearTimeout(wait)
    }
    await this.cancelSelfReport('self-report superseded by user prompt')
    // A status question that ran out of time may still be stopping the worker: a prompt sent
    // into it now would be accepted and then lost with the process group.
    if (this._controlCancel) await this._controlCancel.catch(() => {})
    await this.establish()
    const conn = await this.ensureConn()

    const commandId = `acp-prompt:${walnutMessageId}`
    const owed = this._contextOwed
    const prefix = owed ? await this.sessionContextPrefix() : ''
    const cut = this._controlCut || (await getSessionByClaudeId(this.trackingId()).catch(() => undefined))?.acpControlCut === true
    const lead = [prefix, cut ? renderHintBlock(CONTROL_CUT_HINT_KIND, CONTROL_CUT_NOTE) : ''].filter(Boolean).join('\n\n')
    const sendResp = await conn.send('acpSend', {
      sid: this.runtimeId,
      commandId,
      walnutMessageId,
      text: lead ? `${lead}\n\n${message}` : message,
      ...this.budgetTarget(),
    })
    if (!sendResp.ok) {
      const kind = (sendResp as { errorKind?: string }).errorKind
      if (kind === 'budget_paused') throw new BudgetPausedError()
      if (kind === 'budget_checking') throw new BudgetCheckingError()
      if (kind === 'no_worker') {
        // Worker died between start and send (or idle-reaped): one lazy-resume retry.
        this._active = false
        log.session.info('acp: worker gone on send — lazy resume retry', { runtimeId: this.runtimeId })
        return this.sendAccepted(message, walnutMessageId)
      }
      throw new Error('acpSend failed: ' + sendResp.error)
    }
    if (owed) this._contextOwed = false
    if (cut) {
      this._controlCut = false
      void updateSessionRecord(this.trackingId(), { acpControlCut: undefined } as Partial<SessionRecord>).catch(() => {})
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
      ...this.budgetTarget(),
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
          ...(this.remote ? { host: this.host } : {}),
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
      const pending: PendingPermission = {
        requestId: p.providerRequestId,
        toolName,
        input,
        options,
        receivedAt: p.receivedAt,
        ...(typeof toolCall?.kind === 'string' ? { kind: toolCall.kind } : {}),
        ...(typeof toolCall?.title === 'string' ? { title: toolCall.title } : {}),
        ...this.permissionMeta(p.meta && typeof p.meta === 'object' ? p.meta as Record<string, unknown> : undefined),
      }
      this._pendingPermissions.set(p.providerRequestId, pending)
      // What Walnut answers itself is answered, not shown (acp-permission-posture.ts).
      const auto = this.autoAnswerOf(pending)
      if (auto) {
        this._emittedPermissionRequestIds.add(p.providerRequestId)
        void this.autoAllow(p.providerRequestId, auto, 'adopted')
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
    if (!configId) return false
    await this.establish()
    const conn = await this.ensureConn()
    const resp = await conn.send('acpSetConfigOption', {
      sid: this.runtimeId,
      commandId: `acp-config-${crypto.randomBytes(8).toString('hex')}`,
      configId,
      value,
    })
    if (!resp.ok) return false
    const result = resp.result as { configOptions?: AcpConfigOption[]; models?: AcpModelCatalog } | undefined
    this._configOptions = result?.configOptions ?? this._configOptions.map((control) =>
      control.id === configId ? { ...control, currentValue: value } : control)
    this._models = result?.models ?? (configId === 'model' ? { ...this._models, currentModelId: value } : this._models)
    const record = await getSessionByClaudeId(this.trackingId())
    await updateSessionRecord(this.trackingId(), {
      ...(this._models.currentModelId
        ? { acpModel: this._models.currentModelId, ...this.acpModelNamePatch(this._models.currentModelId) }
        : {}),
      acpConfig: { ...(record?.acpConfig ?? this.cfg.acpConfig ?? {}), [configId]: value },
    })
    // Codex applies approvalPolicy per-turn (adapter passes it to runTurn), so
    // switching to full access mid-turn cannot unblock approvals codex already
    // asked for — they'd dangle until the turn dies. Match the user's intent:
    // "full access" means stop asking, so answer anything pending with allow.
    if (configId === 'mode') {
      this._chosenMode = value
      await this.autoAllowPending()
    }
    return true
  }

  /** Switch the model for the next Codex turn through standard ACP config.
   *  Catalog ids are effort-qualified ("base[effort]") but the adapter's
   *  model config option only accepts the BASE id (applyModelChange matches
   *  availableModels by base id and throws invalidParams otherwise) — split
   *  and apply model + reasoning_effort as two config ops. */
  async setModel(modelId: string): Promise<boolean> {
    const { base: asked, effort } = splitAcpModelId(modelId)
    let base = asked
    // engines.codex.provider.model_prefix: the endpoint's id is not in codex's own list,
    // and the bare one it lists starts turns with no tools there, so neither is switched to.
    if (this.engineId === 'codex' && base) {
      const asStarted = splitAcpModelId((await this.codexPickAsStarted({ model: base })).model ?? base).base
      if (asStarted !== base && !this._configOptions.find((c) => c.id === 'model')?.options.some((o) => o.value === asStarted)) {
        log.session.warn('acp: model not switched: this endpoint needs an id codex does not list; a new session starts on it', {
          sessionId: this.trackingId(), modelId, endpointId: asStarted,
        })
        return false
      }
      base = asStarted
    }
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
      // select one implicitly (reference study 2026-08-12; one ACP client has this
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
    this._controlEpoch++
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
    // One at a time, each for its own answer: joining the question already in flight
    // handed a title request the turn-end report's text (and a diff caption the title's).
    // The deadline counts the wait: a question that cannot start in time leaves the queue.
    const deadline = Date.now() + Math.max(1, timeoutMs)
    const epoch = this._controlEpoch
    const before = this._controlTail
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    this._controlTail = before.then(() => mine)
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const reached = await Promise.race([
        before.then(() => true),
        new Promise<boolean>((resolve) => { waitTimer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())) }),
      ])
      if (!reached) throw new Error(`self-report timed out after ${timeoutMs}ms waiting for an earlier one`)
      if (epoch !== this._controlEpoch) throw new Error('self-report superseded')
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`self-report timed out after ${timeoutMs}ms waiting for an earlier one`)
      return await this.runControlPrompt(prompt, left, epoch)
    } finally {
      clearTimeout(waitTimer)
      // A question that timed out is still being cancelled: the next one waits for that.
      if (this._controlCancel) await this._controlCancel.catch(() => {})
      release()
    }
  }

  private async runControlPrompt(prompt: string, timeoutMs: number, epoch: number): Promise<string> {
    await this.establish()
    if (this._turnActive) throw new Error('cannot request ACP self-report during an active user turn')

    const conn = await this.ensureConn()
    // A user prompt, a stop or an abort while this one was starting: never send it after them.
    if (epoch !== this._controlEpoch) throw new Error('self-report superseded')
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
      this._controlCancel = this.cancelSelfReport(`self-report timed out after ${timeoutMs}ms`)
      void this._controlCancel.catch((error) => {
        log.session.warn('acp: timed-out self-report abort failed', {
          sessionId: this.trackingId(),
          runtimeId: this.runtimeId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, Math.max(1, timeoutMs))
    this._selfReport = {
      commandId,
      started: false,
      toolRefused: false,
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
        text: `${CONTROL_PROMPT_GUARD}\n\n${prompt}`,
        ...this.budgetTarget(),
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

  async restart(): Promise<string> {
    if (this._establishing) await this._establishing
    // acpCancel confirms process-group exit; acpStop only acknowledges shutdown intent.
    await this.abortTurn()
    await this._cursorCommit
    return this.establish()
  }

  /** Graceful stop: shut the worker down (journal meta → adapter teardown). */
  async gracefulStop(): Promise<void> {
    this._controlEpoch++
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
    this._controlEpoch++
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
    const limitText = isError ? this._turnLimitText : null
    this._turnLimitText = null

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
        // The usage limit's own words, so the session says why it stopped (sessions/usage-limit-wait.ts).
        ...(limitText ? { errorMessage: limitText } : {}),
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
      // Before its own acceptance a control frame is an earlier question's straggler
      // (OpenCode flushes the last chunks after the prompt call returns).
      if (!pending.started) return
      const text = controlFrameText(record.frame)
      if (text) pending.chunks.push(text)
      return
    }
    if (record.kind === 'meta' && record.event.type === 'control-prompt-accepted' && record.event.commandId === pending.commandId) {
      pending.started = true
      return
    }
    if (record.kind === 'meta' && record.event.type === 'control-tool-refused' && record.event.commandId === pending.commandId) {
      pending.toolRefused = true
      log.session.warn('acp: the model started a tool during a status question; the question was ended', {
        sessionId: this.trackingId(), runtimeId: this.runtimeId, tool: record.event.title,
        textSoFar: pending.chunks.join('').length,
      })
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
    } else if (pending.toolRefused || record.event.stopReason === 'tool-refused') {
      // What came before the tool may be an opener ("I'll write it to a file"), never a
      // title or a caption: only a caller that parses the text may take it (partialText).
      this.settleSelfReport(pending.commandId, new ControlToolRefusedError(pending.chunks.join('')))
    } else {
      this.settleSelfReport(pending.commandId, undefined, pending.chunks.join(''))
    }
  }

  private settleSelfReport(commandId: string, error?: Error, text = ''): void {
    const pending = this._selfReport
    if (!pending || pending.commandId !== commandId) return
    this._selfReport = null
    clearTimeout(pending.timer)
    if (error) {
      this.noteControlCut()
      pending.reject(error)
    } else pending.resolve(text)
  }

  /**
   * A status question that ended before its answer may stay in the provider's own thread with no
   * answer (2026-11-05: an engine switch stopped Pi mid-question, and after a switch back Pi answered
   * that question, FOR_USER_* lines, instead of the user's next message). The next user prompt
   * carries CONTROL_CUT_NOTE; kept on the record, so a resume in another process says it too.
   */
  private noteControlCut(): void {
    this._controlCut = true
    void updateSessionRecord(this.trackingId(), { acpControlCut: true } as Partial<SessionRecord>).catch(() => {})
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
