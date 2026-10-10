/**
 * Byte streams between two servers, through this daemon
 * (docs/plan/walnut-servers-everywhere.md, "One kind of link").
 *
 * Every server links to daemons only: the Mac over SSH, the companion through
 * the bridge the daemon dials, a host server over loopback. When one server
 * needs another (a host server's browser reaching the Mac, the Mac pushing its
 * copy to the host server) it asks a daemon both are linked to for a stream,
 * and the daemon passes the frames from one link to the other:
 *
 *   server A ──stream.open {sid, to}──────▶ daemon ──stream-open {sid', from}──▶ server B
 *            ◀──stream-accept {sid}───────        ◀──stream.accept {sid'}───────
 *   then stream.data / .ack / .end / .close the same way, either direction.
 *
 * The daemon holds no bytes: a frame goes on as it came. Each end acks what it
 * took (link-stream.ts keeps a window), so a slow end slows its peer, never the
 * daemon. `end` is one side's FIN; the pair is forgotten once both ends ended,
 * or at a `close` (an abort, with an optional error), or when either link drops.
 *
 * Shared by both daemon twins: daemon-standalone.ts imports it, daemon-source.ts
 * inlines its `toString()` through `__CREATE_STREAM_RELAY__`. So the factory
 * body references NOTHING at module scope.
 */

export interface StreamRelayDeps<L> {
  /** Send one event frame to a link (the daemon's sendEvent). */
  send: (link: L, ev: string, data: Record<string, unknown>) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export function createStreamRelay<L>(deps: StreamRelayDeps<L>) {
  const MAX_PER_LINK = 64
  /** base64 of 96 KB; link-stream.ts sends 48 KB pieces. */
  const MAX_DATA_CHARS = 128 * 1024
  /** Ids the opener picks; the daemon's own start with `r`, so they never meet. */
  const OPENER_SID = /^o[A-Za-z0-9_-]{1,63}$/

  interface End { link: L; sid: string; ended: boolean }
  interface Pair { a: End; b: End; accepted: boolean }
  const byLink = new Map<L, Map<string, Pair>>()
  let counter = 0

  function onLink(link: L): Map<string, Pair> {
    let m = byLink.get(link)
    if (!m) { m = new Map(); byLink.set(link, m) }
    return m
  }

  function forget(pair: Pair): void {
    for (const end of [pair.a, pair.b]) {
      const m = byLink.get(end.link)
      if (!m) continue
      m.delete(end.sid)
      if (m.size === 0) byLink.delete(end.link)
    }
  }

  function find(link: L, sid: string): { pair: Pair; me: End; other: End } | null {
    const pair = byLink.get(link)?.get(sid)
    if (!pair) return null
    const me = pair.a.link === link && pair.a.sid === sid ? pair.a : pair.b
    return { pair, me, other: me === pair.a ? pair.b : pair.a }
  }

  function abort(pair: Pair, error: string): void {
    forget(pair)
    deps.send(pair.a.link, 'stream-close', { sid: pair.a.sid, error })
    deps.send(pair.b.link, 'stream-close', { sid: pair.b.sid, error })
  }

  /**
   * `from` asks for a stream to `to` (null: nobody there, `why` says so).
   * `meta` goes to the other end with the open (who asks, for which Walnut).
   */
  function open(from: L, sid: unknown, to: L | null, meta: Record<string, unknown>, why?: string): void {
    if (typeof sid !== 'string' || !OPENER_SID.test(sid)) return
    if (byLink.get(from)?.has(sid)) {
      deps.send(from, 'stream-close', { sid, error: 'that stream id is already in use' })
      return
    }
    if (!to || to === from) {
      deps.send(from, 'stream-close', { sid, error: why ?? 'nobody there' })
      return
    }
    if ((byLink.get(from)?.size ?? 0) >= MAX_PER_LINK || (byLink.get(to)?.size ?? 0) >= MAX_PER_LINK) {
      deps.send(from, 'stream-close', { sid, error: 'too many streams on this link' })
      return
    }
    const pair: Pair = { a: { link: from, sid, ended: false }, b: { link: to, sid: `r${++counter}`, ended: false }, accepted: false }
    onLink(from).set(pair.a.sid, pair)
    onLink(to).set(pair.b.sid, pair)
    deps.send(to, 'stream-open', { ...meta, sid: pair.b.sid })
  }

  /** One frame (`accept`, `data`, `ack`, `end`, `close`) from `from` for one of its streams. */
  function frame(from: L, kind: string, msg: Record<string, unknown>): void {
    const sid = msg.sid
    if (typeof sid !== 'string') return
    const hit = find(from, sid)
    if (!hit) {
      // A late frame for a stream that is gone: say so, except to a close (no echo loop).
      if (kind !== 'close') deps.send(from, 'stream-close', { sid, error: 'no such stream' })
      return
    }
    const { pair, me, other } = hit
    if (kind === 'accept') {
      if (me !== pair.b || pair.accepted) return
      pair.accepted = true
      deps.send(other.link, 'stream-accept', { sid: other.sid })
      return
    }
    if (kind === 'data') {
      if (!pair.accepted || me.ended || typeof msg.d !== 'string' || msg.d.length > MAX_DATA_CHARS) {
        deps.log('warn', 'stream relay: a bad data frame ends the stream', { sid })
        abort(pair, 'bad data frame')
        return
      }
      deps.send(other.link, 'stream-data', { sid: other.sid, d: msg.d })
      return
    }
    if (kind === 'ack') {
      const n = msg.n
      if (typeof n !== 'number' || !(n > 0) || n > 64 * 1024 * 1024) return
      deps.send(other.link, 'stream-ack', { sid: other.sid, n })
      return
    }
    if (kind === 'end') {
      if (me.ended) return
      me.ended = true
      deps.send(other.link, 'stream-end', { sid: other.sid })
      if (other.ended) forget(pair)
      return
    }
    if (kind === 'close') {
      forget(pair)
      const error = typeof msg.error === 'string' ? msg.error.slice(0, 200) : undefined
      deps.send(other.link, 'stream-close', { sid: other.sid, ...(error ? { error } : {}) })
    }
  }

  /** A link closed: every stream on it ends at its other side too. */
  function dropLink(link: L): void {
    const m = byLink.get(link)
    if (!m) return
    for (const pair of [...m.values()]) {
      forget(pair)
      const other = pair.a.link === link ? pair.b : pair.a
      deps.send(other.link, 'stream-close', { sid: other.sid, error: 'the other server is no longer linked to this host' })
    }
  }

  return {
    open,
    frame,
    dropLink,
    /** Open streams, on one link or in all. */
    count: (link?: L): number => {
      if (link !== undefined) return byLink.get(link)?.size ?? 0
      let n = 0
      for (const m of byLink.values()) n += m.size
      return n / 2
    },
  }
}

export type StreamRelay<L> = ReturnType<typeof createStreamRelay<L>>
