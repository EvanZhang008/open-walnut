// endWarmPool / liveChildren (demo.quiesce): a warm child is ended by its stdin alone, and every child counts until it really exits.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOneShotCore, type OneShotChild } from '../../src/providers/oneshot-core.js'

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  killed = false
  stdinEnded = 0
  signals: string[] = []
  stdin = { write: () => true, end: () => { this.stdinEnded++ }, on: () => {} }
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(sig?: string) { this.signals.push(sig ?? 'SIGTERM'); this.killed = true; return true }
  exit(code = 0) { this.exitCode = code; this.emit('exit', code, null); this.emit('close', code, null) }
}

function core(poolMax = 3) {
  const children: FakeChild[] = []
  const oneShot = createOneShotCore<null>({
    spawn: () => { const c = new FakeChild(); children.push(c); return c as unknown as OneShotChild },
    send: () => {},
    poolMax,
    exitGraceMs: 60_000,
  })
  return { oneShot, children }
}

const spec = { command: 'claude', args: ['-p'] }

// The pool's reap and the terminate grace are timers: none of them outlives a test.
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('one-shot warm pool end (demo.quiesce)', () => {
  it('ends each warm child by stdin, sends no signal, and counts it until its exit event', () => {
    const { oneShot, children } = core()
    oneShot.prewarm({ ...spec, warmKey: 'search' })
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 1, children: 1 })
    expect(oneShot.endWarmPool()).toBe(1)
    expect(children[0].stdinEnded).toBe(1)
    expect(children[0].signals).toEqual([])
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 0, children: 1 })
    children[0].exit(0)
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 0, children: 0 })
  })

  it('refuses any run or warm child after the pool closed', () => {
    const { oneShot, children } = core()
    oneShot.endWarmPool()
    expect(() => oneShot.prewarm({ ...spec, warmKey: 'k' })).toThrow(/closed/)
    expect(() => oneShot.run(null, { ...spec, runId: 'r1' })).toThrow(/closed/)
    expect(children).toHaveLength(0)
  })

  it('keeps an evicted child counted while it exits; killed is not an exit', () => {
    const { oneShot, children } = core(1)
    oneShot.prewarm({ ...spec, warmKey: 'a' })
    oneShot.prewarm({ ...spec, warmKey: 'b' })
    expect(children[0].killed).toBe(true)
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 1, children: 2 })
    children[0].exit(143)
    expect(oneShot.liveChildren().children).toBe(1)
  })

  it('an active run stays counted until it ends by itself; endWarmPool does not touch it', () => {
    const { oneShot, children } = core()
    oneShot.run(null, { ...spec, runId: 'r1', input: 'x' })
    oneShot.endWarmPool()
    expect(children[0].signals).toEqual([])
    expect(children[0].stdinEnded).toBe(0)
    expect(oneShot.liveChildren()).toEqual({ runs: 1, pool: 0, children: 1 })
    children[0].exit(0)
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 0, children: 0 })
  })

  it('a run whose child errors while its process lives ends the run but keeps the child counted until its exit', () => {
    const { oneShot, children } = core()
    oneShot.run(null, { ...spec, runId: 'r1' })
    children[0].emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 0, children: 1 })
    children[0].exit(0)
    expect(oneShot.liveChildren().children).toBe(0)
  })

  it('a spawn that failed with no process is not counted', () => {
    const { oneShot, children } = core()
    oneShot.prewarm({ ...spec, warmKey: 'k' })
    children[0].pid = undefined as unknown as number
    children[0].emit('error', new Error('spawn claude ENOENT'))
    expect(oneShot.liveChildren()).toEqual({ runs: 0, pool: 0, children: 0 })
  })

  it('production paths keep their behavior: stats and disposeAll are unchanged', () => {
    const { oneShot, children } = core()
    oneShot.prewarm({ ...spec, warmKey: 'k' })
    expect(oneShot.stats()).toEqual({ runs: 0, pool: 1 })
    oneShot.disposeAll()
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(oneShot.stats()).toEqual({ runs: 0, pool: 0 })
  })
})
