/**
 * Whose fault an event-loop stall is: Walnut's own work, or the machine.
 *
 * The stall flight recorder gives every probe-late hold of a second or more a
 * verdict (stall-recorder-hold.ts). `starved` and `paging` mean the loop thread
 * barely ran in the hold because the machine did not run it (CPU or memory
 * pressure, swap), so no Walnut code path is there to fix. On 2026-11-09 the
 * health alarm counted every stall alike and opened a "fix Walnut" task for 17
 * holds of 18 that read `starved` (the server ran 22 ms of CPU in a 2.9 s hold,
 * load 42 to 175, 315 MB free, 17 GB in the compressor, the disk 6 GB from full).
 *
 * So each stall is counted under one of two health metrics: the own one feeds
 * the `eventloop.stall` alarm (a fix task), the machine one `eventloop.starved`
 * (shown on the Health page). A hold with no verdict (the recorder is off, or it
 * was under a second) counts as Walnut's: nothing showed it was the machine.
 */

import type { HoldVerdict } from './stall-recorder-hold.js'

export type StallCause = 'own' | 'machine'

export const STALL_OWN_METRIC = 'eventloop.stall.own'
export const STALL_MACHINE_METRIC = 'eventloop.stall.machine'

/** Every verdict, classified. A new verdict fails to compile until it is listed here. */
export const CAUSE_OF_VERDICT: Readonly<Record<HoldVerdict, StallCause>> = {
  cpu: 'own',
  gc: 'own',
  // A blocking call on the loop (sync I/O, a lock) is Walnut code.
  'off-cpu': 'own',
  starved: 'machine',
  paging: 'machine',
}

export function stallCauseOf(hold: Record<string, unknown> | undefined): StallCause {
  const v = hold?.verdict
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(CAUSE_OF_VERDICT, v)) {
    return CAUSE_OF_VERDICT[v as HoldVerdict]
  }
  return 'own'
}

export function stallMetricOf(hold: Record<string, unknown> | undefined): string {
  return stallCauseOf(hold) === 'machine' ? STALL_MACHINE_METRIC : STALL_OWN_METRIC
}
