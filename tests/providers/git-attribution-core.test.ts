/**
 * Per-hunk attribution (git-attribution-core.ts): which hunks of a file's diff
 * against HEAD the session wrote, from the ops its transcript recorded. Pure:
 * no git, no disk. The ops below are shaped exactly like session-changes-core's
 * FileOp records.
 */
import { describe, expect, it } from 'vitest'
import {
  applyChosenHunks,
  attributeFile,
  createGitAttribution,
  verifyChosenPresent,
  type AttrOp,
  type CommitHunk,
} from '../../src/providers/git-attribution-core.js'

const edit = (oldString: string, newString: string, extra: Partial<AttrOp> = {}): AttrOp => ({ kind: 'edit', oldString, newString, replaceAll: false, ...extra })
const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')
const owners = (hunks: CommitHunk[]) => hunks.map((h) => h.owner)
const added = (h: CommitHunk) => h.newLines.join('')

describe('attributeFile', () => {
  it('claims the one hunk a session wrote on a clean file', () => {
    const head = lines(10)
    const work = head.replace('line 4\n', 'line four\n')
    const att = attributeFile({ head, work, ops: [edit('line 4\n', 'line four\n')] })
    expect(owners(att.hunks)).toEqual(['mine'])
    expect(att.owner).toBe('mine')
    expect(att.hunks[0]).toMatchObject({ oldStart: 3, oldLines: ['line 4\n'], newLines: ['line four\n'] })
    expect(att.hunks[0].before).toEqual(['line 1\n', 'line 2\n', 'line 3\n'])
    expect(att.hunks[0].after).toEqual(['line 5\n', 'line 6\n', 'line 7\n'])
  })

  it('splits a file two sessions edited: each session claims only its own hunk', () => {
    const head = lines(30)
    const aOps = [edit('line 5\n', 'line five (A)\n')]
    const bOps = [edit('line 20\n', 'line twenty (B)\n')]
    const work = head.replace('line 5\n', 'line five (A)\n').replace('line 20\n', 'line twenty (B)\n')
    const a = attributeFile({ head, work, ops: aOps })
    expect(a.hunks.map((h) => [added(h), h.owner])).toEqual([['line five (A)\n', 'mine'], ['line twenty (B)\n', 'other']])
    expect(a.owner).toBe('mixed')
    const b = attributeFile({ head, work, ops: bOps })
    expect(b.hunks.map((h) => [added(h), h.owner])).toEqual([['line five (A)\n', 'other'], ['line twenty (B)\n', 'mine']])
  })

  it('splits adjacent appends from two sessions into one hunk each', () => {
    const head = 'items:\n- one\n'
    const afterA = head + '- two (A)\n'
    const work = afterA + '- three (B)\n'
    const a = attributeFile({ head, work, ops: [edit('- one\n', '- one\n- two (A)\n')] })
    expect(a.hunks.map((h) => [added(h), h.owner, h.oldStart, h.seq])).toEqual([
      ['- two (A)\n', 'mine', 2, 0],
      ['- three (B)\n', 'other', 2, 1],
    ])
    // Committing only A's hunk leaves B's line out of the blob.
    const res = applyChosenHunks(head, [a.hunks[0]])
    expect(res).toEqual({ text: afterA })
  })

  it('never claims lines for a failed edit whose new text exists in the file', () => {
    const head = lines(8)
    // Another writer put "line X" in; this session's edit with the same new text FAILED.
    const work = head.replace('line 3\n', 'line X\n')
    const att = attributeFile({ head, work, ops: [edit('line 7\n', 'line X\n', { failed: true })] })
    expect(owners(att.hunks)).toEqual(['other'])
    expect(att.owner).toBe('other')
    // The same op without the failure flag would claim it (the reversal is unique),
    // which is exactly why the flag must be honoured.
    const unflagged = attributeFile({ head, work, ops: [edit('line 3\n', 'line X\n')] })
    expect(owners(unflagged.hunks)).toEqual(['mine'])
  })

  it('leaves an edit unreversed when its new text sits at two places', () => {
    const head = 'a\nb\nc\nb\n'
    const work = 'a\nB\nc\nB\n'
    // Two writers each changed one "b" to "B"; this session's edit cannot be placed.
    const att = attributeFile({ head, work, ops: [edit('b\nc\n', 'B\nc\n')] })
    // "B\nc\n" occurs once; reversing it leaves "b\nc\n" unique: the first hunk is ours.
    expect(att.hunks.map((h) => [h.oldStart, h.owner])).toEqual([[1, 'mine'], [3, 'other']])
    const ambiguous = attributeFile({ head, work, ops: [edit('b\n', 'B\n')] })
    expect(owners(ambiguous.hunks)).toEqual(['other', 'other'])
    expect(ambiguous.reason).toBe('partial')
  })

  it('reverses replace_all edits and applies the session ops oldest first', () => {
    const head = 'let x = 1\nlet y = x\nprint(x)\n'
    const ops = [edit('x', 'value', { replaceAll: true }), edit('print(value)\n', 'console.log(value)\n')]
    const work = 'let value = 1\nlet y = value\nconsole.log(value)\n'
    const att = attributeFile({ head, work, ops })
    expect(att.owner).toBe('mine')
    expect(att.hunks.every((h) => h.owner === 'mine')).toBe(true)
  })

  it('a Write the session made, then another writer edited: only the Write\'s lines are claimed', () => {
    const head = 'one\ntwo\nthree\n'
    const written = 'one\nTWO\nthree\nfour\n'
    const work = written.replace('one\n', 'ONE by B\n')
    const att = attributeFile({ head, work, ops: [{ kind: 'write', content: written, original: head }] })
    const map = Object.fromEntries(att.hunks.map((h) => [added(h), h.owner]))
    expect(map['ONE by B\n']).toBe('other')
    expect(map['TWO\n']).toBe('mine')
    expect(map['four\n']).toBe('mine')
  })

  it('a file the session created with Write is all its own; one a shell command wrote is not claimed', () => {
    const work = 'fresh\nfile\n'
    const created = attributeFile({ head: '', work, ops: [{ kind: 'write', content: work }] })
    expect(created.owner).toBe('mine')
    expect(created.hunks).toHaveLength(1)
    const shell = attributeFile({ head: '', work, ops: [{ kind: 'create' }] })
    expect(shell.owner).not.toBe('mine')
    expect(shell.reason).toBe('shell')
    // A shell-made file the session then edited: the edit is claimed, the shell's lines are not.
    const edited = 'fresh\nfile\nadded by edit\n'
    const mixed = attributeFile({ head: '', work: edited, ops: [{ kind: 'create' }, edit('file\n', 'file\nadded by edit\n')] })
    expect(mixed.hunks.map((h) => [added(h), h.owner])).toEqual([['fresh\nfile\n', 'other'], ['added by edit\n', 'mine']])
  })

  it('gives up its claim when another writer rewrote the lines it wrote', () => {
    const head = lines(6)
    const work = head.replace('line 2\n', 'line two, rewritten by B\n')
    const att = attributeFile({ head, work, ops: [edit('line 2\n', 'line two (A)\n')] })
    expect(owners(att.hunks)).toEqual(['other'])
    expect(att.reason).toBe('partial')
  })

  it('splits a replacement followed by another writer\'s insertion', () => {
    const head = 'alpha\nbeta\ngamma\n'
    const work = 'alpha\nBETA (A)\ninserted (B)\ngamma\n'
    const att = attributeFile({ head, work, ops: [edit('beta\n', 'BETA (A)\n')] })
    expect(att.hunks.map((h) => [h.oldLines.join(''), added(h), h.owner])).toEqual([
      ['beta\n', 'BETA (A)\n', 'mine'],
      ['', 'inserted (B)\n', 'other'],
    ])
    expect(applyChosenHunks(head, [att.hunks[0]])).toEqual({ text: 'alpha\nBETA (A)\ngamma\n' })
    expect(applyChosenHunks(head, [att.hunks[1]])).toEqual({ text: 'alpha\nbeta\ninserted (B)\ngamma\n' })
  })

  it('keeps CRLF, a missing final newline and non-ASCII text byte-exact', () => {
    const head = 'café\r\n中文\r\nend'
    const work = 'café\r\n中文 \u{1F330}\r\nend'
    const att = attributeFile({ head, work, ops: [edit('中文\r\n', '中文 \u{1F330}\r\n')] })
    expect(owners(att.hunks)).toEqual(['mine'])
    expect(applyChosenHunks(head, att.hunks)).toEqual({ text: work })
    // The last line has no terminator: changing it is still one exact hunk.
    const tail = attributeFile({ head, work: head.replace(/end$/, 'END'), ops: [edit('end', 'END')] })
    expect(tail.hunks.map((h) => [h.oldLines, h.newLines, h.owner])).toEqual([[['end'], ['END'], 'mine']])
  })

  it('a file this session never touched is all "other"', () => {
    const att = attributeFile({ head: 'a\n', work: 'b\n', ops: [] })
    expect(att).toMatchObject({ owner: 'other', reason: 'untouched' })
  })

  it('a diff past the edit budget is "unknown", never "mine"', () => {
    const small = createGitAttribution({ maxD: 3 })
    const head = lines(20)
    const work = lines(20, 'changed')
    const att = small.attribute({ head, work, ops: [{ kind: 'write', content: work, original: head }] })
    expect(att.hunks.some((h) => h.owner === 'mine')).toBe(false)
    expect(att.reason).toBe('too-large')
  })

  it('credits the lines of a file the session moved here (rename base)', () => {
    const oldContent = 'export const a = 1\n'
    const work = 'export const a = 1\nexport const b = 2\n'
    const att = attributeFile({
      head: '', work, renameBase: oldContent,
      ops: [{ kind: 'rename', from: '/repo/old.ts' }, edit('export const a = 1\n', 'export const a = 1\nexport const b = 2\n')],
    })
    expect(att.owner).toBe('mine')
  })

  it('a long file with many hunks keeps them independent and stable', () => {
    const head = lines(2000)
    let work = head
    const ops: AttrOp[] = []
    for (let i = 10; i <= 1990; i += 40) {
      const from = `line ${i}\n`
      const to = `line ${i} edited\n`
      work = work.replace(from, to)
      ops.push(edit(from, to))
    }
    const att = attributeFile({ head, work, ops })
    expect(att.hunks).toHaveLength(50)
    expect(att.owner).toBe('mine')
    expect(new Set(att.hunks.map((h) => h.id)).size).toBe(50)
    // Same input, same ids.
    expect(attributeFile({ head, work, ops }).hunks.map((h) => h.id)).toEqual(att.hunks.map((h) => h.id))
    // Every other hunk applied gives exactly those edits.
    const pick = att.hunks.filter((_, i) => i % 2 === 0)
    const res = applyChosenHunks(head, pick) as { text: string }
    expect(res.text.split('edited').length - 1).toBe(25)
  })
})

describe('applyChosenHunks', () => {
  it('places a hunk by content when its line number is off, and refuses an ambiguous or missing match', () => {
    const head = 'x\na\nb\nc\ny\n'
    const hunk = { oldStart: 0, oldLines: ['b\n'], newLines: ['B\n'], before: ['a\n'], after: ['c\n'] }
    expect(applyChosenHunks(head, [hunk])).toEqual({ text: 'x\na\nB\nc\ny\n' })
    expect(applyChosenHunks('a\nb\nc\na\nb\nc\n', [hunk])).toEqual({ error: 'content', id: undefined })
    expect(applyChosenHunks('q\nr\n', [{ ...hunk, id: 'h1' }])).toEqual({ error: 'content', id: 'h1' })
  })

  it('refuses overlapping hunks', () => {
    const head = 'a\nb\nc\n'
    const one = { id: 'one', oldStart: 0, oldLines: ['a\n', 'b\n'], newLines: ['A\n'], before: [], after: ['c\n'] }
    const two = { id: 'two', oldStart: 1, oldLines: ['b\n'], newLines: ['B\n'], before: ['a\n'], after: ['c\n'] }
    expect(applyChosenHunks(head, [one, two])).toEqual({ error: 'overlap', id: 'two' })
  })

  it('inserts into an empty file and appends at the end', () => {
    expect(applyChosenHunks('', [{ oldStart: 0, oldLines: [], newLines: ['new\n'], before: [], after: [] }])).toEqual({ text: 'new\n' })
    expect(applyChosenHunks('a\n', [{ oldStart: 1, oldLines: [], newLines: ['b\n'], before: ['a\n'], after: [] }])).toEqual({ text: 'a\nb\n' })
  })
})

describe('verifyChosenPresent', () => {
  it('passes a hunk that is still in the working tree and flags one that is gone', () => {
    const head = lines(10)
    const work = head.replace('line 3\n', 'line three\n')
    const att = attributeFile({ head, work, ops: [edit('line 3\n', 'line three\n')] })
    expect(verifyChosenPresent(head, work, att.hunks)).toEqual([])
    // The session reverted it after the review.
    expect(verifyChosenPresent(head, head, att.hunks)).toEqual([att.hunks[0].id])
    // Another writer changed the line again: the reviewed hunk is not what is on disk.
    expect(verifyChosenPresent(head, head.replace('line 3\n', 'line 3 by B\n'), att.hunks)).toEqual([att.hunks[0].id])
    // An unrelated change elsewhere keeps it valid.
    expect(verifyChosenPresent(head, work.replace('line 9\n', 'line nine\n'), att.hunks)).toEqual([])
  })
})
