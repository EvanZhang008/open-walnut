/**
 * A machine's side of the write permission: it proposes records to the witnesses and
 * acts only on a record of its OWN that a majority of the fixed list accepted, for
 * validMs - holderMarginMs counted from when it first SENT that record, on its own
 * clock. No answer is never a yes: a machine that is unsure reads the witnesses back,
 * and the old holder of a handover resumes only by getting a cancel of its own accepted.
 *
 * Event driven (send now, receive later), so a simulated network can drive it.
 */
import type { ElapsedClock, PermitParams, PermitRecord, PermitReply, PermitTransport } from './types.js'
import { genesisConfigId, majorityOf, nextConfigId, recordKey, sameList, sameRecord } from './types.js'
import { holderLeaseMs } from './rules.js'

export interface ClientOptions {
  id: string
  /** The configured witness list (sorted on use). */
  list: string[]
  /** The id of that list's configuration; default: the first one (genesisConfigId). */
  cfg?: string
  transport: PermitTransport
  /** Elapsed time that never runs slow: createHolderClock(). */
  clock: ElapsedClock
  params: PermitParams
}

export class PermitNotHeld extends Error {
  constructor(readonly opId: string, reason: string) {
    super(`write permission not held for ${opId}: ${reason}`)
    this.name = 'PermitNotHeld'
  }
}

interface Pending {
  record: PermitRecord
  sentAt: number
  acks: Set<string>
  refusals: Map<string, string>
}

export type ProposalOutcome = 'chosen' | 'short' | 'open'

export class PermitClient {
  readonly id: string
  private list: string[]
  /** During a witness list change: the new list, judged together with `list`. */
  private joint: string[] | null = null
  private cfg: string
  /**
   * The pair step is known to stand: our own pair record reached both majorities, or a read
   * showed a majority of each list in the pair (or past it). Only then may the final step
   * go: a pair learned from a read alone may still be held by a minority of the old list.
   */
  private pairConfirmed = false
  private pending: Pending | null = null
  private lease: { record: PermitRecord; until: number } | null = null
  /** Set by handover(): acts on nothing until its own cancel is accepted or the handover is known. */
  private frozen = false
  private top = 0
  private reads = new Map<string, PermitReply>()
  /** The last progress reported: every later record of this machine carries it too. */
  private progress: PermitRecord['progress'] | undefined

  constructor(private readonly opts: ClientOptions) {
    this.id = opts.id
    this.list = [...opts.list].sort()
    this.cfg = opts.cfg ?? genesisConfigId(this.list)
  }

  witnessList(): string[] {
    return [...this.list]
  }

  /** The configuration this machine judges by: its list, the pair's new list, the id. */
  config(): { list: string[]; joint: string[] | null; cfg: string } {
    return { list: [...this.list], joint: this.joint ? [...this.joint] : null, cfg: this.cfg }
  }

  /** The new list while a change is between its two steps, else null. */
  jointList(): string[] | null {
    return this.joint ? [...this.joint] : null
  }

  /** Cheap and synchronous: may this machine write and send right now? */
  mayAct(): boolean {
    return this.remainingMs() > 0
  }

  remainingMs(): number {
    if (this.frozen || !this.lease || this.lease.record.holder !== this.id) return 0
    return Math.max(0, this.lease.until - this.opts.clock.now())
  }

  /** The check an outward send makes first: refuses with less than minSendRemainingMs left. */
  assertMayAct(opId: string, minRemainingMs = this.opts.params.minSendRemainingMs): void {
    const left = this.remainingMs()
    if (left <= 0) throw new PermitNotHeld(opId, this.frozen ? 'a handover is in progress' : 'no live permission')
    if (left < minRemainingMs) throw new PermitNotHeld(opId, `only ${Math.round(left)} ms left, ${minRemainingMs} ms needed`)
  }

  isFrozen(): boolean {
    return this.frozen
  }

  /** The highest record number this machine has seen anywhere. */
  highestSeen(): number {
    return this.top
  }

  /** Extend this machine's permission. null while a handover is open: the old holder never renews then. */
  renew(progress?: PermitRecord['progress']): PermitRecord | null {
    if (this.frozen) return null
    return this.propose({ kind: 'renew', holder: this.id, ...(progress ? { progress } : {}) })
  }

  /** Ask for the permission when the old one ran out (see mayAskForTakeover for the automatic rule). */
  requestGrant(progress?: PermitRecord['progress']): PermitRecord {
    return this.propose({ kind: 'grant', holder: this.id, ...(progress ? { progress } : {}) })
  }

  /** Manual switch: stop acting at once, then propose the handover. */
  handover(to: string): PermitRecord {
    this.frozen = true
    return this.propose({ kind: 'handover', holder: to, from: this.id, to })
  }

  /** Take back a handover this machine wrote. Acts again only once a majority accepted it. */
  cancelHandover(): PermitRecord {
    return this.propose({ kind: 'cancel', holder: this.id, from: this.id })
  }

  /**
   * Replace the witness list, in two steps (rules.ts judge): the pair step, judged by the
   * old and the new list, then, once it reached a majority of both, the final step, sent by
   * itself. Called again for the same new list while the pair step stands, it sends the
   * final step again. `from` names the old list when this machine follows another one (it
   * finishes a change its holder left half done).
   */
  changeWitnesses(newList: string[], from?: { list: string[]; cfg: string }): PermitRecord {
    const next = [...newList].sort()
    if (from) {
      this.list = [...from.list].sort()
      this.cfg = from.cfg
      this.joint = null
      this.pairConfirmed = false
    }
    if (this.joint && sameList(this.joint, next)) {
      return this.pairConfirmed ? this.proposeFinal() : this.propose({ kind: 'members', stage: 'joint', holder: this.id, newList: next }, next)
    }
    return this.propose({ kind: 'members', stage: 'joint', holder: this.id, newList: next }, next)
  }

  private proposeFinal(): PermitRecord {
    return this.propose({ kind: 'members', stage: 'final', holder: this.id, newList: [...this.joint!] })
  }

  /** Send the open proposal again to the witnesses that have not accepted it (same record, same start). */
  retransmit(): void {
    const p = this.pending
    if (!p) return
    for (const w of this.targets(p.record)) if (!p.acks.has(w)) this.opts.transport.send(w, { type: 'propose', record: p.record })
  }

  /** Ask every witness what it holds; answers land in standing() and readBack(). */
  read(): void {
    this.reads.clear()
    for (const w of new Set([...this.list, ...(this.joint ?? [])])) this.opts.transport.send(w, { type: 'read' })
  }

  readBack(): PermitReply[] {
    return [...this.reads.values()]
  }

  /**
   * The record a majority of the fixed list reported in the latest read, or undefined
   * when no record has a majority yet (the outcome is unknown: act on nothing).
   */
  standing(): PermitRecord | null | undefined {
    const counts = new Map<string, { record: PermitRecord | null; n: number }>()
    for (const r of this.reads.values()) {
      if (!this.list.includes(r.witness) || !r.list) continue
      const key = r.held ? recordKey(r.held) : 'none'
      const c = counts.get(key) ?? { record: r.held, n: 0 }
      c.n++
      counts.set(key, c)
    }
    for (const c of counts.values()) if (c.n >= majorityOf(this.list)) return c.record
    return undefined
  }

  outcome(): ProposalOutcome | null {
    const p = this.pending
    if (!p) return null
    if (this.chosen(p)) return 'chosen'
    const lists = this.listsOf(p.record)
    const short = lists.some((l) => l.filter((w) => p.refusals.has(w)).length > l.length - majorityOf(l))
    return short ? 'short' : 'open'
  }

  pendingRecord(): PermitRecord | null {
    return this.pending?.record ?? null
  }

  receive(reply: PermitReply): void {
    if (reply.held && reply.held.number > this.top) this.top = reply.held.number
    if (reply.re === 'read') {
      this.reads.set(reply.witness, reply)
      this.learnFromRead()
      return
    }
    this.dropIfSuperseded(reply)
    const p = this.pending
    if (!p || reply.re !== p.record.number) return
    if (reply.ok || sameRecord(reply.held, p.record)) {
      p.acks.add(reply.witness)
      p.refusals.delete(reply.witness)
    } else if (!p.acks.has(reply.witness)) {
      p.refusals.set(reply.witness, reply.reason ?? 'refused')
    }
    if (this.chosen(p)) this.onChosen(p)
  }

  private propose(fields: Omit<PermitRecord, 'number' | 'by' | 'validMs' | 'list' | 'joint' | 'cfg'>, joint: string[] | null = this.joint): PermitRecord {
    if (fields.progress) this.progress = fields.progress
    const record: PermitRecord = {
      ...fields,
      ...(this.progress && !fields.progress ? { progress: this.progress } : {}),
      number: this.top + 1, by: this.id, validMs: this.opts.params.validMs, list: [...this.list], cfg: this.cfg,
      ...(joint ? { joint: [...joint] } : {}),
    }
    this.top = record.number
    this.pending = { record, sentAt: this.opts.clock.now(), acks: new Set(), refusals: new Map() }
    for (const w of this.targets(record)) this.opts.transport.send(w, { type: 'propose', record })
    return record
  }

  private targets(r: PermitRecord): string[] {
    return [...new Set(this.listsOf(r).flat())]
  }

  private chosen(p: Pending): boolean {
    const enough = (l: string[]) => l.filter((w) => p.acks.has(w)).length >= majorityOf(l)
    return this.listsOf(p.record).every(enough)
  }

  private onChosen(p: Pending): void {
    const r = p.record
    if (r.kind === 'members' && r.stage === 'joint') {
      this.joint = [...r.newList!]
      this.pairConfirmed = true
    }
    if (r.kind === 'members' && r.stage === 'final') {
      this.cfg = nextConfigId(r.cfg, r.newList!)
      this.list = [...r.newList!]
      this.joint = null
      this.pairConfirmed = false
    }
    if (r.holder === this.id) {
      const until = p.sentAt + holderLeaseMs(this.opts.params)
      if (!this.lease || until > this.lease.until) this.lease = { record: r, until }
      if (r.kind === 'cancel') this.frozen = false
    } else {
      // Our handover stands: the permission is the other machine's now.
      this.lease = null
      this.frozen = false
    }
    this.pending = null
    // The pair step reached both majorities: no majority of the old list alone can form
    // any more, so the final step may go.
    if (r.kind === 'members' && r.stage === 'joint') this.proposeFinal()
  }

  /**
   * A majority of `old` and of `next` report this very pair, or the configuration it leads
   * to (by id: the same list from an earlier configuration is not it).
   */
  private pairShownByReads(cfg: string, old: string[], next: string[]): boolean {
    const target = nextConfigId(cfg, next)
    const there = (r: PermitReply) =>
      !!r.list && ((r.cfg === cfg && sameList(r.list, old) && sameList(r.joint, next)) || (r.cfg === target && sameList(r.list, next) && !r.joint))
    const count = (l: string[]) => l.filter((w) => { const r = this.reads.get(w); return !!r && there(r) }).length
    return count(old) >= majorityOf(old) && count(next) >= majorityOf(next)
  }

  /** The lists a record counts by: its list, and the new list during a change. */
  private listsOf(r: PermitRecord): string[][] {
    return r.joint ? [r.list, r.joint] : [r.list]
  }

  /** Another machine's record above our lease's: stop at once (only ever ends a permission early). */
  private dropIfSuperseded(reply: PermitReply): void {
    const h = reply.held
    if (this.lease && h && h.holder !== this.id && h.number > this.lease.record.number) this.lease = null
  }

  private learnFromRead(): void {
    for (const r of this.reads.values()) this.dropIfSuperseded(r)
    // Lists a majority of ours serve now: follow them (liveness only; what counts is
    // always judged by the lists a record names, which the witnesses check).
    const lists = new Map<string, { list: string[]; joint: string[] | null; cfg: string; n: number }>()
    for (const r of this.reads.values()) {
      if (!this.list.includes(r.witness) || !r.list || !r.cfg) continue
      const same = r.cfg === this.cfg && sameList(r.list, this.list) && (r.joint ? sameList(r.joint, this.joint) : this.joint === null)
      if (same) continue
      const key = `${r.cfg}|${[...r.list].sort().join(',')}|${r.joint ? [...r.joint].sort().join(',') : ''}`
      const c = lists.get(key) ?? { list: [...r.list].sort(), joint: r.joint ? [...r.joint].sort() : null, cfg: r.cfg, n: 0 }
      c.n++
      lists.set(key, c)
    }
    for (const c of lists.values()) {
      if (c.n >= majorityOf(this.list)) {
        this.list = c.list
        this.joint = c.joint
        this.cfg = c.cfg
        this.pairConfirmed = false
      }
    }
    if (this.joint && !this.pairConfirmed) this.pairConfirmed = this.pairShownByReads(this.cfg, this.list, this.joint)
    // Our handover is known to stand when a majority reports it or a later record of its new holder.
    const s = this.standing()
    if (this.frozen && s && s.holder !== this.id) {
      this.frozen = false
      this.lease = null
    }
  }
}
