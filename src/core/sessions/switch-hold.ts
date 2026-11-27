/**
 * Whether a leader switch holds a session in the data home (home-sessions.ts) now: on the old leader from the switch
 * stop until a rollback settles it (its CLI was stopped there and may not start in the old home), and on the new
 * leader from the promotion until its records are in place (session-carry.ts placeCarriedRecords). Meanwhile restart
 * recovery does not take it on and a message for it is held (as for a task that moves to another host), so nothing
 * starts it where it cannot run.
 *
 * Before the stop marks the rows, a home a switch is handing over already carries its marker (`switching`): a message
 * for a session working in it is held from then (heldByHomeMarker), instead of a start the daemon would refuse; the
 * stop then marks the row, and the rollback's settle or the new leader delivers what waits.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SessionRecord } from '../types.js'
import { LEADER_SWITCH_MARKER_REL } from '../../lib/leader-home-gate.js'
import { execHostOf, judgedByHost } from './session-row-owner.js'

export function heldBySwitch(r: Pick<SessionRecord, 'leaderSwitch' | 'archived'> | null | undefined): boolean {
  const st = r?.leaderSwitch
  if (!st || st.rolledBack || r!.archived) return false
  return !st.moved || st.moved.records === 'pending'
}

/**
 * Whether `r`, a session of this machine's own daemon, works in `home` (by folder) while that home carries a switch's
 * marker. A host's session whose folder has the same path on its own machine is not held. One existsSync.
 */
export function heldByHomeMarker(r: Pick<SessionRecord, 'cwd' | 'archived' | 'host' | 'judge'> | null | undefined, home: string): boolean {
  if (!home || !r?.cwd || r.archived || !path.isAbsolute(r.cwd)) return false
  if (execHostOf(r) !== undefined || judgedByHost(r)) return false
  const rel = path.relative(path.resolve(home), path.resolve(r.cwd))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  return fs.existsSync(path.join(home, LEADER_SWITCH_MARKER_REL))
}
