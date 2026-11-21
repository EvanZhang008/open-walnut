/**
 * The rules of the write permission, as pure functions: what a witness accepts, and
 * whether a set of timing parameters is safe for the assumed clock drift.
 */
import type { PermitParams, PermitRecord } from './types.js'
import { nextConfigId, sameList } from './types.js'

/** What one witness holds. `acceptedAt` is on the witness's own elapsed clock. */
export interface WitnessState {
  held: PermitRecord | null
  acceptedAt: number
  /** The witness list it serves; null while it waits to join through a members record. */
  list: string[] | null
  /** During a list change: the new list, judged together with `list`. */
  joint: string[] | null
  /** The id of the configuration of `list` (kept through the pair step); null while joining. */
  cfg: string | null
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
  return isMember(s, self) && !holdsForHolder(s, now, p)
}

export type Judgement = { ok: true; next: WitnessState } | { ok: false; reason: string }

function uniqueList(l: unknown): l is string[] {
  return Array.isArray(l) && l.length > 0 && l.every((x) => typeof x === 'string') && new Set(l).size === l.length
}

function shapeError(r: PermitRecord, p: PermitParams): string | null {
  if (!Number.isSafeInteger(r.number) || r.number < 1) return 'bad-number'
  if (r.validMs !== p.validMs) return 'bad-validity'
  if (!uniqueList(r.list) || typeof r.cfg !== 'string' || r.cfg.length === 0) return 'bad-list'
  if (r.joint !== undefined && (!uniqueList(r.joint) || sameList(r.joint, r.list))) return 'bad-list'
  switch (r.kind) {
    case 'grant':
    case 'renew':
      return r.holder === r.by ? null : 'bad-holder'
    case 'handover':
      return r.from === r.by && r.to === r.holder && !!r.to && r.to !== r.from ? null : 'bad-handover'
    case 'cancel':
      return r.from === r.by && r.holder === r.by ? null : 'bad-cancel'
    case 'members':
      // Both steps of a change are judged by both lists: `joint` is the new list.
      if (r.holder !== r.by || !uniqueList(r.newList) || !sameList(r.joint, r.newList)) return 'bad-members'
      return r.stage === 'joint' || r.stage === 'final' ? null : 'bad-members'
    default:
      return 'bad-kind'
  }
}

/** The witness serves a list it is on (in either half of a change). */
export function isMember(s: WitnessState, self: string): boolean {
  return !!s.list && (s.list.includes(self) || !!s.joint?.includes(self))
}

/**
 * Whether witness `self` in state `s` accepts `r` at time `now` (its clock). The
 * number must be above what it holds, and the record must follow what it holds:
 * the permission changes hands only by a grant once the old record ran out here
 * (plus margin), or by a handover its holder wrote; a cancel stands only on its own
 * handover or on its writer's live record.
 *
 * The witness list changes in two steps (joint consensus). A `members` record of stage
 * `joint` moves a witness from the old list to the pair (old, new): from then on it
 * takes only records judged by both lists, which count only with a majority of each.
 * Stage `final`, sent only once a joint record reached both majorities, moves it to the
 * new list alone. A witness never goes back from the pair to the old list, so once a
 * pair record counted, no majority of the old list alone can form again.
 */
export function judge(s: WitnessState, self: string, r: PermitRecord, now: number, p: PermitParams): Judgement {
  const bad = shapeError(r, p)
  if (bad) return { ok: false, reason: bad }
  const accept = (list: string[] | null = s.list, joint: string[] | null = s.joint, cfg: string | null = s.cfg): Judgement =>
    ({ ok: true, next: { held: r, acceptedAt: now, list, joint, cfg } })
  const joining = !isMember(s, self)

  if (r.kind === 'members') {
    const target = nextConfigId(r.cfg, r.newList!)
    const base = s.cfg === r.cfg && sameList(s.list, r.list)
    const pair = base && sameList(s.joint, r.newList)
    // A joining witness takes a change only into the new list, never as a member of the
    // old one: a witness that left a list (or lost its disk) must not count for it again,
    // or a list already replaced could gather a majority from it (stress seed 1309).
    const from = joining
      ? r.newList!.includes(self) && !r.list.includes(self)
      : r.stage === 'joint'
        ? base && (!s.joint || pair) // from the old configuration, or the same step again
        : pair || (!s.joint && s.cfg === target && sameList(s.list, r.newList)) // from the pair, or the same step again
    if (!from) return { ok: false, reason: joining ? 'not-a-member' : 'wrong-list' }
    if (s.held && r.number <= s.held.number) return { ok: false, reason: 'stale-number' }
    // From the live holder, or once the record here ran out, from anyone (as a grant): a
    // change its holder left half done must not stay stuck. A joining witness holds no
    // record that counts, so it has nothing to protect.
    const h = s.held
    const live = holdsForHolder(s, now, p)
    if (!joining && !((h && live && h.holder === r.by && h.kind !== 'handover') || !live)) return { ok: false, reason: 'not-holder' }
    return r.stage === 'joint' ? accept([...r.list], [...r.newList!], r.cfg) : accept([...r.newList!], null, target)
  }

  if (joining) return { ok: false, reason: 'not-a-member' }
  const sameJoint = r.joint ? sameList(r.joint, s.joint) : s.joint === null
  if (r.cfg !== s.cfg || !sameList(r.list, s.list) || !sameJoint) return { ok: false, reason: 'wrong-list' }
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
  }
}
