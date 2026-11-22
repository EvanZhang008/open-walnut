/**
 * A relayed call whose session sid the host's daemon could not prove.
 *
 * A host's daemon checks the process on its gateway socket against the session sid the line
 * names (providers/caller-proof-core.ts). When it cannot read that process (the JS twin never
 * can), it keeps the claimed sid and marks the relayed payload `callerUnproven: true`. The
 * server that runs the call (the leader, or the host's own replica while the leader is away)
 * keeps the sid for provenance, and the start-mode ceiling (core/sessions/delegated-mode.ts,
 * replica/start-ceiling.ts) reads such a caller as the anonymous `external`, capped at
 * `default`: a session naming its bypass sibling's sid never borrows that sibling's ceiling.
 *
 * The mark rides the op's own self-calls as a plain header, like `x-walnut-origin`: it can
 * only LOWER trust, so a caller that writes it on its own request only caps itself, and no
 * secret or hold is needed. A token kept in memory would fail open where this cannot: a hold
 * full of live tokens, or one read after its time ran out, would read as no mark at all.
 *
 * Zero imports: the executor, the routes and the replica all load this.
 */

export const CALLER_UNPROVEN_HEADER = 'x-walnut-caller-unproven'

/** True when a relayed tools.call payload carries the daemon's mark (only the literal `true`). */
export function relayedCallerUnproven(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { callerUnproven?: unknown }).callerUnproven === true
}

interface HeaderLike { headers: Record<string, string | string[] | undefined> }

/**
 * Whether a request carries the mark: any non-empty value counts (it only lowers trust), so a
 * mangled or repeated header still caps. `true` or undefined, to spread into start params.
 */
export function callerUnprovenOf(req: HeaderLike | undefined): true | undefined {
  const raw = req?.headers?.[CALLER_UNPROVEN_HEADER]
  const v = Array.isArray(raw) ? raw.find((x) => typeof x === 'string' && x.trim()) : raw
  return typeof v === 'string' && v.trim() ? true : undefined
}
