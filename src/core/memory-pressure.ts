/**
 * Machine memory pressure, as the kernel judges it, so background work can
 * give memory back before the machine swaps the server's own pages out.
 *
 * Why (2026-10-02): every production freeze of 5 s or more that was not a
 * system sleep, and whose CPU was measured, was off-CPU: the server got 1 to
 * 30% of one core during the hold. An isolated server reproduced the shape (5
 * ms of CPU in an 8.5 s hold, runnable but not run, while the machine's memory
 * compressor ran 49k decompressions at load 281). The freezes lined up with
 * memory pressure: swap at 4.45 of 5 GB and a kernel "warn" four minutes
 * before the 23 s freeze at 07:18Z, and half of the awake freezes fell while
 * the local daemon's heap was mostly compressed out, twice the rate at random
 * times. The server cannot fix the machine, but it is the largest memory user
 * on it (with its embed worker processes), and not because of its heap: one
 * embedding worker lane of the default model measured +2.2 GB of footprint
 * (the 614 MB file is held expanded), and production stood at 2.46 GB (0.82
 * GB compressed) with a 321 MB JS heap.
 *
 * Signals: macOS `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn,
 * 4 critical), the level behind the system's own memory pressure
 * notifications; Linux PSI `/proc/pressure/memory`. That level is late (it
 * read normal through an isolated freeze, and said warn four minutes before
 * the 23 s one), so two earlier signals also count as warn: the swap-out
 * rate and the compressor's size (memory-signals.ts, each with its own
 * hysteresis band). One async `sysctl` child (macOS) or three file reads
 * (Linux) every 30 s, never on the loop.
 *
 * Shedding starts at warn and lasts until every signal has read normal for
 * the hold, 10 minutes: a released model that reloads while pressure flaps
 * costs more than it saves. Pressure that comes back within one base hold of
 * the clear doubles the next hold (10, 20, 40, 60 minutes), because the reload
 * itself can be what brings it back; pressure that comes back later starts
 * again at 10 (see episodeHoldMs). Consumers subscribe with
 * onMemoryPressureChange().
 *
 * Switches: WALNUT_MEMORY_PRESSURE=normal|warn|critical forces the level
 * (diagnostics, tests); WALNUT_MEMORY_PRESSURE_SHED=0 never sheds;
 * WALNUT_MEMORY_PRESSURE_EARLY=0 listens to the kernel level alone;
 * WALNUT_MEMORY_PRESSURE_BACKOFF=0 keeps every hold at the base.
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { log } from '../logging/index.js';
import {
  DARWIN_SYSCTL_ARGS, initialSignalState, nextSignal, parseDarwinSysctl, parseLinuxProc,
  type MemoryReading, type PressureCause, type PressureLevel, type SignalState, type SignalVerdict,
} from './memory-signals.js';

export type { PressureCause, PressureLevel } from './memory-signals.js';

export interface ShedState {
  shedding: boolean;
  /** Last time the level read warn or critical (ms epoch), 0 if never. */
  lastPressuredAt: number;
  /** Hold of the current (or the last) episode: the base hold, or longer
   *  while pressure keeps coming back right after a clear. */
  holdMs: number;
  /** When the last episode ended (ms epoch), 0 if none has. */
  clearedAt: number;
}

type Listener = (shedding: boolean, level: PressureLevel) => void;

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_HOLD_MS = 10 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let level: PressureLevel = 'normal';
let cause: PressureCause = null;
let signals: SignalState = initialSignalState();
let lastVerdict: Pick<SignalVerdict, 'compressorShare' | 'swapoutBytesPerMin'> = { compressorShare: null, swapoutBytesPerMin: null };
let holdMs = DEFAULT_HOLD_MS;
let state: ShedState = initialShedState(holdMs);
let reading = false;
const listeners = new Set<Listener>();

/** macOS level number to a level. Unknown values read as normal. */
export function levelFromDarwin(n: number): PressureLevel {
  if (n >= 4) return 'critical';
  if (n >= 2) return 'warn';
  return 'normal';
}

/**
 * Linux PSI text ("some avg10=.. avg60=.. ...\nfull avg10=.. ...") to a level:
 * tasks stalled on memory 10% of the last 10 s is warn; every task stalled
 * (full) 10% of it is critical.
 */
export function levelFromPsi(text: string): PressureLevel {
  const avg10 = (kind: string): number => {
    const m = new RegExp(`^${kind} avg10=([\\d.]+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  if (avg10('full') >= 10) return 'critical';
  if (avg10('some') >= 10) return 'warn';
  return 'normal';
}

/** A hold never grows past this many base holds (10 minutes base: 60). */
export const HOLD_BACKOFF_MAX_FACTOR = 6;

export function initialShedState(baseHoldMs = DEFAULT_HOLD_MS): ShedState {
  return { shedding: false, lastPressuredAt: 0, holdMs: baseHoldMs, clearedAt: 0 };
}

/**
 * The hold a new episode gets. Measured 2026-10-02: on a machine near its
 * limit, an isolated server that loaded the model was itself enough to tip the
 * kernel into warn, so a fixed hold became a cycle (load, warn, shed, 10
 * minutes, load again; the next warn came 30 to 60 s after each resume, since
 * the backfill reloads the model within a minute of a clear). Pressure back
 * within one base hold of the clear doubles the hold, up to
 * HOLD_BACKOFF_MAX_FACTOR base holds (10, 20, 40, 60 minutes); a later return
 * is a new episode at the base. Replayed on 6 hours of live readings (load up
 * to 660), this sheds 26% of the time instead of 20%; keeping a raised hold
 * for returns up to an hour later would have shed 39%.
 */
function episodeHoldMs(prev: ShedState, now: number, base: number): number {
  if (!prev.clearedAt || now - prev.clearedAt >= base) return base;
  return Math.min(Math.max(base, prev.holdMs) * 2, base * HOLD_BACKOFF_MAX_FACTOR);
}

/** Pure step of the shedding state machine (exported for tests and replays).
 *  `backoff` false keeps every hold at the base. */
export function nextShedState(prev: ShedState, lvl: PressureLevel, now: number, baseHoldMs: number, backoff = true): ShedState {
  if (lvl !== 'normal') {
    if (prev.shedding) return { ...prev, lastPressuredAt: now };
    const hold = backoff ? episodeHoldMs(prev, now, baseHoldMs) : baseHoldMs;
    return { shedding: true, lastPressuredAt: now, holdMs: hold, clearedAt: prev.clearedAt };
  }
  if (!prev.shedding || now - prev.lastPressuredAt < prev.holdMs) return prev;
  return { ...prev, shedding: false, clearedAt: now };
}

function forcedLevel(): PressureLevel | null {
  const v = process.env.WALNUT_MEMORY_PRESSURE;
  return v === 'normal' || v === 'warn' || v === 'critical' ? v : null;
}

function readDarwin(at: number): Promise<MemoryReading | null> {
  return new Promise((resolve) => {
    try {
      // One child for every name. An unknown name (an older macOS) makes sysctl
      // exit non-zero after printing the rest, so stdout is parsed regardless.
      execFile('sysctl', [...DARWIN_SYSCTL_ARGS], { timeout: 5_000 }, (_err, stdout) => {
        const r = parseDarwinSysctl(String(stdout ?? ''), at, levelFromDarwin);
        resolve(r.kernel || r.swapoutPages !== undefined || r.compressorBytes !== undefined ? r : null);
      });
    } catch { resolve(null); }
  });
}

async function readLinux(at: number): Promise<MemoryReading | null> {
  const [psi, vmstat, meminfo] = await Promise.all(
    ['/proc/pressure/memory', '/proc/vmstat', '/proc/meminfo'].map((f) => fsp.readFile(f, 'utf8').catch(() => '')),
  );
  if (!psi && !vmstat) return null;
  return parseLinuxProc(vmstat, meminfo, at, psi ? levelFromPsi(psi) : null);
}

async function readMachine(at: number): Promise<MemoryReading | null> {
  if (process.platform === 'darwin') return readDarwin(at);
  if (process.platform === 'linux') return readLinux(at);
  return null;
}

/** One machine reading through the early bands, then into the shedding state. */
export function applyMemoryReading(r: MemoryReading): void {
  const v = nextSignal(signals, r);
  signals = v.state;
  lastVerdict = { compressorShare: v.compressorShare, swapoutBytesPerMin: v.swapoutBytesPerMin };
  if (process.env.WALNUT_MEMORY_PRESSURE_EARLY === '0') {
    const k = r.kernel ?? 'normal';
    applyPressureReading(k, r.at, k === 'normal' ? null : 'kernel');
    return;
  }
  applyPressureReading(v.level, r.at, v.cause);
}

/** Apply one level: update the state and tell listeners when shedding flips. */
export function applyPressureReading(lvl: PressureLevel, now = Date.now(), why: PressureCause = lvl === 'normal' ? null : 'kernel'): void {
  const prevLevel = level;
  const prevCause = cause;
  level = lvl;
  cause = why;
  const allowShed = process.env.WALNUT_MEMORY_PRESSURE_SHED !== '0';
  const backoff = process.env.WALNUT_MEMORY_PRESSURE_BACKOFF !== '0';
  const next = nextShedState(state, allowShed ? lvl : 'normal', now, holdMs, backoff);
  const flipped = next.shedding !== state.shedding;
  state = next;
  if (lvl !== prevLevel || why !== prevCause) {
    log.web.info('memory pressure level changed', { from: prevLevel, to: lvl, cause: why, shedding: state.shedding, ...signalFields() });
  }
  if (!flipped) return;
  log.web.warn(state.shedding ? 'memory pressure: shedding background memory' : 'memory pressure cleared: background work resumes', {
    level: lvl, cause: why, holdMs: state.holdMs, baseHoldMs: holdMs, ...signalFields(),
  });
  for (const fn of listeners) {
    try { fn(state.shedding, lvl); } catch (err) {
      log.web.warn('memory pressure listener failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function signalFields(): { compressorPct?: number; swapoutMbPerMin?: number } {
  const out: { compressorPct?: number; swapoutMbPerMin?: number } = {};
  if (lastVerdict.compressorShare !== null) out.compressorPct = Math.round(lastVerdict.compressorShare * 1000) / 10;
  if (lastVerdict.swapoutBytesPerMin !== null) out.swapoutMbPerMin = Math.round(lastVerdict.swapoutBytesPerMin / 104857.6) / 10;
  return out;
}

async function poll(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const forced = forcedLevel();
    if (forced) { applyPressureReading(forced, Date.now(), forced === 'normal' ? null : 'forced'); return; }
    const r = await readMachine(Date.now());
    if (r) applyMemoryReading(r);
  } finally {
    reading = false;
  }
}

/** Start polling (idempotent). Off in the test runner unless forced. */
export function startMemoryPressureMonitor(options: { intervalMs?: number; holdMs?: number; force?: boolean } = {}): boolean {
  if (timer) return true;
  if (!options.force && process.env.VITEST) return false;
  holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  timer = setInterval(() => { void poll(); }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  void poll();
  return true;
}

export function stopMemoryPressureMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** True while background work should hold back memory. */
export function memoryPressureShedding(): boolean {
  return state.shedding;
}

export function memoryPressureLevel(): PressureLevel {
  return level;
}

/** What the last non-normal level came from, the hold while shedding, and the
 *  two early signals' last values (flight records, logs). */
export function memoryPressureSnapshot(): {
  level: PressureLevel; cause: PressureCause; shedding: boolean; holdMs?: number; compressorPct?: number; swapoutMbPerMin?: number;
} {
  return { level, cause, shedding: state.shedding, ...(state.shedding ? { holdMs: state.holdMs } : {}), ...signalFields() };
}

/** Subscribe to shedding flips; called at once if shedding already. Returns an unsubscribe. */
export function onMemoryPressureChange(fn: Listener): () => void {
  listeners.add(fn);
  if (state.shedding) {
    try { fn(true, level); } catch { /* the listener logs its own failures */ }
  }
  return () => { listeners.delete(fn); };
}

/** Test hook: back to the boot state. */
export function _resetMemoryPressureForTest(): void {
  stopMemoryPressureMonitor();
  level = 'normal';
  cause = null;
  signals = initialSignalState();
  lastVerdict = { compressorShare: null, swapoutBytesPerMin: null };
  holdMs = DEFAULT_HOLD_MS;
  state = initialShedState(holdMs);
  listeners.clear();
}

/** Test hook: set the hysteresis without starting the poller. */
export function _setPressureHoldMsForTest(ms: number): void {
  holdMs = ms;
}
