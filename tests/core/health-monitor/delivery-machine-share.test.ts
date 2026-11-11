/**
 * A slow resume is Walnut's to fix only when Walnut spent the time.
 *
 * 2026-11-11 the send.resume alarm opened a fix task on two kinds of wait that
 * were not the resume path's: messages to clouddev sessions that waited 65 to
 * 90 s for its link to come back (each resume then took about 5 s), and resumes
 * on the Mac that took 47 to 189 s while its memory was under pressure (swap
 * 7.8 of 9.2 GB, 20 GB in the compressor, the kernel's level warn; the same
 * resumes on clouddev took 1 to 4 s; the CLI wrote its first debug line 73 s
 * after its spawn).
 *
 * This file pins the host link ledger, the machine share of a resume, the split
 * from the wide event to the two health metrics, and the class rule: every
 * latency alarm that opens a fix task says whether a machine share exists for
 * it and, where it does, which no-action alarm counts it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_ALARMS } from '../../../src/core/health-monitor/alarms.js'
import { MinuteCollector, RESUME_MACHINE_METRIC } from '../../../src/core/health-monitor/collect.js'
import { STALL_MACHINE_METRIC, STALL_OWN_METRIC } from '../../../src/core/stall-cause.js'
import { resumeMachineShare } from '../../../src/providers/delivery-latency.js'
import { _resetMemoryPressureForTest, applyPressureReading, memoryPressureSeenSince } from '../../../src/core/memory-pressure.js'
import { __resetHostLinkLedgerForTest, linkDownIntervals, noteHostLinkDown, noteHostLinkUp } from '../../../src/providers/host-link-ledger.js'
import { observe } from '../../../src/core/observability/metrics.js'
import { recordTurn } from '../../../src/core/observability/recorder.js'

describe('host link ledger', () => {
  afterEach(() => __resetHostLinkLedgerForTest())

  it('keeps each outage per host and clips it to the wait', () => {
    noteHostLinkDown('clouddev', 1_000)
    noteHostLinkDown('clouddev', 1_500) // a second down edge keeps the first start
    noteHostLinkUp('clouddev', 4_000)
    noteHostLinkDown('olddev', 2_000)
    expect(linkDownIntervals('clouddev', 0, 10_000)).toEqual([{ start: 1_000, end: 4_000 }])
    expect(linkDownIntervals('clouddev', 2_000, 3_000)).toEqual([{ start: 2_000, end: 3_000 }])
    // An outage still open counts up to now.
    expect(linkDownIntervals('olddev', 0, 10_000, 6_000)).toEqual([{ start: 2_000, end: 6_000 }])
    expect(linkDownIntervals('__local__', 0, 10_000)).toEqual([])
  })

  it('an up edge with no down edge records nothing', () => {
    noteHostLinkUp('clouddev', 5_000)
    expect(linkDownIntervals('clouddev', 0, 10_000)).toEqual([])
  })
})

describe('resumeMachineShare', () => {
  const now = 1_000_000
  const base = { local: true, enqueuedAtMs: now - 195_000, outOfPathSinceSpawnMs: 0, now, pressuredSinceSpawn: true }

  it('a local CLI that waited on paging starting is the machine\'s (the 2026-11-11 18:13 resume)', () => {
    // Enqueued 18:13:55, spawned 18:14:04, read its line 18:17:09: 186 s of 189 s were the CLI's start.
    expect(resumeMachineShare({ ...base, spawnedAtMs: now - 185_904, deliveryMs: 188_782 })).toBe(185_904)
  })

  it('stays the path\'s with no memory pressure, on a remote host, or when Walnut spent most of the wait', () => {
    expect(resumeMachineShare({ ...base, pressuredSinceSpawn: false, spawnedAtMs: now - 185_904, deliveryMs: 188_782 })).toBe(0)
    expect(resumeMachineShare({ ...base, local: false, spawnedAtMs: now - 185_904, deliveryMs: 188_782 })).toBe(0)
    // 150 s in Walnut's queue before a 30 s start: the queue is a Walnut wait.
    expect(resumeMachineShare({ ...base, spawnedAtMs: now - 30_000, deliveryMs: 180_000 })).toBe(0)
    expect(resumeMachineShare({ ...base, spawnedAtMs: 0, deliveryMs: 180_000 })).toBe(0)
    // A start older than the message (another wait's process) is not this wait's.
    expect(resumeMachineShare({ ...base, enqueuedAtMs: now - 100_000, spawnedAtMs: now - 3_600_000, deliveryMs: 100_000 })).toBe(0)
  })

  it('sleep or a down link after the spawn is not counted as the CLI\'s start', () => {
    // 100 s in Walnut before the spawn, then 20 s of start and 5 min asleep: the start is 20 of the 120 awake seconds.
    expect(resumeMachineShare({ ...base, enqueuedAtMs: now - 420_000, outOfPathSinceSpawnMs: 300_000, spawnedAtMs: now - 320_000, deliveryMs: 120_000 })).toBe(0)
  })

  it('the share never passes the wait', () => {
    expect(resumeMachineShare({ ...base, spawnedAtMs: now - 150_000, deliveryMs: 120_000 })).toBe(120_000)
  })
})

describe('memoryPressureSeenSince', () => {
  afterEach(() => _resetMemoryPressureForTest())

  it('a warn reading after the start counts, one before it does not once the level is normal again', () => {
    _resetMemoryPressureForTest()
    expect(memoryPressureSeenSince(0)).toBe(false)
    applyPressureReading('warn', 5_000)
    expect(memoryPressureSeenSince(4_000)).toBe(true)
    applyPressureReading('normal', 6_000)
    expect(memoryPressureSeenSince(4_000)).toBe(true)
    expect(memoryPressureSeenSince(5_500)).toBe(false)
    applyPressureReading('critical', 7_000)
    expect(memoryPressureSeenSince(Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})

describe('the wide event feeds two health metrics', () => {
  it('the machine share goes to its own metric, the rest stays the resume path\'s', () => {
    const c = new MinuteCollector({ dataDir: '/nonexistent' })
    c.start()
    try {
      recordTurn({ sessionId: 's1', isError: false, deliveryMs: 188_782, deliveryPath: 'resume', deliveryMachineMs: 185_904 })
      recordTurn({ sessionId: 's2', isError: false, deliveryMs: 4_806, deliveryPath: 'resume' })
      recordTurn({ sessionId: 's3', isError: false, deliveryMs: 900, deliveryPath: 'stdin' })
      const row = (c as unknown as { maxes: Map<string, number> }).maxes
      expect(row.get('send.delivery.resume')).toBe(4_806)
      expect(row.get(RESUME_MACHINE_METRIC)).toBe(185_904)
      expect(row.get('send.delivery.live')).toBe(900)
      // A machine label on any other path maps to no health metric.
      observe('session.delivery', 50_000, { path: 'stdin', cause: 'machine' })
      expect(row.get('send.delivery.live')).toBe(900)
    } finally {
      c.stop()
    }
  })
})

/**
 * Every millisecond alarm that opens a fix task, and whether the machine can take
 * a share of what it measures. A new one fails here until it says.
 */
const MACHINE_SHARE: Record<string, { machineMetric: string } | { none: string }> = {
  [STALL_OWN_METRIC]: { machineMetric: STALL_MACHINE_METRIC },
  'send.delivery.resume': { machineMetric: RESUME_MACHINE_METRIC },
  'send.delivery.live': { none: 'a write into a live CLI\'s stdin starts no process; its waits are the queue\'s and the daemon\'s' },
}

describe('fix-task latency alarms count the machine apart', () => {
  it('every fix-task millisecond alarm says where the machine\'s share goes', () => {
    const fix = BUILTIN_ALARMS.filter((a) => a.unit === 'ms' && a.action?.then === 'fix-task')
    expect(fix.length).toBeGreaterThan(0)
    for (const a of fix) {
      const entry = MACHINE_SHARE[a.metric]
      expect(entry, `alarm ${a.id} (${a.metric}) opens a fix task: say in MACHINE_SHARE whether the machine takes a share of it`).toBeDefined()
      if (entry && 'machineMetric' in entry) {
        const twin = BUILTIN_ALARMS.find((b) => b.metric === entry.machineMetric)
        expect(twin, `${a.metric}'s machine share ${entry.machineMetric} has no alarm`).toBeDefined()
        expect(twin!.action?.then, `${twin!.id} counts the machine: it must not open a fix task`).toBe('none')
      }
    }
    for (const metric of Object.keys(MACHINE_SHARE)) {
      expect(fix.some((a) => a.metric === metric), `MACHINE_SHARE lists ${metric}, which no fix-task alarm reads`).toBe(true)
    }
  })
})
