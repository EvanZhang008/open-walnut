/**
 * "Did you mean" hints on an unknown op argument key (src/ops/arg-hints.ts,
 * used by parseOpArgs in src/ops/executor.ts).
 *
 * An agent calling `search` with `query` used to read only
 * `Unrecognized key: "query"` and had to fetch the op's help to learn the key is
 * `q`. The hint names the intended key when it is clear (a one or two character
 * typo, or the only missing required key next to the only unknown one) and stays
 * silent otherwise. The call is still refused; nothing is rewritten.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getOp, parseOpArgs } from '../../../src/ops/index.js'
import { editDistance } from '../../../src/ops/arg-hints.js'
import type { WalnutOp } from '../../../src/ops/registry.js'

const op = (name: string) => getOp(name)!
const fakeOp = (input: Record<string, z.ZodTypeAny>) => ({ name: 'fake_op', input }) as unknown as WalnutOp

function refusal(o: WalnutOp, args: Record<string, unknown>): string {
  const r = parseOpArgs(o, args)
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.message
}

describe('a typo of a declared key', () => {
  it('names the key one swap away', () => {
    expect(refusal(op('task_update'), { id: 't1', titel: 'Rename' }))
      .toBe('Invalid arguments for task_update: (root): Unrecognized key: "titel"; did you mean "title"?')
  })

  it('names the key one or two edits away', () => {
    expect(refusal(op('task_update'), { id: 't1', phse: 'TODO' })).toContain('Unrecognized key: "phse"; did you mean "phase"?')
    expect(refusal(op('search'), { q: 'x', limt: 5 })).toContain('; did you mean "limit"?')
    expect(refusal(op('task_update'), { id: 't1', descrption: 'x' })).toContain('; did you mean "description"?')
    expect(refusal(op('task_update'), { id: 't1', descriptoin_: 'x' })).toContain('; did you mean "description"?')
  })

  it('a case-only difference is a typo, and wins over a missing required key', () => {
    expect(refusal(op('search'), { q: 'x', Limit: 5 })).toContain('Unrecognized key: "Limit"; did you mean "limit"?')
    const msg = refusal(op('search'), { Limit: 5 })
    expect(msg).toContain('Unrecognized key: "Limit"; did you mean "limit"?')
    expect(msg).not.toContain('did you mean "q"')
    expect(refusal(fakeOp({ task_id: z.string().optional() }), { taskID: 't1' })).toContain('; did you mean "task_id"?')
  })

  it('hints in a nested object, through optional wrappers', () => {
    const o = fakeOp({ meta: z.object({ name: z.string().optional() }).strict().optional() })
    expect(refusal(o, { meta: { nmae: 'x' } })).toContain('meta: Unrecognized key: "nmae"; did you mean "name"?')
  })

  it('hints inside a list item at that item\'s path', () => {
    expect(refusal(op('task_update_bulk'), { updates: [{ id: 't1', titel: 'x' }] }))
      .toContain('updates.0: Unrecognized key: "titel"; did you mean "title"?')
  })

  it('never rewrites the call', () => {
    const raw = { id: 't1', titel: 'Rename' }
    expect(parseOpArgs(op('task_update'), raw).ok).toBe(false)
    expect(raw).toEqual({ id: 't1', titel: 'Rename' })
  })
})

describe('one missing required key next to one unknown key', () => {
  it('search called with query instead of q', () => {
    const msg = refusal(op('search'), { query: 'deploy failures' })
    expect(msg).toContain('(root): Unrecognized key: "query"; did you mean "q"?')
    // The missing key is still reported as its own issue.
    expect(msg).toContain('q: ')
  })

  it('works with a typo too far to match by spelling', () => {
    expect(refusal(op('task_get'), { task_id: 't1' })).toContain('Unrecognized key: "task_id"; did you mean "id"?')
  })
})

describe('no guess when the intended key is not clear', () => {
  it('several unknown keys and one missing required key', () => {
    const msg = refusal(op('search'), { query: 'x', text: 'y' })
    expect(msg).toContain('Unrecognized keys: "query", "text"')
    expect(msg).not.toContain('did you mean')
  })

  it('an unrelated key when nothing required is missing', () => {
    expect(refusal(op('search'), { q: 'x', banana: 1 })).not.toContain('did you mean')
    expect(refusal(op('task_get'), { id: 't1', wait_report: 'x' })).not.toContain('did you mean')
  })

  it('a one-letter key is no typo of another one-letter key', () => {
    expect(refusal(fakeOp({ q: z.string().optional() }), { x: 'a' })).not.toContain('did you mean')
  })

  it('two declared keys equally close', () => {
    expect(refusal(fakeOp({ cat: z.string().optional(), car: z.string().optional() }), { cax: 'a' })).not.toContain('did you mean')
  })

  it('two unknown keys aimed at the same declared key', () => {
    const msg = refusal(fakeOp({ title: z.string().optional() }), { titel: 'a', tilte: 'b' })
    expect(msg).not.toContain('did you mean')
  })

  it('a key the call already set is not offered again, nor is the runner-up', () => {
    expect(refusal(op('task_update'), { id: 't1', title: 'a', titel: 'b' })).not.toContain('did you mean')
    const o = fakeOp({ title: z.string().optional(), tile: z.string().optional() })
    expect(refusal(o, { title: 'a', titel: 'b' })).not.toContain('did you mean')
  })

  it('a tied near miss is not read as a stand-in for the missing required key', () => {
    const o = fakeOp({ cat: z.string().optional(), car: z.string().optional(), name: z.string() })
    expect(refusal(o, { cax: 'a' })).not.toContain('did you mean')
  })

  it('a key that is a near miss of a set key is not read as a stand-in either', () => {
    const o = fakeOp({ title: z.string().optional(), name: z.string() })
    expect(refusal(o, { title: 'a', titel: 'b' })).not.toContain('did you mean')
  })

  it('a schema it cannot walk (union) gets no hint and no crash', () => {
    const o = fakeOp({ v: z.union([z.object({ a: z.string() }).strict(), z.string()]) })
    expect(refusal(o, { v: { b: 'x' } })).not.toContain('did you mean')
    expect(parseOpArgs(op('search'), ['q'] as unknown as Record<string, unknown>).ok).toBe(false)
    expect(parseOpArgs(op('task_update_bulk'), { updates: [null, { id: 't1', titel: 'x' }] }).ok).toBe(false)
  })
})

describe('several unknown keys, each judged on its own', () => {
  it('hints the typo and leaves the unrelated key alone', () => {
    expect(refusal(op('task_update'), { id: 't1', titel: 'x', banana: 1 }))
      .toContain('Unrecognized keys: "titel", "banana"; did you mean "title" for "titel"?')
  })
})

describe('retired fields are still dropped, never hinted or counted', () => {
  it('a retired field next to a typo', () => {
    const msg = refusal(op('task_update'), { id: 't1', wait_report: 'x', titel: 'y' })
    expect(msg).toBe('Invalid arguments for task_update: (root): Unrecognized key: "titel"; did you mean "title"?')
  })

  it('a retired field does not count as a second unknown key', () => {
    expect(refusal(op('task_update'), { task_id: 't1', wait_report: 'x' })).toContain('Unrecognized key: "task_id"; did you mean "id"?')
  })

  it('a call with only a retired extra still passes', () => {
    // task_update carries wait_report's text into waiting_on (renamedInput); trigger_create drops it.
    expect(parseOpArgs(op('task_update'), { id: 't1', wait_report: 'x' })).toEqual({ ok: true, args: { id: 't1', waiting_on: 'x' } })
  })
})

describe('editDistance', () => {
  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('titel', 'title')).toBe(1)
    expect(editDistance('query', 'q')).toBe(4)
    expect(editDistance('', 'ab')).toBe(2)
    expect(editDistance('same', 'same')).toBe(0)
  })
})
