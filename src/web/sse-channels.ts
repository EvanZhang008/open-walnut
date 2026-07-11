import type { Request, Response } from 'express'

// ─── Generic SSE channel: per-key ring buffer + replay ─────────────────────
//
// Extracted from the api-v1 conversation stream so session streams (and any
// future SSE surface) share one implementation. Semantics are unchanged:
// monotonic seq per channel, ring-capped replay window, Last-Event-ID replay,
// periodic comment pings, explicit flush past the compression middleware.

interface SseEvent { seq: number; event: string; data: unknown }
interface SseConn { res: Response; ping: NodeJS.Timeout }
interface Channel { events: SseEvent[]; nextSeq: number; conns: Set<SseConn> }

/** Ring cap per channel — a turn rarely exceeds a few hundred events. */
const RING_MAX = 512
const PING_INTERVAL_MS = 25_000

const channels = new Map<string, Channel>()

function getChannel(key: string): Channel {
  let ch = channels.get(key)
  if (!ch) {
    ch = { events: [], nextSeq: 0, conns: new Set() }
    channels.set(key, ch)
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
  const ev: SseEvent = { seq: ch.nextSeq++, event, data }
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
    opts?.onClose?.()
  })
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
}
