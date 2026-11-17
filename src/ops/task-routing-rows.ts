/**
 * The lines a sender reads to tell whether new work is a task's own deliverable
 * (core/task-deliverable.ts routingView), put on the rows of the ops that find tasks: search's task
 * rows and task_list's by_meaning rows. Finding an owner is search two or three ways, read each
 * candidate's deliverable, first request and latest report, and decide by meaning; with these lines
 * on the rows the read costs no extra call per candidate.
 */
import { routingView } from '../core/task-deliverable.js'
import type { HttpBinding } from './registry.js'
import { materializeBinding } from './executor.js'
import type { OpCall } from './core.js'

// Server-root-absolute: /api/tasks is the canonical composable-query route (the
// same engine the web UI filters ride), not the frozen /api/v1 mobile projection.
export const TASK_LIST_BINDING: HttpBinding = { method: 'GET', path: '/api/tasks' }

/** The most task rows one search answer decorates (its first ones, in its order). */
export const ROUTING_ROWS_MAX = 12

/** These tasks' full rows (note and reports included), by id. A store that cannot answer gives none. */
export async function fullTaskRows(call: OpCall, ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!ids.length) return new Map()
  const { path } = materializeBinding(TASK_LIST_BINDING, { ids: [...ids], limit: ids.length })
  const listed = await call('GET', path) as { tasks?: Array<Record<string, unknown>> } | undefined
  return new Map((listed?.tasks ?? []).map((t) => [String(t.id), t] as const))
}

type SearchRow = { type?: string; taskId?: string } & Record<string, unknown>

/**
 * search's answer with each task row carrying its phase, deliverable, first request and latest
 * report. Best effort: when the rows cannot be read, the answer goes as search gave it.
 */
export async function withTaskRouting(body: unknown, call: OpCall): Promise<unknown> {
  const b = body as { results?: SearchRow[] } | undefined
  const results = Array.isArray(b?.results) ? b!.results : undefined
  if (!results) return body
  const ids = [...new Set(results.filter((r) => r.type === 'task' && typeof r.taskId === 'string' && r.taskId).map((r) => r.taskId!))]
    .slice(0, ROUTING_ROWS_MAX)
  if (!ids.length) return body
  const rows = await fullTaskRows(call, ids).catch(() => new Map<string, Record<string, unknown>>())
  if (!rows.size) return body
  return {
    ...(b as Record<string, unknown>),
    results: results.map((r) => {
      const t = r.type === 'task' && r.taskId ? rows.get(r.taskId) : undefined
      if (!t) return r
      return { ...r, ...(typeof t.phase === 'string' ? { phase: t.phase } : {}), ...routingView(t) }
    }),
  }
}
