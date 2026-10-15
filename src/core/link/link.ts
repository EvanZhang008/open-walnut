/**
 * A Link: one connection between a Walnut server and a daemon, whatever dialled
 * it (docs/plan/walnut-replica-servers.md, "The link"; implementation plan
 * section 3). A server talks to daemons and only to daemons; the transports are
 * an SSH forward (the Mac to every host), a loopback socket (a host replica to
 * its own daemon, follower-link.ts) and a reverse WebSocket (a daemon to the
 * companion). This file is the interface; each transport has an adapter.
 *
 * `heard()` counts FRAMES, never the socket's state: a sleeping Mac keeps its
 * sockets open, so an open socket says nothing about whether anyone answers.
 */

import type { Duplex } from 'node:stream'

export type LinkState = 'up' | 'down'

/** Where a stream through the daemon goes: the leader (the Mac), the companion, or a follower. */
export type LinkPeerRole = 'primary' | 'companion' | 'follower'

/** Which door of the other server a stream is for. */
export type LinkDoor = 'web' | 'replica'

export interface Link {
  readonly peer: { host: string; walnutId: string }
  state(): LinkState
  /** Milliseconds since the last frame from the daemon (Infinity before the first one). */
  heard(): number
  request(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /** Subscribe to an event of the link ('view', 'state'); returns the unsubscribe. */
  on(event: string, cb: (data: unknown) => void): () => void
  /** A byte stream through the daemon to another server it links. */
  openStream(to: LinkPeerRole, door: LinkDoor): Promise<Duplex>
}

/** A tiny event fan-out the adapters share. */
export function createLinkEvents(): {
  on(event: string, cb: (data: unknown) => void): () => void
  emit(event: string, data: unknown): void
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  return {
    on(event, cb) {
      let set = listeners.get(event)
      if (!set) { set = new Set(); listeners.set(event, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    },
    emit(event, data) {
      for (const cb of listeners.get(event) ?? []) {
        try { cb(data) } catch { /* a listener never breaks the link */ }
      }
    },
  }
}
