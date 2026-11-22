/**
 * The follower Link (link.ts): a host replica's link to its own host's daemon, in two forms.
 *   createFollowerLink: a loopback socket. It wraps the host server's daemon link
 *     (src/host-server/daemon-link.ts: follower.hello, follower.status polls, streams, report) and
 *     adds what the Link interface asks: frames heard, events, and doors on streams.
 *   createDirectFollowerLink (follower-link-direct.ts): a host's one Walnut service holds the
 *     daemon runtime in its own process and calls it, with no socket and no hello.
 */

import type { Duplex } from 'node:stream'
import type { IncomingStreamInfo } from '../../lib/link-stream.js'
import { createDaemonLink, type DaemonLink, type DaemonLinkState, type FollowerView } from '../../host-server/daemon-link.js'
import { createLinkEvents, type Link, type LinkDoor, type LinkPeerRole, type LinkState } from './link.js'

/** What both forms of the link are told: the Walnut it follows and how the server answers around it. */
export interface FollowerLinkWiring {
  walnutId: string
  home: string
  /** This host's name, for the peer field and logs. */
  host: string
  /** A stream the Mac (`primary`) opened to this server: where it is plugged in; null refuses it. */
  accept?: (info: IncomingStreamInfo) => ((stream: Duplex) => void) | null
  openTimeoutMs?: number
  pollMs?: number
  now?: () => number
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  /** This server answers the host's `walnut` calls while its leader is away (daemon-link.ts). */
  answersLocal?: boolean
  /** This server picks the session for the host's unclaimed trigger fires while its leader is away (daemon-link.ts). */
  deliversTriggers?: boolean
  /** This server takes a same-host message while its leader answers too, read at each hello (daemon-link.ts). */
  answersOnline?: () => boolean
  /** More of follower.hello, read at each hello (daemon-link.ts). */
  helloExtra?: () => Record<string, unknown>
  /** A daemon event on the link (a `gateway-request`, a `trigger-delivery`). */
  onEvent?: (event: Record<string, unknown>) => void
}

export interface FollowerLinkOptions extends FollowerLinkWiring {
  daemonDir: string
  token: string
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

export { createDirectFollowerLink, type DirectFollowerLinkOptions } from './follower-link-direct.js'

export function createFollowerLink(opts: FollowerLinkOptions): FollowerLink {
  const now = opts.now ?? Date.now
  const events = createLinkEvents()
  let lastState: DaemonLinkState | null = null
  const inner: DaemonLink = opts.daemonLink ?? createDaemonLink({
    daemonDir: opts.daemonDir, walnutId: opts.walnutId, home: opts.home, token: opts.token,
    accept: opts.accept,
    ...(opts.answersLocal ? { answersLocal: true } : {}),
    ...(opts.deliversTriggers ? { deliversTriggers: true } : {}),
    ...(opts.answersOnline ? { answersOnline: opts.answersOnline } : {}),
    ...(opts.helloExtra ? { helloExtra: opts.helloExtra } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
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
