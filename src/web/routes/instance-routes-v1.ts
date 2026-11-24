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
 *
 * Walnut Connect (core/connect/, docs/reference/walnut-connect.md): the PRIMARY also lists
 * the `connect` route while it runs, and says which network id the caller registered
 * (`connectEndpoint`); POST /connect/register is how a paired phone names its own.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { isFollower, role } from '../../core/server-role.js'
import { getInstanceId, listDeviceRecords, type DeviceRecord } from '../../core/device-auth.js'
import { recordForToken } from '../../core/device-actor.js'
import { CLOUD_ROUTE_LABEL, directRoutes, listeningPort, type DeviceRoute } from '../../core/devices/routes.js'
import { adoptOnCloud, adoptOnPrimary } from './device-twins.js'
import { peekTailscaleBrief } from '../../core/tailnet.js'
import { connectRoute, reservedNetIds, scheduleConnectSync, type ConnectRoute } from '../../core/connect/connect-net.js'
import { ConnectRefused, registerConnectEndpoint } from '../../core/connect/connect-phones.js'

export const instanceRoutesV1Router = Router()

instanceRoutesV1Router.get('/instance', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // A replica (the companion, a host replica) answers REPLICA; a host replica's instance is the Mac's id.
    res.json({ instance: await getInstanceId(), mode: role() === 'replica' ? 'REPLICA' : 'LIVE' })
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
    const routes: Array<DeviceRoute | ConnectRoute> = []
    let connectEndpoint: string | null | undefined
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
      // Listed to every caller (a phone needs this Mac's id before it can register its own);
      // only a phone whose id is registered gets past walnut-net.
      const connect = await connectRoute(instance)
      if (connect) {
        routes.push(connect)
        connectEndpoint = caller ? caller.connect?.endpoint ?? null : null
      }
      const cloud = caller ? await adoptOnCloud(caller) : null
      if (cloud) routes.push({ kind: 'cloud', origin: cloud.origin, label: CLOUD_ROUTE_LABEL, instance: cloud.instance })
      tailscale = await peekTailscaleBrief()
    }
    res.json({ routes, device: caller?.name ?? null, ...(tailscale ? { tailscale } : {}), ...(connectEndpoint !== undefined ? { connectEndpoint } : {}) })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/v1/connect/register { endpoint }: the calling phone's network id (its iroh public
 * key), which this Mac's walnut-net then lets in on Walnut Connect. Its device token only:
 * 403 for any other caller, 409 when another device holds that id, 404 off the primary.
 */
instanceRoutesV1Router.post('/connect/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (isFollower()) {
      res.status(404).json({ error: 'Walnut Connect registers on the Mac', code: 'not_here' })
      return
    }
    const caller = await callerRecord(req)
    if (!caller) {
      res.status(403).json({ error: 'Only a paired app registers for Walnut Connect', code: 'not_a_phone' })
      return
    }
    const token = req.headers.authorization!.slice(7)
    const out = await registerConnectEndpoint(token, (req.body as { endpoint?: unknown } | undefined)?.endpoint, await reservedNetIds())
    if (out.changed) scheduleConnectSync('phone registered')
    res.json({ registered: true, endpoint: out.endpoint, changed: out.changed })
  } catch (err) {
    if (err instanceof ConnectRefused) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    next(err)
  }
})

