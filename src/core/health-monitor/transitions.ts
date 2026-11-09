/**
 * How an alarm instance moves between states beyond its raw verdict: the flap hold
 * (a ring soon after a clear waits a little) and what counts as one episode.
 */

import type { AlarmDef, AlarmInstanceState, AlarmState } from './types.js'

/** An alarm back in ALARM within this of clearing must cross for one more period (flapping). */
export const FLAP_WINDOW_MS = 60 * 60_000
const flapHoldMs = (def: AlarmDef): number => Math.min(Math.max(def.periodMin, 2), 30) * 60_000

/**
 * The state to move to for `verdict`: an alarm that cleared less than an hour ago rings again
 * only once it crossed for one more period. Keeps `inst.heldSince` while it holds.
 */
export function flapHeld(def: AlarmDef, inst: AlarmInstanceState, verdict: AlarmState, now: number): AlarmState {
  if (verdict === 'ALARM' && inst.state !== 'ALARM' && inst.clearedAt !== undefined && now - inst.clearedAt < FLAP_WINDOW_MS) {
    inst.heldSince ??= now
    return now - inst.heldSince < flapHoldMs(def) ? inst.state : verdict
  }
  delete inst.heldSince
  return verdict
}

/** Ringing again after no data that followed an ALARM, with no OK between: its actions still hold. */
export function sameEpisode(inst: AlarmInstanceState): boolean {
  if (inst.state !== 'INSUFFICIENT_DATA') return false
  for (let i = inst.history.length - 1; i >= 0; i--) {
    const h = inst.history[i]!
    if (h.to === 'OK' || h.from === 'OK') return false
    if (h.from === 'ALARM') return true
  }
  return false
}
