/**
 * When this machine was asleep, and when no server of this Walnut ran, so a
 * wall-clock wait can leave that time out.
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
 * 2026-11-21, the send.resume alarm at 1,633 s and 1,238 s: two messages were
 * queued in dark wakes at 07:33 and 07:40 UTC, a deploy stopped the server in
 * the next dark wake, and the new server only started when the lid opened at
 * 08:00. The new process knew nothing of the sleep the old one saw, nor of the
 * twenty minutes no server ran, so the whole wait read as the resume path's.
 * Two rules close that, the way host-link-ledger.ts keeps a link's outages:
 *
 *  - The sleep intervals are kept on disk (cache/, never synced) and read back
 *    at boot (loadSleepLedger, by the server only, once it holds the instance
 *    lock: a CLI running sessions would read as a second server).
 *  - A running server stamps the time every ALIVE_STAMP_MS in a small file of
 *    its own. At boot, from the last stamp of the server before to this
 *    process's start no server ran: that is a server-down interval
 *    (serverDownIntervals). No queued row could be delivered in it, asleep or
 *    awake; the restart and its cause are not the delivery path's.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

export const SLEEP_GAP_MS = 5_000
/** The most intervals kept: a laptop sleeps and dark-wakes a few hundred times a day. */
export const SLEEP_LEDGER_MAX = 2_000
/** Intervals older than this are dropped from disk: a queued row is parked after a week. */
export const SLEEP_LEDGER_KEEP_MS = 7 * 24 * 60 * 60_000
/** How often a running server stamps that it is alive. */
export const ALIVE_STAMP_MS = 10_000

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
/** When this process started, as far as this module can tell: its first look. */
let bootWall = clocks.now()
let lastWall = bootWall
let lastMono = clocks.monoNow()
let intervals: Slept[] = []
let downIntervals: Slept[] = []

/** The files the ledger is kept in, once loadSleepLedger named them. */
let files: { ledger: string; alive: string } | null = null
let saving: Promise<void> = Promise.resolve()
let ledgerSaveQueued = false
let lastAliveStampAt = 0
/** Told once per process when a write fails: a stamp that stops moving reads as a server down at the next boot. */
let onWriteError: ((error: string) => void) | null = null
let writeErrorTold = false

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
    scheduleLedgerSave()
  }
  lastWall = wall
  lastMono = mono
  if (files && wall - lastAliveStampAt >= ALIVE_STAMP_MS) {
    lastAliveStampAt = wall
    const file = files.alive
    const body = JSON.stringify({ v: 1, aliveAt: wall, pid: process.pid })
    saving = saving.then(() => writeFileAtomic(file, body))
  }
}

function clipTo(list: Slept[], from: number, to: number): Slept[] {
  const out: Slept[] = []
  for (const s of list) {
    const a = Math.max(from, s.start)
    const b = Math.min(to, s.end)
    if (b > a) out.push({ start: a, end: b })
  }
  return out
}

/** The parts of `[from, to]` (wall clock) this machine spent asleep, as far as this Walnut saw. */
export function sleepIntervals(from: number, to: number): Slept[] {
  noteSleepSinceLastLook()
  if (!(to > from)) return []
  return clipTo(intervals, from, to)
}

/** Milliseconds of `[from, to]` (wall clock) this machine spent asleep, as far as this Walnut saw. */
export function sleptBetween(from: number, to: number): number {
  let total = 0
  for (const s of sleepIntervals(from, to)) total += s.end - s.start
  return Math.min(total, Math.max(0, to - from))
}

/** The parts of `[from, to]` (wall clock) no server of this Walnut ran (between one server's last stamp and the next one's start). */
export function serverDownIntervals(from: number, to: number): Slept[] {
  if (!(to > from)) return []
  return clipTo(downIntervals, from, to)
}

interface LedgerFile { v: 1; slept?: Slept[]; down?: Slept[] }

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function readIntervals(list: unknown, now: number): Slept[] {
  const out: Slept[] = []
  for (const s of Array.isArray(list) ? list : []) {
    if (valid(s?.start) && valid(s?.end) && s.end > s.start && s.start <= now) out.push({ start: s.start, end: Math.min(s.end, now) })
  }
  return out
}

/** Sorted, the overlaps of the same kind kept once, at most SLEEP_LEDGER_MAX. */
function merged(list: Slept[]): Slept[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Slept[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out.length > SLEEP_LEDGER_MAX ? out.slice(-SLEEP_LEDGER_MAX) : out
}

/**
 * Boot: read what earlier servers saw and keep the ledger on disk from now on. The time from
 * the last server's last alive stamp to this process's start is recorded as server down.
 * Never throws.
 */
export async function loadSleepLedger(
  named?: { ledger: string; alive: string },
  opts: { onWriteError?: (error: string) => void } = {},
): Promise<void> {
  onWriteError = opts.onWriteError ?? null
  let f = named
  if (!f) {
    // A test's constants mock may not name them: then the ledger stays in memory, as before.
    try {
      const c = await import('../constants.js')
      if (c.SLEEP_LEDGER_FILE && c.SERVER_ALIVE_FILE) f = { ledger: c.SLEEP_LEDGER_FILE, alive: c.SERVER_ALIVE_FILE }
    } catch { /* none */ }
    if (!f) return
  }
  const now = clocks.now()
  let data: LedgerFile | null = null
  let aliveAt: number | null = null
  try { data = JSON.parse(await fsp.readFile(f.ledger, 'utf8')) as LedgerFile } catch { /* none yet, or unreadable */ }
  try {
    const a = JSON.parse(await fsp.readFile(f.alive, 'utf8')) as { aliveAt?: unknown }
    if (valid(a?.aliveAt)) aliveAt = a.aliveAt
  } catch { /* the first server here, or unreadable */ }
  intervals = merged([...readIntervals(data?.slept, now), ...intervals])
  const down = readIntervals(data?.down, now)
  // A stamp at or after this start is a server that ran beside this one: nothing was down.
  if (aliveAt !== null && aliveAt < bootWall) down.push({ start: aliveAt, end: bootWall })
  downIntervals = merged([...down, ...downIntervals])
  files = f
  lastAliveStampAt = 0
  scheduleLedgerSave()
  noteSleepSinceLastLook()
}

function scheduleLedgerSave(): void {
  if (!files || ledgerSaveQueued) return
  ledgerSaveQueued = true
  void flushSleepLedger()
}

/** Write the intervals (after each one, and tests); settles after the alive stamps queued before it too. Never throws. */
export function flushSleepLedger(): Promise<void> {
  const f = files
  if (!f) return saving
  saving = saving.then(async () => {
    ledgerSaveQueued = false
    const at = clocks.now()
    const keep = (list: Slept[]) => list.filter((s) => at - s.end < SLEEP_LEDGER_KEEP_MS)
    await writeFileAtomic(f.ledger, JSON.stringify({ v: 1, slept: keep(intervals), down: keep(downIntervals) } satisfies LedgerFile))
  })
  return saving
}

async function writeFileAtomic(file: string, body: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    if (onWriteError && !writeErrorTold) {
      writeErrorTold = true
      try { onWriteError(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`) } catch { /* never throws */ }
    }
  }
}

/** Tests: drive the ledger with fake clocks (null puts the real ones back), forget every interval and stop keeping files. */
export function __resetSleepLedgerForTest(fake: SleepClocks | null = null): void {
  clocks = fake ?? realClocks
  bootWall = clocks.now()
  lastWall = bootWall
  lastMono = clocks.monoNow()
  intervals = []
  downIntervals = []
  files = null
  ledgerSaveQueued = false
  lastAliveStampAt = 0
  onWriteError = null
  writeErrorTold = false
  saving = Promise.resolve()
}
