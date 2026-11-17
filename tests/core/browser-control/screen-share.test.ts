/**
 * The server's screen-share state for the browser on its own machine (screen-share.ts): read from
 * macOS's screen-watcher flag by one osascript, only on a Mac with a real home and the experiment
 * on, and told only to an extension polling from this machine.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SHARE_SCRIPT, _resetScreenShareForTesting, _setScreenSharedForTesting, onScreenShareChange, parseShareLine, screenShared, shareStateForPoll, shareWatchAllowed } from '../../../src/core/browser-control/screen-share'

afterEach(() => _resetScreenShareForTesting())

describe('the screen-share reader', () => {
  it('reads the one flag macOS sets for any screen, window or app capture', () => {
    expect(SHARE_SCRIPT).toContain("ObjC.bindFunction('CGSIsScreenWatcherPresent', ['bool', []])")
    expect(parseShareLine('shared\n')).toBe(true)
    expect(parseShareLine(' clear')).toBe(false)
    expect(parseShareLine('execution error: something')).toBeUndefined()
  })

  it('runs only on a Mac whose home is real (never in a test or an ephemeral server)', () => {
    expect(shareWatchAllowed('linux', () => true)).toBe(false)
    expect(shareWatchAllowed('darwin', () => false)).toBe(false)
    expect(shareWatchAllowed('darwin', () => true)).toBe(true)
  })

  it('a browser on another machine hears nothing; here (Linux, a test home) neither does this one', async () => {
    expect(await shareStateForPoll(false)).toBeUndefined()
    expect(await shareStateForPoll(true)).toBeUndefined()
  })

  it('a change tells every waiter once; the same state again tells none', () => {
    let n = 0
    const off = onScreenShareChange(() => { n++ })
    _setScreenSharedForTesting(true)
    _setScreenSharedForTesting(true)
    expect(screenShared()).toBe(true)
    _setScreenSharedForTesting(false)
    expect(n).toBe(2)
    off()
    _setScreenSharedForTesting(true)
    expect(n).toBe(2)
  })

  // 2026-11-17: the route judged "this machine" by the trusted-caller check, which an extension's
  // own origin always fails, so the user's Chrome never heard a share.
  it('the poll route judges a local browser by where it runs, not by the trusted-caller check', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../../src/web/routes/browser-v1.ts', import.meta.url), 'utf8')
    const line = src.split('\n').find((l) => /const local = /.test(l)) ?? ''
    expect(line).toMatch(/fromThisMachine\(req\)/)
  })
})
