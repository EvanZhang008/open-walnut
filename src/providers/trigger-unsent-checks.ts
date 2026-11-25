/**
 * The checks a host ran while no server of the trigger's Walnut was there to take the report
 * (2026-11-25: a clouddev trigger checked every 30 minutes from 05:09 to 08:40Z while the Mac
 * slept, and its record on the Mac kept only the check before and two after; read at 08:39Z it
 * said "last check 04:40Z" and looked stopped for four hours). The daemon keeps them, bounded,
 * in the trigger's state file, and the configure of a server that dedups checks takes them, oldest
 * first, before the latest one (daemon-trigger-set.ts), so the record has no hole.
 */
// Types only: the daemon's trigger area loads no trigger logic of its own (daemon-task-logic-ratchet.test.ts);
// reading the kept list from disk is trigger-check-core.ts's (coerceUnsentChecks).
import type { TriggerCheckedEvent, TriggerHostState } from './trigger-check-core.js'

/** The most kept per trigger: a day of a 30-minute trigger; older ones go first. */
export const UNSENT_CHECKS_MAX = 48

/** Keep a report no server took. */
export function keepUnsentCheck(state: TriggerHostState, checked: TriggerCheckedEvent): void {
  const list = state.unsentChecks ?? []
  if (list.some((c) => c.atMs === checked.atMs)) return
  list.push(checked)
  list.sort((a, b) => a.atMs - b.atMs)
  if (list.length > UNSENT_CHECKS_MAX) list.splice(0, list.length - UNSENT_CHECKS_MAX)
  state.unsentChecks = list
}

/** The kept reports, oldest first, now handed on (the list is emptied). */
export function takeUnsentChecks(state: TriggerHostState): TriggerCheckedEvent[] {
  const list = state.unsentChecks ?? []
  delete state.unsentChecks
  return list
}
