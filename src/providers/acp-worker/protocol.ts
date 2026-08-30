/**
 * ACP worker wire protocol — NDJSON JSON-RPC between the daemon (parent) and
 * the ACP host worker (child) over the worker's stdio.
 *
 * Design (docs/plan/coding-agent-acp-provider.md):
 * - One worker per Walnut session (runtimeId). Ordinary daemon child.
 * - Mutating ops carry a caller-generated commandId; the worker dedups and
 *   returns the original result on retry (protects against retry-after-lost-ack
 *   duplicating a turn).
 * - The worker never interprets provider frames — raw frames go to the journal,
 *   normalization happens server-side on read.
 */

/** Requests the daemon can send to the worker (JSON-RPC method names). */
export type WorkerOp =
  | 'initialize'        // spawn adapter + ACP initialize handshake
  | 'newSession'        // ACP session/new → providerSessionId
  | 'loadSession'       // ACP session/load(providerSessionId) — cold resume
  | 'prompt'            // ACP session/prompt (mutating, commandId)
  | 'steer'             // inject text into the LIVE turn (_session/steering ext, mutating, commandId)
  | 'cancel'            // ACP session/cancel (mutating, commandId, idempotent)
  | 'permissionResponse'// answer a pending session/request_permission (mutating, commandId)
  | 'setConfigOption'   // ACP session/set_config_option (mutating, commandId)
  | 'getState'          // worker state snapshot (pending requests, session info, models)
  | 'shutdown'          // graceful teardown (adapter stdin close → chain exits)

export interface WorkerRequest {
  id: number
  op: WorkerOp
  params?: Record<string, unknown>
}

export interface WorkerResponse {
  id: number
  ok: boolean
  result?: unknown
  /** Structured error — never a bare string, so callers can branch on kind. */
  error?: WorkerError
}

export interface WorkerError {
  kind:
    | 'adapter_spawn_failed'   // codex-acp missing / not executable
    | 'provider_missing'       // codex binary not found
    | 'provider_incompatible'  // codex version outside adapter's declared range
    | 'auth_required'          // provider reports authentication needed
    | 'load_failed'            // session/load rejected (bad/expired providerSessionId)
    | 'no_session'             // op requires a session but none established
    | 'turn_active'            // prompt while a turn is already running
    | 'no_turn'                // steer requires a live turn but none is running
    | 'steer_unsupported'      // adapter did not advertise _meta.steering at initialize
    | 'steer_race'             // turn ended mid-steer; message must re-queue as a prompt
    | 'protocol'               // ACP-level error from the adapter
    | 'internal'
  message: string
}

/** Push notification from worker → daemon (no id, fire-and-forget). */
export type WorkerNotification =
  | {
      ev: 'journal'      // a new record was appended to the journal at `offset`
      offset: number
    }
  | {
      ev: 'adapter_stderr'
      /** Byte count only. Adapter stderr may contain credentials or auth output. */
      bytes: number
    }

// ── Op payloads ──

export interface InitializeParams {
  /**
   * Full command vector to spawn the adapter, e.g.
   * ['node', '<install>/node_modules/@agentclientprotocol/codex-acp/dist/index.js'].
   * A vector (not a bare path) because the worker may be a bun-compiled binary
   * where process.execPath points at the worker itself, not a JS runtime.
   */
  adapterCommand: string[]
  /** Working directory for the adapter/provider processes. */
  cwd: string
  /** Extra env for the adapter (never logged). */
  env?: Record<string, string>
}

/**
 * One stdio MCP server mount, structurally identical to ACP's `McpServerStdio`
 * (schema/types.gen.d.ts: name / command / args / env). Declared locally so the
 * worker↔daemon wire contract does not depend on the SDK's generated union.
 */
export interface AcpMcpServer {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}

/**
 * The walnut MCP mount — `open-walnut mcp` (src/mcp/server.ts), which exposes
 * the task/project/session tools to an ACP provider.
 *
 * Deliberately a bare command, not an absolute path: it is spawned by the
 * provider on the EXECUTION host, where walnut's install location is unknown.
 * That is also why the mount is opt-in (see `resolveWalnutMcpServers`) — on a
 * host without `open-walnut` on PATH the provider would report a dead MCP
 * server on every session.
 */
export const WALNUT_MCP_SERVER: AcpMcpServer = {
  name: 'walnut',
  command: 'open-walnut',
  args: ['mcp'],
  env: [],
}

/**
 * Walnut's MCP mount list for an ACP session — empty unless the user opted in
 * with config `session.acp_walnut_mcp: true`. Pure (takes the config section,
 * never reads config itself) so both the server and tests can call it.
 */
export function resolveWalnutMcpServers(
  session?: { acp_walnut_mcp?: boolean } | null,
): AcpMcpServer[] {
  if (session?.acp_walnut_mcp !== true) return []
  return [{ ...WALNUT_MCP_SERVER, args: [...WALNUT_MCP_SERVER.args], env: [] }]
}

/** `mcpServers` absent = no MCP servers, i.e. exactly the pre-mount behavior. */
export interface NewSessionParams { cwd: string; mcpServers?: AcpMcpServer[] }
export interface LoadSessionParams {
  providerSessionId: string
  cwd: string
  mcpServers?: AcpMcpServer[]
}

export type PromptParams =
  | {
      commandId: string
      /** Durable Walnut queue identity. Also determines commandId (`acp-prompt:<id>`). */
      walnutMessageId: string
      /** Plain user text — worker wraps it as a single text ContentBlock. */
      text: string
      control?: never
    }
  | {
      commandId: string
      /** Hidden provider-thread prompt used for the turn-complete self-report. */
      control: 'self-report'
      text: string
      walnutMessageId?: never
    }

export interface CancelParams { commandId: string }

/**
 * Mid-turn steering (codex `turn/steer` via the adapter's `_session/steering`
 * extension). The worker forwards the text into the LIVE turn; the provider
 * folds it into the model's next inference step. Only valid while a turn is
 * active and the adapter advertised `_meta.steering.supported` at initialize.
 */
export interface SteerParams {
  commandId: string
  /** Durable Walnut queue identity (same contract as PromptParams). */
  walnutMessageId: string
  text: string
}

export interface SetConfigOptionParams {
  commandId: string
  configId: string
  value: string | boolean
}

export interface PermissionResponseParams {
  commandId: string
  /** ACP RequestPermissionRequest correlation — worker holds the live JSON-RPC callback. */
  providerRequestId: string
  /** Exact ACP PermissionOptionId chosen by the user, or null to cancel. */
  optionId: string | null
}

// ── State snapshot (getState) ──

export interface PendingPermissionSnapshot {
  providerRequestId: string
  toolCall: unknown          // raw ACP ToolCallUpdate — normalized server-side
  options: unknown[]         // raw ACP PermissionOption[]
  receivedAt: number
}

export interface AcpModelInfo {
  modelId: string
  name: string
  description?: string
}

export interface AcpModelCatalog {
  currentModelId?: string
  availableModels: AcpModelInfo[]
}

export interface AcpConfigOptionChoice {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  category?: string
  type: 'select'
  currentValue: string
  options: AcpConfigOptionChoice[]
}

export interface WorkerStateSnapshot {
  providerSessionId: string | null
  adapterPid: number | null
  turnActive: boolean
  controlActive: boolean
  pendingPermissions: PendingPermissionSnapshot[]
  /** Raw ACP InitializeResponse (capabilities, auth methods) — normalized server-side. */
  initializeResponse: unknown
  /** Stable, provider-neutral capability snapshot persisted on the session record. */
  capabilities: AcpCapabilitySnapshot
  /** Raw session/new | session/load response (models, modes, config options). */
  sessionResponse: unknown
  /** Provider-neutral model catalog normalized from the session response extension. */
  models: AcpModelCatalog
  /** Provider-neutral selectable session controls normalized from configOptions. */
  configOptions: AcpConfigOption[]
  /** Last accepted commandId per op — reattaching callers use this to avoid blind retries. */
  lastAcceptedCommands: Record<string, string>
  journalOffset: number
}

export interface AcpCapabilitySnapshot {
  loadSession: boolean
  promptImages: boolean
  promptAudio: boolean
  promptEmbeddedContext: boolean
  listSessions: boolean
  deleteSession: boolean
  additionalDirectories: boolean
  forkSession: boolean
  resumeSession: boolean
  closeSession: boolean
  /** Adapter advertises `_meta.steering.supported` (codex-acp ≥1.2) — mid-turn text injection. */
  steering: boolean
}

export const EMPTY_ACP_CAPABILITIES: AcpCapabilitySnapshot = {
  loadSession: false,
  promptImages: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  listSessions: false,
  deleteSession: false,
  additionalDirectories: false,
  forkSession: false,
  resumeSession: false,
  closeSession: false,
  steering: false,
}

/** Reduce the versioned ACP initialize response to Walnut's stable capability contract. */
export function snapshotAcpCapabilities(response: unknown): AcpCapabilitySnapshot {
  const root = asRecord(response)
  const agent = asRecord(root.agentCapabilities)
  const prompt = asRecord(agent.promptCapabilities)
  const session = asRecord(agent.sessionCapabilities)
  const steering = asRecord(asRecord(root._meta).steering)
  return {
    loadSession: agent.loadSession === true,
    promptImages: prompt.image === true,
    promptAudio: prompt.audio === true,
    promptEmbeddedContext: prompt.embeddedContext === true,
    listSessions: isAdvertised(session.list),
    deleteSession: isAdvertised(session.delete),
    additionalDirectories: isAdvertised(session.additionalDirectories),
    forkSession: isAdvertised(session.fork),
    resumeSession: isAdvertised(session.resume),
    closeSession: isAdvertised(session.close),
    steering: steering.supported === true,
  }
}

/** Normalize the codex-acp models extension, accepting its legacy top-level shape too. */
export function snapshotAcpModels(response: unknown): AcpModelCatalog {
  const root = asRecord(response)
  const metaModels = asRecord(asRecord(root._meta).models)
  const models = Object.keys(metaModels).length > 0 ? metaModels : asRecord(root.models)
  const availableModels = Array.isArray(models.availableModels)
    ? models.availableModels.flatMap((entry) => {
        const model = asRecord(entry)
        if (typeof model.modelId !== 'string') return []
        return [{
          modelId: model.modelId,
          name: typeof model.name === 'string' ? model.name : model.modelId,
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
        }]
      })
    : []
  return {
    ...(typeof models.currentModelId === 'string'
      ? { currentModelId: models.currentModelId }
      : {}),
    availableModels,
  }
}

/** Normalize ACP select config options while dropping malformed/provider-specific entries. */
export function snapshotAcpConfigOptions(response: unknown): AcpConfigOption[] {
  const root = asRecord(response)
  if (!Array.isArray(root.configOptions)) return []
  return root.configOptions.flatMap((entry) => {
    const option = asRecord(entry)
    if (
      option.type !== 'select'
      || typeof option.id !== 'string'
      || typeof option.currentValue !== 'string'
      || !Array.isArray(option.options)
    ) return []
    const choices = option.options.flatMap((choice) => {
      const value = asRecord(choice)
      if (typeof value.value !== 'string') return []
      return [{
        value: value.value,
        name: typeof value.name === 'string' ? value.name : value.value,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
      }]
    })
    return [{
      id: option.id,
      name: typeof option.name === 'string' ? option.name : option.id,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
      ...(typeof option.category === 'string' ? { category: option.category } : {}),
      type: 'select' as const,
      currentValue: option.currentValue,
      options: choices,
    }]
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function isAdvertised(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ── Journal record grammar ──
// One JSON record per line; byte offset of the line start = replay cursor.

export type AcpFrameSource = 'live' | 'provider-replay' | 'control'

export type JournalRecord =
  | {
      kind: 'acp'
      ts: number
      /** Missing on legacy journals and treated as live for backward compatibility. */
      source?: AcpFrameSource
      frame: unknown
    }
  | { kind: 'meta'; ts: number; event: JournalMetaEvent }

export type JournalMetaEvent =
  | { type: 'session-created'; providerSessionId: string }
  | { type: 'session-loaded'; providerSessionId: string }
  | { type: 'prompt-intent'; commandId: string; walnutMessageId: string; text: string }
  | { type: 'prompt-dispatch-attempted'; commandId: string }
  | { type: 'prompt-dispatched'; commandId: string }
  | { type: 'prompt-abandoned'; commandId: string; reason: 'worker-crash' | 'dispatch-failed' }
  | { type: 'prompt-accepted'; commandId: string; walnutMessageId: string; text: string }
  /** A mid-turn steer joined the LIVE turn (owner commandId = the running prompt's). */
  | { type: 'steer-accepted'; commandId: string; walnutMessageId: string; text: string }
  | { type: 'control-prompt-accepted'; commandId: string; purpose: 'self-report' }
  | {
      type: 'control-ended'
      commandId: string
      stopReason: string
      error?: string
    }
  | { type: 'turn-started'; commandId: string }
  | { type: 'turn-ended'; commandId: string; stopReason: string }
  | {
      type: 'turn-interrupted'
      reason:
        | 'daemon-restart'
        | 'worker-crash'
        | 'shutdown'
        | 'user-cancelled'
        | 'dispatch-indeterminate'
      commandId?: string
    }
  | { type: 'permission-requested'; providerRequestId: string }
  | { type: 'permission-answered'; providerRequestId: string; optionId: string | null }
  | { type: 'permission-auto-cancelled'; providerRequestId: string }
  | { type: 'config-option-set'; configId: string; value: string | boolean }
  | { type: 'command-accepted'; op: string; commandId: string }
  | { type: 'error'; errorKind: string; message: string; commandId?: string }

/**
 * Spawn env for the worker (daemon side) and the adapter (worker side): base
 * process env overlaid with the session's adapter env. An EMPTY-STRING overlay
 * value means "unset the inherited variable" — the server maps
 * `engines.<id>.env: {VAR: null}` to '' on the wire, and BOTH spawn sites must
 * apply it identically or the second merge resurrects what the first deleted
 * (real failure: the worker re-set AWS_BEARER_TOKEN_BEDROCK='' over a cleaned
 * env, and the AWS SDK's bearer chain still outranked the AWS_PROFILE the
 * operator configured → IncompleteSignatureException on every goose turn).
 */
export function mergeAcpSpawnEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === '') delete merged[key]
    else merged[key] = value
  }
  return merged
}
