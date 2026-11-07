/**
 * A test that judges how long work held the event loop uses measureLoopHold
 * (tests/helpers/loop-hold.ts), which counts the loop thread's own CPU, never an inline
 * timer probe whose wall-clock gap a loaded CI runner stretches by itself (2026-11-07:
 * drain-online-rules failed its 100 ms bound at 149 ms on a GitHub runner, and measured
 * 38 to 335 ms on a loaded Linux host, while the drain itself held the loop about 40 ms).
 *
 * Every file under tests/ with an inline wall-gap probe (`<name>Gap... = Math.max(`) is
 * either listed here with why its bound survives a loaded machine, or fails.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { measureLoopHold } from '../helpers/loop-hold.js'

const ROOT = path.resolve(__dirname, '..')
const PROBE = /\b\w*[gG]ap\w*\s*=\s*Math\.max\(/

const ALLOWED: Record<string, string> = {
  'helpers/loop-hold.ts': 'the helper itself: it reports the wall gap beside the CPU hold',
  'core/health/perf.test.ts': 'judges every gap on the loop thread CPU too (maxGapCpuMs)',
  'core/project-summary.test.ts': 'measures gaps between bus events to decide which checks apply, not a loop hold',
  'integrations/git-compaction-recovery-async.test.ts': 'its bound is a whole synchronous git call (3 s), with a tick count no load can fake',
  'e2e/browser/code-block-actions-helpers.ts': "a browser page's frame gap while a reply streams (no lag in the page), not a Node loop hold; its bound (400 ms, WebKit 1.5 s) is several busy frames",
  'lib/sqlite.test.ts': 'its bound is half the same backup run inline on the same thread under the same load',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('loop-hold tests judge the loop thread CPU, not a wall-clock gap', () => {
  const probes = walk(ROOT)
    .filter((file) => PROBE.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
    .sort()

  it('finds the probes it knows (the scan still matches)', () => {
    expect(probes).toContain('helpers/loop-hold.ts')
  })

  it('every inline wall-gap probe is listed with why its bound survives load', () => {
    const unlisted = probes.filter((file) => !(file in ALLOWED))
    expect(unlisted, 'use measureLoopHold from tests/helpers/loop-hold.ts, or list the file here with why').toEqual([])
  })

  it('every listed file still has a probe (the list only shrinks)', () => {
    expect(Object.keys(ALLOWED).filter((file) => !probes.includes(file))).toEqual([])
  })
})

describe('measureLoopHold', () => {
  // Holds the loop for `ms` of the loop thread's own CPU (wall time where no per-thread clock
  // exists): a wall-clock spin on a loaded host got under 100 ms of CPU in 150 ms (2026-11-07).
  const threadCpuMs = (): number | undefined => {
    const f = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage
    if (typeof f !== 'function') return undefined
    const t = f.call(process)
    return (t.user + t.system) / 1000
  }
  const busy = (ms: number): void => {
    const cpu0 = threadCpuMs()
    const end = Date.now() + ms
    if (cpu0 === undefined) { while (Date.now() < end) { /* hold the loop */ } return }
    while (threadCpuMs()! - cpu0 < ms) { /* hold the loop */ }
  }

  it('counts work that holds the loop thread', async () => {
    const { holdMs } = await measureLoopHold(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      busy(150)
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(holdMs).toBeGreaterThanOrEqual(100)
  })

  it('does not count a worker thread busy while the loop is free', async () => {
    const worker = new Worker(
      'const end = Date.now() + 300; while (Date.now() < end) {} require("node:worker_threads").parentPort.postMessage(1)',
      { eval: true },
    )
    try {
      const { holdMs } = await measureLoopHold(() => new Promise((resolve) => worker.once('message', resolve)))
      expect(holdMs).toBeLessThan(100)
    } finally {
      await worker.terminate()
    }
  })
})
