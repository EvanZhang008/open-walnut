/**
 * A phone UI test reads a field it typed into only by waiting for the value
 * (ios-native/WalnutUITests/ElementWaits.swift `waitForValue`).
 *
 * `typeText` returns once the keys are sent; the field's value follows a moment later. Read at
 * once, it held the first letters only on a busy runner (2026-11-16, CI on iOS 26.5:
 * ThreadFollowUpVoiceUITests read "Ty" for "Typed without voice", QuickQuestionRenameUITests "Q"
 * for "Quick question"). The class: `<field>.typeText(...)` followed within two lines by
 * `XCTAssertEqual(<field>.value as? String, ...)`. One shared wait, no private copies.
 *
 * A button's state that follows the typing lags the same way (RoutinesUITests: Save still on
 * right after the name was deleted), so `XCTAssertTrue/False(<any>.isEnabled` within two lines
 * after a `typeText` is the same mistake: wait with `waitToMatch(button, "isEnabled == ...")`.
 *
 * Typing moves the page too: the keyboard it raises slides a sheet up, and a tap at a point of an
 * element read while it moved hit nothing (ThreadPushCalendarDraftUITests on CI, iOS 26.5,
 * 2026-11-16: "the all-day switch did not change"). So a `<el>.coordinate(...).tap()` within eight
 * lines after a `typeText` comes after `waitStill(<el>)`.
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
    const stateAtOnce = /XCTAssert(?:True|False)\(\s*[\w.\[\]"]+\.isEnabled\b/
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) if (readAtOnce.test(lines[j]) || stateAtOnce.test(lines[j])) found.push(j + 1)
  })
  return found
}

/** Each point tap on an element (not the app) within eight lines after typing, with no `waitStill` of it first. */
export function pointTapWhileMoving(src: string): number[] {
  const lines = src.split('\n')
  const found: number[] = []
  lines.forEach((line, i) => {
    if (!/\.typeText\(/.test(line)) return
    for (let j = i + 1; j <= i + 8 && j < lines.length; j++) {
      const tap = /([\w.\[\]"]+)\.coordinate\(withNormalizedOffset:.*\)\.tap\(\)/.exec(lines[j])
      if (!tap || tap[1] === 'app') continue
      if (!lines.slice(i + 1, j).some((l) => l.includes(`waitStill(${tap[1]})`))) found.push(j + 1)
    }
  })
  return [...new Set(found)]
}

describe('iOS UI tests: a typed field is read by waiting for its value', () => {
  it('finds the read-at-once form and leaves the waited one', () => {
    expect(typedThenReadAtOnce('input.typeText("a")\nXCTAssertEqual(input.value as? String, "a")')).toEqual([2])
    expect(typedThenReadAtOnce('app.field.typeText("a")\n\nXCTAssertEqual(app.field.value as? String, "a")')).toEqual([3])
    expect(typedThenReadAtOnce('input.typeText("a")\nXCTAssertTrue(waitForValue(input, "a"))')).toEqual([])
    expect(typedThenReadAtOnce('input.typeText("a")\nXCTAssertEqual(other.value as? String, "a")')).toEqual([])
    expect(typedThenReadAtOnce('name.typeText("a")\nXCTAssertFalse(app.buttons["save"].isEnabled, "on")')).toEqual([2])
    expect(typedThenReadAtOnce('name.typeText("a")\nXCTAssertTrue(save.isEnabled)')).toEqual([2])
    expect(typedThenReadAtOnce('name.typeText("a")\nXCTAssertTrue(waitToMatch(save, "isEnabled == true"))')).toEqual([])
  })

  it('no UI test reads a field at once after typing into it', () => {
    const found = files.flatMap((f) => typedThenReadAtOnce(read(f)).map((n) => `${f}:${n}`))
    expect(found, 'wait for it: XCTAssertTrue(waitForValue(field, expected), ...) (WalnutUITests/ElementWaits.swift)').toEqual([])
  })

  it('finds a point tap right after typing, and leaves one after waitStill', () => {
    expect(pointTapWhileMoving('t.typeText("a")\nlet s = app.switches["x"]\ns.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()')).toEqual([3])
    expect(pointTapWhileMoving('t.typeText("a")\nwaitStill(s)\ns.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()')).toEqual([])
    expect(pointTapWhileMoving('t.typeText("a")\napp.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()')).toEqual([])
  })

  it('no UI test taps a point of an element the typing may still be moving', () => {
    const found = files.flatMap((f) => pointTapWhileMoving(read(f)).map((n) => `${f}:${n}`))
    expect(found, 'call waitStill(element) first (WalnutUITests/ElementWaits.swift)').toEqual([])
  })

  it('the waits are defined once, in the shared helper', () => {
    for (const fn of ['waitForValue', 'waitToMatch']) {
      const defs = files.filter((f) => new RegExp(`func ${fn}\\(`).test(read(f)))
      expect(defs, fn).toEqual([HELPER])
    }
  })
})
