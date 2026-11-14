/**
 * The Mac app's native tests (tests/desktop/*.swift, run only by the nightly Mac job) keep up
 * with the app and the web page they drive. 2026-11-14, nightly run 43601554961: both failed
 * because of changes that ran no native test before landing.
 *   - The File menu moved Command-W to "Close Column" and "Close Window" to Command-Shift-W;
 *     the pop-out test still required "Close Window" on Command-W and stopped at its first check.
 *   - A first visit began folding every region of a board that holds work; the Recent test
 *     clears the page's storage and never found the task row it clicks, because the browser
 *     suite's storage presets (playwright.config.ts storageState, tests/e2e/browser/pw-storage.ts) were not set there.
 * Enumerated from the source: every item of the app's File menu, and every storage preset of the
 * browser suite against every native test that clears the page's storage.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RETURNING_VISITOR_FOLDS } from '../e2e/browser/pw-storage.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('the pop-out test checks every File menu item of the app', () => {
  const main = read('desktop/main.swift')
  const start = main.indexOf('let fileMenu = NSMenu(title: "File")')
  const end = main.indexOf('fileMenuItem.submenu = fileMenu', start)
  const block = main.slice(start, end)
  const items = [...block.matchAll(/NSMenuItem\(title: "([^"]+)", action: [^,]+, keyEquivalent: "([^"]*)"\)/g)]
    .map((m) => ({ title: m[1]!, key: m[2]! }))
  const popout = read('tests/desktop/popout-window-tests.swift')

  it('finds the File menu items', () => {
    expect(start).toBeGreaterThan(0)
    expect(items.map((i) => i.title)).toEqual(expect.arrayContaining(['Close Column', 'Close Window']))
  })

  it.each(items.map((i) => [i.title, i] as const))('%s', (title, { key }) => {
    const at = popout.indexOf(`item(withTitle: "${title}")`)
    expect(at, `tests/desktop/popout-window-tests.swift checks no File menu item "${title}"`).toBeGreaterThan(0)
    expect(popout.slice(at, at + 400)).toContain(`keyEquivalent == "${key}"`)
  })
})

describe('a native test that clears the page storage sets the browser suite presets again', () => {
  // The suite's own presets (playwright.config.ts storageState) and the folds every config adds.
  const stateLine = read('playwright.config.ts').split('\n').find((l) => l.includes('storageState:')) ?? ''
  const extra = [...stateLine.matchAll(/\{ name: '([^']+)', value: '([^']*)' \}/g)].map((m) => ({ name: m[1]!, value: m[2]! }))
  const presets = [...extra, ...RETURNING_VISITOR_FOLDS]
  const clearing = fs.readdirSync(path.join(ROOT, 'tests/desktop')).filter((f) => f.endsWith('.swift'))
    .map((f) => ({ file: `tests/desktop/${f}`, text: read(`tests/desktop/${f}`) }))
    .filter(({ text }) => text.includes('localStorage.clear()'))

  it('finds the presets and the native tests that clear storage', () => {
    expect(presets.map((p) => p.name)).toEqual(expect.arrayContaining(['walnut-todo-panel-design', 'walnut-todo-collapsed-sections']))
    expect(clearing.map((c) => c.file)).toContain('tests/desktop/recent-human-touch-tests.swift')
  })

  it.each(clearing.map((c) => [c.file, c] as const))('%s', (_file, { text }) => {
    const missing = presets.filter((p) => !text.includes(`localStorage.setItem('${p.name}','${p.value}')`))
    expect(missing, 'set these after localStorage.clear(), as playwright.config.ts storageState does').toEqual([])
  })
})
