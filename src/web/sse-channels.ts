import type { Request, Response } from 'express'

// ─── Generic SSE channel: per-key ring buffer + replay ─────────────────────
//
// Extracted from the api-v1 conversation stream so session streams (and any
// future SSE surface) share one implementation: process-global monotonic seq,
// ring-capped replay window, Last-Event-ID replay, periodic comment pings,
// explicit flush past the compression middleware.

interface SseEvent { seq: number; event: string; data: unknown }
interface SseConn { res: Response; ping: NodeJS.Timeout }
interface Channel { events: SseEvent[]; conns: Set<SseConn>; lastActiveAt: number }

/** Ring cap per channel — a turn rarely exceeds a few hundred events. */
const RING_MAX = 512
const PING_INTERVAL_MS = 25_000
/** Drop a channel's replay window after this long with no subscribers AND no
 *  emits. Long enough for a page reload / brief tunnel blip to still replay;
 *  without it every session/conversation key ever streamed keeps up to 512
 *  events (unbounded bytes) for the life of the process. */
const IDLE_CHANNEL_TTL_MS = 10 * 60_000
const SWEEP_INTERVAL_MS = 60_000

const channels = new Map<string, Channel>()
// PROCESS-GLOBAL, not per-channel: the idle sweeper deletes and re-creates
// channels, and a per-channel counter restarting at 0 would collide with the
// browser's held Last-Event-ID — the reconnect would silently filter out every
// new event as "already seen". Global seq means a rebuilt channel's ids are
// always larger than anything a client has.
let nextSeq = 0

let sweepTimer: NodeJS.Timeout | null = null
function ensureSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_CHANNEL_TTL_MS
    for (const [key, ch] of channels) {
      if (ch.conns.size === 0 && ch.lastActiveAt < cutoff) channels.delete(key)
    }
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

function getChannel(key: string): Channel {
  let ch = channels.get(key)
  if (!ch) {
    ch = { events: [], conns: new Set(), lastActiveAt: Date.now() }
    channels.set(key, ch)
    ensureSweeper()
  } else {
    ch.lastActiveAt = Date.now()
  }
  return ch
}

function writeSseEvent(res: Response, ev: SseEvent): void {
  res.write(`id: ${ev.seq}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
  // compression() buffers responses — flush after every event or SSE stalls.
  ;(res as Response & { flush?: () => void }).flush?.()
}

/**
 * Emit an event into the channel's ring buffer + all live SSE conns.
 * `reset: true` starts a fresh replay window (turn boundary) — seq stays
 * monotonic across resets so a stale Last-Event-ID never replays old events.
 */
export function emitSse(key: string, event: string, data: unknown, opts?: { reset?: boolean }): void {
  const ch = getChannel(key)
  if (opts?.reset) ch.events = []
  const ev: SseEvent = { seq: nextSeq++, event, data }
  ch.events.push(ev)
  if (ch.events.length > RING_MAX) ch.events.splice(0, ch.events.length - RING_MAX)
  for (const conn of ch.conns) {
    try { writeSseEvent(conn.res, ev) } catch { /* dead conn — close handler cleans up */ }
  }
}

/** Number of live SSE connections on a channel (interest-set bookkeeping). */
export function sseConnCount(key: string): number {
  return channels.get(key)?.conns.size ?? 0
}

/**
 * Attach an HTTP response as an SSE subscriber: writes headers, replays the
 * current window (after Last-Event-ID when provided), starts pings, and
 * cleans up on close. Caller does auth/existence checks BEFORE calling.
 *
 * `onAttach(write)` runs after headers but before replay — for one-off
 * per-connection events (e.g. a snapshot). Events written this way carry no
 * SSE id, so they never disturb Last-Event-ID replay bookkeeping.
 */
export function attachSse(
  key: string,
  req: Request,
  res: Response,
  opts?: { onClose?: () => void; onAttach?: (write: (event: string, data: unknown) => void) => void },
): void {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  // no-transform keeps proxies AND the compression middleware from buffering.
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  res.write(': connected\n\n')
  ;(res as Response & { flush?: () => void }).flush?.()

  const ch = getChannel(key)

  opts?.onAttach?.((event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    ;(res as Response & { flush?: () => void }).flush?.()
  })

  // Replay: with Last-Event-ID → events after it; without → the whole
  // current-turn window (late joiners see the in-flight turn from the top).
  const lastIdRaw = req.header('Last-Event-ID')
    ?? (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined)
  const lastSeq = lastIdRaw != null && lastIdRaw !== '' ? Number(lastIdRaw) : null
  for (const ev of ch.events) {
    if (lastSeq != null && Number.isFinite(lastSeq) && ev.seq <= lastSeq) continue
    writeSseEvent(res, ev)
  }

  const conn: SseConn = {
    res,
    ping: setInterval(() => {
      try {
        res.write(': ping\n\n')
        ;(res as Response & { flush?: () => void }).flush?.()
      } catch { /* close handler cleans up */ }
    }, PING_INTERVAL_MS),
  }
  ch.conns.add(conn)

  req.on('close', () => {
    clearInterval(conn.ping)
    ch.conns.delete(conn)
    ch.lastActiveAt = Date.now() // idle TTL counts from last disconnect
    opts?.onClose?.()
  })
}

/** Test-only: remove one idle channel without resetting the process sequence. */
export function _deleteSseChannelForTesting(key: string): void {
  const ch = channels.get(key)
  if (ch?.conns.size === 0) channels.delete(key)
}

/** Test-only: inspect the buffered IDs for one channel. */
export function _sseEventIdsForTesting(key: string): number[] {
  return channels.get(key)?.events.map(event => event.seq) ?? []
}

/** Close all live SSE connections (server shutdown / tests). */
export function closeAllSseChannels(): void {
  for (const ch of channels.values()) {
    for (const conn of ch.conns) {
      clearInterval(conn.ping)
      try { conn.res.end() } catch { /* already closed */ }
    }
    ch.conns.clear()
  }
  channels.clear()
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}
