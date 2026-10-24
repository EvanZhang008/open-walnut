/**
 * The startup's npm install as a detached job (background-install.ts): it runs
 * in its own process group with its output in a file, the server can stop
 * waiting for it without ending it, and its record keeps a second start from
 * running another npm into the same prefix while it still writes there.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRunning, startDetachedInstall } from '../../../src/core/self-update/background-install.js'
import { processStart } from '../../../src/core/self-update/install-lock.js'

let dir: string
let logFile: string
let record: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bg-install-'))
  logFile = path.join(dir, 'local', 'update-install.log')
  record = path.join(dir, 'local', 'update-installing.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('startDetachedInstall', () => {
  it('runs in its own process group, writes to the log, copies it while someone waits, and ends with its code', async () => {
    const seen: string[] = []
    const job = startDetachedInstall('/bin/sh', ['-c', 'echo one; sleep 0.6; echo two; exit 3'], { logFile, record, version: '0.6.0', tail: (t) => seen.push(t), pollMs: 20 })
    await waitFor(() => fs.existsSync(record))
    const rec = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number; version: string; start: string }
    expect(rec.version).toBe('0.6.0')
    // Its own group: a Ctrl-C or a stop sent to the server's group does not reach it.
    expect(execFileSync('ps', ['-o', 'pgid=', '-p', String(rec.pid)], { encoding: 'utf8' }).trim()).toBe(String(rec.pid))
    expect(await installRunning(record)).toEqual({ pid: rec.pid, version: '0.6.0' })
    expect(await job.done).toBe(3)
    expect(seen.join('')).toBe('one\ntwo\n')
    expect(fs.readFileSync(logFile, 'utf8')).toBe('one\ntwo\n')
    // Over: its record is gone, so the next start may install again.
    expect(fs.existsSync(record)).toBe(false)
  })

  it('quiet stops the copy; the install goes on and its output stays in the log', async () => {
    const seen: string[] = []
    const job = startDetachedInstall('/bin/sh', ['-c', 'echo before; sleep 0.5; echo after'], { logFile, record, version: '0.6.0', tail: (t) => seen.push(t), pollMs: 20 })
    await waitFor(() => seen.join('').includes('before'))
    job.quiet()
    expect(await job.done).toBe(0)
    expect(seen.join('')).toBe('before\n')
    expect(fs.readFileSync(logFile, 'utf8')).toBe('before\nafter\n')
  })

  it('a quick install leaves no record behind', async () => {
    const job = startDetachedInstall('/bin/sh', ['-c', 'exit 0'], { logFile, record, version: '0.6.0', tail: () => {} })
    expect(await job.done).toBe(0)
    // processStart answers after the exit: it must not write a record for a gone pid.
    await new Promise((r) => setTimeout(r, 300))
    expect(fs.existsSync(record)).toBe(false)
  })

  it('an installer that cannot start rejects', async () => {
    const job = startDetachedInstall(path.join(dir, 'no-such-npm'), [], { logFile, record, version: '0.6.0', tail: () => {} })
    await expect(job.done).rejects.toThrow(/ENOENT/)
  })
})

describe('installRunning', () => {
  it('a record whose process is gone, or whose pid now belongs to a later process, does not count and is removed', async () => {
    fs.mkdirSync(path.dirname(record), { recursive: true })
    fs.writeFileSync(record, JSON.stringify({ pid: 9_999_999, version: '0.6.0', start: 'Thu Jan 1 00:00:00 2026' }))
    expect(await installRunning(record)).toBeNull()
    expect(fs.existsSync(record)).toBe(false)
    // This test's own pid is alive, but it did not start at the recorded time.
    fs.writeFileSync(record, JSON.stringify({ pid: process.pid, version: '0.6.0', start: 'Thu Jan 1 00:00:00 2026' }))
    expect(await installRunning(record)).toBeNull()
    expect(fs.existsSync(record)).toBe(false)
    fs.writeFileSync(record, JSON.stringify({ pid: process.pid, version: '0.6.0', start: await processStart(process.pid) }))
    expect(await installRunning(record)).toEqual({ pid: process.pid, version: '0.6.0' })
  })

  it('no record, or one it cannot read, is no install', async () => {
    expect(await installRunning(record)).toBeNull()
    fs.mkdirSync(path.dirname(record), { recursive: true })
    fs.writeFileSync(record, 'not json')
    expect(await installRunning(record)).toBeNull()
  })
})

describe('the pending version', () => {
  it('is written, read back, and forgotten', async () => {
    const { readUnverified, writeUnverified } = await import('../../../src/core/self-update/background-install.js')
    const file = path.join(dir, 'local', 'update-unverified.json')
    expect(readUnverified(file)).toBeNull()
    writeUnverified(file, { version: '0.6.0', from: '0.5.1' })
    expect(readUnverified(file)).toEqual({ version: '0.6.0', from: '0.5.1' })
    writeUnverified(file, null)
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, '{"version":1}')
    expect(readUnverified(file)).toBeNull()
  })
})
