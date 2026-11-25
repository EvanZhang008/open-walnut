/**
 * The minute counters the real-use recorder writes (record.ts) and Walnut Health keeps as sums
 * (health-monitor/collect.ts). A leaf module, so the collector never loads the recorder.
 */
export const USAGE_COUNTERS = [
  'usage.op.cut', 'usage.op.errors', 'usage.op.watched_errors', 'usage.op.bad_args', 'usage.op.over_limit', 'usage.op.mount_failed',
  'usage.http.slow', 'usage.http.server_errors', 'usage.page.errors',
] as const

/** A label value as a series key can hold it (evaluate.ts splits keys on `,`, `=`, `{` and `}`). */
export function labelValue(v: string): string {
  return v.replace(/[,{}=]/g, '_').slice(0, 160)
}

/** The name a session's Walnut MCP mount is counted under (record.ts recordMountVerdict): no op has it. */
export const MOUNT_OP = 'mcp/mount'

/** The MCP method a short or gone tool list is counted under (gateway-record.ts, mount-watch.ts): no op has it. */
export const SHORT_LIST_OP = 'tools/list'

/** What real use counts under an op's name that is no op, so a watch or a report can name it. */
export const RECORDED_NON_OPS: readonly string[] = [MOUNT_OP, SHORT_LIST_OP]
