/**
 * Voice Accuracy's word diff (src/core/stt/compare/score.ts wordDiff) keeps the
 * engine's own text exactly: joining the segments gives it back, a changed or
 * extra mark covers its words and never a space or punctuation next to them,
 * and a missing stretch carries no engine text (the pane marks its place and
 * lists the words apart). 2026-11-22 review: Whisper's line read "thesecond
 * oneis" because missing words were put into the line, and "tail skill" read as
 * one word when copied because the mark took the space.
 * Chinese test data is written as escapes.
 */
import { describe, expect, it } from 'vitest'
import { wordDiff, type DiffSegment } from '../../src/core/stt/compare/score.js'

const GUESS = 'Walnut test take 0: the second one is Tailscale, is the pairing related to it'

const joined = (s: DiffSegment[]) => s.map((x) => x.text).join('')
const marks = (s: DiffSegment[]) => s.filter((x) => x.op === 'changed' || x.op === 'extra')

function expectExact(segments: DiffSegment[], hyp: string): void {
  expect(joined(segments)).toBe(hyp)
  for (const m of marks(segments)) {
    expect(m.text, `mark "${m.text}"`).toBe(m.text.trim())
    expect(m.text).not.toMatch(/^[\s,.;:!?\u3001\u3002\uff0c]|[\s,.;:!?\u3001\u3002\uff0c]$/)
  }
  for (const m of segments.filter((x) => x.op === 'missing')) expect(m.text).toBe('')
}

describe('wordDiff keeps the engine text as it is', () => {
  it('English: words left out are marks of their own, never joined into the line', async () => {
    const hyp = 'Walnut test take 0: second is tail scale, is pairing related to it'
    const segments = await wordDiff(hyp, GUESS)
    expectExact(segments, hyp)
    expect(segments.filter((s) => s.op === 'missing').map((s) => s.ref)).toEqual(['the', 'one', 'the'])
    // The spaces stay where the engine wrote them: "second is", never "secondis" or "thesecond".
    expect(segments.find((s) => s.op === 'same' && s.text.includes('second'))?.text).toBe('second ')
    // Neighbouring edits are one stretch, and the matched "is" after it stays matched.
    expect(segments).toContainEqual({ op: 'changed', text: 'tail scale', ref: 'Tailscale' })
    expect(segments.some((s) => s.op === 'same' && s.text === ', is ')).toBe(true)
  })

  it('English: a mark never takes the space with it ("tail skill" stays two words)', async () => {
    const hyp = 'Walnut test take 0: the second one is tail skill, is the pairing related to it'
    const segments = await wordDiff(hyp, GUESS)
    expectExact(segments, hyp)
    expect(marks(segments)).toEqual([{ op: 'changed', text: 'tail skill', ref: 'Tailscale' }])
  })

  it('English: a word the guess lacks is extra, its spaces outside the mark', async () => {
    const hyp = 'hello  there   world'
    const segments = await wordDiff(hyp, 'hello world')
    expectExact(segments, hyp)
    expect(segments).toEqual([
      { op: 'same', text: 'hello  ' },
      { op: 'extra', text: 'there' },
      { op: 'same', text: '   world' },
    ])
  })

  it('Chinese: one unit per character, no spaces invented', async () => {
    // "we push it to staging today" heard with one character wrong and one left out.
    const guess = '\u6211\u4eec\u4eca\u5929\u63a8\u5230\u73af\u5883\u3002'
    const hyp = '\u6211\u4eec\u660e\u5929\u63a8\u73af\u5883\u3002'
    const segments = await wordDiff(hyp, guess)
    expectExact(segments, hyp)
    expect(segments).toContainEqual({ op: 'changed', text: '\u660e', ref: '\u4eca' })
    expect(segments).toContainEqual({ op: 'missing', text: '', ref: '\u5230' })
  })

  it('mixed Chinese and English: Latin words and Chinese characters marked in place, punctuation kept', async () => {
    const guess = '\u6211\u4eec\u4eca\u5929\u628a deployment \u63a8\u5230 staging \u73af\u5883\uff0c\u7136\u540e check \u4e00\u4e0b pod\u3002'
    const hyp = '\u6211\u4eec\u4eca\u5929\u628adeploy meant\u63a8\u5230 staging \u73af\u5883\u7136\u540e\uff0ccheck\u4e00\u4e0b pot\u3002'
    const segments = await wordDiff(hyp, guess)
    expectExact(segments, hyp)
    expect(segments).toContainEqual({ op: 'changed', text: 'deploy meant', ref: 'deployment' })
    expect(segments).toContainEqual({ op: 'changed', text: 'pot', ref: 'pod' })
  })

  it('an engine text with no words at all is kept as it is, the guess missing before it', async () => {
    expect(await wordDiff('...', 'hello')).toEqual([{ op: 'missing', text: '', ref: 'hello' }, { op: 'same', text: '...' }])
    expect(await wordDiff('', '')).toEqual([])
  })
})
