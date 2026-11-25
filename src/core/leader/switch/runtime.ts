/**
 * The leader server's side of the write permission (experiment `switchable_leader` with a
 * `leader_switch` section; docs/reference/leader-switch.md "Role at boot").
 *
 * The witnesses take a renew, a handover or a cancel only from the process (incarnation) that
 * wrote the record they hold, so every record of a switch is written by a server, never by the
 * switch command: the old leader's server writes the handover and the cancel (asked through
 * POST /api/leader/handover and /cancel), the new leader's server writes the commit (its renew on
 * top of the handover) when the switch starts it with WALNUT_LEADER_SWITCH_COMMIT=<handover number>.
 *
 * At boot it decides whether this server may lead:
 *   - the home's marker says it was (or is being) handed over: refuse, online or not;
 *   - another server of this machine holds the instance lock: refuse;
 *   - a majority of the witnesses names another machine, or a handover to this machine that
 *     the switch did not ask it to commit: refuse;
 *   - its own live record (this process's), or none at all (the very first leader): lead;
 *   - a record an earlier process of this machine wrote (a restart, or a handover this machine
 *     wrote before a switch rolled back after its server stopped): wait with every outward door
 *     closed until that record runs out at the witnesses, then grant itself and lead;
 *   - no majority answers: the same wait. Such a home was never handed over (the marker is
 *     written before any handover record), so its data is the newest there is; refusing would
 *     only take Walnut down whenever two witnesses are unreachable.
 * A trial server (the switch's test start of the new leader, WALNUT_LEADER_TRIAL=1) never asks
 * for the permission and takes no instance lock: every door stays closed.
 * A refusal that names the machine that leads now (`leader`) makes the server a standby
 * (handed-over.ts) instead of an exit.
 *
 * While it leads it renews every `renewEveryMs`; an answer that names another holder ends its
 * permission at once (the client drops the lease). A lease that ran out without a renew
 * standing goes back to waiting (doors closed) and asks again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { appendMayAct, markerRefusal, readMarker, readOpOutcomes, recordOpOutcomes, summarize, writeUnresolvedOps } from './records.js'
import { changeListAndWait, openPermitClient, proposeAndWait, readStanding, PROPOSE_WAIT_MS, READ_WAIT_MS, type PermitHandle } from './permit-ops.js'
import { sightingsOf, type WitnessSighting } from './witness-setup.js'
import { DEFERRED_DOOR_WORK_FILE, notifyOutwardDoorsOpened, setOutwardDoorChecker, setOutwardSender, type OutwardDoorKind } from './doors.js'
import type { LeaderSwitchSettings, WitnessPlace } from './settings.js'
import { majorityOf, type PermitParams, type PermitRecord, type PermitReply } from '../permit/types.js'
import { PermitNotHeld } from '../permit/client.js'
import { generationToJoin } from '../permit/store.js'
import { witnessHoldMs } from '../permit/rules.js'
import { acquireInstanceLock, type InstanceLock } from '../permit/instance-lock.js'

export type BootDecision =
  | { kind: 'lead'; record: PermitRecord }
  | { kind: 'trial' }
  | { kind: 'waiting'; why: string }
  /** `leader`: another machine leads now (the server then runs as a standby, handed-over.ts). */
  | { kind: 'refuse'; why: string; leader?: string; record?: PermitRecord }

export type RuntimeState = 'leading' | 'trial' | 'waiting' | 'handing-over' | 'handed-over' | 'lost' | 'stopped'

export interface PermitRuntime {
  decision: BootDecision
  mayAct(): boolean
  /** What Settings and the switch read: the state, the record held, the time left. */
  status(): { state: RuntimeState; mayAct: boolean; remainingMs: number; record: ReturnType<typeof summarize>; why?: string; handover?: number }
  /**
   * The witnesses' record as THIS process reads it over its own links (read only, proposes nothing):
   * the one way a command reads remote witnesses (witness-reader.ts). `standing` is the record a majority
   * holds (null: none ever), `agreed` false when no record has a majority among the answers.
   */
  /** `waitMs`: how long to wait for the witnesses that have not answered (the read ends once each answered or said it holds nothing). */
  readWitnesses(waitMs?: number): Promise<{ standing: PermitRecord | null; agreed: boolean; answered: number; of: number; sightings: WitnessSighting[] }>
  /** New ways to the same fixed list (keys `walnut leader witnesses init` minted): false when the list itself differs. */
  setWitnessPlaces(places: WitnessPlace[]): boolean
  /** Whether this server has held the permission at least once (its daemon links may open from then on). */
  hasLed(): boolean
  /** The witness list the permission runs on now (it differs from the config's only in the middle of adding a witness). */
  witnessList(): string[]
  /** Change that list as the holder (both steps), only while leading: how a missing witness is added back (witness-setup.ts). */
  changeWitnessList(next: string[]): Promise<{ ok: true } | { ok: false; why: string }>
  /** The generation a joining witness starts from, read from the witnesses now (permit/store.ts generationToJoin). */
  joinGeneration(): Promise<number | null>
  /** The switch's handover, written by this process (the only one the witnesses take it from). */
  handover(to: string): Promise<{ ok: boolean; record?: PermitRecord; why?: string }>
  /** Take back a handover this process wrote (the switch rolled back while this server runs). */
  cancel(): Promise<{ ok: boolean; why?: string; standing?: ReturnType<typeof summarize> }>
  /**
   * Before an outward send (docs/reference/leader-write-permission.md "Outward sends"): the op
   * id registered with a majority of the witnesses, then marked begun by this process. Throws
   * PermitNotHeld when it may not go out: no permission, an id an earlier holder registered
   * (outcome unknown: never sent again), one the data or the witnesses know as sent.
   */
  beginSend(kind: OutwardDoorKind, opId: string): Promise<void>
  /** After the send: 'sent', 'not-sent' (surely never left), or 'unknown' (left as it is, listed). */
  reportSend(opId: string, outcome: 'sent' | 'not-sent' | 'unknown'): void
  /**
   * A planned stop: the doors close at once, then the permission goes back to the witnesses
   * (a release, at most RELEASE_CAP_MS) so the next process of this machine holds at once.
   * Resolves when that is done or the cap passed; a crash skips it and the next one waits.
   */
  stop(): Promise<void>
}

/** How long a planned stop waits for its release to stand; past it the next process waits as after a crash. */
export const RELEASE_CAP_MS = 3_000

/** The longest pause between two rounds of a runtime that does not lead (shorter with a short renewEveryMs). */
export const WAITING_ROUND_MS = 5_000
const waitingRoundMs = (p: PermitParams) => Math.min(WAITING_ROUND_MS, p.renewEveryMs)

/**
 * How long, at most, a runtime that waits for the permission takes to hold it once it may: every record a majority
 * of the witnesses it reaches holds for another process (an earlier process of this machine included, its handover
 * too) ran out there, and every answer leaves the permission to this machine (wantFor, splitOwnRecords). The round
 * under way ends and the next one runs: its pause, its three reads (each waits READ_WAIT_MS for a witness that never
 * answers), the grant's back-off (backoffMaxMs at most), and one proposal wait for the answers. A grant is taken
 * there at once (rules.ts judge: a witness that holds a live record of this very process takes it as it takes a
 * renew). With the defaults: 5 + 4.5 + 30 + 3 = 42.5 s.
 */
export function retakeWithinMs(p: PermitParams): number {
  return waitingRoundMs(p) + 3 * READ_WAIT_MS + p.backoffMaxMs + PROPOSE_WAIT_MS
}

/**
 * How long, at most, a restarted server of the machine that held the permission takes to hold it again from its
 * first read of the witnesses, when what they hold is only its machine's (its handover after a switch that rolled back
 * once its server stopped, or an earlier process's record), a majority of them answers, and nobody else asks: every
 * such record runs out within one witness hold of that read (a witness it keeps itself counts the record from this
 * server's first read; one elsewhere took it before), the hold measured on witness clocks that may run slow by
 * maxDriftRate; then retakeWithinMs. With the defaults: 63.3 + 42.5 = 105.8 s.
 */
export function retakeAfterRestartMs(p: PermitParams): number {
  return Math.ceil(witnessHoldMs(p) / (1 - p.maxDriftRate)) + retakeWithinMs(p)
}

export interface RuntimeOptions {
  home: string
  holderId: string
  settings: LeaderSwitchSettings
  trial: boolean
  /** The instance lock of this machine (one leader process per machine id); none in tests that run one. */
  lockPath?: string
  /** The switch asks this server to commit: the number of the handover to it that it may renew on. */
  commitHandover?: number
  /** Wall-clock ms: after it the handover is no longer renewed on (the commit window ended; the old leader takes it back). */
  commitUntil?: number
  /** Tests: how remote witnesses are reached (witness-transport.ts), in place of the host links. */
  net?: Partial<import('./witness-transport.js').WitnessTransportOptions>
  /**
   * Once, the first time this process leads (at boot, or later from waiting): what a switch left
   * behind is taken back then (boot.ts). Called on a later tick, never awaited, never twice.
   */
  onFirstLead?: () => void
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

type Want = 'renew' | 'grant' | 'none'

/**
 * What this process should send, given what a majority holds. `refuse` marks an answer that
 * will not change by waiting (another machine leads, or a switch to here nobody committed).
 */
/** Tests: the split-records rule alone. */
export const splitOwnRecordsForTest = (h: PermitHandle, read: { standing: PermitRecord | null | undefined; replies: PermitReply[] }, me: string) => splitOwnRecords(h, read, me)

export function wantFor(standing: PermitRecord | null | undefined, me: string, nonce: string, commitHandover?: number): { want: Want; why?: string; refuse?: boolean; released?: boolean; leader?: string } {
  if (standing === undefined) return { want: 'none', why: 'no majority of the witnesses answered' }
  if (standing === null) return { want: 'grant' }
  if (standing.kind === 'handover') {
    if (standing.to === me) {
      if (commitHandover === standing.number) return { want: 'renew' }
      return { want: 'none', refuse: true, why: `a switch to this machine (record ${standing.number}) is not committed: \`walnut leader switch --resume\` finishes it` }
    }
    if (standing.from === me) {
      if (standing.nonce === nonce) return { want: 'none', why: `this server handed the permission over (record ${standing.number})` }
      // Written by an earlier process of this machine, and the switch rolled back after it
      // stopped (the marker is gone): nobody can cancel it any more, so it runs out first.
      return { want: 'grant', why: `waiting for this machine's earlier handover (record ${standing.number}) to run out at the witnesses` }
    }
    return { want: 'none', refuse: true, leader: standing.to, why: `the witnesses hold a handover from machine ${standing.from} to ${standing.to} (record ${standing.number})` }
  }
  if (standing.kind === 'release') {
    // Given back by a planned stop: free at once, for the machine that gave it back only
    // (another machine takes over a lead only through a switch).
    if (standing.by === me) return { want: 'grant', why: `this machine released record ${standing.number}`, released: true }
    return { want: 'none', refuse: true, leader: standing.by, why: `machine ${standing.by} released the permission for its own restart (record ${standing.number})` }
  }
  if (standing.holder !== me) return { want: 'none', refuse: true, leader: standing.holder, why: `the witnesses name machine ${standing.holder} as the holder (record ${standing.number})` }
  if (standing.nonce === nonce) return { want: 'renew' }
  return { want: 'grant', why: `waiting for the record of an earlier process of this machine (record ${standing.number}) to run out at the witnesses` }
}

const tick = (ms: number) => new Promise((r) => { setTimeout(r, ms).unref?.() })

/**
 * A majority answered but holds no one record, and nobody can end that by waiting: no new record stands while
 * none has a majority (a renew cut off part way leaves the witnesses on different records; a switch's handover or
 * its commit reached only some of them before a cut that outlasted every lease). A grant ends it, and asking for one
 * is safe: each witness takes it only once the record it holds ran out there. It is asked only by the machine every
 * answer leaves the permission to, so it is never a takeover:
 *
 *   - a record this machine leads on (a renew or grant it holds, its cancel of its own handover), its release;
 *   - a handover FROM this machine: had the switch committed, the new machine's renews would show (below);
 *   - a handover TO this machine with one of its own records above it (it committed that switch);
 *   - a record of another machine that never stood: more witnesses than a minority hold a lower number (numbers only
 *     grow at a witness, and a witness drops another machine's record only for that machine's own later one, or once
 *     it ran out for a grant this rule allowed), so no majority ever held it and that machine never led on it.
 *
 * Any record of another machine that may have stood (a committed switch, its renews), or a handover to this machine
 * it never led on: null, as before (a switch's to settle). A witness that answered with its list and holds nothing
 * holds nothing for anyone, as after a release. tests/core/leader/switch/split-records-model.test.ts walks every short
 * history of two machines and three witnesses with the witnesses' own rules, and every schedule of a restarted old
 * leader after a failed trial with one witness out of reach (its grant is taken at once where a witness holds this
 * process's own live record: rules.ts judge).
 */
function splitOwnRecords(h: PermitHandle, read: { standing: PermitRecord | null | undefined; replies: PermitReply[] }, me: string): ReturnType<typeof wantFor> | null {
  if (read.standing !== undefined) return null
  const list = h.client.witnessList()
  const answers = read.replies.filter((r) => list.includes(r.witness) && r.list)
  if (answers.length < majorityOf(list)) return null
  // A record this machine leads on: its grant or renew, its cancel of its own handover, and its witness list change (a
  // members record is its writer's permission record as a grant is: rules.ts mayRewrite, ownLive).
  const leadsOn = (r: PermitRecord | null | undefined) => !!r && (r.kind === 'renew' || r.kind === 'grant' || r.kind === 'cancel' || r.kind === 'members') && r.holder === me
  const mineAbove = (n: number) => answers.some((a) => leadsOn(a.held) && a.held!.number > n)
  // More than a minority of the witnesses never held record `n` of another machine while it stood: those that hold a
  // lower number, and those that hold a record of this machine above it (this machine never lands a record on another
  // machine's record that stood: a grant only through this rule, everything else only on its own records).
  const neverStood = (n: number) => answers.filter((a) => (a.held?.number ?? 0) < n || (a.held!.number > n && a.held!.by === me && a.held!.kind !== 'handover')).length > list.length - majorityOf(list)
  const own = (r: PermitReply) => {
    const x = r.held
    // A witness that answers with its list and no record never took one: nothing of another machine stood there,
    // and a grant there is judged by the witness itself (it takes one only once what it holds ran out).
    if (!x) return true
    if (leadsOn(x) || (x.kind === 'release' && x.by === me) || (x.kind === 'handover' && x.from === me)) return true
    if (x.kind === 'handover' && x.to === me) return mineAbove(x.number)
    return neverStood(x.number)
  }
  if (!answers.every(own)) return null
  const numbers = answers.map((r) => r.held?.number ?? 0)
  return { want: 'grant', why: `the witnesses hold different records (${numbers.join(', ')}), every one this machine's or one that never stood: asking for a grant, which stands where each ran out` }
}

type Acquired = { ok: boolean; record?: PermitRecord; why?: string; refused?: boolean; leader?: string; standing?: PermitRecord }

async function acquire(h: PermitHandle, me: string, commitHandover?: number): Promise<Acquired> {
  const refusal = (w: ReturnType<typeof wantFor>, standing: PermitRecord | null | undefined): Acquired =>
    ({ ok: false, why: w.why, refused: !!w.refuse, ...(w.leader ? { leader: w.leader } : {}), ...(standing ? { standing } : {}) })
  const read = await readStanding(h)
  const w = splitOwnRecords(h, read, me) ?? wantFor(read.standing, me, h.client.incarnation(), commitHandover)
  if (w.want === 'none') return refusal(w, read.standing)
  if (w.want === 'renew') {
    const r = await proposeAndWait(h, (c) => c.renew())
    if (r?.outcome === 'chosen') return { ok: true, record: r.record }
    // Not taken: this process's own record, or the handover to it, ran out at the witnesses (a
    // renew is refused then). Asked for again as a grant, which stands only once it ran out.
  }
  // Free, or held by a record no live process will renew: a grant, after the core's back-off
  // (several candidates that see it free at once ask one after the other). A release of this
  // machine's own has no other candidate: asked at once.
  if (!w.released) await tick(h.client.grantDelayMs())
  const again = await readStanding(h)
  const w2 = splitOwnRecords(h, again, me) ?? wantFor(again.standing, me, h.client.incarnation(), commitHandover)
  if (w2.want === 'none') return refusal(w2, again.standing)
  const g = await proposeAndWait(h, (c) => c.requestGrant())
  if (g?.outcome === 'chosen') return { ok: true, record: g.record }
  return { ok: false, why: w.why ?? `the witnesses did not take this machine's grant (${g?.outcome ?? 'no record'})` }
}

export async function startPermitRuntime(opts: RuntimeOptions): Promise<PermitRuntime> {
  /** The handover this start may commit on, while the commit window lasts. */
  const commitOn = (): number | undefined => (opts.commitUntil !== undefined && Date.now() > opts.commitUntil ? undefined : opts.commitHandover)
  const { home, holderId: me, settings } = opts
  const log = opts.log ?? (() => {})
  let lock: InstanceLock | null = null
  let state: RuntimeState = 'waiting'
  // The leader server reaches remote witnesses over its host links, but only once it has LED: a link is a full daemon
  // connection that describes this Walnut to the host as its leader (slice, leader.configure, the offline drain), which a
  // server that does not yet hold the permission, or is refused it, must never do. Before that it reaches the witnesses
  // that need no such link (a registered reach); a list that is all remote cannot be read until a reach exists.
  // After it led, the link stays allowed for what only a leader writes (renew, handover, cancel, the release at a stop).
  let everLed = false
  // A witness that did not answer, said once a minute per witness and reason: the evidence when no majority answers.
  const dropSaid = new Map<string, number>()
  const onDrop: NonNullable<import('./witness-transport.js').WitnessTransportOptions['onDrop']> = (dropWhy, d) => {
    opts.net?.onDrop?.(dropWhy, d)
    const key = `${d.witness}:${d.way ?? ''}:${dropWhy}`
    if (Date.now() - (dropSaid.get(key) ?? 0) < 60_000) return
    dropSaid.set(key, Date.now())
    log('info', 'leader permit: a witness did not answer', { witness: d.witness, way: d.way, why: dropWhy, ...(d.status ? { status: d.status } : {}), ...(d.error ? { error: d.error } : {}) })
  }
  const h = openPermitClient(me, settings.witnesses, settings.params, () => !lock || lock.held(), { daemonLink: () => !opts.trial && everLed, ...opts.net, onDrop })
  let why: string | undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let lastMayAct = false
  /** The doors read open (a send would pass: minSendRemainingMs left), as last noted. */
  let lastOpen = false
  /** A handover or a stop is under way: no new send begins (its outcome could not ride a renew any more). */
  let closing = false
  /** A handover this process wrote stood nowhere and its cancel did not stand either: the loop retries the cancel. */
  let cancelOwed = false
  let lastRecord: PermitRecord | null = null
  let handoverRecord: PermitRecord | null = null
  let busy: Promise<unknown> = Promise.resolve()
  let unresolvedSig = ''
  /** Sends begun and not reported yet: a planned stop lets them end before its release carries their outcomes. */
  const inflight = new Set<string>()
  /** What the witnesses told of outward ops: outcomes into the data, the unknown ones listed. */
  const learn = () => {
    try {
      recordOpOutcomes(home, h.client.learnedOutcomes())
      const un = h.client.unresolvedOps()
      const sig = un.map((e) => e.id).sort().join('\n')
      if (sig !== unresolvedSig) {
        unresolvedSig = sig
        writeUnresolvedOps(home, un)
        if (un.length) log('warn', 'leader permit: outward ops of an earlier holder have no known outcome; they are never sent again (walnut leader status lists them)', { ops: un.length })
      }
    } catch (err) {
      log('warn', 'leader permit: could not write what the witnesses reported of outward ops', { error: (err as Error).message })
    }
  }

  const isOpen = () => !closing && h.client.remainingMs() >= settings.params.minSendRemainingMs
  /** Work held back behind closed doors goes on the rising edge of "open", not of mayAct (a lease in its last seconds is closed too). */
  const openEdge = () => {
    const open = isOpen()
    const rising = open && !lastOpen
    lastOpen = open
    if (rising) notifyOutwardDoorsOpened()
  }
  const note = (event: 'lease' | 'lost' | 'boot', extra: { why?: string; record?: number } = {}) => {
    const held = h.client.readBack().find((r) => r.held)?.held
    if (held && (!lastRecord || held.number > lastRecord.number)) lastRecord = held
    const mayAct = h.client.mayAct()
    appendMayAct(home, { machine: me, event, mayAct, until: mayAct ? Date.now() + h.client.remainingMs() : undefined, ...extra })
    lastMayAct = mayAct
    openEdge()
  }
  const observe = () => {
    if (h.client.mayAct() !== lastMayAct) note(h.client.mayAct() ? 'lease' : 'lost', { why: 'time' })
    else openEdge()
  }
  /** One proposal at a time: the renew loop and a handover or cancel never interleave. */
  const serial = <T>(fn: () => Promise<T>, label: string): Promise<T> => {
    // A step that holds the queue for a minute holds every round behind it: said, so a stalled permit names its cause.
    const timed = async (): Promise<T> => {
      const slow = setTimeout(() => log('warn', 'leader permit: a step still holds the permission\'s queue after 60 s', { step: label, state }), 60_000)
      slow.unref?.()
      try { return await fn() } finally { clearTimeout(slow) }
    }
    const run = busy.then(timed, timed)
    busy = run.catch(() => {})
    return run
  }

  const beginSend = (kind: OutwardDoorKind, opId: string) => serial(async (): Promise<void> => {
    /**
     * `opState`: the op is known already, never sent again (doors.ts knownOpState):
     * 'unknown' (an earlier holder registered it and never reported), 'sent', 'not-sent', or
     * 'sending' (this process began it).
     */
    const refuse = (reason: string, opState?: string): never => {
      appendMayAct(home, { machine: me, event: 'door', mayAct: false, kind, opId, why: reason })
      const err = new PermitNotHeld(opId, reason)
      if (opState) Object.assign(err, { opKnown: true, opState })
      throw err
    }
    observe()
    if (closing) refuse('a handover or a stop is under way: no new send begins')
    try { h.client.assertMayAct(opId) } catch (err) { refuse((err as Error).message) }
    const known = readOpOutcomes(home).get(opId)
    if (known) refuse(`op ${opId} is ${known.state} already (the data says so): never sent again`, known.state)
    const st = h.client.opStatus(opId)
    if (st === 'unknown') refuse(`op ${opId} was registered by an earlier holder and never reported: never sent again (walnut leader status lists it)`, 'unknown')
    if (st === 'sent' || st === 'not-sent' || st === 'sending') refuse(`op ${opId} is ${st} already at the witnesses: never sent again`, st)
    if (st === 'free' || st === 'pending') {
      let refused: { id: string; status: string }[] = []
      const r = await proposeAndWait(h, (c) => { const x = c.registerOps([opId]); refused = x.refused; return x.record }, 5_000)
      if (refused.length) refuse(`op ${opId} is ${refused[0]!.status} at the witnesses: never sent again`, refused[0]!.status)
      if (r?.outcome === 'chosen') learn()
    }
    try { h.client.beginSend(opId) } catch (err) { refuse((err as Error).message) }
    inflight.add(opId)
    appendMayAct(home, { machine: me, event: 'door', mayAct: true, kind, opId, why: 'send' })
  }, `send ${kind}`)

  const reportSend = (opId: string, outcome: 'sent' | 'not-sent' | 'unknown') => {
    inflight.delete(opId)
    // Unknown stays as it is: registered with no outcome, never sent again, listed for a person.
    if (outcome !== 'unknown') h.client.reportOutcome(opId, outcome === 'sent')
  }


  setOutwardDoorChecker((kind: OutwardDoorKind, opId: string) => {
    observe()
    try {
      h.client.assertMayAct(opId)
    } catch (err) {
      appendMayAct(home, { machine: me, event: 'door', mayAct: false, kind, opId, why: (err as Error).message })
      throw err
    }
    appendMayAct(home, { machine: me, event: 'door', mayAct: true, kind, opId })
    // Open means a send would pass: assertMayAct also wants minSendRemainingMs left, so a lease
    // in its last seconds reads closed here too (a timer would otherwise take a slot and give it back).
  }, () => { observe(); return isOpen() })
  // Registered with the checker: a send never passes a door that has a permit but no op ids.
  setOutwardSender({ begin: beginSend, report: reportSend })
  // Work a closed door held on disk before this process (a list rename, a moved copy, a remote
  // delete, an unsubscribe answer) is done at the first opening (src/core/deferred-door-work.ts).
  // No file, nothing held: that module is not loaded here (a hold made later subscribes itself).
  if (!opts.trial && fs.existsSync(path.join(home, ...DEFERRED_DOOR_WORK_FILE.split('/')))) {
    void import('../../deferred-door-work.js').then((m) => m.armDeferredDoorWork(home)).catch(() => {})
  }

  let decision: BootDecision
  const marker = readMarker(home)
  if (marker) {
    decision = { kind: 'refuse', why: markerRefusal(marker) }
  } else if (opts.trial) {
    decision = { kind: 'trial' }
    state = 'trial'
  } else {
    const taken = opts.lockPath
      ? await acquireInstanceLock({
        path: opts.lockPath,
        onLost: (by) => {
          h.client.stop('another server of this machine took its instance lock')
          state = 'lost'
          why = `another server of this machine (pid ${by?.pid ?? '?'}) took the instance lock`
          note('lost', { why })
          log('warn', 'leader permit: the instance lock was taken over; this server no longer acts as the leader', { why })
        },
      }).catch((err) => ({ ok: false as const, owner: null, reason: (err as Error).message }))
      : null
    if (taken && !taken.ok) {
      decision = { kind: 'refuse', why: `another Walnut server of this machine holds its instance lock (${taken.reason}): one leader process per machine` }
    } else {
      if (taken?.ok) { lock = taken.lock; lock.start() }
      const got = await acquire(h, me, commitOn())
      if (got.ok) decision = { kind: 'lead', record: got.record! }
      else if (got.refused) decision = { kind: 'refuse', why: got.why!, ...(got.leader ? { leader: got.leader } : {}), ...(got.standing ? { record: got.standing } : {}) }
      else decision = { kind: 'waiting', why: got.why ?? 'no majority of the witnesses answered' }
    }
  }
  note('boot', { why: decision.kind === 'lead' ? 'lead' : `${decision.kind}${'why' in decision ? `: ${decision.why}` : ''}`, ...(decision.kind === 'lead' ? { record: decision.record.number } : {}) })

  const schedule = (ms: number) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void serial(round, 'round') }, ms)
    timer.unref?.()
  }
  // The first lead of this process (at boot or from waiting) tells onFirstLead, once.
  const ledNow = () => {
    if (everLed) return
    everLed = true
    if (opts.onFirstLead) setImmediate(() => { try { opts.onFirstLead!() } catch (err) { log('warn', 'leader permit: the first lead\'s step failed', { error: (err as Error).message }) } })
  }
  const lead = (record: PermitRecord, msg: string) => {
    ledNow()
    state = 'leading'
    why = undefined
    learn()
    note('lease', { record: record.number })
    log('info', msg, { record: record.number })
  }
  /** One round of the loop; a round that throws is logged and the loop goes on (a dead loop never takes the permission again). */
  const round = async () => {
    try {
      await loop()
    } catch (err) {
      if (stopped) return
      log('warn', 'leader permit: a round failed; the next one runs in a moment', { state, error: err instanceof Error ? err.stack ?? err.message : String(err) })
      schedule(waitingRoundMs(settings.params))
    }
  }
  const loop = async () => {
    if (stopped) return
    observe()
    if (h.client.stoppedReason()) { state = 'lost'; return }
    if (state === 'leading') {
      const r = await proposeAndWait(h, (c) => c.renew(), Math.min(5_000, settings.params.renewEveryMs))
      if (stopped || state !== 'leading') return
      if (r?.outcome === 'chosen') { learn(); note('lease', { record: r.record.number }) }
      else {
        const read = await readStanding(h)
        const w = wantFor(read.standing, me, h.client.incarnation(), commitOn())
        if (w.refuse) {
          state = 'lost'
          why = w.why
          note('lost', { why: w.why })
          log('warn', 'leader permit: another machine holds the permission; this server no longer acts as the leader', { why: w.why })
          return
        }
        observe()
        if (!h.client.mayAct()) {
          // The lease ran out without a renew standing: ask again as at boot, doors closed.
          state = 'waiting'
          why = 'the permission ran out before a renew stood'
          note('lost', { why })
          schedule(1_000)
          return
        }
        // Still acting on the last renew: try again soon, not a whole period later.
        schedule(1_500)
        return
      }
      schedule(settings.params.renewEveryMs)
      return
    }
    if (state === 'waiting') {
      const got = await acquire(h, me, commitOn())
      if (stopped || state !== 'waiting') return
      if (got.ok) {
        lead(got.record!, 'leader permit: taken; the outward doors are open')
        schedule(settings.params.renewEveryMs)
        return
      }
      if (got.refused) {
        state = 'lost'
        why = got.why
        note('lost', { why: got.why })
        return
      }
      why = got.why
      schedule(waitingRoundMs(settings.params))
      return
    }
    if (state === 'lost' && cancelOwed) {
      // Our handover did not stand and its cancel did not either. A cancel stands only on the handover or on this
      // machine's live record: once its records ran out at the others it never can, and a cancel that lands on some
      // witnesses only hides what they held. So a full read decides first: where every answer leaves the permission to
      // this machine (splitOwnRecords: the handover from here, and what never stood), a grant takes it back where
      // each record ran out; otherwise the cancel is sent again.
      const got = await acquire(h, me)
      if (stopped || state !== 'lost') return
      if (got.ok) { cancelOwed = false; lead(got.record!, 'leader permit: the handover did not stand; this server took the permission again'); schedule(settings.params.renewEveryMs); return }
      const c = await proposeAndWait(h, (cl) => cl.cancelHandover(), 8_000)
      if (stopped) return
      if (c?.outcome === 'chosen') { cancelOwed = false; lead(c.record, 'leader permit: the handover is cancelled; this server leads again'); schedule(settings.params.renewEveryMs); return }
      schedule(settings.params.renewEveryMs)
      return
    }
    // handing-over, handed-over, lost: nothing to send; a cancel (below) brings it back.
  }

  if (decision.kind === 'lead') { ledNow(); state = 'leading'; learn(); schedule(settings.params.renewEveryMs) }
  if (decision.kind === 'waiting') { why = decision.why; schedule(waitingRoundMs(settings.params)) }
  if (decision.kind === 'refuse') { state = 'lost'; why = decision.why }

  const handover = (to: string) => serial(async (): Promise<{ ok: boolean; record?: PermitRecord; why?: string }> => {
    if (handoverRecord && handoverRecord.to === to) return { ok: true, record: handoverRecord }
    if (state !== 'leading' || !h.client.mayAct()) return { ok: false, why: `this server does not lead now (${state}${why ? `: ${why}` : ''})` }
    state = 'handing-over'
    why = `handing over to ${to}`
    // No new send begins, and those on their way end first (up to a second): their outcomes ride the renew below.
    closing = true
    openEdge()
    for (const end = Date.now() + 1_000; inflight.size && Date.now() < end;) await tick(50)
    // One renew first: it carries the outcomes of sends that ended since the last one (a
    // frozen holder renews no more, so they would stay unknown at the new leader).
    await proposeAndWait(h, (c) => c.renew(), 3_000)
    const r = await proposeAndWait(h, (c) => c.handover(to), 8_000)
    if (r?.outcome === 'chosen') {
      handoverRecord = r.record
      state = 'handed-over'
      why = `handed over to ${to} (record ${r.record.number})`
      note('lost', { why, record: r.record.number })
      log('info', 'leader permit: handed over; this server no longer acts as the leader', { to, record: r.record.number })
      return { ok: true, record: r.record }
    }
    // Not at a majority: take back whatever part of it the witnesses hold, and lead on.
    const c = await proposeAndWait(h, (cl) => cl.cancelHandover(), 8_000)
    closing = false
    if (c?.outcome === 'chosen') lead(c.record, 'leader permit: the handover did not stand; this server leads again')
    else { state = 'lost'; cancelOwed = true; why = 'a handover that did not stand and could not be cancelled yet: the cancel is tried again' }
    schedule(settings.params.renewEveryMs)
    return { ok: false, why: `the handover record did not reach a majority of the witnesses (${r?.outcome ?? 'no record'})` }
  }, 'handover')

  const cancel = () => serial(async (): Promise<{ ok: boolean; why?: string; standing?: ReturnType<typeof summarize> }> => {
    if (state === 'leading' && h.client.mayAct()) return { ok: true }
    for (let i = 0; i < 3; i++) {
      const c = await proposeAndWait(h, (cl) => cl.cancelHandover(), 8_000)
      if (c?.outcome === 'chosen') {
        handoverRecord = null
        closing = false
        cancelOwed = false
        lead(c.record, 'leader permit: the switch was cancelled; this server leads again')
        schedule(settings.params.renewEveryMs)
        return { ok: true }
      }
      const read = await readStanding(h)
      // The new leader's record stood first: the switch can only go forward. As flow.ts
      // committedRecord: above the handover, a grant or renew of the target, or a release by it
      // (it committed, led, and stopped as planned).
      const s = read.standing
      const to = handoverRecord?.to
      const committed = !!s && s.number > (handoverRecord?.number ?? 0) && (s.kind === 'release'
        ? s.by !== me && (to === undefined || s.by === to)
        : s.holder !== me && s.kind !== 'handover' && (to === undefined || s.holder === to))
      if (committed) return { ok: false, why: 'committed before the cancel', standing: summarize(s) }
      // No record stands and every answer leaves the permission here (splitOwnRecords: the cancel can no longer stand
      // where this machine's records ran out): a grant takes it back instead.
      if (s === undefined && splitOwnRecords(h, read, me)) {
        const got = await acquire(h, me)
        if (got.ok) {
          handoverRecord = null
          closing = false
          cancelOwed = false
          lead(got.record!, 'leader permit: the switch was taken back by a grant; this server leads again')
          schedule(settings.params.renewEveryMs)
          return { ok: true }
        }
      }
    }
    return { ok: false, why: 'the cancel record did not reach a majority of the witnesses' }
  }, 'cancel')


  return {
    decision,
    beginSend,
    reportSend,
    mayAct: () => h.client.mayAct(),
    status: () => ({ state, mayAct: h.client.mayAct(), remainingMs: h.client.remainingMs(), record: summarize(lastRecord), ...(why ? { why } : {}), ...(handoverRecord ? { handover: handoverRecord.number } : {}) }),
    handover,
    cancel,
    readWitnesses: async (waitMs) => {
      const r = await readStanding(h, waitMs)
      return { standing: r.standing ?? null, agreed: r.standing !== undefined, answered: r.answered, of: h.places.length, sightings: sightingsOf(r.replies, r.absent) }
    },
    setWitnessPlaces: (places) => h.setPlaces(places),
    hasLed: () => everLed,
    witnessList: () => h.client.witnessList(),
    changeWitnessList: (next) => serial(async () => {
      if (state !== 'leading' || !h.client.mayAct()) return { ok: false as const, why: 'this server does not hold the permission' }
      const r = await changeListAndWait(h, next)
      log(r.ok ? 'info' : 'warn', r.ok ? 'leader permit: the witness list changed' : 'leader permit: a witness list change did not stand', { list: next, ...(r.ok ? {} : { why: r.why }) })
      return r
    }, 'witness list change'),
    joinGeneration: async () => generationToJoin((await readStanding(h)).replies, h.client.config().epoch),
    stop: async () => {
      if (stopped) return
      const wasLeading = state === 'leading' && h.client.mayAct()
      stopped = true
      state = 'stopped'
      if (timer) clearTimeout(timer)
      // Closed, not removed: a door reached while the server stops must not pass unchecked.
      setOutwardDoorChecker((_kind, opId) => { throw new PermitNotHeld(opId, 'the server is stopping') }, () => false)
      // Sends on their way still report: the release below carries their outcomes.
      closing = true
      setOutwardSender({ begin: async (_kind, opId) => { throw new PermitNotHeld(opId, 'the server is stopping') }, report: reportSend })
      if (wasLeading) {
        const deadline = Date.now() + RELEASE_CAP_MS
        // Sends already on their way end first (up to a second), so the release carries their outcomes.
        while (inflight.size && Date.now() < deadline - 2_000) await tick(50)
        // The client stops acting before it sends the release (permit core); sent again every 300 ms until it stood.
        let released = false
        try {
          if (h.client.release()) {
            let last = Date.now()
            while (Date.now() < deadline) {
              if (h.client.released() === 'stood') { released = true; break }
              await tick(20)
              if (Date.now() - last > 300) { h.client.release(); last = Date.now() }
            }
          }
        } catch { /* the next process waits for the record to run out, as after a crash */ }
        appendMayAct(home, { machine: me, event: 'lost', mayAct: false, why: released ? 'released (planned stop)' : 'stopped; the release did not stand within its cap: the next process waits for the record to run out' })
      }
      h.client.stop('the server is stopping')
      if (lock) await lock.release().catch(() => {})
    },
  }
}
