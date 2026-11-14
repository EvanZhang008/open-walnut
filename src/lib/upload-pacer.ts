/**
 * A token bucket for the bytes one connection sends up (2026-11-12, measured on a relay on
 * the SSH path to a dev host): uploads paced at 20 to 30 KB/s lived through 90 s runs
 * 6 times in 7, uploads at 50 KB/s or more were ended within seconds 8 times in 9,
 * and an idle connection beside a cut one lived on. So a link that keeps its own
 * upload slow stays up; one that bursts megabytes is ended, with every stream on it.
 * The pace is learned per host (lib/adaptive-pace.ts): null limits let bytes go at once.
 *
 * `take(n)` resolves when n bytes may go: at once while the bucket holds them, else
 * in order behind the bytes already waiting. A take bigger than the bucket waits
 * for a full bucket and then goes (the bucket runs negative, so the long-run rate
 * still holds). `setLimits()` changes the pace of a running pacer, waiting takes
 * included. `drop()` fails every waiting take: the connection is gone.
 */

import type { PaceLimits } from './adaptive-pace.js'

export interface UploadPacer {
  take(bytes: number): Promise<void>
  /** Bytes taken but not yet allowed out. */
  readonly queuedBytes: number
  /** Bytes sent through this pacer so far (taken and allowed). */
  readonly sentBytes: number
  /** When the last byte was allowed out (its clock), or null: none yet. */
  readonly lastSentAt: number | null
  /** The pace now, or null: unpaced. */
  readonly limits: PaceLimits | null
  /** Bytes per second allowed out over the last few seconds (at least one second counted). */
  recentBytesPerSec(): number
  setLimits(limits: PaceLimits | null): void
  drop(reason: string): void
}

export interface UploadPacerOptions {
  /** null: unpaced (bytes go at once, still counted). */
  bytesPerSec: number | null
  burstBytes?: number
  now?: () => number
  /** Timers, replaceable in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** Called with the ms bytes waited behind the pace since the last call (demand: adaptive-pace.ts). */
  onDemand?: (ms: number) => void
}

interface Waiter { bytes: number; resolve: () => void; reject: (err: Error) => void }

/** The window recentBytesPerSec reads, and its buckets. */
const RECENT_MS = 5_000
const BUCKET_MS = 250

export function createUploadPacer(opts: UploadPacerOptions): UploadPacer {
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t })
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let limits: PaceLimits | null = opts.bytesPerSec === null ? null : { bytesPerSec: opts.bytesPerSec, burstBytes: opts.burstBytes ?? opts.bytesPerSec }
  let rate = limits ? limits.bytesPerSec / 1000 : Infinity
  let burst = limits ? limits.burstBytes : Infinity
  let tokens = burst
  const createdAt = now()
  let at = createdAt
  let queued = 0
  let sent = 0
  let lastSentAt: number | null = null
  let timer: unknown = null
  let busySince: number | null = null
  /** A drain is running: setLimits from inside it (a probe its demand report set off) only marks it. */
  let draining = false
  let relimited = false
  const waiting: Waiter[] = []
  const recent: Array<{ t: number; n: number }> = []

  const prune = (t: number) => { while (recent.length > 0 && t - recent[0].t >= RECENT_MS) recent.shift() }
  const refill = () => {
    const t = now()
    if (limits) tokens = Math.min(burst, tokens + (t - at) * rate)
    at = t
  }
  const need = (bytes: number) => Math.min(bytes, burst)
  const pass = (w: Waiter) => {
    const t = now()
    if (limits) tokens -= w.bytes
    sent += w.bytes
    lastSentAt = t
    const last = recent[recent.length - 1]
    if (last && t - last.t < BUCKET_MS) last.n += w.bytes
    else { recent.push({ t, n: w.bytes }); prune(t) }
    w.resolve()
  }
  const demand = () => {
    if (busySince === null) return
    const t = now()
    const ms = t - busySince
    // Moved before the report: a report that changes the pace must not count this stretch twice.
    busySince = waiting.length > 0 ? t : null
    if (ms > 0) opts.onDemand?.(ms)
  }
  const passReady = () => {
    while (waiting.length > 0 && (!limits || tokens >= need(waiting[0].bytes))) {
      const w = waiting.shift()!
      queued -= w.bytes
      pass(w)
    }
  }
  const drain = () => {
    timer = null
    draining = true
    try {
      refill()
      passReady()
      relimited = false
      demand()
      // The report changed the pace: what may go at the new one goes now.
      if (relimited) { refill(); passReady() }
    } finally { draining = false }
    if (waiting.length > 0) {
      const ms = Math.max(1, Math.ceil((need(waiting[0].bytes) - tokens) / rate))
      timer = setTimer(drain, ms)
    }
  }

  return {
    take(bytes: number): Promise<void> {
      const n = Math.max(0, Math.floor(bytes))
      return new Promise<void>((resolve, reject) => {
        const w = { bytes: n, resolve, reject }
        if (waiting.length === 0) {
          refill()
          if (!limits || tokens >= need(n)) { pass(w); return }
          busySince = now()
        }
        waiting.push(w)
        queued += n
        if (timer === null) drain()
      })
    },
    get queuedBytes() { return queued },
    get sentBytes() { return sent },
    get lastSentAt() { return lastSentAt },
    get limits() { return limits },
    recentBytesPerSec(): number {
      const t = now()
      prune(t)
      let n = 0
      for (const b of recent) n += b.n
      const span = Math.min(RECENT_MS, Math.max(1_000, t - createdAt))
      return (n * 1000) / span
    },
    setLimits(next: PaceLimits | null): void {
      refill()
      limits = next
      rate = next ? next.bytesPerSec / 1000 : Infinity
      burst = next ? next.burstBytes : Infinity
      // A bucket never holds more than its new size; one that was unpaced starts full.
      tokens = next ? Math.min(burst, Number.isFinite(tokens) ? tokens : burst) : Infinity
      // Inside a drain: that drain goes on at the new pace and sets the one next timer.
      if (draining) { relimited = true; return }
      if (timer !== null) { clearTimer(timer); timer = null }
      if (waiting.length > 0) drain()
    },
    drop(reason: string): void {
      if (timer !== null) { clearTimer(timer); timer = null }
      demand()
      busySince = null
      const err = new Error(reason)
      for (const w of waiting.splice(0)) w.reject(err)
      queued = 0
    },
  }
}
