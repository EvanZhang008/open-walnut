/**
 * The rehearsal and the Mac app smoke stop the daemon they started, and only
 * return once it is gone. 2026-10-07: the 0.6.5 smoke passed every step, sent
 * the daemon SIGTERM, removed its work dir at once and failed on
 * `rmdir .../daemon: ENOTEMPTY`, because the daemon was still writing there.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { stopOwnDaemon } from '../../scripts/release-rehearsal/own-daemon.mjs'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-daemon-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A stand-in daemon: records its pid in `dir`, and on SIGTERM keeps writing there for a while. */
async function fakeDaemon(dir: string, onTerm: 'linger' | 'ignore') {
  fs.mkdirSync(dir, { recursive: true })
  const script = onTerm === 'linger'
    ? `process.on('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'last-words.log'))}, 'bye'); process.exit(0) }, 400)); setInterval(() => {}, 1000)`
    : `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))
  fs.writeFileSync(path.join(dir, 'daemon.pid'), `${child.pid}\n`)
  return child
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('stopOwnDaemon', () => {
  it('returns only after the daemon has exited, so its dir can be removed', async () => {
    const dir = path.join(tmp, 'linger', 'daemon')
    const child = await fakeDaemon(dir, 'linger')
    expect(await stopOwnDaemon(dir)).toBe(child.pid)
    expect(alive(child.pid!)).toBe(false)
    // The write it made while stopping is already on disk, and nothing comes after it.
    expect(fs.readFileSync(path.join(dir, 'last-words.log'), 'utf8')).toBe('bye')
    expect(() => fs.rmSync(path.join(tmp, 'linger'), { recursive: true })).not.toThrow()
  })

  it('kills a daemon that does not stop within the grace period', async () => {
    const dir = path.join(tmp, 'stubborn', 'daemon')
    const child = await fakeDaemon(dir, 'ignore')
    const t0 = Date.now()
    expect(await stopOwnDaemon(dir, { graceMs: 500 })).toBe(child.pid)
    expect(alive(child.pid!)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('signals nothing without a live pid of its own', async () => {
    const kill = vi.spyOn(process, 'kill')
    try {
      const none = path.join(tmp, 'none')
      fs.mkdirSync(none, { recursive: true })
      expect(await stopOwnDaemon(none)).toBeNull()
      for (const bad of ['1', '0', '-5', 'abc', '']) {
        fs.writeFileSync(path.join(none, 'daemon.pid'), bad)
        expect(await stopOwnDaemon(none), bad).toBeNull()
      }
      expect(kill.mock.calls.filter(([, sig]) => sig !== 0 && sig !== undefined)).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })

  it('is the one place a rehearsal or smoke script signals its daemon', () => {
    for (const rel of ['scripts/desktop-smoke.mjs', 'scripts/release-rehearsal/walnut.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      expect(src, rel).toContain('stopOwnDaemon(')
      expect(src, rel).not.toMatch(/daemon\.pid/)
    }
  })
})
