/**
 * Hold context for the stall flight recorder (stall-recorder.ts): per-tick
 * counters (loop thread CPU, getrusage), GC inside a hold (stall-recorder-gc.ts),
 * and the verdict a long probe-late line carries. Reading the counters is two
 * syscalls; nothing here allocates per tick beyond one small object.
 */

import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { gcWithin } from './stall-recorder-gc.js';

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
  /** The event loop's idle time so far (ms, waiting in poll: eventLoopUtilization). */
  idleMs: number;
}

export interface HoldContext {
  windowMs: number;
  mainCpuMs: number;
  /** The thread's CPU in the hold itself (pickHoldSpan): from the last CPU
   *  checkpoint before the deadline to the first one after it. */
  holdCpuMs?: number;
  /** The thread's CPU after the hold ended and before the probe ran: timers and
   *  I/O that came due during the hold, catching up. */
  afterHoldCpuMs?: number;
  /** How long the loop waited in poll inside the hold (eventLoopUtilization): a
   *  process stopped or starved while it waited for work, not while it ran some. */
  loopIdleMs?: number;
  /** Where the hold began and ended, in ms from the deadline (from <= 0 <= to). */
  holdFromMs?: number;
  holdToMs?: number;
  /** The hold began as the loop came back from a pause this long (pickHoldSpan): a
   *  second or more the thread barely ran in (stopped, starved, or waiting in
   *  poll). Its work starts with that pause's backlog. */
  afterWaitMs?: number;
  /** Pauses between the hold's end and the probe (pickHoldSpan, as afterWaitMs):
   *  what ran after them before the probe is their backlog. */
  afterHoldPauseMs?: number;
  /** The loop thread's CPU per wall ms in its normal turns over the 10 s before
   *  the hold (or before the pause it began after), read further back, up to a
   *  minute, when blocks and pauses filled those 10 s: the rate at which a pause
   *  leaves work to catch up (holdVerdict). Absent with too little history. */
  baseCpuShare?: number;
  /** The most CPU the loop ran between two checkpoints in those normal turns,
   *  below a stall's worth (ms): the work one turn of it may hold. */
  baseTurnMs?: number;
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
  /** Of gcMs, the time in full (mark-compact) collections. */
  gcMajorMs?: number;
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

export { profileHoldShare, type ProfileHold } from './stall-recorder-profiler.js';

export const mb = (n: number): number => Math.round(n / 1048576);

const hasThreadCpu = typeof (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage === 'function';

/** The event loop's idle time so far, in ms (0 where the loop does not report it). */
export function readLoopIdleMs(): number {
  try { return performance.eventLoopUtilization().idle; } catch { return 0; }
}

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
    idleMs: readLoopIdleMs(),
  };
}

/** The event-loop monitor's stall threshold: less loop CPU than this cannot hold the loop by itself. */
const OWN_STALL_CPU_MS = 250;

/** The loop thread's CPU clock (us): the one-call half of readTick. */
export function readLoopCpuUs(): number {
  const t = hasThreadCpu
    ? (process as unknown as { threadCpuUsage: () => NodeJS.CpuUsage }).threadCpuUsage()
    : process.cpuUsage();
  return t.user + t.system;
}

/** The loop thread's CPU clock and the loop's idle time at a moment its event loop was free to run a timer. */
export interface CpuCheckpoint { mono: number; cpuUs: number; idleMs: number }

/** The hold proper: from `since` (no later than the deadline) to `until` (after it), or to the probe when no timer ran in between. */
export interface HoldSpan {
  since: CpuCheckpoint;
  until: CpuCheckpoint | null;
  /** The hold began as the loop came back from a pause this long (ms; 0 when it did not). */
  afterWaitMs: number;
  /** Pauses after `until` and before the probe (ms; HoldContext.afterHoldPauseMs). */
  afterHoldPauseMs: number;
  /** The loop's CPU share in its normal turns before the hold or that pause (HoldContext.baseCpuShare). */
  baseCpuShare?: number;
  /** Its largest normal turn (HoldContext.baseTurnMs). */
  baseTurnMs?: number;
}

/** A gap this long between two moments the loop ran its own work, in which the
 *  thread ran less than PAUSE_CPU_SHARE of it, is a pause: the process was
 *  stopped or starved, or the loop waited in poll. */
const LONG_WAIT_MS = 1_000;
const PAUSE_CPU_SHARE = 0.1;
/** A hold beginning this soon after a pause ended begins with its backlog. */
const AFTER_WAIT_MS = 100;
/** The loop's rate before a hold is read over this long, from turns that were
 *  neither a pause nor a block (BLOCK_CPU_MS or more of CPU without the loop
 *  coming back), and only when that is at least BASE_MIN_MS of them. */
const BASE_WINDOW_MS = 10_000;
const BASE_MIN_MS = 1_000;
const BLOCK_CPU_MS = 1_000;
/** When blocks and pauses filled those 10 s, the rate is read further back, up
 *  to this long, until BASE_MIN_MS of normal turns are in. */
const BASE_MAX_LOOKBACK_MS = 60_000;

/**
 * Where a hold begins and ends. Checkpoints (stall-recorder-checkpoints.ts:
 * every 100 ms, and at the end of every loop iteration) mark moments the loop
 * was free to run its own work. The hold begins at the last one after the
 * previous probe and no later than the deadline (`dueMono`), else at the
 * previous probe itself, and ends at the first one after the deadline:
 * everything the thread ran in between is what held the loop. What runs after
 * that and before the probe is catch-up: timers and I/O that came due while the
 * process was stopped or starved. After a stop they all run in the loop turn
 * before the probe's: an earlier version counted up to the probe and called a
 * stopped process with 25 timers of 15 ms every 900 ms `cpu` 8 or 9 times in
 * 11 (SIGSTOP 3 s). The checkpoint at the end of the iteration comes first:
 * the loop comes back from a stop through poll, and the check phase follows it,
 * before the next turn's timers. Work queued with setImmediate by others runs
 * after the recorder's in the check phase, so a stop that lands in it still
 * counts the catch-up that follows.
 *
 * `afterWaitMs` says the hold began right as the loop came back from a pause:
 * two moments it ran its own work (checkpoints, or the previous probe) a second
 * or more apart, the thread running for under a tenth of the gap and under a
 * stall's worth (more is a block load stretched: see below). The process
 * was stopped or starved, in poll or in the middle of a turn: measured
 * 2026-10-07 by the gate's I/O backlog probe, a stop outside poll left no wait
 * in poll to see, and the 610 ms of reads that piled up held the next probe and
 * read `cpu`. `baseCpuShare` is the loop's CPU per wall ms before that pause
 * (or before the hold), in its normal turns: what holdVerdict weighs a pause's
 * backlog by; `baseTurnMs` the most CPU one of those turns ran (below a
 * stall's worth). They are read over the 10 s before, and further back (up to
 * a minute) when blocks and pauses filled those: measured 2026-10-07 by the
 * gate's wake probes at load 264 to 349, a 2.5 s block stretched to 12 s left
 * the next stop no normal turn in its 10 s, and the real blocks after 5 of 9
 * stops read `starved` with the rate unknown.
 *
 * `afterHoldPauseMs` adds up the pauses between `until` and the probe in which
 * the thread also ran under a stall's worth: a stop the loop came back from
 * through poll, then the timers that came due in it, ahead of the probe
 * (2026-10-09, load 473: an 18 ms span, then 368 ms of them read `cpu`). On
 * either side a stall's worth is a block load stretched, not a pause (the same
 * day, load 99: a 400 ms block in 15 s passed for one and read `starved`; the
 * r9 gate: a 1.5 s block in 20 s right before a real block made it `starved`).
 */
export function pickHoldSpan(
  prev: TickSample, checkpoints: Iterable<CpuCheckpoint>, dueMono: number, monoNow: number,
): HoldSpan {
  const start: CpuCheckpoint = { mono: prev.mono, cpuUs: prev.threadUserUs + prev.threadSysUs, idleMs: prev.idleMs };
  let since = start;
  let until: CpuCheckpoint | null = null;
  const all = [...checkpoints];
  for (const c of all) {
    if (c.mono > since.mono && c.mono <= dueMono) since = c;
    else if (c.mono > dueMono && c.mono <= monoNow && (!until || c.mono < until.mono)) until = c;
  }
  // Every moment up to the hold's start the loop ran its own work, oldest first.
  const points = all.filter((c) => c.mono <= since.mono && c.mono !== start.mono).concat(start).sort((a, b) => a.mono - b.mono);
  const quiet = (a: CpuCheckpoint, b: CpuCheckpoint): boolean =>
    b.mono - a.mono >= LONG_WAIT_MS && (b.cpuUs - a.cpuUs) / 1000 < PAUSE_CPU_SHARE * (b.mono - a.mono);
  // A stall's worth of CPU in a quiet gap is a block load stretched, not a pause (on both sides).
  const isPause = (a: CpuCheckpoint, b: CpuCheckpoint): boolean => quiet(a, b) && b.cpuUs - a.cpuUs < OWN_STALL_CPU_MS * 1000;
  // A pause that ended at most AFTER_WAIT_MS before the start (newest first).
  let afterWaitMs = 0;
  let ref = since.mono;
  for (let i = points.length - 1; i > 0 && since.mono - points[i].mono <= AFTER_WAIT_MS; i--) {
    if (isPause(points[i - 1], points[i])) { afterWaitMs = Math.round(points[i].mono - points[i - 1].mono); ref = points[i - 1].mono; break; }
  }
  // Pauses after the hold and before the probe (afterHoldPauseMs).
  const end = until;
  const later = end ? all.filter((c) => c.mono >= end.mono && c.mono <= monoNow).sort((a, b) => a.mono - b.mono) : [];
  let laterMs = 0;
  for (let i = 1; i < later.length; i++) if (isPause(later[i - 1], later[i])) laterMs += later[i].mono - later[i - 1].mono;
  const afterHoldPauseMs = Math.round(laterMs);
  let cpuMs = 0, wallMs = 0, turnMs = 0;
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i - 1], b = points[i];
    if (a.mono < ref - BASE_WINDOW_MS && (wallMs >= BASE_MIN_MS || a.mono < ref - BASE_MAX_LOOKBACK_MS)) break;
    const segMs = (b.cpuUs - a.cpuUs) / 1000;
    if (b.mono > ref || quiet(a, b) || segMs >= BLOCK_CPU_MS) continue;
    cpuMs += segMs;
    wallMs += b.mono - a.mono;
    if (segMs < OWN_STALL_CPU_MS && segMs > turnMs) turnMs = segMs;
  }
  if (wallMs < BASE_MIN_MS) return { since, until, afterWaitMs, afterHoldPauseMs };
  return { since, until, afterWaitMs, afterHoldPauseMs, baseCpuShare: Math.round(Math.min(1, cpuMs / wallMs) * 1000) / 1000, baseTurnMs: Math.round(turnMs) };
}

/** A pause's backlog is the loop's normal work for that long, and normal work
 *  comes in bursts (a list of timers due together): twice the rate allows for one. */
const BACKLOG_RATE_FACTOR = 2;

/**
 * Classify a hold. Exported for tests. Context switches and faults are
 * process-wide (getrusage has no per-thread view on macOS), so the counters
 * alone are a first read; the flight record adds the kept profile's view of the
 * hold (codeShare), which can make a hold `cpu` the counters alone would not.
 *
 * `cpu` means Walnut's own code held the loop, whether or not the machine was
 * short of CPU at the same time: a synchronous loop that is preempted keeps the
 * loop just as held, only longer. Measured 2026-10-03, a 3.5 s synchronous loop at
 * load 120: the thread got 1.35 s of CPU with 6559 involuntary switches and no
 * voluntary one, and the counters alone called that `starved`, which the docs
 * then read as "the machine, not Walnut code".
 *
 * Time the loop did not run its work (a pause right before the hold, a wait in
 * poll inside it, a span the thread barely ran in) leaves a backlog: the timers
 * and reads that came due, which run as soon as it comes back. That backlog is
 * not code holding the loop, so rules 1 and 3 count only the CPU past what the
 * loop owed for that time: twice its normal rate before it (baseCpuShare)
 * times the time. Without the rate they count nothing after such a time. Measured
 * 2026-10-07 by the gate: a real 1.5 to 2.5 s block right after a 3 s stop,
 * code on every sample, read `starved` when any wait before the hold ruled the
 * hold's CPU out (owed: about 0.3 s at the probe's 5% rate), while the 610 ms of
 * reads a 3 s stop of a loop 40% busy left read `cpu` (owed: about 2 s).
 *
 * Rule 1: the thread burned a stall's worth of CPU (250 ms, the event-loop
 * monitor's threshold) past what it owed in the hold itself (holdCpuMs,
 * pickHoldSpan), and the kept profile, when it sampled the hold, has code
 * frames on top for most of it. Less CPU than that cannot have held the loop by
 * itself: a thread preempted in the middle of a short callback is sampled in
 * code for as long as the machine keeps it waiting. With the hold's own span
 * measured, no profile is needed: a sampler the machine starved can miss the
 * hold (measured 2026-10-05: a 300 ms block stopped 50 ms in for 3 s left fewer
 * than 5 samples in its 3.5 s, 2 times in 9 at load 16). A wait in poll inside
 * the hold owes its backlog too, when it lasted a second or more or most of the
 * hold: the process stopped while it had nothing to run, and what ran next was
 * what that wait queued.
 *
 * Rule 2: the thread ran for most of the window (60%, the window starting at
 * most one probe interval before the hold).
 *
 * Rule 3: the CPU up to the probe, past what the loop owed, is a stall's worth.
 * A block runs the loop through its deadline and keeps all of its own CPU,
 * however long the machine stretched it. When the hold's span is shorter than
 * a stall (the recorder's checkpoint ran right after the deadline, and a block
 * started behind it), it must be a stall's worth past the largest turn the loop
 * ran normally (baseTurnMs), however long a stop inside it lasted: what ran
 * there before the probe was due before the deadline, and the loop's own work
 * due then is one turn of it (2026-10-07 gate: with a quarter of the hold
 * required, a 460 ms block stopped for 3 s at load 137 read `starved`, 3 times
 * in 36; with nothing more required, a stopped burst of 25 timers due just
 * before the deadline, 278 ms, read `cpu`). A pause the loop came back from
 * behind that checkpoint (afterHoldPauseMs) owes its backlog in every branch
 * of rule 3. Without the loop's turns, a quarter of the hold is still
 * required, and nothing counts after such a pause. When
 * the thread ran for half of the span, a block began in it, and the CPU must
 * also be a quarter of the hold. When it ran for less, the span was a stop, a
 * stretch the machine did not run it, or a wait in poll, and only what ran
 * after the span counts, past what the loop owed for the span (2026-10-05 gate:
 * counted whole, 10 of 14 stops of a server with many short timers read `cpu`).
 *
 * `gc` needs a stall's worth of CPU too, the thread's own in the hold plus the
 * other threads' (parallel marking runs on helpers): a collection the process
 * was stopped in lasts as long as the stop. `starved` is left for a thread that
 * barely ran: the machine did not run it, and it had little of its own to do.
 */
export function holdVerdict(h: {
  lateByMs: number; windowMs: number; mainCpuMs: number; gcMs: number; majorFaults: number; invCtxSwitches: number;
  volCtxSwitches?: number; procCpuMs?: number; holdCpuMs?: number; afterHoldCpuMs?: number; gcMajorMs?: number;
  loopIdleMs?: number; holdFromMs?: number; holdToMs?: number; afterWaitMs?: number; afterHoldPauseMs?: number;
  baseCpuShare?: number; baseTurnMs?: number;
  /** From the kept profile (profileHoldShare): share of the hold with code on top, and its sample count. */
  codeShare?: number; profileSamples?: number;
}): HoldVerdict {
  const heldMs = h.holdCpuMs ?? h.mainCpuMs;
  // From the hold's start to the probe: the hold and the catch-up after it.
  const toProbeMs = h.holdCpuMs === undefined ? h.mainCpuMs : Math.min(h.mainCpuMs, h.holdCpuMs + (h.afterHoldCpuMs ?? 0));
  // The switch counts and the GC helpers' CPU are process-wide: the other
  // threads' share of the window.
  const othersMs = Math.max(0, (h.procCpuMs ?? h.mainCpuMs) - h.mainCpuMs);
  // GC entries are wall-clock: a scavenge the process was stopped or starved
  // in the middle of lasts as long as the stop (measured 2026-10-04: a 3.1 s
  // scavenge in a 3 s SIGSTOP, 14 ms of the hold's own CPU). A collection held
  // the loop only when a stall's worth of it ran, on the loop thread or on the
  // GC's helpers (a full collection stopped 150 ms in: 194 ms on the loop
  // thread, 793 ms on the others; measured 2026-10-05, another one 6 ms and
  // 966 ms, its marking all on the helpers). A scavenge needs no helper for
  // that long, so unless a full collection lasted the hold the loop thread's
  // own part must be at least a fifth of it: a busy worker thread does not
  // pass for a helper.
  const fullGc = (h.gcMajorMs ?? 0) >= 0.5 * h.lateByMs;
  if (h.gcMs >= 0.5 * h.lateByMs && (heldMs >= OWN_STALL_CPU_MS / 5 || fullGc)
    && heldMs + othersMs >= OWN_STALL_CPU_MS) return 'gc';
  const spanMs = h.holdFromMs !== undefined && h.holdToMs !== undefined ? h.holdToMs - h.holdFromMs : undefined;
  const pauseMs = h.afterWaitMs ?? 0;
  const laterMs = h.afterHoldPauseMs ?? 0;
  /** What the loop owed for `ms` it did not run its work; undefined when that is time and its rate is unknown. */
  const owed = (ms: number): number | undefined => {
    if (ms <= 0) return 0;
    return h.baseCpuShare === undefined ? undefined : BACKLOG_RATE_FACTOR * h.baseCpuShare * ms;
  };
  const past = (cpuMs: number, owedMs: number | undefined): boolean => owedMs !== undefined && cpuMs >= OWN_STALL_CPU_MS + owedMs;
  // Rule 1. A hold context without holdCpuMs has only the window's CPU, the
  // loop's work before the hold included, and then only the profile can say.
  // A wait in poll of a second or more owes its backlog however long load
  // stretched what came after it (2026-10-07 gate, load 322: a 3 s stop in
  // poll, then 415 ms of the reads it queued over 5.5 s, read `cpu` while only
  // a wait that was most of the hold counted); a shorter one only when it was
  // most of the hold.
  const waitedMs = h.loopIdleMs !== undefined && spanMs !== undefined && spanMs > 0
    && (h.loopIdleMs >= LONG_WAIT_MS || h.loopIdleMs >= 0.5 * spanMs) ? h.loopIdleMs : 0;
  const sampled = (h.profileSamples ?? 0) >= 5;
  const sawCode = sampled && (h.codeShare ?? 0) >= 0.5;
  if (past(heldMs, owed(pauseMs + waitedMs)) && (sawCode || (!sampled && h.holdCpuMs !== undefined))) return 'cpu';
  // Rule 2.
  const share = h.mainCpuMs / h.windowMs;
  if (share >= 0.6) return 'cpu';
  // 16 KB pages: 64 hard faults is 1 MB read from disk while the loop waited.
  if (h.majorFaults >= 64 && share < 0.3) return 'paging';
  // Rule 3. Without a profile this is the only evidence, and a starved idle
  // loop never gets near it (5 ms in 8.5 s).
  if (spanMs === undefined) {
    if (past(toProbeMs, 0) && toProbeMs >= 0.25 * h.lateByMs) return 'cpu';
  } else if (spanMs < OWN_STALL_CPU_MS) {
    const o = owed(pauseMs + laterMs);
    if (h.baseTurnMs === undefined ? past(toProbeMs, owed(laterMs)) && toProbeMs >= 0.25 * h.lateByMs
      : past(toProbeMs, o === undefined ? undefined : o + h.baseTurnMs)) return 'cpu';
  } else if (heldMs >= 0.5 * spanMs) {
    if (past(toProbeMs, owed(pauseMs + waitedMs + laterMs)) && toProbeMs >= 0.25 * h.lateByMs) return 'cpu';
  } else if (past(h.afterHoldCpuMs ?? 0, owed(pauseMs + spanMs - heldMs + laterMs))) {
    return 'cpu';
  }
  // Runnable but not running, with little of its own to run: the process lost
  // the CPU to preemption and never waited on its own. Measured 2026-10-02: an
  // isolated server at nice 10, load 300, got 5% of a core with 500 to 900
  // involuntary switches and 0 or 1 voluntary; the same server at load 281 ran
  // 5 ms in an 8.5 s hold (148 involuntary, 1 voluntary, no faults, no GC). A
  // thread blocked in a call, on a lock or on a disk read switches voluntarily
  // instead.
  const offCpuMs = h.windowMs - h.mainCpuMs;
  const vol = h.volCtxSwitches ?? 0;
  // The switch counts speak for the loop thread only when no other thread
  // burned real CPU (a busy, preempted worker would).
  if (othersMs < 0.1 * h.windowMs && h.invCtxSwitches >= 20 && h.invCtxSwitches >= 4 * vol) return 'starved';
  if (share >= 0.1 && h.invCtxSwitches >= offCpuMs / 20) return 'starved';
  return 'off-cpu';
}

export { gcWithin, startGcRing, stopGcRing } from './stall-recorder-gc.js';

/** The part of a hold context its span and the two ticks give (captureHold;
 *  exported so tests run a synthetic span through the same arithmetic). */
export function spanFields(prev: TickSample, now: TickSample, lateByMs: number, monoNow: number, span?: HoldSpan | null) {
  const mainCpuMs = Math.round((now.threadUserUs - prev.threadUserUs + now.threadSysUs - prev.threadSysUs) / 1000);
  const nowCpuUs = now.threadUserUs + now.threadSysUs;
  const since = span && span.since.mono >= prev.mono
    ? span.since
    : { mono: prev.mono, cpuUs: prev.threadUserUs + prev.threadSysUs, idleMs: prev.idleMs };
  const until = span?.until && span.until.mono > since.mono && span.until.mono <= monoNow ? span.until : null;
  const end = until ?? { mono: monoNow, cpuUs: nowCpuUs, idleMs: now.idleMs };
  const ms = (us: number): number => Math.max(0, Math.round(us / 1000));
  const holdCpuMs = Math.min(mainCpuMs, ms(end.cpuUs - since.cpuUs));
  const dueMono = monoNow - lateByMs;
  return {
    windowMs: Math.max(1, Math.round(monoNow - prev.mono)),
    mainCpuMs,
    holdCpuMs,
    afterHoldCpuMs: Math.min(mainCpuMs - holdCpuMs, ms(nowCpuUs - end.cpuUs)),
    loopIdleMs: Math.max(0, Math.round(end.idleMs - since.idleMs)),
    holdFromMs: Math.round(since.mono - dueMono),
    holdToMs: Math.round(end.mono - dueMono),
    afterWaitMs: span?.afterWaitMs ?? 0,
    afterHoldPauseMs: until ? span?.afterHoldPauseMs ?? 0 : 0,
    ...(span?.baseCpuShare !== undefined ? { baseCpuShare: span.baseCpuShare, baseTurnMs: span.baseTurnMs } : {}),
  };
}

/**
 * The hold context for a probe that fired lateByMs late, from the counters at
 * the previous on-time tick, and the hold's own span (pickHoldSpan; the
 * previous tick to now when absent). perfToMonoMs maps monotonic ms onto GC
 * entry times.
 */
export function captureHold(
  prev: TickSample, lateByMs: number, monoNow: number, perfToMonoMs: number, span?: HoldSpan | null,
): HoldContext {
  const now = readTick(monoNow);
  const fromPerf = prev.mono + perfToMonoMs;
  const gc = gcWithin(fromPerf, monoNow + perfToMonoMs);
  const mem = process.memoryUsage();
  const majorFaults = now.majflt - prev.majflt;
  const ctx: HoldContext = {
    ...spanFields(prev, now, lateByMs, monoNow, span),
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
    gcMajorMs: gc.majorMs,
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
  ctx.verdict = holdVerdict({ lateByMs, ...ctx });
  return ctx;
}
