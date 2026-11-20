/**
 * applyTriggersDelta (trigger-check-core.ts, both daemon twins): the set a delta makes from the
 * held one, or null whenever it is not exactly the set the server named, so a daemon never arms a
 * set the server did not compile (triggers-delta-v1).
 */
import { describe, it, expect } from 'vitest'
import { applyTriggersDelta, triggerPushHash, TRIGGERS_DELTA_MAX } from '../../src/providers/trigger-check-core.js'

const d = (id: string, run = 'true') => ({ id, name: id, everyMs: 60_000, check: { run } })
const sorted = (defs: { id: string }[]) => [...defs].sort((a, b) => (a.id < b.id ? -1 : 1))

describe('applyTriggersDelta', () => {
  const held = sorted([d('a'), d('b'), d('c')])

  it('replaces, adds and drops, sorted by id, when the result is the named set', () => {
    const want = sorted([d('a', 'echo 1'), d('c'), d('d')])
    expect(applyTriggersDelta(held, { put: [d('d'), d('a', 'echo 1')], drop: ['b'] }, triggerPushHash(want))).toEqual(want)
  })

  it('keeps Unicode in a def byte-for-byte (the hash is over the wire JSON)', () => {
    const uni = { ...d('e'), name: 'Watch 你好 🚀' }
    const want = sorted([...held, uni])
    expect(applyTriggersDelta(held, { put: [uni], drop: [] }, triggerPushHash(want))).toEqual(want)
  })

  it('is null for a set other than the named one: a lost change, a wrong name, a stale base', () => {
    const want = sorted([d('a', 'echo 1'), d('b'), d('c')])
    expect(applyTriggersDelta(held, { put: [], drop: [] }, triggerPushHash(want))).toBeNull()
    expect(applyTriggersDelta(held, { put: [d('a', 'echo 1')], drop: [] }, 'not-the-hash')).toBeNull()
    expect(applyTriggersDelta(held.filter((x) => x.id !== 'b'), { put: [d('a', 'echo 1')], drop: [] }, triggerPushHash(want))).toBeNull()
  })

  it('is null for a malformed delta or held set', () => {
    const h = triggerPushHash(held)
    for (const bad of [null, 'x', {}, { put: [], drop: 'b' }, { put: {}, drop: [] }, { put: [{ name: 'no id' }], drop: [] }, { put: [], drop: [3] }]) {
      expect(applyTriggersDelta(held, bad, h), JSON.stringify(bad)).toBeNull()
    }
    expect(applyTriggersDelta([{ name: 'no id' }], { put: [], drop: [] }, h)).toBeNull()
    const many = Array.from({ length: TRIGGERS_DELTA_MAX + 1 }, (_, i) => `x${i}`)
    expect(applyTriggersDelta(held, { put: [], drop: many }, h)).toBeNull()
  })

  // Both sides compute this name: the server for the set it compiles, every daemon twin for the
  // set a delta made. A change to the function on one side alone would turn every delta into a
  // refused delta and a whole set; this fixed vector fails first.
  it('names a set by a fixed function of its wire JSON', () => {
    expect(triggerPushHash([])).toBe('4f53cda18c2baa0c')
    expect(triggerPushHash([d('a'), { ...d('b'), name: 'B \u{1F680} 1.5' }])).toBe('9153189826113b3d')
  })

  it('an empty delta onto the same name is the held set (another link pushed it already)', () => {
    expect(applyTriggersDelta(held, { put: [], drop: [] }, triggerPushHash(held))).toEqual(held)
  })
})
