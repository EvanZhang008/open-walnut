/**
 * lineSpan (src/providers/host-exec-core.ts): a window into a job's output keeps
 * whole lines, so the server's line-by-line credential hiding never sees a token
 * cut in two at a window's edge.
 */
import { describe, expect, it } from 'vitest'
import { lineSpan } from '../../src/providers/host-exec-core.js'

const text = (b: Buffer, s: { start: number; end: number }) => b.subarray(s.start, s.end).toString('utf8')

describe('lineSpan', () => {
  it('drops the partial first line of a tail window', () => {
    const b = Buffer.from('ken=abc\nnext\nlast\n')
    expect(text(b, lineSpan(b, true, false))).toBe('next\nlast\n')
  })
  it('stops at the last newline when more may follow', () => {
    const b = Buffer.from('one\ntwo\nghp_half')
    const s = lineSpan(b, false, true)
    expect(text(b, s)).toBe('one\ntwo\n')
    expect(s.end).toBe(8)
  })
  it('keeps a window with no newline whole, never ending inside a character', () => {
    const b = Buffer.from('progress é中')
    const cut = b.subarray(0, b.length - 1) // the last character split
    expect(text(cut, lineSpan(cut, false, true))).toBe('progress é')
    expect(text(b, lineSpan(b, false, false))).toBe('progress é中')
  })
  it('keeps everything for a finished job read from the start', () => {
    const b = Buffer.from('a\nb')
    expect(lineSpan(b, false, false)).toEqual({ start: 0, end: 3 })
  })
})
