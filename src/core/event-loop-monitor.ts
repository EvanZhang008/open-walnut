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

import { monitorEventLoopDelay } from 'node:perf_hooks'
import { log } from '../logging/index.js'

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

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let windowTimer: ReturnType<typeof setInterval> | null = null
let probeTimer: ReturnType<typeof setTimeout> | null = null
let clocks: MonitorClocks = defaultClocks
let lastProbeWallAt = 0
let lastProbeMonoAt = 0
let lastWindowWallAt = 0
let lastWindowMonoAt = 0

/**
 * The name of the synchronous section currently executing, if any. Periodic
 * tasks that are known event-loop hazards (health monitor, reconciler, git
 * sync) wrap themselves with markCriticalSection() so that when the probe
 * detects a stall we can attribute it instead of guessing.
 */
let currentSection: string | null = null
let sectionStartedAt = 0
// Token identifying the current section owner, so a sleep-triggered clear
// (see clearSectionForSleep) can't be undone-over by a stale end() closure.
let sectionToken = 0

/**
 * Mark a synchronous/awaited section so a concurrent stall can be attributed
 * to it. Returns a function to call when the section ends (use try/finally).
 *
 *   const end = markCriticalSection('health-monitor.check')
 *   try { ...heavy work... } finally { end() }
 */
export function markCriticalSection(name: string): () => void {
  // Nested sections: keep the outermost label (the one that owns the burst).
  if (currentSection) return () => { /* inner — outer owns attribution */ }
  currentSection = name
  sectionStartedAt = clocks.now()
  const token = ++sectionToken
  return () => {
    if (token !== sectionToken) return // cleared by sleep detection meanwhile
    currentSection = null
    sectionStartedAt = 0
  }
}

/**
 * System sleep spans whatever periodic tick happened to be in flight (e.g. a
 * health-monitor check awaiting I/O when the lid closed). Clearing the
 * attribution prevents falsely blaming that section for the "stall".
 */
function clearSectionForSleep(): void {
  currentSection = null
  sectionStartedAt = 0
  sectionToken++ // invalidate outstanding end() closures
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

  // Signal 1: windowed histogram — reports the worst delay seen per window.
  windowTimer = setInterval(() => {
    if (!histogram) return
    const wallNow = clocks.now()
    const monoNow = clocks.monoNow()
    const sleptMs = (wallNow - lastWindowWallAt) - (monoNow - lastWindowMonoAt)
    lastWindowWallAt = wallNow
    lastWindowMonoAt = monoNow
    if (sleptMs > SLEEP_GAP_MS) {
      // Window spans a system sleep — the histogram accumulated a giant fake
      // "delay" for the suspended time. Drop the window entirely.
      histogram.reset()
      return
    }
    const maxMs = histogram.max / 1e6 // ns → ms
    if (maxMs >= STALL_THRESHOLD_MS) {
      log.web.warn('event-loop stall detected (histogram)', {
        windowMs: WINDOW_MS,
        maxMs: Math.round(maxMs),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        // If a marked section is mid-flight it's the prime suspect.
        suspectSection: currentSection,
        sectionAgeMs: currentSection ? clocks.now() - sectionStartedAt : undefined,
      })
    }
    histogram.reset()
  }, WINDOW_MS)
  if (typeof windowTimer === 'object' && 'unref' in windowTimer) windowTimer.unref()

  // Signal 2: self-timer lateness — pinpoints WHEN a tick was blocked and by
  // what (the section in flight at that instant). Lateness is judged on the
  // MONOTONIC clock: wall time jumps across macOS system sleep, which used to
  // produce minute-long fake "event-loop blocked" warns (lateByMs = sleep
  // duration) falsely attributed to whatever section spanned the sleep.
  const probe = (): void => {
    const wallNow = clocks.now()
    const monoNow = clocks.monoNow()
    const wallDelta = wallNow - lastProbeWallAt
    const monoDelta = monoNow - lastProbeMonoAt
    lastProbeWallAt = wallNow
    lastProbeMonoAt = monoNow
    const sleptMs = wallDelta - monoDelta
    if (sleptMs > SLEEP_GAP_MS) {
      // Suspended (system sleep / SIGSTOP) — not an event-loop block.
      log.web.info('system sleep detected (not an event-loop block)', { sleptMs: Math.round(sleptMs) })
      histogram?.reset() // drop the fake delay the histogram saw across sleep
      lastWindowWallAt = wallNow // re-baseline the window sampler too
      lastWindowMonoAt = monoNow
      clearSectionForSleep()
    } else {
      const lateBy = monoDelta - PROBE_INTERVAL_MS
      if (lateBy >= STALL_THRESHOLD_MS) {
        log.web.warn('event-loop blocked (probe late)', {
          lateByMs: Math.round(lateBy),
          suspectSection: currentSection,
          sectionAgeMs: currentSection ? wallNow - sectionStartedAt : undefined,
        })
      }
    }
    probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
    if (probeTimer && typeof probeTimer === 'object' && 'unref' in probeTimer) probeTimer.unref()
  }
  probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
  if (probeTimer && typeof probeTimer === 'object' && 'unref' in probeTimer) probeTimer.unref()

  log.web.info('event-loop monitor started', { stallThresholdMs: STALL_THRESHOLD_MS, windowMs: WINDOW_MS })
}

export function stopEventLoopMonitor(): void {
  if (windowTimer) { clearInterval(windowTimer); windowTimer = null }
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
  if (histogram) { histogram.disable(); histogram = null }
  currentSection = null
  sectionToken++
  clocks = defaultClocks
}
