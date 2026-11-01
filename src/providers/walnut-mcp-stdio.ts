/**
 * `walnut mcp-server` — Walnut's ops as an MCP stdio server, on any host.
 *
 * The hub's `open-walnut mcp` (src/mcp/server.ts) runs the op registry itself and
 * calls the server's HTTP API on 127.0.0.1:3456, so it only works on the Mac that
 * runs Walnut. A session on another host (and every session's own `walnut` CLI)
 * reaches Walnut through its host daemon's gateway socket instead. This server
 * speaks MCP on stdio and answers each request with one gateway request, the
 * same one `walnut tools list` / `walnut tools call` send: the same op catalog,
 * the same caller (`WALNUT_SESSION_ID`), the same per-host refusals and write
 * budget. Only the transport differs: typed arguments, no shell quoting, and one
 * long-lived process instead of a CLI start per call.
 *
 * Hand-rolled JSON-RPC (newline-delimited, the MCP stdio transport) instead of
 * the SDK: the daemon builds carry this file, and four methods are all a client
 * needs. Tools carry no `anthropic/alwaysLoad`, so Claude Code lists them by name
 * and loads a schema only when the model asks for it (ToolSearch): the whole
 * catalog costs about 2K tokens at session start, against about 76K for every
 * schema up front (measured 2026-11-01).
 *
 * STDOUT PURITY: stdout carries JSON-RPC frames and nothing else.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GatewayError, GatewayOp, GatewayResponse } from './gateway-core.js'
import { GATEWAY_INLINE_ARGS_MAX_BYTES } from './tool-args-source.js'
import { walnutMcpInstructions } from '../mcp/instructions.js'

/** MCP protocol versions this server speaks; the first is offered when the client's is unknown. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** How long `tools/list` waits on the hub's catalog (the client waits on it to connect). */
export const MCP_LIST_TIMEOUT_MS = 15_000

/** How often a list that came back short (no hub, an older hub) is asked for again. */
export const MCP_LIST_RETRY_MS = 60_000

export type GatewayRequestFn = (op: GatewayOp, args: Record<string, unknown>, timeoutMs?: number) => Promise<GatewayResponse>

export interface WalnutMcpDeps {
  /** One gateway request on this host's daemon socket. */
  request: GatewayRequestFn
  /** Error lines the CLI prints for a gateway error (wn-cli formatErrorLines). */
  formatError: (error: GatewayError) => string[]
  /** Where a payload too big to inline is staged for the hub to pull. */
  tmpDir?: string
  /** Send a notification to the client (tools/list_changed after a short list is completed). */
  notify?: (method: string) => void
  /** Overrides MCP_LIST_RETRY_MS (tests). */
  listRetryMs?: number
}

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown }
type JsonRpcReply = Record<string, unknown>

interface HubOpRow {
  name: string
  title?: string
  description?: string
  readonly?: boolean
  destructive?: boolean
  inputSchema?: Record<string, unknown>
  signature?: string
}

/** What a tool's text content says for an op result: the CLI's own rendering. */
function text(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
}

/** One MCP tool row from a hub catalog row. An older hub sends no schema: accept any object. */
export function mcpToolOf(row: HubOpRow): Record<string, unknown> {
  const description = row.inputSchema || !row.signature
    ? (row.description ?? '')
    : `${row.description ?? ''}\n\nArguments: ${row.signature}`
  return {
    name: row.name,
    ...(row.title ? { title: row.title } : {}),
    description,
    inputSchema: row.inputSchema ?? { type: 'object', additionalProperties: true },
    annotations: {
      ...(row.readonly ? { readOnlyHint: true } : {}),
      ...(row.destructive !== undefined ? { destructiveHint: row.destructive } : {}),
    },
  }
}

/** The protocol version to answer an initialize with. */
export function negotiateProtocol(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0]
}

/**
 * Build the request handler. Returns the reply for a request, or null for a
 * notification (no id) or a method that needs no answer.
 */
export function createWalnutMcpHandler(deps: WalnutMcpDeps): (msg: JsonRpcRequest) => Promise<JsonRpcReply | null> {
  const replyOk = (id: JsonRpcRequest['id'], result: unknown): JsonRpcReply => ({ jsonrpc: '2.0', id: id ?? null, result })
  const replyErr = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcReply =>
    ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const toolError = (message: string, detail?: unknown) => ({
    isError: true,
    content: [{ type: 'text', text: detail === undefined ? message : `${text(detail)}\n${message}` }],
  })

  // The catalog is fetched once and kept. One that came back short (the Mac away,
  // so a host serves its small offline set; an older hub, so no schemas) is asked
  // for again until a full one arrives, and the client is told the list changed.
  let fullList: Record<string, unknown>[] | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let spillSeq = 0
  const fetchList = async (): Promise<{ tools: Record<string, unknown>[]; full: boolean } | { error: string }> => {
    let resp: GatewayResponse
    try {
      resp = await deps.request('tools.list', { schemas: true }, MCP_LIST_TIMEOUT_MS)
    } catch (err) {
      return { error: `Walnut's tool list did not arrive: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!resp.ok) return { error: deps.formatError(resp.error).join('\n') }
    const rows = Array.isArray(resp.result.ops) ? resp.result.ops as HubOpRow[] : []
    return { tools: rows.map(mcpToolOf), full: rows.length > 0 && rows.every((r) => r.inputSchema) }
  }
  const scheduleRetry = () => {
    if (retry || !deps.notify) return
    retry = setTimeout(async () => {
      retry = null
      const got = await fetchList()
      if ('tools' in got && got.full) {
        fullList = got.tools
        deps.notify?.('notifications/tools/list_changed')
      } else scheduleRetry()
    }, deps.listRetryMs ?? MCP_LIST_RETRY_MS)
    retry.unref?.()
  }

  const callTool = async (params: Record<string, unknown>) => {
    const name = typeof params.name === 'string' ? params.name : ''
    if (!name) return toolError('tools/call needs a tool name')
    const args = params.arguments ?? {}
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return toolError('arguments must be an object')
    // A payload the gateway line cannot carry goes as a file the hub pulls, as the CLI's does.
    const raw = JSON.stringify(args)
    let spilled: string | undefined
    if (Buffer.byteLength(raw, 'utf-8') > GATEWAY_INLINE_ARGS_MAX_BYTES) {
      // Calls run concurrently, so the name carries a counter as well as the time.
      spilled = path.join(deps.tmpDir ?? os.tmpdir(), `walnut-mcp-args-${process.pid}-${Date.now().toString(36)}-${++spillSeq}.json`)
      fs.writeFileSync(spilled, raw, { encoding: 'utf-8', mode: 0o600 })
    }
    try {
      const resp = await deps.request('tools.call', spilled ? { name, argsFile: spilled } : { name, args })
      if (resp.ok) return { content: [{ type: 'text', text: text(resp.result) }] }
      return toolError(deps.formatError(resp.error).join('\n'), resp.error.detail)
    } catch (err) {
      return toolError(`walnut: no answer from the Walnut daemon: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (spilled) { try { fs.unlinkSync(spilled) } catch { /* already gone */ } }
    }
  }

  return async (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
    const method = typeof msg.method === 'string' ? msg.method : ''
    const isRequest = msg.id !== undefined && msg.id !== null
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>
    if (!isRequest) return null // notifications/initialized, notifications/cancelled, ...
    switch (method) {
      case 'initialize':
        return replyOk(msg.id, {
          protocolVersion: negotiateProtocol(params.protocolVersion),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'walnut', version: '1' },
          instructions: walnutMcpInstructions(),
        })
      case 'ping':
        return replyOk(msg.id, {})
      case 'tools/list': {
        if (fullList) return replyOk(msg.id, { tools: fullList })
        const got = await fetchList()
        if ('tools' in got && got.full) {
          fullList = got.tools
          return replyOk(msg.id, { tools: fullList })
        }
        // Answer with what there is (an error would leave the session with no server
        // at all), and complete it later.
        scheduleRetry()
        if ('tools' in got) return replyOk(msg.id, { tools: got.tools })
        if (!deps.notify) return replyErr(msg.id, -32603, got.error)
        return replyOk(msg.id, { tools: [] })
      }
      case 'tools/call':
        return replyOk(msg.id, await callTool(params))
      case 'resources/list':
        return replyOk(msg.id, { resources: [] })
      case 'prompts/list':
        return replyOk(msg.id, { prompts: [] })
      default:
        return replyErr(msg.id, -32601, `Method not found: ${method}`)
    }
  }
}

/** Serve MCP on this process's stdin/stdout until stdin closes. */
export function runWalnutMcpStdio(deps: WalnutMcpDeps): Promise<number> {
  const write = (reply: JsonRpcReply) => { process.stdout.write(JSON.stringify(reply) + '\n') }
  const handle = createWalnutMcpHandler({ ...deps, notify: (method) => write({ jsonrpc: '2.0', method }) })
  return new Promise<number>((resolve) => {
    let buf = ''
    let pending = 0
    let ended = false
    const maybeExit = () => { if (ended && pending === 0) resolve(0) }
    const onLine = (line: string) => {
      if (!line.trim()) return
      let msg: JsonRpcRequest
      try {
        msg = JSON.parse(line) as JsonRpcRequest
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      const id = msg && typeof msg === 'object' ? msg.id : undefined
      pending++
      handle(msg)
        .then((reply) => { if (reply) write(reply) })
        .catch((err) => {
          if (id !== undefined && id !== null) {
            write({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
          }
        })
        .finally(() => { pending--; maybeExit() })
    }
    process.stdin.setEncoding('utf-8')
    // setEncoding decodes UTF-8 across chunk edges; the newline search starts where
    // the last one stopped, so a multi-megabyte line is one pass, not one per chunk.
    let scanFrom = 0
    process.stdin.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n', scanFrom)) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        scanFrom = 0
        onLine(line)
      }
      scanFrom = buf.length
    })
    process.stdin.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; ended = true; maybeExit() })
  })
}
