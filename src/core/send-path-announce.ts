/**
 * Primary (Mac): tell the cloud companion when a delivery path for the phone
 * sends it holds comes up where the companion cannot see it.
 *
 * The companion drains its held sends when a bridge connects, but two returns
 * never touch a bridge: the Mac reaching a host's daemon again (its SSH link
 * back after an outage), and the Mac reaching its own daemon after that daemon
 * restarted (the new daemon dials the companion first, so the drain that
 * bridge connect starts finds no Mac behind it yet). Both used to wait for the
 * companion's next 60 s sweep. The Mac announces each one over its own bridge
 * (`send-path-ready`, events-v1), and the companion drains what it holds for
 * that host at once (send-queue-drain.ts noteSendPathReady).
 *
 * Fire-and-forget: a lost announcement costs only the wait it would have
 * saved, and the companion's own quick re-drains and sweep still run.
 */

import { CLOUD_MODE } from '../constants.js'
import { log } from '../logging/index.js'

/** The mobile-event kind the companion's events-v1 allowlist routes to the send queue. */
export const SEND_PATH_READY_KIND = 'send-path-ready'

/**
 * When the Mac's own daemon has just connected, the connection may not be in
 * the pool yet: try again a few times before giving up.
 */
const RETRY_DELAYS_MS = [0, 250, 1_000, 3_000]

async function announce(host: string): Promise<void> {
  const { forwardMobileEventToBridge } = await import('../web/routes/events-v1.js')
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
    try {
      if (await forwardMobileEventToBridge(SEND_PATH_READY_KIND, { host })) {
        log.session.info('send-path: told the companion a delivery path came up', { host })
        return
      }
    } catch { /* try again, then give up */ }
  }
}

/** Start announcing; returns the unsubscribe. A no-op on the companion itself. */
export function startSendPathAnnouncements(
  onHostConnected: (cb: (hostKey: string) => void) => () => void,
): () => void {
  if (CLOUD_MODE) return () => {}
  return onHostConnected((hostKey) => { void announce(hostKey).catch(() => {}) })
}
