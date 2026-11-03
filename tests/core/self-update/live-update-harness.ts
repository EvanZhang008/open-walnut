/**
 * The live update test harness (live-update.ts): a fake clock and timer queue,
 * stub installers and readers the test steers through `set`.
 */
import { LiveUpdater, type LiveUpdateDeps } from '../../../src/core/self-update/live-update.js'
import type { UpdateStatus } from '../../../src/core/self-update/update-check.js'

export const STATUS: UpdateStatus = {
  enabled: true,
  install: { kind: 'binary', sourceDir: null, packageRoot: null, manager: null, updateCommand: 'walnut update', binary: { root: '/opt/w', target: 'linux-x64', version: '0.5.1' } },
  current: '0.5.1', channel: 'stable', latest: '0.6.0', tags: { latest: '0.6.0', nightly: null }, available: true,
  checkedAt: '2026-11-03T10:00:00.000Z', error: null, checking: false, packageUrl: 'https://www.npmjs.com/package/open-walnut',
}

/** A clock and a timer queue the test advances by hand. */
export function fakeTime(start = 1_800_000_000_000) {
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

export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

export interface Harness {
  updater: LiveUpdater
  t: ReturnType<typeof fakeTime>
  calls: { install: string[]; asked: boolean[]; unverified: unknown[]; noted: string[]; changes: number; restarts: number; checks: number }
  deps: LiveUpdateDeps
  status: { value: UpdateStatus }
  set: (patch: Partial<Ctl>) => void
}

export interface Ctl {
  auto: boolean | undefined
  can: boolean
  held: string | null
  busy: string | null
  turns: number
  installed: string | null
  fail: string | null
  /** Resolves the install by hand when set. */
  gate: Promise<void> | null
  /** update-unverified.json as it stands (markUnverified writes it). */
  record: { version: string; from: string } | null
  /** What the install says it replaced. */
  from: string | null
  /** The install fails as the update lock does: someone else took it. */
  lockTaken: boolean
}

export function harness(over: Partial<LiveUpdateDeps> = {}, ctl0: Partial<Ctl> = {}): Harness {
  const t = fakeTime()
  const ctl: Ctl = { auto: undefined, can: true, held: null, busy: null, turns: 0, installed: null, fail: null, gate: null, record: null, from: '0.5.1', lockTaken: false, ...ctl0 }
  const status = { value: STATUS }
  const calls = { install: [] as string[], asked: [] as boolean[], unverified: [] as unknown[], noted: [] as string[], changes: 0, restarts: 0, checks: 0 }
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
      if (ctl.lockTaken) throw Object.assign(new Error('another update of /opt/w is running'), { code: 'update_busy' })
      if (ctl.fail) throw new Error(ctl.fail)
      return { from: ctl.from }
    },
    unverified: () => ctl.record,
    markUnverified: (p) => { calls.unverified.push(p); ctl.record = p },
    checkNow: async () => { calls.checks++ },
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

export const state = async (h: Harness) => (await h.updater.snapshot()).state
