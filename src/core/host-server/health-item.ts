/**
 * A follower that did not start on a host is Walnut's to retry or fix, never the person's
 * (docs/reference/notice-audience.md): ONE Walnut Health item per host (`host-server:<host>`),
 * never a toast or a bell row (no needsYou). Its count rises with each try that fails again, so
 * Walnut Health looks into one that keeps failing. A start that goes through, a host turned
 * off or one that cannot run a follower (its view says why) recovers it.
 *
 * The host's sessions are not touched by any of it: the daemon keeps them whatever its server does.
 * Nothing here throws, and nothing waits for it (manager.ts calls it without waiting).
 */

import type { NewNotification } from '../notifications/store.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'

const conditions = healthConditions('host-server')

export function hostServerHealthKey(hostKey: string): string {
  return `host-server:${hostKey}`
}

export function hostServerHealthItem(hostKey: string, label: string, message: string, retries: boolean): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: `Walnut's server on ${label} did not start`,
    body: `${message} The sessions on ${label} keep running; ${retries ? 'Walnut tries again by itself.' : 'it is tried again on Retry, a reconnect or a newer build.'}`,
    detail: `host server setup on ${hostKey}: ${message}`,
    dedupKey: hostServerHealthKey(hostKey),
    recoveryKey: hostServerHealthKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  }
}

/** The host's follower did not start: raise (or count again) its item. `retries`: Walnut tries again by itself. */
export function noteHostServerFailed(hostKey: string, message: string, retries: boolean): Promise<void> {
  return conditions.raise(hostServerHealthKey(hostKey), async () => hostServerHealthItem(hostKey, await hostLabel(hostKey), message, retries))
}

/** The host's follower runs, or none is meant to run: its item, if any, recovers. */
export function noteHostServerSettled(hostKey: string): Promise<void> {
  return conditions.recover(hostServerHealthKey(hostKey))
}

/** Tests only. */
export function _resetHostServerHealthForTesting(): void {
  conditions.reset()
}
