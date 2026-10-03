/**
 * `walnut mcp …`: the MCP servers Walnut runs, as a CLI. Pure parsing and formatting, shared by the
 * in-session `walnut` (wn-cli.ts) and the hub CLI (src/commands/mcp-client.ts); both run the
 * mcp_* ops (src/ops/mcp.ts), so neither can reach more than the ops allow.
 *
 *   walnut mcp list                                   servers, state, what sessions may call
 *   walnut mcp <server> tools list                    its tools (ro = callable with call)
 *   walnut mcp <server> tools help <tool>             one tool's description and input schema
 *   walnut mcp <server> tools call <tool> ['{json}']  call it (also @file, - for stdin)
 *
 * Zero imports: it is bundled into the daemon binary.
 */

export type McpCliParsed =
  | { kind: 'mcp.servers' }
  | { kind: 'mcp.tools'; server: string }
  | { kind: 'mcp.help'; server: string; tool: string }
  | { kind: 'mcp.call'; server: string; tool: string; rawJson: string | undefined }
  | { kind: 'mcp.usage'; message?: string }

export const MCP_CLI_HELP = `walnut mcp: the MCP servers Walnut runs for its plugins

  walnut mcp list                                   servers, their state, and what you may call
  walnut mcp <server> tools list                    a server's tools (ro = read-only)
  walnut mcp <server> tools help <tool>             one tool's description and input schema
  walnut mcp <server> tools call <tool> ['{json}']  call a tool (arguments inline, @file, or - for stdin)

A server answers outside callers with its read-only tools unless its plugin opened all of them
(sessions: all, this Mac only). Writes a plugin keeps behind an approval go through that plugin's
own ops.`

export function parseMcpCliArgs(args: string[]): McpCliParsed {
  const [first, sub, verb, tool, ...rest] = args
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') return { kind: 'mcp.usage' }
  if (first === 'list') {
    return sub === undefined ? { kind: 'mcp.servers' } : { kind: 'mcp.usage', message: `unexpected argument: ${sub}` }
  }
  if (first.startsWith('-')) return { kind: 'mcp.usage', message: `unknown flag: ${first}` }
  if (sub !== 'tools') return { kind: 'mcp.usage', message: `expected \`walnut mcp ${first} tools list | help | call\`` }
  if (verb === undefined || verb === 'list') {
    return tool === undefined ? { kind: 'mcp.tools', server: first } : { kind: 'mcp.usage', message: `unexpected argument: ${tool}` }
  }
  if (verb === 'help') {
    if (!tool) return { kind: 'mcp.usage', message: 'tools help requires <tool>' }
    return { kind: 'mcp.help', server: first, tool }
  }
  if (verb === 'call') {
    if (!tool) return { kind: 'mcp.usage', message: 'tools call requires <tool>' }
    if (rest.some((arg) => arg === '--help' || arg === '-h')) return { kind: 'mcp.help', server: first, tool }
    if (rest.length > 1) return { kind: 'mcp.usage', message: 'pass the arguments as ONE JSON object (quote it)' }
    return { kind: 'mcp.call', server: first, tool, rawJson: rest[0] }
  }
  return { kind: 'mcp.usage', message: `unknown tools subcommand: ${verb} (expected list | help | call)` }
}

/** The op the CLI tried first refused the tool as a write: the caller may try mcp_call. */
export function isNotReadOnlyRefusal(message: string): boolean {
  return message.includes('mcp_tool_not_read_only')
}

interface ServerRow { name?: unknown; title?: unknown; owner?: unknown; state?: unknown; sessions?: unknown; toolCount?: unknown; lastError?: unknown }
interface ToolRow { name?: unknown; description?: unknown; readOnly?: unknown; destructive?: unknown; inputSchema?: unknown }

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const firstLine = (text: string, max = 100): string => {
  const line = text.split('\n').map((one) => one.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function formatMcpServers(result: unknown): string {
  const servers = ((result as { servers?: ServerRow[] } | undefined)?.servers ?? [])
  if (servers.length === 0) return 'No MCP servers are registered. A plugin registers one (Settings, Plugins).'
  const lines = servers.map((server) => {
    const tools = typeof server.toolCount === 'number' ? `, ${server.toolCount} tools` : ''
    const error = server.lastError ? `\n    ${str(server.lastError)}` : ''
    return `${str(server.name)}  ${str(server.state)}${tools}  sessions: ${str(server.sessions)}  (plugin ${str(server.owner)})${error}`
  })
  return lines.join('\n')
}

export function formatMcpTools(result: unknown): string {
  const tools = ((result as { tools?: ToolRow[] } | undefined)?.tools ?? [])
  if (tools.length === 0) return 'This server lists no tools.'
  const width = Math.min(40, Math.max(...tools.map((tool) => str(tool.name).length)))
  return tools
    .map((tool) => `${str(tool.name).padEnd(width)}  ${tool.readOnly === true ? 'ro' : 'rw'}  ${firstLine(str(tool.description))}`)
    .join('\n')
}

export function formatMcpToolHelp(result: unknown, toolName: string): string | null {
  const tools = ((result as { tools?: ToolRow[] } | undefined)?.tools ?? [])
  const tool = tools.find((one) => one.name === toolName)
  if (!tool) return null
  const kind = tool.readOnly === true ? 'read-only' : tool.destructive === true ? 'changes or deletes something' : 'changes something'
  return [
    `${toolName} (${kind})`,
    '',
    str(tool.description).trim(),
    '',
    'Input schema:',
    JSON.stringify(tool.inputSchema ?? {}, null, 2),
  ].join('\n')
}
