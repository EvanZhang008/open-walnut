/**
 * The disk alarm and the reclaim its auto-fix runs agree on when the disk is low.
 * 2026-11-18: disk.free rang at 29 GB (its line is 30) while the task-dir sweep
 * counted the disk low only under its 20 GB floor, so the auto-fix ran a calm round
 * and freed 0.0 GB. Every alarm whose auto-fix is the sweep now makes the sweep a
 * low-disk round while it rings, and no other reclaim reads the floor on its own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { allAlarms, BUILTIN_ALARMS } from '../../../src/core/health-monitor/alarms.js'
import { alarmRinging } from '../../../src/core/health-monitor/index.js'
import type { AlarmInstanceState, AlarmOverride } from '../../../src/core/health-monitor/types.js'
import { localDiskLow, sweepAlarmRinging } from '../../../src/core/task-dir-sweep.js'
import { taskDirLowDiskFloorBytes } from '../../../src/lib/task-dir.js'

const GiB = 1024 ** 3
const NOW = Date.parse('2026-11-18T06:00:00Z')
const inst = (id: string, state: AlarmInstanceState['state']): AlarmInstanceState =>
  ({ id, defId: id, state, since: NOW - 60_000, value: 29, evaluatedAt: NOW, history: [], actions: [] })
const monitor = (alarms: AlarmInstanceState[], overrides: Record<string, AlarmOverride> = {}) =>
  ({ alarms: Object.fromEntries(alarms.map((a) => [a.id, a])), overrides, now: () => NOW })
const free = (gib: number) => async () => ({ bavail: (gib * GiB) / 4096, bsize: 4096 })

describe('alarmRinging', () => {
  it.each([
    ['in ALARM', [inst('disk.free', 'ALARM')], {}, true],
    ['OK', [inst('disk.free', 'OK')], {}, false],
    ['no data yet', [inst('disk.free', 'INSUFFICIENT_DATA')], {}, false],
    ['another alarm rings', [inst('host.link', 'ALARM')], {}, false],
    ['turned off', [inst('disk.free', 'ALARM')], { 'disk.free': { enabled: false } }, false],
    ['muted for an hour', [inst('disk.free', 'ALARM')], { 'disk.free': { mutedUntil: NOW + 3_600_000 } }, false],
    ['a mute that ran out', [inst('disk.free', 'ALARM')], { 'disk.free': { mutedUntil: NOW - 1 } }, true],
  ] as const)('%s', (_label, alarms, overrides, expected) => {
    expect(alarmRinging('disk.free', monitor([...alarms], overrides as Record<string, AlarmOverride>))).toBe(expected)
  })

  it('is false where no monitor runs (a test, an isolated server)', () => {
    expect(alarmRinging('disk.free', null)).toBe(false)
  })
})

describe('localDiskLow while the disk alarm rings', () => {
  const floorGiB = taskDirLowDiskFloorBytes(process.env) / GiB
  const disk = BUILTIN_ALARMS.find((a) => a.id === 'disk.free')!
  const between = (floorGiB + disk.threshold) / 2 // above the floor, under the alarm's line

  it('the alarm line sits above the floor, which is why the floor alone missed it', () => {
    expect(disk.threshold).toBeGreaterThan(floorGiB)
  })

  it('counts the disk low between the floor and the alarm line only while the alarm rings', async () => {
    expect(await localDiskLow(free(between), async () => true)).toBe(true)
    expect(await localDiskLow(free(between), async () => false)).toBe(false)
  })

  it('still reads the floor when the alarm is quiet or cannot be read', async () => {
    expect(await localDiskLow(free(floorGiB / 2), async () => false)).toBe(true)
    expect(await localDiskLow(free(floorGiB / 2), async () => { throw new Error('no monitor') })).toBe(true)
    expect(await localDiskLow(free(between), async () => { throw new Error('no monitor') })).toBe(false)
  })
})

describe('every alarm whose auto-fix is the sweep makes it a low-disk round', () => {
  const sweepers = allAlarms().filter((a) => a.action.autoFix === 'disk-sweep')

  it('has at least the disk alarm', () => {
    expect(sweepers.map((a) => a.id)).toContain('disk.free')
  })

  it.each(sweepers.map((a) => [a.id]))('%s ringing counts', async (id) => {
    expect(await sweepAlarmRinging((a) => a === id)).toBe(true)
  })

  it('no other alarm ringing counts', async () => {
    const others = allAlarms().filter((a) => a.action.autoFix !== 'disk-sweep').map((a) => a.id)
    expect(await sweepAlarmRinging((a) => others.includes(a))).toBe(false)
  })

  it('the auto-fix asks the sweep for a low-disk round, never a calm one it could join', async () => {
    vi.resetModules()
    const sweepTaskDirsNow = vi.fn(async () => [])
    vi.doMock('../../../src/core/task-dir-sweep.js', () => ({ sweepTaskDirsNow }))
    try {
      const { runAutoFix } = await import('../../../src/core/health-monitor/auto-fix.js')
      const r = await runAutoFix('disk-sweep', process.cwd())
      expect(r.ok).toBe(true)
      expect(sweepTaskDirsNow).toHaveBeenCalledWith({ lowDisk: true })
    } finally {
      vi.doUnmock('../../../src/core/task-dir-sweep.js')
      vi.resetModules()
    }
  })
})

describe('the low-disk floor has one reader for reclaim', () => {
  // A new reclaim that reads the floor itself would again wait under the alarm's line:
  // it goes through localDiskLow instead. The size notice reads it only for its repeat clock.
  const ALLOWED = new Set(['src/core/task-dir-sweep.ts', 'src/core/task-dir-size-notice.ts', 'src/lib/task-dir.ts'])

  it('only the allowed files call taskDirLowDiskFloorBytes', () => {
    const root = path.resolve(__dirname, '../../..')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes('taskDirLowDiskFloorBytes(')) hits.push(path.relative(root, p))
      }
    }
    walk(path.join(root, 'src'))
    expect(hits.filter((h) => !ALLOWED.has(h))).toEqual([])
  })
})
