/**
 * POST /api/devices/adopt and /api/devices/unadopt: the HTTP side of device
 * adoption (core/device-adoption.ts), on both boxes. The Mac calls them on its
 * cloud companion with its own cloud credential, the same one it mints and
 * lists the companion's devices with.
 *
 *   adopt   { name, token_hash, id?, platform?, info? } → { name, instance, adopted }
 *   unadopt { token_hash }                              → { name, instance, revoked }
 *
 * Who may: the same rule as pairing a new device (deviceChangeDecision
 * 'create'): a phone may not (403 phone_cannot_pair); the Mac's token, any
 * other paired non-phone device, an API key or this machine itself may.
 * Adopting the same hash again changes nothing; unadopting a hash that is not
 * here answers revoked:false, so both are safe to repeat.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { getInstanceId, listDeviceRecords } from '../../core/device-auth.js'
import { deviceChangeDecision } from '../../core/device-actor.js'
import { AdoptionError, adoptDeviceRecord, revokeAdoptedByHash } from '../../core/device-adoption.js'
import { actorOf, sendRefusal } from './devices.js'
import { revokePushTokensForDevice } from './push.js'

export const deviceAdoptionRouter = Router()

function sendAdoptionError(res: Response, err: unknown): boolean {
  if (sendRefusal(res, err)) return true
  if (err instanceof AdoptionError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return true
  }
  return false
}

deviceAdoptionRouter.post('/adopt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const out = await adoptDeviceRecord({
      name: body.name,
      tokenHash: body.token_hash,
      id: body.id,
      platform: body.platform,
      info: body.info,
      // On the companion the pairing comes from the primary, and the other way round.
      adoptedFrom: CLOUD_MODE ? 'primary' : 'cloud',
    }, { by: actorOf(req) })
    res.json({ name: out.name, instance: await getInstanceId(), adopted: out.adopted })
  } catch (err) {
    if (sendAdoptionError(res, err)) return
    next(err)
  }
})

deviceAdoptionRouter.post('/unadopt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const decision = deviceChangeDecision(await listDeviceRecords(), actorOf(req), 'create', '', CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    const name = await revokeAdoptedByHash((req.body as Record<string, unknown> | undefined)?.token_hash)
    // Same as any revoke: the pushes stop too (they may live on the primary).
    const push = name ? await revokePushTokensForDevice(name) : null
    if (name) log.web.info('devices: pairing removed by hash', { name, ...(push?.pending ? { pushRevokePending: push.pending } : {}) })
    res.json({ name, instance: await getInstanceId(), revoked: name !== null, ...(push?.pending ? { pushRevokePending: true } : {}) })
  } catch (err) {
    if (sendAdoptionError(res, err)) return
    next(err)
  }
})
