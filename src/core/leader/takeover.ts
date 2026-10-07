/**
 * When the cloud companion takes the lead of a Walnut, keeps it, or gives it
 * back (docs/plan/walnut-control-plane.md, "Who leads"). Pure: the runtime in
 * backup-leader.ts feeds it what it saw and carries out the answer.
 *
 * Two independent views must agree before the companion leads:
 *   - its own: the primary's heartbeat (sent every 15s through the primary's
 *     own bridge) has been silent for `takeoverMs`, or for the longer window
 *     the primary announced when it went down for a restart;
 *   - every host it can reach: each daemon is a witness and says how long ago
 *     it last heard the primary. One host that still hears it is enough to
 *     wait: the link between the primary and the companion is down, not the
 *     primary.
 * Two nodes cannot settle a split on their own, so the hosts are the tie
 * breaker, and the epoch each host keeps fences the loser.
 */

export interface WitnessEntry {
  walnutId: string
  epoch: number
  holder: 'primary' | 'backup'
  primaryConnected: boolean
  primaryHeardAgoMs: number
}

/** One host's answer to `leader.witness` (or why there is none). */
export interface WitnessReport {
  host: string
  walnuts?: WitnessEntry[]
  error?: string
}

export interface TakeoverInput {
  now: number
  takeoverMs: number
  /** The last heartbeat from the primary, or when this companion started if it never heard one. */
  primaryLastSeenAt: number
  /** The primary said it is restarting and will be back by then. */
  restartingUntil?: number
  /** The Walnut this companion serves (from the heartbeat), when known. */
  walnutId?: string
  /** The hosts this companion leads now, with the epoch it holds on each. */
  leading: Map<string, number>
  reports: WitnessReport[]
}

export type TakeoverDecision =
  | { action: 'wait'; reason: string; walnutId?: string }
  | { action: 'claim'; walnutId: string; claims: Array<{ host: string; epoch: number }>; reason: string }
  | { action: 'demote'; hosts: string[]; reason: string; walnutId?: string }

/** The Walnut to act for: the heartbeat's, else the one every witness names. */
export function pickWalnutId(known: string | undefined, reports: WitnessReport[]): string | undefined {
  if (known) return known
  const ids = new Set<string>()
  for (const r of reports) for (const w of r.walnuts ?? []) ids.add(w.walnutId)
  return ids.size === 1 ? [...ids][0] : undefined
}

function entryFor(r: WitnessReport, walnutId: string): WitnessEntry | undefined {
  return (r.walnuts ?? []).find((w) => w.walnutId === walnutId)
}

export function decideTakeover(input: TakeoverInput): TakeoverDecision {
  const walnutId = pickWalnutId(input.walnutId, input.reports)
  const quietMs = input.now - input.primaryLastSeenAt
  const restartWindow = input.restartingUntil && input.restartingUntil > input.now
    ? input.restartingUntil - input.primaryLastSeenAt
    : 0
  const windowMs = Math.max(input.takeoverMs, restartWindow)

  if (!walnutId) {
    return input.leading.size > 0
      ? { action: 'demote', hosts: [...input.leading.keys()], reason: 'no host names the Walnut this companion leads' }
      : { action: 'wait', reason: 'no Walnut lets this companion lead' }
  }

  // Leading: a host where the primary took the lead back (a higher epoch) is
  // no longer ours. The others stay ours until the primary reaches them too;
  // its heartbeat coming back alone proves nothing about the hosts.
  if (input.leading.size > 0) {
    const lost: string[] = []
    for (const r of input.reports) {
      const mine = input.leading.get(r.host)
      if (mine === undefined) continue
      const e = entryFor(r, walnutId)
      if (!e || e.holder === 'primary' || e.epoch > mine) lost.push(r.host)
    }
    if (lost.length > 0) {
      return { action: 'demote', hosts: lost, walnutId, reason: 'the primary took the lead back' }
    }
  }

  if (quietMs < windowMs) {
    return {
      action: 'wait', walnutId,
      reason: input.leading.size > 0 ? 'leading; the primary is back but has not taken the lead yet' : 'the primary is alive',
    }
  }

  // Hosts not led yet that would agree to it now.
  const candidates = input.reports
    .filter((r) => !input.leading.has(r.host))
    .map((r) => ({ host: r.host, entry: entryFor(r, walnutId) }))
    .filter((c): c is { host: string; entry: WitnessEntry } => !!c.entry)
  if (candidates.length === 0) {
    return { action: 'wait', walnutId, reason: input.leading.size > 0 ? 'leading every host that lets it' : 'no reachable host lets this companion lead' }
  }
  // A single witness that still hears the primary means the primary is up and
  // only its link to this companion is down: lead nothing new.
  const hearing = candidates.find((c) => c.entry.primaryConnected || c.entry.primaryHeardAgoMs < input.takeoverMs)
  if (hearing) {
    return { action: 'wait', walnutId, reason: `${hearing.host} still hears the primary` }
  }
  return {
    action: 'claim', walnutId,
    claims: candidates.map((c) => ({ host: c.host, epoch: c.entry.epoch + 1 })),
    reason: `the primary has been silent for ${Math.round(quietMs / 1000)}s and no host hears it`,
  }
}
