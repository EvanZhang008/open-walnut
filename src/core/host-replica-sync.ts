/**
 * When the hosts' read copies are brought up to date (core/host-replica.ts):
 * a few seconds after a note, MEMORY.md / USER.md, or the settings change, and
 * every few minutes for what changes without an event (a skill edited on disk,
 * a note synced in by git). A round that finds nothing changed sends nothing.
 * The cloud companion is one of the targets (core/host-replica.ts
 * syncCompanionHostReplica). Primary only: the companion pushes no copies.
 */

import { CLOUD_MODE } from '../constants.js'

const DEBOUNCE_MS = 3_000
const SWEEP_MS = 5 * 60_000
const FIRST_ROUND_MS = 20_000
const SUBSCRIBER = 'host-replica-sync'

export function startHostReplicaSync(): { stop: () => void } {
  if (CLOUD_MODE) return { stop: () => {} }
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const push = (): void => {
    if (stopped) return
    void import('../providers/daemon-connection.js').then((m) => m.pushHostReplicaToAllHosts()).catch(() => { /* the next sweep */ })
    // The cloud companion keeps the same copy (stage 4), over HTTPS rather than a daemon link.
    void import('./host-replica.js').then((m) => m.syncCompanionHostReplica()).catch(() => { /* the next sweep */ })
  }
  const soon = (): void => {
    if (timer || stopped) return
    timer = setTimeout(() => { timer = null; push() }, DEBOUNCE_MS)
    timer.unref?.()
  }
  void import('./event-bus.js').then(({ bus, EventNames }) => {
    if (stopped) return
    const names = [EventNames.NOTES_UPDATED, EventNames.NOTES_TREE_CHANGED, 'memory:updated', EventNames.CONFIG_CHANGED]
    bus.subscribe(SUBSCRIBER, (event) => { if (names.includes(event.name)) soon() }, { global: true, interest: names })
  })
  const sweep = setInterval(push, SWEEP_MS)
  sweep.unref?.()
  // The daemons get theirs when they connect; the companion has no connect here.
  const first = setTimeout(push, FIRST_ROUND_MS)
  first.unref?.()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      clearTimeout(first)
      clearInterval(sweep)
      void import('./event-bus.js').then(({ bus }) => bus.unsubscribe(SUBSCRIBER)).catch(() => {})
    },
  }
}
