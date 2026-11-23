/**
 * Failed Walnut tool calls by session, op, error code or host (`usage_watch {"action":"errors"}`).
 *
 * 2026-11-23, the daily audit (Reflection VP): "tool and op errors readable by session, by op and
 * by error code, Mac and clouddev, without reading raw JSONL". The session hook records every
 * failed call a session's agent read, on every host (session-hook.ts, store.ts tool_errors), so
 * a refusal the server never saw (Walnut unreachable, a tool gone after a disconnect, Claude Code
 * refusing the input) is counted too. Ids, names and codes only, never what the call said.
 */
import { oldestToolError, readToolErrors, type ToolErrorRow } from './store.js'

export const ERROR_GROUPS = ['op', 'code', 'session', 'host'] as const
export type ErrorGroup = typeof ERROR_GROUPS[number]

const ROWS = 20
const SAMPLE = 10

export interface ErrorRow {
  key: string
  errors: number
  /** The other groupings of this row's errors, most first (the top few). */
  codes?: Record<string, number>
  ops?: Record<string, number>
  sessions?: number
  task?: string
  host?: string
  last: string
}

function top(counts: Map<string, number>, n = 5): Record<string, number> {
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, n))
}

function keyOf(r: ToolErrorRow, by: ErrorGroup): string {
  return by === 'op' ? r.op : by === 'code' ? r.code : by === 'host' ? r.host : r.sid
}

export function toolErrorsReport(opts: { range: '24h' | '7d'; by: ErrorGroup; session?: string; now?: number }): {
  range: string; by: ErrorGroup; from: string; total: number; rows: ErrorRow[]; more: number; hosts: Record<string, number>
  /** When the record starts, when that is inside the range: before it nothing was recorded, not nothing failed. */
  dataFrom?: string
  recent?: { at: string; op: string; code: string; client: string; host: string }[]
} {
  const now = opts.now ?? Date.now()
  const since = now - (opts.range === '24h' ? 24 : 7 * 24) * 3_600_000
  const all = readToolErrors({ since, ...(opts.session ? { session: opts.session } : {}) })
  const groups = new Map<string, ToolErrorRow[]>()
  const hosts = new Map<string, number>()
  for (const r of all) {
    const k = keyOf(r, opts.by)
    const g = groups.get(k)
    if (g) g.push(r); else groups.set(k, [r])
    hosts.set(r.host, (hosts.get(r.host) ?? 0) + 1)
  }
  const rows = [...groups].sort((a, b) => b[1].length - a[1].length).map(([key, rs]): ErrorRow => {
    const codes = new Map<string, number>()
    const ops = new Map<string, number>()
    const sids = new Set<string>()
    for (const r of rs) {
      codes.set(r.code, (codes.get(r.code) ?? 0) + 1)
      ops.set(r.op, (ops.get(r.op) ?? 0) + 1)
      sids.add(r.sid)
    }
    const first = rs[0]!
    return {
      key, errors: rs.length,
      ...(opts.by !== 'code' ? { codes: top(codes) } : {}),
      ...(opts.by !== 'op' ? { ops: top(ops) } : {}),
      ...(opts.by !== 'session' ? { sessions: sids.size } : { ...(first.taskId ? { task: first.taskId } : {}), host: first.host }),
      last: new Date(first.at).toISOString(),
    }
  })
  return {
    range: opts.range, by: opts.by, from: new Date(since).toISOString(), total: all.length,
    ...(() => { const o = oldestToolError(); return o !== null && o > since ? { dataFrom: new Date(o).toISOString() } : {} })(),
    rows: rows.slice(0, ROWS), more: Math.max(0, rows.length - ROWS), hosts: top(hosts, 10),
    // One session asked for: its latest failures one by one.
    ...(opts.session ? { recent: all.slice(0, SAMPLE).map((r) => ({ at: new Date(r.at).toISOString(), op: r.op, code: r.code, client: r.client, host: r.host })) } : {}),
  }
}
