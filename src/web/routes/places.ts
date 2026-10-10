/**
 * Internal places reads, the routes behind the places_* ops:
 *
 *   GET /api/places/status
 *   GET /api/places/visits?last_days=&from=&to=&place=&limit=
 *   POST /api/places/labels  (the user's names for places)
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

// POST /api/places/labels { label, kind?, visit_id? | place?, radius_m?, remove? }: the
// user's own name for a place (labels.ts). Answers the label without its point.
placesRouter.post('/labels', async (req: Request, res: Response) => {
  if (CLOUD_MODE) {
    res.status(501).json({ error: 'not_supported_cloud', message: 'Places data lives on the primary box only' })
    return
  }
  const places = await import('../../core/places/index.js')
  if (!places.placesStoreExists()) {
    res.status(400).json({ error: 'bad_request', message: 'Places has no visits on this Mac yet, so there is nothing to label' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    const out = places.setPlaceLabel({
      label: typeof body.label === 'string' ? body.label : '',
      ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
      ...(typeof body.visit_id === 'string' ? { visitId: body.visit_id } : {}),
      ...(typeof body.place === 'string' ? { place: body.place } : {}),
      ...(typeof body.radius_m === 'number' ? { radiusM: body.radius_m } : {}),
      ...(body.remove === true ? { remove: true } : {}),
    })
    log.web.info('place label set', { removed: out.removed === true })
    res.json({ ...out, labels: places.listPlaceLabels().map(({ label, kind, name, radiusM }) => ({ label, kind, name, radiusM })) })
  } catch (err) {
    if (err instanceof places.PlacesQueryError) {
      res.status(400).json({ error: 'bad_request', message: err.message })
      return
    }
    log.web.warn('place label failed', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) })
  }
})

placesRouter.get('/visits', route('visits', () => ({ visits: [], places: [], count: 0 }), (req, places) => {
  const lastDays = q(req, 'last_days')
  return places.placesVisits({
    lastDays: lastDays === undefined ? undefined : /^\d+$/.test(lastDays) ? Number(lastDays) : Number.NaN,
    from: q(req, 'from'), to: q(req, 'to'), place: q(req, 'place'), limit: q(req, 'limit'),
  })
}))
