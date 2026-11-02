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

const readText = (file: string): string => { try { return readFileSync(file, 'utf8').trim() } catch { return '' } }

/** The cores this process may use: a container's CPU quota (cgroup v2 `cpu.max`, v1 `cfs_quota_us`) when it has one. */
export function quotaCores(read: (file: string) => string = readText, hostCores = cpus().length): number | null {
  const [v2quota, v2period] = read('/sys/fs/cgroup/cpu.max').split(/\s+/)
  const quota = v2quota && v2quota !== 'max' ? Number(v2quota) : Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') || -1)
  const period = v2quota && v2quota !== 'max' ? Number(v2period) : Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us') || 0)
  if (quota > 0 && period > 0) return Math.max(1, Math.min(hostCores, Math.floor(quota / period)))
  return null
}

export interface CgroupCpu { usageNs: number; throttledNs: number }

/** The container's own CPU time and throttled time so far (cgroup v2 `cpu.stat`, v1 `cpuacct.usage` + `cpu.stat`). */
export function readCgroupCpu(read: (file: string) => string = readText): CgroupCpu | null {
  const field = (text: string, name: string): number | null => {
    const m = new RegExp(`^${name} (\\d+)$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const v2 = read('/sys/fs/cgroup/cpu.stat')
  const v2usage = field(v2, 'usage_usec')
  if (v2usage !== null) return { usageNs: v2usage * 1000, throttledNs: (field(v2, 'throttled_usec') ?? 0) * 1000 }
  const v1usage = read('/sys/fs/cgroup/cpuacct/cpuacct.usage') || read('/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage')
  if (!/^\d+$/.test(v1usage)) return null
  const v1stat = read('/sys/fs/cgroup/cpu/cpu.stat') || read('/sys/fs/cgroup/cpu,cpuacct/cpu.stat')
  return { usageNs: Number(v1usage), throttledNs: field(v1stat, 'throttled_time') ?? 0 }
}

export interface QuietFacts {
  hostLoad: number
  hostCores: number
  /** The container's CPU quota in cores, or null outside one. */
  quota: number | null
  /** The container's CPU use over the window: CPU time and throttled time it gained, and the window's length. */
  window?: { usageNs: number; throttledNs: number; wallNs: number } | null
}

/**
 * A core to spare. Outside a container: one runnable process per core or fewer. Inside one with a
 * CPU quota, the host's load average counts every container on the host (2026-11-02: a 48 core
 * host at load 16 read "busy" against an 8 core quota while the container itself idled, and an
 * idle host hid a container pinned at its quota), so the container's own use decides: under 90% of
 * its quota over the window and throttled for under 5% of it, on a host that is not saturated.
 */
export function quietVerdict(f: QuietFacts): boolean {
  if (f.hostLoad >= f.hostCores) return false
  if (f.quota === null) return true
  if (!f.window || f.window.wallNs <= 0) return f.hostLoad < f.quota
  const busyCores = f.window.usageNs / f.window.wallNs
  return busyCores < f.quota * 0.9 && f.window.throttledNs < f.window.wallNs * 0.05
}

const MIN_WINDOW_NS = 250e6
let lastCpu: { at: number; cpu: CgroupCpu } | null = null
const nowNs = (): number => Number(process.hrtime.bigint())
const sample = (): void => { const cpu = readCgroupCpu(); lastCpu = cpu ? { at: nowNs(), cpu } : null }
sample()

/**
 * Whether a wall clock budget measures the work and not the CPU queue (see quietVerdict). In a
 * container it judges the container's use since the previous call, or since this module loaded,
 * so a call right after a measurement judges that measurement; a window under 250 ms is first
 * widened to 250 ms.
 */
export function machineQuiet(): boolean {
  const hostCores = cpus().length
  const quota = quotaCores(readText, hostCores)
  let window: QuietFacts['window'] = null
  if (quota !== null) {
    if (!lastCpu) sample()
    const before = lastCpu
    if (before) {
      const short = MIN_WINDOW_NS - (nowNs() - before.at)
      if (short > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(short / 1e6))
      sample()
      if (lastCpu) {
        window = { usageNs: lastCpu.cpu.usageNs - before.cpu.usageNs, throttledNs: lastCpu.cpu.throttledNs - before.cpu.throttledNs, wallNs: lastCpu.at - before.at }
      }
    }
  }
  return quietVerdict({ hostLoad: loadavg()[0], hostCores, quota, window })
}
