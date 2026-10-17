/**
 * The companion's Link (link.ts) to one host's daemon: the reverse WebSocket
 * that daemon dialled (`/bridge`, src/web/ws/bridge-registry.ts; replica plan
 * WP13). `heard()` is the last frame the bridge sent, never the socket's state.
 * Streams go to the host's primary only ('bridge-stream-v1'): the daemon refuses
 * any other, and an older daemon (no cap in its hello) refuses them all.
 */

import type { Duplex } from 'node:stream'
import { createLinkEvents, type Link, type LinkDoor, type LinkPeerRole, type LinkState } from './link.js'

/** What the adapter reads of the bridge registry (bridge-registry.ts exports it all). */
export interface BridgeRegistryLike {
  bridgeForHost(hostAlias: string): { connected: boolean }
  bridgeLastInbound(hostAlias: string): number | null
  bridgeHasCapability(hostAlias: string, cap: string): boolean
  bridgeRequest(hostAlias: string, cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  openBridgeStream(hostAlias: string, to: 'primary', purpose?: string): Promise<Duplex>
  addBridgeConnectedHandler(handler: (hostAlias: string) => void): () => void
}

export interface BridgeLinkOptions {
  hostAlias: string
  /** The Walnut the bridge serves (the companion's leader). */
  walnutId: string
  registry: BridgeRegistryLike
  now?: () => number
}

export interface BridgeLink extends Link {
  /** Whether the daemon said it opens streams for the companion ('bridge-stream-v1'). */
  streams(): boolean
  close(): void
}

export const BRIDGE_STREAM_CAP = 'bridge-stream-v1'

export function createBridgeLink(opts: BridgeLinkOptions): BridgeLink {
  const { hostAlias, registry } = opts
  const now = opts.now ?? Date.now
  const events = createLinkEvents()
  const state = (): LinkState => (registry.bridgeForHost(hostAlias).connected ? 'up' : 'down')
  // A redial of this host's bridge is the one state change the registry announces.
  const offConnected = registry.addBridgeConnectedHandler((alias) => { if (alias === hostAlias) events.emit('state', 'up') })
  return {
    peer: { host: hostAlias, walnutId: opts.walnutId },
    state,
    heard: () => {
      const at = registry.bridgeLastInbound(hostAlias)
      return at === null ? Infinity : Math.max(0, now() - at)
    },
    request: (cmd, params, timeoutMs) => registry.bridgeRequest(hostAlias, cmd, params ?? {}, timeoutMs),
    on: (event, cb) => events.on(event, cb),
    openStream(to: LinkPeerRole, door: LinkDoor) {
      if (to !== 'primary') return Promise.reject(new Error('the companion opens streams to the primary only'))
      if (!registry.bridgeHasCapability(hostAlias, BRIDGE_STREAM_CAP)) {
        return Promise.reject(new Error(`the daemon of ${hostAlias} opens no stream for the companion (no ${BRIDGE_STREAM_CAP})`))
      }
      return registry.openBridgeStream(hostAlias, 'primary', door)
    },
    streams: () => registry.bridgeHasCapability(hostAlias, BRIDGE_STREAM_CAP),
    close: () => { offConnected() },
  }
}
