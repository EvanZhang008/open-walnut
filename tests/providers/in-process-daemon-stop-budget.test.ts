/**
 * stopServer gives an in-process daemon's stop a budget inside the signal bail (review S4,
 * 2026-11-21): a program had 45 s to drain; the server exits at 7 s. When the drain is still
 * running at the budget, what a stop saves last (the registry, the fold checkpoints) is saved
 * then, synchronously, so the next boot never re-folds from older checkpoints.
 * A fake runtime module stands in (provideDaemonRuntime); nothing is spawned.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { provideDaemonRuntime, startInProcessDaemon, stopInProcessDaemon } from '../../src/providers/in-process-daemon.js'

function fakeRuntime(stopMs: number) {
  const calls: string[] = []
  const runtime = {
    dir: '/fixture/d', version: 'v', instanceId: 'd-1',
    start: async () => ({ kind: 'started' as const, port: 0 }),
    stop: () => new Promise<number>((r) => { calls.push('stop'); setTimeout(() => { calls.push('stopped'); r(0) }, stopMs) }),
    saveNow: () => { calls.push('saveNow') },
    requestStop: () => false,
    connect: () => ({ request: async () => ({}), close() {} }),
  }
  provideDaemonRuntime(async () => ({ createDaemonRuntime: async () => runtime }) as never)
  return calls
}

describe('stopInProcessDaemon with a budget', () => {
  afterEach(() => provideDaemonRuntime(null as never))

  it('a stop that finishes in time returns its code and saves nothing extra', async () => {
    const calls = fakeRuntime(10)
    await startInProcessDaemon({ dir: '/fixture/d', env: {} })
    expect(await stopInProcessDaemon('test', 500)).toBe(0)
    expect(calls).toEqual(['stop', 'stopped'])
  })

  it('a stop still draining at the budget saves now and returns', async () => {
    const calls = fakeRuntime(2_000)
    await startInProcessDaemon({ dir: '/fixture/d', env: {} })
    const t0 = Date.now()
    expect(await stopInProcessDaemon('test', 100)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(calls).toEqual(['stop', 'saveNow'])
  })
})
