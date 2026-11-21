/**
 * A machine's side of the write permission: it proposes records to the witnesses and
 * acts only on a record of its OWN that a majority of the fixed list accepted, for
 * validMs - holderMarginMs counted from when it first SENT that record, on its own
 * clock. No answer is never a yes: a machine that is unsure reads the witnesses back,
 * and the old holder of a handover resumes only by getting a cancel of its own accepted.
 *
 * Event driven (send now, receive later), so a simulated network can drive it.
 */
import type { ElapsedClock, OpEntry, PermitParams, PermitRecord, PermitReply, PermitTransport } from './types.js'
import { genesisConfigId, majorityOf, nextConfigId, recordKey, sameList, sameRecord } from './types.js'
import { randomBytes } from 'node:crypto'
import { backoffDelayMs, holderLeaseMs } from './rules.js'
import { OpBook, type OpStatus } from './ops.js'
import { PairEvidence, planRepair, type PairView, type RepairPlan } from './repair.js'

export interface ClientOptions {
  id: string
  /** The configured witness list (sorted on use). */
  list: string[]
  /** The id of that list's configuration; default: the first one (genesisConfigId). */
  cfg?: string
  /** Its generation; default 0 (the first list). */
  epoch?: number
  /**
   * Tests only: a fixed incarnation. Never set it in the wiring: two processes with one
   * nonce bring back the restart bug the nonce exists for.
   */
  testNonce?: string
  transport: PermitTransport
  /** Elapsed time that never runs slow: createHolderClock(). */
  clock: ElapsedClock
  params: PermitParams
  /** Checked on every mayAct(): false stops acting at once (InstanceLock.held). */
  guard?: () => boolean
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
  private epoch: number
  /** This process's incarnation: on every record it writes. */
  private readonly nonce: string
  /**
   * Who was seen holding which pair: the final step goes only once a majority of each list
   * was (an answer to our own pair record counts, and so does a read), and names them.
   */
  private evidence = new PairEvidence()
  private pending: Pending | null = null
  private lease: { record: PermitRecord; until: number } | null = null
  /** Set by handover(): acts on nothing until its own cancel is accepted or the handover is known. */
  private frozen = false
  private stopped: string | null = null
  private top = 0
  private reads = new Map<string, PermitReply>()
  /** The last progress reported: every later record of this machine carries it too. */
  private progress: PermitRecord['progress'] | undefined
  private readonly ops: OpBook
  /** Grants proposed since this incarnation last had a record chosen: the back-off grows with it. */
  private grantTries = 0

  constructor(private readonly opts: ClientOptions) {
    this.id = opts.id
    this.list = [...opts.list].sort()
    this.cfg = opts.cfg ?? genesisConfigId(this.list)
    this.epoch = opts.epoch ?? 0
    this.nonce = opts.testNonce ?? randomBytes(8).toString('hex')
    this.ops = new OpBook({ by: this.id, nonce: this.nonce }, () => opts.clock.now(), opts.params.opRetainMs)
  }

  witnessList(): string[] {
    return [...this.list]
  }

  /** This process's incarnation (the nonce on its records). */
  incarnation(): string {
    return this.nonce
  }

  /** The configuration this machine judges by: its list, the pair's new list, the id. */
  config(): { list: string[]; joint: string[] | null; cfg: string; epoch: number } {
    return { list: [...this.list], joint: this.joint ? [...this.joint] : null, cfg: this.cfg, epoch: this.epoch }
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
    if (this.stopped || this.frozen || !this.lease || this.lease.record.holder !== this.id) return 0
    if (this.opts.guard && !this.opts.guard()) return 0
    return Math.max(0, this.lease.until - this.opts.clock.now())
  }

  /** The check every write makes first: refuses with less than minSendRemainingMs left. */
  assertMayAct(opId: string, minRemainingMs = this.opts.params.minSendRemainingMs): void {
    const left = this.remainingMs()
    if (left <= 0) throw new PermitNotHeld(opId, this.stopped ? `stopped: ${this.stopped}` : this.frozen ? 'a handover is in progress' : 'no live permission')
    if (left < minRemainingMs) throw new PermitNotHeld(opId, `only ${Math.round(left)} ms left, ${minRemainingMs} ms needed`)
  }

  /**
   * The check an outward send makes first (design section 6): the permission, as assertMayAct,
   * and the op id registered with a majority by this incarnation, with no outcome reported yet.
   */
  assertMaySend(opId: string): void {
    this.assertMayAct(opId)
    const st = this.ops.status(opId)
    if (st !== 'registered') throw new PermitNotHeld(opId, `op ${st === 'pending' || st === 'free' ? 'not registered with a majority' : st}`)
  }

  /**
   * Register op ids before their sends: a renew that carries them. Ids any witness reported
   * (an earlier holder's, sent or of unknown outcome) are refused and returned: never send
   * them. The rest may be sent once assertMaySend passes.
   */
  registerOps(ids: string[]): { record: PermitRecord | null; refused: Array<{ id: string; status: OpStatus }> } {
    if (!this.mayAct()) throw new PermitNotHeld(ids.join(','), 'no live permission')
    const refused = this.ops.askRegister(ids)
    return { record: refused.length === ids.length ? null : this.renew(), refused }
  }

  /**
   * After a send: whether it left. `sent: false` only when it surely did not (it never reached
   * the network); when unsure, report nothing and the op stays unknown. Rides the next renew.
   * The same reports an outcome the user checked for an op another holder left unknown.
   */
  reportOutcome(opId: string, sent: boolean): void {
    this.ops.askOutcome(opId, sent)
  }

  opStatus(opId: string): OpStatus {
    return this.ops.status(opId)
  }

  /** Ops registered by another machine or an earlier process with no outcome: never resent, to be checked by the user. */
  unresolvedOps(): OpEntry[] {
    return this.ops.unresolved()
  }

  isFrozen(): boolean {
    return this.frozen
  }

  /** Stop for good (the instance lock was lost): acts on nothing and proposes nothing again. */
  stop(reason: string): void {
    this.stopped = reason
    this.lease = null
    this.pending = null
  }

  stoppedReason(): string | null {
    return this.stopped
  }

  /** The highest record number this machine has seen anywhere. */
  highestSeen(): number {
    return this.top
  }

  /**
   * How long to wait before the next grant (the permission is free and several candidates may
   * see it at once): random, up to backoffBaseMs, doubling with each grant of this incarnation
   * that did not stand, to backoffMaxMs.
   */
  grantDelayMs(random: () => number = Math.random): number {
    return backoffDelayMs(this.grantTries, random, this.opts.params)
  }

  /** Extend this machine's permission. null while a handover is open: the old holder never renews then. */
  renew(progress?: PermitRecord['progress']): PermitRecord | null {
    if (this.frozen || this.stopped) return null
    const ops = this.ops.changes()
    return this.propose({ kind: 'renew', holder: this.id, ...(progress ? { progress } : {}), ...(ops ? { ops } : {}) })
  }

  /** Ask for the permission when the old one ran out (see mayAskForTakeover for the automatic rule). */
  requestGrant(progress?: PermitRecord['progress']): PermitRecord {
    this.grantTries++
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
   * finishes a change its holder left half done; repairChange() finds it by itself).
   */
  changeWitnesses(newList: string[], from?: { list: string[]; cfg: string; epoch: number }): PermitRecord {
    const next = [...newList].sort()
    if (from) {
      this.list = [...from.list].sort()
      this.cfg = from.cfg
      this.epoch = from.epoch
      this.joint = null
    }
    if (this.joint && sameList(this.joint, next) && this.evidence.stands(this.pairView()!)) return this.proposeFinal()
    return this.propose({ kind: 'members', stage: 'joint', holder: this.id, newList: next, ledger: this.ops.ledger() }, next)
  }

  /**
   * Finish a list change left between its two steps, from the latest read (call read() first):
   * the final step when the pair is known to stand, else the pair step again when enough
   * witnesses of both lists answer, else nothing (`blocked` names whom it waits for). The
   * witnesses take it from the live holder, or from anyone once the permission ran out
   * (mayAskForTakeover with the pair's new list decides when a candidate may).
   */
  repairChange(): { plan: RepairPlan; record: PermitRecord | null } {
    const plan = this.changePlan()
    if (plan.kind === 'none' || plan.kind === 'blocked' || this.stopped || this.frozen) return { plan, record: null }
    const p = this.pending
    if (p && p.record.kind === 'members' && sameList(p.record.newList, plan.pair.next) && this.outcome() === 'open') {
      this.retransmit()
      return { plan, record: p.record }
    }
    this.joint = [...plan.pair.next]
    if (plan.kind === 'final') return { plan, record: this.proposeFinal() }
    return { plan, record: this.propose({ kind: 'members', stage: 'joint', holder: this.id, newList: [...plan.pair.next], ledger: this.ops.ledger() }, plan.pair.next) }
  }

  /** What repairChange() would do now, without doing it. */
  changePlan(): RepairPlan {
    return planRepair({ ...this.config(), reads: this.readBack(), evidence: this.evidence })
  }

  private pairView(): PairView | null {
    return this.joint ? { cfg: this.cfg, epoch: this.epoch, list: [...this.list], next: [...this.joint] } : null
  }

  private proposeFinal(): PermitRecord {
    const pair = this.pairView()!
    return this.propose({ kind: 'members', stage: 'final', holder: this.id, newList: [...pair.next], pairBy: this.evidence.shown(pair), ledger: this.ops.ledger() })
  }

  /** Send the open proposal again to the witnesses that have not accepted it (same record, same start). */
  retransmit(): void {
    const p = this.pending
    if (!p) return
    for (const w of this.targets(p.record)) if (!p.acks.has(w)) this.opts.transport.send(w, { type: 'propose', record: p.record })
  }

  /**
   * Ask every witness what it holds; answers land in standing() and readBack(). Besides its
   * lists, it asks the new witnesses of a change in flight: its own open one, or one the last
   * read showed (repairChange needs to know whether they answer).
   */
  read(): void {
    const p = this.pending?.record
    const seen = [...this.reads.values()].flatMap((r) => (r.joint && this.list.includes(r.witness) ? r.joint : []))
    this.reads.clear()
    const to = new Set([...this.list, ...(this.joint ?? []), ...(p?.kind === 'members' ? p.newList! : []), ...seen])
    for (const w of to) this.opts.transport.send(w, { type: 'read' })
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
    if (this.stopped) return
    if (reply.held && reply.held.number > this.top) this.top = reply.held.number
    // Every answer says where its witness stands and what op ids it holds.
    this.evidence.note(reply)
    this.ops.learn(reply.ops)
    if (reply.re === 'read') {
      this.reads.set(reply.witness, reply)
      this.learnFromRead()
      return
    }
    this.dropIfSuperseded(reply)
    const p = this.pending
    if (!p || reply.re !== p.record.number) return
    // A yes is only a witness holding this very record (nonce included): never an `ok`
    // alone, which may answer a record of the same number sent by an earlier incarnation.
    if (sameRecord(reply.held, p.record)) {
      p.acks.add(reply.witness)
      p.refusals.delete(reply.witness)
    } else if (!p.acks.has(reply.witness)) {
      p.refusals.set(reply.witness, reply.reason ?? 'refused')
    }
    if (this.chosen(p)) this.onChosen(p)
  }

  private propose(fields: Omit<PermitRecord, 'number' | 'by' | 'nonce' | 'validMs' | 'list' | 'joint' | 'cfg' | 'epoch'>, joint: string[] | null = this.joint): PermitRecord {
    if (this.stopped) throw new Error(`permit client stopped: ${this.stopped}`)
    if (fields.progress) this.progress = { ...fields.progress, by: this.id }
    const kind = this.opts.clock.kind
    const record: PermitRecord = {
      ...fields,
      ...(this.progress ? { progress: this.progress } : {}),
      ...(kind ? { clock: kind } : {}),
      number: this.top + 1, by: this.id, nonce: this.nonce, validMs: this.opts.params.validMs, list: [...this.list], cfg: this.cfg, epoch: this.epoch,
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
    this.grantTries = 0
    this.ops.chosen(r.ops)
    if (r.kind === 'members' && r.stage === 'joint') this.joint = [...r.newList!]
    if (r.kind === 'members' && r.stage === 'final') {
      this.cfg = nextConfigId(r.cfg, r.newList!)
      this.epoch = r.epoch + 1
      this.list = [...r.newList!]
      this.joint = null
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
    // The pair step reached both majorities (its acks are in the evidence): no majority of the
    // old list alone can form any more, so the final step may go.
    if (r.kind === 'members' && r.stage === 'joint') this.proposeFinal()
  }

  /** The lists a record counts by: its list, and the new list during a change. */
  private listsOf(r: PermitRecord): string[][] {
    return r.joint ? [r.list, r.joint] : [r.list]
  }

  /**
   * A record above our lease's that this incarnation did not write: stop at once (only ever
   * ends a permission early). Another process of the same machine counts as another machine.
   */
  private dropIfSuperseded(reply: PermitReply): void {
    const h = reply.held
    if (this.lease && h && h.number > this.lease.record.number && !(h.by === this.id && h.nonce === this.nonce)) this.lease = null
  }

  private learnFromRead(): void {
    for (const r of this.reads.values()) this.dropIfSuperseded(r)
    // Lists a majority of ours serve now: follow them (liveness only; what counts is
    // always judged by the lists a record names, which the witnesses check).
    const lists = new Map<string, { list: string[]; joint: string[] | null; cfg: string; epoch: number; n: number }>()
    for (const r of this.reads.values()) {
      if (!this.list.includes(r.witness) || !r.list || !r.cfg || r.epoch === null) continue
      const same = r.cfg === this.cfg && sameList(r.list, this.list) && (r.joint ? sameList(r.joint, this.joint) : this.joint === null)
      if (same) continue
      const key = `${r.cfg}|${[...r.list].sort().join(',')}|${r.joint ? [...r.joint].sort().join(',') : ''}`
      const c = lists.get(key) ?? { list: [...r.list].sort(), joint: r.joint ? [...r.joint].sort() : null, cfg: r.cfg, epoch: r.epoch, n: 0 }
      c.n++
      lists.set(key, c)
    }
    for (const c of lists.values()) {
      if (c.n >= majorityOf(this.list)) {
        this.list = c.list
        this.joint = c.joint
        this.cfg = c.cfg
        this.epoch = c.epoch
      }
    }
    // Our handover is known to stand when a majority reports it or a later record of its new holder.
    const s = this.standing()
    if (this.frozen && s && s.holder !== this.id) {
      this.frozen = false
      this.lease = null
    }
  }
}
