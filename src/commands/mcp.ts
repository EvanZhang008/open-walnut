/**
 * CLI command: open-walnut mcp [--readonly] [--core]
 *
 * Thin adapter between commander options and the stdio MCP server
 * (src/mcp/server.ts). Kept separate so the command module stays lazy-loadable
 * like every other subcommand — importing the MCP SDK costs nothing until
 * someone actually runs `open-walnut mcp`.
 */

interface McpCliOptions {
  readonly?: boolean
  apiUrl?: string
  core?: boolean
}

export async function runMcp(options: McpCliOptions = {}): Promise<void> {
  const { runMcp: serve } = await import('../mcp/server.js')
  // WALNUT_MCP_CORE=1 is how an ACP mount asks (src/providers/acp-worker/protocol.ts withCoreWalnutTools).
  const core = !!options.core || process.env.WALNUT_MCP_CORE === '1'
  await serve({ readonly: !!options.readonly, apiBase: options.apiUrl, core })
}
