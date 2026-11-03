/**
 * The live update's state machine (src/core/self-update/live-update.ts) with a
 * fake clock, fake timers, stub installers and a stub restart handler: every
 * transition of off | idle | downloading | installed | waiting | restarting |
 * failed, the person's Update and Restart, and the idle gate's two rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-live-update'))

import { LiveUpdater, setRestartHandler, type LiveUpdateDeps } from '../../../src/core/self-update/live-update.js'
import { IDLE_MS, MAX_TURN_WAIT_MS, noteUserActivity, resetUserActivityForTest } from '../../../src/core/self-update/idle-gate.js'
import type { UpdateStatus } from '../../../src/core/self-update/update-check.js'

const STATUS: UpdateStatus = {
  enabled: true,
  install: { kind: 'binary', sourceDir: null, packageRoot: null, manager: null, updateCommand: 'walnut update', binary: { root: '/opt/w', target: 'linux-x64', version: '0.5.1' } },
  current: '0.5.1', channel: 'stable', latest: '0.6.0', tags: { latest: '0.6.0', nightly: null }, available: true,
  checkedAt: '2026-11-03T10:00:00.000Z', error: null, checking: false, packageUrl: 'https://www.npmjs.com/package/open-walnut',
}

/** A clock and a timer queue the test advances by hand. */
function fakeTime(start = 1_800_000_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimer: (h: unknown) => { timers.delete(h as number) },
    pending: () => timers.size,
    /** Move the clock and run every timer that came due, in order, letting promises settle between them. */
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
        await flush()
      }
      now = until
      await flush()
    },
  }
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

interface Harness {
  updater: LiveUpdater
  t: ReturnType<typeof fakeTime>
  calls: { install: string[]; asked: boolean[]; unverified: unknown[]; noted: string[]; changes: number; restarts: number }
  deps: LiveUpdateDeps
  status: { value: UpdateStatus }
  set: (patch: Partial<Ctl>) => void
}

interface Ctl {
  auto: boolean | undefined
  can: boolean
  held: string | null
  busy: string | null
  turns: number
  installed: string | null
  fail: string | null
  /** Resolves the install by hand when set. */
  gate: Promise<void> | null
}

function harness(over: Partial<LiveUpdateDeps> = {}, ctl0: Partial<Ctl> = {}): Harness {
  const t = fakeTime()
  const ctl: Ctl = { auto: undefined, can: true, held: null, busy: null, turns: 0, installed: null, fail: null, gate: null, ...ctl0 }
  const status = { value: STATUS }
  const calls = { install: [] as string[], asked: [] as boolean[], unverified: [] as unknown[], noted: [] as string[], changes: 0, restarts: 0 }
  const deps: LiveUpdateDeps = {
    now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer,
    status: () => status.value,
    configAuto: async () => ctl.auto,
    env: {},
    canSelfInstall: () => ctl.can,
    held: () => ctl.held,
    busy: async () => ctl.busy,
    install: async (_s, version, asked) => {
      calls.install.push(version); calls.asked.push(asked)
      if (ctl.gate) await ctl.gate
      if (ctl.fail) throw new Error(ctl.fail)
      return { from: '0.5.1' }
    },
    markUnverified: (p) => { calls.unverified.push(p) },
    noteInstalled: (v) => { calls.noted.push(v) },
    installedLater: () => ctl.installed,
    turnsRunning: async () => ctl.turns,
    onChange: () => { calls.changes++ },
    log: () => {},
    ...over,
  }
  const updater = new LiveUpdater(deps)
  return { updater, t, calls, deps, status, set: (p) => Object.assign(ctl, p) }
}

const state = async (h: Harness) => (await h.updater.snapshot()).state

beforeEach(() => { resetUserActivityForTest(); setRestartHandler(null) })
afterEach(() => { setRestartHandler(null) })

describe('live update: off and idle', () => {
  it('off when updates.auto is false; a newer release installs nothing', async () => {
    const h = harness({}, { auto: false })
    await h.updater.start()
    expect(await state(h)).toBe('off')
    await h.updater.onChecked(STATUS)
    expect(h.calls.install).toEqual([])
    expect((await h.updater.snapshot()).updatesAuto).toBe(false)
  })

  it('off when this install cannot replace itself (a Node build, read-only, Homebrew)', async () => {
    const h = harness({}, { can: false })
    await h.updater.onChecked(STATUS)
    expect(await state(h)).toBe('off')
    expect(h.calls.install).toEqual([])
    expect((await h.updater.snapshot()).canInstall).toBe(false)
  })

  it('idle while nothing newer is published; off -> idle when auto comes back on', async () => {
    const h = harness({}, { auto: false })
    await h.updater.onChecked({ ...STATUS, available: false, latest: '0.5.1' })
    expect(await state(h)).toBe('off')
    h.set({ auto: true })
    await h.updater.onChecked({ ...STATUS, available: false, latest: '0.5.1' })
    expect(await state(h)).toBe('idle')
  })

  it('a held version is not installed automatically, and the status names why', async () => {
    const h = harness({}, { held: '0.6.0 did not start here before' })
    await h.updater.onChecked(STATUS)
    expect(h.calls.install).toEqual([])
    const s = await h.updater.snapshot()
    expect(s).toMatchObject({ state: 'idle', held: '0.6.0 did not start here before' })
  })

  it('an install another start began is left alone (no second npm into one prefix)', async () => {
    const h = harness({}, { busy: 'the install of 0.6.0 still runs' })
    await h.updater.onChecked(STATUS)
    expect(h.calls.install).toEqual([])
    expect(await state(h)).toBe('idle')
  })

  it('a version the startup update installed after its budget is installed already', async () => {
    const h = harness({}, { installed: '0.6.0' })
    await h.updater.onChecked(STATUS)
    expect(await h.updater.snapshot()).toMatchObject({ state: 'installed', version: '0.6.0' })
    expect(h.calls.install).toEqual([])
  })
})

describe('live update: install', () => {
  it('idle -> downloading -> installed: the unverified record and the note are written; no handler, no restart', async () => {
    let release!: () => void
    const h = harness({}, { gate: new Promise<void>((r) => { release = r }) })
    await h.updater.onChecked(STATUS)
    expect(await h.updater.snapshot()).toMatchObject({ state: 'downloading', version: '0.6.0' })
    release()
    await flush()
    expect(await h.updater.snapshot()).toMatchObject({ state: 'installed', version: '0.6.0', error: null })
    expect(h.calls.install).toEqual(['0.6.0'])
    expect(h.calls.asked).toEqual([false])
    // Recorded before the install starts (npm may outlive this server) and again once it is in.
    expect(h.calls.unverified).toEqual([{ version: '0.6.0', from: '0.5.1' }, { version: '0.6.0', from: '0.5.1' }])
    expect(h.calls.noted).toEqual(['0.6.0'])
    // Nothing waits for a gate that can never restart.
    await h.t.advance(IDLE_MS * 10)
    expect(await state(h)).toBe('installed')
    expect(h.t.pending()).toBe(0)
  })

  it('downloading -> failed keeps the error; the next check tries again -> installed', async () => {
    const h = harness({}, { fail: 'registry answered HTTP 503' })
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await h.updater.snapshot()).toMatchObject({ state: 'failed', error: 'registry answered HTTP 503', version: '0.6.0' })
    // The record written before the install goes with the failure: no next start is watched for it.
    expect(h.calls.unverified).toEqual([{ version: '0.6.0', from: '0.5.1' }, null])
    h.set({ fail: null })
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await h.updater.snapshot()).toMatchObject({ state: 'installed', error: null })
    expect(h.calls.install).toEqual(['0.6.0', '0.6.0'])
  })

  it('failed stays failed while another install runs; idle once nothing is newer', async () => {
    const h = harness({}, { fail: 'boom' })
    await h.updater.onChecked(STATUS)
    await flush()
    h.set({ busy: 'still runs' })
    await h.updater.onChecked(STATUS)
    expect(await h.updater.snapshot()).toMatchObject({ state: 'failed', error: 'boom' })
    h.set({ busy: null })
    await h.updater.onChecked({ ...STATUS, available: false })
    expect(await h.updater.snapshot()).toMatchObject({ state: 'idle', error: null })
  })

  it('a check while installed changes nothing, auto turned off included', async () => {
    const h = harness()
    await h.updater.onChecked(STATUS)
    await flush()
    h.set({ auto: false })
    await h.updater.onChecked({ ...STATUS, latest: '0.7.0', tags: { latest: '0.7.0', nightly: null } })
    expect(await h.updater.snapshot()).toMatchObject({ state: 'installed', version: '0.6.0' })
    expect(h.calls.install).toEqual(['0.6.0'])
  })
})

describe('live update: the idle gate and the restart', () => {
  it('installed -> waiting while the person is active -> restarting once idle 10 min; the handler runs after the delay', async () => {
    const h = harness()
    const handler = vi.fn()
    setRestartHandler(handler)
    noteUserActivity(h.t.now(), h.t.now())
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await state(h)).toBe('waiting')
    // Activity keeps it waiting.
    await h.t.advance(5 * 60_000)
    noteUserActivity(h.t.now(), h.t.now())
    await h.t.advance(9 * 60_000)
    expect(await state(h)).toBe('waiting')
    const idle = await h.updater.snapshot()
    expect(idle.idle).toMatchObject({ ready: false, turnsRunning: 0 })
    expect(idle.idle.userIdleMs).toBeGreaterThanOrEqual(8 * 60_000)
    expect(idle.idle.waitingSince).toBe(new Date(1_800_000_000_000).toISOString())
    await h.t.advance(60_000) // 10 min after the last activity
    expect(await state(h)).toBe('restarting')
    expect(handler).not.toHaveBeenCalled()
    await h.t.advance(2_000)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a running turn holds the restart, until the install waited 6 h', async () => {
    const h = harness({}, { turns: 2 })
    const handler = vi.fn()
    setRestartHandler(handler)
    await h.updater.onChecked(STATUS)
    await flush()
    await h.t.advance(IDLE_MS + 60_000)
    expect(await h.updater.snapshot()).toMatchObject({ state: 'waiting', idle: { ready: false, turnsRunning: 2 } })
    await h.t.advance(MAX_TURN_WAIT_MS)
    expect(await state(h)).toBe('restarting')
    await h.t.advance(2_000)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('no activity seen since start counts from the start; a handler that throws before tearing anything down goes back to installed', async () => {
    const h = harness()
    setRestartHandler(() => { throw new Error('port busy') })
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await state(h)).toBe('waiting')
    await h.t.advance(IDLE_MS)
    expect(await state(h)).toBe('restarting')
    await h.t.advance(2_000)
    expect(await h.updater.snapshot()).toMatchObject({ state: 'installed', error: 'the restart failed: port busy' })
  })
})

describe('live update: the person asks', () => {
  it('Update without a restart handler: cannot_install with the command', async () => {
    const h = harness()
    await h.updater.onChecked({ ...STATUS, available: false })
    expect(h.updater.installNow()).toEqual({ ok: false, code: 'cannot_install', fix: 'walnut update' })
  })

  it('Update with auto off or a held version installs it anyway and restarts at once (no idle wait)', async () => {
    const h = harness({}, { auto: false, held: '0.6.0 did not start here before' })
    const handler = vi.fn()
    setRestartHandler(handler)
    noteUserActivity(h.t.now(), h.t.now()) // the person is right there
    await h.updater.onChecked(STATUS)
    expect(await state(h)).toBe('off')
    expect(h.updater.installNow('sid-1')).toEqual({ ok: true })
    await flush()
    expect(h.calls.asked).toEqual([true])
    expect(await state(h)).toBe('restarting')
    await h.t.advance(2_000)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('Update during a download restarts as soon as it is in; Update while installed restarts now', async () => {
    let release!: () => void
    const h = harness({}, { gate: new Promise<void>((r) => { release = r }) })
    const handler = vi.fn()
    setRestartHandler(handler)
    noteUserActivity(h.t.now(), h.t.now())
    await h.updater.onChecked(STATUS)
    expect(h.updater.installNow()).toEqual({ ok: true })
    release()
    await flush()
    expect(await state(h)).toBe('restarting')
    expect(h.calls.install).toEqual(['0.6.0'])
    // And the same once installed (another updater, the gate not ready):
    const h2 = harness()
    setRestartHandler(handler)
    noteUserActivity(h2.t.now(), h2.t.now())
    await h2.updater.onChecked(STATUS)
    await flush()
    expect(await state(h2)).toBe('waiting')
    expect(h2.updater.installNow()).toEqual({ ok: true })
    expect(await state(h2)).toBe('restarting')
  })

  it('Update with nothing newer: no_update; Try again after a failure installs again', async () => {
    const h = harness({}, { fail: 'boom' })
    setRestartHandler(vi.fn())
    h.status.value = { ...STATUS, available: false }
    await h.updater.onChecked(h.status.value)
    expect(h.updater.installNow()).toEqual({ ok: false, code: 'no_update' })
    h.status.value = STATUS
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await state(h)).toBe('failed')
    h.set({ fail: null })
    expect(h.updater.installNow()).toEqual({ ok: true })
    await flush()
    expect(await state(h)).toBe('restarting')
  })

  it('Restart: no_update before an install, no_restart without a handler, ok once installed (twice is one restart)', async () => {
    const h = harness()
    expect(h.updater.restartNow('asked')).toEqual({ ok: false, code: 'no_update' })
    await h.updater.onChecked(STATUS)
    await flush()
    expect(h.updater.restartNow('asked')).toEqual({ ok: false, code: 'no_restart' })
    const handler = vi.fn()
    setRestartHandler(handler)
    expect(h.updater.restartNow('asked')).toEqual({ ok: true })
    expect(h.updater.restartNow('asked')).toEqual({ ok: true })
    await h.t.advance(2_000)
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await h.updater.snapshot()).canInstall).toBe(true)
  })
})

describe('live update: the review cases', () => {
  it('stop() during a download: the install that finishes later still leaves the record its next start is watched by', async () => {
    let release!: () => void
    const h = harness({}, { gate: new Promise<void>((r) => { release = r }) })
    await h.updater.onChecked(STATUS)
    expect(await state(h)).toBe('downloading')
    h.updater.stop()
    release()
    await flush()
    expect(h.calls.unverified).toEqual([{ version: '0.6.0', from: '0.5.1' }, { version: '0.6.0', from: '0.5.1' }])
    expect(h.calls.noted).toEqual(['0.6.0'])
    expect(h.t.pending()).toBe(0)
  })

  it('Update while an earlier start\'s install still runs: no second install, the reason is the error', async () => {
    const h = harness({}, { auto: false })
    setRestartHandler(vi.fn())
    await h.updater.onChecked(STATUS)
    h.set({ busy: 'the install of 0.6.0 an earlier start began still runs (pid 42)' })
    expect(h.updater.installNow()).toEqual({ ok: true })
    await flush()
    expect(await h.updater.snapshot()).toMatchObject({ state: 'failed', error: 'the install of 0.6.0 an earlier start began still runs (pid 42)' })
    expect(h.calls.install).toEqual([])
    expect(h.calls.unverified).toEqual([])
  })

  it('updates.auto turned off while the install waits: the gate never restarts it, the person still can', async () => {
    const h = harness()
    const handler = vi.fn()
    setRestartHandler(handler)
    noteUserActivity(h.t.now(), h.t.now())
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await state(h)).toBe('waiting')
    h.set({ auto: false })
    await h.t.advance(IDLE_MS * 3)
    expect(await state(h)).toBe('waiting')
    expect((await h.updater.snapshot()).idle.ready).toBe(true)
    expect(h.updater.restartNow('asked')).toEqual({ ok: true })
    await h.t.advance(2_000)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a handler registered after the install went in starts the wait on the gate', async () => {
    const h = harness({}, { installed: '0.6.0' })
    await h.updater.onChecked(STATUS)
    expect(h.t.pending()).toBe(0)
    const handler = vi.fn()
    // setRestartHandler tells the process's updater; this one is built by hand, so ask it directly.
    setRestartHandler(handler)
    h.updater.handlerChanged()
    await h.t.advance(IDLE_MS + 60_000)
    expect(await state(h)).toBe('restarting')
  })
})

describe('live update: the Mac app', () => {
  it('a launcher-updated server never installs, but keeps the gate current and says when it turns', async () => {
    const h = harness({ env: { WALNUT_LAUNCHER_UPDATES: '1' } }, { can: false })
    noteUserActivity(h.t.now(), h.t.now())
    await h.updater.start()
    expect(await state(h)).toBe('off')
    const before = h.calls.changes
    await h.t.advance(60_000)
    expect((await h.updater.snapshot()).idle.ready).toBe(false)
    const afterFirst = h.calls.changes
    expect(afterFirst).toBeGreaterThan(before) // the first look says where it stands
    await h.t.advance(IDLE_MS)
    expect((await h.updater.snapshot()).idle.ready).toBe(true)
    expect(h.calls.changes).toBeGreaterThan(afterFirst)
    expect(h.calls.install).toEqual([])
    h.updater.stop()
    expect(h.t.pending()).toBe(0)
  })
})
