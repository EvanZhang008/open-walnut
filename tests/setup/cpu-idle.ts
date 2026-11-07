/**
 * Free CPU, the measure every machine gate here judges a run by.
 *
 * The load average counts runnable threads, not CPU used. On the Mac it sat at 27 to 53
 * on 14 cores for a whole day (2026-11-07) with 30 to 48% of the CPU idle: endpoint
 * agents keep about ten threads runnable while using little CPU. Gates that waited for
 * the load (lane B's 1.2 per CPU, the iOS fleet's 0.75, vitest's 20) never opened, while
 * the CPU they wanted was free. So a gate waits for idle CPU, and keeps a load bar only
 * as a backstop far above that noise (4 per core), where the scheduler itself thrashes.
 *
 * `os.cpus()` times are the kernel's per-core tick counters (host_processor_info on
 * macOS, /proc/stat on Linux); the share of idle ticks between two samples matches
 * `iostat`'s idle column.
 */
import os from 'node:os'

export interface CpuTicks {
  idle: number
  total: number
}

/** Below this share of idle CPU a gate waits (WALNUT_MIN_IDLE_PCT overrides). */
export const MIN_IDLE_PCT = 20
/** The load backstop: above this load per core a gate waits whatever the idle CPU. */
export const MAX_LOAD_PER_CORE = 4

export function cpuTicks(): CpuTicks {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** Idle percent between two samples, or null when no tick passed (unreadable). */
export function idlePctBetween(a: CpuTicks, b: CpuTicks): number | null {
  const dt = b.total - a.total
  if (!(dt > 0)) return null
  const pct = ((b.idle - a.idle) / dt) * 100
  return Math.max(0, Math.min(100, pct))
}

/** Park the thread without burning CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Idle CPU percent over `ms`, blocking the thread (for config-load time gates). */
export function cpuIdlePctSync(ms = 2_000): number | null {
  const a = cpuTicks()
  sleepSync(ms)
  return idlePctBetween(a, cpuTicks())
}

/** Idle CPU percent over `ms`. */
export async function cpuIdlePct(ms = 2_000): Promise<number | null> {
  const a = cpuTicks()
  await new Promise((r) => setTimeout(r, ms))
  return idlePctBetween(a, cpuTicks())
}

export function loadPerCore(): number {
  return (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length)
}

export interface Capacity {
  /** Idle CPU percent, null when it could not be read. */
  idlePct: number | null
  loadPerCore: number
  cores: number
}

export interface CapacityBars {
  minIdlePct: number
  maxLoadPerCore: number
}

/**
 * Whether a run may start. An unreadable idle CPU does not block (the load backstop
 * still does). `why` says what holds it, in plain words, for the wait message.
 */
export function capacityVerdict(c: Capacity, bars: CapacityBars): { ok: boolean; why: string } {
  if (c.loadPerCore > bars.maxLoadPerCore) {
    return {
      ok: false,
      why: `load ${(c.loadPerCore * c.cores).toFixed(0)} on ${c.cores} cores is over ${bars.maxLoadPerCore} per core`,
    }
  }
  if (c.idlePct !== null && c.idlePct < bars.minIdlePct) {
    const free = ((c.idlePct / 100) * c.cores).toFixed(1)
    return { ok: false, why: `only ${Math.floor(c.idlePct)}% of the CPU is idle (${free} of ${c.cores} cores), under ${bars.minIdlePct}%` }
  }
  const idle = c.idlePct === null ? '?' : c.idlePct.toFixed(0)
  return { ok: true, why: `${idle}% of the CPU idle, load ${(c.loadPerCore * c.cores).toFixed(0)} on ${c.cores} cores` }
}

/** A percent from the environment, else the fallback. */
export function pctFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback
}

/** A positive number from the environment, else the fallback. */
export function positiveFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
