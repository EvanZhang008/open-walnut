/**
 * The follower Link (link.ts): a host replica's loopback socket to its own
 * host's daemon. It wraps the host server's daemon link
 * (src/host-server/daemon-link.ts: follower.hello, follower.status polls,
 * streams, report) and adds what the Link interface asks: frames heard, events,
 * and doors on streams.
 */

import type { Duplex } from 'node:stream'
import type { IncomingStreamInfo } from '../../lib/link-stream.js'
import { createDaemonLink, type DaemonLink, type DaemonLinkState, type FollowerView } from '../../host-server/daemon-link.js'
import { createLinkEvents, type Link, type LinkDoor, type LinkPeerRole, type LinkState } from './link.js'

export interface FollowerLinkOptions {
  daemonDir: string
  walnutId: string
  home: string
  token: string
  /** This host's name, for the peer field and logs. */
  host: string
  /** A stream the Mac (`primary`) opened to this server: where it is plugged in; null refuses it. */
  accept?: (info: IncomingStreamInfo) => ((stream: Duplex) => void) | null
  openTimeoutMs?: number
  pollMs?: number
  now?: () => number
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  /** Tests: a daemon link of their own. */
  daemonLink?: DaemonLink
}

export interface FollowerLink extends Link {
  start(): void
  stop(): void
  /** The daemon's last follower.status answer, and when it came. */
  view(): { view: FollowerView; at: number } | null
  /** The daemon link's own state ('following' once hello held). */
  linkState(): DaemonLinkState
  lastError(): string | null
  /** Tell the daemon how this server is (the Mac reads it with server.status). */
  report(body: Record<string, unknown>): void
  /** What the daemon advertised (its `hello`), or null before the first answer. */
  capabilities(): readonly string[] | null
}

export function createFollowerLink(opts: FollowerLinkOptions): FollowerLink {
  const now = opts.now ?? Date.now
  const events = createLinkEvents()
  let lastState: DaemonLinkState | null = null
  const inner: DaemonLink = opts.daemonLink ?? createDaemonLink({
    daemonDir: opts.daemonDir, walnutId: opts.walnutId, home: opts.home, token: opts.token,
    accept: opts.accept,
    openTimeoutMs: opts.openTimeoutMs,
    pollMs: opts.pollMs,
    now,
    onView: (view) => {
      const s = inner.state()
      if (s !== lastState) { lastState = s; events.emit('state', s) }
      events.emit('view', view)
    },
    log: opts.log,
  })

  return {
    peer: { host: opts.host, walnutId: opts.walnutId },
    state: (): LinkState => (inner.state() === 'following' ? 'up' : 'down'),
    heard: () => {
      const at = inner.lastFrameAt()
      return at === null ? Infinity : Math.max(0, now() - at)
    },
    request: (cmd, params, timeoutMs) => inner.request(cmd, params, timeoutMs),
    on: (event, cb) => events.on(event, cb),
    openStream: (to: LinkPeerRole, door: LinkDoor) => {
      if (to === 'follower') return Promise.reject(new Error('a follower opens streams to the primary or the companion'))
      return inner.openStream(to, door)
    },
    start: () => inner.start(),
    stop: () => inner.stop(),
    view: () => inner.view(),
    linkState: () => inner.state(),
    lastError: () => inner.lastError(),
    report: (body) => inner.report(body),
    capabilities: () => inner.capabilities(),
  }
}
