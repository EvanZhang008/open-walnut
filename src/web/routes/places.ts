/**
 * Internal places reads, the routes behind the places_* ops:
 *
 *   GET /api/places/status
 *   GET /api/places/visits?last_days=&from=&to=&place=&limit=
 *
 * Primary only (501 on a replica): the store lives on the Mac. This machine only
 * (middleware/health-access.ts thisMachineGuard): any other caller gets 403, even
 * one holding a valid device token. A Mac that never received a visit answers
 * without creating a store. Logs record counts only.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { PLACES_LOCAL_ONLY_MESSAGE } from '../../lib/caller-origin.js'
import { thisMachineGuard } from '../middleware/health-access.js'

export const placesRouter = Router()

placesRouter.use(thisMachineGuard('places', PLACES_LOCAL_ONLY_MESSAGE))

function q(req: Request, name: string): string | undefined {
  const v = req.query[name]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

type Reader = (req: Request, places: typeof import('../../core/places/index.js')) => Record<string, unknown>

function route(name: string, empty: () => Record<string, unknown>, read: Reader) {
  return async (req: Request, res: Response): Promise<void> => {
    if (CLOUD_MODE) {
      res.status(501).json({ error: 'not_supported_cloud', message: 'Places data lives on the primary box only' })
      return
    }
    const places = await import('../../core/places/index.js')
    try {
      if (!places.placesStoreExists()) {
        res.json({ ...places.emptyPlacesStatus(), ...empty() })
        return
      }
      const body = read(req, places)
      log.web.debug('places read served', { read: name, items: Array.isArray(body.visits) ? body.visits.length : 0 })
      res.json(body)
    } catch (err) {
      if (err instanceof places.PlacesQueryError) {
        res.status(400).json({ error: 'bad_request', message: err.message })
        return
      }
      log.web.warn('places read failed', { read: name, error: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) })
    }
  }
}

placesRouter.get('/status', route('status', () => ({}), (_req, places) =>
  places.placesStatus() as unknown as Record<string, unknown>))

placesRouter.get('/visits', route('visits', () => ({ visits: [], places: [], count: 0 }), (req, places) => {
  const lastDays = q(req, 'last_days')
  return places.placesVisits({
    lastDays: lastDays === undefined ? undefined : /^\d+$/.test(lastDays) ? Number(lastDays) : Number.NaN,
    from: q(req, 'from'), to: q(req, 'to'), place: q(req, 'place'), limit: q(req, 'limit'),
  })
}))
