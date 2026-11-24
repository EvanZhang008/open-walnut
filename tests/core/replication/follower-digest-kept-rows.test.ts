/**
 * A follower's digest leaves out the rows it keeps that the leader does not name (kind-follower.ts
 * `unnamed`). 2026-11-24: a host kept 6 of its own sessions of tasks kept local, the leader's host
 * manifest left them out (host-private.ts hostManifest), the follower's digest counted them, so the
 * digests never matched and every round to that host sent the whole sessions manifest: 3,619 of
 * about 450 KB in one day, need 0 each time.
 *
 * The real leader round and delta shortcut against the real follower side
 * (tests/helpers/replica-kind-harness.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildKindManifest, runKindRound } from '../../../src/core/replication/kind-leader.js'
import { manifestDigest, runDeltaRound, noteManifestTaken, type DeltaKind } from '../../../src/core/replication/kind-delta.js'
import { kindState, _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import { memFollower, memTarget, rowKind, type Row } from '../../helpers/replica-kind-harness.js'

const KIND: DeltaKind<Row> = { ...rowKind(), ordered: true, digest: true }
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r-${i}`, title: `Acme ${i}` }))
const opts = { asOf: 1_000, now: () => 2_000 }

beforeEach(() => _resetReplicaStatusForTesting())

async function manifestRound(f: ReturnType<typeof memFollower>, leader: Row[]) {
  const target = memTarget('host:marina', f)
  const manifest = await buildKindManifest(KIND, leader, async () => {})
  const res = await runKindRound(KIND, manifest, target)
  noteManifestTaken(kindState(target, KIND.kind), manifest)
  return { target, manifest, res }
}

describe('a follower that keeps rows the leader does not name', () => {
  it('answers the leader\'s digest after one manifest round, so later rounds take the shortcut', async () => {
    const own = new Set(['own-1', 'own-2'])
    const f = memFollower({ digest: true, keptBy: (id) => own.has(id) })
    for (const id of own) { f.rows.set(id, { id, title: 'kept here' }); f.order.push(id) }
    const leader = rows(5)
    const { target, manifest, res } = await manifestRound(f, leader)
    expect(res).toMatchObject({ action: 'synced', removed: 0 })
    expect(f.ids()).toEqual(expect.arrayContaining([...own]))

    // Nothing changed, and the leader no longer trusts its last answer (a restart, the 5-minute
    // sweep): the status step matches.
    const st = kindState(target, KIND.kind)
    st.manifest = null
    const again = await runDeltaRound(KIND, await buildKindManifest(KIND, leader, async () => {}), target, st, opts)
    expect(again).toMatchObject({ action: 'unchanged' })

    // One row changed: the delta's put matches too, with no manifest.
    const next = leader.map((r) => (r.id === 'r-2' ? { ...r, title: 'Acme 2 renamed' } : r))
    const nextManifest = await buildKindManifest(KIND, next, async () => {})
    expect(await runDeltaRound(KIND, nextManifest, target, st, opts)).toMatchObject({ action: 'synced', sent: 1 })
    expect(manifestDigest(nextManifest, true)).not.toBe(manifestDigest(manifest, true))
  })

  it('a row kept only because the leader could not read it still counts, so its removal is seen', async () => {
    const f = memFollower({ digest: true })
    const leader = rows(5)
    await manifestRound(f, leader)
    const target = memTarget('host:marina', f)
    const st = kindState(target, KIND.kind)
    // r-4 unreadable this round: the leader names it in keep, the follower keeps its copy.
    const unread = await buildKindManifest(KIND, leader.slice(0, 4), async () => {})
    unread.keep = ['r-4']
    await runKindRound(KIND, unread, target)
    // r-4 is then removed on the leader: the shortcut must not end the round.
    const gone = await buildKindManifest(KIND, leader.slice(0, 4), async () => {})
    st.manifest = null
    expect(await runDeltaRound(KIND, gone, target, st, opts)).toBeNull()
    expect(await runKindRound(KIND, gone, target)).toMatchObject({ action: 'synced', removed: 1 })
    expect(f.ids()).not.toContain('r-4')
  })

  it('a kept row the leader names again counts in the digest once the leader sent it', async () => {
    const own = new Set(['r-4'])
    const f = memFollower({ digest: true, keptBy: (id) => own.has(id) })
    const leader = rows(5)
    await manifestRound(f, leader.slice(0, 4))
    // The host writes r-4 itself (its task is kept local, so the leader leaves it out).
    f.rows.set('r-4', { id: 'r-4', title: 'kept here' }); f.order.push('r-4')
    const { target } = await manifestRound(f, leader.slice(0, 4))
    const st = kindState(target, KIND.kind)
    // The task is shared again: the leader names r-4 and the delta puts it.
    own.clear()
    const named = await buildKindManifest(KIND, leader, async () => {})
    expect(await runDeltaRound(KIND, named, target, st, opts)).toMatchObject({ action: 'synced', sent: 1 })
    st.manifest = null
    expect(await runDeltaRound(KIND, named, target, st, opts)).toMatchObject({ action: 'unchanged' })
  })
})
