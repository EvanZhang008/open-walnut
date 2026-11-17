// A session window in full screen and the dialogs meant to open as wide as one take their size
// from ONE rule (globals.css --sheet-*), so a later change to one never leaves the other behind
// (2026-11-17, the user: "the drawing should be wider by default, like a regular session window").
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
// The selector's own top-level rule (a media query's or a modifier's indented copy is another).
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `${selector} is defined`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

/** Every dialog that opens at the session sheet's size. A new one joins this list. */
const SHEET_SIZED = [
  { file: 'web/src/components/chat/drawing-pad.css', selector: '.drawing-app-dialog' },
]

describe('one size for a full-screen sheet', () => {
  it('the session window in full screen reads its size from the shared variables', () => {
    const globals = read('web/src/styles/globals.css')
    expect(globals).toMatch(/--sheet-width: 95vw;\s*--sheet-height: 95vh;\s*--sheet-max-width: 1400px;/)
    const sheet = rule(globals, '.open-walnut-fullscreen')
    expect(sheet).toMatch(/width: var\(--sheet-width\);/)
    expect(sheet).toMatch(/height: var\(--sheet-height\);/)
    expect(sheet).toMatch(/max-width: var\(--sheet-max-width\);/)
  })

  it.each(SHEET_SIZED)('$selector opens at the sheet size, with no numbers of its own', ({ file, selector }) => {
    const css = rule(read(file), selector)
    const width = css.match(/\n\s*width:([^;]+);/)?.[1] ?? ''
    const height = css.match(/\n\s*height:([^;]+);/)?.[1] ?? ''
    expect(width).toMatch(/var\(--sheet-width\)/)
    expect(width).toMatch(/var\(--sheet-max-width\)/)
    expect(height).toMatch(/var\(--sheet-height\)/)
    expect(`${width} ${height}`, 'no size of its own beside the shared one').not.toMatch(/\b(?!40px)\d+px\b/)
  })
})
