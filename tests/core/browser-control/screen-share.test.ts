/**
 * The server's screen-share state for the browser on its own machine (screen-share.ts): read from
 * macOS's screen-watcher flag by one osascript, only on a Mac with a real home and the experiment
 * on, and told only to an extension polling from this machine.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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

// 2026-11-24: every restart left its reader running (a closed pipe does not end JXA), and 67 readers
// of servers long gone held about 0.8 GB. The reader leaves when the process that spawned it ends.
describe('a reader never outlives its server', () => {
  it.runIf(process.platform === 'darwin')('the reader exits once the process that spawned it is gone', async () => {
    // A shell spawns the reader, prints its pid and exits: the reader is handed to launchd.
    const sh = spawn('/bin/sh', ['-c', '/usr/bin/osascript -l JavaScript -e "$0" $$ 2>/dev/null & echo $!', SHARE_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = await new Promise<number>((resolve) => { let out = ''; sh.stdout!.on('data', (d) => { out += d }); sh.on('exit', () => resolve(Number(out.trim()))) })
    expect(pid).toBeGreaterThan(1)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    try {
      const until = Date.now() + 15_000
      while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
      expect(alive(), 'the reader of a server that ended still runs').toBe(false)
    } finally { if (alive()) process.kill(pid, 'SIGTERM') }
  }, 30_000)

  it('every looping script Walnut hands osascript checks its parent', () => {
    // The class: a long-running osascript the server spawns. A JXA or AppleScript text with an
    // endless loop must leave when its parent changes (getppid), or it outlives every restart.
    const SRC = path.resolve(__dirname, '../../../src')
    const files: string[] = []
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) files.push(p) } }
    walk(SRC)
    const looping = files.filter((f) => { const src = fs.readFileSync(f, 'utf8'); return src.includes('osascript') && /while \((true|\$\.getppid)/.test(src) })
    expect(looping.map((f) => path.relative(SRC, f))).toContain('core/browser-control/screen-share.ts')
    for (const f of looping) expect(fs.readFileSync(f, 'utf8'), path.relative(SRC, f)).toMatch(/getppid/)
  })
})

