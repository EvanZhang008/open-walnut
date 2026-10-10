/**
 * Stall recorder retention (src/core/stall-recorder-retention.ts), the
 * profile's view of a hold (profileHoldShare in stall-recorder-profiler.ts) and
 * the span of the hold itself, with the pause before it and the loop's rate
 * (pickHoldSpan in stall-recorder-hold.ts).
 *
 * Temp files: writeWhole writes `.tmp-<pid>-stall-...` and renames it into
 * place. A process that dies between the two (a crash, a SIGKILL) left the
 * temp file behind, and the pruner only ever looked at `stall-` names, so
 * those piled up without a bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pruneStallDir } from '../../src/core/stall-recorder-retention.js'
import { pickHoldSpan, profileHoldShare, type CpuCheckpoint, type TickSample } from '../../src/core/stall-recorder-hold.js'
import { startStallRecorder, stopStallRecorder, type ProfilerDriver } from '../../src/core/stall-recorder.js'
import { log } from '../../src/logging/index.js'

const LIMITS = { maxFiles: 40, maxAgeMs: 3 * 86_400_000, maxBytes: 256 * 1048576 }

/** A pid that existed a moment ago and is gone now. */
function deadPid(): number {
  const r = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

describe('stall dir retention: temp files', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-ret-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const put = (name: string, ageMs = 0) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, '{}')
    if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t) }
    return name
  }

  it('removes what a dead writer left, keeps a live write in flight, and ages out the rest', async () => {
    const dead = put(`.tmp-${deadPid()}-stall-20261003T010203Z-3000ms-1.cpuprofile`)
    const mineFresh = put(`.tmp-${process.pid}-stall-20261003T010203Z-3000ms-${process.pid}.json`)
    const mineStale = put(`.tmp-${process.pid}-stall-20261003T000000Z-2000ms-${process.pid}.cpuprofile`, 11 * 60_000)
    const otherLive = put(`.tmp-${process.ppid}-stall-20261003T010203Z-4000ms-${process.ppid}.cpuprofile`)
    const otherLiveStale = put(`.tmp-${process.ppid}-stall-20261002T000000Z-4000ms-${process.ppid}.json`, 11 * 60_000)
    const notOurs = put(`.tmp-${deadPid()}-other-file`)
    const kept = put('stall-20261003T010203Z-3000ms-1.json')
    await pruneStallDir(dir, LIMITS)
    const left = fs.readdirSync(dir).sort()
    expect(left).toEqual([mineFresh, otherLive, notOurs, kept].sort())
    expect(left).not.toContain(dead)
    expect(left).not.toContain(mineStale)
    expect(left).not.toContain(otherLiveStale)
  })

  it('the recorder sweeps them at start, before any stall is kept', async () => {
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    const leftover = put(`.tmp-${deadPid()}-stall-20261003T010203Z-3000ms-9.cpuprofile`)
    const driver: ProfilerDriver = {
      begin: async () => {},
      end: async () => ({ nodes: [], startTime: 0, endTime: 1 }),
      close: async () => {},
    }
    try {
      await startStallRecorder({ force: true, dir, windowMs: 3_600_000, profiler: driver, systemContext: false })
      for (let i = 0; i < 100 && fs.existsSync(path.join(dir, leftover)); i++) await new Promise((r) => setTimeout(r, 10))
      expect(fs.existsSync(path.join(dir, leftover))).toBe(false)
    } finally {
      await stopStallRecorder()
      vi.restoreAllMocks()
    }
  })
})

describe('profileHoldShare', () => {
  // Profile time (us) = mono ms * 1000 + offsetUs. Samples every 20 ms from
  // mono 1000 ms; the hold is mono 1100..1500.
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)' } },
    { id: 2, callFrame: { functionName: '(idle)' } },
    { id: 3, callFrame: { functionName: 'rankAll', url: 'file:///repo/dist/core/search.js', lineNumber: 41 } },
    { id: 4, callFrame: { functionName: '(garbage collector)' } },
    { id: 5, callFrame: { functionName: '(program)' } },
  ]
  const offsetUs = 5_000_000
  const build = (pick: (monoMs: number) => number) => {
    const samples: number[] = []
    const timeDeltas: number[] = []
    for (let m = 1000; m < 1600; m += 20) { samples.push(pick(m)); timeDeltas.push(20_000) }
    // startTime + first delta = the first sample, at mono 1000.
    return { nodes, startTime: 1000 * 1000 + offsetUs - 20_000, samples, timeDeltas }
  }

  it('measures code against idle inside the hold only, and names the heaviest frame', () => {
    const p = build((m) => (m >= 1100 && m < 1500 ? (m % 100 === 0 ? 4 : 3) : 2))
    const h = profileHoldShare(p, offsetUs, 1100, 1500)!
    expect(h.samples).toBe(20)
    // 1100, 1200, 1300 and 1400 are GC samples: 4 of the 20 inside the hold.
    expect(h.codeShare).toBe(0.8)
    expect(h.gcShare).toBe(0.2)
    expect(h.idleShare).toBe(0)
    expect(h.top).toEqual([{ frame: 'rankAll /repo/dist/core/search.js:42', share: 0.8 }])
  })

  it('a gap the sampler did not see counts as nothing: a sample stands for two intervals at most', () => {
    // Idle samples every 20 ms with one code sample at mono 1200, then none
    // until 1500 (the sampler was stopped with the process), then idle again.
    // Hold 1100..1600. Crediting the 300 ms gap to the 1200 sample used to make
    // this hold 60% code.
    const samples: number[] = []
    const timeDeltas: number[] = []
    let last = 1000 * 1000 + offsetUs - 20_000
    const at = (m: number, node: number) => { const us = m * 1000 + offsetUs; samples.push(node); timeDeltas.push(us - last); last = us }
    for (let m = 1000; m <= 1200; m += 20) at(m, m === 1200 ? 3 : 2)
    for (let m = 1500; m < 1700; m += 20) at(m, 2)
    const p = { nodes, startTime: 1000 * 1000 + offsetUs - 20_000, samples, timeDeltas }
    for (const h of [profileHoldShare(p, offsetUs, 1100, 1600, 20_000)!, profileHoldShare(p, offsetUs, 1100, 1600)!]) {
      // In the hold: 1100..1180 idle (100 ms), 1200 code capped at 40 ms, and
      // 1500..1580 idle (100 ms): 240 ms sampled of 500, 40 of them code.
      expect(h.samples).toBe(11)
      expect(h.coverage).toBe(0.48)
      expect(h.codeShare).toBe(0.17)
      expect(h.idleShare).toBe(0.83)
    }
  })

  it('a parked thread reads as idle, and a near-empty window says nothing', () => {
    const idle = profileHoldShare(build(() => 2), offsetUs, 1100, 1500)!
    expect(idle.codeShare).toBe(0)
    expect(idle.idleShare).toBe(1)
    expect(profileHoldShare(build(() => 3), offsetUs, 1100, 1150)).toBeNull()
    expect(profileHoldShare({ nodes, startTime: 0 }, offsetUs, 1100, 1500)).toBeNull()
  })
})

describe('pickHoldSpan', () => {
  const tick = (mono: number, cpuMs: number): TickSample => ({
    mono, threadUserUs: cpuMs * 1000, threadSysUs: 0, procUserUs: 0, procSysUs: 0, majflt: 0, minflt: 0, nivcsw: 0, nvcsw: 0, idleMs: 40,
  })
  const cp = (mono: number, cpuMs: number, idleMs = 0): CpuCheckpoint => ({ mono, cpuUs: cpuMs * 1000, idleMs })

  it('begins at the last checkpoint after the previous probe and no later than the deadline', () => {
    const prev = tick(10_000, 500)
    // Older than the probe, inside the second before the deadline, and two from
    // after it (the loop free again, then catching up).
    const ring = [cp(9_900, 490), cp(12_600, 950), cp(10_300, 600), cp(10_700, 700), cp(12_500, 900)]
    expect(pickHoldSpan(prev, ring, 11_000, 13_000)).toEqual({ since: cp(10_700, 700), until: cp(12_500, 900), afterWaitMs: 0, afterHoldPauseMs: 0 })
    // A deadline right after the probe: only what came before it begins the hold.
    expect(pickHoldSpan(prev, ring, 10_400, 13_000).since).toEqual(cp(10_300, 600))
  })

  it('ends at the first checkpoint after the deadline, never one after the probe ran', () => {
    const prev = tick(10_000, 500)
    const ring = [cp(10_700, 700), cp(12_500, 900), cp(12_400, 880)]
    expect(pickHoldSpan(prev, ring, 11_000, 13_000).until).toEqual(cp(12_400, 880))
    expect(pickHoldSpan(prev, ring, 11_000, 12_450).until).toEqual(cp(12_400, 880))
    expect(pickHoldSpan(prev, ring, 11_000, 12_300).until).toBeNull()
  })

  it('falls back to the previous probe when no checkpoint lies between it and the deadline', () => {
    const prev = tick(10_000, 500)
    expect(pickHoldSpan(prev, [], 11_000, 13_000)).toEqual({ since: cp(10_000, 500, 40), until: null, afterWaitMs: 0, afterHoldPauseMs: 0 })
    expect(pickHoldSpan(prev, [cp(9_950, 495), cp(11_200, 800)], 11_000, 13_000)).toEqual({ since: cp(10_000, 500, 40), until: cp(11_200, 800), afterWaitMs: 0, afterHoldPauseMs: 0 })
  })

  it('says when the hold began as the loop came back from a long wait in poll', () => {
    // The probe ran 10 ms after the checkpoint that ended a 3 s stop in poll
    // (3 s of the loop's idle time between the two checkpoints around it).
    const prev = tick(20_010, 500)
    const stopped = [cp(16_990, 490, 1_000), cp(20_000, 495, 4_000)]
    expect(pickHoldSpan(prev, stopped, 21_010, 23_000).afterWaitMs).toBe(3_010)
    // The loop's own checkpoints right after it (the end of that iteration, then
    // the 100 ms timer in the next) do not hide it.
    expect(pickHoldSpan(prev, [...stopped, cp(20_002, 495, 4_000), cp(20_004, 495, 4_000)], 21_010, 23_000).afterWaitMs).toBe(3_010)
    // A stretch of the same length the thread ran in (a block: a third of it) is no pause.
    expect(pickHoldSpan(prev, [cp(16_990, 490, 1_000), cp(20_000, 1_490, 1_100)], 21_010, 23_000).afterWaitMs).toBe(0)
    // Nor is a wait the hold began well after.
    expect(pickHoldSpan(tick(20_400, 500), stopped, 21_400, 23_000).afterWaitMs).toBe(0)
    // Nor a gap shorter than a second.
    expect(pickHoldSpan(prev, [cp(19_200, 490, 1_000), cp(20_000, 495, 1_800)], 21_010, 23_000).afterWaitMs).toBe(0)
    // Nothing but the pause before it: no rate to weigh its backlog by.
    expect(pickHoldSpan(prev, stopped, 21_010, 23_000).baseCpuShare).toBeUndefined()
  })

  it('a stop outside poll is a pause too: the thread barely ran, whether or not the loop waited', () => {
    // Measured 2026-10-07 by the gate's I/O backlog probe: stopped in the middle
    // of a turn, no idle time between the checkpoint before the stop and the
    // previous probe, which ran first after it; the reads that piled up came next.
    const prev = tick(20_010, 500)
    expect(pickHoldSpan(prev, [cp(17_000, 497, 1_000)], 21_010, 23_000).afterWaitMs).toBe(3_010)
    // The thread ran over a tenth of the gap: no pause.
    expect(pickHoldSpan(prev, [cp(17_000, 180, 1_000)], 21_010, 23_000).afterWaitMs).toBe(0)
    // Nor is a stall's worth under a tenth: a block load stretched (the r9 gate:
    // 1.5 s in 20 s), and 249 ms still is one, as after the hold.
    expect(pickHoldSpan(tick(20_010, 2_000), [cp(10, 500, 1_000)], 21_010, 23_000).afterWaitMs).toBe(0)
    expect(pickHoldSpan(prev, [cp(17_000, 250, 1_000)], 21_010, 23_000).afterWaitMs).toBe(0)
    expect(pickHoldSpan(prev, [cp(17_000, 251, 1_000)], 21_010, 23_000).afterWaitMs).toBe(3_010)
  })

  it('adds up the pauses between the hold and the probe, never one after the probe ran', () => {
    // Measured 2026-10-09 at load 473: the checkpoint right after the deadline,
    // a 2 s stop the loop came back from through poll, then the timers that came
    // due in it, ahead of the probe.
    const prev = tick(10_000, 500)
    const ring = [cp(10_990, 600), cp(11_015, 618), cp(13_015, 620)]
    const span = pickHoldSpan(prev, ring, 11_000, 13_566)
    expect(span.until).toEqual(cp(11_015, 618))
    expect(span.afterHoldPauseMs).toBe(2_000)
    // Two of them add up; a gap the thread ran a block in, a gap under a second,
    // and a checkpoint after the probe add nothing.
    expect(pickHoldSpan(prev, [...ring, cp(13_020, 621), cp(14_520, 622)], 11_000, 14_600).afterHoldPauseMs).toBe(3_500)
    expect(pickHoldSpan(prev, [cp(10_990, 600), cp(11_015, 618), cp(13_015, 1_018)], 11_000, 13_566).afterHoldPauseMs).toBe(0)
    expect(pickHoldSpan(prev, [cp(10_990, 600), cp(11_015, 618), cp(11_900, 619)], 11_000, 13_566).afterHoldPauseMs).toBe(0)
    expect(pickHoldSpan(prev, [cp(10_990, 600), cp(11_015, 618), cp(12_015, 768)], 11_000, 13_566).afterHoldPauseMs).toBe(0)
    expect(pickHoldSpan(prev, ring, 11_000, 12_500).afterHoldPauseMs).toBe(0)
    // A block behind the checkpoint runs up to the probe: no checkpoint ends it.
    expect(pickHoldSpan(prev, [cp(10_990, 600), cp(11_015, 618)], 11_000, 13_566).afterHoldPauseMs).toBe(0)
    // Nor is a block load stretched between two checkpoints, under a tenth of
    // its gap (measured 2026-10-09 at load 99: 400 ms in 15 s), and 249 ms is.
    expect(pickHoldSpan(prev, [cp(10_990, 600), cp(11_015, 618), cp(26_015, 1_018)], 11_000, 26_500).afterHoldPauseMs).toBe(0)
    expect(pickHoldSpan(prev, [cp(10_990, 600), cp(11_015, 618), cp(26_015, 867)], 11_000, 26_500).afterHoldPauseMs).toBe(15_000)
  })

  /** A steady loop: one checkpoint every 100 ms from `from` to `to`, `per` ms of CPU between two. */
  const steady = (from: number, to: number, cpuMs: number, per = 5): CpuCheckpoint[] => {
    const out: CpuCheckpoint[] = []
    for (let t = from, c = cpuMs; t <= to; t += 100, c += per) out.push(cp(t, c))
    return out
  }

  it('reads the loop\'s normal rate over the 10 s before the pause, leaving out pauses and blocks', () => {
    // 6 to 12 s at 10%, a 1.5 s pause, 13.5 to 15 s at 5%, a 1.2 s block
    // between two checkpoints, 16.3 to 17 s at 5%, then the 3 s stop the hold
    // began after (the previous probe at 20.01 s ran first after it).
    const a = steady(6_000, 12_000, 1_000, 10)
    const b = steady(13_500, 15_000, a.at(-1)!.cpuUs / 1000 + 3)
    const c = steady(16_300, 17_000, b.at(-1)!.cpuUs / 1000 + 1_200)
    const prev = tick(20_010, c.at(-1)!.cpuUs / 1000 + 5)
    const span = pickHoldSpan(prev, [...a, ...b, ...c], 21_010, 23_000)
    expect(span.afterWaitMs).toBe(3_010)
    // From 7 s (10 s before the pause): 610 ms in 7.2 s of normal turns.
    // Counted whole, the 10 s would read 18%; from 6 s, 8.7%; from 12 s, 5%.
    expect(span.baseCpuShare).toBe(0.085)
    expect(span.baseTurnMs).toBe(10)
    expect(span.since).toEqual(cp(20_010, prev.threadUserUs / 1000, 40))
  })

  it('leaves a block load stretched out of the rate, as it leaves out pauses', () => {
    // 260 ms in 3 s: under a tenth, so not the loop's normal work, and a stall's
    // worth, so not a pause either (afterWaitMs). 5% around it.
    const a = steady(1_000, 6_000, 1_000)
    const b = steady(9_000, 12_000, a.at(-1)!.cpuUs / 1000 + 260)
    const span = pickHoldSpan(tick(11_500, b.at(-1)!.cpuUs / 1000 - 25), [...a, ...b], 12_400, 14_000)
    expect(span.since).toEqual(b.at(-1))
    expect(span.afterWaitMs).toBe(0)
    expect(span.baseCpuShare).toBe(0.05)
  })

  it('keeps the largest normal turn below a stall\'s worth', () => {
    // A loop 5% busy with one turn of 400 ms and one of 200 ms in it: the
    // first is a stall of its own, the second the largest normal turn.
    const ring = [...steady(1_000, 6_000, 1_000), cp(6_500, 1_650), cp(6_800, 1_850), ...steady(6_900, 12_000, 1_855)]
    const span = pickHoldSpan(tick(11_500, 1_855 + 5 * 46), ring, 12_400, 14_000)
    expect(span.afterWaitMs).toBe(0)
    expect(span.baseTurnMs).toBe(200)
  })

  it('with no pause, reads the rate over the 10 s before the hold began', () => {
    // A loop 5% busy up to 12 s, then a block from there: the hold begins at
    // the checkpoint before the deadline, and nothing before it was a pause.
    const ring = steady(1_000, 12_000, 1_000)
    const span = pickHoldSpan(tick(11_500, 1_000 + 5 * 105), ring, 12_400, 14_000)
    expect(span.since).toEqual(cp(12_000, 1_550))
    expect(span.afterWaitMs).toBe(0)
    expect(span.baseCpuShare).toBe(0.05)
    expect(span.baseTurnMs).toBe(5)
    // Less than a second of turns before it says nothing.
    const short = pickHoldSpan(tick(11_500, 1_525), steady(11_400, 12_000, 1_520), 12_400, 14_000)
    expect(short.baseCpuShare).toBeUndefined()
    expect(short.baseTurnMs).toBeUndefined()
  })

  it('reads the rate further back, up to a minute, when a block filled the 10 s before the pause', () => {
    // Measured 2026-10-07 by the gate's wake probes at load 264 to 349: a 2.5 s
    // block stretched to 12 s, 50 ms of normal turns, then the next 3 s stop,
    // whose real block then read `starved` with no rate to weigh the stop by.
    // A loop 5% busy from 1 s to 5 s, the block to 17 s, the 50 ms, the stop.
    const before = steady(1_000, 5_000, 1_000)
    const blockEnd = before.at(-1)!.cpuUs / 1000 + 2_500
    const ring = [...before, cp(17_000, blockEnd), cp(17_050, blockEnd + 2)]
    const span = pickHoldSpan(tick(20_060, blockEnd + 5), ring, 21_060, 23_000)
    expect(span.afterWaitMs).toBe(3_010)
    // The 50 ms, then the turns before the block until a second of them is in:
    // 52 ms in 1.05 s.
    expect(span.baseCpuShare).toBe(0.05)
    expect(span.baseTurnMs).toBe(5)
    // A block that filled the whole minute before the stop leaves no rate.
    const late = (c: CpuCheckpoint): CpuCheckpoint => cp(c.mono + 60_000, c.cpuUs / 1000)
    const old = [...before, ...[cp(17_000, blockEnd), cp(17_050, blockEnd + 2)].map(late)]
    const far = pickHoldSpan(tick(80_060, blockEnd + 5), old, 81_060, 83_000)
    expect(far.afterWaitMs).toBe(3_010)
    expect(far.baseCpuShare).toBeUndefined()
  })
})
