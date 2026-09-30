/**
 * Internal Apple Health reads, the routes behind the health_* ops:
 *
 *   GET /api/health/status
 *   GET /api/health/sleep?last_nights=&from=&to=&detail=summary|stages
 *   GET /api/health/daily?last_days=&from=&to=&metrics=
 *   GET /api/health/series?metric=&from=&to=&bucket=5m|1h|1d
 *
 * Primary only (501 on a replica, like /api/time): the store lives on the Mac.
 * This machine only (middleware/health-access.ts): any other caller gets 403,
 * even one holding a valid device token.
 * A Mac that never received an upload answers `connected: false` WITHOUT creating
 * a store, so an agent's curiosity never leaves a health database behind.
 * Logs record counts only, never a value.
 */

import fs from 'node:fs'
import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { requireThisMachine } from '../middleware/health-access.js'

export const healthRouter = Router()

healthRouter.use(requireThisMachine)

const NOT_CONNECTED = 'Apple Health is not connected: the iPhone has not uploaded anything to this Mac yet'

function q(req: Request, name: string): string | undefined {
  const v = req.query[name]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function intParam(req: Request, name: string): number | undefined {
  const raw = q(req, name)
  if (raw === undefined) return undefined
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN
}

async function storeExists(): Promise<boolean> {
  const { healthDbPath } = await import('../../core/health/db.js')
  return fs.existsSync(healthDbPath())
}

type Reader = (req: Request) => Promise<Record<string, unknown>>

function route(name: string, empty: () => Record<string, unknown>, read: Reader) {
  return async (req: Request, res: Response): Promise<void> => {
    if (CLOUD_MODE) {
      res.status(501).json({ error: 'not_supported_cloud', message: 'Apple Health data lives on the primary box only' })
      return
    }
    try {
      if (!(await storeExists())) {
        res.json({ connected: false, message: NOT_CONNECTED, ...empty() })
        return
      }
      const body = await read(req)
      log.web.debug('health read served', { read: name, items: countItems(body) })
      res.json(body)
    } catch (err) {
      const { HealthQueryError } = await import('../../core/health/index.js')
      if (err instanceof HealthQueryError) {
        res.status(400).json({ error: 'bad_request', message: err.message })
        return
      }
      log.web.warn('health read failed', { read: name, error: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) })
    }
  }
}

function countItems(body: Record<string, unknown>): number {
  for (const key of ['nights', 'days', 'points', 'types']) {
    const v = body[key]
    if (Array.isArray(v)) return v.length
  }
  return 0
}

healthRouter.get('/status', route('status', () => ({ paused: false, types: [], sources: [] }), async () => {
  const { healthStatus } = await import('../../core/health/index.js')
  return healthStatus() as unknown as Record<string, unknown>
}))

healthRouter.get('/sleep', route('sleep', () => ({ nights: [] }), async (req) => {
  const { healthSleep } = await import('../../core/health/index.js')
  return await healthSleep({
    lastNights: intParam(req, 'last_nights'), from: q(req, 'from'), to: q(req, 'to'), detail: q(req, 'detail'),
  }) as unknown as Record<string, unknown>
}))

healthRouter.get('/daily', route('daily', () => ({ days: [] }), async (req) => {
  const { healthDaily } = await import('../../core/health/index.js')
  return await healthDaily({
    lastDays: intParam(req, 'last_days'), from: q(req, 'from'), to: q(req, 'to'), metrics: q(req, 'metrics'),
  }) as unknown as Record<string, unknown>
}))

healthRouter.get('/series', route('series', () => ({ points: [] }), async (req) => {
  const { healthSeries } = await import('../../core/health/index.js')
  return await healthSeries({
    metric: q(req, 'metric'), from: q(req, 'from'), to: q(req, 'to'), bucket: q(req, 'bucket'),
  }) as unknown as Record<string, unknown>
}))
