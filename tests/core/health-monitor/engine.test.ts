/**
 * The health monitor's minute clock end to end on a temp dir: real collector taps
 * (metrics registry, warn/error logger), real store, fake clock and fake actions.
 * Covers each action path (auto-fix then notify with recovery, fix task once per
 * alarm, the daily cap, reuse while open, mute), log spikes against a seeded
 * normal, restarts and cut-off shutdowns read from the exit trace, and a restart
 * keeping rows and state.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MinuteCollector } from '../../../src/core/health-monitor/collect.js'
import { bootOnSameBuild, FIX_TASKS_PER_DAY, HealthMonitor, type FixTaskInput, type TellTaskInput } from '../../../src/core/health-monitor/engine.js'
import { setCustomAlarms } from '../../../src/core/health-monitor/alarms.js'
import { customAlarmDefs } from '../../../src/core/health-monitor/custom-metrics.js'
import { DAY_MS, hourStart, signatureId } from '../../../src/core/health-monitor/log-alarms.js'
import { HealthStore, type ServerEvent } from '../../../src/core/health-monitor/store.js'
import { BUILTIN_ALARMS } from '../../../src/core/health-monitor/alarms.js'
import { signatureKey } from '../../../src/core/health-monitor/signature.js'
import { count } from '../../../src/core/observability/metrics.js'
import { createSubsystemLogger } from '../../../src/logging/subsystem.js'

const START = Date.parse('2026-11-08T10:00:30Z')

interface Harness {
  m: HealthMonitor
  collector: MinuteCollector
  clock: { now: number }
  fixes: FixTaskInput[]
  open: Set<string>
  autoFixes: string[]
  autoFixLabels: Array<Record<string, string> | undefined>
  /** Tasks with a live session (a tell reaches them). */
  live: Set<string>
  told: TellTaskInput[]
  notified: string[]
  recovered: string[]
  disk: { free: number; usedPct: number }
  mode: { v: 'record' | 'start' | 'off' }
  /** tellTask throws (a full host, a send that failed). */
  failTell?: boolean
}

let dir: string
let harnesses: Harness[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-monitor-'))
})

afterEach(async () => {
  for (const h of harnesses) { h.m.stop(); await h.m.flushed() }
  harnesses = []
  await fs.rm(dir, { recursive: true, force: true })
})

async function harness(opts: { pid?: number; exitTrace?: string; now?: number; build?: string | null } = {}): Promise<Harness> {
  const clock = { now: opts.now ?? START }
  const disk = { free: 200, usedPct: 40 }
  const GiB = 1024 ** 3
  const collector = new MinuteCollector({
    dataDir: dir,
    // blocks/bfree/bavail of 1 GiB each: free GB and used % as the test sets them
    statfs: async () => {
      const total = 1000
      const avail = disk.free
      const used = (disk.usedPct / 100) * (avail / (1 - disk.usedPct / 100))
      return { bsize: GiB, bavail: avail, bfree: avail, blocks: Math.round(used + avail) || total }
    },
    fdCount: async () => 100,
    memoryPressure: () => 'normal',
    sshCertExpiring: async () => false,
    rssBytes: () => 500 * 1024 * 1024,
  })
  const h: Harness = {
    clock, collector, disk, fixes: [], open: new Set(), autoFixes: [], autoFixLabels: [], live: new Set(), told: [], notified: [], recovered: [], mode: { v: 'record' },
    m: undefined as unknown as HealthMonitor,
  }
  let n = 0
  h.m = new HealthMonitor({
    store: new HealthStore(dir),
    collector,
    pid: opts.pid ?? 4242,
    build: opts.build,
    now: () => clock.now,
    exitTraceFile: opts.exitTrace ?? null,
    ...(opts.actsOn === false ? { actsOn: () => false } : {}),
    fixMode: async () => h.mode.v,
    autoFix: async (id, labels) => { h.autoFixes.push(id); h.autoFixLabels.push(labels); return { ok: true, detail: `${id} ran` } },
    openFixTask: async (input) => {
      h.fixes.push(input); const id = `task-${++n}`; h.open.add(id)
      if (input.mode === 'start') h.live.add(id)
      return { taskId: id, started: input.mode === 'start' }
    },
    isTaskOpen: async (id) => h.open.has(id),
    tellTask: async (input) => {
      h.told.push(input)
      if (h.failTell) throw new Error('409 hosts_full')
      if (!h.open.has(input.taskId)) return { delivered: false, started: false, detail: 'the task is closed' }
      if (h.live.has(input.taskId)) return { delivered: true, started: false, detail: `told its task ${input.taskId}` }
      if (input.start) { h.live.add(input.taskId); return { delivered: false, started: true, detail: `started a session on its task ${input.taskId}` } }
      return { delivered: false, started: false, detail: 'no running session' }
    },
    notify: (id) => { h.notified.push(id) },
    recover: (id) => { h.recovered.push(id) },
  })
  await h.m.start({ clock: false })
  harnesses.push(h)
  return h
}

function collectorHung(h: Harness, n: number): void {
  h.collector.setGauge('session.hung', n)
}

async function minutes(h: Harness, n: number, each?: (i: number) => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    each?.(i)
    h.clock.now += 60_000
    await h.m.tick()
  }
}

describe('health monitor engine', () => {
  it('a host link that keeps dropping opens ONE fix task, reused while it is open', async () => {
    const h = await harness()
    // 10 drops an hour for two hours: the reconnect runs first, for that host
    await minutes(h, 121, (i) => { if (i % 6 === 0) count('host.link.lost', 1, { host: 'devbox' }) })
    const a = h.m.alarms['host.link{host=devbox}']
    expect(a?.state).toBe('ALARM')
    expect(h.autoFixes).toEqual(['host-reconnect'])
    expect(h.autoFixLabels).toEqual([{ host: 'devbox' }])
    expect(h.fixes).toHaveLength(0)
    // still dropping after its hour of grace: one fix task
    await minutes(h, 61, (i) => { if (i % 6 === 0) count('host.link.lost', 1, { host: 'devbox' }) })
    expect(h.fixes).toHaveLength(1)
    expect(h.fixes[0].title).toContain('devbox')
    expect(h.fixes[0].brief).toContain('host.link.lost{host=devbox}')
    expect(a.fixTaskId).toBe('task-1')
    // calm for two hours: OK; then drops again: the open task is reused, no second one
    await minutes(h, 125)
    expect(h.m.alarms['host.link{host=devbox}'].state).toBe('OK')
    await minutes(h, 125 + 61, (i) => { if (i % 6 === 0) count('host.link.lost', 1, { host: 'devbox' }) })
    expect(h.m.alarms['host.link{host=devbox}'].state).toBe('ALARM')
    expect(h.fixes).toHaveLength(1)
    expect(h.m.alarms['host.link{host=devbox}'].actions.find((x) => x.kind === 'fix-task')?.detail).toContain('still open')
  })

  it('disk: the auto-fix runs first, the card only after its grace, and the card is retired on OK', async () => {
    const h = await harness()
    h.disk.free = 20
    h.disk.usedPct = 96
    await minutes(h, 16)
    expect(h.m.alarms['disk.free'].state).toBe('ALARM')
    expect(h.autoFixes).toEqual(['disk-sweep'])
    expect(h.notified).toEqual([])
    await minutes(h, 31)
    expect(h.notified).toEqual(['disk.free'])
    expect(h.autoFixes).toEqual(['disk-sweep'])
    h.disk.free = 80
    h.disk.usedPct = 70
    await minutes(h, 6)
    expect(h.m.alarms['disk.free'].state).toBe('OK')
    expect(h.recovered).toEqual(['disk.free'])
    expect(h.fixes).toHaveLength(0)
  })

  it('a muted alarm evaluates but does nothing; a lower threshold through an override fires', async () => {
    const h = await harness()
    h.m.setOverride('disk.free', { mutedUntil: START + 3 * 3_600_000 }, 'human')
    h.disk.free = 20
    h.disk.usedPct = 96
    await minutes(h, 16)
    expect(h.m.alarms['disk.free'].state).toBe('ALARM')
    expect(h.autoFixes).toEqual([])
    h.m.setOverride('disk.free', { mutedUntil: null, threshold: 10 }, 'task:abc')
    await minutes(h, 2)
    expect(h.m.alarms['disk.free'].state).toBe('OK')
    expect(h.m.overrides['disk.free']).toMatchObject({ threshold: 10, by: 'task:abc' })
  })

  it('a kind of log line far above its normal raises a log spike with its own fix task', async () => {
    const sig = signatureKey('session', 'gateway relay refused')
    // three earlier days: 10 at this hour
    const hours: Record<string, Record<string, number>> = {}
    for (let d = 1; d <= 3; d++) hours[String(hourStart(START + 30 * 60_000) - d * DAY_MS)] = { [signatureId(sig)]: 10 }
    const meta = { [signatureId(sig)]: { sig, level: 'warn', sample: 'session: gateway relay refused', lastAt: START - DAY_MS } }
    await fs.writeFile(path.join(dir, 'log-hours.json'), JSON.stringify({ version: 1, hours, meta }))
    const h = await harness()
    const logger = createSubsystemLogger('session')
    // 3 a minute through the real logger: 90 in half an hour, normal 10, alarm at 50
    await minutes(h, 30, () => { for (let k = 0; k < 3; k++) logger.warn('gateway relay refused', { n: k }) })
    const id = `log.spike:${signatureId(sig)}`
    expect(h.m.alarms[id]?.state).toBe('ALARM')
    expect(h.m.alarms[id].signature).toBe(sig)
    expect(h.fixes.map((f) => f.alarmId)).toContain(id)
    expect(h.fixes.find((f) => f.alarmId === id)!.brief).toContain('gateway relay refused')
    // a kind with no normal yet never alarms
    expect(Object.values(h.m.alarms).filter((a) => a.signature && a.signature !== sig)).toEqual([])
    // stored by the short id, with the kind in meta
    h.m.stop()
    await h.m.flushed()
    harnesses = harnesses.filter((x) => x !== h)
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'log-hours.json'), 'utf-8'))
    const thisHour = saved.hours[String(hourStart(START + 30 * 60_000))]
    expect(thisHour[signatureId(sig)]).toBe(90)
    expect(saved.meta[signatureId(sig)].sig).toBe(sig)
  })

  it('at most FIX_TASKS_PER_DAY new fix tasks a day; the rest wait and say so', async () => {
    const h = await harness()
    const hosts = Array.from({ length: FIX_TASKS_PER_DAY + 2 }, (_, i) => `h${i}`)
    // past each host's reconnect and its hour of grace
    await minutes(h, 182, (i) => { if (i % 5 === 0) for (const host of hosts) count('host.link.lost', 1, { host }) })
    expect(h.fixes).toHaveLength(FIX_TASKS_PER_DAY)
    const waiting = hosts.map((x) => h.m.alarms[`host.link{host=${x}}`]).filter((a) => a.actions.some((x) => x.kind === 'fix-task' && !x.ok))
    expect(waiting).toHaveLength(2)
    expect(waiting[0].actions.find((x) => x.kind === 'fix-task')!.detail).toContain('waiting')
  })

  it('fix tasks off: the alarm shows, nothing is filed; turned back on, the alarm still ringing gets its task', async () => {
    const h = await harness()
    h.mode.v = 'off'
    await minutes(h, 182, (i) => { if (i % 5 === 0) count('host.link.lost', 1, { host: 'x' }) })
    expect(h.m.alarms['host.link{host=x}'].state).toBe('ALARM')
    expect(h.fixes).toHaveLength(0)
    h.mode.v = 'record'
    await minutes(h, 31, (i) => { if (i % 5 === 0) count('host.link.lost', 1, { host: 'x' }) })
    expect(h.m.alarms['host.link{host=x}'].state).toBe('ALARM')
    expect(h.fixes.map((f) => f.alarmId)).toEqual(['host.link{host=x}'])
  })

  it("an alarm turned off stays off for an instance given only its own threshold", async () => {
    const h = await harness()
    h.m.setOverride('host.link', { enabled: false }, 'human')
    h.m.setOverride('host.link{host=y}', { threshold: 2 }, 'human')
    await minutes(h, 121, (i) => { if (i % 5 === 0) count('host.link.lost', 1, { host: 'y' }) })
    expect(h.m.alarms['host.link{host=y}'].state).toBe('ALARM')
    expect(h.fixes).toHaveLength(0)
    // a mute on the alarm holds the instance the same way
    h.m.setOverride('host.link', { enabled: true, mutedUntil: h.clock.now + 3_600_000 }, 'human')
    await minutes(h, 5, (i) => { if (i % 5 === 0) count('host.link.lost', 1, { host: 'y' }) })
    expect(h.fixes).toHaveLength(0)
  })

  it('old log alarms back to OK never use up the room for a new one, and are forgotten once their fix task closed', async () => {
    const old = START - 10 * DAY_MS
    const alarms: Record<string, unknown> = {}
    for (let i = 0; i < 70; i++) {
      const id = `log.spike:old${i}`
      alarms[id] = { id, defId: 'log.spike', state: 'OK', since: old, value: 0, evaluatedAt: old, history: [], actions: [], signature: `old: kind ${i}`, fixTaskId: `closed-${i}` }
    }
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, alarms, overrides: {}, events: [], fixes: [] }))
    const logger = createSubsystemLogger('session')
    // a new kind on three recorded days without it (a zero normal): 30 in an hour rings
    const sig = signatureKey('session', 'brand new failure')
    const hours: Record<string, Record<string, number>> = {}
    for (let d = 1; d <= 3; d++) hours[String(hourStart(START + 30 * 60_000) - d * DAY_MS)] = {}
    await fs.writeFile(path.join(dir, 'log-hours.json'), JSON.stringify({ version: 1, hours, meta: {} }))
    const h2 = await harness()
    await minutes(h2, 20, () => { for (let k = 0; k < 3; k++) logger.error('brand new failure') })
    expect(h2.m.alarms[`log.spike:${signatureId(sig)}`]?.state).toBe('ALARM')
    expect(h2.fixes.map((f) => f.alarmId)).toContain(`log.spike:${signatureId(sig)}`)
    // the hourly pass forgets the old ones (their fix tasks are closed)
    await minutes(h2, 45)
    expect(Object.keys(h2.m.alarms).filter((id) => id.startsWith('log.spike:old'))).toEqual([])
  })

  it('a log spike still going on stays in ALARM across a restart', async () => {
    const sig = signatureKey('session', 'gateway relay refused')
    const hours: Record<string, Record<string, number>> = {}
    for (let d = 1; d <= 3; d++) hours[String(hourStart(START + 30 * 60_000) - d * DAY_MS)] = { [signatureId(sig)]: 10 }
    const meta = { [signatureId(sig)]: { sig, level: 'warn', sample: 'x', lastAt: START - DAY_MS } }
    await fs.writeFile(path.join(dir, 'log-hours.json'), JSON.stringify({ version: 1, hours, meta }))
    const h = await harness()
    const logger = createSubsystemLogger('session')
    const id = `log.spike:${signatureId(sig)}`
    await minutes(h, 20, () => { for (let k = 0; k < 3; k++) logger.warn('gateway relay refused') })
    expect(h.m.alarms[id].state).toBe('ALARM')
    h.m.stop(); await h.m.flushed(); harnesses = harnesses.filter((x) => x !== h)
    const h2 = await harness({ now: h.clock.now, pid: 6 })
    await minutes(h2, 1, () => { for (let k = 0; k < 3; k++) logger.warn('gateway relay refused') })
    expect(h2.m.alarms[id].state).toBe('ALARM')
    expect(h2.m.alarms[id].value).toBeGreaterThanOrEqual(60)
  })

  it('a task that owns the problem hears the alarm once, instead of a new fix task; the user still gets the disk card', async () => {
    const h = await harness()
    h.open.add('owner-1'); h.live.add('owner-1')
    h.m.setOverride('disk.free', { ownerTask: 'owner-1' }, 'task:lead')
    h.m.setOverride('session.hung', { ownerTask: 'owner-1' }, 'task:lead')
    h.disk.free = 20
    h.disk.usedPct = 96
    collectorHung(h, 4)
    await minutes(h, 50)
    expect(h.m.alarms['disk.free'].state).toBe('ALARM')
    expect(h.m.alarms['session.hung'].state).toBe('ALARM')
    expect(h.fixes).toHaveLength(0)
    const toOwner = h.told.filter((t) => t.taskId === 'owner-1')
    expect(toOwner.map((t) => t.text.match(/"([^"]+)" \(([^)]+)\)/)?.[2])).toEqual(['session.hung', 'disk.free'])
    expect(toOwner[0].text).toContain('You own this problem')
    expect(h.notified).toEqual(['disk.free'])
    expect(h.m.alarms['session.hung'].fixTaskId).toBe('owner-1')
    // its owner closed: the next episode files a fix task the usual way
    h.open.delete('owner-1')
    collectorHung(h, 0)
    await minutes(h, 3)
    collectorHung(h, 4)
    await minutes(h, 20)
    expect(h.fixes.map((f) => f.alarmId)).toEqual(['session.hung'])
  })

  it('a fix task filed while fix tasks only recorded is started once they start; told again on the next episode; told when OK', async () => {
    const h = await harness()
    collectorHung(h, 4)
    await minutes(h, 16)
    expect(h.fixes).toHaveLength(1)
    expect(h.told).toHaveLength(0)
    h.mode.v = 'start'
    await minutes(h, 2)
    expect(h.told.map((t) => [t.taskId, t.start])).toEqual([['task-1', true]])
    expect(h.m.alarms['session.hung'].actions.find((a) => a.kind === 'fix-task')).toMatchObject({ started: true, taskId: 'task-1' })
    await minutes(h, 5)
    expect(h.told).toHaveLength(1)
    // back to OK: the task working on it hears so, and no session is started for that
    collectorHung(h, 0)
    await minutes(h, 2)
    expect(h.m.alarms['session.hung'].state).toBe('OK')
    expect(h.told.at(-1)).toMatchObject({ taskId: 'task-1', start: false })
    expect(h.told.at(-1)!.text).toContain('back to OK')
    // a new episode an hour later: the same task, told in its session, no new one
    await minutes(h, 60)
    collectorHung(h, 4)
    await minutes(h, 16)
    expect(h.fixes).toHaveLength(1)
    expect(h.told.at(-1)).toMatchObject({ taskId: 'task-1' })
    expect(h.told.at(-1)!.text).toContain('in ALARM again')
  })

  it('a start that fails is tried again after half an hour, never every minute', async () => {
    const h = await harness()
    collectorHung(h, 4)
    await minutes(h, 16)
    h.mode.v = 'start'
    h.failTell = true
    await minutes(h, 20)
    expect(h.told).toHaveLength(1)
    expect(h.m.alarms['session.hung'].actions.find((a) => a.kind === 'fix-task')).toMatchObject({ ok: false, taskId: 'task-1' })
    h.failTell = false
    await minutes(h, 12)
    expect(h.told).toHaveLength(2)
    expect(h.m.alarms['session.hung'].actions.find((a) => a.kind === 'fix-task')).toMatchObject({ ok: true, started: true })
    expect(h.fixes).toHaveLength(1)
  })

  it('an alarm that cleared less than an hour ago must cross for one more period before it rings again', async () => {
    const h = await harness()
    const ringAfter = async (): Promise<number> => {
      for (let i = 1; i <= 30; i++) { await minutes(h, 1); if (h.m.alarms['status.mismatch']?.state === 'ALARM') return i }
      return -1
    }
    h.m.setGauge('status.mismatches', 3)
    const first = await ringAfter()
    expect(first).toBeGreaterThan(0)
    h.m.setGauge('status.mismatches', 0)
    for (let i = 0; i < 10 && h.m.alarms['status.mismatch'].state === 'ALARM'; i++) await minutes(h, 1)
    expect(h.m.alarms['status.mismatch'].state).toBe('OK')
    h.m.setGauge('status.mismatches', 3)
    const again = await ringAfter()
    expect(again).toBeGreaterThanOrEqual(first + 5)
    // long after the last clear, it rings as fast as the first time
    h.m.setGauge('status.mismatches', 0)
    for (let i = 0; i < 10 && h.m.alarms['status.mismatch'].state === 'ALARM'; i++) await minutes(h, 1)
    await minutes(h, 61)
    h.m.setGauge('status.mismatches', 3)
    expect(await ringAfter()).toBe(first)
  })

  it('a server that takes no actions still rings its alarms but does and records nothing', async () => {
    const h = await harness({ actsOn: false })
    h.mode.v = 'start'
    collectorHung(h, 4)
    h.disk.free = 20
    h.disk.usedPct = 96
    await minutes(h, 120)
    expect(h.m.alarms['session.hung'].state).toBe('ALARM')
    expect(h.m.alarms['disk.free'].state).toBe('ALARM')
    expect(h.m.alarms['session.hung'].actions).toEqual([])
    expect(h.m.alarms['disk.free'].actions).toEqual([])
    expect([h.fixes, h.autoFixes, h.told, h.notified]).toEqual([[], [], [], []])
  })

  it('a check that stops reporting is no recovery: the owner hears no OK, and the ring after it is the same episode', async () => {
    const h = await harness()
    h.open.add('owner-1'); h.live.add('owner-1')
    setCustomAlarms(customAlarmDefs([{ id: 'gate', command: 'true', alarm: { threshold: 60, minutes: 3 }, owner_task: 'owner-1' }]))
    try {
      h.m.setGauge('custom.gate', 90)
      await minutes(h, 5)
      expect(h.m.alarms['custom.gate'].state).toBe('ALARM')
      expect(h.told.map((t) => t.taskId)).toEqual(['owner-1'])
      h.m.setGauge('custom.gate', null)
      for (let i = 0; i < 10 && h.m.alarms['custom.gate'].state === 'ALARM'; i++) await minutes(h, 1)
      expect(h.m.alarms['custom.gate'].state).toBe('INSUFFICIENT_DATA')
      expect(h.told).toHaveLength(1)
      expect(h.m.alarms['custom.gate'].clearedAt).toBeUndefined()
      h.m.setGauge('custom.gate', 90)
      await minutes(h, 5)
      expect(h.m.alarms['custom.gate'].state).toBe('ALARM')
      expect(h.told).toHaveLength(1)
      expect(h.fixes).toHaveLength(0)
      // a real OK is a recovery: the owner hears it
      h.m.setGauge('custom.gate', 10)
      await minutes(h, 3)
      expect(h.m.alarms['custom.gate'].state).toBe('OK')
      expect(h.told.at(-1)!.text).toContain('back to OK')
    } finally {
      setCustomAlarms([])
    }
  })

  it('an owner that closed while its alarm rings on hands over to a new fix task after the usual delay', async () => {
    const h = await harness()
    h.open.add('owner-1'); h.live.add('owner-1')
    h.m.setOverride('session.hung', { ownerTask: 'owner-1' }, 'task:lead')
    collectorHung(h, 4)
    await minutes(h, 20)
    expect(h.told.map((t) => t.taskId)).toEqual(['owner-1'])
    h.open.delete('owner-1')
    await minutes(h, 300)
    expect(h.fixes).toHaveLength(0)
    await minutes(h, 70)
    expect(h.fixes.map((f) => f.alarmId)).toEqual(['session.hung'])
    expect(h.told.map((t) => t.taskId)).toEqual(['owner-1'])
  })

  it("owner_task null takes the owner off, even one the person's config names", async () => {
    const h = await harness()
    h.open.add('owner-1'); h.live.add('owner-1')
    setCustomAlarms(customAlarmDefs([{ id: 'gate', command: 'true', alarm: { threshold: 60, minutes: 3 }, owner_task: 'owner-1' }]))
    try {
      h.m.setOverride('custom.gate', { ownerTask: null }, 'human')
      h.m.setGauge('custom.gate', 90)
      await minutes(h, 5)
      expect(h.m.alarms['custom.gate'].state).toBe('ALARM')
      expect(h.told).toHaveLength(0)
      expect(h.fixes.map((f) => f.alarmId)).toEqual(['custom.gate'])
    } finally {
      setCustomAlarms([])
    }
  })

  it("the person's own metric with an alarm rings and files its fix task; taken out of the config, it goes", async () => {
    const h = await harness()
    setCustomAlarms(customAlarmDefs([{ id: 'deploy-wait', title: 'Deploy queue wait', command: 'true', unit: 'min', alarm: { comparison: '>', threshold: 60, minutes: 5 } }]))
    try {
      h.m.setGauge('custom.deploy-wait', 90)
      await minutes(h, 7)
      expect(h.m.alarms['custom.deploy-wait'].state).toBe('ALARM')
      expect(h.fixes.map((f) => f.title)).toEqual(['Fix: Deploy queue wait'])
      setCustomAlarms([])
      await minutes(h, 1)
      expect(h.m.alarms['custom.deploy-wait']).toBeUndefined()
    } finally {
      setCustomAlarms([])
    }
  })

  it('restarts and cut-off shutdowns of THIS server are counted from the exit trace; other pids are not', async () => {
    const trace = path.join(dir, 'exit.log')
    await fs.writeFile(trace, [
      `[${new Date(START - 3_600_000).toISOString()}] SERVER EXIT: shutdown bail after 7000ms pid=111`,
      `[${new Date(START - 3_500_000).toISOString()}] SERVER EXIT: shutdown bail after 7000ms pid=999`,
      `[${new Date(START - 3_400_000).toISOString()}] SERVER EXIT: code=0 pid=111 uptime=25s`,
    ].join('\n') + '\n')
    // an earlier boot of pid 111 recorded in state
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, alarms: {}, overrides: {}, fixes: [], events: [{ kind: 'boot', at: START - 7_200_000, pid: 111 }] }))
    const h = await harness({ exitTrace: trace, pid: 222 })
    await minutes(h, 6)
    const last = h.m.minuteRows[h.m.minuteRows.length - 1]
    expect(last.v['server.restarts_24h']).toBe(2)
    expect(last.v['server.shutdown_bails_24h']).toBe(1)
    expect(h.m.alarms['server.shutdown'].state).toBe('ALARM')
    expect(h.fixes.map((f) => f.alarmId)).toContain('server.shutdown')
  })

  it('only a start on the build that already ran is an unplanned restart; deploys are not', async () => {
    // A deploy on every boot, the way the deploy queue paces them: 20 a day stays OK.
    let pid = 100
    let now = START
    const reboot = async (build: string | null) => {
      const h = await harness({ now, pid: ++pid, build })
      await minutes(h, 6)
      h.m.stop(); await h.m.flushed(); harnesses = harnesses.filter((x) => x !== h)
      now = h.clock.now + 60 * 60_000
      return h
    }
    let h = await reboot('c0@t0')
    for (let i = 1; i < 20; i++) h = await reboot(`c${i}@t${i}`)
    let row = h.m.minuteRows[h.m.minuteRows.length - 1]
    expect(row.v['server.restarts_24h']).toBe(20)
    expect(row.v['server.deploys_24h']).toBe(20)
    expect(row.v['server.unplanned_restarts_24h']).toBe(0)
    expect(h.m.alarms['server.restarts'].state).toBe('OK')
    // The server crashes and launchd starts the same file again, twice: that is the alarm.
    h = await reboot('c19@t19')
    h = await reboot('c19@t19')
    row = h.m.minuteRows[h.m.minuteRows.length - 1]
    expect(row.v['server.unplanned_restarts_24h']).toBe(2)
    expect(h.m.alarms['server.restarts'].state).toBe('ALARM')
    expect(h.fixes.map((f) => f.alarmId)).toContain('server.restarts')
  })

  it('a boot is the same build only when the boot before it recorded that build', () => {
    const boot = (build?: string | null): ServerEvent => (build === undefined ? { kind: 'boot', at: 1, pid: 1 } : { kind: 'boot', at: 1, pid: 1, build })
    const bail: ServerEvent = { kind: 'shutdown-bail', at: 2, pid: 1 }
    expect(bootOnSameBuild([], 'a@1')).toBe(false) // first boot ever
    expect(bootOnSameBuild([boot()], 'a@1')).toBe(false) // an older Walnut's boot has no build
    expect(bootOnSameBuild([boot('a@1')], 'b@2')).toBe(false) // a deploy
    expect(bootOnSameBuild([boot('a@1')], 'a@2')).toBe(false) // a forced redeploy of one commit: new build time
    expect(bootOnSameBuild([boot('a@1'), bail], 'a@1')).toBe(true) // a respawn after a cut-off shutdown
    expect(bootOnSameBuild([boot('a@1'), boot('b@2')], 'a@1')).toBe(false) // a rollback from a new build that booted (one that died before booting reads as a restart: it was one)
    expect(bootOnSameBuild([boot(null)], null)).toBe(true) // from source, started again
  })

  it('no built-in alarm counts every boot: a restart alarm reads the unplanned count', () => {
    // Deploys restart the server by design (the deploy queue paces them); an alarm
    // on all boots asks for a fix nobody can make (2026-11-10: 16 deploys in a day).
    const restartAlarms = BUILTIN_ALARMS.filter((a) => /restart|boot|start/.test(a.metric) && a.metric.startsWith('server.'))
    expect(restartAlarms.map((a) => a.metric)).toEqual(['server.unplanned_restarts_24h'])
  })

  it('a restart in the small hours reads back every UTC day of its 26-hour window', async () => {
    const now = Date.parse('2026-11-08T01:00:30Z')
    const store = new HealthStore(dir)
    for (const t of [Date.parse('2026-11-06T23:30:00Z'), Date.parse('2026-11-07T12:00:00Z'), Date.parse('2026-11-08T00:30:00Z')]) {
      await store.appendMinute({ t, v: { x: 1 } })
    }
    const rows = await store.loadRecentMinutes(now)
    expect(rows.map((r) => new Date(r.t).toISOString().slice(0, 10))).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
  })

  it('a restart keeps the rows, the states and the history', async () => {
    const h = await harness()
    h.disk.free = 20
    h.disk.usedPct = 96
    await minutes(h, 16)
    h.m.stop()
    await h.m.flushed()
    harnesses = harnesses.filter((x) => x !== h)
    const h2 = await harness({ now: h.clock.now, pid: 5 })
    expect(h2.m.minuteRows.length).toBeGreaterThanOrEqual(16)
    expect(h2.m.alarms['disk.free'].state).toBe('ALARM')
    expect(h2.m.alarms['disk.free'].history.at(-1)?.to).toBe('ALARM')
    // the auto-fix already ran in this episode: not again after the restart
    h2.disk.free = 20
    h2.disk.usedPct = 96
    await minutes(h2, 2)
    expect(h2.autoFixes).toEqual([])
  })
})
