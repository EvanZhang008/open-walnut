/**
 * Whether a leader switch holds a session in the data home (home-sessions.ts) now: on the old leader from the switch
 * stop until a rollback settles it (its CLI was stopped there and may not start in the old home), and on the new
 * leader from the promotion until its records are in place (session-carry.ts placeCarriedRecords). Meanwhile restart
 * recovery does not take it on and a message for it is held (as for a task that moves to another host), so nothing
 * starts it where it cannot run. Leaf module: types only.
 */
import type { SessionRecord } from '../../types.js'

export function heldBySwitch(r: Pick<SessionRecord, 'leaderSwitch' | 'archived'> | null | undefined): boolean {
  const st = r?.leaderSwitch
  if (!st || st.rolledBack || r!.archived) return false
  return !st.moved || st.moved.records === 'pending'
}
