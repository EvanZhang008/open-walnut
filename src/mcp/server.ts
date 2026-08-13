/**
 * `open-walnut mcp` — a stdio MCP server exposing Walnut's core operations as
 * tools, so an AI coding session gets structured access to the user's tasks,
 * projects, sessions, and search.
 *
 *   claude --mcp-config '{"mcpServers":{"walnut":{"command":"open-walnut","args":["mcp"]}}}'
 *
 * Every tool is a thin wrapper over the frozen `/api/v1` facade on the local
 * server (see src/mcp/tools.ts) — the server, not this process, owns the data.
 *
 * STDOUT PURITY (the one hard rule of a stdio MCP server): stdout carries
 * JSON-RPC frames and NOTHING else. One stray `console.log` anywhere in an
 * imported module corrupts the stream and the client drops the connection with
 * a parse error. Walnut's logger already writes to stderr + a file only
 * (src/logging/subsystem.ts), but this module additionally rebinds the console
 * writers to stderr for the lifetime of the process so a future stray log
 * cannot break the protocol.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerWalnutTools, resolveApiBase } from './tools.js'

export interface McpOptions {
  /** Register only the read-only tools (for triage-style consumers). */
  readonly?: boolean
  /** Override the API base; defaults to OPEN_WALNUT_API_URL or 127.0.0.1:3456. */
  apiBase?: string
}

/** Build a configured (but unconnected) MCP server — also the test entry point. */
export function createWalnutMcpServer(options: McpOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'walnut', version: '1' },
    {
      instructions:
        'Walnut is the user\'s personal task + session hub. Read before you write ' +
        '(task_list / search) so you never duplicate an existing task. After task_create ' +
        'or task_complete, paste the returned `ref` tag verbatim into your reply so the user ' +
        'gets a clickable task pill. Never delete tasks unless the user explicitly asked.',
    },
  )
  registerWalnutTools(server, options)
  return server
}

/** Send every console writer to stderr so stdout stays JSON-RPC only. */
function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
      .join(' ')
    process.stderr.write(line + '\n')
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  console.warn = toStderr
  console.trace = toStderr
  // Already stderr-bound by default, but a future custom console or monkey-patch
  // could redirect it — rebind for symmetry so no console channel can hit stdout.
  console.error = toStderr
}

/** CLI entry: serve MCP over stdio until stdin closes. */
export async function runMcp(options: McpOptions = {}): Promise<void> {
  routeConsoleToStderr()

  const base = resolveApiBase(options.apiBase)
  const server = createWalnutMcpServer(options)
  const transport = new StdioServerTransport()

  await server.connect(transport)
  process.stderr.write(
    `[walnut mcp] serving ${options.readonly ? 'read-only ' : ''}tools against ${base}\n`,
  )

  // Resolve when the client hangs up (stdin EOF closes the transport), so the
  // CLI's action promise mirrors the process lifetime.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
    process.stdin.once('end', () => resolve())
  })
  await server.close().catch(() => { /* already gone */ })
}
