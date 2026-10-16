/**
 * The drain's text merge runs off the server's event loop (src/core/offline-merge/
 * text-merge.ts mergeTextOffLoop): a worker thread with a deadline. A long text both
 * sides rewrote (12,000 lines, about 14 s per diff on the loop) never holds the loop
 * for more than a timer tick, and runs out into the over-budget row: one conflict over the
 * whole text, the newer side kept by the times alone.
 * A worker merge answers exactly what the inline merge answers.
 */
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { mergeText, mergeTextOffLoop, TEXT_MERGE_DEADLINE_MS, TEXT_MERGE_INLINE_MAX } from '../../../src/core/offline-merge/text-merge.js'
import { resolveTaskFields, premergeTexts } from '../../../src/core/offline-merge/task-fields.js'

const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${'x'.repeat(8)}\n`).join('')

/** The longest gap between two 10 ms timer ticks while `run` is pending. */
async function maxLoopGap<T>(run: () => Promise<T>): Promise<{ value: T; gapMs: number }> {
  let last = performance.now()
  let gap = 0
  const probe = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 10)
  try {
    const value = await run()
    return { value, gapMs: Math.max(gap, performance.now() - last) }
  } finally {
    clearInterval(probe)
  }
}

describe('text merge off the event loop', () => {
  it('a 12,000-line both-sides rewrite never holds the loop over 100 ms; after the deadline the newer side is kept', async () => {
    const base = lines(12_000, 'base')
    const mac = lines(12_000, 'mac')
    const away = lines(12_000, 'away')
    const started = Date.now()
    const { value, gapMs } = await maxLoopGap(() => mergeTextOffLoop(base, mac, away))
    expect(value).toEqual({ clean: false, conflicts: 1, overBudget: true, timedOut: true })
    expect(gapMs).toBeLessThan(100)
    expect(Date.now() - started).toBeLessThan(TEXT_MERGE_DEADLINE_MS + 2_000)
    // The resolver turns that answer into the over-budget row (section 6): one conflict over
    // the whole text, the newer side kept, by the times alone (never the machine's speed).
    const fields = { description: { base, value: away } }
    const macAt = Date.parse('2031-01-01T00:00:00.000Z')
    const task = { description: mac, updated_at: new Date(macAt).toISOString() }
    const textMerges = { description: { base, mac, replica: away, result: value } }
    const newer = resolveTaskFields({ mac: task, fields, at: macAt + 1, textMerges })
    expect(newer.patch).toEqual({ description: away })
    expect(newer.conflicts).toMatchObject([{ field: 'description', kept: 'replica', why: 'text-conflict', overBudget: true }])
    const older = resolveTaskFields({ mac: task, fields, at: macAt - 1, textMerges })
    expect(older.patch).toEqual({})
    expect(older.conflicts).toMatchObject([{ field: 'description', kept: 'mac', why: 'text-conflict', overBudget: true }])
    // The inline over-budget answer (the diff gave up) is judged the same way.
    const gaveUp = { description: { base, mac, replica: away, result: { clean: false as const, conflicts: 1, overBudget: true } } }
    expect(resolveTaskFields({ mac: task, fields, at: macAt + 1, textMerges: gaveUp }).patch)
      .toEqual(resolveTaskFields({ mac: task, fields, at: macAt + 1, textMerges }).patch)
  }, 20_000)

  it('a worker merge answers exactly what the inline merge does (clean, and with a conflict)', async () => {
    const base = lines(2_000, 'base')
    expect(base.length).toBeGreaterThan(TEXT_MERGE_INLINE_MAX)
    const edit = (text: string, at: number, line: string): string => {
      const parts = text.split('\n')
      parts[at] = line
      return parts.join('\n')
    }
    const mac = edit(base, 10, 'mac changed line 10')
    const away = edit(base, 1_500, 'away changed line 1500')
    const clean = await mergeTextOffLoop(base, mac, away)
    expect(clean).toEqual(mergeText(base, mac, away))
    expect(clean.clean).toBe(true)
    const clash = await mergeTextOffLoop(base, mac, edit(base, 10, 'away changed line 10'))
    expect(clash).toEqual(mergeText(base, mac, edit(base, 10, 'away changed line 10')))
    expect(clash.clean).toBe(false)
  }, 20_000)

  it('the resolver never merges when the merges were made beforehand: a moved Mac text is named stale', async () => {
    const base = 'one\ntwo\nthree\n'
    const fields = { description: { base, value: 'one\ntwo\nthree\nfour\n' } }
    const textMerges = await premergeTexts({ description: 'zero\none\ntwo\nthree\n' }, fields)
    // The Mac's text moved again after the merge was made: resolved again, never merged here.
    const r = resolveTaskFields({ mac: { description: 'zero\none\ntwo\nthree\nand more\n' }, fields, at: Date.now(), textMerges })
    expect(r.staleText).toEqual(['description'])
    expect(r.patch).toEqual({})
    const ok = resolveTaskFields({ mac: { description: 'zero\none\ntwo\nthree\n' }, fields, at: Date.now(), textMerges })
    expect(ok.patch).toEqual({ description: 'zero\none\ntwo\nthree\nfour\n' })
  })
})
