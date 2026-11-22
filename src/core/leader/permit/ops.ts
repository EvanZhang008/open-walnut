/**
 * Op ids registered before an outward send (design section 6). A mail server does not know
 * the permission's numbers, so a send that leaves after the permission moved cannot be refused
 * on the other side. So before a send the holder registers its op id with the witnesses, beside
 * the permission's record (ids only, never content), and sends only once a majority of the
 * list took it. A new holder reads every entry back; one with no outcome is "outcome unknown":
 * no machine registers or sends it again, and it is listed for the user to check.
 *
 * Why a majority registration is always seen: a witness takes a registration only from the live
 * holder of the same incarnation (rules.ts judge), so every witness that took it took it before
 * any later holder's record. Any majority of a later holder overlaps the registering majority
 * in a witness that holds the entry: a later registration of the same id is refused there, and
 * the later holder's answers carry the entry. A list change carries the entries to the new list
 * (PermitRecord.ledger), so the same holds across it.
 */
import type { OpChanges, OpEntry, OpState, PermitRecord } from './types.js'

export const MAX_OPS_PER_RECORD = 200
export const MAX_OP_ID_LENGTH = 200
/** The most entries a list change carries (and a witness file holds): entries with no outcome are never dropped, so report them. */
export const MAX_LEDGER_ENTRIES = 10_000

/** An entry as a witness keeps it: `at` is when it last changed, on the witness's own clock. */
export interface HeldOp extends OpEntry {
  at: number
}

const RANK: Record<OpState, number> = { registered: 0, 'not-sent': 1, sent: 2 }

/** The later of two states of one op: any outcome over none, and 'sent' over 'not-sent' (never send twice). */
export function laterState(a: OpState, b: OpState): OpState {
  return RANK[b] > RANK[a] ? b : a
}

const goodId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_OP_ID_LENGTH

export function opEntryValid(e: unknown): e is OpEntry {
  const o = e as OpEntry
  return !!o && typeof o === 'object' && goodId(o.id) && o.state in RANK && typeof o.by === 'string' && o.by.length > 0 && typeof o.nonce === 'string' && o.nonce.length > 0
}

/** Shape errors of a record's op changes: lists of distinct ids, no id in two of them. */
export function opChangesError(c: OpChanges): string | null {
  const all: string[] = []
  for (const l of [c.register, c.sent, c.notSent]) {
    if (l === undefined) continue
    if (!Array.isArray(l) || !l.every(goodId)) return 'bad-ops'
    all.push(...l)
  }
  if (all.length > MAX_OPS_PER_RECORD || new Set(all).size !== all.length) return 'bad-ops'
  return null
}

export function ledgerError(l: unknown): string | null {
  if (!Array.isArray(l) || l.length > MAX_LEDGER_ENTRIES || !l.every(opEntryValid)) return 'bad-ledger'
  return new Set(l.map((e) => e.id)).size === l.length ? null : 'bad-ledger'
}

/**
 * Why a witness refuses these registrations from incarnation (by, nonce), or null. An id it
 * holds is refused unless it is the same incarnation's own registration sent again (its first
 * proposal reached only some witnesses), with no outcome yet.
 */
export function registrationConflict(held: readonly OpEntry[], c: OpChanges | undefined, by: string, nonce: string): string | null {
  if (!c?.register?.length) return null
  const byId = new Map(held.map((e) => [e.id, e]))
  for (const id of c.register) {
    const e = byId.get(id)
    if (e && !(e.state === 'registered' && e.by === by && e.nonce === nonce)) return `op-known: ${id}`
  }
  return null
}

/**
 * What a witness holds after it takes `r`: the record's ledger and op changes merged in (an
 * outcome never goes back to none, 'sent' never to 'not-sent'), and an entry whose outcome has
 * been known for longer than retainMs dropped. An entry with no outcome is never dropped.
 */
export function applyOps(held: readonly HeldOp[], r: PermitRecord, now: number, retainMs: number): HeldOp[] {
  const m = new Map(held.map((e) => [e.id, e]))
  const put = (id: string, state: OpState, by: string, nonce: string): void => {
    const e = m.get(id)
    if (!e) m.set(id, { id, state, by, nonce, at: now })
    else if (laterState(e.state, state) !== e.state) m.set(id, { ...e, state, at: now })
  }
  for (const e of r.ledger ?? []) put(e.id, e.state, e.by, e.nonce)
  for (const id of r.ops?.register ?? []) put(id, 'registered', r.by, r.nonce)
  for (const id of r.ops?.sent ?? []) put(id, 'sent', r.by, r.nonce)
  for (const id of r.ops?.notSent ?? []) put(id, 'not-sent', r.by, r.nonce)
  return [...m.values()].filter((e) => e.state === 'registered' || now - e.at <= retainMs).sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** An entry without the witness's own time, as it goes into a reply or a file. */
export function plainEntry(e: OpEntry): OpEntry {
  return { id: e.id, state: e.state, by: e.by, nonce: e.nonce }
}

/** Where one op stands, as a machine sees it. */
export type OpStatus =
  /** No witness reported it and this machine did not ask: free to register. */
  | 'free'
  /** This machine asked to register it; no majority took that yet. */
  | 'pending'
  /** A majority took this machine's registration: it may send it while it holds the permission. */
  | 'registered'
  /** Registered by another machine or an earlier incarnation, no outcome: never send it; list it for the user. */
  | 'unknown'
  /** This process began its send (beginSend) and has reported no outcome yet: never send it again. */
  | 'sending'
  | 'sent'
  | 'not-sent'

/**
 * A machine's side of the op ids: what the witnesses reported, what it asked to register or
 * report and no majority took yet (every proposal carries all of it again), the registrations
 * of its own that a majority took, and what this process did with each of its own: began
 * sending, or knows the outcome of. That last part is never dropped for the life of the
 * process, so it never sends one op twice, even once the witnesses dropped the entry.
 *
 * A registration of this process stays good across a lapse of its own permission: no other
 * process can register the id once a majority took it, and this one sends it at most once
 * (beginSend), so sending it under a later permission of its own sends it once.
 */
export class OpBook {
  private known = new Map<string, OpEntry & { seenAt: number }>()
  private wantRegister = new Set<string>()
  private wantSent = new Set<string>()
  private wantNotSent = new Set<string>()
  private mine = new Set<string>()
  private done = new Map<string, 'sending' | 'sent' | 'not-sent'>()

  constructor(private readonly self: { by: string; nonce: string }, private readonly now: () => number, private readonly retainMs: number) {}

  /** Entries a witness reported. An id someone else holds leaves the registrations asked for. */
  learn(entries: readonly OpEntry[] | null): void {
    if (!entries) return
    const t = this.now()
    for (const e of entries) {
      const k = this.known.get(e.id)
      if (!k) this.known.set(e.id, { ...plainEntry(e), seenAt: t })
      else if (laterState(k.state, e.state) !== k.state) this.known.set(e.id, { ...k, state: e.state, seenAt: t })
      if (!this.isMineEntry(e) || e.state !== 'registered') this.wantRegister.delete(e.id)
    }
    for (const [id, e] of this.known) if (e.state !== 'registered' && t - e.seenAt > this.retainMs) this.known.delete(id)
  }

  status(id: string): OpStatus {
    const e = this.known.get(id)
    const local = this.done.get(id)
    // What this process did itself first: a report it made, or a send it began, is final here.
    if (local && local !== 'sending') return e && e.state !== 'registered' ? laterState(local, e.state) : local
    if (e && e.state !== 'registered') return e.state
    if (local) return local
    if (this.mine.has(id)) return 'registered'
    if (this.wantRegister.has(id) || (e && this.isMineEntry(e))) return 'pending'
    return e ? 'unknown' : 'free'
  }

  /** Ask to register ids that are free; returns those that are not, with their status. */
  askRegister(ids: readonly string[]): Array<{ id: string; status: OpStatus }> {
    const refused: Array<{ id: string; status: OpStatus }> = []
    for (const id of ids) {
      const st = this.status(id)
      if (st === 'free' || st === 'pending') this.wantRegister.add(id)
      else refused.push({ id, status: st })
    }
    return refused
  }

  /** This process starts sending `id` (its registration stood): from now on it never sends it again. */
  beginSend(id: string): void {
    this.done.set(id, 'sending')
  }

  askOutcome(id: string, sent: boolean): void {
    this.wantRegister.delete(id)
    this.mine.delete(id)
    // 'sent' is final; a later 'not-sent' for the same id changes nothing (never send twice).
    if (this.done.get(id) === 'sent' && !sent) return
    this.done.set(id, sent ? 'sent' : 'not-sent')
    ;(sent ? this.wantSent : this.wantNotSent).add(id)
    ;(sent ? this.wantNotSent : this.wantSent).delete(id)
  }

  /**
   * A planned stop: every op whose registration a majority took from this process and whose send
   * it never began is surely not sent (it sends only through beginSend, and never acts again), so
   * it is reported 'not-sent' instead of being left for the next holder as unknown. Only those: an
   * id whose registration did not reach a majority may collide with an earlier holder's
   * registration this process never heard of, and a 'not-sent' would overwrite that entry. (One
   * that did reach a majority cannot: the two majorities share a witness, which refuses the second.)
   */
  abandonUnbegun(): void {
    for (const id of [...this.mine]) if (!this.done.has(id)) this.askOutcome(id, false)
    this.wantRegister.clear()
  }

  /** What the next proposal carries, or undefined when nothing is waiting. */
  changes(): OpChanges | undefined {
    const c: OpChanges = {}
    if (this.wantRegister.size) c.register = [...this.wantRegister]
    if (this.wantSent.size) c.sent = [...this.wantSent]
    if (this.wantNotSent.size) c.notSent = [...this.wantNotSent]
    return c.register || c.sent || c.notSent ? c : undefined
  }

  /** A record of ours that carried `c` reached the majorities it needs. */
  chosen(c: OpChanges | undefined): void {
    for (const id of c?.register ?? []) {
      this.wantRegister.delete(id)
      this.mine.add(id)
    }
    for (const id of c?.sent ?? []) this.wantSent.delete(id)
    for (const id of c?.notSent ?? []) this.wantNotSent.delete(id)
  }

  /** Every entry known, for a list change to carry. */
  ledger(): OpEntry[] {
    return [...this.known.values()].map(plainEntry).sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /** Entries with no outcome registered by anyone but this incarnation: never sent again, listed for the user. */
  unresolved(): OpEntry[] {
    return this.ledger().filter((e) => e.state === 'registered' && !this.mine.has(e.id) && !this.done.has(e.id) && !this.isMineEntry(e))
  }

  /**
   * Outcomes this process learned from the witnesses ('sent', 'not-sent') that its data must
   * record before the witnesses drop them (opRetainMs): after that only the data remembers.
   */
  learnedOutcomes(): OpEntry[] {
    return this.ledger().filter((e) => e.state !== 'registered')
  }

  private isMineEntry(e: OpEntry): boolean {
    return e.by === this.self.by && e.nonce === this.self.nonce
  }
}
