/**
 * The turn of a session its host runs and judges, as the leader reads it (turn-run.ts). The retriers
 * that continue such a turn run on its host (session-channel/host-resend.ts), so their state is the
 * host's, not this server's: the leader reads it from what the host sends.
 *
 *   at the turn end   the host stamps its own answer on the session:result / session:error fact
 *                     (`hostTakenBy`, host-emitter.ts), taken at the event as its own readers take it;
 *                     the leader's turnEndTakenBy answers with it
 *   any time after    the host's waits and stops ride the session's `live` record (`turnWaits`,
 *                     `turnStops`, host-live.ts); the leader's turnRunNow answers a host-judged
 *                     record with them
 *
 * A source is installed only by the leader side (session-channel/leader-boot.ts); with none, and for
 * every session no host judges, the leader's own rows answer as before. Imports nothing: turn-run.ts
 * is imported by every reader.
 */
import type { TurnRetryReason } from '../types.js'

/** What the host says of its session's current turn (the shape of turn-run.ts TurnWait, kept loose here). */
export interface HostTurnState {
  waits: ReadonlyArray<{ reason: TurnRetryReason } & Record<string, unknown>>
  stops: ReadonlyArray<{ reason: TurnRetryReason } & Record<string, unknown>>
}

type Source = (sid: string) => HostTurnState | null
let source: Source | null = null

/** Installed by the leader side: the host's turn state of a session a host judges, null for any other. */
export function setHostTurnSource(fn: Source | null): void {
  source = fn
}

/** The host's turn state of `sid`, or null (a session this server judges, or no word from its host yet). */
export function hostTurnOf(sid: string | undefined): HostTurnState | null {
  if (!sid || !source) return null
  try { return source(sid) } catch { return null }
}

/** The host's answer stamped on a turn-end fact: a reason, null (no retrier took it), or undefined (not stamped). */
export function stampedTakenBy(end: { hostTakenBy?: unknown }): TurnRetryReason | null | undefined {
  const v = end.hostTakenBy
  if (v === null) return null
  return typeof v === 'string' && v ? v as TurnRetryReason : undefined
}
