/**
 * The rules of the write permission, as pure functions: what a witness accepts, and
 * whether a set of timing parameters is safe for the assumed clock drift.
 */
import type { PermitParams, PermitProgress, PermitRecord } from './types.js'
import { MAX_CLOCK_MARK_LENGTH, NO_HOLDER, majorityOf, nextConfigId, sameList } from './types.js'
import { applyOps, ledgerError, opChangesError, registrationConflict, type HeldOp } from './ops.js'

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
  /**
   * That configuration's generation (types.ts PermitRecord.epoch). For a witness waiting to
   * join: the generation it may join from (where it retired, or what its operator set up).
   * null: not set up at all (no file): it takes nothing.
   */
  epoch: number | null
  /**
   * The highest progress stamp any record it took carried. Kept when a later record carries
   * none or a lower one (a contending grant), so the takeover rule still sees how far the
   * last real holder wrote (review round 1, S-2).
   */
  progress: PermitProgress | null
  /** The op ids registered before outward sends, with their outcomes (ops.ts). */
  ops: HeldOp[]
}

function higher(a: PermitProgress | null, b: PermitProgress | undefined): PermitProgress | null {
  if (!b) return a
  return !a || b.seq > a.seq ? { seq: b.seq, writtenAt: b.writtenAt, ...(b.by ? { by: b.by } : {}) } : a
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
  if (!(p.opRetainMs >= 10 * p.validMs)) throw new Error('permit timing: opRetainMs must cover several permissions (10 x validMs at least)')
  if (!(p.backoffBaseMs > 0) || p.backoffMaxMs < p.backoffBaseMs) throw new Error('permit timing: backoffBaseMs must be positive and at most backoffMaxMs')
}

/**
 * The witness still keeps its record for that record's holder. A release is a hold that is
 * already over: its writer stopped acting before it sent it, and never acts again.
 *
 * Judged by the longer of the judge's own validity and the record's (its margin scaled with it):
 * a witness record one process opens with shorter clocks (a test's scaled permit, settings.ts
 * permitParamsFor) while another machine's longer record is held there must keep that record
 * its whole time. A mismatch only makes the witness wait longer, never shorter.
 */
export function holdsForHolder(s: WitnessState, now: number, p: PermitParams): boolean {
  return !!s.held && s.held.kind !== 'release' && now < s.acceptedAt + heldForMs(s.held, p)
}

/** How long a witness keeps `held` for its holder: witnessHoldMs(p), longer when the record says it is valid longer. */
function heldForMs(held: PermitRecord, p: PermitParams): number {
  const v = held.validMs
  if (!Number.isFinite(v) || v <= p.validMs) return witnessHoldMs(p)
  return v + p.witnessMarginMs * (v / p.validMs)
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
  if (typeof r.nonce !== 'string' || r.nonce.length === 0) return 'bad-nonce'
  // No machine id is empty: the empty holder is the release's "nobody" (NO_HOLDER).
  if (typeof r.by !== 'string' || r.by.length === 0) return 'bad-holder'
  if (!uniqueList(r.list) || typeof r.cfg !== 'string' || r.cfg.length === 0) return 'bad-list'
  if (!Number.isSafeInteger(r.epoch) || r.epoch < 0) return 'bad-epoch'
  if (r.progress && (!Number.isSafeInteger(r.progress.seq) || !Number.isFinite(r.progress.writtenAt) || (r.progress.by !== undefined && r.progress.by !== r.by))) {
    return 'bad-progress'
  }
  if (r.joint !== undefined && (!uniqueList(r.joint) || sameList(r.joint, r.list))) return 'bad-list'
  // The clock mark only informs: a kind this witness does not know yet (a newer holder) is
  // taken, so an upgrade never splits holders from older witnesses; only a malformed one is not.
  if (r.clock !== undefined && (typeof r.clock !== 'string' || r.clock.length === 0 || r.clock.length > MAX_CLOCK_MARK_LENGTH)) return 'bad-clock'
  // A release carries outcomes only: its writer never sends again, so it registers nothing.
  if (r.ops !== undefined && (!(r.kind === 'renew' || (r.kind === 'release' && !r.ops.register)) || opChangesError(r.ops))) return 'bad-ops'
  if (r.ledger !== undefined && (r.kind !== 'members' || ledgerError(r.ledger))) return 'bad-ledger'
  if (r.pairBy !== undefined && (r.kind !== 'members' || r.stage !== 'final' || !uniqueList(r.pairBy))) return 'bad-evidence'
  switch (r.kind) {
    case 'grant':
    case 'renew':
      return r.holder === r.by ? null : 'bad-holder'
    case 'handover':
      return r.from === r.by && r.to === r.holder && !!r.to && r.to !== r.from ? null : 'bad-handover'
    case 'cancel':
      return r.from === r.by && r.holder === r.by ? null : 'bad-cancel'
    case 'release':
      return r.from === r.by && r.holder === NO_HOLDER && r.to === undefined ? null : 'bad-release'
    case 'members':
      // Both steps of a change are judged by both lists: `joint` is the new list.
      if (r.holder !== r.by || !uniqueList(r.newList) || !sameList(r.joint, r.newList)) return 'bad-members'
      if (r.stage === 'final' && r.pairBy === undefined) return 'bad-evidence'
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
 * Whether a members record may move this witness from where it stands:
 * - a joining witness: only into the new list, never as a member of the old one (a witness
 *   that left a list, or lost its disk, must not count for it again: stress seed 1309);
 * - the pair step: from the old configuration, or the same pair again;
 * - the final step: from the pair, or the configuration it leads to again (by id: the same
 *   list from an earlier configuration is not it, stress seed 1754).
 */
function changeStartsHere(s: WitnessState, self: string, r: PermitRecord, joining: boolean): 'joining' | 'pair' | 'past' | null {
  // ...and only from its own generation or a later one: a witness that left at generation g
  // never took part in anything after g, so it cannot be one of the majority that left a
  // later configuration; a late step of an older change could put it back into a list
  // that majority already left, beside a straggler (stress seed 8618).
  if (joining) return s.epoch !== null && r.epoch >= s.epoch && r.newList!.includes(self) && !r.list.includes(self) ? 'joining' : null
  const fromOld = s.cfg === r.cfg && sameList(s.list, r.list)
  const inPair = fromOld && sameList(s.joint, r.newList)
  if (r.stage === 'joint') return fromOld && (!s.joint || inPair) ? 'pair' : null
  const finalAgain = !s.joint && s.cfg === nextConfigId(r.cfg, r.newList!) && sameList(s.list, r.newList)
  return inPair ? 'pair' : finalAgain ? 'past' : null
}

/**
 * The evidence a final step carries that its pair stood: the witnesses its writer saw hold the
 * pair, a majority of each list. A witness cannot ask the others, so it checks what it can: the
 * evidence names a majority of each list and only their members, and it names this witness only
 * if this witness did take the pair (it stands in the pair or past it). Each name comes from an
 * answer to the pair record itself or a state at or past the pair, and a witness's configuration
 * only moves forward, so the named witnesses took the pair and refuse the old list alone from
 * then on: no majority of the old list alone can form beside the new list.
 */
function pairEvidenceError(r: PermitRecord, self: string, path: 'joining' | 'pair' | 'past'): string | null {
  const by = r.pairBy!
  const next = r.newList!
  if (by.some((w) => !r.list.includes(w) && !next.includes(w))) return 'bad-evidence'
  const count = (l: string[]) => l.filter((w) => by.includes(w)).length
  if (count(r.list) < majorityOf(r.list) || count(next) < majorityOf(next)) return 'pair-not-shown'
  if (by.includes(self) && path === 'joining') return 'bad-evidence'
  return null
}

/**
 * A members record from the live holder, or once the record here ran out, from anyone (as
 * a grant): a change its holder left half done must not stay stuck. (A joining witness
 * holds no record that counts, so it has nothing to protect.)
 */
function mayRewrite(s: WitnessState, r: PermitRecord, now: number, p: PermitParams): boolean {
  const h = s.held
  const live = holdsForHolder(s, now, p)
  return (!!h && live && ownLive(h, r)) || !live
}

/**
 * The held record is `r`'s writer's own permission: same machine AND same incarnation. Another
 * process of the same machine is another holder (a second server started beside the first, or
 * one restarted while the old one still runs): it waits for the permission to run out like any
 * other machine, so two processes of one machine can never both hold it.
 */
function ownLive(h: PermitRecord, r: PermitRecord): boolean {
  return h.holder === r.by && h.kind !== 'handover' && h.nonce === r.nonce
}

/**
 * Whether witness `self` in state `s` accepts `r` at time `now` (its clock). The
 * number must be above what it holds, and the record must follow what it holds:
 * the permission changes hands only by a grant once the old record ran out here
 * (plus margin), or by a handover its holder wrote; a grant on a live record of its own
 * writer's process is taken as that process's renew would be; a cancel stands only on its own
 * handover or on its writer's live record. A release, from the same writer as a handover,
 * gives it to nobody: the witness holds nothing for anyone from then on (holdsForHolder), so
 * a grant is taken at once, and a renew, handover or cancel on it is refused.
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
  const accept = (list: string[] | null = s.list, joint: string[] | null = s.joint, cfg: string | null = s.cfg, epoch: number | null = s.epoch): Judgement =>
    ({ ok: true, next: { held: r, acceptedAt: now, list, joint, cfg, epoch, progress: higher(s.progress, r.progress), ops: applyOps(s.ops, r, now, p.opRetainMs) } })
  const joining = !isMember(s, self)

  if (r.kind === 'members') {
    const path = changeStartsHere(s, self, r, joining)
    if (!path) return { ok: false, reason: joining ? (s.epoch === null ? 'not-set-up' : 'not-a-member') : 'wrong-list' }
    if (s.held && r.number <= s.held.number) return { ok: false, reason: 'stale-number' }
    const evidence = r.stage === 'final' ? pairEvidenceError(r, self, path) : null
    if (evidence) return { ok: false, reason: evidence }
    if (!joining && !mayRewrite(s, r, now, p)) return { ok: false, reason: 'not-holder' }
    return r.stage === 'joint'
      ? accept([...r.list], [...r.newList!], r.cfg, r.epoch)
      : accept([...r.newList!], null, nextConfigId(r.cfg, r.newList!), r.epoch + 1)
  }

  if (joining) return { ok: false, reason: s.epoch === null ? 'not-set-up' : 'not-a-member' }
  const sameJoint = r.joint ? sameList(r.joint, s.joint) : s.joint === null
  if (r.cfg !== s.cfg || r.epoch !== s.epoch || !sameList(r.list, s.list) || !sameJoint) return { ok: false, reason: 'wrong-list' }
  if (s.held && r.number <= s.held.number) return { ok: false, reason: 'stale-number' }

  const live = holdsForHolder(s, now, p)
  const h = s.held
  switch (r.kind) {
    case 'grant':
      // Once what it holds ran out; or on a live record of the grant's own writer, same incarnation, which a renew of
      // that writer would replace just the same (ownLive: never on a handover, never for another process of the
      // machine). Without that, a process whose grant one witness took alone could never have a later grant taken
      // there until it ran out, while another witness, its record just run out, took that later grant alone: two
      // witnesses of a reachable pair each on another grant of the same process, and nothing standing on both
      // (the remote rehearsal's failed trial, 17 minutes without a leader).
      return live && !(h && ownLive(h, r)) ? { ok: false, reason: 'held' } : accept()
    case 'renew': {
      // On a handover to it (written by the old holder), any incarnation of the new holder; the
      // first renew a witness takes then fixes which one (ownLive).
      const mine = !!h && live && (ownLive(h, r) || (h.kind === 'handover' && h.holder === r.by))
      if (!mine) return { ok: false, reason: 'not-holder' }
      const conflict = registrationConflict(s.ops, r.ops, r.by, r.nonce)
      return conflict ? { ok: false, reason: conflict } : accept()
    }
    case 'handover':
      return h && live && ownLive(h, r) ? accept() : { ok: false, reason: 'not-holder' }
    case 'cancel': {
      const onOwnHandover = !!h && h.kind === 'handover' && h.from === r.by && h.nonce === r.nonce
      const onOwnLive = !!h && live && ownLive(h, r)
      return onOwnHandover || onOwnLive ? accept() : { ok: false, reason: 'nothing-to-cancel' }
    }
    case 'release':
      // As a handover: only on the writer's own live record, same incarnation. A witness that
      // holds another holder's record (or a handover) keeps holding it for them.
      return h && live && ownLive(h, r) ? accept() : { ok: false, reason: 'not-holder' }
  }
}

/**
 * A candidate's random wait before its next grant (full jitter): up to backoffBaseMs before the
 * first, doubling with each grant that did not stand, to backoffMaxMs. Candidates that see the
 * permission free at the same instant then ask one after the other, and the first to ask
 * reaches every witness before the others: no split where each witness took another
 * candidate's grant and nobody holds a majority until all of them run out.
 */
export function backoffDelayMs(tries: number, random: () => number, p: PermitParams): number {
  const cap = Math.min(p.backoffMaxMs, p.backoffBaseMs * 2 ** Math.min(Math.max(0, tries), 30))
  return random() * cap
}
