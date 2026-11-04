/**
 * readLogLines (host-exec-line.ts): a read from an offset inside a line starts at that line's start.
 * 2026-11-04 review: a partial match's answer showed the unfinished line and named an offset inside
 * it, so the next read began mid-line, and the server, which hides credentials one line at a time,
 * saw a secret printed in two writes as two harmless halves in two answers.
 *
 * MACHINE SAFETY: writes only files in its own temp dir.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readLogLines } from '../../src/providers/host-exec-line.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-line-read-'))
afterAll(() => { if (dir.includes('walnut-line-read-')) fs.rmSync(dir, { recursive: true, force: true }) })
const log = (name: string, text: string) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p }

describe('readLogLines from an offset', () => {
  it('an offset inside a line reads that whole line, and the answer says where it starts', () => {
    const head = 'hi\ntoken: ghp_abc'
    const p = log('split.log', head)
    // The job printed the rest of the line later.
    fs.appendFileSync(p, 'def\nnext line\n')
    const r = readLogLines(p, head.length, 256 * 1024, false)
    expect(r).toMatchObject({ output: 'token: ghp_abcdef\nnext line\n', offset: 3, nextOffset: head.length + 'def\nnext line\n'.length })
  })

  it('an offset at a line start, at 0 and at the end stays where it is', () => {
    const p = log('lines.log', 'one\ntwo\nthree\n')
    expect(readLogLines(p, 4, 1024, false)).toMatchObject({ output: 'two\nthree\n', offset: 4 })
    expect(readLogLines(p, 0, 1024, false)).toMatchObject({ output: 'one\ntwo\nthree\n', offset: 0 })
    expect(readLogLines(p, 14, 1024, false)).toMatchObject({ output: '', offset: 14 })
  })

  it('inside the first line it starts at 0; inside a line longer than 64 KB it keeps the offset', () => {
    const first = log('first.log', 'no newline yet')
    expect(readLogLines(first, 5, 1024, false)).toMatchObject({ output: 'no newline yet', offset: 0 })
    const long = 'x'.repeat(70 * 1024)
    const p = log('long.log', `a\n${long}\n`)
    const at = 2 + 68 * 1024
    expect(readLogLines(p, at, 256 * 1024, false)).toMatchObject({ offset: at, output: `${'x'.repeat(2 * 1024)}\n` })
  })
})
