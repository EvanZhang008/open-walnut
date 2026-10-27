/**
 * Dictation into the question card's box (useBoxDictation): where the words go.
 * The composer's rules: a fresh dictation lands at the caret with a space on a
 * side that touches other text; a draft's span is replaced by the next draft and
 * by the final text, never appended to.
 */
import { describe, expect, it } from 'vitest'
import { shiftCaret, spliceDictation } from '../../web/src/hooks/useBoxDictation'

describe('spliceDictation', () => {
  it('fills an empty box', () => {
    expect(spliceDictation('', 0, null, 'why merge')).toEqual({ next: 'why merge', start: 0 })
  })

  it('lands at the caret with a space on each side that touches text', () => {
    expect(spliceDictation('Ask why it waits', 7, null, 'exactly')).toEqual({ next: 'Ask why exactly it waits', start: 8 })
    expect(spliceDictation('Ask ', 4, null, 'why')).toEqual({ next: 'Ask why', start: 4 })
    expect(spliceDictation('then?', 0, null, 'And')).toEqual({ next: 'And then?', start: 0 })
  })

  it('a caret past the end counts as the end', () => {
    expect(spliceDictation('Ask', 99, null, 'why')).toEqual({ next: 'Ask why', start: 4 })
  })

  it('replaces the span the last draft wrote, keeping what the user typed around it', () => {
    const first = spliceDictation('Q: ', 3, null, 'why does')
    expect(first.next).toBe('Q: why does')
    const span = { start: first.start, length: 'why does'.length }
    expect(spliceDictation(first.next + ' (typed)', 0, span, 'why does phase two matter')).toEqual({
      next: 'Q: why does phase two matter (typed)', start: 3,
    })
  })

  it('keeps Unicode intact around the span', () => {
    // Test data: e-acute and CJK "hello".
    const value = 'café 你好'
    expect(spliceDictation(value, value.length, null, 'ok').next).toBe('café 你好 ok')
  })
})

describe('shiftCaret (a refine swapping the provisional words for the final ones)', () => {
  // 'Note: why does phase done.' -> 'Note: why does phase two matter done.' (words at 6, 14 -> 25 chars)
  it('a caret right after the words stays right after them', () => {
    expect(shiftCaret(20, 6, 14, 25)).toBe(31)
  })

  it('a caret further on moves with the text after the words', () => {
    expect(shiftCaret(26, 6, 14, 25)).toBe(37)
  })

  it('a caret before the words, or inside them, stays put', () => {
    expect(shiftCaret(3, 6, 14, 25)).toBe(3)
    expect(shiftCaret(10, 6, 14, 25)).toBe(10)
  })

  it('a caret inside words that got shorter stays inside them', () => {
    expect(shiftCaret(18, 6, 14, 5)).toBe(11)
  })
})
