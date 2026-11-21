/**
 * The clocks of one daemon runtime (daemon-runtime-timers.ts): every timer is tracked so
 * clearAll() ends them, and a callback that throws or rejects is reported, never left to the
 * process as an uncaught error. Real timers with delays of a few milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRuntimeTimers, type RuntimeTimers } from '../../src/providers/daemon-runtime-timers.js'

const sleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))
const nextImmediate = () => new Promise<void>((resolve) => globalThis.setImmediate(resolve))

let reported: Array<{ what: string; err: unknown }>
let rt: RuntimeTimers
const uncaught: unknown[] = []
const onUncaught = (err: unknown) => { uncaught.push(err) }

beforeEach(() => {
  reported = []
  uncaught.length = 0
  rt = createRuntimeTimers((what, err) => { reported.push({ what, err }) })
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
})

afterEach(() => {
  rt.clearAll()
  process.off('uncaughtException', onUncaught)
  process.off('unhandledRejection', onUncaught)
})

describe('createRuntimeTimers: errors are reported, never thrown at the process', () => {
  it('reports a throwing setTimeout callback as a timer', async () => {
    const boom = new Error('timer boom')
    rt.setTimeout(() => { throw boom }, 1)
    await sleep(20)
    expect(reported).toEqual([{ what: 'timer', err: boom }])
    expect(uncaught).toEqual([])
  })

  it('reports a throwing setInterval callback as an interval, on every run', async () => {
    let runs = 0
    const t = rt.setInterval(() => { runs++; throw new Error(`run ${runs}`) }, 2)
    await sleep(40)
    rt.clearInterval(t)
    expect(runs).toBeGreaterThanOrEqual(2)
    expect(reported.length).toBe(runs)
    expect(reported.every((r) => r.what === 'interval')).toBe(true)
    expect(uncaught).toEqual([])
  })

  it('reports a throwing setImmediate callback as an immediate', async () => {
    const boom = new Error('immediate boom')
    rt.setImmediate(() => { throw boom })
    await nextImmediate()
    await nextImmediate()
    expect(reported).toEqual([{ what: 'immediate', err: boom }])
    expect(uncaught).toEqual([])
  })

  it('reports a callback whose promise rejects, for each kind', async () => {
    const errs = { timer: new Error('t'), interval: new Error('i'), immediate: new Error('m') }
    rt.setTimeout(async () => { throw errs.timer }, 1)
    const iv = rt.setInterval(() => { rt.clearInterval(iv); return Promise.reject(errs.interval) }, 1)
    rt.setImmediate(async () => { throw errs.immediate })
    await sleep(30)
    expect(reported).toHaveLength(3)
    expect(reported).toEqual(expect.arrayContaining([
      { what: 'timer', err: errs.timer },
      { what: 'interval', err: errs.interval },
      { what: 'immediate', err: errs.immediate },
    ]))
    expect(uncaught).toEqual([])
  })

  it('reports nothing for callbacks that return normally or resolve', async () => {
    rt.setTimeout(() => 42, 1)
    rt.setImmediate(async () => 'ok')
    await sleep(15)
    expect(reported).toEqual([])
  })
})

describe('createRuntimeTimers: arguments and bookkeeping', () => {
  it('passes extra arguments through to each kind', async () => {
    const seen: unknown[][] = []
    rt.setTimeout((...a: unknown[]) => { seen.push(['timer', ...a]) }, 1, 'a', 1)
    const iv = rt.setInterval((...a: unknown[]) => { seen.push(['interval', ...a]); rt.clearInterval(iv) }, 1, 'b', 2)
    rt.setImmediate((...a: unknown[]) => { seen.push(['immediate', ...a]) }, 'c', 3)
    await sleep(30)
    expect(seen).toEqual(expect.arrayContaining([
      ['timer', 'a', 1],
      ['interval', 'b', 2],
      ['immediate', 'c', 3],
    ]))
    expect(seen).toHaveLength(3)
  })

  it('counts pending timers: a fired timeout or immediate leaves, an interval stays', async () => {
    expect(rt.pending).toBe(0)
    rt.setTimeout(() => {}, 1)
    rt.setImmediate(() => {})
    const iv = rt.setInterval(() => {}, 1)
    expect(rt.pending).toBe(3)
    await sleep(20)
    expect(rt.pending).toBe(1)
    rt.clearInterval(iv)
    expect(rt.pending).toBe(0)
  })

  it('clearTimeout, clearInterval and clearImmediate remove from pending and stop the callback', async () => {
    let fired = 0
    const t = rt.setTimeout(() => { fired++ }, 5)
    const iv = rt.setInterval(() => { fired++ }, 5)
    const im = rt.setImmediate(() => { fired++ })
    expect(rt.pending).toBe(3)
    rt.clearTimeout(t)
    expect(rt.pending).toBe(2)
    rt.clearInterval(iv)
    expect(rt.pending).toBe(1)
    rt.clearImmediate(im)
    expect(rt.pending).toBe(0)
    await sleep(25)
    expect(fired).toBe(0)
  })

  it('clearAll stops every pending timeout, interval and immediate', async () => {
    let fired = 0
    rt.setTimeout(() => { fired++ }, 5)
    rt.setTimeout(() => { fired++ }, 10)
    rt.setInterval(() => { fired++ }, 3)
    rt.setImmediate(() => { fired++ })
    expect(rt.pending).toBe(4)
    rt.clearAll()
    expect(rt.pending).toBe(0)
    await sleep(30)
    expect(fired).toBe(0)
  })

  it('keeps working after clearAll', async () => {
    rt.setInterval(() => {}, 5)
    rt.clearAll()
    let fired = false
    rt.setTimeout(() => { fired = true }, 1)
    expect(rt.pending).toBe(1)
    await sleep(15)
    expect(fired).toBe(true)
    expect(rt.pending).toBe(0)
  })
})

describe('createRuntimeTimers: contain() guards an event handler the same way', () => {
  it('passes the arguments, reports a throw and a rejection by name, and never throws', async () => {
    const errors: Array<{ what: string; message: string }> = []
    const rt = createRuntimeTimers((what, err) => { errors.push({ what, message: (err as Error).message }) })
    const seen: unknown[] = []
    const onExit = rt.contain('child exit', (code: number | null, signal: string | null) => { seen.push(code, signal) })
    onExit(3, 'SIGTERM')
    expect(seen).toEqual([3, 'SIGTERM'])
    expect(() => rt.contain('throws', () => { throw new Error('boom') })()).not.toThrow()
    rt.contain('rejects', async () => { throw new Error('late') })()
    await new Promise((r) => setTimeout(r, 5))
    expect(errors).toEqual([{ what: 'throws', message: 'boom' }, { what: 'rejects', message: 'late' }])
    rt.clearAll()
  })
})

// A daemon program (contain=false) keeps its old rule: an error reaches the process, whose crash
// handler exits for a clean restart that re-adopts every CLI (review S1, 2026-11-21).
describe('createRuntimeTimers without contain: errors reach the process, as before', () => {
  it('contain() rethrows, the slow report still runs, nothing is reported as contained', () => {
    const reported: string[] = []
    const slow: string[] = []
    const rt = createRuntimeTimers((what) => { reported.push(what) }, { ms: 0, report: (what) => { slow.push(what) } }, false)
    expect(() => rt.contain('child exit', () => { throw new Error('boom') })()).toThrow('boom')
    expect(reported).toEqual([])
    expect(slow).toEqual(['child exit'])
  })

  it('a rejected promise is left to the process (no handler attached)', async () => {
    const reported: string[] = []
    const rt = createRuntimeTimers((what) => { reported.push(what) }, undefined, false)
    const p = Promise.reject(new Error('late'))
    const seen: unknown[] = []
    p.catch((e) => seen.push(e))
    rt.contain('rejects', () => p)()
    await new Promise((r) => setTimeout(r, 5))
    expect(reported).toEqual([])
    expect(seen).toHaveLength(1)
  })
})
