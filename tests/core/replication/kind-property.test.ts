/**
 * Property test of the generic replication kind (docs/plan/walnut-replica-servers-impl.md,
 * section 4, WP3): random row sets, edits, reorders and held sets on the real
 * leader round and the real follower side (tests/helpers/replica-kind-harness.ts),
 * over a transport that drops steps (before and after delivery), duplicates
 * them, delivers an old put again out of order, and cuts puts short.
 *
 * Invariant after a quiet round (the sweep's forget, then a clean transport):
 * the follower's rows equal the leader's except the held ones, in the
 * leader's order; a held row the follower had is still there; and no step
 * ever removed more than half of the follower's rows once it held the floor.
 * In about a third of the runs the leader's store opens damaged for one round
 * (a view with under a third of its rows, as an empty or broken database at
 * boot) once the follower holds the floor: that manifest must remove nothing.
 *
 * Seeded mulberry32 as tests/core/session-snapshot-sim.test.ts; scenario i uses
 * WALNUT_SIM_SEED + i; WALNUT_SIM_RUNS runs (default 200).
 */
import { describe, expect, it } from 'vitest'
import type { CloudReplicaReply } from '../../../src/core/cloud-ingest.js'
import { buildKindManifest, runKindRound } from '../../../src/core/replication/kind-leader.js'
import { forgetKindManifests, _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import type { ReplicaTarget } from '../../../src/core/replication/replica-targets.js'
import { memFollower, memTarget, rowKind, type MemFollower, type Row } from '../../helpers/replica-kind-harness.js'

const RUNS = Number(process.env.WALNUT_SIM_RUNS) || 200
const BASE_SEED = Number(process.env.WALNUT_SIM_SEED) || 0x5eed03
const FLOOR = 50
const KIND = rowKind()

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Faults { drop: number; lostAnswer: number; dup: number; stale: number; cut: number }

/** How often each fault fired over all runs: the property is not vacuous. */
const fired = { drop: 0, lostAnswer: 0, dup: 0, stale: 0, cut: 0, held: 0, refusedRounds: 0, massRounds: 0, refusedInMass: 0 }

/** A transport over the real follower with faults, and the old puts it may deliver again. */
function faulty(f: MemFollower, rnd: () => number, faults: Faults): ReplicaTarget {
  const real = memTarget('host:marina', f)
  const oldPuts: Array<Record<string, unknown>> = []
  return {
    ...real,
    post: async (payload, opts): Promise<CloudReplicaReply> => {
      let body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
      if (rnd() < faults.drop) { fired.drop++; return { ok: false, outcome: 'failed', error: 'socket closed before the body' } }
      if (oldPuts.length > 0 && rnd() < faults.stale) { fired.stale++; await real.post(oldPuts[Math.floor(rnd() * oldPuts.length)], opts) }
      if (body.op === 'put' && Array.isArray(body.rows) && body.rows.length > 1 && rnd() < faults.cut) {
        fired.cut++
        body = { ...body, rows: body.rows.slice(0, 1 + Math.floor(rnd() * (body.rows.length - 1))) }
      }
      if (body.op === 'put') oldPuts.push(body)
      let r = await real.post(body, opts)
      if (rnd() < faults.dup) { fired.dup++; r = await real.post(body, opts) }
      if (rnd() < faults.lostAnswer) { fired.lostAnswer++; return { ok: false, outcome: 'failed', error: 'answer lost' } }
      if (!r.ok && r.error === 'manifest_removes_most_rows') fired.refusedRounds++
      return r
    },
  }
}

async function round(target: ReplicaTarget, leader: Row[]): Promise<void> {
  const manifest = await buildKindManifest(KIND, leader, async () => {})
  try { await runKindRound(KIND, manifest, target) } catch { /* a failed round: the next one asks again */ }
}

let nextId = 0
const newRow = (rnd: () => number): Row => ({ id: `k-${nextId++}`, title: `acme ${Math.floor(rnd() * 1e6)}`, n: Math.floor(rnd() * 10) })

/** One step of leader edits: changes, adds, at most 10% removed, sometimes a reorder. */
function editLeader(rows: Row[], rnd: () => number): Row[] {
  let out = rows.map((r) => (rnd() < 0.15 ? { ...r, title: `${r.title}!`, n: (r.n ?? 0) + 1 } : r))
  const removals = Math.floor(out.length * 0.1 * rnd())
  for (let i = 0; i < removals; i++) out.splice(Math.floor(rnd() * out.length), 1)
  const adds = Math.floor(rnd() * 6)
  for (let i = 0; i < adds; i++) out.splice(Math.floor(rnd() * (out.length + 1)), 0, newRow(rnd))
  if (rnd() < 0.3 && out.length > 1) {
    const a = Math.floor(rnd() * out.length)
    const [moved] = out.splice(a, 1)
    out.splice(Math.floor(rnd() * (out.length + 1)), 0, moved)
  }
  if (rnd() < 0.1) out = [...out].reverse()
  return out
}

/** The follower writes rows of its own (they are held) and some holds end. */
function editHeld(f: MemFollower, leader: Row[], rnd: () => number, kept: Map<string, Row | null>): void {
  for (const k of [...f.held]) if (rnd() < 0.3) { f.held.delete(k); kept.delete(k) }
  const pool = [...new Set([...f.ids(), ...leader.map((r) => r.id)])]
  const n = Math.floor(rnd() * 3)
  for (let i = 0; i < n && pool.length > 0; i++) {
    const k = pool[Math.floor(rnd() * pool.length)]
    if (f.held.has(k)) continue
    f.held.add(k)
    fired.held++
    if (rnd() < 0.2) { f.rows.delete(k); kept.set(k, null) } // deleted here
    else {
      const own = { id: k, title: `written on the host ${i}` }
      if (!f.rows.has(k)) f.order.push(k)
      f.rows.set(k, own)
      kept.set(k, own)
    }
    delete f.state.hashes[k] // as noteLocalTaskWrite: the row is no longer the leader's
  }
}

function check(f: MemFollower, leader: Row[], kept: Map<string, Row | null>): string | null {
  const free = (k: string) => !f.held.has(k)
  const want = leader.filter((r) => free(r.id))
  const have = f.ids().filter(free)
  if (want.length !== have.length || new Set(have).size !== have.length) return `rows: leader ${want.length}, follower ${have.length}`
  const wantSet = new Set(want.map((r) => r.id))
  for (const k of have) if (!wantSet.has(k)) return `follower keeps ${k}, which the leader does not have`
  for (const r of want) if (JSON.stringify(f.rows.get(r.id)) !== JSON.stringify(r)) return `row ${r.id} differs`
  const both = new Set(have)
  const wantOrder = leader.map((r) => r.id).filter((k) => free(k) && both.has(k))
  if (JSON.stringify(have) !== JSON.stringify(wantOrder)) return 'order differs'
  for (const [k, own] of kept) {
    if (!f.held.has(k)) continue
    if (own === null ? f.rows.has(k) : JSON.stringify(f.rows.get(k)) !== JSON.stringify(own)) return `held row ${k} changed`
  }
  for (const [before, removed] of f.removals) if (before >= FLOOR && removed * 2 > before) return `removed ${removed} of ${before}`
  return null
}

/**
 * The leader's store opened damaged for one round: a view keeping under a
 * third of its rows. When that would remove more than half of the follower's
 * (non-held) rows, the round must remove none of them.
 */
async function massDrop(f: MemFollower, target: ReplicaTarget, leader: Row[], rnd: () => number): Promise<string | null> {
  const view = leader.filter(() => rnd() < 0.3)
  const viewSet = new Set(view.map((r) => r.id))
  const before = f.ids()
  const removing = before.filter((k) => !viewSet.has(k) && !f.held.has(k)).length
  if (before.length < FLOOR || removing * 2 <= before.length) return null
  fired.massRounds++
  const refusedBefore = fired.refusedRounds
  await round(target, view)
  fired.refusedInMass += fired.refusedRounds - refusedBefore
  const after = new Set(f.ids())
  const lost = before.filter((k) => !after.has(k) && !f.held.has(k))
  return lost.length > 0 ? `a damaged manifest removed ${lost.length} of ${before.length} rows` : null
}

async function scenario(seed: number, floor = FLOOR): Promise<string | null> {
  const rnd = mulberry32(seed)
  _resetReplicaStatusForTesting()
  const f = memFollower({ floor })
  const kept = new Map<string, Row | null>()
  let leader = Array.from({ length: Math.floor(rnd() * 120) }, () => newRow(rnd))
  const faults: Faults = { drop: rnd() * 0.25, lostAnswer: rnd() * 0.2, dup: rnd() * 0.3, stale: rnd() * 0.2, cut: rnd() * 0.3 }
  const target = faulty(f, rnd, faults)
  const steps = 1 + Math.floor(rnd() * 4)
  const massAt = rnd() < 0.35 ? Math.floor(rnd() * steps) : -1
  for (let s = 0; s < steps; s++) {
    leader = editLeader(leader, rnd)
    editHeld(f, leader, rnd, kept)
    if (s === massAt) {
      const why = await massDrop(f, target, leader, rnd)
      if (why) return why
    }
    await round(target, leader)
  }
  // The quiet round: the sweep forgets every manifest, the transport is clean.
  forgetKindManifests([KIND.kind])
  const clean = memTarget('host:marina', f)
  await round(clean, leader)
  return check(f, leader, kept)
}

describe('a generic kind over a lossy transport (property)', () => {
  it(`after a quiet round the follower equals the leader except held rows (${RUNS} runs, seed ${BASE_SEED})`, async () => {
    const failures: string[] = []
    for (let i = 0; i < RUNS; i++) {
      const why = await scenario(BASE_SEED + i)
      if (why) failures.push(`seed ${BASE_SEED + i}: ${why}`)
      if (failures.length >= 5) break
    }
    expect(failures).toEqual([])
    // Enough runs fire every fault at least once (a few runs may not).
    if (RUNS >= 50) for (const k of ['drop', 'lostAnswer', 'dup', 'stale', 'cut', 'held'] as const) expect([k, fired[k] > 0]).toEqual([k, true])
    // Damaged rounds happened and the follower refused them; the generator's own
    // edits keep removals under half, so no other round was ever refused.
    if (RUNS >= 50) expect([fired.massRounds > 0, fired.refusedInMass > 0]).toEqual([true, true])
    expect(fired.refusedRounds - fired.refusedInMass).toBe(0)
  }, 120_000)

  it('the half-rule clause really bites: a follower that never reaches its floor is emptied by a damaged manifest', async () => {
    // A floor out of reach is a follower without the half rule: some seed's damaged round must show.
    let found: string | null = null
    for (let i = 0; i < 200 && !found; i++) found = await scenario(BASE_SEED + i, 1e9)
    expect(found).toMatch(/a damaged manifest removed/)
  })

  it('the invariant really bites: a follower whose hold is never cleaned up shows', async () => {
    const f = memFollower({ floor: FLOOR })
    const leader = [{ id: 'k-a', title: 'a' }, { id: 'k-b', title: 'b' }]
    await round(memTarget('host:marina', f), leader)
    f.rows.set('k-a', { id: 'k-a', title: 'drifted' }) // not held, hash kept: nothing asks for it again
    expect(check(f, leader, new Map())).toBe('row k-a differs')
  })
})
