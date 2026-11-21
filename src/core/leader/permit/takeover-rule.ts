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
  /** The configured witness list. */
  list: string[]
  /** Its configuration id (PermitClient.config().cfg); default: the first configuration. */
  cfg?: string
  /**
   * A change left between its steps (PermitClient.config().joint, or a repair plan's pair):
   * the witnesses in that pair count, and the old permission must have run out on a majority
   * of each list. The candidate then finishes the change (repairChange) instead of a grant.
   */
  joint?: string[] | null
  /** Answers of one fresh read round. */
  reads: PermitReply[]
  /**
   * The newest write in this machine's standby copy: its seq, and the stamp its writer
   * made for it (writtenAt on writtenBy's wall clock).
   */
  standby: { seq: number; writtenAt?: number; writtenBy?: string }
  params: PermitParams
  /** Design: 5 minutes. */
  maxBehindMs: number
}

export type TakeoverRuleAnswer = { ok: true; behindAtMostMs: number; reason: string } | { ok: false; reason: string }

export function mayAskForTakeover(input: TakeoverRuleInput): TakeoverRuleAnswer {
  const byWitness = new Map<string, PermitReply>()
  // Only a witness that serves this very configuration counts: one that moved to another
  // list, or stands in the middle of a change, would refuse the grant anyway.
  const cfg = input.cfg ?? genesisConfigId(input.list)
  const joint = input.joint ?? null
  const lists = joint ? [input.list, joint] : [input.list]
  for (const r of input.reads) {
    const sameJoint = joint ? sameList(r.joint, joint) : !r.joint
    if (lists.some((l) => l.includes(r.witness)) && r.cfg === cfg && sameList(r.list, input.list) && sameJoint) byWitness.set(r.witness, r)
  }
  for (const l of lists) {
    const need = majorityOf(l)
    const ranOut = l.filter((w) => byWitness.get(w)?.grantable).length
    if (ranOut < need) {
      return { ok: false, reason: `the old permission ran out on ${ranOut} of ${l.length} witnesses (${l.join(', ')}), ${need} needed` }
    }
  }
  // Any record a majority accepted is held (or a later one) by one of these answers, and each
  // witness keeps the highest stamp it ever took, so the highest stamp here is at least the
  // last real holder's, even under a contending grant that carries none or an older one.
  let newest = null as PermitReply['held']
  let p = null as PermitReply['progress']
  for (const r of byWitness.values()) {
    if (r.held && (!newest || r.held.number > newest.number)) newest = r.held
    for (const stamp of [r.progress, r.held?.progress]) if (stamp && (!p || stamp.seq > p.seq)) p = stamp
  }
  if (!newest) return { ok: true, behindAtMostMs: 0, reason: 'no machine ever held the permission' }
  if (!p) return { ok: false, reason: 'the last holder reported no progress: cannot prove how far behind the copy is' }
  let behind = holderLeaseMs(input.params)
  if (input.standby.seq < p.seq) {
    if (input.standby.writtenAt === undefined) return { ok: false, reason: 'the copy has no stamp for its newest write: cannot prove how far behind it is' }
    // Two wall clocks are never subtracted: minutes of offset would hide minutes of writes.
    if (!p.by || input.standby.writtenBy !== p.by) {
      return { ok: false, reason: 'the copy\'s newest write and the last stamp were made by different machines: their clocks do not compare' }
    }
    behind += Math.max(0, p.writtenAt - input.standby.writtenAt)
  }
  if (behind > input.maxBehindMs) {
    return { ok: false, reason: `the copy may be up to ${Math.round(behind / 1000)} s behind, the limit is ${Math.round(input.maxBehindMs / 1000)} s` }
  }
  return { ok: true, behindAtMostMs: behind, reason: 'the old permission ran out on a majority and the copy is close enough' }
}
