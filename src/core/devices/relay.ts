/**
 * Device adoption over the bridge (runs on the PRIMARY box).
 *
 * A phone paired with the cloud companion asks the companion for its routes
 * (GET /api/v1/routes). The companion relays `server.devices.adopt` here with
 * that pairing's hash: this box adopts it (device-adoption.ts) and answers its
 * own direct routes, so the phone can also reach the Mac over the LAN or a
 * tailnet with the token it already holds. `server.devices.revoke-by-hash` is
 * the companion's revoke of that pairing, removing the twin here too.
 *
 * The authenticated party on this hop is the bridge socket (the companion,
 * through this Mac's own daemon), and the companion built the params from the
 * caller's own record, so the adoption runs as this box itself.
 */

import { CLOUD_MODE } from '../../constants.js'
import { getInstanceId } from '../device-auth.js'
import { AdoptionError, adoptDeviceRecord, revokeAdoptedByHash } from '../device-adoption.js'
import { directRoutes, listeningPort } from './routes.js'
import { peekTailscaleBrief } from '../tailnet.js'

export class DevicesRelayError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message)
    this.name = 'DevicesRelayError'
  }
}

export async function handleDevicesRelayAction(
  sub: string,
  p: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Same structural guard as push/relay.ts: a replica answering this would
  // adopt into its own registry, which is the box the request came from.
  if (CLOUD_MODE) {
    throw new DevicesRelayError(
      'device adoption over the bridge is answered by the primary box; a replica must relay it, never apply it',
      'wrong_box', 500,
    )
  }
  try {
    switch (sub) {
      case 'adopt': {
        const out = await adoptDeviceRecord({
          name: p.name, tokenHash: p.tokenHash, id: p.id, platform: p.platform, info: p.info, adoptedFrom: 'cloud',
        })
        const instance = await getInstanceId()
        // The phone reached the companion, so it is away from the Mac: this is where
        // "set up Tailscale on your Mac" has to travel from (null while the first check runs).
        const [routes, tailscale] = await Promise.all([directRoutes(listeningPort(), instance), peekTailscaleBrief()])
        return { name: out.name, adopted: out.adopted, instance, routes, tailscale }
      }
      case 'revoke-by-hash': {
        // The revoke removes the push rows the phone registered here as itself
        // (over the LAN route) too: revokePairing owns that for every revoke.
        const name = await revokeAdoptedByHash(p.tokenHash)
        return { name, revoked: name !== null }
      }
      default:
        throw new DevicesRelayError(`unknown devices action: ${sub}`, 'bad_request', 400)
    }
  } catch (err) {
    if (err instanceof AdoptionError) throw new DevicesRelayError(err.message, err.code, err.status)
    throw err
  }
}
