/**
 * Why a host gets no offer of the one Walnut service (src/providers/one-service-mode.ts), while it
 * is wanted for the host (the offer on for the host, with service_launcher on;
 * service-launcher-flag.ts hostServiceOfferWanted): no follower of this Walnut there, no
 * launcher yet, no walnut file of this build for it, or a switch that did not take. Walnut Health's
 * (audience.ts: no needsYou, never a popup), one item per host, said again only when the reason
 * changes; an offer recovers it, and so do the experiments going off: an item this process raised at
 * once, and one an earlier process raised (the experiment turned off, then a leader restart) at the
 * first check of the host in this process, with one lock-free read of the store, as every host
 * connect's recovery does (a3b land 2 review L1: those stayed in Walnut Health for good).
 */

import type { NewNotification } from '../notifications/store.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'
import type { ServiceModeWant } from '../../providers/one-service-mode.js'

const conditions = healthConditions('one-service')
/** The reason last raised per host this process (a check runs on every settle of the host). */
const lastWhy = new Map<string, string>()
/** Hosts whose item an earlier process may have left was recovered in this one, with the experiments off. */
const offChecked = new Set<string>()

export function serviceOfferKey(hostKey: string): string {
  return `one-service-offer:${hostKey}`
}

export function noServiceOfferItem(hostKey: string, label: string, why: string): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'info',
    title: `${label} keeps the session helper and its Walnut server as two programs`,
    body: `Walnut does not run ${label} as one Walnut service: ${why.replace(/\.$/, '')}. Its sessions and its server run as before.`,
    detail: `one Walnut service not offered on ${hostKey}: ${why}`,
    dedupKey: serviceOfferKey(hostKey),
    recoveryKey: serviceOfferKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  }
}

/** The host's offer as decided now (experiments on). */
export function noteServiceOffer(hostKey: string, w: ServiceModeWant): void {
  const key = serviceOfferKey(hostKey)
  if (w.why) {
    if (lastWhy.get(hostKey) === w.why) return
    lastWhy.set(hostKey, w.why)
    const why = w.why
    void conditions.raise(key, async () => noServiceOfferItem(hostKey, await hostLabel(hostKey), why))
    return
  }
  // Settled with no reason against it: offered, or the host already serves.
  if (w.want === 'walnut-serve') {
    lastWhy.delete(hostKey)
    void conditions.recover(key)
  }
}

/** The experiments are off: an item raised in this process recovers, and once per process one an earlier process left. */
export function noteServiceOfferOff(hostKey: string): void {
  const key = serviceOfferKey(hostKey)
  lastWhy.delete(hostKey)
  if (conditions.toldOf(key) === 'raised' || !offChecked.has(hostKey)) {
    offChecked.add(hostKey)
    void conditions.recover(key)
  }
}

/** Tests only. */
export function _resetServiceOfferHealthForTesting(): void {
  conditions.reset()
  lastWhy.clear()
  offChecked.clear()
}
