/**
 * `isFramedOutside` and `isFramedOutsideText` (core/outside-content.ts) test the frame's SHAPE, which
 * anyone can write: an event description holding `<external-content trust="untrusted">`, a remote JSON
 * shaped like an envelope with a `walnut_note` beside it. So they are for code that reads data back out
 * of an answer that crossed a wire, never a reason to skip a frame (2026-11-26 review B2: three
 * content-based skips handed a forged frame's words over plain). The only test that may skip a frame is
 * `isWalnutFramed`, the brand frameOutsideData sets on the object it built.
 *
 * This guard reads src/: every file that calls a shape check is listed with why it only reads, and no
 * call is the condition of an early return (`if (isFramedOutside(x)) return ...`), the shape a skip
 * takes. A new reader fails until it is listed; a new skip fails outright.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SHAPE_CHECK = /\bisFramedOutside(?:Text)?\(/

/** Each file that calls a shape check, and what it reads with it. */
const READERS: Readonly<Record<string, string>> = {
  'src/ops/time-outside.ts': 'reads the item group\'s framed rows back to fit them to time_report\'s cap, and frames the kept ones again (groupRows)',
  'src/core/router/context-frame.ts': 'takes the frame off a router context answer for Walnut\'s own code that parses it (unframeRouterContext)',
  'src/core/browser-control/page-frame.ts': 'reads a framed page answer back in the `walnut browser` CLI, which frames what it prints again (readPageAnswer)',
  'src/ops/letter-rows.ts': 'reads a letter\'s own frame to build its short row (compactEnvelope)',
  'src/ops/mcp.ts': 'finds the text of a framed mcp_read answer to page it inside the frame (its answer shape)',
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [full] : []
  })
}

/** Lines that call a shape check, comments and imports left out. */
function callLines(text: string): Array<{ line: number; text: string }> {
  return text.split('\n').flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    if (/^\s*(\*|\/\*|import\b|export \{)/.test(line) || !SHAPE_CHECK.test(code)) return []
    return [{ line: i + 1, text: code.trim() }]
  })
}

const files = sourceFiles(path.join(ROOT, 'src'))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  .filter((f) => f !== 'src/core/outside-content.ts')
const calls = files.map((file) => ({ file, lines: callLines(fs.readFileSync(path.join(ROOT, file), 'utf8')) })).filter((c) => c.lines.length)

describe('guard: the frame\'s shape checks only read, never skip a frame', () => {
  it('every file that calls one is listed with what it reads, and every listed file still does', () => {
    expect(calls.map((c) => c.file).sort(), 'a new caller of isFramedOutside/isFramedOutsideText: use isWalnutFramed to skip a frame, or list it in READERS with what it reads').toEqual(Object.keys(READERS).sort())
    for (const why of Object.values(READERS)) expect(why.length).toBeGreaterThan(20)
  })

  it('no call is the condition of an early return', () => {
    const skips = calls.flatMap(({ file, lines }) => lines
      // A negated test (`if (!isFramedOutside(x)) return x`) is a reader handing on what is not framed.
      .filter((l) => /\bif\s*\(/.test(l.text) && /\)\s*return\b/.test(l.text) && /(?<!!)\bisFramedOutside(?:Text)?\(/.test(l.text))
      .map((l) => `${file}:${l.line}: ${l.text}`))
    expect(skips, 'a frame skipped for content that looks framed: skip only for isWalnutFramed (core/outside-content.ts)').toEqual([])
  })
})
