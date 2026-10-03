/**
 * Hold context for the stall flight recorder (stall-recorder.ts): per-tick
 * counters (loop thread CPU, getrusage), a ring of GC entries, and the verdict
 * a long probe-late line carries. Reading the counters is two syscalls; nothing
 * here allocates per tick beyond one small object.
 */

import os from 'node:os';
import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';

export interface TickSample {
  mono: number;
  threadUserUs: number;
  threadSysUs: number;
  procUserUs: number;
  procSysUs: number;
  majflt: number;
  minflt: number;
  nivcsw: number;
  nvcsw: number;
}

export interface HoldContext {
  windowMs: number;
  mainCpuMs: number;
  mainSysMs: number;
  mainCpuSource: 'thread' | 'process';
  procCpuMs: number;
  majorFaults: number;
  minorFaults: number;
  invCtxSwitches: number;
  volCtxSwitches: number;
  gcMs: number;
  gcCount: number;
  gcMaxMs: number;
  gcMajor: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  load1: number;
  cores: number;
  freeMemMb: number;
  verdict: HoldVerdict;
  /** A `cpu` hold whose thread did not run most of the window: code held the
   *  loop and machine load stretched it (set on the flight record). */
  loadStretched?: boolean;
}

export type HoldVerdict = 'cpu' | 'starved' | 'gc' | 'paging' | 'off-cpu';

/** What the kept CPU profile saw inside one hold (stall-recorder.ts). */
export interface ProfileHold {
  /** Samples inside the hold window. */
  samples: number;
  /** Share of the hold's sampled time with a code frame on top: JavaScript or a
   *  native call made from it, running or preempted while running. */
  codeShare: number;
  idleShare: number;
  gcShare: number;
  /** The heaviest self frames inside the hold, `name url:line`. */
  top: { frame: string; share: number }[];
}

interface ProfileNode { id: number; callFrame?: { functionName?: string; url?: string; lineNumber?: number } }

const NOT_CODE = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

/**
 * Who was on the loop thread during [startMono, endMono], from a kept profile.
 * Profile time (us) = monotonic ms * 1000 + offsetUs. Each sample counts for
 * the time until the next one, clipped to the window, so a sampler that was
 * itself delayed by machine load still adds up to wall time. Null when the
 * window holds too few samples to say anything.
 */
export function profileHoldShare(
  profile: { nodes: unknown[]; startTime: number; samples?: number[]; timeDeltas?: number[] },
  offsetUs: number, startMono: number, endMono: number,
): ProfileHold | null {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length === 0 || deltas.length !== samples.length) return null;
  const byId = new Map<number, ProfileNode>();
  for (const n of profile.nodes as ProfileNode[]) byId.set(n.id, n);
  const from = startMono * 1000 + offsetUs;
  const to = endMono * 1000 + offsetUs;
  let t = profile.startTime;
  let total = 0, code = 0, idle = 0, gc = 0, count = 0;
  const self = new Map<string, number>();
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i];
    const next = i + 1 < deltas.length ? t + deltas[i + 1] : t;
    const w = Math.min(next, to) - Math.max(t, from);
    if (w <= 0) continue;
    count += 1;
    total += w;
    const cf = byId.get(samples[i])?.callFrame;
    const name = cf?.functionName || '(anonymous)';
    if (name === '(idle)') idle += w;
    else if (name === '(garbage collector)') gc += w;
    if (NOT_CODE.has(name)) continue;
    code += w;
    const frame = `${name} ${cf?.url ? `${cf.url.replace(/^file:\/\//, '')}:${(cf.lineNumber ?? 0) + 1}` : '(native)'}`;
    self.set(frame, (self.get(frame) ?? 0) + w);
  }
  if (count < 5 || total <= 0) return null;
  const r = (x: number): number => Math.round((x / total) * 100) / 100;
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([frame, w]) => ({ frame, share: r(w) }));
  return { samples: count, codeShare: r(code), idleShare: r(idle), gcShare: r(gc), top };
}

export const mb = (n: number): number => Math.round(n / 1048576);

const hasThreadCpu = typeof (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage === 'function';

export function readTick(mono: number): TickSample {
  const t = hasThreadCpu
    ? (process as unknown as { threadCpuUsage: () => NodeJS.CpuUsage }).threadCpuUsage()
    : process.cpuUsage();
  const r = process.resourceUsage();
  return {
    mono,
    threadUserUs: t.user,
    threadSysUs: t.system,
    procUserUs: r.userCPUTime,
    procSysUs: r.systemCPUTime,
    majflt: r.majorPageFault,
    minflt: r.minorPageFault,
    nivcsw: r.involuntaryContextSwitches,
    nvcsw: r.voluntaryContextSwitches,
  };
}

/**
 * Classify a hold. Exported for tests. Context switches and faults are
 * process-wide (getrusage has no per-thread view on macOS), so the counters
 * alone are a first read; the flight record adds the kept profile's view of the
 * hold (codeShare), which outranks them.
 *
 * `cpu` means Walnut's own code held the loop, whether or not the machine was
 * short of CPU at the same time: a synchronous loop that is preempted keeps the
 * loop just as held, only longer. Measured 2026-10-03, a 3.5 s synchronous loop at
 * load 120: the thread got 1.35 s of CPU with 6559 involuntary switches and no
 * voluntary one, and the counters alone called that `starved`, which the docs
 * then read as "the machine, not Walnut code". Two rules keep it `cpu`: the
 * profile has code frames on top for most of the hold, or the thread itself
 * burned a stall's worth of CPU inside the hold (at least 250 ms and a quarter
 * of it). `starved` is left for a thread that barely ran: the machine did not
 * run it, and it had little of its own to do.
 */
export function holdVerdict(h: {
  lateByMs: number; windowMs: number; mainCpuMs: number; gcMs: number; majorFaults: number; invCtxSwitches: number;
  volCtxSwitches?: number; procCpuMs?: number;
  /** From the kept profile (profileHoldShare): share of the hold with code on top, and its sample count. */
  codeShare?: number; profileSamples?: number;
}): HoldVerdict {
  if (h.gcMs >= 0.5 * h.lateByMs) return 'gc';
  // The profile saw code on the thread for most of the hold: code held it.
  if ((h.profileSamples ?? 0) >= 5 && (h.codeShare ?? 0) >= 0.5) return 'cpu';
  // The window includes up to one normal probe interval before the hold, so a
  // thread that ran for most of the window was running through the hold.
  const share = h.mainCpuMs / h.windowMs;
  if (share >= 0.6) return 'cpu';
  // 16 KB pages: 64 hard faults is 1 MB read from disk while the loop waited.
  if (h.majorFaults >= 64 && share < 0.3) return 'paging';
  // The thread ran a stall's worth of its own work inside the hold: code held
  // the loop and load stretched it. Without a profile this is the only
  // evidence, and a starved idle loop never gets near it (5 ms in 8.5 s).
  if (h.mainCpuMs >= 250 && h.mainCpuMs >= 0.25 * h.lateByMs) return 'cpu';
  // Runnable but not running, with little of its own to run: the process lost
  // the CPU to preemption and never waited on its own. Measured 2026-10-02: an
  // isolated server at nice 10, load 300, got 5% of a core with 500 to 900
  // involuntary switches and 0 or 1 voluntary; the same server at load 281 ran
  // 5 ms in an 8.5 s hold (148 involuntary, 1 voluntary, no faults, no GC). A
  // thread blocked in a call, on a lock or on a disk read switches voluntarily
  // instead.
  const offCpuMs = h.windowMs - h.mainCpuMs;
  const vol = h.volCtxSwitches ?? 0;
  // The switch counts are process-wide: they speak for the loop thread only
  // when no other thread burned real CPU (a busy, preempted worker would).
  const othersMs = Math.max(0, (h.procCpuMs ?? h.mainCpuMs) - h.mainCpuMs);
  if (othersMs < 0.1 * h.windowMs && h.invCtxSwitches >= 20 && h.invCtxSwitches >= 4 * vol) return 'starved';
  if (share >= 0.1 && h.invCtxSwitches >= offCpuMs / 20) return 'starved';
  return 'off-cpu';
}

// ── GC ring: start (performance ms), duration, kind ─────────────────────────
const GC_RING = 1024;
const gcStart = new Float64Array(GC_RING);
const gcDur = new Float64Array(GC_RING);
const gcKind = new Uint8Array(GC_RING);
let gcHead = 0;
let gcFilled = 0;
const GC_MAJOR = perfConstants.NODE_PERFORMANCE_GC_MAJOR;

export function gcWithin(fromPerfMs: number, toPerfMs: number): { ms: number; count: number; maxMs: number; major: number } {
  let ms = 0, count = 0, maxMs = 0, major = 0;
  for (let i = 0; i < gcFilled; i++) {
    const s = gcStart[i];
    const d = gcDur[i];
    if (s + d < fromPerfMs || s > toPerfMs) continue;
    const overlap = Math.min(s + d, toPerfMs) - Math.max(s, fromPerfMs);
    if (overlap <= 0) continue;
    ms += overlap; count += 1;
    if (d > maxMs) maxMs = d;
    if (gcKind[i] === GC_MAJOR) major += 1;
  }
  return { ms: Math.round(ms), count, maxMs: Math.round(maxMs), major };
}

let gcObserver: PerformanceObserver | null = null;

/** Start recording GC entries into the ring (idempotent). */
export function startGcRing(): void {
  if (gcObserver) return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gcStart[gcHead] = e.startTime;
        gcDur[gcHead] = e.duration;
        gcKind[gcHead] = ((e as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0) & 0xff;
        gcHead = (gcHead + 1) % GC_RING;
        if (gcFilled < GC_RING) gcFilled += 1;
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { gcObserver = null; }
}

export function stopGcRing(): void {
  if (gcObserver) { gcObserver.disconnect(); gcObserver = null; }
  gcHead = 0; gcFilled = 0;
}

/**
 * The hold context for a probe that fired lateByMs late, from the counters at
 * the previous on-time tick. perfToMonoMs maps monotonic ms onto GC entry times.
 */
export function captureHold(prev: TickSample, lateByMs: number, monoNow: number, perfToMonoMs: number): HoldContext {
  const now = readTick(monoNow);
  const windowMs = Math.max(1, Math.round(monoNow - prev.mono));
  const mainCpuMs = Math.round((now.threadUserUs - prev.threadUserUs + now.threadSysUs - prev.threadSysUs) / 1000);
  const fromPerf = prev.mono + perfToMonoMs;
  const gc = gcWithin(fromPerf, monoNow + perfToMonoMs);
  const mem = process.memoryUsage();
  const majorFaults = now.majflt - prev.majflt;
  const ctx: HoldContext = {
    windowMs,
    mainCpuMs,
    mainSysMs: Math.round((now.threadSysUs - prev.threadSysUs) / 1000),
    mainCpuSource: hasThreadCpu ? 'thread' : 'process',
    procCpuMs: Math.round((now.procUserUs - prev.procUserUs + now.procSysUs - prev.procSysUs) / 1000),
    majorFaults,
    minorFaults: now.minflt - prev.minflt,
    invCtxSwitches: now.nivcsw - prev.nivcsw,
    volCtxSwitches: now.nvcsw - prev.nvcsw,
    gcMs: gc.ms,
    gcCount: gc.count,
    gcMaxMs: gc.maxMs,
    gcMajor: gc.major,
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
    externalMb: mb(mem.external),
    arrayBuffersMb: mb(mem.arrayBuffers),
    load1: Math.round(os.loadavg()[0]),
    cores: os.cpus().length,
    freeMemMb: mb(os.freemem()),
    verdict: 'off-cpu',
  };
  ctx.verdict = holdVerdict({
    lateByMs, windowMs, mainCpuMs, gcMs: gc.ms, majorFaults,
    invCtxSwitches: ctx.invCtxSwitches, volCtxSwitches: ctx.volCtxSwitches, procCpuMs: ctx.procCpuMs,
  });
  return ctx;
}
