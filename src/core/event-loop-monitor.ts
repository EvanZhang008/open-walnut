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
import { execFile } from 'node:child_process'
import { log } from '../logging/index.js'
import { observe } from './observability/metrics.js'

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
 * Second sleep signal, darwin-only: the wall-vs-monotonic gap NEVER fires on
 * Apple Silicon because mach_absolute_time (hrtime's source) keeps advancing
 * through system sleep there — measured hrtime ≈ os.uptime ≈ wall clock on an
 * M-series Mac, and "system sleep detected" appeared 0 times in days of logs
 * while minute-long sleep artifacts were reported as 1,000,000ms+ "stalls".
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

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let windowTimer: ReturnType<typeof setInterval> | null = null
let probeTimer: ReturnType<typeof setTimeout> | null = null
let clocks: MonitorClocks = defaultClocks
let lastProbeWallAt = 0
let lastProbeMonoAt = 0
let lastWindowWallAt = 0
let lastWindowMonoAt = 0

/**
 * Every synchronous/awaited section currently executing. Periodic tasks that are
 * known event-loop hazards (health monitor, reconciler, git sync) wrap themselves
 * with markCriticalSection() so that when the probe detects a stall we can
 * attribute it instead of guessing.
 *
 * Tracks ALL open sections, not just one. This was a single slot, which caused
 * two concrete misreads:
 *   1. Concurrent sections — only the first was recorded, so a stall during an
 *      overlapping section was blamed on whichever started first. The health
 *      monitor and git sync both run on ~30 s cadences, so they overlap often.
 *   2. Await-heavy sections — the label persists across `await`, so a tick that
 *      merely WAITED (e.g. a 30 s daemon RPC to a dead host) was reported as a
 *      stall even though the loop was free the whole time. That is how an 11 s
 *      "stall" was attributed to health-monitor.check when nothing was blocked.
 *
 * Fix: track every open section, and record CPU time alongside wall time so a
 * reader can tell "burning the loop" from "waiting on I/O".
 */
interface OpenSection {
  name: string
  startedAt: number
  startCpuMs: number
}
const openSections = new Map<number, OpenSection>()
// Monotonic key per section. A stale end() from a sleep-cleared section simply
// deletes a key that's already gone, so it can no longer clobber a NEW section
// (which is what the old shared-slot + token dance had to guard against).
let sectionSeq = 0

function cpuMsNow(): number {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

/**
 * Mark a synchronous/awaited section so a concurrent stall can be attributed
 * to it. Returns a function to call when the section ends (use try/finally).
 *
 *   const end = markCriticalSection('health-monitor.check')
 *   try { ...heavy work... } finally { end() }
 */
export function markCriticalSection(name: string): () => void {
  const token = ++sectionSeq
  openSections.set(token, { name, startedAt: clocks.now(), startCpuMs: cpuMsNow() })
  return () => { openSections.delete(token) }
}

/**
 * Sections open right now, longest-running first, each with the share of its wall
 * time that actually consumed CPU.
 *
 * `section` keeps the existing contract (the longest-running open section is the
 * suspect) so a real block is still attributed. `openSections` is the new part:
 * it exposes wall vs cpu per section, which is what distinguishes "burned the
 * loop" from "waited on a dead host for 30 s" — the two used to be
 * indistinguishable in the logs, and every await-bound tick read as a stall.
 * `awaiting` flags the whole set as wait-dominated so a reader (or
 * scripts/walnut-logs.sh) can discount it without doing the arithmetic.
 */
function describeOpenSections(): {
  section: string | null
  detail: string[]
  awaiting: boolean
} {
  if (openSections.size === 0) return { section: null, detail: [], awaiting: false }
  const now = clocks.now()
  const cpuNow = cpuMsNow()
  const rows = [...openSections.values()]
    .map(s => ({
      name: s.name,
      wallMs: now - s.startedAt,
      cpuMs: Math.max(0, Math.round(cpuNow - s.startCpuMs)),
    }))
    .sort((a, b) => b.wallMs - a.wallMs)
  const top = rows[0]
  return {
    section: top.name,
    detail: rows.map(r => `${r.name} wall=${r.wallMs}ms cpu=${r.cpuMs}ms`),
    // Wall ≫ cpu ⇒ the section was waiting, not holding the loop.
    awaiting: top.wallMs > 0 && top.cpuMs / top.wallMs < 0.5,
  }
}

/**
 * System sleep spans whatever periodic tick happened to be in flight (e.g. a
 * health-monitor check awaiting I/O when the lid closed). Clearing the
 * attribution prevents falsely blaming that section for the "stall".
 */
function clearSectionForSleep(): void {
  // Drop all open sections; their end() closures become no-ops (delete of a
  // missing key), so a tick that spanned the sleep can't be blamed afterwards.
  openSections.clear()
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
    // Metric: every window's worst loop delay — the continuous baseline the
    // stall warnings below are the outliers of. Lets "was the loop healthy at
    // 14:32?" be answered from metrics instead of absence-of-warnings.
    observe('eventloop.delay.max', Math.round(maxMs))
    if (maxMs >= STALL_THRESHOLD_MS) {
      const payload = {
        windowMs: WINDOW_MS,
        maxMs: Math.round(maxMs),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        // suspectSection names only a section whose CPU time dominates its wall
        // time — i.e. one that really held the loop. openSections lists them all
        // (with wall vs cpu) so an await-bound tick isn't mistaken for a stall.
        ...(() => {
          const { section, detail, awaiting } = describeOpenSections()
          return { suspectSection: section, openSections: detail, sectionAwaiting: awaiting }
        })(),
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
            log.web.warn('event-loop stall detected (histogram)', payload)
          }
        })
      } else {
        log.web.warn('event-loop stall detected (histogram)', payload)
      }
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
      // Metric: probe lateness every tick (usually ~0ms). The p99 of this series
      // IS the user-felt scheduling delay for any queued request.
      observe('eventloop.probe.late', Math.max(0, Math.round(lateBy)))
      if (lateBy >= STALL_THRESHOLD_MS) {
        const { section, detail, awaiting } = describeOpenSections()
        const payload = {
          lateByMs: Math.round(lateBy),
          suspectSection: section,
          openSections: detail,
          sectionAwaiting: awaiting,
        }
        // Same Apple Silicon caveat as the histogram: hrtime advances through
        // sleep there, so the wall-vs-mono branch above never triggers and a
        // lid-close shows up here as a minutes-long "block". Verify against
        // kern.waketime before reporting a giant one.
        if (lateBy >= 60_000) {
          wakeTimeChangedSince((slept) => {
            if (slept) {
              log.web.info('system sleep detected via kern.waketime (probe lateness dropped)', { lateByMs: payload.lateByMs })
              clearSectionForSleep()
            } else {
              log.web.warn('event-loop blocked (probe late)', payload)
            }
          })
        } else {
          log.web.warn('event-loop blocked (probe late)', payload)
        }
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
  openSections.clear()
  clocks = defaultClocks
}
