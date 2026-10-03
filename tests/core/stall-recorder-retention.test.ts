/**
 * Stall recorder retention (src/core/stall-recorder-retention.ts) and the
 * profile's view of a hold (profileHoldShare in stall-recorder-hold.ts).
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
import { profileHoldShare } from '../../src/core/stall-recorder-hold.js'
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

  it('a parked thread reads as idle, and a near-empty window says nothing', () => {
    const idle = profileHoldShare(build(() => 2), offsetUs, 1100, 1500)!
    expect(idle.codeShare).toBe(0)
    expect(idle.idleShare).toBe(1)
    expect(profileHoldShare(build(() => 3), offsetUs, 1100, 1150)).toBeNull()
    expect(profileHoldShare({ nodes, startTime: 0 }, offsetUs, 1100, 1500)).toBeNull()
  })
})
