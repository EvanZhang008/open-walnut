/**
 * The replica cluster's signal guards (tests/helpers/replica-cluster.ts, WP7 S8):
 * a signal goes only to a process this harness started, checked right before it
 * is sent. A pid is pinned with its start time and command line; a pid whose
 * start time or command changed (gone and reused) is never signalled. A direct
 * child is signalled only while it runs (an exited child's pid may be anyone's).
 * Processes are found by the START of their command line (an interpreter and a
 * script of the cluster's own), never by a word anywhere in it.
 *
 * Every process signalled here is a child this file spawned; a forged pin is
 * only ever pointed at one of them too.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { _signalSafetyForTesting as g } from '../helpers/replica-cluster.js'

const kids: ChildProcess[] = []
let dir = ''

function idle(script: string): ChildProcess {
  const proc = spawn(process.execPath, [script], { stdio: 'ignore' })
  kids.push(proc)
  return proc
}
const running = (p: ChildProcess) => p.exitCode === null && p.signalCode === null
const exited = (p: ChildProcess) => new Promise<void>((resolve) => { if (!running(p)) resolve(); else p.once('exit', () => resolve()) })
async function started(p: ChildProcess): Promise<void> {
  // The command line `ps` shows is the script's once node runs it.
  for (let i = 0; i < 100; i++) {
    if (g.pin('probe', p.pid!, (c) => c.includes(path.basename(dir)))) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('the child never showed its command line')
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-sig-'))
  fs.writeFileSync(path.join(dir, 'idle.cjs'), 'setInterval(() => {}, 1 << 30)\n')
  fs.writeFileSync(path.join(dir, 'quick.cjs'), 'process.exit(0)\n')
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  for (const k of kids) if (running(k)) k.kill('SIGKILL')
  await Promise.all(kids.map(exited))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the cluster signals only the processes it started', () => {
  it('a pinned child is signalled while it is still that process', async () => {
    const a = idle(path.join(dir, 'idle.cjs'))
    await started(a)
    const pinned = g.pin('a', a.pid!, (c) => c.startsWith(`${process.execPath} ${path.join(dir, 'idle.cjs')}`))
    expect(pinned).not.toBeNull()
    expect(g.stillPinned(pinned!)).toBe(true)
    expect(g.signalPinned(pinned!, 'SIGTERM')).toBe(true)
    await exited(a)
    expect(a.signalCode).toBe('SIGTERM')
    // Gone: never signalled again.
    expect(g.stillPinned(pinned!)).toBe(false)
    expect(g.signalPinned(pinned!, 'SIGTERM')).toBe(false)
  })

  it('a pid whose start time or command line changed (reused) is never signalled', async () => {
    const b = idle(path.join(dir, 'idle.cjs'))
    await started(b)
    const real = g.pin('b', b.pid!, () => true)!
    const kill = vi.spyOn(process, 'kill')
    // The same pid, pinned when another process held it.
    for (const forged of [{ ...real, started: 'Thu Jan  1 00:00:00 1970' }, { ...real, command: `${process.execPath} /elsewhere/acme-daemon.cjs` }]) {
      expect(g.stillPinned(forged)).toBe(false)
      expect(g.signalPinned(forged, 'SIGTERM')).toBe(false)
    }
    expect(kill).not.toHaveBeenCalled()
    expect(running(b)).toBe(true)
  })

  it('pins nothing that is not a plain process of ours', async () => {
    const c = idle(path.join(dir, 'idle.cjs'))
    await started(c)
    expect(g.pin('init', 1, () => true)).toBeNull()
    expect(g.pin('zero', 0, () => true)).toBeNull()
    expect(g.pin('nan', Number.NaN, () => true)).toBeNull()
    expect(g.pin('self', process.pid, () => true)).toBeNull()
    expect(g.pin('looks-wrong', c.pid!, () => false)).toBeNull()
    expect(g.signalPinned(null, 'SIGTERM')).toBe(false)
  })

  it('an exited child is never signalled (its pid may be anyone\'s by now)', async () => {
    const q = spawn(process.execPath, [path.join(dir, 'quick.cjs')], { stdio: 'ignore' })
    kids.push(q)
    await exited(q)
    const kill = vi.spyOn(q, 'kill')
    expect(g.signalChild(q, 'SIGTERM')).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    expect(g.signalChild(null, 'SIGTERM')).toBe(false)
    const live = idle(path.join(dir, 'idle.cjs'))
    expect(g.signalChild(live, 'SIGTERM')).toBe(true)
    await exited(live)
  })

  it('finds processes by the start of their command line only', async () => {
    const d = idle(path.join(dir, 'idle.cjs'))
    await started(d)
    expect(g.pidsRunning(`${process.execPath} ${path.join(dir, 'idle.cjs')}`)).toContain(d.pid)
    // The script's path is in the command line, but not at its start.
    expect(g.pidsRunning(path.join(dir, 'idle.cjs'))).not.toContain(d.pid)
    expect(g.pidsRunning(path.basename(dir))).toEqual([])
  })

  it('reads a pid file in both shapes, and never a pid of 1 or less', () => {
    const f = path.join(dir, 'pid')
    const read = (text: string) => { fs.writeFileSync(f, text); return g.readPid(f) }
    expect(read(JSON.stringify({ pid: 4242, startTime: 'Thu Oct 16 03:00:00 2026' }))).toBe(4242)
    expect(read('4243\n')).toBe(4243)
    expect(read('4244 extra words')).toBe(4244)
    expect(read(JSON.stringify({ pid: 1 }))).toBe(0)
    expect(read('{not json')).toBe(0)
    expect(g.readPid(path.join(dir, 'missing'))).toBe(0)
  })
})
