/**
 * A phone UI test checks that a sheet closed with `waitOffScreen(element, timeout:)`
 * (ios-native/WalnutUITests/ElementWaits.swift): the element is gone or has no frame.
 *
 * A sheet that closed can leave its views in the accessibility tree a while with a frame of
 * {inf, inf, 0, 0}, so `exists == false` never comes though nothing shows (2026-11-26, CI on
 * iOS 26.6: RoutinesUITests' Edit sheet had closed, yet `routines.editor.taskCurrent` still
 * existed at {inf, inf}). The class: an `exists == false` expectation named for a close
 * (`closed`, `sheetClosed`), the name every sheet-closed check in these tests used.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const UI_TESTS = path.resolve(__dirname, '../../ios-native/WalnutUITests')
const HELPER = 'ElementWaits.swift'

const files = fs.readdirSync(UI_TESTS).filter((f) => f.endsWith('.swift'))
const read = (f: string) => fs.readFileSync(path.join(UI_TESTS, f), 'utf8')

/** Line numbers of sheet-closed checks that read `exists` alone. */
export function existsOnlyCloses(src: string): number[] {
  const found: number[] = []
  src.split('\n').forEach((line, i) => {
    if (/\b(?:let|var)\s+\w*[cC]losed\w*\s*=\s*expectation\(for:\s*NSPredicate\(format:\s*"exists == (?:false|0)"/.test(line)) {
      found.push(i + 1)
    }
  })
  return found
}

describe('iOS UI tests: a sheet closed means it is off the screen', () => {
  it('finds an exists-only close and leaves the helper', () => {
    expect(existsOnlyCloses('let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: name)')).toEqual([1])
    expect(existsOnlyCloses('let sheetClosed = expectation(for: NSPredicate(format: "exists == 0"), evaluatedWith: x)')).toEqual([1])
    expect(existsOnlyCloses('XCTAssertTrue(waitOffScreen(name, timeout: 5), "the editor did not close")')).toEqual([])
    expect(existsOnlyCloses('let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row)')).toEqual([])
  })

  it('no UI test checks a sheet closed by exists alone', () => {
    const found = files.flatMap((f) => existsOnlyCloses(read(f)).map((n) => `${f}:${n}`))
    expect(found, 'use waitOffScreen(element, timeout:) (WalnutUITests/ElementWaits.swift)').toEqual([])
  })

  it('the helper is defined once, in the shared file', () => {
    const defs = files.filter((f) => /func waitOffScreen\(/.test(read(f)))
    expect(defs).toEqual([HELPER])
  })
})
