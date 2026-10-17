/**
 * The Mac's Link (link.ts) to one host's daemon: its SSH forward, wrapped
 * (src/providers/daemon-connection.ts `DaemonConnection`; replica plan WP13).
 * Nothing changes in the connection: the adapter only reads it the way every
 * Link is read. `heard()` is the last frame or pong the daemon sent, never the
 * socket's state; streams go to the host's follower (the host replica), the
 * only server the Mac reaches through a host's daemon.
 */

import type { Duplex } from 'node:stream'
import { createLinkEvents, type Link, type LinkDoor, type LinkPeerRole, type LinkState } from './link.js'

/** What the adapter reads of a DaemonConnection (the class satisfies it). */
export interface DaemonConnectionLike {
  readonly hostKey: string
  readonly connected: boolean
  lastHeardAt(): number
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<object>
  onEvent(handler: (event: never) => void): () => void
  openStream(to: 'follower', purpose?: string): Promise<Duplex>
}

export interface DaemonConnectionLinkOptions {
  conn: DaemonConnectionLike
  /** The Walnut whose leader this Mac is (device-auth instance id). */
  walnutId: string
  now?: () => number
  /** How often the state is read for 'state' events (ms; only while someone listens). */
  stateEveryMs?: number
}

export interface DaemonConnectionLink extends Link {
  /** Stop the state watch and the event fan-out, for good: a later on() arms nothing. */
  close(): void
}

export function createDaemonConnectionLink(opts: DaemonConnectionLinkOptions): DaemonConnectionLink {
  const { conn } = opts
  const now = opts.now ?? Date.now
  const events = createLinkEvents()
  let stateListeners = 0
  let closed = false
  let last: LinkState | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const state = (): LinkState => (conn.connected ? 'up' : 'down')
  const watch = () => {
    const s = state()
    if (s !== last) { last = s; events.emit('state', s) }
  }
  // Every daemon event, named by its `ev` (or `type`), for whoever subscribes to it.
  const offEvents = conn.onEvent(((event: Record<string, unknown>) => {
    const name = typeof event?.ev === 'string' ? event.ev : typeof event?.type === 'string' ? event.type : null
    if (name) events.emit(name, event)
    watch()
  }) as never)

  return {
    peer: { host: conn.hostKey, walnutId: opts.walnutId },
    state,
    heard: () => {
      const at = conn.lastHeardAt()
      return at > 0 ? Math.max(0, now() - at) : Infinity
    },
    request: async (cmd, params, timeoutMs) => (await conn.send(cmd, params ?? {}, timeoutMs)) as Record<string, unknown>,
    on(event, cb) {
      // A closed link emits nothing and arms nothing (no watch close() could stop).
      if (closed) return () => {}
      const off = events.on(event, cb)
      if (event !== 'state') return off
      if (stateListeners++ === 0) {
        last = state()
        timer = setInterval(watch, opts.stateEveryMs ?? 1_000)
        timer.unref?.()
      }
      // Counted once: a second call of this off, or one after close() let every
      // listener go, never takes the count below the listeners still there.
      let counted = true
      return () => {
        off()
        if (!counted) return
        counted = false
        if (closed) return
        if (--stateListeners === 0 && timer) { clearInterval(timer); timer = null }
      }
    },
    openStream(to: LinkPeerRole, door: LinkDoor) {
      if (to !== 'follower') return Promise.reject(new Error('the Mac opens streams to a host\'s follower only'))
      return conn.openStream('follower', door)
    },
    close() {
      if (closed) return
      closed = true
      offEvents()
      if (timer) { clearInterval(timer); timer = null }
      stateListeners = 0
    },
  }
}
