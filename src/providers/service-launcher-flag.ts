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

/**
 * Does this leader offer this host its one Walnut service (one-service-mode.ts)? Only when the
 * host's key is in the config's `host_service_offer` list: the service on chosen hosts only, one by
 * one. `in_process_daemon` (this computer's own sessions in Walnut's process) offers no host anything
 * (2026-11-23: with it on, every host under the launcher was offered at its next update, a macOS host
 * that had never run the service among them, and taking a host out of the list changed nothing, so
 * no host could be put back alone while this computer kept its own runtime in process). The list is
 * temporary, until the old two-program path on a host is removed. `service_launcher` must be on
 * too (serviceModeWantNow asks it apart).
 *
 * Every decision of the offer for a host reads it here, from the config on each check, never
 * through inProcessDaemonWanted(), which is this computer's own runtime and decided once per process.
 * A host taken out of the list is switched back at its next update. WALNUT_HOST_SERVICE_OFFER=1 or 0 decides the offer alone for one process.
 */
export async function hostServiceOfferWanted(hostKey: string, machineIdOf?: (hostKey: string) => string | null): Promise<boolean | null> {
  const forced = process.env.WALNUT_HOST_SERVICE_OFFER
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()
    // A hand-edited file may hold anything here: only a list of names counts.
    const listed: unknown = config.host_service_offer
    if (!Array.isArray(listed)) return false
    if (listed.includes(hostKey)) return true
    // The list names config entries, and two entries can be one machine (two names for one box):
    // a name of the same machine (the same hello machine id) counts, and while a listed name's
    // machine is not known yet the answer is "not sure", so the box is never switched back and forth.
    const others = listed.filter((k): k is string => typeof k === 'string' && k !== hostKey)
    if (others.length === 0 || !machineIdOf) return false
    const mine = machineIdOf(hostKey)
    if (!mine) return null
    let unknown = false
    for (const k of others) {
      const theirs = machineIdOf(k)
      if (theirs === mine) return true
      if (!theirs) unknown = true
    }
    return unknown ? null : false
  } catch {
    return false
  }
}
