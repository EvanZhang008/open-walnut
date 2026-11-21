/**
 * Does this server install and update hosts' daemons under the launcher (service-launcher-script.ts)?
 * The experiment `service_launcher` (src/core/experimental.ts); WALNUT_SERVICE_LAUNCHER=1 or 0 decides
 * for one process (a test, a person's own run). Off: `walnut daemon install|update` runs as before, and
 * a host that has the launcher gets the plain config back at its next update.
 */
import { experimentalEnabled } from '../core/experimental.js'

export async function serviceLauncherWanted(): Promise<boolean> {
  const forced = process.env.WALNUT_SERVICE_LAUNCHER
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    return experimentalEnabled((await getConfig()).experimental, 'service_launcher')
  } catch {
    return false
  }
}
