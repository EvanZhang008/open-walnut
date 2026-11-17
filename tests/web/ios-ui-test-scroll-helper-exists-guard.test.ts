/**
 * A phone UI test's scroll helper asks whether its element exists before it reads the element's frame.
 *
 * A SwiftUI lazy list builds a row only near the screen. Reading `.frame` of a row it has not built
 * fails the test at once ("Failed to get matching snapshot"), before the helper scrolls at all
 * (2026-11-17, lane B: InboxItemActionsUITests.reveal read `inbox.item.mail-2.find_task` two
 * 900 pt cards below the fold, so testTaskPreviewOpenAndReturnPreservesSelectorWithoutSelection
 * never reached the task selector). The class: every helper named reveal*, scrollTo* or
 * bringIntoView* that takes an XCUIElement. Its body tests `<element>.exists` before the first
 * `<element>.frame`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const UI_TESTS = path.resolve(__dirname, '../../ios-native/WalnutUITests')
const HELPER = /func\s+((?:reveal|scrollTo|bringIntoView)\w*)\s*\(([^)]*)\)[^{]*\{/g

function body(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i)
  }
  return src.slice(open)
}

function helpers() {
  const found: { file: string; name: string; element: string; text: string }[] = []
  for (const file of fs.readdirSync(UI_TESTS).filter((f) => f.endsWith('.swift'))) {
    const src = fs.readFileSync(path.join(UI_TESTS, file), 'utf8')
    for (const m of src.matchAll(HELPER)) {
      // `_ element: XCUIElement` or `_ e: XCUIElement?`: the local name of each element parameter.
      for (const p of m[2].matchAll(/(\w+)\s*:\s*XCUIElement\??/g)) {
        found.push({ file, name: m[1], element: p[1], text: body(src, m.index! + m[0].length - 1) })
      }
    }
  }
  return found
}

describe('iOS UI test scroll helpers', () => {
  it('finds the helpers it guards', () => {
    expect(helpers().map((h) => h.name)).toContain('reveal')
  })

  it('test that the element exists before reading its frame', () => {
    const bad = helpers().filter(({ element, text }) => {
      const frame = text.search(new RegExp(`\\b${element}\\.frame\\b`))
      if (frame < 0) return false
      const exists = text.search(new RegExp(`\\b${element}\\??\\.exists\\b`))
      return exists < 0 || exists > frame
    })
    expect(bad.map((h) => `${h.file} ${h.name}(${h.element})`)).toEqual([])
  })
})
