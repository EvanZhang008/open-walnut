/**
 * Paced uplink for the daemon's cloud bridge socket. Pure factories, shared by
 * both daemon twins: daemon-standalone.ts imports them, daemon-source.ts inlines
 * their text (fn.toString()), so NOTHING here may reference module scope,
 * imports, or helpers. Globals (Buffer, Math, JSON, Date) are fine.
 *
 * Why (Mac uplink, 2026-09-25/26): bridge flaps clustered within a second of the
 * primary's 5-minute projection self-heal, which wrote ~1.7MB of mobile-event
 * frames (one 1.5MB task list among them) into the socket in one go. The client
 * WebSocket takes every send() at once and reports nothing back: on the Bun
 * binary its `bufferedAmount` reads 0 even while megabytes wait in the kernel,
 * so the adapter could never see that it was flooding the link.
 *
 * The rule here: never have more than `hwmBytes` on the wire that the replica
 * has not confirmed. Confirmation rides the existing keepalive: every
 * `bridge-ping` frame is a MARKER carrying a sequence number, and the replica
 * answers each one with a `ping` RPC echoing it (`ackSeq`). Frames are handled
 * in order on both ends, so an echoed marker confirms every byte written before
 * it. A replica that predates `ackSeq` still answers each marker with a plain
 * `ping`, in order, so the oldest outstanding marker is the one it confirms.
 * A marker nobody confirms within `ackTimeoutMs` releases the window (fail
 * open): a dead link is the silence watchdog's job, not a reason to wedge.
 *
 * On a busy link the marker answers are the only frames the daemon hears, and
 * its silence watchdog tears a link down 45 to 50 s after the last one
 * (BRIDGE_WATCHDOG in daemon-core.ts). So a marker follows every
 * `markerEveryBytes` (64 KB): at least one per chunk, since markers only go
 * between frames. At 256 KB a marker followed every second chunk (an envelope
 * is a little under 256 KB), about 508 KB apart, and a link slower than about
 * 11 KB/s was torn down mid-transfer and never finished one (gate 2026-10-04:
 * a 2 MB reply at 8 KB/s, 8 drops in 420 s). Now a link stays up down to about
 * 6 KB/s, one chunk per watchdog window.
 *
 * Frames larger than the chunk size are split into `{ev:'chunk'}` envelopes,
 * but only after the replica has said it can reassemble them (`bridge.peer`).
 */

export interface BridgeUplinkDeps {
  /** Write one frame to the socket. Throws when the socket is gone. */
  write: (frame: string) => void
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  /** The queue passed maxQueueBytes: the caller closes the socket. */
  onOverflow: (queuedBytes: number) => void
}

export interface BridgeUplinkOptions {
  hwmBytes?: number
  markerEveryBytes?: number
  ackTimeoutMs?: number
  maxQueueBytes?: number
}

export function createBridgeUplink(deps: BridgeUplinkDeps, opts?: BridgeUplinkOptions) {
  const HWM = (opts && opts.hwmBytes) || 1024 * 1024
  const MARKER_EVERY = (opts && opts.markerEveryBytes) || 64 * 1024
  const ACK_TIMEOUT_MS = (opts && opts.ackTimeoutMs) || 15_000
  const MAX_QUEUE = (opts && opts.maxQueueBytes) || 64 * 1024 * 1024
  const CHUNK_MIN = 16 * 1024
  const CHUNK_MAX = 512 * 1024
  // Room kept for the marker that follows a frame, so markers never push the
  // unconfirmed total past the high-water mark either.
  const MARKER_ROOM = 128

  const byteLen = (s: string): number =>
    (typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : s.length)
  const kindOf = (frame: string): string => {
    const head = frame.slice(0, 80)
    const i = head.indexOf('"ev":"')
    if (i >= 0) {
      const j = head.indexOf('"', i + 6)
      if (j > i + 6) return head.slice(i + 6, j)
    }
    return head.indexOf('"id":') >= 0 ? 'reply' : 'other'
  }

  let queue: Array<{ frame: string; size: number }> = []
  let queuedBytes = 0
  let sentBytes = 0
  let ackedBytes = 0
  let sinceMarker = 0
  let markerSeq = 0
  let markers: Array<{ seq: number; covers: number; sentAt: number }> = []
  let ackTimer: unknown = null
  let chunkBytes = 0
  let chunkSeq = 0
  let closed = false
  const rtts: number[] = []
  const stats = {
    framesOut: 0, bytesOut: 0, framesIn: 0, bytesIn: 0,
    maxOutFrameBytes: 0, maxOutFrameKind: '', inFlightPeak: 0,
    queuedPeak: 0, chunkedFrames: 0, ackTimeouts: 0, lastInboundAt: 0,
  }

  const inFlight = (): number => sentBytes - ackedBytes
  const fits = (size: number): boolean => inFlight() === 0 || inFlight() + size + MARKER_ROOM <= HWM

  const writeFrame = (frame: string, size: number): boolean => {
    try { deps.write(frame) } catch { return false }
    sentBytes += size
    sinceMarker += size
    stats.framesOut++
    stats.bytesOut += size
    if (size > stats.maxOutFrameBytes) { stats.maxOutFrameBytes = size; stats.maxOutFrameKind = kindOf(frame) }
    if (inFlight() > stats.inFlightPeak) stats.inFlightPeak = inFlight()
    return true
  }

  const armAckTimer = (): void => {
    if (ackTimer || markers.length === 0) return
    const oldest = markers[0]
    const wait = Math.max(0, oldest.sentAt + ACK_TIMEOUT_MS - deps.now())
    ackTimer = deps.setTimer(() => {
      ackTimer = null
      if (closed || markers.length === 0) return
      if (deps.now() - markers[0].sentAt >= ACK_TIMEOUT_MS) {
        stats.ackTimeouts++
        ackedBytes = sentBytes
        markers = []
        pump()
      }
      armAckTimer()
    }, wait)
  }

  /** Write a marker now. It covers everything written before it. */
  const sendMarker = (): number => {
    const seq = ++markerSeq
    const frame = JSON.stringify({ ev: 'bridge-ping', ts: deps.now(), seq })
    const size = byteLen(frame)
    if (!writeFrame(frame, size)) return seq
    // The marker's own bytes are part of what its echo confirms.
    markers.push({ seq, covers: sentBytes, sentAt: deps.now() })
    sinceMarker = 0
    armAckTimer()
    return seq
  }

  const pump = (): void => {
    while (!closed && queue.length > 0) {
      const next = queue[0]
      // One oversized frame may go alone, onto an otherwise empty wire.
      if (!fits(next.size)) break
      queue.shift()
      queuedBytes -= next.size
      if (!writeFrame(next.frame, next.size)) { closed = true; queue = []; queuedBytes = 0; return }
      if (sinceMarker >= MARKER_EVERY) sendMarker()
    }
    // Blocked with unconfirmed bytes nobody asked about: ask, or it never frees.
    if (!closed && queue.length > 0 && sinceMarker > 0) sendMarker()
  }

  const split = (frame: string, size: number): string[] => {
    if (chunkBytes <= 0 || size <= chunkBytes) return [frame]
    // Parts are cut by characters, and JSON escaping inside the envelope grows
    // them (a quote becomes two bytes), so each cut is checked against the
    // budget and shrunk until its envelope fits. The first pass measures with
    // the widest `n`; the real envelopes can only be as big or smaller.
    const cid = (++chunkSeq).toString(36)
    const envelope = (i: number, n: number, part: string): string =>
      JSON.stringify({ ev: 'chunk', cid, i, n, part })
    const ratio = size / Math.max(1, frame.length)
    let guess = Math.max(1024, Math.floor(chunkBytes / ratio))
    const cuts: Array<[number, number]> = []
    let pos = 0
    while (pos < frame.length) {
      let len = Math.min(guess, frame.length - pos)
      for (;;) {
        const bytes = byteLen(envelope(cuts.length, 999_999, frame.slice(pos, pos + len)))
        if (bytes <= chunkBytes || len <= 256) break
        len = Math.max(256, Math.floor(len * chunkBytes / bytes * 0.97))
      }
      cuts.push([pos, pos + len])
      guess = len
      pos += len
    }
    stats.chunkedFrames++
    return cuts.map(([a, b], i) => envelope(i, cuts.length, frame.slice(a, b)))
  }

  return {
    /** 'sent' = on the wire now, 'queued' = will be, 'dropped' = never will be. */
    send(frame: string): 'sent' | 'queued' | 'dropped' {
      if (closed) return 'dropped'
      const size = byteLen(frame)
      const parts = split(frame, size)
      const direct = queue.length === 0
      let wroteAll = direct
      for (const part of parts) {
        const partSize = parts.length === 1 ? size : byteLen(part)
        if (direct && wroteAll && fits(partSize)) {
          if (!writeFrame(part, partSize)) { closed = true; queue = []; queuedBytes = 0; return 'dropped' }
          if (sinceMarker >= MARKER_EVERY) sendMarker()
          continue
        }
        wroteAll = false
        queue.push({ frame: part, size: partSize })
        queuedBytes += partSize
      }
      if (queuedBytes > stats.queuedPeak) stats.queuedPeak = queuedBytes
      if (queuedBytes > MAX_QUEUE) {
        const q = queuedBytes
        closed = true
        queue = []
        queuedBytes = 0
        deps.onOverflow(q)
        return 'dropped'
      }
      if (!wroteAll) pump()
      return wroteAll ? 'sent' : 'queued'
    },
    /** The keepalive tick: a marker that also carries the ping's meaning. */
    ping(): number { return closed ? 0 : sendMarker() },
    /** A `ping` RPC from the replica: `ackSeq` when it echoes, else in order. */
    ack(ackSeq?: unknown): void {
      if (closed || markers.length === 0) return
      let hit: { seq: number; covers: number; sentAt: number } | undefined
      if (typeof ackSeq === 'number') {
        while (markers.length > 0 && markers[0].seq <= ackSeq) hit = markers.shift()
      } else {
        hit = markers.shift()
      }
      if (!hit) return
      rtts.push(deps.now() - hit.sentAt)
      if (rtts.length > 128) rtts.shift()
      if (hit.covers > ackedBytes) ackedBytes = hit.covers
      if (ackTimer) { deps.clearTimer(ackTimer); ackTimer = null }
      armAckTimer()
      pump()
    },
    noteInbound(bytes: number): void {
      stats.framesIn++
      stats.bytesIn += bytes
      stats.lastInboundAt = deps.now()
    },
    /** The replica can reassemble chunks up to this size (0 turns chunking off). */
    setChunkBytes(n: unknown): number {
      const v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : 0
      chunkBytes = v <= 0 ? 0 : Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, v))
      return chunkBytes
    },
    close(): void {
      closed = true
      queue = []
      queuedBytes = 0
      markers = []
      if (ackTimer) { deps.clearTimer(ackTimer); ackTimer = null }
    },
    get queuedBytes(): number { return queuedBytes },
    get inFlightBytes(): number { return inFlight() },
    get chunkBytes(): number { return chunkBytes },
    snapshot() {
      const sorted = rtts.slice().sort((a, b) => a - b)
      return {
        framesOut: stats.framesOut, bytesOut: stats.bytesOut,
        framesIn: stats.framesIn, bytesIn: stats.bytesIn,
        maxOutFrameBytes: stats.maxOutFrameBytes, maxOutFrameKind: stats.maxOutFrameKind || null,
        bufferedAmountPeak: stats.inFlightPeak, bufferedAmountAtClose: inFlight() + queuedBytes,
        queuedPeak: stats.queuedPeak, chunkedFrames: stats.chunkedFrames, ackTimeouts: stats.ackTimeouts,
        lastInboundAt: stats.lastInboundAt,
        rttMsP50: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
        rttMsMax: sorted.length ? sorted[sorted.length - 1] : null,
      }
    },
  }
}

/**
 * Event-loop drift from a fixed-period timer: how late each tick fired. The
 * daemon's own loop stalling is one way a bridge goes silent without the link
 * being at fault; the close log carries the worst lateness near the close.
 */
export function createLoopDriftProbe(deps: {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (timer: unknown) => void
}, periodMs?: number) {
  const PERIOD = periodMs || 500
  let timer: unknown = null
  let last = 0
  let samples: Array<{ at: number; drift: number }> = []
  const maxSince = (ms: number): number => {
    const cutoff = deps.now() - ms
    let m = 0
    for (const s of samples) if (s.at >= cutoff && s.drift > m) m = s.drift
    return m
  }
  return {
    start(): void {
      if (timer) return
      last = deps.now()
      timer = deps.setInterval(() => {
        const t = deps.now()
        samples.push({ at: t, drift: Math.max(0, t - last - PERIOD) })
        last = t
        const cutoff = t - 60_000
        while (samples.length > 0 && samples[0].at < cutoff) samples.shift()
      }, PERIOD)
      const maybe = timer as { unref?: () => void }
      if (maybe && typeof maybe.unref === 'function') maybe.unref()
    },
    stop(): void {
      if (timer) deps.clearInterval(timer)
      timer = null
      samples = []
    },
    max60s(): number { return maxSince(60_000) },
    max5s(): number { return maxSince(5_000) },
  }
}
