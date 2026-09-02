/**
 * Push-registration bridge relay (runs on the PRIMARY box).
 *
 * A cloud replica can accept a phone's `POST /api/push/register`, but it must not
 * KEEP it: the rows live in `config.yaml`, which never syncs, and the sender +
 * the APNs key live on the primary. So the replica forwards each push route here
 * over the `server.push.*` control actions and this file is the ONE place that
 * maps an action name onto the same registry functions the primary's own routes
 * call — exactly the shape core/human-inbox/relay.ts has for letters.
 *
 * Replies match the HTTP responses field for field, so the replica can hand the
 * result straight back to the phone.
 *
 * `keyName` + `origin` ride the params because the DEVICE identity is what scopes
 * a row, and on this hop the authenticated party is the bridge socket, not the
 * phone. The name is provenance for scoping, never authorization (same contract
 * as `callerSid` on the human-inbox relay), and `origin: 'relay'` records that
 * the name was minted on ANOTHER box — names are unique only within one box.
 */

import { CLOUD_MODE } from '../../constants.js'
import {
  PushRegistryError,
  pushRegistrationStatus,
  registerPushToken,
  reportDeviceActive,
  revokeDevicePushTokens,
  setDevicePushPreferences,
  unregisterPushToken,
} from './registry.js'

export { PushRegistryError }

function deviceOf(p: Record<string, unknown>): string | null {
  const raw = p.keyName
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function requireDevice(p: Record<string, unknown>): string {
  const device = deviceOf(p)
  if (!device) {
    throw new PushRegistryError(
      'keyName (the calling device) is required on a relayed push action',
      'bad_request', 400,
    )
  }
  return device
}

export async function handlePushRelayAction(
  sub: string,
  p: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // "The replica stores nothing" is an invariant, so make it structural rather
  // than a consequence of the daemon happening to route these actions to the
  // primary. A cloud box reaching this code means something forwarded a push
  // action to the WRONG box, and writing its own config there is the original bug.
  if (CLOUD_MODE) {
    throw new PushRegistryError(
      'push registrations are owned by the primary box; a replica must relay them, never apply them',
      'wrong_box', 500,
    )
  }
  switch (sub) {
    case 'register':
      return await registerPushToken({
        token: p.token,
        platform: p.platform,
        environment: p.environment,
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
        ...(p.letterTypes !== undefined ? { letterTypes: p.letterTypes } : {}),
        keyName: deviceOf(p),
        origin: 'relay',
      }) as unknown as Record<string, unknown>
    case 'unregister':
      return await unregisterPushToken(p.token) as unknown as Record<string, unknown>
    // The pairing was revoked on the replica, so the rows it forwarded here have
    // to go with it: a revoked phone must stop receiving letter subjects and
    // previews on its lock screen. Only that device's RELAYED rows are touched —
    // a phone paired directly to this box keeps its own row even if the two
    // pairings happen to share a name.
    case 'revoke-device':
      return await revokeDevicePushTokens(requireDevice(p), 'relay')
    case 'preferences':
      return await setDevicePushPreferences(requireDevice(p), {
        mode: p.mode,
        ...(p.letterTypes !== undefined ? { letterTypes: p.letterTypes } : {}),
      }, 'relay') as unknown as Record<string, unknown>
    case 'active':
      return await reportDeviceActive(
        requireDevice(p), p.active !== false, 'relay',
      ) as unknown as Record<string, unknown>
    case 'status':
      return await pushRegistrationStatus(deviceOf(p), 'relay')
    default:
      throw new PushRegistryError(`unknown push action: ${sub}`, 'bad_request', 400)
  }
}
