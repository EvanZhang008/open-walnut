/**
 * dropRepeatedHintBlocks (src/core/hints/hint-format.ts): when the queue sends several fresh rows
 * as one line, each composed on its own, a hint a later row also carries is taken out of the
 * earlier rows (the last copy is the newest state), so the model reads it once per message (2026-11-06 audit: merged messages carried one
 * hint two or three times). Only a block word for word the same is dropped: one that says something
 * else (another thread, a mode switched since) stays.
 */
import { describe, expect, it } from 'vitest'
import { composeHinted, dropRepeatedHintBlocks, foldTidyIntoThreads, hintKindsIn, parseHinted, renderHintBlock } from '../../../src/core/hints/hint-format.js'

const RICH = renderHintBlock('rich-output', 'rich output mode is on.')
const HAND_ON = renderHintBlock('hand-on', 'at most 3 commands of your own a turn, only to look; hand the rest to your team.')
const row = (text: string, ...after: string[]) => composeHinted(text, { before: [], after })

/** Run the rows of one line through it newest first, as the queue does. */
function line(rows: string[]): string[] {
  const seen = new Set<string>()
  return [...rows].reverse().map((r) => dropRepeatedHintBlocks(r, seen)).reverse()
}

describe('dropRepeatedHintBlocks', () => {
  it('a generic hint a later row carries is dropped from the earlier rows, with its separator', () => {
    const [a, b, c] = line([row('first', RICH, HAND_ON), row('second', RICH), row('third', HAND_ON, RICH)])
    expect(a).toBe('first')
    expect(b).toBe('second')
    expect(c).toBe(row('third', HAND_ON, RICH))
    expect(parseHinted([a, b, c].join('\n\n')).hints.map((h) => h.kind)).toEqual(['hand-on', 'rich-output'])
  })

  it('threads notes about different messages both stay; the same one word for word is dropped', () => {
    const one = renderHintBlock('threads', 'filed under thread th-aaaaaaaaaaaa "Deploy guard".')
    const two = renderHintBlock('threads', 'filed under thread th-bbbbbbbbbbbb "Logo".')
    const [a, b, c] = line([row('first', one), row('second', two), row('third', one)])
    expect(a).toBe('first')
    expect(b).toBe(row('second', two))
    expect(c).toBe(row('third', one))
  })

  it('a block of the same kind that says something else stays (a mode switched between two rows)', () => {
    const off = renderHintBlock('rich-output', 'rich output mode is off again.')
    const [a, b] = line([row('first', RICH), row('second', off)])
    expect(a).toBe(row('first', RICH))
    expect(b).toBe(row('second', off))
  })

  it('on, off, on again: the line ends on (the last copy is kept, never the first)', () => {
    const off = renderHintBlock('rich-output', 'rich output mode is off again.')
    const out = line([row('one', RICH), row('two', off), row('three', RICH)])
    expect(out).toEqual(['one', row('two', off), row('three', RICH)])
    expect(parseHinted(out.join('\n\n')).hints.at(-1)?.text).toBe('rich output mode is on.')
  })

  it('a question block of another number stays', () => {
    const q3 = renderHintBlock('question', 'this message is an Ask here question.', '3')
    const q4 = renderHintBlock('question', 'this message is an Ask here question.', '4')
    const [a, b] = line([composeHinted('one?', { before: [q3], after: [] }), composeHinted('two?', { before: [q4], after: [] })])
    expect(a).toContain(q3)
    expect(b).toContain(q4)
  })

  it('text without hint blocks comes back unchanged, and a row that is only a repeated block is kept', () => {
    const seen = new Set<string>()
    expect(dropRepeatedHintBlocks('plain words, no blocks', seen)).toBe('plain words, no blocks')
    expect(dropRepeatedHintBlocks('quoting system-reminder in words', seen)).toBe('quoting system-reminder in words')
    expect(seen.size).toBe(0)
    expect(dropRepeatedHintBlocks(row('first', RICH), seen)).toBe(row('first', RICH))
    // Nothing but the block again: nothing would be left, so the row stays as it was.
    expect(dropRepeatedHintBlocks(RICH, seen)).toBe(RICH)
  })

  it('a kind the line drops goes whatever it says (the cleanup beside a filing note)', () => {
    const tidy = renderHintBlock('threads-tidy', 'threads to tidy: th-aaaaaaaaaaaa (needs a title).')
    const filed = renderHintBlock('threads', 'filed under thread th-bbbbbbbbbbbb "Logo".')
    const rows = [row('a notice', tidy), row('his words', filed)]
    expect(rows.flatMap(hintKindsIn)).toEqual(['threads-tidy', 'threads'])
    const seen = new Set<string>()
    const out = rows.map((r) => dropRepeatedHintBlocks(r, seen, new Set(['threads-tidy'])))
    expect(out).toEqual(['a notice', row('his words', filed)])
  })

  it('a block dropped before the words takes its separator along', () => {
    const ctx = renderHintBlock('object-context', 'the page the person reads.', 'c1')
    const seen = new Set<string>()
    dropRepeatedHintBlocks(composeHinted('ask 1', { before: [ctx], after: [] }), seen)
    expect(dropRepeatedHintBlocks(composeHinted('ask 2', { before: [ctx], after: [] }), seen)).toBe('ask 2')
  })
})

describe('foldTidyIntoThreads', () => {
  // 2026-11-06 review: a merged line dropped a peer row's cleanup beside the user's filing note,
  // while the cleanup was recorded as told, so the model never read the threads to tidy.
  const tidy = renderHintBlock('threads-tidy', 'threads to tidy: th-aaaaaaaaaaaa (needs a title).')
  const filed = renderHintBlock('threads', 'filed under thread th-bbbbbbbbbbbb "Logo".')

  it('a cleanup in one row joins the filing note of a later row: one threads block, nothing lost', () => {
    const out = foldTidyIntoThreads([{ message: row('a peer note', tidy), fresh: true }, { message: row('his words', filed), fresh: true }])
    expect(out[0]).toBe('a peer note')
    expect(out[1]).toBe(row('his words', renderHintBlock('threads', 'filed under thread th-bbbbbbbbbbbb "Logo". Also threads to tidy: th-aaaaaaaaaaaa (needs a title).')))
    expect(out.flatMap(hintKindsIn)).toEqual(['threads'])
  })

  it('no fresh filing note: the cleanup stays where it is; a row that must stay byte-exact is never touched', () => {
    const rows = [{ message: row('a peer note', tidy), fresh: true }, { message: row('his words', filed), fresh: false }]
    expect(foldTidyIntoThreads(rows)).toEqual(rows.map((r) => r.message))
    const frozenTidy = [{ message: row('old', tidy), fresh: false }, { message: row('his words', filed), fresh: true }]
    expect(foldTidyIntoThreads(frozenTidy)).toEqual(frozenTidy.map((r) => r.message))
  })

  it('the same cleanup in two rows is said once', () => {
    const out = foldTidyIntoThreads([{ message: row('one', tidy), fresh: true }, { message: row('two', tidy), fresh: true }, { message: row('three', filed), fresh: true }])
    expect(out.join('\n').match(/threads to tidy/g)).toHaveLength(1)
  })
})

