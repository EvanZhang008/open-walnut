/**
 * CLI command: open-walnut mcp [--readonly]
 *
 * Thin adapter between commander options and the stdio MCP server
 * (src/mcp/server.ts). Kept separate so the command module stays lazy-loadable
 * like every other subcommand — importing the MCP SDK costs nothing until
 * someone actually runs `open-walnut mcp`.
 */

interface McpCliOptions {
  readonly?: boolean
  apiUrl?: string
}

export async function runMcp(options: McpCliOptions = {}): Promise<void> {
  const { runMcp: serve } = await import('../mcp/server.js')
  await serve({ readonly: !!options.readonly, apiBase: options.apiUrl })
}
