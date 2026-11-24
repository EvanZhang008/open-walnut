/**
 * A host's daemon update that has waited long (src/providers/daemon-update-wait.ts updateWaitIsLong:
 * postponed past the overdue bound, or skipped for more than an hour, never a skip the person chose)
 * is a Walnut Health item (audience.ts: an operation error with no needsYou, never a popup), one per
 * host. The minute sweep over every connected host (host-down-gauge.ts) asks; the item is raised once
 * per wait (the same build waiting since the same time), not at every sweep, and it recovers when the
 * wait ends: the update landed, or it no longer waits. A host away is not asked (its link drops do not
 * raise and recover the item again and again). After a restart the first sweep of each host with
 * no long wait recovers one an earlier process may have left, with one store read.
 */
import type { NewNotification } from '../notifications/store.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'
import { daemonUpdateWaitSentence, updateWaitIsLong, type DaemonUpdateWait } from '../../providers/daemon-update-wait.js'

const conditions = healthConditions('daemon-update-wait')
/** The wait raised per host this process (build and since). */
const raised = new Map<string, string>()
/** Hosts whose item an earlier process may have left were looked at in this one. */
const checked = new Set<string>()

export function daemonUpdateWaitKey(hostKey: string): string {
  return `daemon-update-wait:${hostKey}`
}

export function daemonUpdateWaitItem(hostKey: string, label: string, w: DaemonUpdateWait): NewNotification {
  const sentence = daemonUpdateWaitSentence(label, w)
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: `The daemon on ${label} still waits for its update`,
    body: `${sentence}. Its sessions keep running on the daemon it has.`,
    detail: `daemon update of ${hostKey} to ${w.expected} waits (${w.kind}) since ${new Date(w.since).toISOString()}: ${w.why}`,
    dedupKey: daemonUpdateWaitKey(hostKey),
    recoveryKey: daemonUpdateWaitKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  }
}

/** The host's update wait as it is now (null: none), at each sweep. */
export function noteDaemonUpdateWait(hostKey: string, wait: DaemonUpdateWait | null | undefined, now: number = Date.now()): void {
  const key = daemonUpdateWaitKey(hostKey)
  if (wait && updateWaitIsLong(wait, now)) {
    checked.add(hostKey)
    const tag = `${wait.expected}@${wait.since}`
    if (raised.get(hostKey) === tag) return
    raised.set(hostKey, tag)
    void conditions.raise(key, async () => daemonUpdateWaitItem(hostKey, await hostLabel(hostKey), wait))
    return
  }
  if (raised.has(hostKey) || !checked.has(hostKey)) {
    raised.delete(hostKey)
    checked.add(hostKey)
    void conditions.recover(key)
  }
}

/** Tests only. */
export function _resetDaemonUpdateWaitHealthForTesting(): void {
  conditions.reset()
  raised.clear()
  checked.clear()
}
