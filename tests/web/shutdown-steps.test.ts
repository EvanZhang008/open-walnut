/**
 * stopServer's steps are bounded and named (src/web/shutdown-steps.ts).
 *
 * 2026-11-12: a deploy's smoke boot was cut off by the 7 s shutdown bail while
 * the external session importer's stop waited on a whole import pass, and the
 * bail's line did not say where it hung.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  beginShutdownSteps, shutdownStep, shutdownStepNow, shutdownStepSuffix,
  SHUTDOWN_STEPS_RESERVE_MS, SHUTDOWN_STEP_DEFAULT_MS,
} from '../../src/web/shutdown-steps.js'
import { SHUTDOWN_BAIL_MS } from '../../src/commands/web.js'

afterEach(() => { vi.useRealTimers() })

describe('shutdownStep', () => {
  it('a step that never ends is left behind after its budget', async () => {
    vi.useFakeTimers()
    beginShutdownSteps({ bailMs: SHUTDOWN_BAIL_MS })
    let done = false
    const step = shutdownStep('hangs', () => new Promise(() => {}), { budgetMs: 800 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(799)
    expect(done).toBe(false)
    expect(shutdownStepNow()?.name).toBe('hangs')
    expect(shutdownStepSuffix()).toContain('step="hangs"')
    await vi.advanceTimersByTimeAsync(1)
    await step
    expect(done).toBe(true)
    expect(shutdownStepNow()).toBeNull()
    expect(shutdownStepSuffix()).toBe('')
  })

  it('a step with no budget of its own gets the default', async () => {
    vi.useFakeTimers()
    beginShutdownSteps({ bailMs: SHUTDOWN_BAIL_MS })
    let done = false
    const step = shutdownStep('hangs', () => new Promise(() => {})).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(SHUTDOWN_STEP_DEFAULT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await step
    expect(done).toBe(true)
  })

  it('steps together never wait longer than the shared budget', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    beginShutdownSteps({ bailMs: SHUTDOWN_BAIL_MS })
    const all = (async () => {
      for (let i = 0; i < 10; i++) await shutdownStep(`hang ${i}`, () => new Promise(() => {}), { budgetMs: 3_000 })
    })()
    const budget = SHUTDOWN_BAIL_MS - SHUTDOWN_STEPS_RESERVE_MS
    await vi.advanceTimersByTimeAsync(budget + 10)
    await all
    expect(Date.now() - t0).toBeLessThanOrEqual(budget + 10)
  })

  it('a step that throws, sync or async, counts as done and the next one runs', async () => {
    beginShutdownSteps({ bailMs: SHUTDOWN_BAIL_MS })
    const ran: string[] = []
    await shutdownStep('sync throw', () => { throw new Error('boom') })
    await shutdownStep('async throw', async () => { throw new Error('boom') })
    await shutdownStep('next', () => { ran.push('next') })
    expect(ran).toEqual(['next'])
  })

  it('a fast step is awaited to its end', async () => {
    beginShutdownSteps({ bailMs: SHUTDOWN_BAIL_MS })
    let wrote = false
    await shutdownStep('write', async () => { await new Promise((r) => setTimeout(r, 20)); wrote = true })
    expect(wrote).toBe(true)
  })

  it('with no bail (a test stopping a server in process) a slow step is awaited to its end', async () => {
    vi.useFakeTimers()
    beginShutdownSteps()
    let done = false
    const step = shutdownStep('slow', () => new Promise((r) => setTimeout(r, 20_000))).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await step
    expect(done).toBe(true)
  })

  it('the steps leave the bail room for the HTTP close and the exit', () => {
    expect(SHUTDOWN_BAIL_MS - SHUTDOWN_STEPS_RESERVE_MS).toBeGreaterThanOrEqual(4_000)
  })
})
