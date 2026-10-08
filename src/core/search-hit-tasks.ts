/**
 * The phone's extras on GET /api/v1/search (and the `server.search` relay that
 * answers the same call for the cloud companion).
 *
 * `tasks=1`: the response also carries the task each task or session row names,
 * in the ProjectedTask shape GET /api/v1/tasks serves. The phone's task list only
 * holds open tasks and the last 14 days of completed ones, so without this a hit on
 * an older completed task could be neither drawn as a task row (no phase) nor
 * opened. The web console needs none of it: it loads the whole archive in search.
 *
 * `semanticWaitMs=`: how long the semantic lane may wait for the query embedding.
 * The 150 ms default is sized for the web list, which searches on every typing
 * pause; on 2026-10-08 it timed out on 6 of 21 fresh queries, which then ranked by
 * keywords alone. The phone sends a longer wait: its local rows are already on
 * screen and the server's rows append below them.
 */

import { log } from '../logging/index.js'
import type { SearchResult } from './search.js'
import type { ProjectedTask } from './task-projection.js'

/** The most any caller may ask the semantic lane to wait (same cap as /api/search). */
export const MAX_SEARCH_SEMANTIC_WAIT_MS = 5000

/** A wait in ms from a query string or JSON number, clamped; undefined keeps the library default. */
export function clampSemanticWaitMs(raw: unknown): number | undefined {
  const asked = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN
  if (!Number.isFinite(asked)) return undefined
  return Math.max(0, Math.min(MAX_SEARCH_SEMANTIC_WAIT_MS, Math.round(asked)))
}

/** `tasks=1` / `tasks=true` on the query, or `tasks: true` in a relay payload. */
export function wantsHitTasks(raw: unknown): boolean {
  return raw === true || raw === '1' || raw === 'true'
}

/**
 * The tasks the rows name, once each, in the rows' order. Memory rows and session
 * rows with no owning task name none. Best effort: a task store that cannot answer
 * returns undefined, and the caller serves the rows alone.
 */
export async function searchHitTasks(results: readonly SearchResult[]): Promise<ProjectedTask[] | undefined> {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of results) {
    if (row.type === 'memory' || !row.taskId || seen.has(row.taskId)) continue
    seen.add(row.taskId)
    ids.push(row.taskId)
  }
  if (ids.length === 0) return []
  try {
    const [{ listTasksByIds }, { projectTask }] = await Promise.all([
      import('./task-manager.js'),
      import('./task-projection.js'),
    ])
    const byId = new Map((await listTasksByIds(ids)).map((task) => [task.id, task]))
    const out: ProjectedTask[] = []
    for (const id of ids) {
      const task = byId.get(id)
      if (task) out.push(projectTask(task))
    }
    return out
  } catch (err) {
    log.web.warn('v1 search: the hit tasks could not be read, serving the rows alone', {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
