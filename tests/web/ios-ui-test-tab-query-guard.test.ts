/**
 * A phone UI test reaches a tab through the tab bar, never by the tab's name on the whole app
 * (2026-11-15, CI: `app.buttons["Tasks"]` in WatchingTierUITests matched the tab bar's Tasks and
 * the Tasks button on Main's chat bar, which the Chat tab had reopened from the test before, and
 * the tap failed on "Multiple matching elements found"). A tab's name is not unique on screen:
 * Main's chat bar has Threads, Tasks and Brief, the Tasks page's drawer button reads "Tasks".
 *
 * The tabs are read from `MainTabView` (`.tabItem { Label("<name>"`), so a new tab is covered
 * the day it lands. Every UI test goes through `app.tab(.<case>)`
 * (ios-native/WalnutUITests/AppTabs.swift); a query for a tab's name is allowed only on a scope
 * listed below, with the reason it is not the tab.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const UI_TESTS = path.join(ROOT, 'ios-native/WalnutUITests')
const TAB_VIEW = path.join(ROOT, 'ios-native/Walnut/App/WalnutApp.swift')
const HELPER = 'AppTabs.swift'

/** The receiver a tab-named button query may hang off, and why that button is not the tab. */
const ALLOWED_SCOPES: Record<string, string> = {
  navigationBars: 'a page\'s Back button, named after the page it returns to',
  picker: 'QuickQuestionRenameUITests: the project picker\'s Inbox row',
}

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function tabNames(): string[] {
  const src = code(fs.readFileSync(TAB_VIEW, 'utf8'))
  return [...src.matchAll(/\.tabItem\s*\{\s*Label\(\s*"([^"]+)"/g)].map((m) => m[1])
}

describe('iOS UI tests: a tab is found in the tab bar', () => {
  const tabs = tabNames()
  const files = fs.readdirSync(UI_TESTS).filter((f) => f.endsWith('.swift'))

  it('reads the five tabs from MainTabView', () => {
    expect(tabs).toEqual(['Chat', 'Inbox', 'Notes', 'Tasks', 'Settings'])
  })

  it('the helper names every tab and looks only in the tab bar', () => {
    const src = code(fs.readFileSync(path.join(UI_TESTS, HELPER), 'utf8'))
    const cases = [...src.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map((m) => m[1])
    expect(cases.sort()).toEqual([...tabs].sort())
    expect(src).toMatch(/tabBars\.buttons\[tab\.rawValue\]/)
  })

  it('no UI test queries a button by a tab\'s name outside an allowed scope', () => {
    const names = tabs.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    // `[<receiver>.]buttons["<tab>"]`, and the same through `matching(identifier:)` or a label
    // predicate, over the whole file so a chain split across lines counts too. With no named
    // receiver (`buttons[...]` inside an XCUIApplication extension, `XCUIApplication().buttons`)
    // the query is on the whole app.
    const query = new RegExp(
      String.raw`(?:\b(\w+)\s*\.\s*|(?<![\w.])|\)\s*\.\s*)buttons\s*(?:\[\s*"(${names})"\s*\]|\.matching\(\s*identifier:\s*"(${names})"\s*\)|\.matching\(\s*NSPredicate\(\s*format:\s*"label\s*==\s*'(${names})'"\s*\)\s*\))`,
      'g',
    )
    const offenders: string[] = []
    for (const file of files) {
      if (file === HELPER) continue
      const src = code(fs.readFileSync(path.join(UI_TESTS, file), 'utf8'))
      for (const m of src.matchAll(query)) {
        const receiver = m[1]
        if (receiver && Object.hasOwn(ALLOWED_SCOPES, receiver)) continue
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${file}:${line}: ${m[0].replace(/\s+/g, ' ').trim()}`)
      }
    }
    expect(offenders, 'use app.tab(.<tab>) (WalnutUITests/AppTabs.swift), or list the scope with its reason').toEqual([])
  })

  it('every allowed scope is still in use', () => {
    const all = files.map((f) => code(fs.readFileSync(path.join(UI_TESTS, f), 'utf8'))).join('\n')
    const unused = Object.keys(ALLOWED_SCOPES).filter((scope) => !new RegExp(String.raw`\b${scope}\s*\.\s*buttons\s*\[`).test(all))
    expect(unused).toEqual([])
  })
})
