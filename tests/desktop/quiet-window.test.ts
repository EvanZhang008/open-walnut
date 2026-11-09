/**
 * No window the Mac app or its native tests make plays the alert sound for a key nobody handles
 * (2026-11-08: a native test driver sent Escape, Enter and arrow keys into a web view on a Mac a
 * person was near, and AppKit's NSBeep for each unhandled key sounded through the night). The
 * window at the end of the responder chain answers an unhandled keyDown with NSBeep unless it
 * says otherwise; QuietKeyWindow (desktop/main.swift) says otherwise. Checked on a muted Mac by
 * the system log, never by listening: a plain NSWindow's process opened its connection to the
 * system sound server on the first such key, a QuietKeyWindow's never did.
 *
 * Enumerated from the source: every Swift file outside the iOS app that makes a window must make
 * a QuietKeyWindow, every NSWindow or NSPanel subclass must swallow keyDown the same way, and
 * every file that makes key events of its own is listed here with why it cannot beep.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const swiftFiles = execFileSync('git', ['ls-files', '*.swift', '*.m', '*.mm'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.startsWith('ios-native/'))
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8')
  // Comments say what the code does; only code counts.
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** Windows made some other way, each with why no key reaches it. */
const OTHER_WINDOWS: Record<string, string> = {
  'desktop/GlobalDictation.swift': 'the dictation HUD: a borderless non-activating NSPanel that ignores the mouse, so it never becomes key and no key event reaches it',
}

/** Files that make key events of their own, each with why no unhandled key beeps. */
const KEY_MAKERS: Record<string, string> = {
  'desktop/GlobalDictation.swift': 'types the text the person just dictated where they put the cursor, at their own hotkey press: their own typing, not a test',
  'tests/desktop/popout-window-tests.swift': 'sends Command-W to the main menu performKeyEquivalent, which closes the window; the event never enters the responder chain',
}

const makesWindow = /\bNS(?:Window|Panel)\s*\(/
const makesKeys = /NSEvent\s*\.\s*keyEvent\s*\(|CGEvent\s*\(\s*keyboardEventSource|CGEventCreateKeyboardEvent|CGPostKeyboardEvent/

describe('every window of the Mac app swallows a key nobody handles', () => {
  it('QuietKeyWindow swallows only keyDown and leaves every other action to AppKit', () => {
    const src = read('desktop/main.swift')
    const body = src.match(/final class QuietKeyWindow: NSWindow \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(body).toMatch(/override func noResponder\(for eventSelector: Selector\)/)
    expect(body).toMatch(/if eventSelector == #selector\(NSResponder\.keyDown\(with:\)\) \{ return \}/)
    expect(body).toMatch(/super\.noResponder\(for: eventSelector\)/)
    // It sits above the entry point, so the native tests (which compile main.swift up to it) get it.
    const raw = fs.readFileSync(path.join(ROOT, 'desktop/main.swift'), 'utf8')
    expect(raw.indexOf('// MARK: - Entry Point')).toBeGreaterThan(raw.indexOf('final class QuietKeyWindow'))
  })

  it('found the files it judges', () => {
    expect(swiftFiles).toContain('desktop/main.swift')
    expect(swiftFiles).toContain('tests/desktop/update-window-tests.swift')
  })

  for (const f of swiftFiles) {
    it(f, () => {
      const src = read(f)
      if (makesWindow.test(src)) expect(OTHER_WINDOWS[f], `${f} makes an NSWindow or NSPanel: make a QuietKeyWindow, or list it in OTHER_WINDOWS with why no key reaches it`).toBeTruthy()
      for (const m of src.matchAll(/class\s+(\w+)\s*:\s*NS(?:Window|Panel)\b[^{]*\{/g)) {
        const rest = src.slice(m.index! + m[0].length)
        const body = rest.slice(0, rest.search(/\n\}/) + 1)
        expect(body, `${f}: ${m[1]} is a window class: it swallows keyDown in noResponder(for:) as QuietKeyWindow does`).toMatch(/override func noResponder\(for[\s\S]*keyDown\(with:\)/)
      }
      if (makesKeys.test(src)) expect(KEY_MAKERS[f], `${f} makes key events: list it in KEY_MAKERS with why no unhandled key beeps (a QuietKeyWindow target, a focused text field checked first)`).toBeTruthy()
    })
  }

  it('lists nothing that no longer needs it', () => {
    for (const f of Object.keys(OTHER_WINDOWS)) expect(makesWindow.test(read(f)), f).toBe(true)
    for (const f of Object.keys(KEY_MAKERS)) expect(makesKeys.test(read(f)), f).toBe(true)
  })
})
