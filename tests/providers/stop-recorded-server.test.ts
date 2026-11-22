/**
 * The host's one Walnut service, starting, ends the follower child an older daemon left for its
 * home (host-server-core.ts stopRecordedServer): only the recorded pid whose start time still
 * matches, its whole group, then its pid file; the spec stays for a rollback.
 * MACHINE SAFETY: the only process signalled is a `sleep` this test spawned in its own group.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stopRecordedServer } from '../../src/providers/host-server-core.js'
import { defaultReadStartTime } from '../../src/providers/daemon-core.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

function dirWith(pid: unknown, startTime: unknown): { pidFile: string; specFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recorded-'))
  roots.push(root)
  const pidFile = path.join(root, 'server-0123456789abcdef.pid')
  const specFile = path.join(root, 'server-0123456789abcdef.json')
  fs.writeFileSync(pidFile, JSON.stringify({ pid, startTime }))
  fs.writeFileSync(specFile, '{"spec":{}}')
  return { pidFile, specFile }
}

describe('stopRecordedServer', () => {
  it('ends the recorded follower group, removes its pid file and keeps its spec', async () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    const pid = child.pid!
    expect(pid).toBeGreaterThan(1)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const { pidFile, specFile } = dirWith(pid, defaultReadStartTime(fs, pid))
    const signals: string[] = []
    const verdict = await stopRecordedServer({
      pidFile, fs,
      startTimeOf: (p) => defaultReadStartTime(fs, p),
      killGroup: (p, signal) => { signals.push(signal); if (p === pid) process.kill(-p, signal) },
    })
    await exited
    expect(verdict).toBe('stopped')
    expect(signals).toEqual(['SIGTERM'])
    expect(fs.existsSync(pidFile)).toBe(false)
    expect(fs.existsSync(specFile)).toBe(true)
  })

  it('a pid whose start time changed is another process: never signalled', async () => {
    const { pidFile } = dirWith(process.pid, 'not-this-start-time')
    const signals: string[] = []
    const verdict = await stopRecordedServer({ pidFile, fs, startTimeOf: (p) => defaultReadStartTime(fs, p), killGroup: (_p, s) => { signals.push(s) } })
    expect(verdict).toBe('none')
    expect(signals).toEqual([])
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it('no pid file, or one naming no real pid, is nothing to stop', async () => {
    const signals: string[] = []
    const kill = (_p: number, s: string) => { signals.push(s) }
    expect(await stopRecordedServer({ pidFile: path.join(os.tmpdir(), 'no-such-dir-x', 'a.pid'), fs, startTimeOf: () => 'x', killGroup: kill })).toBe('none')
    expect(await stopRecordedServer({ pidFile: dirWith(1, 'x').pidFile, fs, startTimeOf: () => 'x', killGroup: kill })).toBe('none')
    expect(signals).toEqual([])
  })

  it('one that outlives SIGTERM is killed; one that outlives both stays recorded', async () => {
    const { pidFile } = dirWith(99999, 'st')
    let alive = true
    const signals: string[] = []
    const killed = await stopRecordedServer({
      pidFile, fs, killAfterMs: 50, pollMs: 10,
      startTimeOf: () => (alive ? 'st' : null), exists: () => alive,
      killGroup: (_p, s) => { signals.push(s); if (s === 'SIGKILL') alive = false },
    })
    expect(killed).toBe('killed')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    const stays = dirWith(99998, 'st')
    const verdict = await stopRecordedServer({ pidFile: stays.pidFile, fs, killAfterMs: 20, pollMs: 10, startTimeOf: () => 'st', killGroup: () => {} })
    expect(verdict).toBe('stays')
    expect(fs.existsSync(stays.pidFile)).toBe(true)
  }, 10_000)

  // Review A3b S34-L1: ps timing out on a loaded Mac read as "another process", the pid file went
  // while the follower ran on, and a daemon put back started a second follower beside it.
  it('a live pid whose start time does not read is never signalled and keeps its pid file', async () => {
    const { pidFile } = dirWith(99997, 'st')
    const signals: string[] = []
    let reads = 0
    const verdict = await stopRecordedServer({
      pidFile, fs, unknownRetryMs: 5,
      startTimeOf: () => { reads++; return null }, exists: () => true,
      killGroup: (_p, s) => { signals.push(s) },
    })
    expect(verdict).toBe('unknown')
    expect(reads, 'asked again before it gives up').toBe(3)
    expect(signals).toEqual([])
    expect(fs.existsSync(pidFile)).toBe(true)
  })

  it('an unreadable start time that reads on a later try is stopped; a gone pid is nothing to stop', async () => {
    const later = dirWith(99996, 'st')
    let reads = 0
    let alive = true
    const signals: string[] = []
    const stopped = await stopRecordedServer({
      pidFile: later.pidFile, fs, unknownRetryMs: 5, pollMs: 5,
      startTimeOf: () => (++reads === 1 ? null : alive ? 'st' : null), exists: () => alive,
      killGroup: (_p, s) => { signals.push(s); alive = false },
    })
    expect(stopped).toBe('stopped')
    expect(signals).toEqual(['SIGTERM'])
    expect(fs.existsSync(later.pidFile)).toBe(false)
    const gone = dirWith(99995, 'st')
    expect(await stopRecordedServer({ pidFile: gone.pidFile, fs, startTimeOf: () => null, exists: () => false, killGroup: () => { throw new Error('never') } })).toBe('none')
    expect(fs.existsSync(gone.pidFile)).toBe(false)
  })
})
