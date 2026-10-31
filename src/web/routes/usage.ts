/**
 * Usage tracking routes — token/cost summaries and breakdowns.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { DEFAULT_PRICING, PRICING_VERSION } from '../../core/usage/index.js'
import type { UsagePeriod, UsageFilter } from '../../core/usage/types.js'
import { reconciledOverview, collectUsage, collectionState, INCREMENTAL, responseUsageStore } from '../../core/usage/collection.js'

export const usageRouter = Router()

// GET /api/usage/overview — every aggregate under one cross-filter, in one call.
// Query params (all optional, ANDed): start, end (YYYY-MM-DD), source, model, agent.
// This is the endpoint the interactive dashboard uses; the older per-view
// endpoints below stay for back-compat.
usageRouter.get('/overview', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: UsageFilter = {
      startDate: parseDate(req.query.start),
      endDate: parseDate(req.query.end),
      source: parseTok(req.query.source),
      model: parseTok(req.query.model),
      agentId: parseTok(req.query.agent),
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500)
    res.json(reconciledOverview(filter, limit))
  } catch (err) { next(err) }
})

// GET /api/usage/costs?view=all|walnut|agents&start&end&engine: the Usage & Costs page,
// dollars (tokens x public prices) and tokens for a period, read from the
// per-day sums (cost-report.ts), never from the per-response table. `engine`
// (claude, codex, opencode, goose...) counts one coding engine; agents view only.
usageRouter.get('/costs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const view = req.query.view === 'agents' || req.query.view === 'all' ? req.query.view : 'walnut'
    const [{ buildCostReport }, { getConfig }, { listTasksByIds }, { listSessions }] = await Promise.all([
      import('../../core/usage/cost-report.js'), import('../../core/config-manager.js'),
      import('../../core/task-manager.js'), import('../../core/session-tracker.js'),
    ])
    const store = responseUsageStore()
    const engine = typeof req.query.engine === 'string' && req.query.engine !== 'all' ? req.query.engine : undefined
    const report = await buildCostReport(view, { start: parseDate(req.query.start), end: parseDate(req.query.end), engine }, {
      rollup: store.rollup, db: store.database, timeZone: store.timezone, overrides: (await getConfig()).usage?.prices,
      tasks: async (ids) => new Map((ids.length ? await listTasksByIds(ids) : []).map(t => [t.id, { title: t.title, project: t.project ?? '' }])),
      sessions: async () => new Map((await listSessions()).map(s => [s.claudeSessionId, {
        title: s.title, taskId: s.taskId || undefined, project: s.project, engine: s.engine }])),
    })
    res.json({ ...report, timeZone: store.timezone, bounds: store.rollup.bounds(), countedUntil: store.countedUntil(),
      checks: store.sourceChecks(), collection: collectionState() })
  } catch (err) { next(err) }
})

usageRouter.post('/collect', (req: Request, res: Response) => {
  const { since, until } = req.body ?? {}
  const valid = (value: unknown) => value === undefined || (typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)))
  if (!valid(since) || !valid(until) || (since && Date.parse(since) >= Date.parse(until ?? new Date().toISOString()))) {
    res.status(400).json({ error: 'Invalid usage collection window. Use timestamps with an explicit timezone.' })
    return
  }
  void collectUsage(since ?? (req.body?.full ? undefined : INCREMENTAL), until).catch(() => {})
  res.status(202).json(collectionState())
})
usageRouter.get('/collection', (_req: Request, res: Response) => res.json(collectionState()))

// NOT_FOUND is the owning daemon not knowing the session: a new one, a stored one
// no daemon runs, and also one a host has not adopted yet after a restart, so the
// web store keeps a budget it already showed when null comes back.
const NO_BUDGET_CODES = new Set(['budget_unsupported', 'session_not_found', 'NOT_FOUND'])
usageRouter.get('/sessions/:sid', async (req: Request, res: Response) => {
  try {
    const { getSessionBudget } = await import('../../core/usage/session-budget.js')
    res.json(await getSessionBudget(String(req.params.sid)))
  } catch (error) {
    const failure = error as Error & { code?: string; status?: number }
    // No budget here is an answer, not an error: an engine without per-request usage, or
    // a session whose record is not written yet (its panel mounts first) or that its
    // host does not know. 2026-10-30: every Gemini, Goose, Pi and DeepSeek panel, and
    // every new session, logged one. A JSON null, not a 204, which Chromium reports as
    // a failed (aborted) request. Only for a client that asks (`absent=null`): an
    // older bundle, in a window open across the deploy, reads `null.sessionId`.
    if (req.query.absent === 'null' && NO_BUDGET_CODES.has(failure.code ?? '')) { res.json(null); return }
    res.status(failure.status ?? 503).json({ error: failure.message, code: failure.code ?? 'budget_unavailable' })
  }
})
usageRouter.patch('/sessions/:sid/budget', async (req: Request, res: Response) => {
  const { limitUsd, revision } = req.body ?? {}
  if (!(limitUsd === null || (typeof limitUsd === 'number' && Number.isFinite(limitUsd) && limitUsd >= 0.01 && limitUsd <= 1_000_000))
    || !Number.isSafeInteger(revision) || revision < 0) {
    res.status(400).json({ error: 'Set a limit from 0.01 to 1,000,000 USD or null, and the current revision.' })
    return
  }
  try {
    const { configureSessionBudget } = await import('../../core/usage/session-budget.js')
    res.json(await configureSessionBudget(String(req.params.sid), { limitUsd, revision }))
  } catch (error) {
    const failure = error as Error & { code?: string; status?: number }
    res.status(failure.status ?? 503).json({ error: failure.message, code: failure.code ?? 'budget_unavailable' })
  }
})

// GET /api/usage/summary — all period summaries
usageRouter.get('/summary', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Intl.DateTimeFormat('en-CA').format(new Date())
    const daysAgo = (days: number) => { const day = new Date(); day.setDate(day.getDate() - days); return new Intl.DateTimeFormat('en-CA').format(day) }
    res.json({ today: reconciledOverview({ startDate: today, endDate: today }, 1).summary,
      week: reconciledOverview({ startDate: daysAgo(7) }, 1).summary,
      month: reconciledOverview({ startDate: daysAgo(30) }, 1).summary,
      allTime: reconciledOverview({}, 1).summary })
  } catch (err) { next(err) }
})

// GET /api/usage/daily?days=30 — daily cost time series
usageRouter.get('/daily', (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 365)
    const start = new Date(); start.setDate(start.getDate() - days)
    const daily = reconciledOverview({ startDate: new Intl.DateTimeFormat('en-CA').format(start) }, 1).daily
    res.json({ daily })
  } catch (err) { next(err) }
})

// GET /api/usage/by-source?period=30d — breakdown by source
usageRouter.get('/by-source', (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period as string)
    const sources = reconciledOverview(periodFilter(period), 1).bySource
    res.json({ sources })
  } catch (err) { next(err) }
})

// GET /api/usage/by-model?period=30d — breakdown by model
usageRouter.get('/by-model', (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period as string)
    const models = reconciledOverview(periodFilter(period), 1).byModel
    res.json({ models })
  } catch (err) { next(err) }
})

// GET /api/usage/by-agent?period=30d — breakdown by the agent that spent it
usageRouter.get('/by-agent', (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period as string)
    const agents = reconciledOverview(periodFilter(period), 1).byAgent
    res.json({ agents })
  } catch (err) { next(err) }
})

// GET /api/usage/recent?limit=50 — recent records
usageRouter.get('/recent', (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 500)
    const records = reconciledOverview({}, limit).recent
    res.json({ records })
  } catch (err) { next(err) }
})

// GET /api/usage/pricing — current pricing table
usageRouter.get('/pricing', (_req: Request, res: Response) => {
  res.json({ models: DEFAULT_PRICING, version: PRICING_VERSION })
})

function periodFilter(period: UsagePeriod): UsageFilter {
  if (period === 'all') return {}
  const now = new Date()
  if (period !== 'today') now.setDate(now.getDate() - (period === '7d' ? 7 : 30))
  const startDate = new Intl.DateTimeFormat('en-CA').format(now)
  return { startDate, ...(period === 'today' ? { endDate: startDate } : {}) }
}

function parsePeriod(raw: string | undefined): UsagePeriod {
  if (raw === 'today' || raw === '7d' || raw === '30d' || raw === 'all') return raw
  return '30d'
}

/** Accept only well-formed YYYY-MM-DD; anything else is ignored (undefined). */
function parseDate(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}

/** A non-empty string token, trimmed; empty/absent → undefined. */
function parseTok(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}
