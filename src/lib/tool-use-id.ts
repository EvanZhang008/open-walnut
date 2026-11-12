/**
 * The tool call an op runs for. Claude Code names it in every MCP tools/call
 * (`_meta["claudecode/toolUseId"]`); Walnut's MCP servers hand it to the ops that
 * tie what they start to that call (a light subagent's Background tasks row to the
 * chat's tool block), as the `tool_use_id` argument those ops declare.
 */
const META_KEY = 'claudecode/toolUseId'
const OPS_TAKING_IT = new Set(['subagent_run'])

export function withToolUseId(op: string, args: Record<string, unknown>, meta: unknown): Record<string, unknown> {
  if (!OPS_TAKING_IT.has(op) || args.tool_use_id !== undefined) return args
  const id = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[META_KEY] : undefined
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? { ...args, tool_use_id: id } : args
}
