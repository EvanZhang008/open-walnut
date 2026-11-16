/**
 * A phone UI test reads a field it typed into only by waiting for the value
 * (ios-native/WalnutUITests/ElementWaits.swift `waitForValue`).
 *
 * `typeText` returns once the keys are sent; the field's value follows a moment later. Read at
 * once, it held the first letters only on a busy runner (2026-11-16, CI on iOS 26.5:
 * ThreadFollowUpVoiceUITests read "Ty" for "Typed without voice", QuickQuestionRenameUITests "Q"
 * for "Quick question"). The class: `<field>.typeText(...)` followed within two lines by
 * `XCTAssertEqual(<field>.value as? String, ...)`. One shared wait, no private copies.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const UI_TESTS = path.resolve(__dirname, '../../ios-native/WalnutUITests')
const HELPER = 'ElementWaits.swift'

const files = fs.readdirSync(UI_TESTS).filter((f) => f.endsWith('.swift'))
const read = (f: string) => fs.readFileSync(path.join(UI_TESTS, f), 'utf8')

/** Each `<field>.value as? String` equality read within two lines after typing into that field. */
export function typedThenReadAtOnce(src: string): number[] {
  const lines = src.split('\n')
  const found: number[] = []
  lines.forEach((line, i) => {
    const typed = /([\w.]+)\.typeText\(/.exec(line)
    if (!typed) return
    const field = typed[1].replace(/[.]/g, '\\.')
    const readAtOnce = new RegExp(`XCTAssertEqual\\(\\s*${field}\\.value as\\? String`)
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) if (readAtOnce.test(lines[j])) found.push(j + 1)
  })
  return found
}

describe('iOS UI tests: a typed field is read by waiting for its value', () => {
  it('finds the read-at-once form and leaves the waited one', () => {
    expect(typedThenReadAtOnce('input.typeText("a")\nXCTAssertEqual(input.value as? String, "a")')).toEqual([2])
    expect(typedThenReadAtOnce('app.field.typeText("a")\n\nXCTAssertEqual(app.field.value as? String, "a")')).toEqual([3])
    expect(typedThenReadAtOnce('input.typeText("a")\nXCTAssertTrue(waitForValue(input, "a"))')).toEqual([])
    expect(typedThenReadAtOnce('input.typeText("a")\nXCTAssertEqual(other.value as? String, "a")')).toEqual([])
  })

  it('no UI test reads a field at once after typing into it', () => {
    const found = files.flatMap((f) => typedThenReadAtOnce(read(f)).map((n) => `${f}:${n}`))
    expect(found, 'wait for it: XCTAssertTrue(waitForValue(field, expected), ...) (WalnutUITests/ElementWaits.swift)').toEqual([])
  })

  it('the wait is defined once, in the shared helper', () => {
    const defs = files.filter((f) => /func waitForValue\(/.test(read(f)))
    expect(defs).toEqual([HELPER])
  })
})
