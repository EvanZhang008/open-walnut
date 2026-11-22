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
 * Does this leader offer this host its one Walnut service (one-service-mode.ts)? Yes when the
 * experiment that runs this computer's sessions in Walnut's own process, `in_process_daemon`, is on
 * (one choice, "Walnut's runtime runs inside a Walnut process", on this computer and on every host
 * that can take it), or when the host's key is in the config's `host_service_offer` list: the
 * service on chosen hosts only, with nothing else of the experiment switched on (this computer's
 * own runtime, home-move declarations and same-machine aliases stay as they are). The list is
 * temporary, until the old two-program path on a host is removed. `service_launcher` must be on
 * too (serviceModeWantNow asks it apart).
 *
 * Every decision of the offer for a host reads it here, from the config on each check, never
 * through inProcessDaemonWanted(): that one also takes WALNUT_IN_PROCESS_DAEMON, a switch for one
 * process's own runtime (a test, a person's own run), which must not switch every host, and it is
 * decided once per process, so turning the experiment off reached the hosts only at the next leader
 * start. A host taken out of the list is switched back at its next update, as when the experiment
 * goes off. WALNUT_HOST_SERVICE_OFFER=1 or 0 decides the offer alone for one process.
 */
export async function hostServiceOfferWanted(hostKey: string): Promise<boolean> {
  const forced = process.env.WALNUT_HOST_SERVICE_OFFER
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()
    if (experimentalEnabled(config.experimental, 'in_process_daemon')) return true
    // A hand-edited file may hold anything here: only a list of names counts.
    const listed: unknown = config.host_service_offer
    return Array.isArray(listed) && listed.includes(hostKey)
  } catch {
    return false
  }
}
