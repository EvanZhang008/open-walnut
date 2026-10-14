/**
 * Usage tracking routes — token/cost summaries and breakdowns.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { DEFAULT_PRICING, PRICING_VERSION } from '../../core/usage/index.js'
import type { UsagePeriod, UsageFilter } from '../../core/usage/types.js'
import { reconciledOverview, collectUsage, collectionState } from '../../core/usage/collection.js'

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

usageRouter.post('/collect', (req: Request, res: Response) => {
  const { since, until } = req.body ?? {}
  const valid = (value: unknown) => value === undefined || (typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)))
  if (!valid(since) || !valid(until) || (since && Date.parse(since) >= Date.parse(until ?? new Date().toISOString()))) {
    res.status(400).json({ error: 'Invalid usage collection window. Use timestamps with an explicit timezone.' })
    return
  }
  void collectUsage(since, until).catch(() => {})
  res.status(202).json(collectionState())
})
usageRouter.get('/collection', (_req: Request, res: Response) => res.json(collectionState()))

usageRouter.get('/sessions/:sid', async (req: Request, res: Response) => {
  try {
    const { getSessionBudget } = await import('../../core/usage/session-budget.js')
    res.json(await getSessionBudget(String(req.params.sid)))
  } catch (error) {
    const failure = error as Error & { code?: string; status?: number }
    res.status(failure.status ?? 503).json({ error: failure.message, code: failure.code ?? 'budget_unavailable' })
  }
})
usageRouter.patch('/sessions/:sid/budget', async (req: Request, res: Response) => {
  const { limitUsd, revision } = req.body ?? {}
  if (!(limitUsd === null || (typeof limitUsd === 'number' && Number.isFinite(limitUsd) && limitUsd >= 0.01))
    || !Number.isSafeInteger(revision) || revision < 0) {
    res.status(400).json({ error: 'Set a limit of at least 0.01 USD or null, and the current revision.' })
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
