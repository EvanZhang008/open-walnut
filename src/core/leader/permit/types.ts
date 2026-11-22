import { createHash } from 'node:crypto'

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
  /**
   * The writer's incarnation: random per PermitClient (per process start). Two processes
   * never write the same record, so a yes a witness gave a record sent before a restart
   * is never taken for a yes to one sent after it (review round 1, B-1).
   */
  nonce: string
  /** handover and cancel: the old holder. */
  from?: string
  /** handover: the new holder. */
  to?: string
  validMs: number
  /** The witness list this record is judged by (sorted ids). */
  list: string[]
  /**
   * Which configuration of that list: an id chained from the first list through every
   * change (configId, nextConfigId). The same list can come back after changes; only the
   * id tells a witness that never followed them from one that did.
   */
  cfg: string
  /**
   * How many list changes led to that configuration (0 for the first list). It orders
   * configurations, which the chained id cannot: a witness waiting to join takes a change
   * only from its own generation or a later one, never a late step of an older change.
   */
  epoch: number
  /**
   * During a witness list change: the new list. The record is then judged by both lists
   * and counts only with a majority of each.
   */
  joint?: string[]
  /** members: the list that replaces `list` (equal to `joint`). */
  newList?: string[]
  /** members: 'joint' enters the pair (list, newList); 'final' leaves it for newList alone. */
  stage?: 'joint' | 'final'
  /**
   * The holder's write progress as of this record (design section 7: the leader reports
   * how far it wrote on every renew; a standby compares its saved copy against it).
   * `writtenAt` is the holder's own wall clock, comparable only with other stamps it made.
   */
  progress?: PermitProgress
  /** renew: op ids registered before an outward send, and outcomes reported after it (ops.ts). */
  ops?: OpChanges
  /**
   * members: every op entry the writer knows. A witness joining the new list takes them, so an
   * op registered under the old list is still refused under the new one (ops.ts).
   */
  ledger?: OpEntry[]
  /**
   * members, stage 'final': the witnesses the writer saw hold the pair step (an answer to the
   * pair record itself, or a state at or past the pair). A witness refuses a final whose list
   * names no majority of each list, or names itself when it never took the pair.
   */
  pairBy?: string[]
  /** Which clock the writer counts its lease on (clock.ts HolderClockKind). */
  /** A HolderClockKind from this version; any short string from a newer one is taken too. */
  clock?: HolderClockKind | (string & {})
}

/**
 * The holder's clock: 'boottime' (Linux CLOCK_BOOTTIME) and 'continuous' (macOS
 * mach_continuous_time) count a sleep at once; 'mono-wall' (no system clock reachable) takes the
 * larger of the monotonic and the wall clock, which misses a sleep the wall clock was set back by.
 */
export type HolderClockKind = 'boottime' | 'continuous' | 'mono-wall'
export const HOLDER_CLOCK_KINDS: readonly HolderClockKind[] = ['boottime', 'continuous', 'mono-wall']
/** The longest clock mark a witness takes: the mark only informs, so unknown kinds pass. */
export const MAX_CLOCK_MARK_LENGTH = 32

/**
 * One outward send's op id, as the witnesses keep it (design section 6). 'registered': the
 * holder may send it, or did, with no outcome reported: its outcome is unknown, and no one
 * sends it again. 'sent' and 'not-sent': its outcome, reported by a holder.
 */
export type OpState = 'registered' | 'sent' | 'not-sent'
export interface OpEntry {
  id: string
  state: OpState
  /** The machine and incarnation that registered it. */
  by: string
  nonce: string
}
export interface OpChanges {
  register?: string[]
  sent?: string[]
  notSent?: string[]
}

/**
 * How far a holder had written. `seq` is the Walnut data's own write sequence: ONE sequence
 * for the Walnut, which a new holder continues from the copy it took over (never a counter of
 * each machine's own). `writtenAt` is the writer's wall clock, so it compares only with other
 * stamps of the same writer (`by`).
 */
export interface PermitProgress {
  seq: number
  writtenAt: number
  /** The machine that made the stamp; PermitClient fills it in. */
  by?: string
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
  /**
   * How long a witness keeps an op entry once its outcome is known, on its own clock (an
   * unknown one stays until a holder reports it). Longer than any standby copy may lag.
   */
  opRetainMs: number
  /** A candidate's random wait before a grant: up to backoffBaseMs, doubling per failed try to backoffMaxMs. */
  backoffBaseMs: number
  backoffMaxMs: number
}

export const DEFAULT_PERMIT_PARAMS: PermitParams = {
  validMs: 60_000,
  renewEveryMs: 15_000,
  holderMarginMs: 2_000,
  witnessMarginMs: 2_000,
  maxDriftRate: 0.02,
  minSendRemainingMs: 15_000,
  opRetainMs: 3_600_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 30_000,
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
  /** During a list change: the new list it judges by too. */
  joint: string[] | null
  /** The id of the configuration it serves (null: waiting to join). */
  cfg: string | null
  /** Its configuration's generation, or the one it waits to join from (null: not set up). */
  epoch: number | null
  /** The highest progress stamp (by seq) any record it accepted carried. */
  progress: PermitProgress | null
  /** Its op entries (ops.ts); null when it reports nothing (a broken witness). */
  ops: OpEntry[] | null
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
  /** A holder clock says which source it counts on; the client marks its records with it. */
  kind?: HolderClockKind
}

/** The id of the first configuration: the list alone. */
export function genesisConfigId(list: readonly string[]): string {
  return hashId(`genesis|${[...list].sort().join(',')}`)
}

/** The id of the list a change from configuration `from` leads to. */
export function nextConfigId(from: string, newList: readonly string[]): string {
  return hashId(`${from}|${[...newList].sort().join(',')}`)
}

function hashId(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
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
    r.nonce, r.cfg, r.epoch, [...r.list].sort(), r.joint ? [...r.joint].sort() : null, r.newList ? [...r.newList].sort() : null, r.stage ?? null,
    r.progress ? [r.progress.seq, r.progress.writtenAt] : null,
    r.ops ? [r.ops.register ?? [], r.ops.sent ?? [], r.ops.notSent ?? []] : null,
    r.ledger ? r.ledger.map((e) => [e.id, e.state, e.by, e.nonce]) : null,
    r.pairBy ? [...r.pairBy].sort() : null, r.clock ?? null,
  ])
}

export function sameRecord(a: PermitRecord | null | undefined, b: PermitRecord | null | undefined): boolean {
  return !!a && !!b && recordKey(a) === recordKey(b)
}
