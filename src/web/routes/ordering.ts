/**
 * Ordering routes — the project display order (single grouping layer), stored
 * flat in config as `ordering.projects: string[]`, plus the hand-placed tier
 * divider lines (`ordering.separators`).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import type { Config } from '../../core/types.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { testRunPrefsRead, testRunPrefsWrite } from '../../core/test-run-prefs.js'

export const orderingRouter = Router()

type Separator = NonNullable<NonNullable<Config['ordering']>['separators']>[number]

/** A separator is decoration, so the ceiling is only there to keep a runaway
 *  client from growing config without bound. Well past any hand-placed count. */
const MAX_SEPARATORS = 500

/** Accept only fully-formed rows and normalize the optional fields, so the
 *  renderer never has to defend against a half-written entry. Anything else is
 *  rejected outright (400) rather than silently dropped — a line the user
 *  placed that quietly vanishes is worse than an error. */
function parseSeparator(raw: unknown): Separator | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.tier !== 'string' || !r.tier) return null
  if (r.mode !== 'project' && r.mode !== 'custom') return null
  if (r.project !== undefined && typeof r.project !== 'string') return null
  if (r.after !== undefined && typeof r.after !== 'string') return null
  if (r.before !== undefined && typeof r.before !== 'string') return null
  if (r.afterProject !== undefined && typeof r.afterProject !== 'string') return null
  if (r.beforeProject !== undefined && typeof r.beforeProject !== 'string') return null
  // The client classifies ids by prefix (isSeparatorId) and splices them into
  // dnd items / render arrays — an id colliding with a task id would duplicate
  // that task in both. The UI can only mint sep_* ids (newSeparatorId); reject
  // anything else at the trust boundary.
  if (!r.id.startsWith('sep_')) return null
  if (r.label !== undefined && typeof r.label !== 'string') return null
  // A named line is a section heading; empty text degrades to a plain line
  // rather than persisting a heading that renders as nothing. Stored TRIMMED —
  // the emptiness gate reads the trimmed value, so the stored one must match.
  const label = typeof r.label === 'string' && r.label.trim() !== ''
    ? { label: r.label.trim().slice(0, 200) }
    : {}
  // Each mode keeps only the anchors it can act on, so one line can never carry
  // two conflicting positions. 'project' anchors on FOLDERS (a folder is one unit
  // there), 'custom' anchors on cards.
  if (r.mode === 'project') {
    return {
      id: r.id,
      tier: r.tier,
      mode: r.mode,
      ...label,
      // Absent stays absent: '' is Inbox, a real folder, so it cannot double as
      // "no folder on that side".
      ...(r.afterProject !== undefined ? { afterProject: r.afterProject as string } : {}),
      ...(r.beforeProject !== undefined ? { beforeProject: r.beforeProject as string } : {}),
      // Legacy rows (a line that used to sit inside a run) keep their field so the
      // renderer can still resolve them to that folder's top edge.
      ...(r.project !== undefined && r.afterProject === undefined && r.beforeProject === undefined
        ? { project: r.project as string }
        : {}),
    }
  }
  return {
    id: r.id,
    tier: r.tier,
    mode: r.mode,
    ...label,
    after: (r.after as string | undefined) ?? '',
    before: (r.before as string | undefined) ?? '',
  }
}

// GET /api/ordering
export interface Ordering { projects: string[]; separators: Separator[] }

/** The order this request reads: config.yaml, with a test run's own lists on top (test-run-prefs.ts). */
export async function readOrdering(): Promise<Ordering> {
  const config = await getConfig()
  return withTestRunOrdering({ projects: config.ordering?.projects ?? [], separators: config.ordering?.separators ?? [] })
}

/** `o` with the lists the current test run set (as is for a real request). */
export function withTestRunOrdering(o: Ordering): Ordering {
  const own = testRunPrefsRead<Partial<Ordering>>('ordering')
  return own ? { ...o, ...own } : o
}

/** Set one part of the order: a test run's own copy, else config.yaml. */
export async function writeOrdering<K extends keyof Ordering>(key: K, value: Ordering[K]): Promise<Ordering[K]> {
  const own = testRunPrefsWrite<Partial<Ordering>>('ordering', () => ({}))
  if (own) { own[key] = value; return value }
  const config = await getConfig()
  if (!config.ordering) config.ordering = {}
  config.ordering[key] = value
  await updateConfig({ ordering: config.ordering })
  bus.emit(EventNames.CONFIG_CHANGED, { key: 'ordering' }, ['web-ui'])
  return value
}

orderingRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await readOrdering())
  } catch (err) {
    next(err)
  }
})

// PUT /api/ordering/separators — replace the whole separator list
orderingRouter.put('/separators', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { separators } = req.body as { separators: unknown }
    if (!Array.isArray(separators)) {
      res.status(400).json({ error: 'separators must be an array' })
      return
    }
    if (separators.length > MAX_SEPARATORS) {
      res.status(400).json({ error: `too many separators (max ${MAX_SEPARATORS})` })
      return
    }
    const parsed: Separator[] = []
    for (const raw of separators) {
      const sep = parseSeparator(raw)
      if (!sep) {
        res.status(400).json({ error: 'each separator needs { id, tier, mode: "project"|"custom" } with string after/before (custom) or afterProject/beforeProject (project)' })
        return
      }
      parsed.push(sep)
    }
    // Last id wins — a client that replays a stale list can't fork one line into two.
    const deduped = [...new Map(parsed.map((s) => [s.id, s])).values()]
    res.json({ separators: await writeOrdering('separators', deduped) })
  } catch (err) {
    next(err)
  }
})

// PUT /api/ordering/projects — replace the flat project order
orderingRouter.put('/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { order } = req.body as { order: string[] }
    if (!Array.isArray(order) || !order.every((p) => typeof p === 'string')) {
      res.status(400).json({ error: 'order must be an array of strings' })
      return
    }
    res.json({ projects: await writeOrdering('projects', order) })
  } catch (err) {
    next(err)
  }
})
