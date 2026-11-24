/**
 * A host's daemon update that has waited long (src/providers/daemon-update-wait.ts updateWaitIsLong:
 * postponed past the overdue bound, or a skip that means something went wrong for more than an hour;
 * never a skip the person chose or a steady fact of the host) is a Walnut Health item (audience.ts: an
 * operation error with no needsYou, never a popup), one per host. The minute sweep over every connected
 * host (host-down-gauge.ts) asks; the item is raised once per wait (the same build waiting since the
 * same time), not at every sweep. A host away is not asked (its link drops do not raise and recover
 * the item again and again).
 *
 * It recovers when the wait is really over: the update landed (endUpdateWait), the wait is one Health
 * does not carry, or RECOVER_AFTER_SWEEPS sweeps in a row found no wait. A connected host reads no wait
 * for a moment now and then while its update still waits (an SSH decision made again every minute, the
 * host network updater's "not connected" round and its settle after a reconnect): one such sweep must
 * not recover the item, or Health raises and recovers it again and again. After a restart each host
 * may still have an item an earlier process left: it recovers by the same rule. A host no longer listed
 * (removed, turned off) recovers its item at the next sweep, and its clocks go (forgetDaemonUpdateWaits).
 */
import type { NewNotification } from '../notifications/store.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'
import { daemonUpdateWaitSentence, forgetUpdateWait, updateWaitEnded, updateWaitIsLong, type DaemonUpdateWait } from '../../providers/daemon-update-wait.js'

const conditions = healthConditions('daemon-update-wait')
/** Sweeps in a row with no wait before the item recovers (the sweep runs every minute). */
export const RECOVER_AFTER_SWEEPS = 3
/**
 * Per host: the wait raised this process (`tag`: build and since; null: maybe one an earlier process
 * left) and the sweeps in a row since with no wait; 'clear': none is raised. Absent: not looked at yet.
 */
const hosts = new Map<string, { tag: string | null; misses: number } | 'clear'>()

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

function recover(hostKey: string): void {
  hosts.set(hostKey, 'clear')
  void conditions.recover(daemonUpdateWaitKey(hostKey))
}

/** The host's update wait as it is now (null: none), at each sweep of a connected host. */
export function noteDaemonUpdateWait(hostKey: string, wait: DaemonUpdateWait | null | undefined, now: number = Date.now()): void {
  const was = hosts.get(hostKey)
  if (wait && updateWaitIsLong(wait, now)) {
    const tag = `${wait.expected}@${wait.since}`
    if (was && was !== 'clear' && was.tag === tag) { was.misses = 0; return }
    hosts.set(hostKey, { tag, misses: 0 })
    void conditions.raise(daemonUpdateWaitKey(hostKey), async () => daemonUpdateWaitItem(hostKey, await hostLabel(hostKey), wait))
    return
  }
  if (was === 'clear') return
  // A wait that is there but not one for Health (the person held it, a short one after its clock
  // started again), or one that really ended: over now. No wait at all: over only after a few sweeps.
  const misses = (was?.misses ?? 0) + 1
  if (wait || updateWaitEnded(hostKey) || misses >= RECOVER_AFTER_SWEEPS) recover(hostKey)
  else hosts.set(hostKey, { tag: was?.tag ?? null, misses })
}

/** After a sweep over `listed` (every host in the config): a host swept before and gone now recovers its item, and its wait clocks go. */
export function forgetDaemonUpdateWaits(listed: ReadonlySet<string>): void {
  for (const [host, s] of hosts) {
    if (listed.has(host)) continue
    if (s !== 'clear') void conditions.recover(daemonUpdateWaitKey(host))
    hosts.delete(host)
    forgetUpdateWait(host)
  }
}

/** Tests only. */
export function _resetDaemonUpdateWaitHealthForTesting(): void {
  conditions.reset()
  hosts.clear()
}
