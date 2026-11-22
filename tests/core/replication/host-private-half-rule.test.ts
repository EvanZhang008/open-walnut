/**
 * Making many tasks local at once never waits on the half rule (kind.ts `leftOut`,
 * host-private.ts hostManifest): a host target's manifest names the rows it leaves out as kept,
 * and the follower removes those without counting them, so a kept task's rows leave the host at
 * once instead of staying until the user confirms the removal in Settings. Every other removal
 * still counts: a leader that lost its store (nothing kept, nothing named) is refused as before.
 * The real leader round against the real follower side (tests/helpers/replica-kind-harness.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildKindManifest, runKindRound, StepFailed, type LeaderKind } from '../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import { hostManifest, hostPrivacyOf, LEFT_OUT_MAX, nothingKept, type HostPrivacy, type OwnedKind } from '../../../src/core/replication/host-private.js'
import { memFollower, memTarget, rowKind, type MemFollower, type Row } from '../../helpers/replica-kind-harness.js'

/** Each row belongs to the task of its own id. */
const KIND: LeaderKind<Row> & OwnedKind<Row> = { ...rowKind(), owners: (r) => [`task:${r.id}`] }
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r-${String(i).padStart(3, '0')}`, title: `acme ${i}` }))
const kept = (ids: string[]): HostPrivacy => hostPrivacyOf(ids.map((id) => ({ id, sync_hold: { state: 'private' } })), [])
let calls: Array<Record<string, unknown>> = []

async function round(f: MemFollower, leader: Row[], p: HostPrivacy) {
  const manifest = await hostManifest(KIND, await buildKindManifest(KIND, leader, async () => {}), p)
  try {
    return await runKindRound(KIND, manifest, memTarget('host:marina', f, { calls }))
  } catch (err) {
    if (err instanceof StepFailed) return { kind: KIND.kind, action: err.outcome, error: err.message }
    throw err
  }
}

beforeEach(() => {
  _resetReplicaStatusForTesting()
  calls = []
})

describe('rows of tasks made local leave a host at once, whatever their share', () => {
  it('30 of 50 rows kept: the follower removes them in the same round, and the sync named them', async () => {
    const f = memFollower({ floor: 50 })
    const all = rows(50)
    expect(await round(f, all, nothingKept())).toMatchObject({ action: 'synced', entries: 50 })
    const keptIds = all.slice(0, 30).map((r) => r.id)
    calls = []
    expect(await round(f, all, kept(keptIds))).toMatchObject({ action: 'synced', removed: 30 })
    expect(f.ids()).toEqual(all.slice(30).map((r) => r.id))
    expect(calls.find((c) => c.op === 'sync')?.leftOut).toEqual(keptIds)
  })

  it('every other removal still counts: kept rows plus a lost half are refused, and the follower keeps them all', async () => {
    const f = memFollower({ floor: 50 })
    const all = rows(50)
    await round(f, all, nothingKept())
    // 10 kept and 26 more gone: 26 of the 40 not explained is more than half.
    expect(await round(f, all.slice(26), kept(all.slice(26, 36).map((r) => r.id)))).toMatchObject({
      action: 'failed', error: 'manifest_removes_most_rows',
    })
    expect(f.ids().length).toBe(50)
  })

  it('a leader that lost its store names nothing, so the half rule still holds', async () => {
    const f = memFollower({ floor: 50 })
    await round(f, rows(50), nothingKept())
    calls = []
    expect(await round(f, rows(5), nothingKept())).toMatchObject({ action: 'failed', error: 'manifest_removes_most_rows' })
    expect(calls.find((c) => c.op === 'sync')?.leftOut).toBeUndefined()
  })

  it('a follower refuses a malformed list, and the leader names none past the cap', async () => {
    const f = memFollower({ floor: 50 })
    await round(f, rows(3), nothingKept())
    const step = (leftOut: unknown) => f.handler.step('sync', { kind: KIND.kind, schemaVersion: 1, entries: [], asOf: 1, leftOut })
    expect(await step([1, 2])).toMatchObject({ ok: false, error: 'bad_left_out' })
    expect(await step('r-000')).toMatchObject({ ok: false, error: 'bad_left_out' })
    expect(LEFT_OUT_MAX).toBeGreaterThan(1_000)
  })
})
