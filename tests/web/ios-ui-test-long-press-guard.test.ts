/**
 * A phone UI test long-presses an element only through `longPress(element, seconds)`
 * (ios-native/WalnutUITests/ElementWaits.swift), which waits for the element to hold still first.
 *
 * An element in a drawer that is still sliding in, or on a page that is still coming back, is
 * already hittable while it moves, and the motion cancels a long press on it: no menu comes
 * (2026-11-16, CI on iOS 26.5: TaskPageLargeTypeUITests' board row, "no Details item in the row
 * menu"). The class: `<element>.press(forDuration: n)` with no drag. A press on a coordinate (a
 * point inside a text, `x.coordinate(...)` or a value made from one) is outside it: a coordinate
 * has no frame to wait on, and those tests place it themselves.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const UI_TESTS = path.resolve(__dirname, '../../ios-native/WalnutUITests')
const HELPER = 'ElementWaits.swift'

const files = fs.readdirSync(UI_TESTS).filter((f) => f.endsWith('.swift'))
const read = (f: string) => fs.readFileSync(path.join(UI_TESTS, f), 'utf8')

/** Line numbers of bare element long presses in one Swift file. */
export function bareLongPresses(src: string): number[] {
  const lines = src.split('\n')
  const found: number[] = []
  lines.forEach((line, i) => {
    const m = /(\S*)\.press\(forDuration:[^)]*\)/.exec(line)
    if (!m || /thenDragTo/.test(line) || /coordinate\(/.test(line)) return
    // `.press` on a line of its own continues the expression above it.
    if (m[1] === '' && /coordinate\(/.test(lines[i - 1] ?? '')) return
    // A value made from a coordinate: `let start = code.coordinate(...)`.
    const name = /^(?:.*[;(\s])?(\w+)$/.exec(m[1])?.[1]
    if (name && new RegExp(`(?:let|var)\\s+${name}\\b[^\\n]*=[^\\n]*coordinate\\(`).test(src)) return
    found.push(i + 1)
  })
  return found
}

describe('iOS UI tests: a long press waits for its element to hold still', () => {
  it('finds a bare element press and leaves coordinates, drags and the helper', () => {
    expect(bareLongPresses('row.press(forDuration: 1.0)')).toEqual([1])
    expect(bareLongPresses('app.buttons["x"].press(forDuration: 1)')).toEqual([1])
    expect(bareLongPresses('updated.tap(); updated.press(forDuration: 1.2)')).toEqual([1])
    expect(bareLongPresses('longPress(row, 1.0)')).toEqual([])
    expect(bareLongPresses('row.press(forDuration: 0.5, thenDragTo: other)')).toEqual([])
    expect(bareLongPresses('text.coordinate(withNormalizedOffset: .zero).press(forDuration: 1)')).toEqual([])
    expect(bareLongPresses('text.coordinate(withNormalizedOffset: .zero)\n    .press(forDuration: 1)')).toEqual([])
    expect(bareLongPresses('let start = code.coordinate(withNormalizedOffset: .zero)\nstart.press(forDuration: 1.2)')).toEqual([])
  })

  it('no UI test long-presses an element without waiting for it to hold still', () => {
    const found = files.filter((f) => f !== HELPER).flatMap((f) => bareLongPresses(read(f)).map((n) => `${f}:${n}`))
    expect(found, 'use longPress(element, seconds) (WalnutUITests/ElementWaits.swift)').toEqual([])
  })

  it('the helpers are defined once, in the shared file', () => {
    for (const fn of ['longPress', 'waitStill']) {
      const defs = files.filter((f) => new RegExp(`func ${fn}\\(`).test(read(f)))
      expect(defs, fn).toEqual([HELPER])
    }
  })
})
