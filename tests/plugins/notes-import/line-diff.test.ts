/**
 * The comparison view's line diff: lines only in the person's note, lines only in
 * Notion's, and folded runs of shared lines.
 */
import { describe, expect, it } from 'vitest'
import { diffNoteLines } from '../../../plugin-store/notes-import/src/web/line-diff'

const kinds = (mine: string, notion: string) => diffNoteLines(mine, notion).rows.map((r) => r.kind === 'fold' ? `fold${r.count}` : `${r.kind[0]}:${r.text}`)

describe('diffNoteLines', () => {
  it('marks a changed line on both sides and keeps the rest', () => {
    const d = diffNoteLines('a\nb\nc', 'a\nB\nc')
    expect(d.mine).toBe(1)
    expect(d.notion).toBe(1)
    expect(kinds('a\nb\nc', 'a\nB\nc')).toEqual(['s:a', 'm:b', 'n:B', 's:c'])
  })

  it('folds long shared runs, keeping two lines around each change', () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const mine = [...base.slice(0, 10), 'mine only', ...base.slice(10)].join('\n')
    const rows = kinds(mine, base.join('\n'))
    expect(rows).toEqual(['fold8', 's:line 8', 's:line 9', 'm:mine only', 's:line 10', 's:line 11', 'fold8'])
  })

  it('reads every line as different when nothing is shared, counting each side', () => {
    const d = diffNoteLines('x\ny', 'p\nq\nr')
    expect([d.mine, d.notion]).toEqual([2, 3])
    expect(d.rows.every((r) => r.kind !== 'same' && r.kind !== 'fold')).toBe(true)
  })

  it('ignores trailing spaces and Windows line ends, and counts no blank line', () => {
    expect(diffNoteLines('a  \r\nb', 'a\nb')).toMatchObject({ mine: 0, notion: 0 })
    expect(diffNoteLines('a\n\n\nb', 'a\nb')).toMatchObject({ mine: 0, notion: 0 })
  })

  it('keeps Unicode lines intact', () => {
    expect(kinds('\u4f60\u597d\n\u2705 done', '\u4f60\u597d\n\u2610 todo')).toEqual(['s:\u4f60\u597d', 'm:\u2705 done', 'n:\u2610 todo'])
  })

  it('stays quick on a long note with many changes', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n')
    const b = Array.from({ length: 3000 }, (_, i) => (i % 7 ? `row ${i}` : `changed ${i}`)).join('\n')
    const t = Date.now()
    const d = diffNoteLines(a, b)
    expect(Date.now() - t).toBeLessThan(2000)
    expect(d.notion).toBe(429)
    expect(d.mine).toBe(429)
  })
})
