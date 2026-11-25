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
