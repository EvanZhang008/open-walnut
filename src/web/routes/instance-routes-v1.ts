/**
 * GET /api/v1/instance and GET /api/v1/routes: which box is this, and every
 * address the caller's own token can reach this Walnut at.
 *
 * /instance is public (no token, both modes; auth.ts PUBLIC_GET_PATHS): a
 * client probing an address learns whether it reached the box it expects and
 * nothing else. /routes needs the device token and, as a side effect, makes
 * that token work on the other box too (device-twins.ts):
 *  - PRIMARY: its LAN and tailnet routes, plus the cloud route once the
 *    companion adopted the caller's pairing;
 *  - REPLICA: its own (cloud) route, plus the primary's LAN and tailnet routes
 *    once the primary adopted it over the bridge.
 * A caller without a device (an API key, the loopback console) gets the routes
 * that need no adoption. Every failure on the far side leaves only that route
 * out; the answer is still 200.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { getInstanceId, listDeviceRecords, type DeviceRecord } from '../../core/device-auth.js'
import { recordForToken } from '../../core/device-actor.js'
import { CLOUD_ROUTE_LABEL, directRoutes, listeningPort, type DeviceRoute } from '../../core/devices/routes.js'
import { adoptOnCloud, adoptOnPrimary } from './device-twins.js'
import { peekTailscaleBrief } from '../../core/tailnet.js'

export const instanceRoutesV1Router = Router()

instanceRoutesV1Router.get('/instance', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ instance: await getInstanceId(), mode: CLOUD_MODE ? 'REPLICA' : 'LIVE' })
  } catch (err) {
    next(err)
  }
})

/** The paired device that made this request (by the token it presented), never a machine credential. */
async function callerRecord(req: Request): Promise<DeviceRecord | null> {
  const name = (req as Request & { deviceName?: string }).deviceName
  const header = req.headers.authorization
  if (!name || !header?.startsWith('Bearer ')) return null
  const record = recordForToken(await listDeviceRecords(), header.slice(7))
  return record && record.name === name && record.kind !== 'machine' ? record : null
}

instanceRoutesV1Router.get('/routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const instance = await getInstanceId()
    const caller = await callerRecord(req)
    const routes: DeviceRoute[] = []
    // So the phone can say "set up Tailscale on your Mac" vs "install it on this phone":
    // the Mac's own summary here, the one it sent in its adopt reply on a replica (the
    // phone that asks a replica is the one away from home); absent while the first probe runs.
    let tailscale: { installed: boolean; running: boolean; dnsName?: string } | null = null
    if (CLOUD_MODE) {
      // trust proxy is on in cloud mode, so req.protocol is what the client used.
      if (caller) {
        const primary = await adoptOnPrimary(caller)
        routes.push(...primary.routes)
        tailscale = primary.tailscale
      }
      routes.push({ kind: 'cloud', origin: `${req.protocol}://${req.get('host') ?? ''}`, label: CLOUD_ROUTE_LABEL, instance })
    } else {
      // The port this request reached the server on: the direct routes use the same one.
      routes.push(...await directRoutes(req.socket.localPort || listeningPort(), instance))
      const cloud = caller ? await adoptOnCloud(caller) : null
      if (cloud) routes.push({ kind: 'cloud', origin: cloud.origin, label: CLOUD_ROUTE_LABEL, instance: cloud.instance })
      tailscale = await peekTailscaleBrief()
    }
    res.json({ routes, device: caller?.name ?? null, ...(tailscale ? { tailscale } : {}) })
  } catch (err) {
    next(err)
  }
})
