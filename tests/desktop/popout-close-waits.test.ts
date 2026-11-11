/**
 * A pop-out window closes only after its page answers whether it holds unsaved work
 * (windowShouldClose in desktop/main.swift asks the page, then closes or shows the discard sheet),
 * so what Command-W did is known only later. 2026-11-11, nightly-extra-tests run 43021612722: the
 * pop-out test asserted `!window.isVisible` right after the key, and a window the discard sheet had
 * shown was still visible for that moment, so the run crashed on a precondition. The key helper
 * asserts no window state, and every press is followed by a wait for its outcome. This fails on a
 * native window test that checks a close right after the key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join(__dirname)
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.swift'))

describe('native window tests wait for what a close key did', () => {
  const withKey = files.filter((f) => fs.readFileSync(path.join(DIR, f), 'utf8').includes('func pressCloseKey('))

  it('finds the pop-out test', () => {
    expect(withKey).toContain('popout-window-tests.swift')
  })

  for (const file of withKey) {
    const lines = fs.readFileSync(path.join(DIR, file), 'utf8').split('\n')

    it(`${file}: the key helper checks no window state`, () => {
      const start = lines.findIndex((l) => l.includes('func pressCloseKey('))
      const end = lines.findIndex((l, i) => i > start && /^ {4}\}/.test(l))
      // after the key is pressed, nothing in the helper asserts what it did
      const press = lines.findIndex((l, i) => i > start && l.includes('performKeyEquivalent'))
      expect(press).toBeGreaterThan(start)
      const after = lines.slice(press + 1, end + 1).filter((l) => !l.trim().startsWith('//'))
      expect(after.filter((l) => /precondition|assert|isVisible|attachedSheet|popoutWindows/.test(l))).toEqual([])
    })

    it(`${file}: every press is followed by a wait`, () => {
      const presses = lines.map((l, i) => [l, i] as const).filter(([l]) => /try pressCloseKey\(/.test(l))
      expect(presses.length).toBeGreaterThan(0)
      const bare = presses.filter(([l, i]) => {
        const next = lines.slice(i + 1, i + 3)
        // two presses in a row (the second one while the first is still asking) count as one
        if (next[0]?.includes('try pressCloseKey(')) return false
        return !next.some((n) => n.includes('try await wait {'))
      })
      expect(bare.map(([l, i]) => `${i + 1}: ${l.trim()}`)).toEqual([])
    })
  }
})
