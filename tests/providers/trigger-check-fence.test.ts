/**
 * runCheckProcess's Demo fence (trigger-check-core.ts): the final spawn gate, the abort that
 * ends the check's own group the way its deadline does, and the pid set that only a real
 * 'close' leaves. Everything is a stub: `spawn` returns a fake child and `process.kill` only
 * records, so no process starts and no signal is sent.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

import { spawn } from 'node:child_process'
import { runCheckProcess, CHECK_SETTLE_GRACE_MS } from '../../src/providers/trigger-check-core.js'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { on: () => {}, end: vi.fn() }
  kill = vi.fn(() => true)
  constructor(public pid: number | undefined) { super() }
  close(code: number | null, signal: string | null = null): void { this.emit('close', code, signal) }
}

const spawnMock = vi.mocked(spawn)
let children: FakeChild[] = []
let kills: Array<[number, string | number | undefined]> = []
let order: string[] = []

beforeEach(() => {
  children = []
  kills = []
  order = []
  spawnMock.mockReset()
  spawnMock.mockImplementation((() => {
    order.push('spawn')
    const c = new FakeChild(5000 + children.length)
    children.push(c)
    return c
  }) as unknown as typeof spawn)
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => { kills.push([pid, sig]); return true }) as typeof process.kill)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runCheckProcess fence options', () => {
  it('without them (production) it spawns exactly as before and tracks nothing', async () => {
    const run = runCheckProcess({ run: 'echo hi', cwd: '/w' }, '{}')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawnMock.mock.calls[0]! as unknown as [string, string[], Record<string, unknown>]
    expect(cmd).toBe('/bin/sh')
    expect(args).toEqual(['-c', 'echo hi'])
    expect(opts).toMatchObject({ cwd: '/w', detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children[0]!.stdout.emit('data', Buffer.from('{"fire":false}\n'))
    children[0]!.close(0)
    expect(await run).toMatchObject({ exitCode: 0, stdout: '{"fire":false}\n' })
    expect(kills).toEqual([])
  })

  it('a closed gate starts nothing and says why; the gate is read synchronously right before the spawn', async () => {
    let open = true
    const maySpawn = vi.fn(() => { order.push('gate'); return open })
    const pids = new Set<number>()
    const first = runCheckProcess({ run: 'true' }, '{}', { maySpawn, children: pids })
    expect(order).toEqual(['gate', 'spawn'])
    children[0]!.close(0)
    await first
    // A late check after the fence closed.
    open = false
    const late = runCheckProcess({ run: 'true' }, '{}', { maySpawn, children: pids })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(await late).toMatchObject({ exitCode: null, spawnError: 'check not started: this daemon is stopping' })
    expect(pids.size).toBe(0)
  })

  it('an already aborted signal starts nothing', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const r = await runCheckProcess({ run: 'true' }, '{}', { signal: ctl.signal })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(r.spawnError).toMatch(/stopping/)
  })

  it('an abort kills only the check\'s own group with SIGKILL, and the pid leaves only at the real close', async () => {
    const ctl = new AbortController()
    const pids = new Set<number>()
    const run = runCheckProcess({ run: 'sleep 99' }, '{}', { signal: ctl.signal, children: pids, maySpawn: () => true })
    const child = children[0]!
    expect([...pids]).toEqual([child.pid])
    ctl.abort()
    expect(kills).toEqual([[-child.pid!, 'SIGKILL']])
    expect(pids.size).toBe(1)
    child.close(null, 'SIGKILL')
    expect(await run).toMatchObject({ exitCode: null, signal: 'SIGKILL' })
    expect(pids.size).toBe(0)
    // The listener is gone with the process: a second abort signal sends nothing more.
    ctl.signal.dispatchEvent(new Event('abort'))
    expect(kills).toHaveLength(1)
  })

  it('a settle by the grace timer resolves the run but the pid stays counted until close', async () => {
    vi.useFakeTimers()
    const pids = new Set<number>()
    let result: unknown
    void runCheckProcess({ run: 'sleep 99', timeoutSeconds: 1 }, '{}', { children: pids, signal: new AbortController().signal }).then((r) => { result = r })
    const child = children[0]!
    await vi.advanceTimersByTimeAsync(1000 + CHECK_SETTLE_GRACE_MS + 1000)
    // Its deadline killed the group (the existing behaviour), the grace timer settled it.
    expect(kills).toEqual([[-child.pid!, 'SIGKILL']])
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' })
    expect(pids.size).toBe(1)
    child.close(null, 'SIGKILL')
    expect(pids.size).toBe(0)
  })

  it('never signals a pid of 1 or none, and never counts one', async () => {
    for (const pid of [1, undefined]) {
      spawnMock.mockImplementationOnce((() => { const c = new FakeChild(pid); children.push(c); return c }) as unknown as typeof spawn)
      const ctl = new AbortController()
      const pids = new Set<number>()
      const run = runCheckProcess({ run: 'true' }, '{}', { signal: ctl.signal, children: pids })
      ctl.abort()
      expect(pids.size).toBe(0)
      const c = children[children.length - 1]!
      if (pid === undefined) c.emit('error', Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' }))
      else c.close(0)
      await run
    }
    expect(kills).toEqual([])
  })
})
