/**
 * Stall flight recorder end to end with the REAL inspector profiler: block the
 * loop in a named function, and the kept profile plus its summary must name it.
 * Slow tier (real 1 s probe cadence, a real 2.6 s block: whatever phase it
 * starts at, the probe is late by at least 1.6 s, over the hold-context floor).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startStallRecorder, stopStallRecorder } from '../../src/core/stall-recorder.js'
import { startEventLoopMonitor, stopEventLoopMonitor } from '../../src/core/event-loop-monitor.js'
import { log } from '../../src/logging/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function holdTheLoopForTest(ms: number): number {
  const end = Date.now() + ms
  let h = 0
  while (Date.now() < end) for (let i = 0; i < 5_000; i++) h = (h * 33 + i) | 0
  return h
}

afterEach(async () => {
  await stopStallRecorder()
  stopEventLoopMonitor()
  vi.restoreAllMocks()
})

describe('stall flight recorder with the real profiler', () => {
  it('keeps a profile for a real block and the summary names the blocking function', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-prof-'))
    const warns: Array<[string, Record<string, unknown>]> = []
    vi.spyOn(log.web, 'warn').mockImplementation((msg: string, data?: Record<string, unknown>) => { warns.push([msg, data ?? {}]) })
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    startEventLoopMonitor()
    // Short windows, so real make-before-break rotations happen before the block
    // and the claim (current vs previous window) runs against real timing.
    expect(await startStallRecorder({ force: true, dir, windowMs: 400, postStallMs: 200, profileMinMs: 500, systemContext: false })).toBe(true)
    await new Promise((r) => setTimeout(r, 1_100)) // one on-time probe and two rotations first
    holdTheLoopForTest(2_600)
    // Complete = the .json beside the profile and the flight record logged
    // (the record waits on the memory context, so it can trail the files).
    let files: string[] = []
    const recorded = () => warns.some(([m]) => m === 'event-loop stall flight record')
    for (let i = 0; i < 200 && (files.length === 0 || !recorded()); i++) {
      await new Promise((r) => setTimeout(r, 50))
      const names = fs.readdirSync(dir)
      files = names.filter((f) => f.endsWith('.cpuprofile') && names.includes(f.replace(/\.cpuprofile$/, '.json')))
    }
    expect(files).toHaveLength(1)

    // The block's probe line is the longest one (a loaded machine can add shorter ones).
    const late = warns.filter(([m]) => m === 'event-loop blocked (probe late)').map(([, d]) => d)
      .sort((a, b) => (b.lateByMs as number) - (a.lateByMs as number))[0]
    expect(late?.lateByMs as number).toBeGreaterThanOrEqual(1_000)
    const hold = late?.hold as Record<string, unknown>
    expect(hold.mainCpuMs as number).toBeGreaterThan(0)
    expect(['cpu', 'starved', 'off-cpu']).toContain(hold.verdict)
    const record = warns.find(([m]) => m === 'event-loop stall flight record')?.[1]
    expect(record?.profile).toBe(path.join(dir, files[0]))
    // The flight record weighs the profile: the loop was in our function for
    // most of the hold, so the verdict is code, however busy the machine was
    // (the counters alone called a loaded-machine hot loop `starved`).
    const profileHold = record?.profileHold as { codeShare: number; top: { frame: string }[] }
    expect(profileHold.codeShare).toBeGreaterThanOrEqual(0.5)
    expect(profileHold.top[0].frame).toContain('holdTheLoopForTest')
    expect((record?.hold as Record<string, unknown>).verdict).toBe('cpu')

    const summary = execFileSync(process.execPath, [path.join(repoRoot, 'scripts/stall-profile-summary.mjs'), path.join(dir, files[0]), '--top', '5'], { encoding: 'utf8' })
    const selfSection = summary.split('top self time')[1] ?? ''
    expect(selfSection.split('\n').slice(1, 3).join('\n')).toContain('holdTheLoopForTest')
    fs.rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})
