/**
 * Voice input holds the music off while it listens (src/core/stt/media-hold.ts).
 *
 * POST /api/stt/media-hold  { id, action: 'hold' | 'release', source? } → MediaHoldView
 *   hold starts the hold, or renews it (the same id again, every MEDIA_HOLD_RENEW_MS);
 *   release ends it. A page that closes sends its release with navigator.sendBeacon,
 *   whose body may arrive as text/plain.
 * GET  /api/stt/media-hold → MediaHoldView (+ fakePlayer on an isolated test server)
 *
 * Only voice input on this machine holds this machine's music: a phone or another
 * computer reaching the server through a tunnel or a key gets `otherDevice` and nothing changes.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { fromThisMachine } from '../middleware/local-trust.js'
import { fakeMediaPlayerHere, mediaHold } from '../../core/stt/media-hold-runtime.js'
import { isMediaHoldId } from '../../core/stt/media-hold.js'

export const sttMediaHoldRouter = Router()

const OTHER_DEVICE = 'Voice input on another device leaves the music of this machine alone.'

sttMediaHoldRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const fake = fakeMediaPlayerHere()
    res.json({ ...(await mediaHold().status()), ...(fake ? { fakePlayer: fake } : {}) })
  } catch (err) {
    next(err)
  }
})

sttMediaHoldRouter.post('/', express.json({ limit: '4kb', type: ['application/json', 'text/plain'] }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { id?: unknown; action?: unknown; source?: unknown }
    if (!isMediaHoldId(body.id)) { res.status(400).json({ error: 'id: 6 to 80 letters, digits, - or _' }); return }
    if (body.action !== 'hold' && body.action !== 'release') { res.status(400).json({ error: "action: 'hold' or 'release'" }); return }
    const holds = mediaHold()
    if (body.action === 'release') { res.json(await holds.release(body.id)); return }
    if (!fromThisMachine(req)) { res.json({ ...(await holds.status()), otherDevice: true, note: OTHER_DEVICE }); return }
    const source = typeof body.source === 'string' && body.source ? body.source : 'voice'
    res.json(await holds.hold(body.id, source))
  } catch (err) {
    next(err)
  }
})
