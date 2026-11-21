/**
 * The rules of the write permission, as pure functions: what a witness accepts, and
 * whether a set of timing parameters is safe for the assumed clock drift.
 */
import type { PermitParams, PermitRecord } from './types.js'
import { sameList } from './types.js'

/** What one witness holds. `acceptedAt` is on the witness's own elapsed clock. */
export interface WitnessState {
  held: PermitRecord | null
  acceptedAt: number
  /** The witness list it serves; null while it waits to join through a members record. */
  list: string[] | null
}

/** How long the holder counts one record: from when it SENT it, on its own clock. */
export function holderLeaseMs(p: PermitParams): number {
  return p.validMs - p.holderMarginMs
}

/** How long a witness keeps a record for its holder: from when it ACCEPTED it, on its own clock. */
export function witnessHoldMs(p: PermitParams): number {
  return p.validMs + p.witnessMarginMs
}

/**
 * The largest clock rate error the margins cover. The holder's lease of L (its clock)
 * lasts at most L/(1-r) real time; a witness's hold of W (its clock) lasts at least
 * W/(1+r); the witness accepted no earlier than the holder sent. So it is safe while
 * L/(1-r) < W/(1+r), that is r < (W-L)/(W+L).
 */
export function maxSafeDrift(p: PermitParams): number {
  const L = holderLeaseMs(p)
  const W = witnessHoldMs(p)
  return (W - L) / (W + L)
}

/** Refuses parameters that cannot keep two holders apart under the assumed drift. */
export function checkTiming(p: PermitParams): void {
  const L = holderLeaseMs(p)
  if (!(p.validMs > 0) || !(L > 0)) throw new Error('permit timing: validMs must exceed holderMarginMs')
  if (p.holderMarginMs < 0 || p.witnessMarginMs < 0) throw new Error('permit timing: margins cannot be negative')
  if (!(p.renewEveryMs > 0) || p.renewEveryMs >= L) throw new Error('permit timing: renewEveryMs must be shorter than the holder lease')
  if (!(p.maxDriftRate >= 0) || p.maxDriftRate >= maxSafeDrift(p)) {
    throw new Error(`permit timing: margins cover a drift rate below ${maxSafeDrift(p).toFixed(4)}, assumed ${p.maxDriftRate}`)
  }
  if (p.minSendRemainingMs < 0 || p.minSendRemainingMs >= L) throw new Error('permit timing: minSendRemainingMs must be under the holder lease')
}

/** The witness still keeps its record for that record's holder. */
export function holdsForHolder(s: WitnessState, now: number, p: PermitParams): boolean {
  return !!s.held && now < s.acceptedAt + witnessHoldMs(p)
}

/** The witness would accept a grant to another machine now. */
export function grantable(s: WitnessState, self: string, now: number, p: PermitParams): boolean {
  return !!s.list && s.list.includes(self) && !holdsForHolder(s, now, p)
}

export type Judgement = { ok: true; next: WitnessState } | { ok: false; reason: string }

function shapeError(r: PermitRecord, p: PermitParams): string | null {
  if (!Number.isSafeInteger(r.number) || r.number < 1) return 'bad-number'
  if (r.validMs !== p.validMs) return 'bad-validity'
  if (!Array.isArray(r.list) || r.list.length === 0 || new Set(r.list).size !== r.list.length) return 'bad-list'
  switch (r.kind) {
    case 'grant':
    case 'renew':
      return r.holder === r.by ? null : 'bad-holder'
    case 'handover':
      return r.from === r.by && r.to === r.holder && !!r.to && r.to !== r.from ? null : 'bad-handover'
    case 'cancel':
      return r.from === r.by && r.holder === r.by ? null : 'bad-cancel'
    case 'members':
      if (r.holder !== r.by || !Array.isArray(r.newList) || r.newList.length === 0) return 'bad-members'
      if (new Set(r.newList).size !== r.newList.length || sameList(r.newList, r.list)) return 'bad-members'
      return null
    default:
      return 'bad-kind'
  }
}

/**
 * Whether witness `self` in state `s` accepts `r` at time `now` (its clock). The
 * number must be above what it holds, and the record must follow what it holds:
 * the permission changes hands only by a grant once the old record ran out here
 * (plus margin), or by a handover its holder wrote; a cancel stands only on its own
 * handover or on its writer's live record.
 */
export function judge(s: WitnessState, self: string, r: PermitRecord, now: number, p: PermitParams): Judgement {
  const bad = shapeError(r, p)
  if (bad) return { ok: false, reason: bad }
  const accept = (list: string[] | null = s.list): Judgement => ({ ok: true, next: { held: r, acceptedAt: now, list } })

  if (!s.list || !s.list.includes(self)) {
    // Waiting to join (new, or removed earlier): only a members record that names it,
    // which counts only with a majority of the old list behind it.
    if (r.kind === 'members' && r.newList!.includes(self) && (!s.held || r.number > s.held.number)) return accept([...r.newList!])
    return { ok: false, reason: 'not-a-member' }
  }
  // A members record may come again to a witness that already moved to its new list (the
  // first attempt reached one majority but not the other): the holder retries the same
  // change, or takes it back with the reverse one, and only both majorities count.
  const retry = r.kind === 'members' && sameList(r.newList, s.list)
  if (!sameList(r.list, s.list) && !retry) return { ok: false, reason: 'wrong-list' }
  if (s.held && r.number <= s.held.number) return { ok: false, reason: 'stale-number' }

  const live = holdsForHolder(s, now, p)
  const h = s.held
  switch (r.kind) {
    case 'grant':
      return live ? { ok: false, reason: 'held' } : accept()
    case 'renew':
      return h && live && h.holder === r.by ? accept() : { ok: false, reason: 'not-holder' }
    case 'handover':
      return h && live && h.holder === r.by && h.kind !== 'handover' ? accept() : { ok: false, reason: 'not-holder' }
    case 'cancel': {
      const onOwnHandover = !!h && h.kind === 'handover' && h.from === r.by
      const onOwnLive = !!h && live && h.holder === r.by && h.kind !== 'handover'
      return onOwnHandover || onOwnLive ? accept() : { ok: false, reason: 'nothing-to-cancel' }
    }
    case 'members':
      return h && live && h.holder === r.by && h.kind !== 'handover' ? accept([...r.newList!]) : { ok: false, reason: 'not-holder' }
  }
}
