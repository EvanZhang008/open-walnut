/**
 * How long a piece of work held the event loop, judged on the loop thread's own CPU.
 *
 * A probe timer's longest wall-clock gap counts everything that kept the timer from
 * running: work on the loop, but also a loaded machine that did not schedule the thread.
 * On a shared CI runner the second alone reached 149 ms and 335 ms where the work itself
 * held the loop for about 40 ms (2026-11-07, drain-online-rules), so a fixed wall bound
 * failed at random. The CPU the loop thread spent inside its longest gap is what the work
 * cost; a worker thread's CPU is not in it (process.threadCpuUsage is per thread).
 *
 * tests/core/loop-gap-probe-guard.test.ts fails on a new inline wall-gap probe in tests/.
 */
import { performance } from 'node:perf_hooks'

type ThreadCpu = () => NodeJS.CpuUsage
const threadCpu = (process as unknown as { threadCpuUsage?: ThreadCpu }).threadCpuUsage

/** The loop thread's CPU clock in ms, or undefined where the runtime has no per-thread clock. */
function loopCpuMs(): number | undefined {
  if (typeof threadCpu !== 'function') return undefined
  const t = threadCpu.call(process)
  return (t.user + t.system) / 1000
}

export interface LoopHold<T> {
  value: T
  /** The longest wall-clock gap between two probe ticks (ms): for messages, not for judging. */
  gapMs: number
  /** The loop thread's CPU inside its longest-CPU gap (ms); the wall gap where no per-thread clock exists. */
  holdMs: number
}

/** Runs `run` under a `tickMs` probe timer and reports the longest hold of the loop. */
export async function measureLoopHold<T>(run: () => Promise<T>, tickMs = 10): Promise<LoopHold<T>> {
  let lastWall = performance.now()
  let lastCpu = loopCpuMs()
  let gapMs = 0
  let cpuMs = 0
  const sample = (): void => {
    const wall = performance.now()
    const cpu = loopCpuMs()
    gapMs = Math.max(gapMs, wall - lastWall)
    if (cpu !== undefined && lastCpu !== undefined) cpuMs = Math.max(cpuMs, cpu - lastCpu)
    lastWall = wall
    lastCpu = cpu
  }
  const probe = setInterval(sample, tickMs)
  try {
    const value = await run()
    sample()
    return { value, gapMs, holdMs: lastCpu === undefined ? gapMs : cpuMs }
  } finally {
    clearInterval(probe)
  }
}
