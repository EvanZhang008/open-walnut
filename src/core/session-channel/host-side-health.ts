/**
 * A host that runs its own sessions and does not judge them as it should is Walnut's to look into,
 * never the person's (docs/reference/notice-audience.md): ONE Walnut Health item per host
 * (`host-sessions:<host>`), no toast and no bell row. Its host's status report says it
 * (replica/front.ts `sessionSide`, from old-leader-watch.ts):
 *
 *   stood-down   the host took this leader for an older Walnut and stopped judging its sessions: the
 *                leader treats them as host-judged, so no one continues, retries or drains them
 *   waiting      this leader says it speaks the session channel and still has not opened it: the host
 *                keeps judging, and this leader's copy of its sessions stands still
 *
 * Raised once per change into either state, recovered when the report says `judging` again or the
 * host's server stops reporting. Nothing here throws, and nothing waits for it.
 */
import type { NewNotification } from '../notifications/store.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'

const conditions = healthConditions('host-sessions')
const last = new Map<string, string>()

export function hostSidesHealthKey(hostKey: string): string {
  return `host-sessions:${hostKey}`
}

function itemOf(hostKey: string, label: string, state: 'stood-down' | 'waiting'): NewNotification {
  const message = state === 'stood-down'
    ? `${label} took this Walnut for an older one that judges every session itself and stopped judging the sessions it runs. No one continues, retries or sends queued lines into them until the session channel to ${label} opens.`
    : `${label} keeps judging the sessions it runs, but this Walnut has not opened the session channel to it, so its copy of those sessions does not move.`
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: state === 'stood-down' ? `Sessions on ${label} are judged by no one` : `The session channel to ${label} did not open`,
    body: message,
    detail: `host session side on ${hostKey}: ${state}`,
    dedupKey: hostSidesHealthKey(hostKey),
    recoveryKey: hostSidesHealthKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  }
}

/** The host's report now (`sessionSide.state`, or null: no report of it). */
export function noteHostSessionSide(hostKey: string, state: unknown): void {
  const s = state === 'stood-down' || state === 'waiting' ? state : 'judging'
  if (last.get(hostKey) === s) return
  const before = last.get(hostKey)
  last.set(hostKey, s)
  if (s === 'judging') { if (before) void conditions.recover(hostSidesHealthKey(hostKey)).catch(() => {}); return }
  void conditions.raise(hostSidesHealthKey(hostKey), async () => itemOf(hostKey, await hostLabel(hostKey), s)).catch(() => {})
}

/** Tests only. */
export function _resetHostSideHealthForTesting(): void {
  last.clear()
  conditions.reset()
}
