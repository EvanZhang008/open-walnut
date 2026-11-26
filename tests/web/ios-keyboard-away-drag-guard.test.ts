/**
 * A UI test's drag that puts the keyboard away starts off the field being typed in. A touch that
 * lands on the focused field is that field's first: on CI the question card's drag from 0.75 of
 * its box started on the six-line answer it had just grown, the cards did not move and the
 * keyboard stayed up (2026-11-26, run 45784774186, AskQuestionCardUITests: the screens before and
 * after the drag were the same, the answer at the same frame, the keyboard at 583).
 *
 * The members are read from source: every drag (`thenDragTo`) a UI test makes right before it
 * checks that the keyboard went (a few lines before, directly or through a helper of its file)
 * takes its start from `keyboardAwayDragY` (WalnutUITests/KeyboardAwayDrag.swift). A swipe on a
 * named element (`reply.swipeDown()`) starts on that element, which a test names; it is not read.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { code } from './ios-timed-hide-scan'
import { body } from './ios-swift-source'

const DIR = path.resolve(import.meta.dirname, '../../ios-native/WalnutUITests')

/** A check that the keyboard is gone, in each spelling the UI tests use. */
const GONE =
  /keyboards[\w.]*\.(waitForNonExistence\(|count == 0)|evaluatedWith:\s*app\.keyboards|!\s*app\.keyboards[\w.]*\.exists|XCTAssertFalse\(app\.keyboards[\w.]*\.exists/
const LOOK_BACK = 8

type Drag = { where: string; usesHelper: boolean }

/** The drag's start comes from the helper: a value named from `keyboardAwayDragY(` that the code
 * after it, up to the drag, reads. */
function startFromHelper(src: string): boolean {
  const m = /let\s+(\w+)\s*=\s*keyboardAwayDragY\(/.exec(src)
  if (!m) return false
  const after = src.slice(m.index + m[0].length)
  const rest = after.slice(after.indexOf('\n'))
  return new RegExp(`\\b${m[1]}\\b`).test(rest.slice(0, rest.search(/thenDragTo/) + 1 || undefined))
}

export function keyboardAwayDrags(file: string, raw: string): Drag[] {
  const src = code(raw)
  const lines = src.split('\n')
  const dragFns = [...new Set([...src.matchAll(/func\s+(\w+)\s*\(/g)].map((m) => m[1]))].filter(
    (n) => n !== 'keyboardAwayDragY' && /thenDragTo/.test(body(src, n) ?? ''),
  )
  const out: Drag[] = []
  lines.forEach((line, i) => {
    if (!GONE.test(line)) return
    const from = Math.max(0, i - LOOK_BACK)
    const back = lines.slice(from, i + 1)
    const last = back.map((l) => /thenDragTo/.test(l)).lastIndexOf(true)
    if (last >= 0) {
      const at = from + last
      const before = lines.slice(Math.max(0, at - 6), at + 1).join('\n')
      out.push({ where: `${file}:${at + 1}`, usesHelper: startFromHelper(before) })
      return
    }
    for (const fn of dragFns) {
      if (!new RegExp(`\\b${fn}\\s*\\(`).test(back.join('\n'))) continue
      out.push({ where: `${file}: ${fn}() before line ${i + 1}`, usesHelper: startFromHelper(body(src, fn) ?? '') })
    }
  })
  return out
}

const drags = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.swift'))
  .flatMap((f) => keyboardAwayDrags(f, fs.readFileSync(path.join(DIR, f), 'utf8')))

describe('iOS UI tests: a keyboard-away drag starts off the field being typed in', () => {
  it('finds the drags it guards', () => {
    const files = new Set(drags.map((d) => d.where.split(':')[0]))
    expect([...files]).toEqual(
      expect.arrayContaining(['AskQuestionCardUITests.swift', 'LetterReplyUITests.swift', 'ModelPillHealUITests.swift']),
    )
  })

  it('each takes its start from keyboardAwayDragY', () => {
    expect(drags.filter((d) => !d.usesHelper).map((d) => d.where)).toEqual([])
  })

  it('reads a drag before a keyboard check, direct or through a helper', () => {
    const direct = 'func t() {\n  start.press(forDuration: 0.1, thenDragTo: end)\n  XCTAssertFalse(app.keyboards.element.exists)\n}'
    expect(keyboardAwayDrags('A.swift', direct)).toEqual([{ where: 'A.swift:2', usesHelper: false }])
    const helper =
      'func away(_ app: XCUIApplication) {\n  let y = keyboardAwayDragY(app, in: r, avoiding: f, preferredY: 1)\n  o.withOffset(CGVector(dx: 0, dy: y)).press(forDuration: 0.1, thenDragTo: e)\n}\n' +
      '\n'.repeat(8) +
      'func t() {\n  away(app)\n  XCTAssertTrue(app.keyboards.element.waitForNonExistence(timeout: 5))\n}'
    expect(keyboardAwayDrags('B.swift', helper)).toEqual([{ where: 'B.swift: away() before line 15', usesHelper: true }])
    // The helper called but its answer not the start.
    expect(keyboardAwayDrags('C.swift', helper.replace('dy: y)', 'dy: 300)'))[0].usesHelper).toBe(false)
  })
})
