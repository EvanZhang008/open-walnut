/**
 * What a host said of this Walnut's data dir, as Walnut Health items (audience.ts: no needsYou,
 * never a popup), one per host and condition:
 *
 *   - refused (`walnut_home_busy`): the Walnut that used this data dir declared a move to another
 *     data dir there (walnut-scope-core.ts), so this copy is an older one, revived or copied. The
 *     host's sessions are the other copy's and keep running.
 *   - refused while this Walnut declared a move (`contested`): another copy of its data declared
 *     one there first and still holds this Walnut's id on this machine (a copy that is gone is
 *     replaced by itself: primary-leader.ts describeTo), so a person picks which copy is real.
 *   - refused (`walnut_home_taken`): ANOTHER Walnut used this data dir's path there and moved; the
 *     host keeps that Walnut's data under the path, so this one needs a data folder of its own
 *     (or it is the user's earlier Walnut, started again from the folder it moved to).
 *   - a declared move not taken (leader.configure's `moveNotTaken`): the host keeps this Walnut's
 *     earlier data under a folder it could not follow, so what ran there before is not shown.
 *
 *   - a leader switch to this data dir whose commit is not confirmed in time (moved-home.ts): every
 *     host is held, sends nothing and retries, until a witness majority confirms it.
 *
 * An accepted leader.configure clears the refusal; one that took the declared move clears the other.
 */

import type { NewNotification } from '../notifications/store.js'
import { healthConditions, hostLabel } from '../notifications/health-items.js'
import { inProcessDaemonWantedNow } from '../../providers/in-process-daemon.js'

const conditions = healthConditions('home-move')

export type HomeRefusalKind = 'busy' | 'contested' | 'taken'

export function homeBusyKey(hostKey: string): string {
  return `walnut-home-busy:${hostKey}`
}

export function homeMoveKey(hostKey: string): string {
  return `walnut-home-move:${hostKey}`
}

export function homeBusyItem(hostKey: string, label: string, movedTo: string, kind: HomeRefusalKind = 'busy'): NewNotification {
  const where = movedTo ? ` (moved to ${movedTo})` : ''
  const words = kind === 'taken'
    ? {
        title: `Another Walnut used this data folder on ${label}`,
        body: `Another Walnut used this data folder's path on ${label} and moved to another folder${movedTo ? `, ${movedTo}` : ''}. ${label} keeps that Walnut's data under this path, so this Walnut cannot use it from here. Run this Walnut from another data folder to use ${label}.${movedTo ? ` If that was your earlier Walnut, start Walnut from ${movedTo} instead.` : ''}`,
        detail: `walnut_home_taken on ${hostKey}: the host keeps another Walnut under this path, which moved${movedTo ? ` to ${movedTo}` : ''}`,
      }
    : kind === 'contested' && movedTo
    ? {
        title: `${label} follows another copy of this Walnut`,
        body: `Another copy of this Walnut's data, at ${movedTo}, reached ${label} first, so ${label} keeps working with that copy and not this one. If the copy at ${movedTo} is an old one, quit any Walnut running from it and delete or rename that folder: this copy takes ${label} over the next time it connects (restart Walnut to do it now). If ${movedTo} is the copy you use, run Walnut from there.`,
        detail: `walnut_home_busy on ${hostKey}: the host follows the copy of this Walnut at ${movedTo}, which still holds this Walnut's id`,
      }
    : {
        title: `Another copy of this Walnut uses ${label}`,
        body: `Another copy of this Walnut's data uses ${label}${where}. This copy cannot use that host.`,
        detail: `walnut_home_busy on ${hostKey}: the host keeps this Walnut under the data dir it moved to${movedTo ? `, ${movedTo}` : ''}`,
      }
  return { kind: 'operation-error', severity: 'warning', ...words, dedupKey: homeBusyKey(hostKey), recoveryKey: homeBusyKey(hostKey), category: 'Sessions', host: hostKey }
}

/** Why a host did not take a declared move, in plain words (walnut-scope-core.ts moveNotTakenTold). */
const NOT_TAKEN_WHY: Record<string, string> = {
  lost_trail: 'it knows this Walnut under a folder this one no longer lists',
  own_record: 'it already keeps this data folder as a Walnut of its own',
  already_aliased: 'it keeps this data folder as part of another Walnut',
  not_persisted: 'it could not save the move; it tries again at the next connect',
}

export function homeMoveItem(hostKey: string, label: string, why: string): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: `${label} could not follow this Walnut's move`,
    body: `This Walnut's data folder moved, and ${label} keeps its earlier data under another folder: ${NOT_TAKEN_WHY[why] ?? 'it did not take the move'}. Sessions and routines this Walnut ran there before the move are not shown.`,
    detail: `moveNotTaken on ${hostKey}: ${why}`,
    dedupKey: homeMoveKey(hostKey),
    recoveryKey: homeMoveKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  }
}

/** The host refused this data dir: raise (or count again) its item. */
export function noteHomeBusy(hostKey: string, movedTo: string, kind: HomeRefusalKind = 'busy'): void {
  void conditions.raise(homeBusyKey(hostKey), async () => homeBusyItem(hostKey, await hostLabel(hostKey), movedTo, kind))
}

/** The host took the description but not the declared move: raise (or count again) its item. */
export function noteMoveNotTaken(hostKey: string, why: string): void {
  void conditions.raise(homeMoveKey(hostKey), async () => homeMoveItem(hostKey, await hostLabel(hostKey), why))
}

/** The host took the declared move (a move is declared only under the experiment): its item recovers. */
export function noteMoveTaken(hostKey: string): void {
  if (conditions.toldOf(homeMoveKey(hostKey)) === 'clear') return
  void conditions.recover(homeMoveKey(hostKey))
}

/**
 * The host took this Walnut's description: an item raised in this process recovers. One from an
 * earlier process is read only under the one-service experiment, the only way a refused copy is
 * let in again (a declared move back), so with it off a connect never reads the store for this.
 */
export function noteHomeServed(hostKey: string): void {
  const key = homeBusyKey(hostKey)
  const told = conditions.toldOf(key)
  if (told === 'clear') return
  if (told === 'raised') { void conditions.recover(key); return }
  const on = inProcessDaemonWantedNow()
  if (on === false) return
  if (on === true) { void conditions.recover(key); return }
  void import('../../providers/in-process-daemon.js')
    .then(({ inProcessDaemonWanted }) => inProcessDaemonWanted())
    .then((yes) => (yes ? conditions.recover(key) : undefined))
    .catch(() => {})
}

export const SWITCH_HELD_KEY = 'walnut-switch-held'

export function switchHeldItem(switchId: string): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: 'Hosts wait for the leader switch to be confirmed',
    body: `This Walnut became the leader by switch ${switchId}, but a majority of its witnesses has not confirmed it yet. Until they do, no host is connected to it, so its hosts keep the earlier leader's triggers, jobs and sessions as they were and nothing of them is lost. It connects again on its own once the witnesses answer.`,
    detail: `leader switch ${switchId}: commit not confirmed; host connections held (home-move.ts HomeMoveHeld)`,
    dedupKey: SWITCH_HELD_KEY,
    recoveryKey: SWITCH_HELD_KEY,
    category: 'Sessions',
  }
}

/** A leader switch's commit was not confirmed in time: hosts are held (raise, or count again). */
export function noteSwitchHeld(switchId: string): void {
  void conditions.raise(SWITCH_HELD_KEY, async () => switchHeldItem(switchId))
}

/** The switch's commit is confirmed and its move declared: the held item, if any, recovers. */
export function noteSwitchConfirmed(): void {
  if (conditions.toldOf(SWITCH_HELD_KEY) === 'clear') return
  void conditions.recover(SWITCH_HELD_KEY)
}

/** Tests only. */
export function _resetHomeBusyHealthForTesting(): void {
  conditions.reset()
}
