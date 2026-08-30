/**
 * Search route — full-text + semantic search across tasks and memory.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { search, type SearchResult } from '../../core/search.js'
import { prewarmAgentSearchChild } from '../../core/task-search-agent.js'
import { listTasksByIds } from '../../core/task-manager.js'
import { sessionRefTag, taskRefTag } from '../../utils/entity-refs.js'

const SLIM_SUMMARY_CHARS = 120

const SEARCH_TYPES = ['task', 'memory', 'session'] as const
type SearchType = (typeof SEARCH_TYPES)[number]

/**
 * Slim result row for agent/CLI callers (?slim=1): one short line per hit
 * instead of a 3KB+ snippet, mirroring /api/tasks?slim=1. Exists because
 * agents were `head -c` truncating the verbose payload mid-JSON and losing
 * results — search is a broad-and-fast list surface; callers open the full
 * record next. The Personal AI prompt (sessions/profiles.ts) points every Personal AI
 * session at this mode; the web UI stays on the verbose default.
 */
interface SlimSearchResult {
  type: SearchResult['type']
  id: string
  title: string
  summary: string
  phase?: string
  project?: string
  ref?: string
  /** True when this row was injected as a child of a matching parent task,
   * not a direct hit — carried through so agents don't cite it as a match. */
  isAutoExpanded?: boolean
}

function oneLineSummary(snippet: string): string {
  const flat = snippet.replace(/\s+/g, ' ').trim()
  if (flat.length <= SLIM_SUMMARY_CHARS) return flat
  // Slice by code point, not code unit — a UTF-16 slice can split a surrogate
  // pair (emoji), and the resulting lone surrogate makes jq reject the WHOLE
  // response, which is exactly the failure mode slim=1 exists to prevent.
  return [...flat].slice(0, SLIM_SUMMARY_CHARS).join('') + '…'
}

async function toSlimResults(results: SearchResult[]): Promise<SlimSearchResult[]> {
  // Batch-resolve phase/project for task hits (score/snippet come from the
  // search index, which deliberately doesn't carry task lifecycle fields).
  // Enrichment is best-effort: if the task DB is unavailable, degrade to rows
  // without phase/project rather than turning already-computed search results
  // into a 500 (the verbose path never touches the task DB).
  const taskIds = [...new Set(
    results.filter((r) => r.type === 'task' && r.taskId).map((r) => r.taskId!),
  )]
  let tasksById = new Map<string, Awaited<ReturnType<typeof listTasksByIds>>[number]>()
  try {
    tasksById = new Map((await listTasksByIds(taskIds)).map((task) => [task.id, task]))
  } catch (err) {
    log.web.warn('slim search: task enrichment failed — returning rows without phase/project', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return results.map((r) => {
    const base: SlimSearchResult = {
      type: r.type,
      // Task/session rows carry their entity id; memory rows carry the file
      // path (absolute — the Personal AI Reads it directly; same as verbose mode).
      id: r.taskId ?? r.sessionId ?? r.path ?? '',
      title: r.title,
      summary: oneLineSummary(r.snippet),
    }
    if (r.isAutoExpanded) base.isAutoExpanded = true
    if (r.type === 'task' && r.taskId) {
      const task = tasksById.get(r.taskId)
      if (task) {
        base.phase = task.phase
        if (task.project) base.project = task.project
      }
      // ref is emitted even when enrichment missed (task deleted mid-flight
      // or DB down) — the pill still renders from id + title.
      base.ref = taskRefTag(r.taskId, r.title)
    } else if (r.type === 'session' && r.sessionId) {
      base.ref = sessionRefTag(r.sessionId, r.title)
    }
    return base
  })
}

export const searchRouter = Router()

// GET /api/search?q=...&types=task,memory&limit=20&slim=1
searchRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string) ?? ''
    // `type` (singular) is accepted as an alias: it was silently ignored for
    // months and every caller who guessed the param name got the default lanes
    // with no signal anything was wrong (the 2026-08-15 star-system hunt).
    const typesParam = (req.query.types ?? req.query.type) as string | undefined
    let types: SearchType[] | undefined
    if (typesParam) {
      // Validate against the allowlist — the raw param feeds a metric label in
      // search(), and unvalidated values would mint unbounded metric series
      // (the registry caps at 500 process-wide, then drops ALL new series).
      const requested = typesParam.split(',')
      const invalid = requested.filter((t) => !SEARCH_TYPES.includes(t as SearchType))
      if (invalid.length > 0) {
        res.status(400).json({ error: `invalid types: ${invalid.join(', ')} (valid: ${SEARCH_TYPES.join(', ')})` })
        return
      }
      types = [...new Set(requested)] as SearchType[]
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined
    const slim = req.query.slim === '1'

    // A verbose search = the human search box (agents/CLI use slim=1); it
    // fires ~500ms before the AI lane's debounce, so pre-boot that lane's
    // CLI child now — by the time the agent query lands, boot is done.
    if (!slim) prewarmAgentSearchChild()

    const results = await search(q, { types, limit })
    res.json({ results: slim ? await toSlimResults(results) : results })
  } catch (err) {
    next(err)
  }
})
