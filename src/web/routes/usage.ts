/**
 * Usage tracking routes — token/cost summaries and breakdowns.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { usageTracker, DEFAULT_PRICING, PRICING_VERSION } from '../../core/usage/index.js'
import type { UsagePeriod } from '../../core/usage/types.js'

export const usageRouter = Router()

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
