/**
 * The quick bar's two halves speak one language: every message the page posts to the Mac app
 * (web/src/components/quickbar/quickbar-native.ts NativeQuickBarMessage) has a case in the app
 * (desktop/QuickBarPanel.swift for the panel page's, desktop/main.swift for the main window's
 * flag), and every page function the app calls is one the page exposes (QuickBarPageApi).
 * Enumerated from both sources, so a message or call added on one side alone fails here: the
 * native half runs only on a Mac, and nothing else would notice until a person pressed the key.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const bridge = read('web/src/components/quickbar/quickbar-native.ts')
const panel = read('desktop/QuickBarPanel.swift')
const main = read('desktop/main.swift')

const posted = [...bridge.slice(bridge.indexOf('export type NativeQuickBarMessage'), bridge.indexOf('interface Handler')).matchAll(/type: '(\w+)'/g)].map((m) => m[1]!)
const pageApi = (() => {
  const body = bridge.slice(bridge.indexOf('export interface QuickBarPageApi'))
  return [...body.slice(0, body.indexOf('}')).matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]!)
})()

describe('the quick bar bridge between the page and the Mac app', () => {
  it('finds both sides', () => {
    expect(posted).toEqual(expect.arrayContaining(['flag', 'layout', 'open', 'capture']))
    expect(pageApi).toEqual(expect.arrayContaining(['open', 'hotkey', 'attach', 'close']))
  })

  it('the app answers every message the page posts', () => {
    const received = panel.slice(panel.indexOf('fileprivate func received'))
    for (const type of posted.filter((t) => t !== 'flag')) expect(received, `QuickBarPanel.swift has no case "${type}"`).toContain(`case "${type}":`)
    // The switch comes from the main window's page, which main.swift hears.
    expect(main).toMatch(/case QuickBarPanel\.handlerName:[\s\S]{0,400}"flag"[\s\S]{0,300}setEnabled/)
    expect(main).toContain('config.userContentController.add(self, name: QuickBarPanel.handlerName)')
    expect(panel).toContain('static let handlerName = "walnutQuickBar"')
    expect(bridge).toContain('messageHandlers?.walnutQuickBar')
  })

  it('the app calls only what the page exposes', () => {
    const calls = [...panel.matchAll(/call\("(\w+)\(/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThan(0)
    for (const fn of new Set(calls)) expect(pageApi, `the app calls ${fn}() but QuickBarPageApi has none`).toContain(fn)
    const page = read('web/src/components/quickbar/QuickBarPanelPage.tsx')
    for (const fn of pageApi) expect(page, `QuickBarPanelPage.tsx exposes no ${fn}`).toMatch(new RegExp(`\\b${fn}(:|,|\\s*\\()`))
  })

  it('both app builds compile the panel, and the capture makes no sound', () => {
    for (const build of ['desktop/build.sh', 'desktop/build-release.sh']) expect(read(build)).toContain('"$SCRIPT_DIR/QuickBarPanel.swift"')
    expect(panel).toMatch(/arguments = \["-i", "-x"/)
  })
})
