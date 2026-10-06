/**
 * /api/v1 Places (additive, frozen contract): once the user turns Places on, the
 * iPhone records the places they visit (iOS visit monitoring, from then on only)
 * and keeps this Mac current with them.
 *
 *   POST   /api/v1/places/sync     { tz, state?: { enabled, access }, visits?: [...] }
 *   GET    /api/v1/places/status   recording, phone state, visit count, last upload
 *   DELETE /api/v1/places/data     delete every visit on the Mac (the files themselves)
 *
 * The primary (Mac) is the ONLY writer. On a cloud REPLICA every call is a relay
 * over `session.control` (`server.places.*`), and the replica keeps nothing.
 *   200                      committed; the phone may forget the visits it sent
 *   503 primary_unreachable  nothing stored: keep the visits queued and retry
 *   413 too_large            over the per-call caps: split the batch
 *
 * Access: this Mac, or a paired phone's DEVICE token (not an API key), and never
 * a loopback self-call the server makes for a caller off this Mac. The internal
 * reads under /api/places/* are narrower: a caller on this Mac only.
 *
 * Logs record counts and outcomes only, never a coordinate or a place name.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { PLACES_LOCAL_ONLY_MESSAGE } from '../../lib/caller-origin.js'
import type { PlacesAction } from '../../core/places/relay.js'
import type { SessionControlAction } from '../../core/sessions/session-controls.js'
import { phoneOrThisMachineGuard } from '../middleware/health-access.js'

export const placesV1Router = Router()

export const PLACES_DEVICE_ONLY_MESSAGE =
  "Places accepts only this Mac and a paired phone's device token. An API key cannot read or change it."

const SERVER_RELAY_SID = '__server__'
const RELAY_TIMEOUT_MS = 10_000

function sendUnreachable(res: Response): void {
  res.status(503).json({ error: { code: 'primary_unreachable', message: 'The visits could not reach the primary box: keep them queued and retry' } })
}

async function handle(res: Response, action: PlacesAction, body: unknown): Promise<void> {
  try {
    if (CLOUD_MODE) {
      await relay(res, action, body)
      return
    }
    const { runPlacesAction } = await import('../../core/places/relay.js')
    const out = await runPlacesAction(action, { body })
    res.status(out.status).json(out.body)
  } catch (err) {
    log.web.warn('v1 places request failed', { action, error: err instanceof Error ? err.message : String(err) })
    if (res.headersSent) { res.end(); return }
    sendUnreachable(res)
  }
}

/** REPLICA: bound, forward, and pass the primary's answer through verbatim. */
async function relay(res: Response, action: PlacesAction, body: unknown): Promise<void> {
  if (action === 'sync') {
    const { placesSyncTooLarge } = await import('../../core/places/ingest.js')
    const tooLarge = placesSyncTooLarge(body)
    if (tooLarge) { res.status(tooLarge.status).json(tooLarge.body); return }
  }
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const outcome = await callPrimaryControl(`server.places.${action}` as SessionControlAction, SERVER_RELAY_SID, { body }, RELAY_TIMEOUT_MS)
  if (outcome.ok) {
    const status = outcome.result.status
    const answer = outcome.result.body
    if (typeof status === 'number' && status >= 200 && status < 600 && answer && typeof answer === 'object') {
      res.status(status).json(answer)
      return
    }
    log.web.warn('v1 places relay: the primary answered an unreadable shape', { action })
    sendUnreachable(res)
    return
  }
  log.web.info('v1 places could not reach the primary: client will retry', { action, failureKind: outcome.failure.kind })
  sendUnreachable(res)
}

placesV1Router.use('/places', phoneOrThisMachineGuard('places', PLACES_LOCAL_ONLY_MESSAGE, PLACES_DEVICE_ONLY_MESSAGE))
placesV1Router.post('/places/sync', (req: Request, res: Response) => handle(res, 'sync', req.body))
placesV1Router.get('/places/status', (_req: Request, res: Response) => handle(res, 'status', undefined))
placesV1Router.delete('/places/data', (_req: Request, res: Response) => handle(res, 'delete', undefined))
