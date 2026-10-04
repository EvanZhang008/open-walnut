/**
 * Internal Apple Health reads, the routes behind the health_* ops:
 *
 *   GET /api/health/status
 *   GET /api/health/sleep?last_nights=&from=&to=&detail=summary|stages
 *   GET /api/health/daily?last_days=&from=&to=&metrics=
 *   GET /api/health/series?metric=&from=&to=&bucket=5m|1h|1d
 *   GET /api/health/samples?type=&from=&to=&limit=
 *
 * Primary only (501 on a replica, like /api/time): the store lives on the Mac.
 * This machine only (middleware/health-access.ts): any other caller gets 403,
 * even one holding a valid device token.
 * A Mac that never received a sync answers `connected: false` WITHOUT creating
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

const NOT_CONNECTED = 'Apple Health is not connected yet. Walnut on the iPhone asks for access by itself: when the app opens, and right away when a health question comes up in it. ' +
  'Ask the user to open Walnut on the iPhone and allow Apple Health there; the phone then keeps this Mac up to date by itself. Do not send the user looking through Settings.'

/** health_status with a store whose phone never synced, or stopped: the agent tells the user the same thing. */
export function notSyncingMessage(lastUploadAt: unknown): string {
  if (typeof lastUploadAt !== 'string') return NOT_CONNECTED
  return `Nothing has synced from the iPhone since ${lastUploadAt.slice(0, 10)}. Walnut on the iPhone syncs whenever it is open, and in the background unless it was force-quit, `
    + 'Low Power Mode is on or Background App Refresh is off. Ask the user to open Walnut on the iPhone once.'
}

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
      if (body.connected === false && body.message === undefined) body.message = notSyncingMessage(body.lastUploadAt)
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
  for (const key of ['nights', 'days', 'points', 'rows', 'types']) {
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

healthRouter.get('/samples', route('samples', () => ({ rows: [] }), async (req) => {
  const { healthSamples } = await import('../../core/health/index.js')
  return await healthSamples({
    type: q(req, 'type'), from: q(req, 'from'), to: q(req, 'to'), limit: q(req, 'limit'),
  }) as unknown as Record<string, unknown>
}))
