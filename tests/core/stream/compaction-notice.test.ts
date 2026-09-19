/**
 * "ONE compaction is ONE row" — the rule itself.
 *
 * Reported 2026-09-18: five identical "Compacting context..." lines stacked above
 * one "Context compacted 444K tokens", collapsed behind an opaque "6 system
 * messages", and the lone number read like a percentage.
 *
 * Two sources of repeats, both real and both pinned here:
 *   - the CLI re-emits `status: compacting` every 30s as a TRANSPORT KEEP-ALIVE
 *     for the whole compaction (measured 147-539s per auto-compaction on this
 *     machine, so up to ~18 lines);
 *   - a daemon reattach replays the stream tail, and system lines carry no dedup
 *     key of their own.
 */
import { describe, it, expect } from 'vitest'
import {
  COMPACTED_MESSAGE,
  COMPACTING_MESSAGE,
  compactedDetail,
  compactedHistoryText,
  firstSightingOfLine,
  placeSystemRow,
  type SystemRow,
  type TimelineRow,
} from '../../../src/core/stream/compaction-notice.js'

const progress: SystemRow = { variant: 'compact', message: COMPACTING_MESSAGE, progress: true }
const outcome = (detail?: string): SystemRow => ({
  variant: 'compact', message: COMPACTED_MESSAGE, ...(detail ? { detail } : {}),
})
/** A model-text block. The rule only reads `variant`, which text never has — that
 *  absence is what lets both twins pass their whole timeline in. */
const text = (_content: string): TimelineRow => ({ type: 'text' })

describe('compactedDetail: the numbers say what they are', () => {
  it('shows both ends, so nobody reads the number as a percentage', () => {
    expect(compactedDetail({ preTokens: 444_000, postTokens: 45_000, trigger: 'auto' }))
      .toBe('444K → 45K tokens · auto')
  })

  it('a manual /compact carries no trigger label (the user typed it)', () => {
    expect(compactedDetail({ preTokens: 287_603, postTokens: 17_789, trigger: 'manual' }))
      .toBe('288K → 18K tokens')
  })

  it('falls back to the one end it knows', () => {
    expect(compactedDetail({ preTokens: 411_000, trigger: 'auto' })).toBe('411K tokens · auto')
    expect(compactedDetail({ postTokens: 45_000 })).toBe('down to 45K tokens')
  })

  it('sub-1K counts stay exact rather than rounding to 0K', () => {
    expect(compactedDetail({ preTokens: 900, postTokens: 120 })).toBe('900 → 120 tokens')
  })

  it('no metadata at all still yields a usable row', () => {
    expect(compactedDetail(undefined)).toBeUndefined()
    expect(compactedDetail({})).toBeUndefined()
    expect(compactedDetail({ trigger: 'auto' })).toBe('auto')
    // 0 is "unknown", the shape the CLI uses when it never counted.
    expect(compactedDetail({ preTokens: 0, postTokens: 0 })).toBeUndefined()
  })

  it('history text reads like the live row (trigger outside the parens)', () => {
    expect(compactedHistoryText({ preTokens: 444_000, postTokens: 45_000, trigger: 'auto' }))
      .toBe('Context compacted (444K → 45K tokens) · auto')
    expect(compactedHistoryText(undefined)).toBe('Context compacted')
  })
})

describe('firstSightingOfLine: the replay guard system lines never had', () => {
  it('is true once per uuid', () => {
    const seen = new Set<string>()
    expect(firstSightingOfLine(seen, 'u1')).toBe(true)
    expect(firstSightingOfLine(seen, 'u1')).toBe(false)
    expect(firstSightingOfLine(seen, 'u2')).toBe(true)
  })

  it('an untrackable line (no uuid) always counts as new', () => {
    const seen = new Set<string>()
    for (const bad of [undefined, null, '', 42, {}]) {
      expect(firstSightingOfLine(seen, bad)).toBe(true)
    }
    expect(seen.size).toBe(0)
  })

  it('stays bounded, evicting oldest first — a session compacts dozens of times', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 700; i++) firstSightingOfLine(seen, `u${i}`)
    expect(seen.size).toBeLessThanOrEqual(500)
    expect(seen.has('u699')).toBe(true)   // newest kept
    expect(seen.has('u0')).toBe(false)    // oldest evicted
  })
})

describe('placeSystemRow: the keep-alive collapses, the boundary lands in place', () => {
  it('the first progress notice appends', () => {
    expect(placeSystemRow([], progress)).toEqual({ action: 'append' })
  })

  it('every later keep-alive drops — one compaction, one row', () => {
    const rows: TimelineRow[] = [progress]
    for (let i = 0; i < 17; i++) {
      expect(placeSystemRow(rows, progress)).toEqual({ action: 'drop' })
    }
    expect(rows).toHaveLength(1)
  })

  it('the boundary REPLACES the placeholder, at the placeholder position', () => {
    const rows: TimelineRow[] = [text('before'), progress, text('after')]
    expect(placeSystemRow(rows, outcome('444K → 45K tokens · auto')))
      .toEqual({ action: 'replace', index: 1 })
  })

  it('a boundary with no placeholder appends (manual /compact never announces)', () => {
    expect(placeSystemRow([text('hi')], outcome('287K → 18K tokens'))).toEqual({ action: 'append' })
  })

  it('a replayed boundary drops instead of stacking its own twin', () => {
    const landed = outcome('444K → 45K tokens · auto')
    expect(placeSystemRow([text('hi'), landed], landed)).toEqual({ action: 'drop' })
  })

  it('a replayed STATUS line drops too — its compaction already finished', () => {
    // A reattach replays [status, boundary] in order. The boundary consumed the
    // placeholder on the first pass, so the replayed status has nothing to
    // announce; without this it re-opened a fresh "Compacting context..." row
    // BELOW the outcome, which reads as a second compaction that never happened.
    const rows: TimelineRow[] = [text('hi'), outcome('444K → 45K tokens · auto')]
    expect(placeSystemRow(rows, progress)).toEqual({ action: 'drop' })
  })

  it('a SECOND real compaction starts its own row', () => {
    // Two compactions always have the model's continuation between them, and
    // never the same token counts — both signals point the same way.
    const rows: TimelineRow[] = [outcome('444K → 45K tokens · auto'), text('continued')]
    expect(placeSystemRow(rows, progress)).toEqual({ action: 'append' })
    expect(placeSystemRow([...rows, progress], outcome('612K → 47K tokens · auto')))
      .toEqual({ action: 'replace', index: 2 })
  })

  it('a stale placeholder from a dead compaction is consumed by the NEXT boundary', () => {
    // The CLI died mid-compaction: the placeholder never got its boundary. The
    // next real one takes that row rather than leaving a permanent "Compacting…".
    const rows: TimelineRow[] = [progress, text('new turn')]
    expect(placeSystemRow(rows, outcome('500K → 40K tokens · auto')))
      .toEqual({ action: 'replace', index: 0 })
  })

  it('non-compaction notices NEVER collapse — two API errors are two facts', () => {
    const apiError: SystemRow = { variant: 'error', message: 'API error: ECONNRESET' }
    expect(placeSystemRow([apiError], apiError)).toEqual({ action: 'append' })
    const info: SystemRow = { variant: 'info', message: 'Upstream retry 1/3' }
    expect(placeSystemRow([info, info], info)).toEqual({ action: 'append' })
  })

  it('an unrelated notice between the placeholder and the boundary is preserved', () => {
    const rows: TimelineRow[] = [progress, { variant: 'error', message: 'API error: 529' }]
    expect(placeSystemRow(rows, outcome('700K → 50K tokens · auto')))
      .toEqual({ action: 'replace', index: 0 })
  })
})
