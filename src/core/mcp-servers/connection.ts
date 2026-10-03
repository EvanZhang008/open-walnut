/**
 * One MCP server process and the client talking to it over stdio.
 *
 * Lifecycle: `idle` (no process) → `starting` on the first call → `ready`. A crash or a failed start
 * is `failed`, and the next call after a short cooldown starts it again; an idle timer closes it
 * back to `idle`. Concurrent first calls share one start.
 *
 * tools/list and tools/call go through the client's low-level `request`, never `listTools` /
 * `callTool`: after a `listTools` the SDK validates every structured result against the tool's
 * outputSchema and THROWS on a mismatch, which would turn a message that was really posted into
 * a failure. Walnut hands the server's answer to the caller as sent.
 *
 * Logged: server, tool, duration, isError. Never arguments, never results.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError, ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { redactSensitiveText, type SubsystemLogger } from '../../logging/index.js'
import { mcpServerEnv } from './env.js'
import {
  McpCallError, type McpCallOptions, type McpCallResult, type McpServerDefinition, type McpServerState,
  type McpServerStatus, type McpSessionAccess, type McpToolInfo,
} from './types.js'

/** After a failed start or a crash, calls fail fast for this long instead of respawning per call. */
export const RETRY_COOLDOWN_MS = 5_000
const STDERR_TAIL_CHARS = 8_192
const TOOLS_TTL_MS = 10 * 60_000
const MAX_TOOLS = 2_000

export interface ResolvedMcpDefinition {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  title: string
  sessions: McpSessionAccess
  startupTimeoutMs: number
  callTimeoutMs: number
  idleCloseMs: number
}

export function resolveDefinition(def: McpServerDefinition): ResolvedMcpDefinition {
  return {
    name: def.name,
    command: def.command,
    args: [...(def.args ?? [])],
    env: { ...(def.env ?? {}) },
    ...(def.cwd ? { cwd: def.cwd } : {}),
    title: def.title?.trim() || def.name,
    sessions: def.sessions ?? 'read-only',
    startupTimeoutMs: def.startupTimeoutMs ?? 60_000,
    callTimeoutMs: def.callTimeoutMs ?? 60_000,
    idleCloseMs: def.idleCloseMs ?? 15 * 60_000,
  }
}

export interface ConnectionHooks {
  onStatus(): void
  log: SubsystemLogger
  /** A replica never starts servers: the primary owns every account they reach. */
  replica: boolean
  clientVersion: string
  now?: () => number
}

const durationText = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class McpConnection {
  private state: McpServerState = 'idle'
  private since: number
  private lastError: string | undefined
  private serverInfo: { name: string; version: string } | undefined
  private toolCount: number | undefined
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  /** The transport of a start in progress, so a stop can end a slow start at once. */
  private pendingTransport: StdioClientTransport | null = null
  private starting: Promise<Client> | null = null
  private lastFailureAt = 0
  private stderrTail = ''
  private inFlight = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private tools: { at: number; list: McpToolInfo[] } | null = null
  private removed = false
  /** Bumped by every start and every close: a transport event from an older one is ignored. */
  private generation = 0

  constructor(
    readonly def: ResolvedMcpDefinition,
    readonly owner: string,
    private readonly hooks: ConnectionHooks,
  ) {
    this.since = this.now()
  }

  private now(): number {
    return (this.hooks.now ?? Date.now)()
  }

  status(): McpServerStatus {
    return {
      name: this.def.name,
      title: this.def.title,
      owner: this.owner,
      state: this.state,
      since: this.since,
      sessions: this.def.sessions,
      ...(this.toolCount !== undefined ? { toolCount: this.toolCount } : {}),
      ...(this.serverInfo ? { serverInfo: this.serverInfo } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** The process id while one is running (tests use it to prove reuse and restart). */
  pid(): number | null {
    return this.transport?.pid ?? null
  }

  private setState(state: McpServerState): void {
    if (this.state === state) return
    this.state = state
    this.since = this.now()
    this.hooks.onStatus()
  }

  private sentence(what: string, error?: unknown): string {
    const detail = error === undefined ? '' : `: ${messageOf(error)}`
    const lastLine = this.stderrTail.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? ''
    const said = lastLine ? ` It said: ${lastLine.slice(0, 200)}` : ''
    return redactSensitiveText(`The MCP server "${this.def.title}" ${what}${detail}.${said}`).slice(0, 400)
  }

  private async ensure(): Promise<Client> {
    if (this.removed) {
      throw new McpCallError('unavailable', `The MCP server "${this.def.name}" is no longer registered.`, 'before-call')
    }
    if (this.hooks.replica) {
      throw new McpCallError('unavailable', 'MCP servers run on the primary Walnut, not on this replica.', 'before-call')
    }
    if (this.client && this.state === 'ready') return this.client
    if (this.starting) return this.starting
    if (this.state === 'failed' && this.now() - this.lastFailureAt < RETRY_COOLDOWN_MS) {
      throw new McpCallError('unavailable', this.lastError ?? this.sentence('is not running'), 'before-call')
    }
    const starting = this.start()
    this.starting = starting
    const settle = () => { if (this.starting === starting) this.starting = null }
    void starting.then(settle, settle)
    return starting
  }

  private async start(): Promise<Client> {
    const generation = ++this.generation
    const startedAt = this.now()
    this.stderrTail = ''
    this.tools = null
    this.setState('starting')
    const transport = new StdioClientTransport({
      command: this.def.command,
      args: this.def.args,
      env: mcpServerEnv(this.def.env),
      ...(this.def.cwd ? { cwd: this.def.cwd } : {}),
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    const client = new Client({ name: 'walnut', version: this.hooks.clientVersion }, { capabilities: {} })
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { this.tools = null })
    let ready = false
    client.onclose = () => { if (ready) this.handleClose(generation) }
    this.pendingTransport = transport
    try {
      await client.connect(transport, { timeout: this.def.startupTimeoutMs })
    } catch (error) {
      if (this.pendingTransport === transport) this.pendingTransport = null
      await transport.close().catch(() => {})
      if (generation !== this.generation) throw this.superseded()
      const code = (error as NodeJS.ErrnoException)?.code
      const lastError = code === 'ENOENT'
        ? this.sentence(`could not start: its command was not found (${this.def.command})`)
        : error instanceof McpError && error.code === ErrorCode.RequestTimeout
          ? this.sentence(`did not finish starting within ${durationText(this.def.startupTimeoutMs)}`)
          : this.sentence('could not start', error)
      this.lastError = lastError
      this.lastFailureAt = this.now()
      this.setState('failed')
      this.hooks.log.warn('mcp server failed to start', { server: this.def.name, ms: this.now() - startedAt, error: lastError })
      throw new McpCallError('unavailable', lastError, 'before-call')
    }
    if (this.pendingTransport === transport) this.pendingTransport = null
    if (generation !== this.generation || this.removed) {
      await transport.close().catch(() => {})
      throw this.superseded()
    }
    ready = true
    this.client = client
    this.transport = transport
    const info = client.getServerVersion()
    this.serverInfo = info ? { name: String(info.name), version: String(info.version) } : undefined
    this.lastError = undefined
    this.setState('ready')
    this.hooks.log.info('mcp server ready', { server: this.def.name, ms: this.now() - startedAt, pid: transport.pid })
    this.armIdle()
    return client
  }

  private superseded(): McpCallError {
    return new McpCallError('unavailable', `The MCP server "${this.def.name}" was stopped while it was starting.`, 'before-call')
  }

  /** The process went away on its own: pending calls are rejected by the SDK (ConnectionClosed). */
  private handleClose(generation: number): void {
    if (generation !== this.generation) return
    this.generation += 1
    this.client = null
    this.transport = null
    this.tools = null
    this.disarmIdle()
    this.lastError = this.sentence('stopped unexpectedly')
    this.lastFailureAt = this.now()
    this.hooks.log.warn('mcp server exited', { server: this.def.name, error: this.lastError })
    this.setState('failed')
  }

  async call(tool: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<McpCallResult> {
    const client = await this.ensure()
    this.inFlight += 1
    this.disarmIdle()
    const startedAt = this.now()
    const timeoutMs = options.timeoutMs ?? this.def.callTimeoutMs
    try {
      const result = await client.request(
        { method: 'tools/call', params: { name: tool, arguments: args, ...(options.meta ? { _meta: options.meta } : {}) } },
        CallToolResultSchema,
        { timeout: timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
      )
      this.hooks.log.debug('mcp call', { server: this.def.name, tool, ms: this.now() - startedAt, isError: result.isError === true })
      return result as McpCallResult
    } catch (error) {
      const failure = this.callFailure(tool, timeoutMs, error, options.signal)
      this.hooks.log.warn('mcp call failed', {
        server: this.def.name, tool, ms: this.now() - startedAt, failure: failure.failure, stage: failure.stage,
      })
      throw failure
    } finally {
      this.inFlight -= 1
      this.armIdle()
    }
  }

  private callFailure(tool: string, timeoutMs: number, error: unknown, signal?: AbortSignal): McpCallError {
    if (error instanceof McpCallError) return error
    const name = this.def.name
    if (signal?.aborted) return new McpCallError('aborted', `The call to ${tool} on "${name}" was cancelled.`, 'after-call')
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) {
        return new McpCallError('timeout', `The MCP server "${name}" did not answer ${tool} within ${durationText(timeoutMs)}.`, 'after-call')
      }
      if (error.code === ErrorCode.ConnectionClosed) {
        return new McpCallError('closed', `The MCP server "${name}" stopped before it answered ${tool}.`, 'after-call')
      }
      // A JSON-RPC error is the server refusing the request (unknown tool, bad arguments).
      return new McpCallError('refused', `The MCP server "${name}" refused ${tool}: ${error.message.slice(0, 200)}`, 'before-call')
    }
    return new McpCallError('unavailable', `The MCP server "${name}" could not answer ${tool}: ${messageOf(error).slice(0, 200)}`, 'after-call')
  }

  async listTools(options: { refresh?: boolean; timeoutMs?: number } = {}): Promise<McpToolInfo[]> {
    if (!options.refresh && this.tools && this.now() - this.tools.at < TOOLS_TTL_MS && this.state === 'ready') return this.tools.list
    const client = await this.ensure()
    const timeout = options.timeoutMs ?? this.def.callTimeoutMs
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    this.inFlight += 1
    this.disarmIdle()
    try {
      do {
        const page = await client.request(
          { method: 'tools/list', params: cursor ? { cursor } : {} },
          ListToolsResultSchema,
          { timeout },
        )
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            readOnly: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint === true,
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          })
        }
        cursor = page.nextCursor
      } while (cursor && tools.length < MAX_TOOLS)
    } catch (error) {
      throw this.callFailure('tools/list', timeout, error)
    } finally {
      this.inFlight -= 1
      this.armIdle()
    }
    this.tools = { at: this.now(), list: tools }
    if (this.toolCount !== tools.length) {
      this.toolCount = tools.length
      this.hooks.onStatus()
    }
    return tools
  }

  /** Stop the process (a restart starts it again at once). */
  async restart(): Promise<McpServerStatus> {
    await this.stop()
    this.lastError = undefined
    this.lastFailureAt = 0
    try { await this.listTools({ refresh: true }) } catch { /* the status says why */ }
    return this.status()
  }

  private async stop(): Promise<void> {
    this.disarmIdle()
    const transports = [this.transport, this.pendingTransport]
    this.generation += 1
    // A start in flight now settles as superseded; the next call starts afresh instead of joining it.
    this.starting = null
    this.client = null
    this.transport = null
    this.pendingTransport = null
    this.tools = null
    if (this.state !== 'failed') this.setState('idle')
    await Promise.all(transports.map((one) => one?.close().catch(() => {})))
  }

  /** The owner went away (plugin disposed, server stopping): close and refuse every later call. */
  async dispose(): Promise<void> {
    this.removed = true
    await this.stop()
  }

  private armIdle(): void {
    if (this.def.idleCloseMs <= 0 || this.inFlight > 0 || this.state !== 'ready' || this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.inFlight > 0 || this.state !== 'ready') return
      this.hooks.log.info('mcp server closed after being idle', { server: this.def.name, idleMs: this.def.idleCloseMs })
      void this.stop()
    }, this.def.idleCloseMs)
    this.idleTimer.unref?.()
  }

  private disarmIdle(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
