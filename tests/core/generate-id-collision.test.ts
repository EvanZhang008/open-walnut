/**
 * `generateId()` is too narrow for bulk inserts, and the bulk insert hides it.
 *
 * generateId() (src/utils/format.ts) = `base36(Date.now())` + 2 random bytes. Ids
 * minted inside the same millisecond therefore differ only in 16 bits — 65536
 * values. A 50-row bulk create is a 50-draw birthday problem over that space:
 *
 *     P(at least one duplicate) = 1 - Π(i=0..49) (65536 - i)/65536 ≈ 1.85%
 *
 * On its own a rare duplicate id would be a caught error. The damage comes from
 * `addTasksBulk` using INSERT OR REPLACE: a collision SILENTLY OVERWRITES the
 * earlier row, so the batch reports success while quietly storing 49 of 50 rows.
 *
 * This is reachable in production, not just in tests: the plugin sync reconciler's
 * create path (src/core/sync-reconciler.ts) supplies no ids, so every row of a
 * full-reconcile batch relies on generateId(). A user syncing 50 remote items has
 * roughly a 1-in-54 chance of one going missing with no error anywhere.
 *
 * It was found because a test asserting an exact stored count of 50 turned ~2%
 * flaky. The fix is to widen the random part (or make the bulk path reject
 * duplicate ids instead of replacing) — both in src, tracked separately. This test
 * measures the collision rate directly so the fix has an objective target, and it
 * does NOT depend on chance: it drives the generator many times within a pinned
 * millisecond rather than hoping to observe a collision.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateId } from '../../src/utils/format.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('generateId collision space', () => {
  it('mints ids that collide within a single millisecond', () => {
    // Freeze the clock so every id shares the same timePart — exactly the
    // condition a bulk insert creates. Any collision must then come from the
    // 2-byte random tail.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'))

    // 1000 draws over 65536 values collide with probability ~99.95%, so this is
    // deterministic in practice without asserting on a specific random outcome.
    const ids = new Set<string>()
    let collisions = 0
    for (let i = 0; i < 1000; i++) {
      const id = generateId()
      if (ids.has(id)) collisions++
      ids.add(id)
    }

    // Documents the defect: same-millisecond ids are NOT unique.
    expect(
      collisions,
      'generateId produced no collisions in 1000 same-ms draws — if the random part was widened, ' +
        'delete this test and tighten the sync-reconciler cap test back to an exact count',
    ).toBeGreaterThan(0)
  })

  it('has a random part narrow enough to matter at realistic batch sizes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'))

    const id = generateId()
    const randPart = id.split('-')[1]

    // 4 hex chars = 2 bytes = 65536 values. Asserting the WIDTH (rather than a
    // collision probability) is what actually pins the risk: widen this and the
    // birthday math for a 50-row batch drops from 1.85% to negligible.
    expect(randPart).toMatch(/^[0-9a-f]{4}$/)
    expect(
      randPart.length,
      'random part widened — good. Update the birthday math in the header, re-tighten ' +
        'tests/core/sync-reconciler.test.ts "caps creates at 50" to toHaveLength(50), and delete this assertion.',
    ).toBe(4)
  })
})
