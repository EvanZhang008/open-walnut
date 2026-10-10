/**
 * Transcript clipping for the phone's slim tail, once replies can be HTML.
 *
 * The blind `slice(0, 4000)` this replaced cut wherever the 4000th character
 * landed. On a rich reply that is routinely mid-attribute or inside a `<style>`
 * body, and the phone now RENDERS that text: half a tag becomes an empty box and
 * the rest of the attribute becomes visible prose (the same defect
 * splitPendingMarkup exists for, inc-1788209680147), while a cut `<style>` body
 * prints CSS as a paragraph.
 *
 * Would-fail-if-reverted: go back to a plain slice and the "never ends inside a
 * tag" cases below fail; drop the rich budget and a 6KB card comes back clipped.
 */
import { describe, it, expect } from 'vitest'
import {
  clipTranscriptText, TRANSCRIPT_TEXT_MAX, TRANSCRIPT_RICH_TEXT_MAX,
  TRANSCRIPT_LIVE_TEXT_MAX, TRANSCRIPT_LIVE_RICH_TEXT_MAX,
} from '../../src/core/sessions/transcript-clip.js'

describe('clipTranscriptText', () => {
  it('leaves anything within the prose budget byte-identical', () => {
    const text = 'a'.repeat(TRANSCRIPT_TEXT_MAX)
    expect(clipTranscriptText(text)).toBe(text)
  })

  it('clips plain prose at the prose budget', () => {
    const text = 'a'.repeat(TRANSCRIPT_TEXT_MAX + 500)
    const clipped = clipTranscriptText(text)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped.length).toBe(TRANSCRIPT_TEXT_MAX + 1)
  })

  it('gives an HTML-bearing reply the larger budget, so a real card survives whole', () => {
    // A card the size models actually write: a style block, some markup, filler
    // prose — well past the prose budget, well inside the rich one.
    const card = `<style>.c{color:var(--fg)}</style>\n<div class="c">${'word '.repeat(1200)}</div>`
    expect(card.length).toBeGreaterThan(TRANSCRIPT_TEXT_MAX)
    expect(card.length).toBeLessThan(TRANSCRIPT_RICH_TEXT_MAX)
    expect(clipTranscriptText(card)).toBe(card)
  })

  it('never ends inside a tag', () => {
    // Pad so the budget lands in the middle of the attribute.
    const filler = `<p>${'x'.repeat(TRANSCRIPT_RICH_TEXT_MAX - 40)}</p>`
    const text = `${filler}<div style="border-left:3px solid #dc2626;padding:8px">tail</div>`
    const clipped = clipTranscriptText(text)
    expect(clipped.endsWith('…')).toBe(true)
    // The unfinished `<div style="…` is gone rather than half-rendered.
    expect(clipped).not.toContain('padding:8')
    expect(clipped.slice(0, -1).endsWith('</p>')).toBe(true)
  })

  it('never ends inside a <style> body (CSS as prose is the worst outcome)', () => {
    const head = `<p>${'y'.repeat(TRANSCRIPT_RICH_TEXT_MAX - 30)}</p>`
    const text = `${head}<style>.card{background:var(--bg-secondary);color:var(--fg)}</style>`
    const clipped = clipTranscriptText(text)
    expect(clipped).not.toContain('background:var(--bg-secondary)')
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('an element left OPEN by the cut is kept — every parser closes it at end of document', () => {
    const text = `<div class="card">${'z'.repeat(TRANSCRIPT_RICH_TEXT_MAX)}</div>`
    const clipped = clipTranscriptText(text)
    expect(clipped.startsWith('<div class="card">')).toBe(true)
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('a text that is nothing but one oversized unfinished construct degrades to the ellipsis', () => {
    const text = `<style>${'.a{color:red}'.repeat(2000)}`
    expect(clipTranscriptText(text)).toBe('…')
  })

  it('a `<` in prose does not count as markup for the budget', () => {
    // "a < b" and a generic parameter must not buy prose the rich budget.
    const text = `if a < b and Vec<u8> then ${'p'.repeat(TRANSCRIPT_TEXT_MAX)}`
    expect(clipTranscriptText(text).length).toBe(TRANSCRIPT_TEXT_MAX + 1)
  })
})

describe('clipTranscriptText: the live budget (a phone reading right now)', () => {
  // The 2026-10-10 report: on the phone a long reply streamed in whole, then
  // turned into its first 4,000 characters plus "…" when the turn ended, because
  // the turn-end refetch was clipped at the pushed tail's budget. The real reply
  // was 5,005 characters of Chinese prose; this one is the same shape.
  const cjkReply = '\u8fd9\u662f\u4e00\u6bb5\u5f88\u957f\u7684\u56de\u7b54\u3002'.repeat(500) + 'END'

  it('a 5,000-character CJK reply arrives whole on a live read and cut on the tail', () => {
    expect(cjkReply.length).toBeGreaterThan(TRANSCRIPT_TEXT_MAX)
    expect(clipTranscriptText(cjkReply, 'live')).toBe(cjkReply)
    const tail = clipTranscriptText(cjkReply)
    expect(tail.length).toBe(TRANSCRIPT_TEXT_MAX + 1)
    expect(tail.endsWith('\u2026')).toBe(true)
  })

  it('the default stays the tail budget, so the sweep and the push do not grow', () => {
    expect(clipTranscriptText(cjkReply)).toBe(clipTranscriptText(cjkReply, 'tail'))
  })

  it('a live read still clips prose, at the phone row bound', () => {
    const text = 'a'.repeat(TRANSCRIPT_LIVE_TEXT_MAX + 500)
    const clipped = clipTranscriptText(text, 'live')
    expect(clipped.length).toBe(TRANSCRIPT_LIVE_TEXT_MAX + 1)
    expect(clipped.endsWith('\u2026')).toBe(true)
  })

  it('a live read gives markup the live window, and still never ends inside a tag', () => {
    const card = `<div class="c">${'word '.repeat(6000)}</div>`
    expect(card.length).toBeGreaterThan(TRANSCRIPT_RICH_TEXT_MAX)
    expect(card.length).toBeLessThan(TRANSCRIPT_LIVE_RICH_TEXT_MAX)
    expect(clipTranscriptText(card, 'live')).toBe(card)
    const filler = `<p>${'x'.repeat(TRANSCRIPT_LIVE_RICH_TEXT_MAX - 40)}</p>`
    const over = `${filler}<div style="border-left:3px solid #dc2626;padding:8px">tail</div>`
    const clipped = clipTranscriptText(over, 'live')
    expect(clipped).not.toContain('padding:8')
    expect(clipped.slice(0, -1).endsWith('</p>')).toBe(true)
  })
})
