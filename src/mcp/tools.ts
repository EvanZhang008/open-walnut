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
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getOp, listOps, opNames, executeOp, resolveApiBase } from '../ops/index.js'
import { opInputJsonSchema } from '../ops/registry.js'
import { LOCAL_ORIGIN } from '../lib/caller-origin.js'

export { resolveApiBase }

/**
 * Read/write tool name sets — derived from the registry now, kept as exports
 * because tests and callers pin the surface through them. They are taken when
 * this module is imported, so they hold the builtin ops only: an op a plugin
 * registers later (the calendar's) is missing. Call opNames() for the live set.
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
 * The ops a `core` server lists in full; every other op is reached through
 * tool_help and tool_call. An engine with no on-demand tool loading (OpenCode,
 * Goose) puts every listed schema into every model call, and all 131 ops came to
 * about 223 KB (some 56k tokens): a local model spent most of a
 * 95 to 172 s Ask Walnut turn reading them, and a context of 32k cut them off
 * (2026-11-01, measured through a proxy in front of Ollama). Claude Code loads
 * MCP tools on demand and keeps the full list.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'task_list', 'task_get', 'task_create', 'task_update', 'task_complete', 'task_send',
  'task_history', 'open_items', 'project_list', 'search', 'note_search', 'note_read', 'memory_read',
]

type GatewayHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

/** Register the two tools that reach every op a `core` server does not list; returns their handlers. */
function registerOpGateway(server: McpServer, base: string, readonly: boolean): Map<string, GatewayHandler> {
  const allowed = (name: string) => {
    // A model that read the engine's own prefixed names (OpenCode lists walnut_task_list) may send one.
    const op = getOp(name) ?? (name.startsWith('walnut_') ? getOp(name.slice('walnut_'.length)) : undefined)
    return op && listOps({ includeDeprecated: true }).some((o) => o.name === op.name) && (!readonly || op.tags.readonly) ? op : undefined
  }
  const help = async (args: { name?: unknown; filter?: unknown }): Promise<CallToolResult> => {
    if (typeof args.name === 'string' && args.name) {
      const op = allowed(args.name)
      if (!op) return fail(`No Walnut tool named ${args.name}. Call tool_help with no name for the list.`)
      return ok({ name: op.name, title: op.title, description: op.description, arguments: opInputJsonSchema(op) })
    }
    const word = typeof args.filter === 'string' ? args.filter.toLowerCase() : undefined
    const rows = listOps().filter((op) => (!readonly || op.tags.readonly)
      && (!word || op.name.includes(word) || op.title.toLowerCase().includes(word)))
    return { content: [{ type: 'text', text: rows.map((op) => `${op.name}: ${op.title}`).join('\n') || 'No tool matches.' }] }
  }
  const call = async (args: { name?: unknown; args?: unknown }): Promise<CallToolResult> => {
    const op = typeof args.name === 'string' ? allowed(args.name) : undefined
    if (!op) return fail(`No Walnut tool named ${String(args.name)}. Call tool_help with no name for the list.`)
    // A small model often sends the arguments as a JSON string.
    let given = args.args
    if (typeof given === 'string') { try { given = JSON.parse(given) } catch { return fail('tool_call args must be an object of the tool\'s arguments') } }
    if (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given))) {
      return fail('tool_call args must be an object of the tool\'s arguments')
    }
    const opArgs = (given ?? {}) as Record<string, unknown>
    const r = await executeOp(op.name, opArgs, { apiBase: base, origin: LOCAL_ORIGIN })
    return r.ok ? ok(r.result) : r.result !== undefined ? { ...ok(r.result), isError: true } : fail(r.message)
  }
  server.registerTool('tool_help', {
    title: 'List Walnut tools, or show one tool\'s arguments',
    description: 'Walnut has more tools than the ones listed here (boards, triggers, notes, folders, hosts, time, health and more). '
      + 'With no name: every tool name with its title (filter narrows by a word). With name: that tool\'s full description and '
      + 'its argument schema. Then run it with tool_call.',
    inputSchema: { name: z.string().optional().describe('A tool name, e.g. "board_post"'), filter: z.string().optional().describe('A word to narrow the list, e.g. "board"') },
    annotations: { readOnlyHint: true },
  }, help)
  server.registerTool('tool_call', {
    title: 'Run any Walnut tool by name',
    description: 'Runs the Walnut tool `name` with `args` (an object with that tool\'s arguments; tool_help name=<tool> shows them).',
    inputSchema: { name: z.string().describe('The tool name, e.g. "board_post"'), args: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe('Its arguments, as an object') },
    ...(readonly ? { annotations: { readOnlyHint: true } } : {}),
  }, call)
  return new Map<string, GatewayHandler>([['tool_help', help as GatewayHandler], ['tool_call', call as GatewayHandler]])
}

/**
 * Register Walnut's registry ops on an McpServer. `readonly` restricts the
 * surface to readonly-tagged ops (nothing that mutates the user's data is even
 * advertised, so a read-only consumer cannot be talked into a write).
 */
export function registerWalnutTools(
  server: McpServer,
  options: { readonly?: boolean; apiBase?: string; core?: boolean } = {},
): void {
  const base = resolveApiBase(options.apiBase)

  for (const op of listOps()) {
    if (options.readonly && !op.tags.readonly) continue
    if (options.core && !CORE_TOOL_NAMES.includes(op.name)) continue
    server.registerTool(op.name, {
      title: op.title,
      description: op.description,
      inputSchema: op.input,
      annotations: {
        ...(op.tags.readonly ? { readOnlyHint: true } : {}),
        ...(op.tags.destructive !== undefined ? { destructiveHint: op.tags.destructive } : {}),
      },
      // Claude Code defers ALL MCP tools behind ToolSearch by default
      // (ENABLE_TOOL_SEARCH unset → 'tst' mode): they never appear in the
      // initial prompt, so the Personal AI never used them — it fell back to
      // the Bash/curl paths its skill teaches (observed live 2026-08-16:
      // init carried 0 mcp__ tools, debug showed "0/17 deferred included").
      // 'anthropic/alwaysLoad' is the per-tool opt-out the CLI honors; these
      // ops ARE the session's primary interface to Walnut, so they must be
      // visible from turn 1. ~17 small schemas ≈ a modest one-time prompt
      // cost, far cheaper than every op-call spawning a CLI via Bash.
      _meta: { 'anthropic/alwaysLoad': true },
    }, async (args: Record<string, unknown>) => {
      // A separate process: the server re-judges its socket, and can only lower this.
      const r = await executeOp(op.name, args ?? {}, { apiBase: base, origin: LOCAL_ORIGIN })
      return r.ok ? ok(r.result) : r.result !== undefined ? { ...ok(r.result), isError: true } : fail(r.message)
    })
  }
  const gateway = options.core ? registerOpGateway(server, base, !!options.readonly) : undefined
  // The MCP catalog leaves out old names, but explicit calls from existing clients still go through the same validation and permission checks.
  const callable = new Set(listOps({ includeDeprecated: true }).filter((op) => !options.readonly || op.tags.readonly).map((op) => op.name))
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const viaGateway = gateway?.get(params.name)
    if (viaGateway) return viaGateway(params.arguments ?? {})
    const op = getOp(params.name)
    if (!op || !callable.has(op.name) || (options.readonly && !op.tags.readonly)) return fail(`Tool ${params.name} not found`)
    const result = await executeOp(op.name, params.arguments ?? {}, { apiBase: base, origin: LOCAL_ORIGIN })
    return result.ok ? ok(result.result)
      : result.result !== undefined ? { ...ok(result.result), isError: true } : fail(result.message)
  })
}
