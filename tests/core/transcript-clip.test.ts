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
