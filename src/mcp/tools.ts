/**
 * Walnut MCP tools — rendered from the shared operation registry (src/ops/).
 *
 * This module no longer declares any tool of its own: every tool the MCP
 * server advertises is a registry op, executed by the same executor the CLI's
 * `walnut tools call` and the daemon gateway use. One registry, one behavior,
 * three surfaces (docs/plan/unified-cli-mcp.md).
 *
 * Split read vs write is preserved: `--readonly` registers only ops tagged
 * readonly, so a read-only consumer cannot be talked into a write — the write
 * ops are not even advertised.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { listOps, opNames, executeOp, resolveApiBase } from '../ops/index.js'

export { resolveApiBase }

/**
 * Read/write tool name sets — derived from the registry now, kept as exports
 * because tests and callers pin the surface through them.
 */
export const READ_TOOL_NAMES: readonly string[] = opNames({ readonly: true })
export const WRITE_TOOL_NAMES: readonly string[] = opNames({ readonly: false })

/** JSON text content — the one result shape every tool returns on success. */
function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** MCP tool error (isError) carrying a human-readable message. */
function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/**
 * Register Walnut's registry ops on an McpServer. `readonly` restricts the
 * surface to readonly-tagged ops (nothing that mutates the user's data is even
 * advertised, so a read-only consumer cannot be talked into a write).
 */
export function registerWalnutTools(
  server: McpServer,
  options: { readonly?: boolean; apiBase?: string } = {},
): void {
  const base = resolveApiBase(options.apiBase)

  for (const op of listOps()) {
    if (options.readonly && !op.tags.readonly) continue
    server.registerTool(op.name, {
      title: op.title,
      description: op.description,
      inputSchema: op.input,
      annotations: {
        ...(op.tags.readonly ? { readOnlyHint: true } : {}),
        ...(op.tags.destructive !== undefined ? { destructiveHint: op.tags.destructive } : {}),
      },
    }, async (args: Record<string, unknown>) => {
      const r = await executeOp(op.name, args ?? {}, { apiBase: base })
      return r.ok ? ok(r.result) : fail(r.message)
    })
  }
}
