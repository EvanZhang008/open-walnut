/**
 * A token bucket for the bytes one connection sends up (2026-11-12, measured on the
 * SSH relay to a dev host): uploads paced at 20 to 30 KB/s lived through 90 s runs
 * 6 times in 7, uploads at 50 KB/s or more were ended within seconds 8 times in 9,
 * and an idle connection beside a cut one lived on. So a link that keeps its own
 * upload slow stays up; one that bursts megabytes is ended, with every stream on it.
 *
 * `take(n)` resolves when n bytes may go: at once while the bucket holds them, else
 * in order behind the bytes already waiting. A take bigger than the bucket waits
 * for a full bucket and then goes (the bucket runs negative, so the long-run rate
 * still holds). `drop()` fails every waiting take: the connection is gone.
 */

export interface UploadPacer {
  take(bytes: number): Promise<void>
  /** Bytes taken but not yet allowed out. */
  readonly queuedBytes: number
  /** Bytes sent through this pacer so far (taken and allowed). */
  readonly sentBytes: number
  drop(reason: string): void
}

export interface UploadPacerOptions {
  bytesPerSec: number
  burstBytes: number
  now?: () => number
  /** Timers, replaceable in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

interface Waiter { bytes: number; resolve: () => void; reject: (err: Error) => void }

export function createUploadPacer(opts: UploadPacerOptions): UploadPacer {
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t })
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const rate = opts.bytesPerSec / 1000
  const burst = opts.burstBytes
  let tokens = burst
  let at = now()
  let queued = 0
  let sent = 0
  let timer: unknown = null
  const waiting: Waiter[] = []

  const refill = () => {
    const t = now()
    tokens = Math.min(burst, tokens + (t - at) * rate)
    at = t
  }
  const need = (bytes: number) => Math.min(bytes, burst)
  const pass = (w: Waiter) => {
    tokens -= w.bytes
    sent += w.bytes
    w.resolve()
  }
  const drain = () => {
    timer = null
    refill()
    while (waiting.length > 0 && tokens >= need(waiting[0].bytes)) {
      const w = waiting.shift()!
      queued -= w.bytes
      pass(w)
    }
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
          if (tokens >= need(n)) { pass(w); return }
        }
        waiting.push(w)
        queued += n
        if (timer === null) drain()
      })
    },
    get queuedBytes() { return queued },
    get sentBytes() { return sent },
    drop(reason: string): void {
      if (timer !== null) { clearTimer(timer); timer = null }
      const err = new Error(reason)
      for (const w of waiting.splice(0)) w.reject(err)
      queued = 0
    },
  }
}
