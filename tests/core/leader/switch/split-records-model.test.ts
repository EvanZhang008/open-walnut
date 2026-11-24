/**
 * Every state two machines and three witnesses can reach in a few steps, with the witnesses' real rules
 * (permit/rules.ts judge) and the runtime's real decision (runtime.ts wantFor and the split records rule):
 *
 *   moves      the leader renews or hands over to the other machine; the handover's writer cancels it; the
 *              handover's target commits on it (a renew); the leader gives the permission back for its restart
 *              (a release: its next process has a new incarnation); the leader changes the witness list (a
 *              members record, its joint step and then its final one, to the same three witnesses: a new
 *              configuration every later record must carry); either machine sends what the runtime decides
 *              from a read of all three witnesses or of any two (wantFor, or splitOwnRecords first); time
 *              passes (a little, or past every record). Each record reaches any non-empty set of the
 *              witnesses (a cut anywhere).
 *   safety     no two machines ever hold a live lease at once (a lease: a record of the machine that acts,
 *              taken by a majority, for validMs from its send), and no lease is a takeover: every lease is
 *              the machine of the last lease, or the target of a handover a majority took after it.
 *   liveness   from every reached state where nobody holds a lease and no record has a majority, once every
 *              record ran out, the runtime's decisions on full links make a machine lead again within a few
 *              rounds, and it is the machine that held the last lease, or the target of a handover a majority
 *              took after it (the switch finishing). Two histories can leave the witnesses alike with
 *              different last holders (the new machine's commit reached a majority in one, never in the
 *              other): there the switch's target finishing it is the answer both allow.
 *
 * Red controls: the rule as it was before the cancel case leaves a state where nobody can lead again; a loose
 * rule (a grant whenever no record has a majority) takes over.
 */
import { describe, expect, it } from 'vitest'
import { judge, type WitnessState } from '../../../../src/core/leader/permit/rules.js'
import { DEFAULT_PERMIT_PARAMS, NO_HOLDER, majorityOf, type PermitRecord, type PermitReply } from '../../../../src/core/leader/permit/types.js'
import { splitOwnRecordsForTest, wantFor } from '../../../../src/core/leader/switch/runtime.js'

const P = DEFAULT_PERMIT_PARAMS
const LIST = ['w1', 'w2', 'w3']
/** The list change: w3 leaves, w4 (set up, waiting to join) comes in. */
const NEW_LIST = ['w1', 'w2', 'w4']
const SLOTS = ['w1', 'w2', 'w3', 'w4']
const MACHINES = ['A', 'B'] as const
type M = typeof MACHINES[number]
const other = (m: M): M => (m === 'A' ? 'B' : 'A')
const subsets = (n: number) => Array.from({ length: 2 ** n - 1 }, (_, k) => [...Array(n).keys()].filter((i) => ((k + 1) >> i) & 1))
/** Where a record lands: any non-empty set of w1 to w3, or of all four once the list change began (w4 takes only that change before). */
const SUBSETS3 = subsets(3)
const SUBSETS4 = subsets(4)
/** The reads a runtime decides from: every witness, or all but one (it does not answer). */
const READS: Array<number[] | undefined> = [undefined, [0, 1, 3], [0, 2, 3], [1, 2, 3], [0, 1, 2]]
const EXPIRE = P.validMs + P.witnessMarginMs + 1

interface State {
  t: number
  w: WitnessState[]
  /** Leases taken: who, until when (its send plus validMs). */
  leases: Array<{ who: M; until: number }>
  /** The machine of the last lease taken. */
  last: M
  /** The target of a handover a majority took since that lease: the switch may finish there (its commit, late or not). */
  stoodTo: M | null
  /** Each machine's process: a release ends it (its restart is a new incarnation). */
  inc: Record<M, number>
  handovers: number
  releases: number
  /** The list change: 0 none, 1 its joint step sent, 2 its final step sent. */
  members: number
  /** The configuration each machine's client judges by (the writer's after its own change stood; viewOf adds what reads teach). */
  conf: Record<M, Conf>
  ticks: number
}

type Split = (read: { standing: PermitRecord | null | undefined; replies: PermitReply[]; list: string[] }, me: M) => ReturnType<typeof wantFor> | null
const realSplit: Split = (read, me) => splitOwnRecordsForTest({ client: { witnessList: () => read.list } } as never, read, me)

interface Conf { list: string[]; joint: string[] | null; cfg: string; epoch: number }
const FIRST: Conf = { list: LIST, joint: null, cfg: 'c', epoch: 0 }
const confKey = (c: Conf) => `${c.cfg}|${c.list.join(',')}|${c.joint?.join(',') ?? ''}`

const nonceOf = (s: State, m: M) => `nonce-${m}-${s.inc[m]}`

/** The configuration `m`'s client sends with: its own, or one a majority of its list serves (client.ts learnFromRead). */
function viewOf(s: State, m: M): Conf {
  let c = s.conf[m]
  for (let round = 0; round < 2; round++) {
    const served = new Map<string, { c: Conf; n: number }>()
    s.w.forEach((x, i) => {
      if (!c.list.includes(SLOTS[i]!) || !x.list || !x.cfg || x.epoch === null) return
      const xc: Conf = { list: [...x.list].sort(), joint: x.joint ? [...x.joint].sort() : null, cfg: x.cfg, epoch: x.epoch }
      if (confKey(xc) === confKey(c)) return
      const e = served.get(confKey(xc)) ?? { c: xc, n: 0 }
      e.n++
      served.set(confKey(xc), e)
    })
    const next = [...served.values()].find((e) => e.n >= majorityOf(c.list))
    if (!next) break
    c = next.c
  }
  return c
}

function record(s: State, kind: PermitRecord['kind'], by: M, number: number, extra: Partial<PermitRecord> = {}): PermitRecord {
  const c = viewOf(s, by)
  return { kind, holder: by, by, number, nonce: nonceOf(s, by), validMs: P.validMs, list: [...c.list], cfg: c.cfg, epoch: c.epoch, ...(c.joint ? { joint: [...c.joint] } : {}), ...extra } as PermitRecord
}

function replies(s: State, only?: number[]): PermitReply[] {
  return s.w.flatMap((x, i) => (only && !only.includes(i) ? [] : [{ witness: SLOTS[i]!, re: 'read', ok: true, held: x.held, list: x.list, joint: x.joint, cfg: x.cfg, epoch: x.epoch, progress: null, ops: [] } as PermitReply]))
}

/** As the permit client counts it (client.ts standing): the record a majority of its list hold (null: none ever), else undefined. */
function standingOf(rs: PermitReply[], list: string[]): PermitRecord | null | undefined {
  const counts = new Map<string, { r: PermitRecord | null; n: number }>()
  for (const r of rs) {
    if (!list.includes(r.witness) || !r.list) continue
    const k = r.held ? `${r.held.number}:${r.held.nonce}` : 'none'
    const c = counts.get(k) ?? { r: r.held, n: 0 }
    c.n++
    counts.set(k, c)
  }
  for (const c of counts.values()) if (c.n >= majorityOf(list)) return c.r
  return undefined
}

/**
 * A record counts once a majority of its list holds it, and of its new list too during a change (client.ts chosen);
 * `oldListOnly`: a majority of its list alone, as a reader that counts its own list sees it stand (client.ts standing).
 */
function chosen(w: WitnessState[], r: PermitRecord, oldListOnly = false): boolean {
  const holds = SLOTS.filter((_, i) => w[i]!.held?.number === r.number && w[i]!.held!.nonce === r.nonce)
  return [r.list, ...(r.joint && !oldListOnly ? [r.joint] : [])].every((l) => l.filter((x) => holds.includes(x)).length >= majorityOf(l))
}

const maxNumber = (s: State) => Math.max(0, ...s.w.map((x) => x.held?.number ?? 0))
const liveLeases = (s: State) => s.leases.filter((l) => l.until > s.t)
const ACTS = new Set<PermitRecord['kind']>(['renew', 'grant', 'cancel', 'members'])

interface Found { twoLeaders: State[]; takeovers: string[] }

/** Send `r` at the state's time to the witnesses `to`: each judges it by its own rule. A majority taking it is a lease for its writer, when it is one that acts. */
function deliver(s: State, r: PermitRecord, to: number[], found?: Found): State {
  const w = s.w.map((x, i) => {
    if (!to.includes(i)) return x
    const j = judge(x, SLOTS[i]!, r, s.t, P)
    return j.ok ? j.next : x
  })
  const stood = chosen(w, r)
  const next: State = { ...s, w }
  if (ACTS.has(r.kind) && stood) {
    // Never a takeover: the lease goes to the machine of the last one, or to the target of a handover that stood after it.
    if (found && r.by !== s.last && r.by !== s.stoodTo) found.takeovers.push(`${r.kind} ${r.number} by ${r.by} (last ${s.last}, handed to ${s.stoodTo ?? 'none'}): ${showW(s)}`)
    next.leases = [...s.leases.filter((l) => l.until > s.t), { who: r.by as M, until: s.t + P.validMs }]
    next.last = r.by as M
    next.stoodTo = null
  }
  // The switch may finish once its handover stands where the runtime reads it (a majority of the list it judges by):
  // the old holder wrote it, so its target leading after it is the switch, not a takeover.
  if (r.kind === 'handover' && chosen(w, r, true)) next.stoodTo = r.to as M
  // A list change that stood: its writer's client judges by what it set up (client.ts onChosen).
  if (r.kind === 'members' && stood) {
    const at = w.find((x) => x.held?.number === r.number && x.held.nonce === r.nonce)!
    next.conf = { ...s.conf, [r.by]: { list: [...at.list!].sort(), joint: at.joint ? [...at.joint].sort() : null, cfg: at.cfg!, epoch: at.epoch! } }
  }
  return next
}

/** What the runtime of `me` sends on a read of `only` (all three by default): its split rule first, then wantFor (the target of a standing handover commits on it). */
function decide(s: State, me: M, split: Split, only?: number[]): PermitRecord | null {
  const rs = replies(s, only)
  const list = viewOf(s, me).list
  const standing = standingOf(rs, list)
  const commit = standing?.kind === 'handover' && standing.to === me ? standing.number : undefined
  const w = split({ standing, replies: rs, list }, me) ?? wantFor(standing, me, nonceOf(s, me), commit)
  if (w.want === 'none') return null
  return record(s, w.want === 'renew' ? 'renew' : 'grant', me, maxNumber(s) + 1)
}

/** A writer whose process acts no more from the moment it sends `r` (a handover freezes it, a release ends it). */
function freezes(s: State, r: PermitRecord): State {
  if (r.kind === 'handover') return { ...s, leases: s.leases.filter((l) => l.who !== r.by) }
  if (r.kind === 'release') return { ...s, leases: s.leases.filter((l) => l.who !== r.by), inc: { ...s.inc, [r.by]: s.inc[r.by as M] + 1 }, releases: s.releases + 1 }
  return s
}

function moves(s: State, split: Split, found: Found, listChange: boolean): State[] {
  const out: State[] = []
  const n = maxNumber(s) + 1
  for (const m of MACHINES) {
    const sends: PermitRecord[] = []
    for (const only of READS) {
      const d = decide(s, m, split, only)
      if (d && !sends.some((x) => x.kind === d.kind)) sends.push(d)
    }
    const leads = liveLeases(s).some((l) => l.who === m)
    // The leader hands over to the other machine, once per run.
    if (s.handovers === 0 && leads) sends.push(record(s, 'handover', m, n, { holder: other(m), from: m, to: other(m) }))
    // The writer of a handover takes it back (its stop wait, a cancel by hand).
    if (s.w.some((x) => x.held?.kind === 'handover' && x.held.from === m && x.held.nonce === nonceOf(s, m))) sends.push(record(s, 'cancel', m, n, { from: m }))
    // The leader gives the permission back for its restart (a planned stop), once per run.
    if (s.releases === 0 && leads) sends.push(record(s, 'release', m, n, { holder: NO_HOLDER, from: m }))
    // The leader changes the witness list (w3 out, w4 in): the joint step, then the final one once a majority of each list took the joint.
    if (listChange && s.members === 0 && leads) sends.push(record(s, 'members', m, n, { stage: 'joint', newList: [...NEW_LIST], joint: [...NEW_LIST] }))
    // The pair's evidence: the witnesses that took its joint step (those already past it did too, client.ts evidence).
    const inPair = SLOTS.filter((_, i) => s.w[i]!.joint || s.w[i]!.epoch === 1)
    const pairShown = [LIST, NEW_LIST].every((l) => l.filter((x) => inPair.includes(x)).length >= majorityOf(l))
    if (listChange && s.members === 1 && leads && pairShown) sends.push(record(s, 'members', m, n, { list: [...LIST], joint: [...NEW_LIST], stage: 'final', newList: [...NEW_LIST], pairBy: inPair }))
    for (const r of sends) {
      const from = freezes(s, r)
      const step = { handovers: s.handovers + (r.kind === 'handover' ? 1 : 0), members: s.members + (r.kind === 'members' ? 1 : 0) }
      for (const to of s.members > 0 || r.kind === 'members' ? SUBSETS4 : SUBSETS3) out.push({ ...deliver(from, r, to, found), ...step })
    }
  }
  if (s.ticks < 2) {
    out.push({ ...s, t: s.t + 20_000, ticks: s.ticks + 1 })
    out.push({ ...s, t: s.t + EXPIRE, ticks: s.ticks + 1 })
  }
  return out
}

const key = (s: State) => JSON.stringify([s.w.map((x) => [x.held?.kind, x.held?.by, x.held?.holder, x.held?.number, x.held?.nonce, s.t - x.acceptedAt, x.cfg, x.epoch, !!x.joint]), liveLeases(s).map((l) => [l.who, l.until - s.t]), s.last, s.stoodTo, s.inc, s.handovers, s.releases, s.members, s.ticks, confKey(s.conf.A), confKey(s.conf.B)])

/** Rounds of both runtimes' decisions on full links, every record run out before each (a witness holding a cancel or a grant that did not stand refuses a grant until then). Who leads, if anyone. */
function recover(s0: State, split: Split, found: Found): M | null {
  let s = s0
  for (let round = 0; round < 4; round++) {
    s = { ...s, t: s.t + EXPIRE }
    // A list change left half done (some witness in its joint step) is run again: an operator's step (permit-ops.ts
    // changeWitnesses; the runtime does not repair one by itself), on the machine of the last lease, until it is done: the joint step from the first configuration again, then the final one once a
    // majority of each list took the joint.
    // Done once every witness of the new list serves it (one that missed it, w4 down during the change, answers nobody:
    // running the change again sets it up, as the operator's init does).
    const finished = NEW_LIST.every((x) => s.w[SLOTS.indexOf(x)]!.epoch === 1)
    if (s.w.some((x) => x.joint || x.epoch) && !finished) {
      const by = s.last
      s = deliver(s, record(s, 'members', by, maxNumber(s) + 1, { ...FIRST, joint: [...NEW_LIST], stage: 'joint', newList: [...NEW_LIST] }), [0, 1, 2, 3], found)
      const inPair = SLOTS.filter((_, i) => s.w[i]!.joint || s.w[i]!.epoch === 1)
      if ([LIST, NEW_LIST].every((l) => l.filter((x) => inPair.includes(x)).length >= majorityOf(l))) {
        s = deliver(s, record(s, 'members', by, maxNumber(s) + 1, { ...FIRST, joint: [...NEW_LIST], stage: 'final', newList: [...NEW_LIST], pairBy: inPair }), [0, 1, 2, 3], found)
      }
      const lead = liveLeases(s)
      if (lead.length) return lead[lead.length - 1]!.who
    }
    for (const m of MACHINES) {
      // As the runtime: what a full read decides first (a grant where the split rule allows one); else the writer of a
      // handover that did not stand sends its cancel again.
      const r = decide(s, m, split)
      if (r) s = deliver(s, r, [0, 1, 2, 3], found)
      else if (s.w.some((x) => x.held?.kind === 'handover' && x.held.from === m && x.held.nonce === nonceOf(s, m))) s = deliver(s, record(s, 'cancel', m, maxNumber(s) + 1, { from: m }), [0, 1, 2, 3], found)
      const lead = liveLeases(s)
      if (lead.length) return lead[lead.length - 1]!.who
    }
  }
  return null
}

/** The walk yields to the event loop every so many states, so the test worker's calls home (its RPC) are answered during it. */
const YIELD_EVERY = 2_000

async function explore(split: Split, depth: number, listChange = false): Promise<{ states: number; held: Set<string>; twoLeaders: State[]; takeovers: string[]; stuck: Array<{ s: State; led: M | null }> }> {
  const found: Found = { twoLeaders: [], takeovers: [] }
  // w4 is set up and waits to join (no list, no configuration): it takes only the change that brings it in.
  const witness = (joining: boolean): WitnessState => ({ held: null, acceptedAt: 0, list: joining ? null : LIST, joint: null, cfg: joining ? null : 'c', epoch: 0, progress: null, ops: [] })
  const start: State = { t: 0, w: SLOTS.map((x) => witness(x === 'w4')), leases: [], last: 'A', stoodTo: null, inc: { A: 0, B: 0 }, handovers: 0, releases: 0, members: 0, ticks: 0, conf: { A: FIRST, B: FIRST } }
  const s0 = deliver(start, record(start, 'grant', 'A', 1), [0, 1, 2, 3])
  const seen = new Set<string>([key(s0)])
  const stuck: Array<{ s: State; led: M | null }> = []
  // What the witnesses came to hold (the model reaches every kind, and the new configuration).
  const held = new Set<string>()
  let frontier = [s0]
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: State[] = []
    for (const [i, s] of frontier.entries()) {
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise((r) => setImmediate(r))
      for (const n of moves(s, split, found, listChange)) {
        const k = key(n)
        if (seen.has(k)) continue
        seen.add(k)
        for (const x of n.w) { if (x.held) held.add(`${x.held.kind}${x.held.kind === 'members' ? `:${x.held.stage}` : ''}`); if (x.epoch) held.add(`epoch ${x.epoch}`) }
        if (new Set(liveLeases(n).map((l) => l.who)).size > 1) found.twoLeaders.push(n)
        if (!liveLeases(n).length && MACHINES.every((m) => standingOf(replies(n), viewOf(n, m).list) === undefined)) {
          const led = recover(n, split, found)
          if (led === null || (led !== n.last && led !== n.stoodTo)) stuck.push({ s: n, led })
        }
        next.push(n)
      }
    }
    frontier = next
  }
  return { states: seen.size, held, twoLeaders: found.twoLeaders, takeovers: [...new Set(found.takeovers)], stuck }
}

const showW = (s: State) => s.w.map((w) => (w.held ? `${w.held.kind} ${w.held.number} ${w.held.by}->${w.held.holder}` : 'none')).join(' | ')
const show = (x: { s: State; led: M | null }) => `${showW(x.s)}; last lease ${x.s.last}${x.s.stoodTo ? `, handed to ${x.s.stoodTo}` : ''}; after recovery: ${x.led ?? 'nobody'}`

describe('the split records rule over every short history of two machines and three witnesses', () => {
  it('never two leases at once, never a takeover, and from every state where nobody leads the last holder leads again', async () => {
    const r = await explore(realSplit, Number(process.env.SPLIT_MODEL_DEPTH ?? 6))
    expect(r.states).toBeGreaterThan(10_000)
    console.log(`split records model: ${r.states} states`)
    expect([...r.held].sort()).toEqual(['cancel', 'grant', 'handover', 'release', 'renew'])
    expect(r.twoLeaders.slice(0, 3).map((s) => show({ s, led: null }))).toEqual([])
    expect(r.takeovers.slice(0, 5)).toEqual([])
    expect([r.stuck.length, ...r.stuck.slice(0, 6).map(show)]).toEqual([0])
  }, 300_000)

  it('the same with a witness list change (w3 out, w4 in: its joint and final steps), a step shallower', async () => {
    const r = await explore(realSplit, Number(process.env.SPLIT_MODEL_DEPTH_LIST ?? 5), true)
    console.log(`split records model with a list change: ${r.states} states`)
    expect([...r.held].sort()).toEqual(['cancel', 'epoch 1', 'grant', 'handover', 'members:final', 'members:joint', 'release', 'renew'])
    expect(r.twoLeaders.slice(0, 3).map((s) => show({ s, led: null }))).toEqual([])
    expect(r.takeovers.slice(0, 5)).toEqual([])
    expect([r.stuck.length, ...r.stuck.slice(0, 6).map(show)]).toEqual([0])
  }, 300_000)

  it('red control: without the cancel case some state leaves nobody able to lead', async () => {
    // The rule as it was before: a cancel of this machine is neither its own record nor a record of its own above a handover.
    const before: Split = (read, me) => {
      if (read.standing !== undefined) return null
      const answers = read.replies.filter((r) => read.list.includes(r.witness) && r.list)
      if (answers.length < majorityOf(read.list)) return null
      const mineAbove = (n: number) => answers.some((a) => (a.held?.kind === 'renew' || a.held?.kind === 'grant') && a.held.holder === me && a.held.number > n)
      const own = (r: PermitReply) => !r.held || (r.held.kind === 'release' ? r.held.by === me
        : r.held.kind === 'handover' ? (r.held.holder === me || r.held.from === me) && mineAbove(r.held.number)
          : (r.held.kind === 'renew' || r.held.kind === 'grant') && r.held.holder === me)
      return answers.every(own) ? { want: 'grant' } : null
    }
    const r = await explore(before, 5)
    expect(r.twoLeaders.length).toBe(0)
    expect(r.stuck.length).toBeGreaterThan(0)
    expect(r.stuck.some((x) => x.s.w.some((w) => w.held?.kind === 'cancel'))).toBe(true)
  }, 300_000)

  it('red control: a grant whenever no record has a majority takes over', async () => {
    const loose: Split = (read) => (read.standing === undefined && read.replies.filter((r) => read.list.includes(r.witness)).length >= majorityOf(read.list) ? { want: 'grant' } : null)
    const r = await explore(loose, 5)
    expect(r.takeovers.length).toBeGreaterThan(0)
  }, 300_000)
})
