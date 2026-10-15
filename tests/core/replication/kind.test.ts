/**
 * The generic replication kind (docs/plan/walnut-replica-servers-impl.md,
 * section 4, WP3): the real leader round (kind-leader.ts) against the real
 * follower side (kind-follower.ts) over a JSON-only target
 * (tests/helpers/replica-kind-harness.ts), each target with its own state
 * (replica-status.ts). The task kind's own cases live in
 * tests/core/task-replica.test.ts (companion) and
 * tests/core/task-replica-host-target.test.ts (host).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildKindManifest, confirmKindRemoval, runKindRound, StepFailed } from '../../../src/core/replication/kind-leader.js'
import { forgetKindManifests, kindState, replicaStatuses, _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import { CONFIRM_TTL_MS, UNSUPPORTED_REST_MS } from '../../../src/core/replication/kind.js'
import { followerStep } from '../../../src/core/replication/kind-follower.js'
import { memFollower, memTarget, rowKind, type MemFollower, type Row } from '../../helpers/replica-kind-harness.js'

const KIND = rowKind()
let leader: Row[] = []
let calls: Array<Record<string, unknown>> = []

const rows = (n: number, prefix = 'r', size = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(3, '0')}`, title: `acme ${i}${size ? ' ' + 'x'.repeat(size) : ''}` }))

async function round(f: MemFollower | null, id = 'host:marina', opts: { now?: () => number } = {}) {
  const target = memTarget(id, f, { calls })
  const manifest = await buildKindManifest(KIND, leader, async () => {})
  try {
    return await runKindRound(KIND, manifest, target, opts)
  } catch (err) {
    if (err instanceof StepFailed) return { kind: KIND.kind, action: err.outcome, error: err.message }
    throw err
  }
}

const puts = () => calls.filter((c) => c.op === 'put').reduce((s, c) => s + (c.rows as unknown[]).length, 0)

beforeEach(() => {
  _resetReplicaStatusForTesting()
  leader = rows(5)
  calls = []
})

describe('a generic kind on one target', () => {
  it('the first round brings every row in order; an unchanged round sends nothing', async () => {
    const f = memFollower()
    expect(await round(f)).toMatchObject({ action: 'synced', entries: 5, sent: 5, held: 0, removed: 0 })
    expect(f.ids()).toEqual(leader.map((r) => r.id))
    expect([...f.rows.values()]).toEqual(leader)
    // Every step names its schema.
    expect(calls.every((c) => c.schemaVersion === 1)).toBe(true)
    calls = []
    expect(await round(f)).toMatchObject({ action: 'unchanged', entries: 5 })
    expect(calls).toEqual([])
  })

  it('a changed row is sent alone; a removed row goes', async () => {
    const f = memFollower()
    await round(f)
    leader = leader.map((r) => (r.id === 'r-002' ? { ...r, title: 'acme changed' } : r)).filter((r) => r.id !== 'r-004')
    calls = []
    expect(await round(f)).toMatchObject({ action: 'synced', sent: 1, removed: 1 })
    expect(puts()).toBe(1)
    expect(f.rows.get('r-002')?.title).toBe('acme changed')
    expect(f.ids()).toEqual(['r-000', 'r-001', 'r-002', 'r-003'])
  })

  it('rows over several batches end in the leader\'s order, whatever order the follower had', async () => {
    const f = memFollower()
    leader = rows(30, 'big', 40_000)
    await round(f)
    expect(calls.filter((c) => c.op === 'put').length).toBeGreaterThan(1)
    expect(calls.filter((c) => c.op === 'put' && c.last === true).length).toBe(1)
    leader = [...leader.slice(20), ...leader.slice(0, 10), { id: 'new-a', title: 'a' }, { id: 'new-b', title: 'b' }, ...leader.slice(10, 20)]
    await round(f)
    expect(f.ids()).toEqual(leader.map((r) => r.id))
  })

  it('a held row survives: not replaced, not removed; the next round asks again', async () => {
    const f = memFollower()
    await round(f)
    f.held.add('r-001')
    f.rows.set('r-001', { id: 'r-001', title: 'written on the host' })
    f.held.add('r-003')
    leader = leader.map((r) => (r.id === 'r-001' ? { ...r, title: 'leader side' } : r)).filter((r) => r.id !== 'r-003')
    expect(await round(f)).toMatchObject({ action: 'synced', held: 2 })
    expect(f.rows.get('r-001')?.title).toBe('written on the host')
    expect(f.ids()).toContain('r-003')
    calls = []
    await round(f)
    expect(calls.some((c) => c.op === 'sync')).toBe(true)
    // Its hold ends: the leader's row comes in, the removed one goes.
    f.held.clear()
    expect(await round(f)).toMatchObject({ action: 'synced', held: 0, removed: 1 })
    expect(f.rows.get('r-001')?.title).toBe('leader side')
    expect(f.ids()).not.toContain('r-003')
  })
})

describe('the half rule', () => {
  it('at the floor: removing more than half is refused, half is not; under the floor anything goes', async () => {
    const f = memFollower({ floor: 50 })
    leader = rows(50)
    await round(f)
    const all = leader
    leader = all.slice(0, 24) // removes 26 of 50
    expect(await round(f)).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
    expect(f.ids().length).toBe(50)
    leader = all.slice(0, 25) // removes exactly half
    expect(await round(f)).toMatchObject({ action: 'synced', removed: 25 })
    // 25 rows is under the floor: a manifest removing all but one is taken.
    leader = all.slice(0, 1)
    expect(await round(f)).toMatchObject({ action: 'synced', removed: 24 })
    expect(f.ids()).toEqual(['r-000'])
  })

  it('3 refused rounds at a stable count, then the user confirms: confirm:true is accepted once', async () => {
    const f = memFollower({ floor: 50 })
    leader = rows(60)
    await round(f)
    const target = memTarget('host:marina', f)
    leader = leader.slice(0, 10)
    expect(confirmKindRemoval(target, KIND.kind)).toBe(false)
    for (let i = 1; i <= 3; i++) {
      expect(await round(f)).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
      expect(kindState(target, KIND.kind)).toMatchObject({ refusals: i, lastRefusal: { entries: 10 } })
    }
    const [status] = await replicaStatuses()
    expect(status.kinds).toEqual([expect.objectContaining({ kind: KIND.kind, refusals: 3, needsConfirm: true, lastRefusal: expect.objectContaining({ error: 'manifest_removes_most_rows' }) })])
    expect(confirmKindRemoval(target, KIND.kind)).toBe(true)
    calls = []
    expect(await round(f)).toMatchObject({ action: 'synced', removed: 50 })
    expect(calls.find((c) => c.op === 'sync')?.confirm).toBe(true)
    expect(f.ids().length).toBe(10)
    expect(kindState(target, KIND.kind)).toMatchObject({ refusals: 0, confirmNext: false })
    // The confirm was for that one round: a later mass removal is refused again.
    leader = rows(60, 'again')
    await round(f)
    leader = leader.slice(0, 5)
    calls = []
    expect(await round(f)).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
    expect(calls.find((c) => c.op === 'sync')?.confirm).toBeUndefined()
  })

  it('a count that moves between refusals starts the streak again', async () => {
    const f = memFollower({ floor: 50 })
    leader = rows(60)
    await round(f)
    const target = memTarget('host:marina', f)
    for (const n of [10, 10, 9]) {
      leader = rows(60).slice(0, n)
      await round(f)
    }
    expect(kindState(target, KIND.kind).refusals).toBe(1)
    expect(confirmKindRemoval(target, KIND.kind)).toBe(false)
  })
})

describe('a follower that does not take the kind', () => {
  it('unknown kind: 404 unknown_kind, the kind rests 10 minutes for that target, then is asked again', async () => {
    let now = 1_000_000
    const clock = () => now
    expect(await round(null, 'host:marina', { now: clock })).toMatchObject({ action: 'unsupported' })
    expect(calls.length).toBe(1)
    expect(kindState(memTarget('host:marina', null), KIND.kind)).toMatchObject({ restUntil: now + UNSUPPORTED_REST_MS, restWhy: 'unknown_kind' })
    calls = []
    now += UNSUPPORTED_REST_MS - 1
    expect(await round(null, 'host:marina', { now: clock })).toMatchObject({ action: 'unsupported' })
    expect(calls).toEqual([])
    now += 1
    const f = memFollower() // the follower was upgraded meanwhile
    expect(await round(f, 'host:marina', { now: clock })).toMatchObject({ action: 'synced', sent: 5 })
  })

  it('schema_newer: a follower with older code answers 409 and the kind rests', async () => {
    const old = memFollower({ schemaVersion: 1 })
    const newer = rowKind('acme-rows', 2)
    const manifest = await buildKindManifest(newer, leader, async () => {})
    const target = memTarget('host:marina', old, { calls })
    await expect(runKindRound(newer, manifest, target)).rejects.toMatchObject({ outcome: 'unsupported', code: 'schema_newer' })
    expect(kindState(target, 'acme-rows')).toMatchObject({ restWhy: 'schema_newer' })
    expect(old.ids()).toEqual([])
    calls = []
    expect(await runKindRound(newer, manifest, target)).toMatchObject({ action: 'unsupported' })
    expect(calls).toEqual([])
  })
})

describe('targets and restarts', () => {
  it('each target keeps its own state: one that failed gets the manifest again, the other sends nothing', async () => {
    const a = memFollower()
    const b = memFollower()
    let aDown = false
    const down = memTarget('host:acme', a)
    const flaky = { ...down, post: async (p: Record<string, unknown>, o?: { timeoutMs?: number }) => (aDown ? { ok: false as const, outcome: 'failed' as const, error: 'socket closed' } : down.post(p, o)) }
    const both = async () => {
      const manifest = await buildKindManifest(KIND, leader, async () => {})
      const out: string[] = []
      for (const t of [flaky, memTarget('host:marina', b, { calls })]) {
        try { out.push(`${t.id}:${(await runKindRound(KIND, manifest, t)).action}`) } catch (err) { out.push(`${t.id}:${(err as StepFailed).outcome}`) }
      }
      return out
    }
    expect(await both()).toEqual(['host:acme:synced', 'host:marina:synced'])
    leader = [...leader, { id: 'r-new', title: 'new' }]
    aDown = true
    expect(await both()).toEqual(['host:acme:failed', 'host:marina:synced'])
    expect(b.ids()).toContain('r-new')
    expect(a.ids()).not.toContain('r-new')
    aDown = false
    calls = []
    expect(await both()).toEqual(['host:acme:synced', 'host:marina:unchanged'])
    expect(calls).toEqual([])
    expect(a.ids()).toEqual(b.ids())
    const statuses = await replicaStatuses()
    expect(statuses.map((s) => s.id)).toEqual(['host:acme', 'host:marina'])
  })

  it('a follower restart, and a leader restart, ask for no row again', async () => {
    const f = memFollower()
    leader = rows(40)
    await round(f)
    f.restart()
    forgetKindManifests([KIND.kind]) // the sweep
    calls = []
    expect(await round(f)).toMatchObject({ action: 'synced', sent: 0 })
    expect(puts()).toBe(0)
    _resetReplicaStatusForTesting() // the leader restarted: no memo at all
    calls = []
    expect(await round(f)).toMatchObject({ action: 'synced', sent: 0 })
    expect(calls.map((c) => c.op)).toEqual(['sync'])
  })

  it('a put the follower answered for fewer rows than were sent counts them held', async () => {
    const f = memFollower()
    const real = memTarget('host:marina', f, { calls })
    const cut = { ...real, post: async (p: Record<string, unknown>, o?: { timeoutMs?: number }) => real.post(p.op === 'put' ? { ...p, rows: (p.rows as Row[]).slice(0, 2) } : p, o) }
    const manifest = await buildKindManifest(KIND, leader, async () => {})
    expect(await runKindRound(KIND, manifest, cut)).toMatchObject({ action: 'synced', sent: 2, held: 3 })
    expect(kindState(cut, KIND.kind).manifest).toBeNull()
    expect(await runKindRound(KIND, manifest, real)).toMatchObject({ action: 'synced', sent: 3, held: 0 })
    expect(f.ids()).toEqual(leader.map((r) => r.id))
  })
})

describe('the confirm on a lossy link', () => {
  it('a confirm whose step was lost on the way is kept for the next round', async () => {
    const f = memFollower({ floor: 50 })
    leader = rows(60)
    await round(f)
    leader = leader.slice(0, 10)
    for (let i = 0; i < 3; i++) await round(f)
    const real = memTarget('host:marina', f, { calls })
    expect(confirmKindRemoval(real, KIND.kind)).toBe(true)
    const lost = { ...real, post: async () => ({ ok: false as const, outcome: 'failed' as const, error: 'socket closed' }) }
    const manifest = await buildKindManifest(KIND, leader, async () => {})
    await expect(runKindRound(KIND, manifest, lost)).rejects.toMatchObject({ outcome: 'failed' })
    expect(kindState(real, KIND.kind)).toMatchObject({ confirmNext: true, refusals: 3 })
    calls.length = 0 // the target holds this very array
    expect(await runKindRound(KIND, manifest, real)).toMatchObject({ action: 'synced', removed: 50 })
    expect(calls.find((c) => c.op === 'sync')?.confirm).toBe(true)
  })
})

describe('a confirm is bound to the manifest the user confirmed', () => {
  /** Follower at `have` rows, the leader drops to `to` and is refused 3 times. */
  async function refusedThrice(f: MemFollower, have: number, to: number) {
    leader = rows(have)
    await round(f)
    leader = leader.slice(0, to)
    for (let i = 0; i < 3; i++) await round(f)
    return memTarget('host:marina', f, { calls })
  }

  it('confirmed at 40 rows, the next manifest has 0: refused, the follower keeps every row', async () => {
    const f = memFollower({ floor: 50 })
    const target = await refusedThrice(f, 100, 40)
    expect(confirmKindRemoval(target, KIND.kind)).toBe(true)
    // The status shows the armed confirm, so the user can see it.
    const [status] = await replicaStatuses()
    expect(status.kinds[0]).toMatchObject({ needsConfirm: false, confirmArmed: { entries: 40 } })
    leader = [] // the leader's store opened empty after the click
    calls.length = 0
    expect(await round(f)).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
    expect(calls.find((c) => c.op === 'sync')?.confirm).toBeUndefined()
    expect(f.ids().length).toBe(100)
    expect(f.removals).toEqual([])
    // A new streak at the new count; the old confirm is gone.
    expect(kindState(target, KIND.kind)).toMatchObject({ confirmNext: false, refusals: 1, lastRefusal: { entries: 0 } })
    expect(kindState(target, KIND.kind).confirmFor).toBeUndefined()
  })

  it('the same count with other keys drops the confirm and starts a new streak the user has not seen', async () => {
    const f = memFollower({ floor: 50 })
    const target = await refusedThrice(f, 100, 40)
    const seenKeys = kindState(target, KIND.kind).lastRefusal!.keys!
    expect(confirmKindRemoval(target, KIND.kind)).toBe(true)
    leader = rows(40, 'other') // 40 rows, none the user confirmed keeping
    calls.length = 0
    expect(await round(f)).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
    expect(calls.find((c) => c.op === 'sync')?.confirm).toBeUndefined()
    expect(f.ids().length).toBe(100)
    expect(kindState(target, KIND.kind)).toMatchObject({ refusals: 1, confirmNext: false })
    let [status] = await replicaStatuses()
    expect(status.kinds[0]).toMatchObject({ needsConfirm: false })
    expect(status.kinds[0].confirmArmed).toBeUndefined()
    // Two more refusals of the new set: the row comes back, and a click naming the
    // keys the user saw before (the old set) arms nothing.
    for (let i = 0; i < 2; i++) await round(f)
    ;[status] = await replicaStatuses()
    expect(status.kinds[0]).toMatchObject({ needsConfirm: true, refusals: 3, lastRefusal: { entries: 40 } })
    expect(status.kinds[0].lastRefusal!.keys).not.toBe(seenKeys)
    expect(confirmKindRemoval(target, KIND.kind, { entries: 40, keys: seenKeys })).toBe(false)
    expect(confirmKindRemoval(target, KIND.kind, { entries: 40, keys: status.kinds[0].lastRefusal!.keys })).toBe(true)
  })

  it('the same count and keys again is the same streak, with or without a reorder', async () => {
    const f = memFollower({ floor: 50 })
    await refusedThrice(f, 100, 40)
    leader = [...leader].reverse()
    await round(f)
    expect(kindState(memTarget('host:marina', f), KIND.kind)).toMatchObject({ refusals: 4 })
  })

  it('a refusal says how many rows the follower holds and how many it would remove', async () => {
    const f = memFollower({ floor: 50 })
    const target = await refusedThrice(f, 100, 40)
    expect(kindState(target, KIND.kind).lastRefusal).toMatchObject({ entries: 40, local: 100, removing: 60 })
    const [status] = await replicaStatuses()
    expect(status.kinds[0].lastRefusal).toMatchObject({ entries: 40, local: 100, removing: 60 })
  })

  it('a confirm no round sent within CONFIRM_TTL_MS expires', async () => {
    let now = 5_000_000
    const f = memFollower({ floor: 50 })
    const target = await refusedThrice(f, 100, 40)
    expect(confirmKindRemoval(target, KIND.kind, { now })).toBe(true)
    now += CONFIRM_TTL_MS
    const [status] = await replicaStatuses(now)
    expect(status.kinds[0]).toMatchObject({ needsConfirm: true })
    calls.length = 0
    expect(await round(f, 'host:marina', { now: () => now })).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
    expect(calls.find((c) => c.op === 'sync')?.confirm).toBeUndefined()
    expect(f.ids().length).toBe(100)
  })

  it('the sent confirm names its count and keys; the user may name the count they saw', async () => {
    const f = memFollower({ floor: 50 })
    const target = await refusedThrice(f, 100, 40)
    expect(confirmKindRemoval(target, KIND.kind, { entries: 39 })).toBe(false)
    expect(confirmKindRemoval(target, KIND.kind, { entries: 40 })).toBe(true)
    calls.length = 0
    expect(await round(f)).toMatchObject({ action: 'synced', removed: 60 })
    const sync = calls.find((c) => c.op === 'sync')!
    expect(sync).toMatchObject({ confirm: true, confirmFor: { entries: 40, keys: expect.stringMatching(/^[0-9a-f]{12}$/) } })
    expect(f.ids().length).toBe(40)
  })

  it('the follower refuses a confirm whose confirmFor does not match the manifest it came with', async () => {
    const f = memFollower({ floor: 50 })
    leader = rows(100)
    await round(f)
    const empty = { op: 'sync', kind: KIND.kind, schemaVersion: 1, entries: [], asOf: 1, confirm: true }
    expect(await followerStep({ ...empty, confirmFor: { entries: 40, keys: 'aaaaaaaaaaaa' } }, [f.handler])).toMatchObject({ ok: false, error: 'manifest_removes_most_rows' })
    expect(await followerStep({ ...empty, confirmFor: 'yes' }, [f.handler])).toMatchObject({ ok: false, error: 'manifest_removes_most_rows' })
    expect(f.ids().length).toBe(100)
    // A confirm with no binding at all is refused too: no leader ever sent one.
    expect(await followerStep(empty, [f.handler])).toMatchObject({ ok: false, error: 'manifest_removes_most_rows', local: 100, removing: 100 })
    expect(f.ids().length).toBe(100)
    expect(f.removals).toEqual([])
  })
})

describe('older followers rest the kind instead of failing every round', () => {
  for (const error of ['not_a_replica', 'unknown_op']) {
    it(`a follower that answers 400 ${error} rests the kind 10 minutes for that target`, async () => {
      let now = 2_000_000
      const sent: Array<Record<string, unknown>> = []
      const old = { ...memTarget('host:marina', null), post: async (p: Record<string, unknown>) => { sent.push(p); return { ok: false as const, outcome: 'failed' as const, status: 400, error } } }
      const manifest = await buildKindManifest(KIND, leader, async () => {})
      await expect(runKindRound(KIND, manifest, old, { now: () => now })).rejects.toMatchObject({ outcome: 'unsupported', code: error })
      expect(kindState(old, KIND.kind)).toMatchObject({ restUntil: now + UNSUPPORTED_REST_MS, restWhy: error, action: 'unsupported' })
      // No manifest again on every debounce: the next round asks nothing.
      expect(await runKindRound(KIND, manifest, old, { now: () => now + 3_000 })).toMatchObject({ action: 'unsupported' })
      expect(sent.length).toBe(1)
      now += UNSUPPORTED_REST_MS
      await expect(runKindRound(KIND, manifest, old, { now: () => now })).rejects.toMatchObject({ outcome: 'unsupported' })
      expect(sent.length).toBe(2)
    })
  }
})
