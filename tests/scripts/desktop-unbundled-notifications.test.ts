/**
 * The Mac app's window tests compile the whole app as a bare binary with no app bundle
 * (scripts/test-desktop-popout.sh, test-desktop-update-windows.sh). There
 * `UNUserNotificationCenter.current()` throws "bundleProxyForCurrentProcess is nil" and ends the
 * process: 2026-11-10, nightly run 43003008304, the pop-out tests aborted when the page asked the
 * notification bridge for its status. Every call reads the center only when the program has a
 * bundle; this fails on a new call that does not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SWIFT_DIRS = ['desktop', 'src/data', 'tests/desktop']
const GUARD = 'Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()'

const calls = SWIFT_DIRS.flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
  .filter((f) => f.endsWith('.swift'))
  .flatMap((f) => fs.readFileSync(path.join(ROOT, dir, f), 'utf8').split('\n')
    .map((line, i) => ({ at: `${dir}/${f}:${i + 1}`, line }))
    .filter(({ line }) => /UNUserNotificationCenter\s*\.\s*current\s*\(/.test(line) && !line.trim().startsWith('//'))))

describe('the notification center in a program with no app bundle', () => {
  it('is read only behind the bundle check, at every call', () => {
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.line, c.at).toContain(GUARD)
  })

  it('leaves NotificationBridge working with no center: status off, nothing posted, nothing kept', () => {
    const src = fs.readFileSync(path.join(ROOT, 'desktop/NotificationBridge.swift'), 'utf8')
    expect(src).toContain('private var center: UNUserNotificationCenter? {')
    expect(src).toContain('center?.delegate = self')
    expect(src).toContain('guard let center else { done("off"); return }')
    expect(src).toContain('guard let center else { done(["posted": false, "status": "off"]); return }')
    expect(src).toContain('guard let center else { replyHandler(["removed": 0], nil); return }')
    // No call left that would force the optional open.
    expect(src).not.toMatch(/center!\./)
  })

  it('is in the app the window tests compile', () => {
    const list = fs.readFileSync(path.join(ROOT, 'scripts/lib/desktop-app-sources.sh'), 'utf8')
    expect(list).toContain('"$ROOT"/desktop/*.swift')
    for (const s of ['scripts/test-desktop-popout.sh', 'scripts/test-desktop-update-windows.sh']) {
      expect(fs.readFileSync(path.join(ROOT, s), 'utf8'), s).toContain('scripts/lib/desktop-app-sources.sh')
    }
  })
})
