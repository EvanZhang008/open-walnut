/**
 * Free CPU, the measure every machine gate here judges a run by.
 *
 * The load average counts runnable threads, not CPU used. On the Mac it sat at 27 to 53
 * on 14 cores for a whole day (2026-11-07) with 30 to 48% of the CPU idle: endpoint
 * agents keep about ten threads runnable while using little CPU. Gates that waited for
 * the load (lane B's 1.2 per CPU, the iOS fleet's 0.75, vitest's 20) never opened, while
 * the CPU they wanted was free. So a gate also waits for idle CPU.
 *
 * Free CPU is only an extra condition, never a replacement for the load line (2026-11-08,
 * the Operations VP: at a backstop of 4 per core, 56 on 14 cores, a simulator lease booted
 * at load 48 and the load went to 377). A run starts only while the load is at most 2 per
 * core (28 on 14 cores, the load watchdog's line), memory is not tight, and enough CPU is
 * idle, the same rule as lane B's machine-gate.sh.
 *
 * `os.cpus()` times are the kernel's per-core tick counters (host_processor_info on
 * macOS, /proc/stat on Linux); the share of idle ticks between two samples matches
 * `iostat`'s idle column.
 */
import { spawnSync } from 'node:child_process'
import os from 'node:os'

export interface CpuTicks {
  idle: number
  total: number
}

/** Below this share of idle CPU a gate waits (WALNUT_MIN_IDLE_PCT overrides). */
export const MIN_IDLE_PCT = 20
/** The load line: above this load per core a gate waits whatever the idle CPU. */
export const MAX_LOAD_PER_CORE = 2
/** Memory is tight at kernel pressure level warn (2) or worse, ... */
export const MEM_PRESSURE_LEVEL = 2
/** ... or with this much in the compressor, ... */
export const MEM_COMP_HARD_MB = 14_336
/** ... or with swap this full while the compressor holds MEM_COMP_MB. */
export const MEM_SWAP_PCT = 80
export const MEM_COMP_MB = 10_240

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

export interface Memory {
  pressureLevel: number
  swapUsedMb: number
  swapTotalMb: number
  compressorMb: number
}

/** Why memory is tight by the load watchdog's rule, or null when it is not. */
export function memoryTightWhy(m: Memory): string | null {
  const swapFull = m.swapTotalMb > 0 && m.swapUsedMb * 100 >= MEM_SWAP_PCT * m.swapTotalMb
  if (m.pressureLevel >= MEM_PRESSURE_LEVEL || m.compressorMb >= MEM_COMP_HARD_MB || (swapFull && m.compressorMb >= MEM_COMP_MB)) {
    return `memory is tight (pressure level ${m.pressureLevel}, swap ${m.swapUsedMb}/${m.swapTotalMb}MB, compressor ${m.compressorMb}MB)`
  }
  return null
}

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000 })
  return r.status === 0 ? r.stdout : ''
}

/** Parse `sysctl -n vm.swapusage` ("total = 2048.00M  used = 1024.00M  free = ..."). */
export function parseSwapUsage(out: string): { usedMb: number; totalMb: number } {
  const mb = (k: string) => Math.floor(Number(new RegExp(`${k} = ([0-9.]+)M`).exec(out)?.[1] ?? 0))
  return { usedMb: mb('used'), totalMb: mb('total') }
}

/** Parse `vm_stat`'s page size and "Pages occupied by compressor" into MB. */
export function parseCompressorMb(out: string): number {
  const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 0)
  const pages = Number(/occupied by compressor:\s+(\d+)/.exec(out)?.[1] ?? 0)
  return Math.floor((pages * page) / 1_048_576)
}

/** The Mac's memory reading, null where it cannot be read (Linux, a sysctl that failed). */
export function readMemorySync(): Memory | null {
  if (process.platform !== 'darwin') return null
  const raw = run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim()
  const level = Number(raw)
  if (raw === '' || !Number.isInteger(level)) return null
  const swap = parseSwapUsage(run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']))
  return { pressureLevel: level, swapUsedMb: swap.usedMb, swapTotalMb: swap.totalMb, compressorMb: parseCompressorMb(run('/usr/bin/vm_stat', [])) }
}

export interface Capacity {
  /** Idle CPU percent, null when it could not be read. */
  idlePct: number | null
  loadPerCore: number
  cores: number
  /** The memory reading, null or absent when it could not be read (does not block). */
  memory?: Memory | null
}

export interface CapacityBars {
  minIdlePct: number
  maxLoadPerCore: number
}

/**
 * Whether a run may start: the load line first, then memory, then idle CPU. An unreadable
 * idle CPU or memory does not block (the load line still does). `why` says what holds it,
 * in plain words, for the wait message.
 */
export function capacityVerdict(c: Capacity, bars: CapacityBars): { ok: boolean; why: string } {
  if (c.loadPerCore > bars.maxLoadPerCore) {
    return {
      ok: false,
      why: `load ${(c.loadPerCore * c.cores).toFixed(0)} on ${c.cores} cores is over ${bars.maxLoadPerCore} per core`,
    }
  }
  const mem = c.memory ? memoryTightWhy(c.memory) : null
  if (mem) return { ok: false, why: mem }
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
