/**
 * Event-loop lag monitor — makes event-loop starvation VISIBLE.
 *
 * Walnut has repeatedly hit bugs where a synchronous burst (unbounded debug
 * logging, ~293 serial SQLite writes per health-monitor tick, a JSON-store
 * read-modify-write) blocks the libuv event loop for seconds, so EVERY HTTP
 * request — even a 2 KB one — stalls behind it and times out at 15 s. Those
 * bugs were invisible: the slow request's own handler logged a fast duration
 * because the time was spent *queued*, not *running*.
 *
 * This monitor closes that gap. It uses two independent signals:
 *
 *  1. perf_hooks.monitorEventLoopDelay — a zero-overhead libuv histogram of
 *     loop delay (max/p99/mean). Sampled every WINDOW_MS; if the window max
 *     crosses STALL_THRESHOLD_MS we log a `warn` with the percentiles. This
 *     tells us a stall happened and how bad, with no hot-path cost.
 *
 *  2. A self-scheduled timer that measures how late it actually fired. When a
 *     single tick is late by > STALL_THRESHOLD_MS we log the lateness plus the
 *     name of the periodic task most likely responsible (set via
 *     markCriticalSection), so the culprit is named, not guessed.
 *
 * Cheap enough to run in production permanently. Off only in tests.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { execFile } from 'node:child_process'
import { log } from '../logging/index.js'
import { observe } from './observability/metrics.js'
import { noteSleepSinceLastLook } from '../lib/sleep-ledger.js'
import { HISTOGRAM_STALL_MESSAGE, PROBE_LATE_MESSAGE, stallMetricOf } from './stall-cause.js'
import { blockingCallsWithin } from './blocking-calls.js'
import { readLoopCpuUs } from './stall-recorder-hold.js'
import {
  clearSectionsForSleep, closedSectionsSince, describeOpenSections, resetSections, setSectionClock, sinceStartS,
} from './event-loop-sections.js'

export { markCriticalSection } from './event-loop-sections.js'

/** Loop delay above this (ms) in a window is reported as a stall. */
const STALL_THRESHOLD_MS = 250
/** How often we sample the libuv histogram + reset it. */
const WINDOW_MS = 5_000
/** Self-timer cadence; lateness beyond threshold = the loop was blocked. */
const PROBE_INTERVAL_MS = 1_000
/**
 * If the wall-clock delta exceeds the monotonic delta by more than this, the
 * process was suspended (macOS system sleep, laptop lid close, SIGSTOP) — the
 * "lateness" is sleep, not an event-loop block, and must not be reported as one.
 */
const SLEEP_GAP_MS = 5_000

/** Injectable clock pair so tests can simulate wall/monotonic divergence. */
export interface MonitorClocks {
  /** Wall clock (jumps across system sleep). */
  now(): number
  /** Monotonic clock in ms (does not include suspended time). */
  monoNow(): number
}
const defaultClocks: MonitorClocks = {
  now: () => Date.now(),
  monoNow: () => Number(process.hrtime.bigint()) / 1e6,
}

/**
 * Second sleep signal, darwin-only: under Node the wall-vs-monotonic gap NEVER
 * fires on Apple Silicon because hrtime keeps advancing through system sleep
 * there (measured hrtime ≈ os.uptime ≈ wall clock on an M-series Mac, while
 * minute-long sleep artifacts were reported as 1,000,000ms+ "stalls"). Under
 * Bun, which the server runs on now, hrtime stops while the Mac sleeps and the
 * gap fires (2026-11-10 logs); this signal stays for a Node run.
 * kern.waketime is the kernel's last-wake timestamp: if it changed since we
 * last looked, the machine slept inside the window and the report is an
 * artifact. Only consulted when a stall is about to be reported (no per-tick
 * exec cost); result is applied asynchronously.
 */
let lastObservedWakeTime = ''
function wakeTimeChangedSince(cb: (changed: boolean) => void): void {
  if (process.platform !== 'darwin') { cb(false); return }
  execFile('sysctl', ['-n', 'kern.waketime'], { timeout: 2_000 }, (err, stdout) => {
    if (err) { cb(false); return }
    const current = stdout.trim()
    const changed = lastObservedWakeTime !== '' && current !== lastObservedWakeTime
    lastObservedWakeTime = current
    cb(changed)
  })
}

/**
 * A reported probe-late stall, as the stall flight recorder (stall-recorder.ts)
 * sees it. Monotonic times are process.hrtime milliseconds.
 */
export interface StallReport {
  lateByMs: number
  /** The previous probe tick: the hold began after this. */
  holdStartMono: number
  /** When this probe was due: the hold covered this instant. */
  dueMono: number
  /** This (late) probe tick: the hold ended just before this. */
  holdEndMono: number
  wallNow: number
  suspectSection: string | null
  hold?: Record<string, unknown>
}

/**
 * Optional observer of the probe (the stall flight recorder). tick() runs on
 * every probe tick and must be O(1); hold() runs synchronously when a probe is
 * late, BEFORE tick() replaces its previous sample, and returns fields for the
 * report; reported() runs once the stall is confirmed (not a system sleep).
 */
export interface ProbeObserver {
  tick(monoNow: number): void
  hold(lateByMs: number, monoNow: number): Record<string, unknown> | undefined
  reported(report: StallReport): void
}
let probeObserver: ProbeObserver | null = null
export function setProbeObserver(next: ProbeObserver | null): void {
  probeObserver = next
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
/** p99 loop delay of the last completed window (ms), for close-time diagnostics. */
let lastWindowP99Ms: number | null = null
let windowTimer: ReturnType<typeof setInterval> | null = null
let probeTimer: ReturnType<typeof setTimeout> | null = null
let clocks: MonitorClocks = defaultClocks
let lastProbeWallAt = 0
let lastProbeMonoAt = 0
let lastWindowWallAt = 0
let lastWindowMonoAt = 0

/** The loop thread's CPU and the process's context switches when the current window began. */
let windowLoopCpuUs = 0
let windowInvCsw = 0
let windowVolCsw = 0

function readWindowCounters(): { cpuUs: number; inv: number; vol: number } {
  const r = process.resourceUsage()
  return { cpuUs: readLoopCpuUs(), inv: r.involuntaryContextSwitches, vol: r.voluntaryContextSwitches }
}

/**
 * What the loop thread did in the window that held a stall, so a stall with no section open still
 * says what it was (2026-11-23: 650 of 1,207 histogram stalls named nothing):
 *   loopCpuMs   the loop thread's own CPU in the window. `offCpu` when that is under half the
 *               stall's length: its code cannot have held the loop that long by itself, so the
 *               machine did not run the thread (`invCtxSwitches` high) or it waited in a
 *               blocking call (`blocking`). The reverse proves nothing: a busy loop's normal
 *               turns add up too.
 *   blocking    the synchronous SQLite and child-process calls of 20 ms or more in the window,
 *               with their call sites (blocking-calls.ts), as the probe-late line has had;
 *   closedSections  sections that ended inside the window (event-loop-sections.ts).
 */
function windowEvidence(maxMs: number, windowStartWall: number): Record<string, unknown> {
  const now = readWindowCounters()
  const loopCpuMs = Math.round((now.cpuUs - windowLoopCpuUs) / 1000)
  let blocking: ReturnType<typeof blockingCallsWithin> = null
  if (clocks === defaultClocks) {
    try {
      const perfNow = performance.now()
      blocking = blockingCallsWithin(perfNow - WINDOW_MS, perfNow)
    } catch { blocking = null }
  }
  const closedSections = closedSectionsSince(windowStartWall)
  return {
    loopCpuMs,
    offCpu: loopCpuMs * 2 < maxMs,
    invCtxSwitches: now.inv - windowInvCsw,
    volCtxSwitches: now.vol - windowVolCsw,
    ...(blocking ? { blocking } : {}),
    ...(closedSections.length ? { closedSections } : {}),
  }
}

function resetWindowCounters(): void {
  const c = readWindowCounters()
  windowLoopCpuUs = c.cpuUs
  windowInvCsw = c.inv
  windowVolCsw = c.vol
}

export function startEventLoopMonitor(clocksOverride?: MonitorClocks): void {
  if (histogram) return // already running
  clocks = clocksOverride ?? defaultClocks

  histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  lastProbeWallAt = clocks.now()
  lastProbeMonoAt = clocks.monoNow()
  lastWindowWallAt = lastProbeWallAt
  lastWindowMonoAt = lastProbeMonoAt
  setSectionClock(clocks.now, lastProbeWallAt)
  resetWindowCounters()

  // Signal 1: windowed histogram — reports the worst delay seen per window.
  windowTimer = setInterval(() => {
    if (!histogram) return
    const wallNow = clocks.now()
    const monoNow = clocks.monoNow()
    const sleptMs = (wallNow - lastWindowWallAt) - (monoNow - lastWindowMonoAt)
    const windowStartWall = lastWindowWallAt
    lastWindowWallAt = wallNow
    lastWindowMonoAt = monoNow
    if (sleptMs > SLEEP_GAP_MS) {
      // Window spans a system sleep — the histogram accumulated a giant fake
      // "delay" for the suspended time. Drop the window entirely.
      histogram.reset()
      resetWindowCounters()
      return
    }
    const maxMs = histogram.max / 1e6 // ns → ms
    // Metric: every window's worst loop delay — the continuous baseline the
    // stall warnings below are the outliers of. Lets "was the loop healthy at
    // 14:32?" be answered from metrics instead of absence-of-warnings.
    observe('eventloop.delay.max', Math.round(maxMs))
    lastWindowP99Ms = Math.round(histogram.percentile(99) / 1e6)
    if (maxMs >= STALL_THRESHOLD_MS) {
      const payload = {
        windowMs: WINDOW_MS,
        maxMs: Math.round(maxMs),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        sinceStartS: sinceStartS(),
        // suspectSection is the longest-running open section (`boot` with none open
        // right after start); openSections lists them all with wall vs loop CPU, so
        // an await-bound tick is not mistaken for the one that held the loop.
        ...(() => {
          const { section, detail, awaiting } = describeOpenSections()
          return { suspectSection: section, openSections: detail, sectionAwaiting: awaiting }
        })(),
        ...windowEvidence(maxMs, windowStartWall),
      }
      // Giant "stalls" (minutes) are almost always sleep artifacts the
      // wall-vs-mono gap can't see on Apple Silicon (see wakeTimeChangedSince).
      // Confirm against the kernel's wake time before reporting those; small
      // stalls skip the check (a real block is never minutes long without the
      // whole process being dead anyway).
      if (maxMs >= 60_000) {
        wakeTimeChangedSince((slept) => {
          if (slept) {
            log.web.info('system sleep detected via kern.waketime (histogram window dropped)', { maxMs: payload.maxMs })
          } else {
            log.web.warn(HISTOGRAM_STALL_MESSAGE, payload)
          }
        })
      } else {
        log.web.warn(HISTOGRAM_STALL_MESSAGE, payload)
      }
    }
    histogram.reset()
    resetWindowCounters()
  }, WINDOW_MS)
  if (typeof windowTimer === 'object' && 'unref' in windowTimer) windowTimer.unref()

  // Signal 2: self-timer lateness — pinpoints WHEN a tick was blocked and by
  // what (the section in flight at that instant). Lateness is judged on the
  // MONOTONIC clock: wall time jumps across macOS system sleep, which used to
  // produce minute-long fake "event-loop blocked" warns (lateByMs = sleep
  // duration) falsely attributed to whatever section spanned the sleep.
  const probe = (): void => {
    // Keeps the sleep ledger's intervals a second wide (lib/sleep-ledger.ts).
    noteSleepSinceLastLook()
    const wallNow = clocks.now()
    const monoNow = clocks.monoNow()
    const wallDelta = wallNow - lastProbeWallAt
    const monoDelta = monoNow - lastProbeMonoAt
    const prevProbeMono = lastProbeMonoAt
    lastProbeWallAt = wallNow
    lastProbeMonoAt = monoNow
    const sleptMs = wallDelta - monoDelta
    if (sleptMs > SLEEP_GAP_MS) {
      // Suspended (system sleep / SIGSTOP) — not an event-loop block.
      log.web.info('system sleep detected (not an event-loop block)', { sleptMs: Math.round(sleptMs) })
      histogram?.reset() // drop the fake delay the histogram saw across sleep
      lastWindowWallAt = wallNow // re-baseline the window sampler too
      lastWindowMonoAt = monoNow
      resetWindowCounters()
      clearSectionsForSleep()
    } else {
      const lateBy = monoDelta - PROBE_INTERVAL_MS
      // Metric: probe lateness every tick (usually ~0ms). The p99 of this series
      // IS the user-felt scheduling delay for any queued request.
      observe('eventloop.probe.late', Math.max(0, Math.round(lateBy)))
      if (lateBy >= STALL_THRESHOLD_MS) {
        const { section, detail, awaiting } = describeOpenSections()
        // Hold context (thread CPU, faults, GC, memory) from the flight recorder,
        // read now: the next tick replaces the sample it is measured against.
        let hold: Record<string, unknown> | undefined
        try { hold = probeObserver?.hold(lateBy, monoNow) } catch { hold = undefined }
        // The synchronous calls (SQLite, child process starts) that held the loop
        // past the probe's deadline: from that deadline to now, so a call that ran
        // in the normal second before it is not counted (blocking.ms <= lateByMs).
        let blocking: ReturnType<typeof blockingCallsWithin> = null
        if (clocks === defaultClocks) {
          try {
            const perfNow = performance.now()
            blocking = blockingCallsWithin(perfNow - lateBy, perfNow)
          } catch { blocking = null }
        }
        const payload = {
          lateByMs: Math.round(lateBy),
          sinceStartS: sinceStartS(),
          suspectSection: section,
          openSections: detail,
          sectionAwaiting: awaiting,
          ...(blocking ? { blocking } : {}),
          ...(hold ? { hold } : {}),
        }
        const report = (): void => {
          log.web.warn(PROBE_LATE_MESSAGE, payload)
          // Health: Walnut's own stalls and the machine's are counted apart
          // (stall-cause.ts), so a starved server opens no "fix Walnut" task.
          observe(stallMetricOf(hold), payload.lateByMs)
          try {
            probeObserver?.reported({
              lateByMs: payload.lateByMs,
              holdStartMono: prevProbeMono,
              dueMono: prevProbeMono + PROBE_INTERVAL_MS,
              holdEndMono: monoNow,
              wallNow,
              suspectSection: section,
              hold,
            })
          } catch { /* diagnostics only */ }
        }
        // Same Apple Silicon caveat as the histogram: hrtime advances through
        // sleep there, so the wall-vs-mono branch above never triggers and a
        // lid-close shows up here as a minutes-long "block". Verify against
        // kern.waketime before reporting a giant one.
        if (lateBy >= 60_000) {
          wakeTimeChangedSince((slept) => {
            if (slept) {
              log.web.info('system sleep detected via kern.waketime (probe lateness dropped)', { lateByMs: payload.lateByMs })
              clearSectionsForSleep()
            } else {
              report()
            }
          })
        } else {
          report()
        }
      }
    }
    try { probeObserver?.tick(monoNow) } catch { /* diagnostics only */ }
    probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
    if (probeTimer && typeof probeTimer === 'object' && 'unref' in probeTimer) probeTimer.unref()
  }
  probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
  if (probeTimer && typeof probeTimer === 'object' && 'unref' in probeTimer) probeTimer.unref()

  log.web.info('event-loop monitor started', { stallThresholdMs: STALL_THRESHOLD_MS, windowMs: WINDOW_MS })
}

/**
 * The p99 event-loop delay of the most recent 5s window, or null before the
 * first window (or with the monitor off). A bridge that goes silent while this
 * process's loop was blocked is a different story from a link that died.
 */
export function eventLoopP99Ms(): number | null {
  return lastWindowP99Ms
}

export function stopEventLoopMonitor(): void {
  if (windowTimer) { clearInterval(windowTimer); windowTimer = null }
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
  if (histogram) { histogram.disable(); histogram = null }
  lastWindowP99Ms = null
  resetSections()
  clocks = defaultClocks
}
