/**
 * Critical sections: the names a stall report (event-loop-monitor.ts) blames.
 *
 * Periodic tasks that are known event-loop hazards (health monitor, change watch, git sync) wrap
 * themselves with markCriticalSection() (runPeriodic does it for every periodic task), so a stall
 * is attributed instead of guessed.
 *
 * Every open section is tracked, not one slot: overlapping sections (the health monitor and git
 * sync both run on ~30 s cadences) used to blame whichever started first. Each section's
 * `loopCpu` is the LOOP THREAD's CPU (process.threadCpuUsage) while the section was open, not the
 * process's: Bun's other threads (GC helpers, the HTTP and SQLite workers) ran up "cpu" for a
 * section that only waited (2026-11-23: change-watch was "not awaiting" in 182 of 426 stalls
 * while its median section was open 10 s waiting on reads).
 *
 * It is still not the section's OWN CPU: everything else the loop ran while the section was open
 * counts too, so a section that awaits for 14 s on a loop busy half the time shows 7 s. Read it
 * as "how busy the loop was meanwhile"; what used the CPU is in the stall profiles
 * (stall-recorder.ts). 2026-11-25: the field was named `cpu`, and a pass read change-watch's
 * 4.7 s per run as its own work; the kept profiles of the same windows held about 10 ms of
 * change-watch code per run (and about 40 ms of git-pull-walnut's).
 *
 * Two things a stall report could not say before (2026-11-23: 650 of 1,207 stalls named nothing):
 *  - a section that opened and CLOSED inside the 5 s window: kept in a small ring of the last
 *    closed ones, reported as `closedSections`;
 *  - the server's own boot: no section is open while startServer and its deferred jobs run, and
 *    a third of the day's stall-seconds fell in the first 90 s after one of 75 restarts. With no
 *    section open in the first BOOT_SECTION_MS, the suspect is `boot`.
 */

import { readLoopCpuUs } from './stall-recorder-hold.js'

/** A stall this soon after the monitor started, with no section open, is blamed on the boot. */
export const BOOT_SECTION_MS = 120_000
export const BOOT_SECTION = 'boot'
const CLOSED_RING = 16

interface OpenSection { name: string; startedAt: number; startCpuMs: number }
interface ClosedSection { name: string; startedAt: number; endedAt: number; cpuMs: number }

const openSections = new Map<number, OpenSection>()
// Monotonic key per section: a stale end() from a sleep-cleared section deletes a key that is
// already gone, so it can never clobber a NEW section.
let sectionSeq = 0
const closed: Array<ClosedSection | undefined> = new Array(CLOSED_RING)
let closedNext = 0
let nowFn: () => number = () => Date.now()
/** When the monitor started (nowFn time), or null when it is not running. */
let startedAt: number | null = null

function cpuMsNow(): number {
  return readLoopCpuUs() / 1000
}

/** The monitor's clock and start (event-loop-monitor.ts); null stops the boot attribution. */
export function setSectionClock(now: () => number, monitorStartedAt: number | null): void {
  nowFn = now
  startedAt = monitorStartedAt
}

/** Seconds since the monitor started, or null when it is not running. */
export function sinceStartS(): number | null {
  return startedAt === null ? null : Math.round((nowFn() - startedAt) / 1000)
}

/**
 * Mark a synchronous/awaited section so a concurrent stall can be attributed to it. Returns a
 * function to call when the section ends (use try/finally).
 *
 *   const end = markCriticalSection('health-monitor.check')
 *   try { ...heavy work... } finally { end() }
 */
export function markCriticalSection(name: string): () => void {
  const token = ++sectionSeq
  openSections.set(token, { name, startedAt: nowFn(), startCpuMs: cpuMsNow() })
  return () => {
    const s = openSections.get(token)
    if (!s) return
    openSections.delete(token)
    closed[closedNext] = { name: s.name, startedAt: s.startedAt, endedAt: nowFn(), cpuMs: Math.max(0, cpuMsNow() - s.startCpuMs) }
    closedNext = (closedNext + 1) % CLOSED_RING
  }
}

const fmt = (name: string, wallMs: number, cpuMs: number): string => `${name} wall=${Math.round(wallMs)}ms loopCpu=${Math.round(cpuMs)}ms`

/**
 * Sections open right now, longest-running first, each with the loop thread's CPU since it began.
 * `section` is the suspect: the longest-running open section; with none open in the boot window,
 * `boot`. `awaiting` flags the suspect as wait-dominated (the loop's CPU under half its wall time),
 * so a reader (or scripts/walnut-logs.sh) can discount it; false does not prove the suspect did
 * the work, only that the loop was busy while it was open.
 */
export function describeOpenSections(): { section: string | null; detail: string[]; awaiting: boolean } {
  const now = nowFn()
  if (openSections.size === 0) {
    const boot = startedAt !== null && now - startedAt < BOOT_SECTION_MS
    return { section: boot ? BOOT_SECTION : null, detail: [], awaiting: false }
  }
  const cpuNow = cpuMsNow()
  const rows = [...openSections.values()]
    .map((s) => ({ name: s.name, wallMs: now - s.startedAt, cpuMs: Math.max(0, cpuNow - s.startCpuMs) }))
    .sort((a, b) => b.wallMs - a.wallMs)
  const top = rows[0]
  return {
    section: top.name,
    detail: rows.map((r) => fmt(r.name, r.wallMs, r.cpuMs)),
    awaiting: top.wallMs > 0 && top.cpuMs / top.wallMs < 0.5,
  }
}

/** Sections that ended at or after `since` (nowFn time), the most recent first. */
export function closedSectionsSince(since: number): string[] {
  return closed
    .filter((c): c is ClosedSection => !!c && c.endedAt >= since)
    .sort((a, b) => b.endedAt - a.endedAt)
    .map((c) => fmt(c.name, c.endedAt - c.startedAt, c.cpuMs))
}

/**
 * System sleep spans whatever periodic tick happened to be in flight (a health check awaiting I/O
 * when the lid closed): drop every open section so the tick that spanned the sleep is never blamed.
 * Their end() closures become no-ops.
 */
export function clearSectionsForSleep(): void {
  openSections.clear()
}

/** The monitor stopped: forget everything. */
export function resetSections(): void {
  openSections.clear()
  closed.fill(undefined)
  closedNext = 0
  startedAt = null
  nowFn = () => Date.now()
}
