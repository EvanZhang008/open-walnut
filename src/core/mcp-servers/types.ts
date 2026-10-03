/**
 * MCP servers Walnut connects to as a CLIENT (src/mcp/ is the opposite: Walnut's own server).
 *
 * A plugin registers a stdio server (`walnut.mcp.register`); Walnut starts it on first use, keeps
 * the one process alive across calls, restarts it after a crash, and closes it when idle. The
 * plugin calls it through `walnut.mcp.client(name)`, and sessions reach it through the
 * `mcp_read` / `mcp_call` ops and `walnut mcp <server> tools …`.
 */

/** What an outside caller (a session, the CLI, the Personal AI) may call on a server. */
export type McpSessionAccess = 'read-only' | 'all' | 'none'

export interface McpServerDefinition {
  /** Unique across Walnut: lowercase letters, digits, `.`, `_`, `-`. */
  name: string
  command: string
  args?: string[]
  /** Added to the allowlisted environment (see env.ts); never the server's own environment. */
  env?: Record<string, string>
  cwd?: string
  /** Shown in Settings; defaults to the name. */
  title?: string
  /**
   * `read-only` (default): outside callers reach only tools the server marks `readOnlyHint`.
   * `all`: every tool, from this Mac only. `none`: the registering plugin alone.
   */
  sessions?: McpSessionAccess
  /** Spawn + initialize budget. Default 60 s (a first start may refresh a login). */
  startupTimeoutMs?: number
  /** Default per-call deadline. Default 60 s. */
  callTimeoutMs?: number
  /** Close the process after this long without a call. Default 15 min; 0 keeps it open. */
  idleCloseMs?: number
}

export type McpServerState = 'idle' | 'starting' | 'ready' | 'failed'

export interface McpServerStatus {
  name: string
  title: string
  /** The plugin that registered it. */
  owner: string
  state: McpServerState
  /** Epoch ms of the last state change. */
  since: number
  sessions: McpSessionAccess
  /** From the last tools/list, when one has run. */
  toolCount?: number
  serverInfo?: { name: string; version: string }
  /** One plain sentence: why the last start failed or why the process went away. */
  lastError?: string
}

export interface McpToolInfo {
  name: string
  title?: string
  description?: string
  readOnly: boolean
  destructive: boolean
  inputSchema: Record<string, unknown>
}

/** A tools/call answer, as the server sent it (structured content is NOT validated). */
export interface McpCallResult {
  content: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface McpCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Sent as the request's `_meta` (tracing, a caller tag a test server can read). Never logged. */
  meta?: Record<string, unknown>
}

/**
 * `before-call`: the request never reached the server (it could not start, or it is gone), so it
 * did not run. `after-call`: it was sent and no answer came (timeout, the process died, aborted):
 * it may have run. A write that fails after-call must not be retried blindly.
 */
export type McpCallStage = 'before-call' | 'after-call'
export type McpFailure = 'unavailable' | 'timeout' | 'closed' | 'aborted' | 'refused'

export class McpCallError extends Error {
  constructor(
    readonly failure: McpFailure,
    message: string,
    readonly stage: McpCallStage,
  ) {
    super(message)
    this.name = 'McpCallError'
  }
}

export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const MCP_STATUS_EVENT = 'mcp:status-changed'
