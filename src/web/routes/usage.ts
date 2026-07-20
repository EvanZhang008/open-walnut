/**
 * Usage tracking routes — token/cost summaries and breakdowns.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { usageTracker, DEFAULT_PRICING, PRICING_VERSION } from '../../core/usage/index.js'
import type { UsagePeriod, UsageFilter } from '../../core/usage/types.js'

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
    res.json(usageTracker.getOverview(filter, limit))
  } catch (err) { next(err) }
})

// GET /api/usage/summary — all period summaries
usageRouter.get('/summary', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = usageTracker.getAllSummaries()
    res.json(data)
  } catch (err) { next(err) }
})

// GET /api/usage/daily?days=30 — daily cost time series
usageRouter.get('/daily', (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 365)
    const daily = usageTracker.getDailyCosts(days)
    res.json({ daily })
  } catch (err) { next(err) }
})

// GET /api/usage/by-source?period=30d — breakdown by source
usageRouter.get('/by-source', (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period as string)
    const sources = usageTracker.getBySource(period)
    res.json({ sources })
  } catch (err) { next(err) }
})

// GET /api/usage/by-model?period=30d — breakdown by model
usageRouter.get('/by-model', (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period as string)
    const models = usageTracker.getByModel(period)
    res.json({ models })
  } catch (err) { next(err) }
})

// GET /api/usage/by-agent?period=30d — breakdown by the agent that spent it
usageRouter.get('/by-agent', (req: Request, res: Response, next: NextFunction) => {
  try {
    const period = parsePeriod(req.query.period as string)
    const agents = usageTracker.getByAgent(period)
    res.json({ agents })
  } catch (err) { next(err) }
})

// GET /api/usage/recent?limit=50 — recent records
usageRouter.get('/recent', (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 500)
    const records = usageTracker.getRecentRecords(limit)
    res.json({ records })
  } catch (err) { next(err) }
})

// GET /api/usage/pricing — current pricing table
usageRouter.get('/pricing', (_req: Request, res: Response) => {
  res.json({ models: DEFAULT_PRICING, version: PRICING_VERSION })
})

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
