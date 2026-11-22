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
 * Does this leader offer each host its one Walnut service (one-service-mode.ts)? The same experiment
 * that runs this computer's sessions in Walnut's own process, `in_process_daemon`: it is one
 * choice, "Walnut's runtime runs inside a Walnut process", on this computer and on every host that
 * can take it (with `service_launcher` on too). One flag on purpose: the other parts of the one
 * service (home moves, same-machine aliases) already hang on it, and a second experiment would
 * switch on by itself wherever every experiment is on.
 *
 * Read from the config on each check, never through inProcessDaemonWanted(): that one also takes
 * WALNUT_IN_PROCESS_DAEMON, a switch for one process's own runtime (a test, a person's own run),
 * which must not switch every host, and it is decided once per process, so turning the experiment
 * off reached the hosts only at the next leader start. WALNUT_HOST_SERVICE_OFFER=1 or 0 decides the
 * offer alone for one process.
 */
export async function hostServiceOfferWanted(): Promise<boolean> {
  const forced = process.env.WALNUT_HOST_SERVICE_OFFER
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    return experimentalEnabled((await getConfig()).experimental, 'in_process_daemon')
  } catch {
    return false
  }
}
