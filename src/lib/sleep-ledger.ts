/**
 * When this machine was asleep, so a wall-clock wait can leave that time out.
 *
 * A latency measured as `Date.now() - startedAt` counts system sleep: a Mac
 * that sends a message in a few seconds of dark wake and goes back to sleep
 * for seven minutes reads a seven-minute "slow delivery" (2026-11-10, the
 * send.delivery health alarm: 467 s, of which 421 s were sleep).
 *
 * The monotonic clock (process.hrtime) does not advance while the machine is
 * suspended under Bun on macOS and on Linux, while the wall clock does, so the
 * growth of `wall - mono` between two looks is time spent asleep. Each look
 * that sees it grow by more than SLEEP_GAP_MS records one interval, placed at
 * the end of the span between the looks (the awake part of a span is at most
 * the time between two looks, a second while the event-loop probe runs).
 * Where the monotonic clock counts sleep too (Node on Apple Silicon), nothing
 * is recorded and every wait reads as it did before.
 *
 * Sleep before this process started is unknown, so a wait that began in an
 * earlier process counts it.
 */

export const SLEEP_GAP_MS = 5_000
/** The most intervals kept: a laptop sleeps and dark-wakes a few hundred times a day. */
export const SLEEP_LEDGER_MAX = 2_000

export interface SleepClocks {
  now(): number
  monoNow(): number
}

const realClocks: SleepClocks = {
  now: () => Date.now(),
  monoNow: () => Number(process.hrtime.bigint()) / 1e6,
}

interface Slept { start: number; end: number }

let clocks: SleepClocks = realClocks
let lastWall = clocks.now()
let lastMono = clocks.monoNow()
let intervals: Slept[] = []

/** Look at the clocks now and record a sleep since the last look. Cheap: call it as often as you like. */
export function noteSleepSinceLastLook(): void {
  const wall = clocks.now()
  const mono = clocks.monoNow()
  const slept = (wall - lastWall) - (mono - lastMono)
  if (slept > SLEEP_GAP_MS) {
    const span = Math.max(0, wall - lastWall)
    const ms = Math.min(slept, span)
    intervals.push({ start: wall - ms, end: wall })
    if (intervals.length > SLEEP_LEDGER_MAX) intervals = intervals.slice(-SLEEP_LEDGER_MAX)
  }
  lastWall = wall
  lastMono = mono
}

/** The parts of `[from, to]` (wall clock) this machine spent asleep, as far as this process saw. */
export function sleepIntervals(from: number, to: number): Slept[] {
  noteSleepSinceLastLook()
  if (!(to > from)) return []
  const out: Slept[] = []
  for (const s of intervals) {
    const a = Math.max(from, s.start)
    const b = Math.min(to, s.end)
    if (b > a) out.push({ start: a, end: b })
  }
  return out
}

/** Milliseconds of `[from, to]` (wall clock) this machine spent asleep, as far as this process saw. */
export function sleptBetween(from: number, to: number): number {
  let total = 0
  for (const s of sleepIntervals(from, to)) total += s.end - s.start
  return Math.min(total, Math.max(0, to - from))
}

/** Tests: drive the ledger with fake clocks (null puts the real ones back) and forget every interval. */
export function __resetSleepLedgerForTest(fake: SleepClocks | null = null): void {
  clocks = fake ?? realClocks
  lastWall = clocks.now()
  lastMono = clocks.monoNow()
  intervals = []
}
