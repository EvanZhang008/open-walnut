/**
 * Voice Accuracy scores a take the way the 2026-11-21 benchmark did (score.py):
 * a Chinese character or a Latin word is one unit, punctuation and the judge's
 * unsure marks are not. The expected numbers below were computed with the
 * benchmark's own Python on the same strings. The summary compares engines
 * only over the takes they all have.
 */
import { describe, expect, it } from 'vitest'
import { countTerm, lev, scoreText, termsSpoken, tokens, wordDiff } from '../../src/core/stt/compare/score.js'
import { BEST_MARGIN, summarize, trendOf } from '../../src/core/stt/compare/summary.js'
import type { CompareTake, TakeScore } from '../../src/core/stt/compare/types.js'

// A mixed Chinese/English dictation (test data as escapes).
const REF = '\u6211\u4eec\u4eca\u5929\u628a deployment \u63a8\u5230 [?staging] \u73af\u5883\uff0c\u7136\u540e check \u4e00\u4e0b pod \u7684\u72b6\u6001\u3002Don\'t wait.'
const HYP = '\u6211\u4eec\u4eca\u5929\u628adeploy meant\u63a8\u5230 staging \u73af\u5883\u7136\u540e\uff0ccheck\u4e00\u4e0b pot \u7684\u72b6\u6001 dont wait'

describe('score', () => {
  it('tokenizes as the benchmark: one unit per Chinese character and per Latin word, marks ignored', () => {
    const keys = tokens(REF).map((t) => t.key)
    expect(keys).toHaveLength(22)
    expect(keys).toContain('staging')
    expect(keys).toContain("don't")
    expect(keys.filter((k) => /[\u4e00-\u9fff]/.test(k))).toHaveLength(16)
  })

  it('matches the benchmark\'s mixed, CJK and Latin edits', async () => {
    const s = await scoreText(HYP, REF)
    expect(s).toMatchObject({ edits: 4, n: 22, cjkEdits: 0, cjkN: 16, latEdits: 4, latN: 6 })
  })

  it('edit distance basics', async () => {
    expect(await lev([], ['a', 'b'])).toBe(2)
    expect(await lev(['a', 'b', 'c'], ['a', 'c'])).toBe(1)
    expect(await lev(['k', 'i', 't'], ['s', 'i', 't'])).toBe(1)
  })

  it('counts a term only where it is written the same way (any case), on word edges', () => {
    expect(countTerm('Open Walnut and open  walnut, not OpenWalnut', 'open walnut')).toBe(2)
    expect(countTerm('podcast pod Pod', 'pod')).toBe(2)
  })

  it('lists the terms spoken in a reference once per span, longest first', () => {
    expect(termsSpoken('Claude Code runs; Claude reads. claude code again', ['Claude', 'Claude Code'])).toEqual(['Claude Code', 'Claude Code', 'Claude'])
  })

  it('scores term hits up to the times the reference says them', async () => {
    const s = await scoreText('pod pod pod deploy', 'pod deployment pod', ['pod', 'pod', 'deployment'])
    expect(s.termsNeed).toBe(3)
    expect(s.termsHit).toBe(2)
  })
})

describe('wordDiff', () => {
  it('gives the engine text back exactly and marks what differs', async () => {
    const segments = await wordDiff(HYP, REF)
    expect(segments.map((s) => s.text).join('')).toBe(HYP)
    const changed = segments.filter((s) => s.op !== 'same')
    expect(changed.length).toBeGreaterThan(0)
    expect(segments.some((s) => s.op === 'changed' && s.text.includes('pot') && s.ref === 'pod')).toBe(true)
  })

  it('marks reference words the engine left out as missing', async () => {
    const segments = await wordDiff('hello world', 'hello big world')
    expect(segments).toEqual([
      { op: 'same', text: 'hello ' },
      { op: 'missing', text: '', ref: 'big' },
      { op: 'same', text: 'world' },
    ])
  })
})

const score = (edits: number, n = 100): TakeScore => ({ edits, n, cjkEdits: 0, cjkN: 0, latEdits: edits, latN: n, termsHit: 1, termsNeed: 2 })
function take(id: string, at: string, scores: Record<string, TakeScore>): CompareTake {
  return {
    id, source: 'web', at, format: 'webm', audioRef: { kind: 'recording', id: id.slice(4) },
    results: Object.fromEntries(Object.keys(scores).map((e) => [e, { text: 'x', ms: 1000, at }])),
    reference: { text: 'x', judge: 'judge-model', at }, scores,
  }
}

describe('summarize', () => {
  const takes = [
    take('rec-a', '2026-11-20T10:00:00.000Z', { 'in-use': score(10), whisper: score(20) }),
    take('rec-b', '2026-11-21T10:00:00.000Z', { 'in-use': score(30), whisper: score(10) }),
    // Only one engine on this one: it is not shared, so it counts for neither.
    take('rec-c', '2026-11-21T11:00:00.000Z', { 'in-use': score(0) }),
  ]

  it('compares only over the takes every shown engine has', () => {
    const s = summarize(takes)
    expect(s.sharedTakes).toBe(2)
    const inUse = s.engines.find((e) => e.id === 'in-use')!
    expect(inUse.mixed).toBeCloseTo(40 / 200)
    expect(inUse.takes).toBe(2)
    expect(inUse.scoredTakes).toBe(3)
    expect(inUse.terms).toBeCloseTo(0.5)
    expect(inUse.medianMs).toBe(1000)
    // Tied at 20% and 15%: whisper is lower by 5 points, so it is marked.
    expect(s.best).toBe('whisper')
  })

  it('marks no best when the lead is under half a point', () => {
    const close = [take('rec-x', '2026-11-21T10:00:00.000Z', { a: score(100, 1000), b: score(100 + BEST_MARGIN * 1000 - 1, 1000) })]
    expect(summarize(close).best).toBeUndefined()
  })

  it('groups the shared takes by local day, newest first', () => {
    const s = summarize(takes)
    expect(s.byDay.map((d) => d.takes)).toEqual([1, 1])
    expect(s.byDay[0]!.day > s.byDay[1]!.day).toBe(true)
  })
})

describe('trend', () => {
  // Local noon, so the local day is the one named whatever the machine's zone.
  const at = (d: number, h = 12) => new Date(2026, 10, d, h).toISOString()
  const timed = (t: CompareTake, ms: Record<string, number>) => {
    for (const [e, v] of Object.entries(ms)) t.results[e]!.ms = v
    return t
  }
  const takes = [
    timed(take('rec-1', at(21), { 'in-use': score(30), whisper: score(10) }), { 'in-use': 400, whisper: 3000 }),
    // Later the same day, the in-use engine alone: the trend counts it (the shared table would not).
    timed(take('rec-2', at(21, 15), { 'in-use': score(10) }), { 'in-use': 800 }),
    take('rec-3', at(20), { 'in-use': score(5) }),
    // No judge yet: no scores, so no point.
    { ...take('rec-4', at(22), {}), scores: undefined },
  ]

  it('is one entry per local day, oldest first, each engine over every take it scored that day', () => {
    const s = summarize(takes)
    expect(s.trend.map((d) => d.day)).toEqual(['2026-11-20', '2026-11-21'])
    const [first, second] = s.trend
    // Whisper ran only on the 21st: no point on the 20th.
    expect(Object.keys(first!.engines)).toEqual(['in-use'])
    expect(first!.engines['in-use']).toMatchObject({ takes: 1, mixed: 0.05, medianMs: 1000 })
    expect(second!.engines['in-use']).toMatchObject({ takes: 2, medianMs: 600 })
    expect(second!.engines['in-use']!.mixed).toBeCloseTo(40 / 200)
    expect(second!.engines['in-use']!.latin).toBeCloseTo(40 / 200)
    expect(second!.engines['in-use']!.cjk).toBeNull()
    expect(second!.engines.whisper).toMatchObject({ takes: 1, mixed: 0.1, medianMs: 3000 })
    // The side-by-side table still counts only the one shared take.
    expect(s.sharedTakes).toBe(1)
    expect(s.byDay.map((d) => d.takes)).toEqual([1])
  })

  it('keeps to the engines shown and leaves out a take with no day', () => {
    const odd = take('rec-x', 'not a time', { 'in-use': score(1) })
    const trend = trendOf([...takes, odd], ['whisper'])
    expect(trend.map((d) => d.day)).toEqual(['2026-11-21'])
    expect(Object.keys(trend[0]!.engines)).toEqual(['whisper'])
    expect(trendOf(takes, [])).toEqual([])
  })
})
