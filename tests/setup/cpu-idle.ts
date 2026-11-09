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
 * The load line is the load of our own work (2026-11-08: lane B and the iOS fleet stayed shut
 * for hours at a load of 40 to 80 while a third of the CPU stood idle; a video call app and
 * security agents, which we neither own nor can stop, held most of the runnable threads). Over
 * the line, the load counts only in the share of runnable threads our processes hold
 * (`ownLoadPerCore`, twin of scripts/lib/own-load.sh); what the others take of the CPU and of
 * memory still counts through the idle and memory checks.
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

/**
 * Ours: a process that is, or descends from, Walnut, an agent CLI, bun, node, a test browser,
 * Xcode's tools or a simulator, by its path. The same pattern as scripts/lib/own-load.sh.
 */
export const OWN_LOAD_RE =
  /(^|\/)([Ww]alnut[^/]*|claude|codex|bun|bunx|node|launchd_sim|Simulator|xcodebuild|XCBBuildService|swift-frontend|Playwright|chrome-headless-shell|Google Chrome for Testing|maestro|daemon-(darwin|linux)-[^/]*)$|\/CoreSimulator\/|\/Xcode[^/]*\.app\/|\/ms-playwright\//

/**
 * The mean runnable threads of our processes and of the rest, from a process tree
 * (`ps -axww -o pid= -o ppid= -o comm=`) and `ps -axM` samples; null with no sample.
 */
export function parseRunnableShare(tree: string, samples: string[]): { ours: number; others: number } | null {
  if (samples.length === 0) return null
  const parent = new Map<string, string>()
  const marked = new Set<string>()
  for (const line of tree.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    parent.set(m[1], m[2])
    if (OWN_LOAD_RE.test(m[3])) marked.add(m[1])
  }
  const memo = new Map<string, boolean>()
  const ours = (pid: string): boolean => {
    const known = memo.get(pid)
    if (known !== undefined) return known
    let q: string | undefined = pid
    let hit = false
    for (let i = 0; i < 40 && q !== undefined && Number(q) > 1; i++) {
      if (marked.has(q)) { hit = true; break }
      q = parent.get(q)
    }
    memo.set(pid, hit)
    return hit
  }
  let o = 0
  let f = 0
  for (const sample of samples) {
    for (const line of sample.split('\n').slice(1)) {
      // A process line starts with its user (STAT in field 5), a thread line with spaces (field 3).
      const w = line.trim().split(/\s+/)
      const thread = /^\s/.test(line)
      const pid = thread ? w[0] : w[1]
      const st = thread ? w[2] : w[4]
      if (!pid || !st || !st.startsWith('R')) continue
      if (ours(pid)) o++
      else f++
    }
  }
  return { ours: o / samples.length, others: f / samples.length }
}

/** The share read now: five `ps -axM` samples a second apart; null off macOS or unreadable. */
export function readRunnableShareSync(samples = 5): { ours: number; others: number } | null {
  if (process.platform !== 'darwin') return null
  // The tree before and after the samples, so a child our work starts or ends meanwhile counts as ours.
  const before = run('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='])
  if (!before) return null
  const out: string[] = []
  for (let i = 0; i < samples; i++) {
    if (i > 0) sleepSync(1_000)
    const s = run('/bin/ps', ['-axM'])
    if (!s) return null
    out.push(s)
  }
  const after = run('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='])
  if (!after) return null
  return parseRunnableShare(`${before}\n${after}`, out)
}

/**
 * The load per core to judge by, and how it was counted. Over `line`, our processes' share of
 * it when the share can be read and another process holds any runnable thread; else the load.
 */
export function ownLoadPerCore(
  perCore = loadPerCore(),
  line = MAX_LOAD_PER_CORE,
  share: () => { ours: number; others: number } | null = readRunnableShareSync,
): { perCore: number; rawPerCore?: number } {
  if (perCore <= line) return { perCore }
  const s = share()
  if (!s || s.others <= 0) return { perCore }
  return { perCore: (perCore * s.ours) / (s.ours + s.others), rawPerCore: perCore }
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
  // ps -axM runs to about 600 KB on a busy Mac: room past the default 1 MB.
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })
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
  /** The whole load per core when loadPerCore is our share of it (ownLoadPerCore). */
  rawLoadPerCore?: number
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
  const whole = c.rawLoadPerCore === undefined ? '' : ` (our share of the whole load ${(c.rawLoadPerCore * c.cores).toFixed(0)})`
  if (c.loadPerCore > bars.maxLoadPerCore) {
    return {
      ok: false,
      why: `load ${(c.loadPerCore * c.cores).toFixed(0)}${whole} on ${c.cores} cores is over ${bars.maxLoadPerCore} per core`,
    }
  }
  const mem = c.memory ? memoryTightWhy(c.memory) : null
  if (mem) return { ok: false, why: mem }
  if (c.idlePct !== null && c.idlePct < bars.minIdlePct) {
    const free = ((c.idlePct / 100) * c.cores).toFixed(1)
    return { ok: false, why: `only ${Math.floor(c.idlePct)}% of the CPU is idle (${free} of ${c.cores} cores), under ${bars.minIdlePct}%` }
  }
  const idle = c.idlePct === null ? '?' : c.idlePct.toFixed(0)
  return { ok: true, why: `${idle}% of the CPU idle, load ${(c.loadPerCore * c.cores).toFixed(0)}${whole} on ${c.cores} cores` }
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
