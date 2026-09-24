import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronSupervisionController, DaemonSessionGate, type CronObservation } from '../../src/providers/daemon-cron-controller.js'
import { CronSupervisionStore } from '../../src/providers/daemon-cron-store.js'

const sid = '11111111-2222-4333-8444-555555555555'
const otherSid = '11111111-2222-4333-8444-555555555556'
const launch = { cwd: '/workspace/demo', args: ['claude', '-p'], mode: 'default', cliVersion: '2.1.258' }
const identity = { bootId: 'boot-a', pid: 200, startTime: '100' }
let directory: string

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function lab() {
  const store = new CronSupervisionStore(directory)
  await store.load()
  const clock = { now: 10000 }
  const gate = new DaemonSessionGate()
  const observe = vi.fn(async (): Promise<CronObservation> => ({ process: 'dead', cron: 'active' }))
  const ensureRunning = vi.fn(async () => identity)
  const changed = vi.fn()
  const controller = new CronSupervisionController({
    store, gate, observe, ensureRunning, changed, clock: () => clock.now, random: () => 0,
  })
  await controller.register(sid, launch, identity)
  return { store, controller, clock, gate, observe, ensureRunning, changed }
}

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-cron-controller-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('host-local cron recovery controller', () => {
  it('persists the attempt before ensuring one idle process with the original launch settings', async () => {
    const l = await lab()
    await l.controller.tick()
    expect(l.ensureRunning).not.toHaveBeenCalled()
    expect(l.store.get(sid)?.retryAt).toBe(15000)
    l.clock.now = 15000
    l.ensureRunning.mockImplementationOnce(async () => {
      expect(l.store.get(sid)?.attempts).toEqual([15000])
      return identity
    })
    await Promise.all(Array.from({ length: 25 }, () => l.controller.tick()))
    expect(l.ensureRunning).toHaveBeenCalledExactlyOnceWith(sid, launch, expect.any(Function))
    expect(l.store.get(sid)).toMatchObject({ state: 'checking', process: identity, reason: 'scheduler-unconfirmed' })
    l.observe.mockResolvedValue({ process: 'alive', cron: 'active', schedulerConfirmed: true })
    await l.controller.tick()
    expect(l.store.get(sid)?.state).toBe('watching')
    expect(l.store.get(sid)?.attempts).toEqual([15000])
  })

  it('stop wins while the cron observation is in flight and remains stopped after daemon restart', async () => {
    const l = await lab()
    await l.controller.tick()
    l.clock.now = 15000
    const entered = deferred<void>()
    const observation = deferred<CronObservation>()
    l.observe.mockImplementationOnce(() => { entered.resolve(); return observation.promise })
    const tick = l.controller.tick()
    await entered.promise
    await l.controller.disable(sid)
    observation.resolve({ process: 'dead', cron: 'active' })
    await tick
    expect(l.ensureRunning).not.toHaveBeenCalled()
    const restarted = await lab()
    await restarted.controller.tick()
    expect(restarted.store.get(sid)).toMatchObject({ enabled: false, state: 'disabled' })
    expect(restarted.ensureRunning).not.toHaveBeenCalled()
  })

  it('invalidates asynchronous launch preparation immediately when stop arrives', async () => {
    const l = await lab()
    await l.controller.tick()
    l.clock.now = 15000
    const entered = deferred<void>()
    const proceed = deferred<void>()
    const spawn = vi.fn()
    const controller = new CronSupervisionController({
      store: l.store, gate: l.gate, observe: l.observe, changed: l.changed,
      clock: () => l.clock.now,
      ensureRunning: async (_sid, _launch, isCurrent) => {
        entered.resolve()
        await proceed.promise
        if (!isCurrent()) return null
        spawn()
        return identity
      },
    })
    const tick = controller.tick()
    await entered.promise
    await controller.disable(sid)
    proceed.resolve()
    await tick
    expect(spawn).not.toHaveBeenCalled()
    expect(l.store.get(sid)?.state).toBe('disabled')
  })

  it('does not let a queued enable undo a newer stop', async () => {
    const l = await lab()
    const entered = deferred<void>()
    const release = deferred<void>()
    const holder = l.gate.run(sid, async () => { entered.resolve(); await release.promise })
    await entered.promise
    const enable = l.controller.enable(sid)
    const rejection = expect(enable).rejects.toThrow('superseded')
    await l.controller.disable(sid)
    release.resolve()
    await holder
    await rejection
    expect(l.store.get(sid)?.enabled).toBe(false)
  })

  it('records stop even when no live process or launch record exists', async () => {
    const l = await lab()
    await l.controller.disable(otherSid)
    await l.controller.register(otherSid, launch, identity)
    expect(l.store.get(otherSid)).toMatchObject({ enabled: false, state: 'disabled', launch: null })
    await expect(l.controller.enable(otherSid)).rejects.toThrow('No saved launch settings')
  })

  it('keeps a retry deadline and exhausted budget through store reload', async () => {
    const l = await lab()
    await l.controller.tick()
    const restarted = await lab()
    expect(restarted.store.get(sid)?.retryAt).toBe(15000)
    for (const at of [15000, 45000, 165000]) {
      restarted.clock.now = at
      await restarted.controller.tick()
      await restarted.controller.tick()
    }
    expect(restarted.ensureRunning).toHaveBeenCalledTimes(3)
    expect(restarted.store.get(sid)).toMatchObject({ state: 'blocked', reason: 'retry-budget-exhausted' })
    const again = await lab()
    again.clock.now = 999999999
    await again.controller.tick()
    expect(again.ensureRunning).not.toHaveBeenCalled()
    await again.controller.enable(sid)
    expect(again.store.get(sid)?.attempts).toEqual([])
  })

  it.each([
    { process: 'alive', cron: 'active' },
    { process: 'unknown', cron: 'active' },
    { process: 'dead', cron: 'unknown' },
    { process: 'dead', cron: 'inactive' },
    { process: 'dead', cron: 'active', blockedReason: 'unsupported-cli' },
  ] as const)('does not spawn with evidence %j', async (evidence) => {
    const l = await lab()
    l.observe.mockResolvedValue(evidence)
    await l.controller.tick()
    l.clock.now += 999999
    await l.controller.tick()
    expect(l.ensureRunning).not.toHaveBeenCalled()
  })

  it('serializes different session recoveries and shares the user-start gate', async () => {
    const l = await lab()
    await l.controller.register(otherSid, launch, identity)
    await l.controller.tick()
    l.clock.now = 15000
    const entered = deferred<void>()
    const release = deferred<void>()
    l.ensureRunning.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return identity })
    const tick = l.controller.tick()
    await entered.promise
    const userStart = vi.fn(async () => {})
    const user = l.gate.run(sid, userStart)
    expect(l.ensureRunning).toHaveBeenCalledTimes(1)
    expect(userStart).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([tick, user])
    expect(l.ensureRunning).toHaveBeenCalledTimes(2)
    expect(userStart).toHaveBeenCalledTimes(1)
  })

  it('close stops the batch after the current observation without spending a recovery attempt', async () => {
    const l = await lab()
    await l.controller.register(otherSid, launch, identity)
    await l.controller.tick()
    l.clock.now = 15000
    l.observe.mockClear()
    const entered = deferred<void>()
    const observation = deferred<CronObservation>()
    l.observe.mockImplementationOnce(() => { entered.resolve(); return observation.promise })
    const tick = l.controller.tick()
    await entered.promise
    let closed = false
    const closing = l.controller.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    observation.resolve({ process: 'dead', cron: 'active' })
    await Promise.all([tick, closing])
    await l.controller.tick()
    expect(l.observe).toHaveBeenCalledTimes(1)
    expect(l.ensureRunning).not.toHaveBeenCalled()
    expect(l.store.get(sid)?.attempts).toEqual([])
    expect(l.store.get(otherSid)?.attempts).toEqual([])
    await l.controller.disable(sid)
    expect(l.store.get(sid)?.enabled).toBe(false)
  })

  it('close invalidates a launch that is still preparing', async () => {
    const l = await lab()
    await l.controller.tick()
    l.clock.now = 15000
    const entered = deferred<void>()
    const release = deferred<void>()
    const spawn = vi.fn()
    const controller = new CronSupervisionController({
      store: l.store, gate: l.gate, observe: l.observe, changed: l.changed,
      clock: () => l.clock.now,
      ensureRunning: async (_sid, _launch, current) => {
        entered.resolve()
        await release.promise
        if (!current()) return null
        spawn()
        return identity
      },
    })
    const tick = controller.tick()
    await entered.promise
    const closing = controller.close()
    release.resolve()
    await Promise.all([tick, closing])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('pauses new recovery while draining existing work and resumes without duplicating it', async () => {
    const l = await lab()
    await l.controller.tick()
    l.clock.now = 15000
    const entered = deferred<void>()
    const observation = deferred<CronObservation>()
    l.observe.mockImplementationOnce(() => { entered.resolve(); return observation.promise })
    const tick = l.controller.tick()
    await entered.promise
    const pause = l.controller.pause()
    let drained = false
    const waiting = pause.drained.then(() => { drained = true })
    await l.controller.tick()
    expect(drained).toBe(false)
    pause.resume()
    expect(l.controller.tick()).toBe(tick)
    observation.resolve({ process: 'dead', cron: 'active' })
    await Promise.all([tick, waiting])
    expect(l.ensureRunning).toHaveBeenCalledTimes(1)
    const again = l.controller.pause()
    await again.drained
    await l.controller.close()
    again.resume()
    await l.controller.tick()
    expect(l.ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('a stop accepted during a cancelled update still wins over delayed recovery', async () => {
    const l = await lab()
    await l.controller.tick()
    l.clock.now = 15000
    const entered = deferred<void>()
    const observation = deferred<CronObservation>()
    l.observe.mockImplementationOnce(() => { entered.resolve(); return observation.promise })
    const tick = l.controller.tick()
    await entered.promise
    const pause = l.controller.pause()
    pause.resume()
    await l.controller.disable(sid)
    observation.resolve({ process: 'dead', cron: 'active' })
    await Promise.all([tick, pause.drained])
    expect(l.ensureRunning).not.toHaveBeenCalled()
    expect(l.store.get(sid)?.enabled).toBe(false)
  })

  it('never starts when the durable attempt write fails', async () => {
    const l = await lab()
    await l.controller.tick()
    l.clock.now = 15000
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('write refused'))
    await expect(l.controller.tick()).rejects.toThrow('write refused')
    expect(l.ensureRunning).not.toHaveBeenCalled()
  })
})
