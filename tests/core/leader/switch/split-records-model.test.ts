/**
 * Every state two machines and three witnesses can reach in a few steps, with the witnesses' real rules
 * (permit/rules.ts judge) and the runtime's real decision (runtime.ts wantFor and the split records rule):
 *
 *   moves      the leader renews or hands over to the other machine; the handover's writer cancels it; the
 *              handover's target commits on it (a renew); either machine sends what the runtime decides from a
 *              full read (wantFor, or splitOwnRecords first); time passes (a little, or past every record).
 *              Each record reaches any non-empty set of the witnesses (a cut anywhere).
 *   safety     no two machines ever hold a live lease at once (a lease: a record of the machine taken by a
 *              majority, for validMs from its send).
 *   liveness   from every reached state where nobody holds a lease and no record has a majority, once every
 *              record ran out, the runtime's decisions on full links make a machine lead again within a few
 *              rounds, and it is the machine that held the last lease, or the target of a handover a majority took
 *              after it (the switch finishing): never a takeover. Two histories can leave the witnesses alike with
 *              different last holders (the new machine's commit reached a majority in one, never in the other):
 *              there the switch's target finishing it is the answer both allow.
 *
 * The red control runs the same model with the rule as it was before the cancel case (a cancel of this
 * machine not counted as its own): it reaches a state where nobody can lead again.
 */
import { describe, expect, it } from 'vitest'
import { judge, type WitnessState } from '../../../../src/core/leader/permit/rules.js'
import { DEFAULT_PERMIT_PARAMS, majorityOf, type PermitRecord, type PermitReply } from '../../../../src/core/leader/permit/types.js'
import { splitOwnRecordsForTest, wantFor } from '../../../../src/core/leader/switch/runtime.js'

const P = DEFAULT_PERMIT_PARAMS
const LIST = ['w1', 'w2', 'w3']
const MACHINES = ['A', 'B'] as const
type M = typeof MACHINES[number]
const NONCE: Record<M, string> = { A: 'nonce-a', B: 'nonce-b' }
const other = (m: M): M => (m === 'A' ? 'B' : 'A')
const SUBSETS = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]]
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
  handovers: number
  ticks: number
}

type Split = (read: { standing: PermitRecord | null | undefined; replies: PermitReply[] }, me: M) => ReturnType<typeof wantFor> | null
const HANDLE = { client: { witnessList: () => LIST } }
const realSplit: Split = (read, me) => splitOwnRecordsForTest(HANDLE as never, read, me)

function record(kind: PermitRecord['kind'], by: M, number: number, extra: Partial<PermitRecord> = {}): PermitRecord {
  return { kind, holder: by, by, number, nonce: NONCE[by], validMs: P.validMs, list: LIST, cfg: 'c', epoch: 0, ...extra } as PermitRecord
}

function replies(s: State): PermitReply[] {
  return s.w.map((x, i) => ({ witness: LIST[i]!, re: 'read', ok: true, held: x.held, list: LIST, joint: null, cfg: 'c', epoch: 0, progress: null, ops: [] }) as PermitReply)
}

/** As the permit client counts it: the record a majority of the answers hold (null: none ever), else undefined. */
function standingOf(rs: PermitReply[]): PermitRecord | null | undefined {
  const counts = new Map<string, { r: PermitRecord | null; n: number }>()
  for (const r of rs) {
    const k = r.held ? `${r.held.number}:${r.held.nonce}` : 'none'
    const c = counts.get(k) ?? { r: r.held, n: 0 }
    c.n++
    counts.set(k, c)
  }
  for (const c of counts.values()) if (c.n >= majorityOf(LIST)) return c.r
  return undefined
}

const maxNumber = (s: State) => Math.max(0, ...s.w.map((x) => x.held?.number ?? 0))
const liveLeases = (s: State) => s.leases.filter((l) => l.until > s.t)

/** Send `r` at the state's time to the witnesses `to`: each judges it by its own rule. A majority taking it is a lease for its writer, when it is one that acts. */
function deliver(s: State, r: PermitRecord, to: number[]): State {
  const w = s.w.map((x, i) => {
    if (!to.includes(i)) return x
    const j = judge(x, LIST[i]!, r, s.t, P)
    return j.ok ? j.next : x
  })
  const n = w.filter((x) => x.held?.number === r.number && x.held.nonce === r.nonce).length
  const acts = r.kind === 'renew' || r.kind === 'grant' || r.kind === 'cancel'
  const next: State = { ...s, w }
  if (acts && n >= majorityOf(LIST)) {
    next.leases = [...s.leases.filter((l) => l.until > s.t), { who: r.by as M, until: s.t + P.validMs }]
    next.last = r.by as M
    next.stoodTo = null
  }
  if (r.kind === 'handover' && n >= majorityOf(LIST)) next.stoodTo = r.to as M
  return next
}

/** What the runtime of `me` sends on a full read: its split rule first, then wantFor (the target of a standing handover commits on it). */
function decide(s: State, me: M, split: Split): PermitRecord | null {
  const rs = replies(s)
  const standing = standingOf(rs)
  const commit = standing?.kind === 'handover' && standing.to === me ? standing.number : undefined
  const w = split({ standing, replies: rs }, me) ?? wantFor(standing, me, NONCE[me], commit)
  if (w.want === 'none') return null
  return record(w.want === 'renew' ? 'renew' : 'grant', me, maxNumber(s) + 1)
}

function moves(s: State, split: Split): State[] {
  const out: State[] = []
  const n = maxNumber(s) + 1
  for (const m of MACHINES) {
    const sends: PermitRecord[] = []
    const d = decide(s, m, split)
    if (d) sends.push(d)
    // The leader (a live lease of its own) hands over, once per run.
    if (s.handovers === 0 && liveLeases(s).some((l) => l.who === m)) sends.push(record('handover', m, n, { holder: other(m), from: m, to: other(m) }))
    // The writer of a handover takes it back (its stop wait, a cancel by hand).
    if (s.w.some((x) => x.held?.kind === 'handover' && x.held.from === m)) sends.push(record('cancel', m, n, { from: m }))
    for (const r of sends) {
      // A handover: its writer acts no more from the moment it sends it (client.ts handover freezes it).
      const from = r.kind === 'handover' ? { ...s, leases: s.leases.filter((l) => l.who !== m) } : s
      for (const to of SUBSETS) out.push({ ...deliver(from, r, to), handovers: s.handovers + (r.kind === 'handover' ? 1 : 0) })
    }
  }
  if (s.ticks < 2) {
    out.push({ ...s, t: s.t + 20_000, ticks: s.ticks + 1 })
    out.push({ ...s, t: s.t + EXPIRE, ticks: s.ticks + 1 })
  }
  return out
}

const key = (s: State) => JSON.stringify([s.w.map((x) => [x.held?.kind, x.held?.by, x.held?.holder, x.held?.number, s.t - x.acceptedAt]), liveLeases(s).map((l) => [l.who, l.until - s.t]), s.last, s.stoodTo, s.handovers, s.ticks])

/** Once every record ran out: rounds of both runtimes' decisions on full links. Who leads, if anyone. */
function recover(s0: State, split: Split): M | null {
  let s = { ...s0, t: s0.t + EXPIRE }
  for (let round = 0; round < 4; round++) {
    for (const m of MACHINES) {
      // As the runtime: what a full read decides first (a grant where the split rule allows one); else the writer of a
      // handover that did not stand sends its cancel again.
      const r = decide(s, m, split)
      if (r) s = deliver(s, r, [0, 1, 2])
      else if (s.w.some((x) => x.held?.kind === 'handover' && x.held.from === m)) s = deliver(s, record('cancel', m, maxNumber(s) + 1, { from: m }), [0, 1, 2])
      const lead = liveLeases(s)
      if (lead.length) return lead[lead.length - 1]!.who
    }
  }
  return null
}

function explore(split: Split, depth: number): { states: number; twoLeaders: State[]; stuck: Array<{ s: State; led: M | null }> } {
  const start: State = { t: 0, w: LIST.map(() => ({ held: null, acceptedAt: 0, list: LIST, joint: null, cfg: 'c', epoch: 0, progress: null, ops: [] })), leases: [], last: 'A', stoodTo: null, handovers: 0, ticks: 0 }
  const s0 = deliver(start, record('grant', 'A', 1), [0, 1, 2])
  const seen = new Set<string>([key(s0)])
  const twoLeaders: State[] = []
  const stuck: Array<{ s: State; led: M | null }> = []
  let frontier = [s0]
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: State[] = []
    for (const s of frontier) {
      for (const n of moves(s, split)) {
        const k = key(n)
        if (seen.has(k)) continue
        seen.add(k)
        if (new Set(liveLeases(n).map((l) => l.who)).size > 1) twoLeaders.push(n)
        if (!liveLeases(n).length && standingOf(replies(n)) === undefined) {
          const led = recover(n, split)
          if (led === null || (led !== n.last && led !== n.stoodTo)) stuck.push({ s: n, led })
        }
        next.push(n)
      }
    }
    frontier = next
  }
  return { states: seen.size, twoLeaders, stuck }
}

const show = (x: { s: State; led: M | null }) => `${x.s.w.map((w) => (w.held ? `${w.held.kind} ${w.held.number} ${w.held.by}->${w.held.holder}` : 'none')).join(' | ')}; last lease ${x.s.last}${x.s.stoodTo ? `, handed to ${x.s.stoodTo}` : ''}; after recovery: ${x.led ?? 'nobody'}`

describe('the split records rule over every short history of two machines and three witnesses', () => {
  it('never two leases at once, and from every state where nobody leads the last holder leads again', () => {
    const r = explore(realSplit, Number(process.env.SPLIT_MODEL_DEPTH ?? 7))
    expect(r.states).toBeGreaterThan(1_000)
    console.log(`split records model: ${r.states} states`)
    expect(r.twoLeaders.slice(0, 3).map((s) => show({ s, led: null }))).toEqual([])
    expect([r.stuck.length, ...r.stuck.slice(0, 6).map(show)]).toEqual([0])
  }, 120_000)

  it('red control: without the cancel case some state leaves nobody able to lead', () => {
    // The rule as it was before: a cancel of this machine is neither its own record nor a record of its own above a handover.
    const before: Split = (read, me) => {
      if (read.standing !== undefined) return null
      const answers = read.replies.filter((r) => LIST.includes(r.witness) && r.list)
      if (answers.length < majorityOf(LIST)) return null
      const mineAbove = (n: number) => answers.some((a) => (a.held?.kind === 'renew' || a.held?.kind === 'grant') && a.held.holder === me && a.held.number > n)
      const own = (r: PermitReply) => !r.held || (r.held.kind === 'release' ? r.held.by === me
        : r.held.kind === 'handover' ? (r.held.holder === me || r.held.from === me) && mineAbove(r.held.number)
          : (r.held.kind === 'renew' || r.held.kind === 'grant') && r.held.holder === me)
      return answers.every(own) ? { want: 'grant' } : null
    }
    const r = explore(before, 5)
    expect(r.twoLeaders.length).toBe(0)
    expect(r.stuck.length).toBeGreaterThan(0)
    expect(r.stuck.some((x) => x.s.w.some((w) => w.held?.kind === 'cancel'))).toBe(true)
  }, 120_000)
})
