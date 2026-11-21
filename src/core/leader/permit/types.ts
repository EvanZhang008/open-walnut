/**
 * The leader's write permission (docs/reference/leader-write-permission.md): one
 * numbered record per Walnut, kept by a fixed list of witnesses. Wired to nothing yet.
 */

export type PermitKind = 'grant' | 'renew' | 'handover' | 'cancel' | 'members'

/**
 * One record. A higher number always wins at a witness; the record a majority of the
 * witness list holds is the permission. `holder` is the machine the record gives the
 * permission to (a handover gives it to `to`, a cancel back to `from`).
 *
 * There is no wall-clock `validUntil`: every machine measures `validMs` on its own
 * clock from its own event (the holder from when it SENT the record, a witness from
 * when it ACCEPTED it), so a clock that is minutes off changes nothing; only the rate
 * of a clock matters (PermitParams.maxDriftRate).
 */
export interface PermitRecord {
  number: number
  kind: PermitKind
  holder: string
  /** The machine that wrote it. */
  by: string
  /** handover and cancel: the old holder. */
  from?: string
  /** handover: the new holder. */
  to?: string
  validMs: number
  /** The witness list this record is judged by (sorted ids). */
  list: string[]
  /** members: the list that replaces `list` once a majority of both accepted it. */
  newList?: string[]
  /**
   * The holder's write progress as of this record (design section 7: the leader reports
   * how far it wrote on every renew; a standby compares its saved copy against it).
   * `writtenAt` is the holder's own wall clock, comparable only with other stamps it made.
   */
  progress?: { seq: number; writtenAt: number }
}

export interface PermitParams {
  /** How long one record lasts, measured by each side on its own clock (design: 60 s). */
  validMs: number
  /** How often the holder renews (design: 15 s). */
  renewEveryMs: number
  /** The holder treats its permission as ended this much before validMs runs out. */
  holderMarginMs: number
  /** A witness waits this much past validMs before it grants to another machine. */
  witnessMarginMs: number
  /**
   * The assumed bound on how far any clock's RATE differs from real time (0.02 = 2%).
   * The margins must cover it: checkTiming() refuses params that do not.
   */
  maxDriftRate: number
  /** assertMayAct refuses an outward send with less than this left (design: 15 s). */
  minSendRemainingMs: number
}

export const DEFAULT_PERMIT_PARAMS: PermitParams = {
  validMs: 60_000,
  renewEveryMs: 15_000,
  holderMarginMs: 2_000,
  witnessMarginMs: 2_000,
  maxDriftRate: 0.02,
  minSendRemainingMs: 15_000,
}

/** A machine to a witness. */
export type PermitRequest =
  | { type: 'propose'; record: PermitRecord }
  | { type: 'read' }

/** A witness's answer. `held` is what it holds after handling the request. */
export interface PermitReply {
  witness: string
  /** The request this answers: the proposed record's number, or 'read'. */
  re: number | 'read'
  ok: boolean
  reason?: string
  held: PermitRecord | null
  /** The witness list this witness holds (null: it is waiting to join). */
  list: string[] | null
  /** Whether this witness would grant the permission to another machine now. */
  grantable: boolean
}

/** How a machine reaches the witnesses. The reply comes back through PermitClient.receive. */
export interface PermitTransport {
  send(witness: string, req: PermitRequest): void
}

/** A clock that only measures elapsed time (milliseconds); its zero means nothing. */
export interface ElapsedClock {
  now(): number
}

export function sameList(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((v, i) => v === y[i])
}

export function majorityOf(list: readonly string[]): number {
  return Math.floor(list.length / 2) + 1
}

/** Canonical text of a record: two records are the same record when this matches. */
export function recordKey(r: PermitRecord): string {
  return JSON.stringify([
    r.number, r.kind, r.holder, r.by, r.from ?? null, r.to ?? null, r.validMs,
    [...r.list].sort(), r.newList ? [...r.newList].sort() : null,
    r.progress ? [r.progress.seq, r.progress.writtenAt] : null,
  ])
}

export function sameRecord(a: PermitRecord | null | undefined, b: PermitRecord | null | undefined): boolean {
  return !!a && !!b && recordKey(a) === recordKey(b)
}
