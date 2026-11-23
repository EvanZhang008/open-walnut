/**
 * What a turn end says for its task's phase by its data alone, in ONE place: the leader's turn-end
 * handlers (web/server.ts, session:result and session:error) and the record the session channel
 * keeps of a host's turn end until the leader acted on it (session-channel/turn-ends.ts).
 *
 * The phase itself is always decided by applySessionPhase (phase.ts) with the edge named here; this
 * only says which edge the event is, or none:
 *
 *   a host's retrier took it  none, when the host's stamp (`hostTakenBy`, turn-run-host.ts) names a
 *                   reason that keeps the phase (TURN_RETRY_TRAITS: a usage-limit or endpoint wait, a
 *                   restart recovery, a safeguard switch, a context recovery): Walnut continues the turn
 *   session:result  interrupted: none (a Stop of a compaction-only turn: a result edge); work that
 *                   goes on after the reply (a team, a detached background command, an armed
 *                   wakeup): none; an error result: session:error; else session:result
 *   session:error   a delivery failure is no turn outcome: none; else session:error
 *
 * What only the server can know at the time (a quiet turn, a retrier that takes the turn end:
 * turn-run.ts turnEndTakenBy) is checked by the caller and by applySessionPhase, not here.
 */
import { TURN_RETRY_TRAITS } from './turn-run.js'
import { stampedTakenBy } from './turn-run-host.js'

export type TurnEndEdge = 'session:result' | 'session:error'

interface TurnEndData {
  interrupted?: unknown
  compactionStopped?: unknown
  isError?: unknown
  teamActive?: unknown
  backgroundActive?: unknown
  detachedBgActive?: unknown
  wakeupPending?: unknown
  errorKind?: unknown
  hostTakenBy?: unknown
}

/** The reply is out but the session's work goes on (a team, a detached command, an armed wakeup): no hand-back yet. */
export function turnEndWorkContinues(data: unknown): boolean {
  const d = (data ?? {}) as TurnEndData
  return d.teamActive === true || d.backgroundActive === true || d.detachedBgActive === true || d.wakeupPending === true
}

/** The phase edge of a turn-end event of `name`, or null when it moves no phase. */
export function turnEndEdgeOf(name: string, data: unknown): TurnEndEdge | null {
  const d = (data ?? {}) as TurnEndData
  if (name !== 'session:result' && name !== 'session:error') return null
  const taken = stampedTakenBy(d)
  if (taken && (TURN_RETRY_TRAITS as Record<string, { keepsPhase: boolean } | undefined>)[taken]?.keepsPhase) return null
  if (name === 'session:result') {
    if (d.interrupted === true) return d.compactionStopped === true ? 'session:result' : null
    if (turnEndWorkContinues(d)) return null
    return d.isError === true ? 'session:error' : 'session:result'
  }
  if (name === 'session:error') return d.errorKind === 'delivery_failed' ? null : 'session:error'
  return null
}
