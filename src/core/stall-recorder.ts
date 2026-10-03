/**
 * Stall flight recorder: makes the NEXT event-loop freeze name its culprit.
 *
 * The probe in event-loop-monitor.ts says THAT the loop was held and for how
 * long. On 2026-10-02 the production server went silent for 23 s and nothing in
 * the logs said why: no section was open, no request was slow before it, and a
 * profiler can only be attached after the fact. This module keeps the evidence
 * that the moment itself leaves behind, at a cost small enough to run always:
 *
 *  1. Hold context on every long probe-late line (`hold`): how much CPU the
 *     loop THREAD burned during the hold (user vs system), the process page
 *     faults (major = disk page-ins), context switches, GC time inside the
 *     hold, heap/RSS, load and free memory, and a verdict:
 *       cpu      Walnut code held the loop: synchronous work (see the profile).
 *                Also when the machine was short of CPU at the same time, if the
 *                kept profile shows code on the thread for most of the hold or
 *                the thread burned a stall's worth of CPU in it; the flight
 *                record then says `loadStretched`
 *       starved  the thread was runnable but the machine did not run it, and it
 *                had little of its own to run: it lost the CPU to preemption
 *                and never waited on its own (involuntary context switches, few
 *                or no voluntary ones). Measured 2026-10-02, 5 ms of CPU in an
 *                8.5 s hold at load 281
 *       gc       most of the hold was garbage collection
 *       paging   the thread waited on disk page-ins (swap)
 *       off-cpu  the thread barely ran and waited on its own: a blocking call
 *                (sync I/O, a lock) or a wait the fault counter does not see
 *  2. A rolling sampling CPU profile (node:inspector, in process), cut into
 *     windows; a window is kept only when a stall over the threshold fell
 *     inside it, so normal operation writes nothing. For a cpu or gc hold the
 *     kept profile names the code (the flight record carries `profileHold`:
 *     the share of the hold with code on top, and the top frames). V8 samples
 *     on a wall clock and samples a descheduled thread too, so for a starved or
 *     off-cpu hold the stack only says where the thread was parked, not what
 *     used the time (the summary script flags that case).
 *
 * Rotation is make-before-break: the next window is a NEW titled profile
 * started before the old one ends, so V8's profiler stays alive across
 * windows. Stopping the last profile disposes it, and the next start then walks
 * the whole heap to log every compiled function: measured 2026-10-02 at 400 to
 * 2000 ms on a 430 MB heap (load 300), once per window, on the loop. With the
 * overlap a rotation costs about 1 ms; the walk happens once, at start.
 *
 * Never blocks the loop otherwise: per probe tick it reads two counters
 * (thread CPU, getrusage); rotation runs on a timer; files are written with
 * async fs and pruned by count, age and size. Kill switches:
 * WALNUT_STALL_RECORDER=0 (everything), WALNUT_STALL_PROFILE=0 (profile only).
 * Summarize a kept profile with `node scripts/stall-profile-summary.mjs <file>`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LOG_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import { setProbeObserver, type ProbeObserver, type StallReport } from './event-loop-monitor.js';
import { memoryPressureSnapshot } from './memory-pressure.js';
import {
  captureHold, gcWithin, holdVerdict, mb, profileHoldShare, readTick, startGcRing, stopGcRing,
  type HoldContext, type ProfileHold, type TickSample,
} from './stall-recorder-hold.js';
import { refreshVmBaseline, resetSystemContext, sampleMemContext } from './stall-recorder-system.js';
import { pruneStallDir } from './stall-recorder-retention.js';
import { connectInspectorDriver, type CpuProfile, type ProfilerDriver } from './stall-recorder-profiler.js';

export type { CpuProfile, ProfilerDriver } from './stall-recorder-profiler.js';
export { holdVerdict, profileHoldShare, type HoldContext, type HoldVerdict, type ProfileHold } from './stall-recorder-hold.js';

/** Long probe-late lines (>= this) carry the `hold` context. */
const HOLD_CONTEXT_MIN_MS = 1_000;

export interface StallRecorderOptions {
  /** Keep a CPU profile for stalls >= this (ms). */
  profileMinMs?: number;
  /** Sampling interval of the CPU profile (microseconds). */
  intervalUs?: number;
  /** Profile rotation window (ms). */
  windowMs?: number;
  /** Rotate this long after a kept stall ends, so the file lands promptly (ms). */
  postStallMs?: number;
  /** Where kept profiles go. */
  dir?: string;
  /** Retention: newest N files, max age, max total bytes. */
  maxFiles?: number;
  maxAgeMs?: number;
  maxBytes?: number;
  /** At most this many profiles written per hour (a sustained overload must not turn into a write storm). */
  maxPerHour?: number;
  /** Turn the profiler off but keep the hold context. */
  profile?: boolean;
  /** Start even where the defaults say off (tests). */
  force?: boolean;
  /** Sample machine paging counters and this process's compressed bytes around a stall. */
  systemContext?: boolean;
  /** Tests: a stand-in for the inspector-backed profiler. */
  profiler?: ProfilerDriver;
}


interface WindowRec {
  title: string;
  startMono: number;
  /** startMono in microseconds, measured around the profile's begin (for clock calibration). */
  startMonoUs: number;
  stalls: StallReport[];
}

interface HeldProfile {
  profile: CpuProfile;
  win: WindowRec;
  endMono: number;
}


// ── Recorder state ──────────────────────────────────────────────────────────
let running = false;
let opts: Required<StallRecorderOptions>;
let lastTick: TickSample | null = null;
/** performance.now() minus monotonic ms, so GC entries map onto probe times. */
let perfToMonoMs = 0;
let driver: ProfilerDriver | null = null;
let current: WindowRec | null = null;
let previous: HeldProfile | null = null;
let rotateTimer: ReturnType<typeof setTimeout> | null = null;
let rotating = false;
let windowSeq = 0;
let writesThisHour: number[] = [];
const stats = { rotations: 0, rotateMsMax: 0, rotateMsSum: 0, firstStartMs: 0, kept: 0, skippedRate: 0, errors: 0 };
let statsTimer: ReturnType<typeof setInterval> | null = null;

const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6;

function envFlag(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envNum(name: string, fallback: number): number {
  const v = Number(envFlag(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Defaults: on everywhere except the test runner (opt in with WALNUT_STALL_RECORDER=1). */
export function stallRecorderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WALNUT_STALL_RECORDER === '0') return false;
  if (env.WALNUT_STALL_RECORDER === '1') return true;
  return !env.VITEST;
}

const observer: ProbeObserver = {
  tick(monoNow: number): void {
    lastTick = readTick(monoNow);
  },
  hold(lateByMs: number, monoNow: number): Record<string, unknown> | undefined {
    if (lateByMs < HOLD_CONTEXT_MIN_MS) return undefined;
    try {
      return lastTick ? captureHold(lastTick, lateByMs, monoNow, perfToMonoMs) as unknown as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  },
  reported(report: StallReport): void {
    if (report.lateByMs < opts.profileMinMs) return;
    if (opts.systemContext) memContexts.set(report, sampleMemContext().catch(() => null));
    onStall(report);
  },
};

const memContexts = new WeakMap<StallReport, Promise<Record<string, unknown> | null>>();

// ── Profiler ────────────────────────────────────────────────────────────────

/** Begin a new titled window. While another window runs this is cheap (no heap walk). */
async function beginWindow(): Promise<WindowRec | null> {
  if (!driver) return null;
  windowSeq += 1;
  const title = `walnut-stall-recorder-${process.pid}-${windowSeq}`;
  const before = monoMs();
  await driver.begin(title);
  const after = monoMs();
  return { title, startMono: before, startMonoUs: ((before + after) / 2) * 1000, stalls: [] };
}

function scheduleRotate(delayMs: number): void {
  if (!running || !driver) return;
  if (rotateTimer) clearTimeout(rotateTimer);
  rotateTimer = setTimeout(() => { rotateTimer = null; void rotate(); }, delayMs);
  rotateTimer.unref?.();
}

async function rotate(): Promise<void> {
  if (!driver || !current || rotating) { scheduleRotate(opts.windowMs); return; }
  rotating = true;
  const win = current;
  const t0 = monoMs();
  try {
    // Make before break: the next window starts BEFORE this one ends, so the
    // profiler is never idle and never re-walks the heap on the next begin.
    const next = await beginWindow();
    if (next) current = next;
    // The old window ends where its end() began; that instant is the edge.
    const endMono = monoMs();
    const profile = await driver.end(win.title);
    const ms = monoMs() - t0;
    stats.rotations += 1;
    stats.rotateMsSum += ms;
    if (ms > stats.rotateMsMax) stats.rotateMsMax = ms;
    const held: HeldProfile = { profile, win, endMono };
    if (win.stalls.length > 0) {
      previous = null;
      void keep(held);
    } else {
      // Kept one window back: a stall whose probe fires just after this
      // rotation (both timers expire at the end of the same hold) claims it.
      previous = held;
    }
    if (opts.systemContext) refreshVmBaseline();
  } catch (err) {
    stats.errors += 1;
    log.web.debug('stall recorder: rotation failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    rotating = false;
    scheduleRotate(opts.windowMs);
  }
}

function onStall(report: StallReport): void {
  if (!driver) {
    // Profiling off: still leave one flight record line with the final GC numbers.
    setTimeout(() => { void emitRecord([report], null); }, 100).unref?.();
    return;
  }
  // The hold covered the probe's due time and a rotation cannot run inside a
  // hold, so a window that ended after the due time ended after the hold too:
  // the hold is wholly in that (previous) window. Otherwise it is in the current one.
  if (previous && previous.endMono > report.dueMono) {
    const held = previous;
    previous = null;
    held.win.stalls.push(report);
    void keep(held);
    return;
  }
  if (current && current.startMono <= report.dueMono) {
    current.stalls.push(report);
    scheduleRotate(opts.postStallMs);
  }
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function keep(held: HeldProfile): Promise<void> {
  const now = Date.now();
  writesThisHour = writesThisHour.filter((t) => now - t < 3_600_000);
  if (writesThisHour.length >= opts.maxPerHour) {
    stats.skippedRate += 1;
    void emitRecord(held.win.stalls, null, 'rate-limited');
    return;
  }
  writesThisHour.push(now);
  const worst = Math.max(...held.win.stalls.map((s) => s.lateByMs));
  const base = `stall-${stamp(new Date(held.win.stalls[0].wallNow))}-${worst}ms-${process.pid}`;
  const file = path.join(opts.dir, `${base}.cpuprofile`);
  const offsetUs = held.profile.startTime - held.win.startMonoUs;
  const seen = new Map<StallReport, ProfileHold | null>();
  for (const s of held.win.stalls) {
    try { seen.set(s, profileHoldShare(held.profile, offsetUs, s.holdStartMono, s.holdEndMono)); } catch { seen.set(s, null); }
  }
  const meta = {
    version: 1,
    pid: process.pid,
    node: process.version,
    intervalUs: opts.intervalUs,
    window: { startMono: held.win.startMono, endMono: held.endMono },
    // profile time (us) = monotonic ms * 1000 + offsetUs
    offsetUs,
    stalls: held.win.stalls.map((s) => ({
      lateByMs: s.lateByMs,
      at: new Date(s.wallNow).toISOString(),
      holdStartMono: s.holdStartMono,
      holdEndMono: s.holdEndMono,
      suspectSection: s.suspectSection,
      hold: finalHold(s, seen.get(s) ?? null),
      profileHold: seen.get(s) ?? null,
    })),
  };
  try {
    await fsp.mkdir(opts.dir, { recursive: true });
    // Profile first, meta last, each renamed into place: a reader (or the
    // pruner) that sees the .json can trust the .cpuprofile beside it is whole.
    await writeWhole(file, JSON.stringify(held.profile));
    await writeWhole(path.join(opts.dir, `${base}.json`), JSON.stringify(meta, null, 2));
    stats.kept += 1;
    await emitRecord(held.win.stalls, file, undefined, seen);
    await prune();
  } catch (err) {
    stats.errors += 1;
    log.web.warn('stall recorder: could not write profile', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Write to a temp name outside the `stall-` namespace, then rename into place. */
async function writeWhole(file: string, body: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${path.basename(file)}`);
  try {
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The hold context with the final GC numbers (GC entries for collections inside
 * the hold arrive after it ends) and the final verdict, which also weighs what
 * the kept profile saw on the thread.
 */
function finalHold(s: StallReport, seen: ProfileHold | null): Record<string, unknown> | undefined {
  if (!s.hold) return undefined;
  const gc = gcWithin(s.holdStartMono + perfToMonoMs, s.holdEndMono + perfToMonoMs);
  const h: HoldContext = { ...(s.hold as unknown as HoldContext), gcMs: gc.ms, gcCount: gc.count, gcMaxMs: gc.maxMs, gcMajor: gc.major };
  h.verdict = holdVerdict({ lateByMs: s.lateByMs, ...h, codeShare: seen?.codeShare, profileSamples: seen?.samples });
  if (h.verdict === 'cpu' && h.mainCpuMs / h.windowMs < 0.6) h.loadStretched = true;
  return h as unknown as Record<string, unknown>;
}

async function emitRecord(
  stalls: StallReport[], file: string | null, reason?: string, seen?: Map<StallReport, ProfileHold | null>,
): Promise<void> {
  for (const s of stalls) {
    const mem = await Promise.race([
      memContexts.get(s) ?? Promise.resolve(null),
      new Promise<null>((r) => { setTimeout(() => r(null), 10_000).unref?.(); }),
    ]);
    const profileHold = seen?.get(s) ?? null;
    const hold = finalHold(s, profileHold);
    log.web.warn('event-loop stall flight record', {
      lateByMs: s.lateByMs,
      holdStart: new Date(s.wallNow - (s.holdEndMono - s.holdStartMono)).toISOString(),
      suspectSection: s.suspectSection,
      ...(hold ? { hold } : {}),
      ...(profileHold ? { profileHold } : {}),
      ...(mem ?? {}),
      memoryPressure: memoryPressureSnapshot(),
      profile: file,
      ...(reason ? { reason } : {}),
    });
  }
}

function prune(): Promise<void> {
  return pruneStallDir(opts.dir, { maxFiles: opts.maxFiles, maxAgeMs: opts.maxAgeMs, maxBytes: opts.maxBytes });
}

async function connectProfiler(): Promise<ProfilerDriver | null> {
  try {
    const d = await connectInspectorDriver(opts.intervalUs);
    if (!d) log.web.info('stall recorder: V8 console profiles unavailable, keeping hold context only');
    return d;
  } catch (err) {
    log.web.info('stall recorder: CPU profile unavailable, keeping hold context only', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Start the recorder (idempotent). Returns false when disabled. */
export async function startStallRecorder(options: StallRecorderOptions = {}): Promise<boolean> {
  if (running) return true;
  if (!options.force && !stallRecorderEnabled()) return false;
  const injected = options.profiler;
  opts = {
    profiler: undefined as unknown as ProfilerDriver,
    force: options.force ?? false,
    systemContext: options.systemContext ?? true,
    profileMinMs: options.profileMinMs ?? envNum('WALNUT_STALL_PROFILE_MIN_MS', 2_000),
    // 20 ms: a 2 s hold still gets ~100 samples, and the always-on cost of the
    // running profile drops by ~40% against 10 ms (measured 2026-10-02, process
    // CPU per idle 20 s: 1.9 ms off, 18.6 ms at 10 ms, 11.3 ms at 20 ms).
    intervalUs: options.intervalUs ?? envNum('WALNUT_STALL_PROFILE_INTERVAL_US', 20_000),
    windowMs: options.windowMs ?? envNum('WALNUT_STALL_PROFILE_WINDOW_MS', 60_000),
    postStallMs: options.postStallMs ?? 2_000,
    dir: options.dir ?? path.join(LOG_DIR, 'stall-profiles'),
    maxFiles: options.maxFiles ?? 40,
    maxAgeMs: options.maxAgeMs ?? 3 * 86_400_000,
    maxBytes: options.maxBytes ?? 256 * 1048576,
    maxPerHour: options.maxPerHour ?? 20,
    profile: options.profile ?? envFlag('WALNUT_STALL_PROFILE') !== '0',
  };
  running = true;
  // A crash's leftovers (and anything past retention) go at start, not only
  // after the next kept stall.
  void prune().catch(() => { /* best effort */ });
  perfToMonoMs = performance.now() - monoMs();
  lastTick = readTick(monoMs());
  startGcRing();
  setProbeObserver(observer);
  if (opts.systemContext) refreshVmBaseline();
  if (opts.profile) {
    driver = injected ?? await connectProfiler();
    if (driver) {
      // The first begin is the one that walks the heap (measured once, logged
      // below); it runs at boot, when the heap is smallest.
      const t0 = monoMs();
      try {
        current = await beginWindow();
        stats.firstStartMs = Math.round(monoMs() - t0);
        scheduleRotate(opts.windowMs);
      } catch (err) {
        log.web.info('stall recorder: could not start the CPU profile, keeping hold context only', { error: err instanceof Error ? err.message : String(err) });
        const d = driver;
        driver = null;
        current = null;
        try { await d.close(); } catch { /* gone */ }
      }
    }
  }
  statsTimer = setInterval(() => {
    if (stats.rotations === 0) return;
    log.web.info('stall recorder stats', {
      rotations: stats.rotations,
      rotateMsAvg: Math.round((stats.rotateMsSum / stats.rotations) * 10) / 10,
      rotateMsMax: Math.round(stats.rotateMsMax * 10) / 10,
      kept: stats.kept, skippedRate: stats.skippedRate, errors: stats.errors,
      ...memoryFields(),
    });
    stats.rotateMsMax = 0;
  }, envNum('WALNUT_STALL_STATS_MS', 3_600_000));
  statsTimer.unref?.();
  log.web.info('stall recorder started', {
    profile: driver !== null, firstStartMs: stats.firstStartMs, intervalUs: opts.intervalUs, windowMs: opts.windowMs,
    profileMinMs: opts.profileMinMs, dir: opts.dir, ...memoryFields(),
  });
  return true;
}

function memoryFields(): Record<string, number> {
  const m = process.memoryUsage();
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external) };
}

export async function stopStallRecorder(): Promise<void> {
  if (!running) return;
  running = false;
  setProbeObserver(null);
  if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  stopGcRing();
  const d = driver;
  const win = current;
  driver = null; current = null; previous = null; lastTick = null;
  if (d) {
    if (win) { try { await d.end(win.title); } catch { /* not started */ } }
    try { await d.close(); } catch { /* already gone */ }
  }
  writesThisHour = []; windowSeq = 0;
  resetSystemContext();
  Object.assign(stats, { rotations: 0, rotateMsMax: 0, rotateMsSum: 0, firstStartMs: 0, kept: 0, skippedRate: 0, errors: 0 });
}

/** Test hook: rotation and keep counters. */
export function _stallRecorderStats(): typeof stats & { running: boolean; windowOpen: boolean; previousHeld: boolean } {
  return { ...stats, running, windowOpen: current !== null, previousHeld: previous !== null };
}

/** Test hook: force a rotation now and wait for it. */
export async function _rotateNowForTest(): Promise<void> {
  await rotate();
}

/** Test hook: the observer the recorder installs on the probe. */
export function _recorderObserverForTest(): ProbeObserver {
  return observer;
}
