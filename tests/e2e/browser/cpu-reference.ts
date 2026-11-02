/**
 * A main-thread CPU budget that travels between machines.
 *
 * A budget in ms of the page's main-thread CPU holds only on the machine it was measured on: the
 * same React render costs about twice as much in an 8 CPU dev container as on the Mac, and more
 * again on a 4 core CI runner at load 11 (2026-11-01: the kanban's 500 ms open budget, measured
 * 290 to 360 ms on the Mac, read 700 here and 697 to 1,058 on CI, for a product that had not got
 * slower: the build of 2026-10-23 read 900 to 986 here). So the budget is counted in a
 * fixed reference draw measured in the same page, on the same clock: a slower machine gets it in
 * proportion, a machine as fast as the one it was set on keeps it as written, and a real regression
 * (the work itself grown) still fails anywhere.
 */
import { readFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * Main-thread CPU of a fixed draw in this page: 3,000 two-line rows built, laid out and taken
 * away, five times; the median, in ms. It does the kind of work a first render does (markup,
 * style, layout), so it scales with the machine the way that render does. `cpuMs` reads the
 * page's main-thread CPU so far, in ms (CDP Performance TaskDuration).
 */
export async function referenceDrawMs(page: Page, cpuMs: () => Promise<number>): Promise<number> {
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    const before = await cpuMs()
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:0;top:0;width:600px;visibility:hidden;pointer-events:none'
      host.innerHTML = Array.from({ length: 3_000 }, (_, n) =>
        `<div class="ref-row"><b>Sender ${n}</b> <span>Subject line number ${n} of the reference draw</span><p>A preview of the message body, ${n}</p></div>`).join('')
      document.body.append(host)
      void host.getBoundingClientRect().height
      host.remove()
    })
    runs.push((await cpuMs()) - before)
  }
  return Math.round(runs.sort((a, b) => a - b)[2]!)
}

/**
 * A budget as it holds on this machine: `refs` reference draws, and never less than the budget as
 * written (`asWrittenMs`, for the machine it was measured on, which is faster than any runner).
 * Pick `refs` from the work's own cost in references, measured where both are read on one clock,
 * with headroom for the spread under load, and no more: work that grew by half should fail.
 */
export function cpuBudget(asWrittenMs: number, refs: number, referenceMs: number): number {
  return Math.max(asWrittenMs, Math.round(refs * referenceMs))
}

/**
 * What the reference draw costs on a fast desktop core, the kind of machine the long task budgets
 * below were set on. Taken as 165 ms, so a 50 ms task is 0.3 references: in an 8 CPU container
 * C96's worst task read 60 ms beside a 241 to 263 ms reference (0.24), and failed its plain 50 ms
 * (2026-11-01).
 */
export const FAST_CORE_REFERENCE_MS = 165

/**
 * A long task budget (the length of one main-thread task) as it holds on this machine: the budget
 * as written, grown by how much slower than a fast desktop core this machine draws the reference,
 * never below what is written. A task that grew by half its budget still fails anywhere.
 */
export function longTaskBudget(asWrittenMs: number, referenceMs: number): number {
  return Math.max(asWrittenMs, Math.round(asWrittenMs * referenceMs / FAST_CORE_REFERENCE_MS))
}

/** The page's main-thread CPU so far, in ms (CDP Performance TaskDuration); Chromium only. */
export async function chromiumCpuClock(page: Page): Promise<() => Promise<number>> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
  return async () => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000
}

export interface TaskTime {
  /** The task's length on the wall clock, as a longtask entry reads it, in ms. */
  wall: number
  /** The main thread's own CPU in it, in ms. */
  cpu: number
}

/**
 * The page's long tasks with the CPU its main thread spent in each, from Chrome's trace (Chromium
 * only; call the returned function to stop and read).
 *
 * A longtask entry is wall time. Where more threads are runnable than there are cores it also counts
 * the time the page's thread waited for one: C96's 30 s of pushes read 80 tasks of 50 to 347 ms on a
 * 4 core CI runner beside a 346 ms reference draw (2026-11-02), a CPU measure, so no budget in
 * reference draws could tell the product's cost from the queue. A long task budget judges `cpu`
 * (the trace's thread time of each top level task on the renderer's main thread), and `wall` only
 * on a machine with a core to spare.
 */
export async function traceTaskTimes(page: Page, minWallMs = 50): Promise<() => Promise<TaskTime[]>> {
  const browser = page.context().browser()
  if (!browser) throw new Error('traceTaskTimes needs a launched browser')
  await browser.startTracing(undefined, { categories: ['toplevel'] })
  return async () => {
    const { traceEvents } = JSON.parse((await browser.stopTracing()).toString('utf8')) as {
      traceEvents: Array<{ ph: string; name: string; cat?: string; pid: number; tid: number; ts?: number; dur?: number; tdur?: number; args?: { name?: string } }>
    }
    const mains = new Set(traceEvents
      .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map((e) => `${e.pid}:${e.tid}`))
    // A task is a top level slice of the main thread: a posted task (ThreadControllerImpl::RunTask)
    // or an IPC handled straight off the pipe (Receive mojo message), never one nested in another.
    const slices = traceEvents
      .filter((e) => e.ph === 'X' && (e.cat ?? '').split(',').includes('toplevel') && mains.has(`${e.pid}:${e.tid}`))
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (b.dur ?? 0) - (a.dur ?? 0))
    const ends = new Map<string, number>()
    const out: TaskTime[] = []
    for (const e of slices) {
      const thread = `${e.pid}:${e.tid}`
      const start = e.ts ?? 0
      if (start < (ends.get(thread) ?? -1)) continue
      ends.set(thread, start + (e.dur ?? 0))
      if ((e.dur ?? 0) >= minWallMs * 1000) out.push({ wall: Math.round((e.dur ?? 0) / 1000), cpu: Math.round((e.tdur ?? e.dur ?? 0) / 1000) })
    }
    return out
  }
}

/** The cores this process may use: a container's CPU quota (cgroup v2 `cpu.max`, v1 `cfs_quota_us`) when it has one. */
function usableCores(): number {
  const read = (file: string) => { try { return readFileSync(file, 'utf8').trim() } catch { return '' } }
  const [v2quota, v2period] = read('/sys/fs/cgroup/cpu.max').split(/\s+/)
  const quota = v2quota && v2quota !== 'max' ? Number(v2quota) : Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') || -1)
  const period = v2quota && v2quota !== 'max' ? Number(v2period) : Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us') || 0)
  if (quota > 0 && period > 0) return Math.max(1, Math.min(cpus().length, Math.floor(quota / period)))
  return cpus().length
}

/** One runnable process per usable core or fewer: a wall clock budget measures the work, not the CPU queue. */
export function machineQuiet(): boolean {
  return loadavg()[0] < usableCores()
}
