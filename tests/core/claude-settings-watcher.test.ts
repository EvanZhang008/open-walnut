/**
 * The Claude Code settings file is watched by polling its stat (fs.watchFile), not with an
 * fs.watch of its folder: on macOS that call held the event loop about half a second at every
 * boot of a loaded Mac (2026-11-24, `watch (native)` in the kept boot stall profiles). A change
 * still reaches the callback once, debounced, including an editor's atomic rename-replace.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watchClaudeSettings } from '../../src/core/claude-settings-watcher.js'

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(true) } else if (Date.now() > end) { clearInterval(t); resolve(false) }
    }, 20)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tempFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prefs-'))
  dirs.push(dir)
  return { dir, file: path.join(dir, 'prefs.json') }
}

describe('Claude settings watcher', () => {
  it('tells a rename-replace of the file once, and nothing for a file beside it', async () => {
    const { dir, file } = tempFile()
    fs.writeFileSync(file, '{}')
    let calls = 0
    stops.push(watchClaudeSettings(() => { calls++ }, { file, pollMs: 50, debounceMs: 50 }))
    fs.writeFileSync(path.join(dir, 'other.json'), '{"x":1}')
    await sleep(300)
    expect(calls).toBe(0)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, '{"model":"x"}')
    fs.renameSync(tmp, file)
    expect(await until(() => calls === 1, 3_000)).toBe(true)
    await sleep(300)
    expect(calls).toBe(1)
  })

  it('starts on a missing file and tells its creation', async () => {
    const { file } = tempFile()
    let calls = 0
    stops.push(watchClaudeSettings(() => { calls++ }, { file, pollMs: 50, debounceMs: 50 }))
    fs.writeFileSync(file, '{}')
    expect(await until(() => calls === 1, 3_000)).toBe(true)
  })
})
