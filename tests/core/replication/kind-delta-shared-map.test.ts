/**
 * A replication round notes what each target took (kind-delta.ts noteTaken) as a key -> hash map of
 * the manifest. 2026-11-25: that map (about 8,000 rows, about 1 MB) was built again for every
 * target on every round, some 200 of them every 5 minutes on the live server. One manifest object
 * is one map, shared by every target that takes it.
 */
import { describe, expect, it } from 'vitest'
import { _entryMapBuildsForTesting, manifestDigest, runDeltaRound, type DeltaKind } from '../../../src/core/replication/kind-delta.js'
import type { KindManifest } from '../../../src/core/replication/kind-leader.js'
import type { KindState } from '../../../src/core/replication/replica-status.js'

type Row = { id: string; v: number }

const KIND: DeltaKind<Row> = {
  kind: 'rows', schemaVersion: 1, ordered: false, digest: true,
  key: (r) => r.id,
  hash: (r) => `h${r.v}`,
}

function manifestOf(rows: Row[], hash: string): KindManifest<Row> {
  return { entries: rows.map((r) => ({ k: r.id, h: KIND.hash(r) })), hash, byKey: new Map(rows.map((r) => [r.id, r])) }
}

const freshState = (): KindState => ({ kind: KIND.kind, manifest: null, restUntil: 0, refusals: 0, confirmNext: false })

/** A follower that holds what the leader sends: every step answers the manifest's digest. */
const follower = (manifest: KindManifest<Row>) => ({
  id: 'target', post: async () => ({ ok: true as const, reply: { ok: true, digest: manifestDigest(manifest), stored: 1, held: 0 } }),
})

const ROWS = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, v: 0 }))

describe('the delta round builds one key -> hash map per manifest, whatever the number of targets', () => {
  it('an unchanged round over several targets builds it once', async () => {
    const manifest = manifestOf(ROWS, 'm1')
    const states = Array.from({ length: 6 }, freshState)
    const before = _entryMapBuildsForTesting()
    for (const st of states) {
      const r = await runDeltaRound(KIND, manifest, follower(manifest), st, { asOf: 1, now: () => 1 })
      expect(r?.action).toBe('unchanged')
    }
    expect(_entryMapBuildsForTesting() - before).toBe(1)
  })

  it('a delta round (one row changed) over several targets builds it once, and each target still sends its delta', async () => {
    const first = manifestOf(ROWS, 'm1')
    const states = Array.from({ length: 6 }, freshState)
    for (const st of states) await runDeltaRound(KIND, first, follower(first), st, { asOf: 1, now: () => 1 })
    const next = manifestOf(ROWS.map((r, i) => (i === 7 ? { ...r, v: 1 } : r)), 'm2')
    const before = _entryMapBuildsForTesting()
    for (const st of states) {
      const r = await runDeltaRound(KIND, next, follower(next), st, { asOf: 2, now: () => 2 })
      expect(r).toMatchObject({ action: 'synced', sent: 1 })
      expect(st.manifest).toBe('m2')
    }
    expect(_entryMapBuildsForTesting() - before).toBe(1)
    // The shared map is the new manifest's: a third round with nothing changed sends nothing.
    for (const st of states) expect((await runDeltaRound(KIND, manifestOf(next.entries.map((e) => ({ id: e.k, v: e.h === 'h1' ? 1 : 0 })), 'm3'), follower(next), st, { asOf: 3, now: () => 3 }))?.action).toBe('unchanged')
  })
})
