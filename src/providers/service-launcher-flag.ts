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
 * Does this leader offer this host its one Walnut service (one-service-mode.ts)? Every host is, by
 * default, unless the config keeps it on the old two-program path; `service_launcher` must be on too
 * (serviceModeWantNow asks it apart). The choice for one host, read in this one place
 * (serviceOfferFor), in this order:
 *
 *   WALNUT_HOST_SERVICE_OFFER=1|0   decides the offer alone for one process (a test, a rehearsal).
 *   `hosts.<name>.service_offer`    false keeps that host on two programs, true offers it, as
 *                                   `hosts.<name>.runs_sessions` does for its switch.
 *   `host_service_offer: [names]`   kept from when the offer went to chosen hosts only: while a list
 *                                   is there, only the hosts it names are offered, so a config that
 *                                   chose hosts one by one keeps its choice. Absent: every host.
 *
 * Never this computer's own daemon (`__local__`) and never from a follower (a replica, the companion,
 * a host's service): the offer is the leader's word, and the list and the per-host choice are not in
 * a follower's config copy (replication/config-allowlist.ts), so a follower would read "every host".
 *
 * `in_process_daemon` (this computer's own sessions in Walnut's process) offers no host anything
 * (2026-11-23: with it on, every host under the launcher was offered at its next update, a macOS host
 * that had never run the service among them, and taking a host out of the list changed nothing, so
 * no host could be put back alone while this computer kept its own runtime in process). Every
 * decision of the offer for a host reads it here, from the config on each check, never through
 * inProcessDaemonWanted(), which is this computer's own runtime and decided once per process. A host
 * the config takes the offer from is switched back at its next update.
 */
export async function hostServiceOfferWanted(hostKey: string, machineIdOf?: (hostKey: string) => string | null): Promise<boolean | null> {
  const forced = process.env.WALNUT_HOST_SERVICE_OFFER
  if (forced === '1' || forced === '0') return forced === '1'
  if (hostKey === '__local__') return false
  try {
    const [{ getConfig }, { isFollower }] = await Promise.all([import('../core/config-manager.js'), import('../core/server-role.js')])
    if (isFollower()) return false
    const config = await getConfig()
    const offer = serviceOfferFor(config, hostKey, machineIdOf)
    if (offer === true) return true
    // A host the leader runs without a copy (experiment service_without_copy) runs only as the one
    // service, whatever the list kept from before says; a host's own service_offer: false still wins.
    if (!serviceRefusedBy(config, hostKey, machineIdOf)) {
      try { if ((await import('../core/host-server/copyless.js')).runsCopyless(hostKey)) return true } catch { /* the offer decides */ }
    }
    return offer
  } catch {
    return false
  }
}

/**
 * The config takes the one service from this host by its own word: `hosts.<name>.service_offer: false`
 * (or a name proven to be the same machine says so). A list kept from before that leaves the host
 * out is no such word (serviceOfferFor without the list).
 */
export function serviceRefusedBy(config: OfferConfig, hostKey: string, machineIdOf?: (hostKey: string) => string | null): boolean {
  return serviceOfferFor({ hosts: config.hosts }, hostKey, machineIdOf) === false
}

/**
 * Whether a host may not run as the one service whatever its size (copyless.ts copylessUnfit asks it):
 * the service launcher is off, or the config takes the service from this host (serviceRefusedBy).
 */
export async function oneServiceRefused(hostKey: string): Promise<boolean> {
  if (!(await serviceLauncherWanted())) return true
  const forced = process.env.WALNUT_HOST_SERVICE_OFFER
  if (forced === '1' || forced === '0') return forced === '0'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    return serviceRefusedBy(await getConfig(), hostKey)
  } catch {
    return true
  }
}

type OfferConfig = { hosts?: Record<string, unknown> | null; host_service_offer?: unknown }

/**
 * The offer for one host from the leader's config (pure). Two entries can be one machine (two names
 * for one box, the same hello machine id): the machine gets one answer, and a false of any of its
 * names wins. An opt-out spreads only to a name proven to be its machine (both ids known and equal):
 * a row whose machine is not known (offline, asleep, never connected) is another machine, so one
 * host kept on two programs never holds every other host (review of the default flip, M2). A row
 * turned off (`enabled: false`) reaches no machine and decides nothing for another name. Only a name
 * that offers (a list kept from before) and may be this machine, while it would change the answer,
 * makes the answer "not sure" (null), so the box is never switched back and forth between its names.
 */
export function serviceOfferFor(config: OfferConfig, hostKey: string, machineIdOf?: (hostKey: string) => string | null): boolean | null {
  // A hand-edited file may hold anything here: only a list of names counts.
  const rawList = config.host_service_offer
  const listed = Array.isArray(rawList) ? rawList.filter((k): k is string => typeof k === 'string') : null
  const hosts = config.hosts && typeof config.hosts === 'object' ? config.hosts : {}
  const row = (k: string) => hosts[k] as { service_offer?: unknown; enabled?: unknown } | null | undefined
  const choiceOf = (k: string): boolean | undefined => {
    const own = row(k)?.service_offer
    if (typeof own === 'boolean') return own
    return listed?.includes(k) ? true : undefined
  }
  // No list: every host; a list kept from before: only the hosts it names.
  const fallback = listed === null
  const own = choiceOf(hostKey)
  if (own === false) return false
  const others = [...new Set([...Object.keys(hosts), ...(listed ?? [])])]
    .filter((k) => k !== hostKey && row(k)?.enabled !== false && choiceOf(k) !== undefined)
  if (others.length === 0 || !machineIdOf) return own ?? fallback
  const mine = machineIdOf(hostKey)
  let decided: boolean | undefined = own
  let maybeOffer = false
  for (const k of others) {
    const theirs = mine ? machineIdOf(k) : null
    const c = choiceOf(k) as boolean
    if (mine && theirs === mine) decided = decided === false || c === false ? false : true
    else if ((!mine || !theirs) && c) maybeOffer = true
  }
  const now = decided ?? fallback
  // An offer of a name that may be this machine changes the answer only where it would be "no".
  return maybeOffer && decided !== false && !now ? null : now
}
