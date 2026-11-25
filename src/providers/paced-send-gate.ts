/**
 * What may be written onto the bulk channel's own paced connection, and when (2026-11-25).
 *
 * A host's daemon closes a client it heard no whole frame from for 120 to 135 s (its keepalive,
 * daemon-standalone.ts CLIENT_KEEPALIVE_MISSED), and on a paced connection a frame goes up at the
 * pace: one too big for that (the whole notes manifest, about 1.7 MB, at 13.7 KB/s) was cut every
 * two minutes, all day, and took every answer written behind it (2026-11-25 04:15 to 05:05Z: a
 * session's `walnut` reads of 164 KB never came back from the dev host behind that relay, while
 * 92 KB ones, small enough for the session link, did). Three rules, judged at the pace the
 * connection goes now:
 *
 *   - a frame that alone takes longer than FRAME_ALONE_MAX_SECS to go up is never written: its
 *     sender gets why at once, and nothing else on the connection is cut;
 *   - a relay's answer (`first`) never waits behind frames not written yet: its sender judges
 *     whether it can arrive in time (relayAnswerSecs) and answers a small error when not;
 *   - any other upload is written only once what is still going up ahead of it is a few seconds
 *     of the pace (AHEAD_MAX_SECS), so an answer written later waits behind one frame at most;
 *     it waits in order, as long as the bytes ahead keep moving.
 *
 * tests/providers/paced-send-gate.test.ts holds the rules; tests/providers/daemon-connection-paced-gate.test.ts
 * holds DaemonConnection to them on a real paced forward.
 */
import { UPLOAD_FRAME_MAX_SECS } from './ssh-upload-budget.js'

/** The paced connection as the gate reads it. */
export interface PacedLink {
  /** Bytes written to it that have not gone up yet (its pacer's queue and the socket's buffer). */
  aheadBytes(): number
  /** Its pace now, bytes a second; null when unpaced (the gate lets everything through). */
  bytesPerSec(): number | null
  /** Bytes it let go up so far (monotonic): a waiting frame waits on while this moves. */
  upBytes(): number
}

/**
 * The longest one frame may take alone at the pace: under the host's 120 s keepalive, with room.
 * UPLOAD_FRAME_MAX_SECS (100 s) sized the lowest pace for the bare base64 of one upload part; a
 * part's frame adds its command's fields, so the line here sits a little above it (2026-11-25
 * review: a whole 1 MB part's frame needs 100.003 s at the lowest pace, and must still go).
 */
export const FRAME_ALONE_MAX_SECS = UPLOAD_FRAME_MAX_SECS + 10

/** Uploads wait while more than this many seconds of the pace are still ahead of them. */
export const AHEAD_MAX_SECS = 3
/** How often waiting frames look again. */
export const GATE_TICK_MS = 200

const kb = (n: number) => Math.round(n / 1024)
/** A pace in KB/s, one decimal. */
export const kbps = (n: number) => Math.round(n / 102.4) / 10

/** Seconds `bytes` take to go up at `bytesPerSec`. */
export function upSecs(bytes: number, bytesPerSec: number): number {
  return bytes / Math.max(1, bytesPerSec)
}

/** A frame that alone takes longer than the host keeps a silent client: never written. */
export class PacedFrameTooSlowError extends Error {
  constructor(readonly what: string, readonly host: string, readonly bytes: number, readonly bytesPerSec: number) {
    super(`${what}: a ${kb(bytes)} KB frame takes about ${Math.round(upSecs(bytes, bytesPerSec))} s to go up to ${host} at its paced ${kbps(bytesPerSec)} KB/s, `
      + `longer than the ${FRAME_ALONE_MAX_SECS} s a frame may take here (the host closes a link it heard no whole frame from for 120 s, and every answer on it goes with it). Nothing was sent`)
    this.name = 'PacedFrameTooSlowError'
  }
}

/** A frame that waited its whole time while nothing ahead of it moved: never written. */
export class PacedGateWaitError extends Error {
  constructor(what: string, host: string, waitedMs: number, aheadBytes: number, bytesPerSec: number) {
    super(`${what}: waited ${Math.round(waitedMs / 1000)} s behind ${kb(aheadBytes)} KB still going up to ${host} at ${kbps(bytesPerSec)} KB/s; nothing was sent, try again`)
    this.name = 'PacedGateWaitError'
  }
}

/** Whether a frame of `bytes` may ever go up the link at `bytesPerSec`. */
export function fitsAlone(bytes: number, bytesPerSec: number | null): boolean {
  return bytesPerSec === null || upSecs(bytes, bytesPerSec) <= FRAME_ALONE_MAX_SECS
}

/**
 * Seconds a relay answer of `bytes` written now needs to reach the host, behind what is ahead;
 * null when the link is unpaced (it goes at once).
 */
export function relayAnswerSecs(link: PacedLink, bytes: number): number | null {
  const pace = link.bytesPerSec()
  return pace === null ? null : upSecs(link.aheadBytes() + bytes, pace)
}

/** How late an answer would be: its size, what is ahead of it, the pace, the time it needs and the time left. */
export interface LateAnswer { bytes: number; aheadKB: number; paceKBps: number; needSecs: number; leftSecs: number }

interface Waiter {
  bytes: number
  what: string
  resolve: () => void
  reject: (err: Error) => void
  since: number
  /** When the bytes ahead last moved, and what they read then. */
  movedAt: number
  upMark: number
  stallMs: number
  deadline: number
}

export class PacedSendGate {
  private waiters: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly host: string,
    private readonly link: PacedLink,
    private readonly opts: { aheadMaxSecs?: number; tickMs?: number; now?: () => number } = {},
  ) {}

  private now(): number { return this.opts.now?.() ?? Date.now() }
  private aheadMax(pace: number): number { return pace * (this.opts.aheadMaxSecs ?? AHEAD_MAX_SECS) }

  /** Frames waiting now. */
  get waiting(): number { return this.waiters.length }

  /**
   * May a frame of `bytes` be written now? null: write it now, in this same tick. A promise: write
   * it once that resolves. Throws PacedFrameTooSlowError for one that may never go.
   * `first`: a relay's answer, never behind a waiting frame. `stallMs`: how long it waits while
   * nothing ahead moves; `maxMs`: how long it waits at most.
   */
  admit(bytes: number, o: { what: string; first?: boolean; stallMs: number; maxMs: number }): Promise<void> | null {
    const pace = this.link.bytesPerSec()
    if (pace === null) return null
    if (!fitsAlone(bytes, pace)) throw new PacedFrameTooSlowError(o.what, this.host, bytes, pace)
    if (o.first) return null
    if (this.waiters.length === 0 && this.link.aheadBytes() <= this.aheadMax(pace)) return null
    const now = this.now()
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ bytes, what: o.what, resolve, reject, since: now, movedAt: now, upMark: this.link.upBytes(), stallMs: o.stallMs, deadline: now + o.maxMs })
      this.schedule()
    })
  }

  /** The connection ended: every waiting frame fails with `err` (nothing of them was sent). */
  close(err: Error): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const w of this.waiters.splice(0)) w.reject(err)
  }

  private schedule(): void {
    if (this.timer || this.waiters.length === 0) return
    this.timer = setTimeout(() => { this.timer = null; this.tick() }, this.opts.tickMs ?? GATE_TICK_MS)
    this.timer.unref?.()
  }

  /** Let the head frames go while the bytes ahead are few; fail those that waited too long. */
  tick(): void {
    const pace = this.link.bytesPerSec()
    const now = this.now()
    const up = this.link.upBytes()
    // Written in this pass count as ahead of the next: their sender writes them after this tick.
    let extra = 0
    while (this.waiters.length > 0) {
      const head = this.waiters[0]!
      if (pace === null || this.link.aheadBytes() + extra <= this.aheadMax(pace)) {
        this.waiters.shift()
        extra += head.bytes
        head.resolve()
        continue
      }
      break
    }
    for (const w of [...this.waiters]) {
      if (up !== w.upMark) { w.upMark = up; w.movedAt = now }
      if (now - w.movedAt < w.stallMs && now < w.deadline) continue
      this.waiters = this.waiters.filter((x) => x !== w)
      w.reject(new PacedGateWaitError(w.what, this.host, now - w.since, this.link.aheadBytes(), pace ?? 0))
    }
    this.schedule()
  }
}
