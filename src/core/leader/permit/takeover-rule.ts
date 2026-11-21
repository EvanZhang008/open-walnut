/**
 * The automatic takeover rule (design section 7), as a pure function of data. Nothing
 * calls it yet; it has no timers. A candidate may ask for the permission only when:
 *   1. a majority of the FIXED witness list answered that the old permission ran out
 *      on its own clock (grantable), never a majority of whoever answered; and
 *   2. its standby copy is provably no further behind than maxBehindMs. Proof is the
 *      holder's own progress stamp on the newest record: how far it had written then,
 *      plus one whole lease for what it may have written after the stamp. No stamp, or
 *      no stamp for the copy's own newest write, means no proof: refuse.
 */
import type { PermitParams, PermitReply } from './types.js'
import { genesisConfigId, majorityOf, sameList } from './types.js'
import { holderLeaseMs } from './rules.js'

export interface TakeoverRuleInput {
  self: string
  /** The configured witness list. */
  list: string[]
  /** Its configuration id (PermitClient.config().cfg); default: the first configuration. */
  cfg?: string
  /** Answers of one fresh read round. */
  reads: PermitReply[]
  /** The newest write in this machine's standby copy, with the holder's stamp for it. */
  standby: { seq: number; writtenAt?: number }
  params: PermitParams
  /** Design: 5 minutes. */
  maxBehindMs: number
}

export type TakeoverRuleAnswer = { ok: true; behindAtMostMs: number; reason: string } | { ok: false; reason: string }

export function mayAskForTakeover(input: TakeoverRuleInput): TakeoverRuleAnswer {
  const byWitness = new Map<string, PermitReply>()
  // Only a witness that serves this very list counts: one that moved to another list
  // would refuse the grant anyway.
  // (A witness in the middle of a list change does not count either.)
  const cfg = input.cfg ?? genesisConfigId(input.list)
  for (const r of input.reads) {
    if (input.list.includes(r.witness) && r.cfg === cfg && sameList(r.list, input.list) && !r.joint) byWitness.set(r.witness, r)
  }
  const need = majorityOf(input.list)
  const ranOut = [...byWitness.values()].filter((r) => r.grantable).length
  if (ranOut < need) {
    return { ok: false, reason: `the old permission ran out on ${ranOut} of ${input.list.length} witnesses, ${need} needed` }
  }
  // Any record a majority accepted is held (or a later one) by one of these answers.
  let newest = null as PermitReply['held']
  for (const r of byWitness.values()) if (r.held && (!newest || r.held.number > newest.number)) newest = r.held
  if (!newest) return { ok: true, behindAtMostMs: 0, reason: 'no machine ever held the permission' }
  if (newest.holder === input.self) return { ok: true, behindAtMostMs: 0, reason: 'this machine held it last' }
  const p = newest.progress
  if (!p) return { ok: false, reason: 'the last holder reported no progress: cannot prove how far behind the copy is' }
  let behind = holderLeaseMs(input.params)
  if (input.standby.seq < p.seq) {
    if (input.standby.writtenAt === undefined) return { ok: false, reason: 'the copy has no stamp for its newest write: cannot prove how far behind it is' }
    behind += Math.max(0, p.writtenAt - input.standby.writtenAt)
  }
  if (behind > input.maxBehindMs) {
    return { ok: false, reason: `the copy may be up to ${Math.round(behind / 1000)} s behind, the limit is ${Math.round(input.maxBehindMs / 1000)} s` }
  }
  return { ok: true, behindAtMostMs: behind, reason: 'the old permission ran out on a majority and the copy is close enough' }
}
