/**
 * The front of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 1 and 3; WP2): what sits in front of the full server program on the
 * public (tunnel) port, before every body parser.
 *
 *   follower Link (core/link/follower-link.ts) to this host's daemon: its view
 *     says who leads; the Mac's streams to this server come in on it and go to
 *     the leader door (leader-door.ts); the report the Mac reads goes out on it
 *   presence (presence.ts) from that view, the age of it, and the last forward
 *   dispatcher (dispatch.ts) forwards, or answers away from this replica
 *   no alone page: away, a page is the console on this replica's copies (WP7);
 *              the alone page and /_alone/* stay the plain host server's. An
 *              alone page left open from before the host switched program asks
 *              /_alone/state: it is told the console answers, and reloads into it
 *   the tunnel supervisor (host-server/expose.ts) the Mac sets through the daemon
 *
 * The report loop and the link start before the server's heavy init, so the
 * Mac sees a first report within seconds of the spawn.
 *
 * What a browser learns about presence (the contract with web/src/api/leader-presence.ts):
 *
 *   x-walnut-presence-seq: <n>      on EVERY HTTP answer of this replica (forwarded,
 *   x-walnut-presence-boot: <id>    local, or from the copies): n counts the changes of
 *                                   what browsers are told (presence.ts ToldPresence:
 *                                   answers, why, the route's kind), from 1 in this
 *                                   process; id is random per process, so a client
 *                                   resets its count when the replica restarted. The
 *                                   seq is the one in force when the request was
 *                                   routed: an answer that was on its way while the
 *                                   presence changed carries the older number.
 *   x-walnut-offline: <asOf ms>     on an answer made from this replica's copies (and
 *                                   its needs_leader refusals), for a known device:
 *                                   asOf is the copies' last completed round
 *                                   (kind-follower.ts copiesAsOf), 0 when not known
 *   x-walnut-offline-why: away | suspect
 *                                   beside it: `suspect` while the Mac is only marked
 *                                   suspect (a stream to it failed; it was heard within
 *                                   the quiet window), `away` otherwise
 *   replica:presence {answers, asOf, host, hostKey, why, seq, boot}
 *                                   on the replica's own /ws, at connect and on every
 *                                   change of what is told; asOf as above, null when not
 *                                   known. answers:true (the Mac is back) is told only
 *                                   once a probe stream to the Mac opened, and only
 *                                   then are this replica's own sockets closed 4002; a
 *                                   socket that joined while this replica answered alone
 *                                   is closed 4002 too once the companion stands in (a
 *                                   probe to it opened), so it reconnects there
 *   GET /api/config                 answered here (the Mac away) carries
 *                                   `replica: {hostKey}` (WALNUT_HOST_KEY); the Mac's and
 *                                   the companion's own answers have no such field
 */

import crypto from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { getBuildInfo } from '../lib/build-info.js'
import { placement, role, setLeaderPresence } from '../core/server-role.js'
import { createFollowerLink, type FollowerLink } from '../core/link/follower-link.js'
import { clearSelfHost, installSelfHost, isLocalHere } from './self-host.js'
import type { HostServerEnv } from '../host-server/env.js'
import type { Route } from '../host-server/route.js'
import { createHostExpose, followExposeSettings, type HostExpose } from '../host-server/expose.js'
import type { DeviceCopy } from '../host-server/device-copy.js'
import { chooseReplicaRoute, presenceOf, quietWindow, SuspectMarks, wireLeaderPresence, type Presence, type PresenceInput, type ToldPresence } from './presence.js'
import { createDispatcher, PRESENCE_BOOT_HEADER, PRESENCE_SEQ_HEADER, type Dispatcher, type OfflineWhy } from './dispatch.js'
import { rpcAway } from './ws-rpc-table.js'
import { replicaRefusal, verifyReplicaToken } from './auth.js'
import { copiesAsOf } from '../core/replication/kind-follower.js'

/** The /_alone/ path the alone page of the plain host server polls (host-server/alone-api.ts). */
const ALONE_STATE_PATH = '/_alone/state'

/** The `replica:presence` event (see the header). */
export interface PresenceEvent {
  answers: boolean
  /** The copies' last completed round (ms), or null when not known. */
  asOf: number | null
  host: string
  hostKey: string | null
  why: string
  seq: number
  boot: string
}

const REPORT_MS = 5_000
/** The daemon capability that carries follower.op (docs/plan/walnut-replica-servers-impl.md, section 5). */
export const REPLICA_OPS_CAP = 'replica-ops-v1'
/** A browser's request waits this long for the Mac or the companion to take its stream. */
const OPEN_TIMEOUT_MS = 4_000
/** How often presence is looked at between views (a view ages). */
const PRESENCE_TICK_MS = 1_000

export interface ReplicaFrontOptions {
  env: HostServerEnv
  devices: DeviceCopy
  /** Where a stream the Mac opened to this server goes (the leader door). */
  acceptFromLeader(stream: Duplex): void
  /** The replica's own WS: an event to every socket, and closing them all. */
  broadcast?(name: string, data: unknown): void
  closeOwnSockets?(code: number, reason: string): void
  /** The Mac's name for this host (WALNUT_HOST_KEY): the `host` of the sessions that run here, told to browsers. */
  hostKey?: string
  /** Tests. */
  pollMs?: number
  writeBudgetMs?: number
  /** Tests: a follower link of their own (the daemon's view and the streams are the test's). */
  link?: FollowerLink
}

export interface ReplicaFront {
  /** Express middleware for the public app, mounted before every body parser. */
  middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void
  /** An upgrade on the public port; `own` is the replica's own /ws handling. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, own: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void
  /** A /ws RPC on the replica's own socket: null to run it, else the refusal (needs_leader). */
  rpcGate(method: string): string | null
  route(): Route
  presence(): Presence
  /** The `replica:presence` event for a browser (on connect and on every change). */
  presenceEvent(): PresenceEvent
  /** What browsers are told now (seq and all). */
  told(): ToldPresence
  /** This process's random id (x-walnut-presence-boot, the event's `boot`). */
  readonly boot: string
  /** The headers an answer made from the copies carries for a known device (x-walnut-offline and its why). */
  offlineHeaders(): Record<string, string>
  /** What the Mac reads (server.status report, and /host-api/status on the leader door). */
  status(): Record<string, unknown>
  link: FollowerLink
  dispatcher: Dispatcher
  stop(): Promise<void>
}

/** Where a session runs, from this replica's session store (the copy, WP4). */
async function lookupSessionHost(sessionId: string): Promise<{ host?: string | null } | null> {
  const { getSessionByClaudeId } = await import('../core/session-tracker.js')
  return (await getSessionByClaudeId(sessionId)) ?? null
}

export function startReplicaFront(opts: ReplicaFrontOptions): ReplicaFront {
  const env = opts.env
  const startedAt = Date.now()
  const build = getBuildInfo()
  // Backs off: a door that keeps refusing is not tried, and every socket moved, every 5 s.
  const marks: SuspectMarks = new SuspectMarks((): number => quietWindow(input()))
  const suspect: { leader?: number; companion?: number } = marks.until
  let last: Presence | null = null
  let lastRoute: Route['kind'] | null = null
  let ownUpgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null
  let reported = false
  const boot = crypto.randomBytes(8).toString('hex')

  const expose: HostExpose = createHostExpose({
    port: env.publicPort,
    stateFile: path.join(WALNUT_HOME, 'host-expose.json'),
    log: { info: (m, d) => log.web.info(m, d), warn: (m, d) => log.web.warn(m, d) },
  })
  const followSettings = followExposeSettings(expose, (m, d) => log.web.warn(m, d))

  const link: FollowerLink = opts.link ?? createFollowerLink({
    daemonDir: env.daemonDir, walnutId: env.walnutId, home: env.leaderHome, token: env.followerToken, host: env.label,
    openTimeoutMs: OPEN_TIMEOUT_MS,
    ...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
    accept: (info) => (info.from === 'primary' ? (stream: Duplex) => opts.acceptFromLeader(stream) : null),
    log: (level, msg, data) => log.web[level](msg, data),
  })
  // The Mac's name for this host resolves to this link (self-host.ts, WP6).
  installSelfHost({ aliases: env.hostKey ? [env.hostKey] : [], link })
  log.web.info('replica: self host', { host: env.label, hostKey: env.hostKey ?? null, home: env.leaderHome })
  link.on('view', (view) => {
    followSettings((view as { settings: Record<string, unknown> }).settings)
    look()
    // The first report goes out with the first view (once hello made the link
    // `following`, right after this listener), not REPORT_MS later.
    if (!reported) {
      setImmediate(() => {
        if (reported || link.linkState() !== 'following') return
        reported = true
        link.report(status())
      })
    }
  })

  const input = (): PresenceInput => ({ view: link.view(), now: Date.now(), suspect })

  function routeNow(): Route {
    const route = chooseReplicaRoute(input())
    if (route.kind !== lastRoute) {
      lastRoute = route.kind
      log.web.info('replica: browsers now reach ' + (route.kind === 'alone' ? 'this replica' : `the ${route.kind}`), {
        route: route.kind, host: env.label, home: env.leaderHome, ...(route.kind === 'alone' ? { why: route.why } : {}),
      })
    }
    return route
  }

  /**
   * Presence now; a change tells the replica's own clients. A real absence
   * (presence.ts macAway) moves the Mac's sockets and in-flight forwards at
   * once; a bare suspect mark steers new requests only. Back: once a probe
   * stream opened. The wiring is presence.ts wireLeaderPresence, which the
   * suspect tests drive.
   */
  /** One stream to `to` through the daemon, let go at once: resolves once it opened. */
  const probeStream = async (to: 'primary' | 'companion'): Promise<void> => {
    const stream = await link.openStream(to, 'web')
    stream.on('error', () => { /* a probe: nothing is sent on it */ })
    stream.destroy()
  }
  const { look, onSuspect, told } = wireLeaderPresence({
    input,
    marks,
    dispatcher: () => dispatcher,
    probe: () => probeStream('primary'),
    probeCompanion: () => probeStream('companion'),
    changed: (p) => {
      last = p
      setLeaderPresence(p.answers, p.why)
      log.web.info('replica: presence', { answers: p.answers, why: p.why, asOf: p.asOf, host: env.label, home: env.leaderHome })
    },
    told: (t) => {
      const ev = presenceEventOf(t)
      log.web.info('replica: presence told', { answers: ev.answers, why: ev.why, route: t.route, seq: ev.seq, asOf: ev.asOf, host: env.label })
      opts.broadcast?.('replica:presence', ev)
    },
    closeOwnSockets: (to) => opts.closeOwnSockets?.(4002, to === 'leader' ? 'leader_back' : 'companion_stands_in'),
    failed: (kind, err, skipMs) => {
      log.web.warn('replica: a forward failed', { to: kind, host: env.label, error: err.message, skipMs, failures: marks.failures(kind) })
    },
  })

  /** Whether what is answered from the copies now is answered so only because a stream to a live Mac failed. */
  const offlineWhy = (): OfflineWhy => (look().why === 'unreachable' ? 'suspect' : 'away')
  const offlineHeaders = (): Record<string, string> => ({ 'x-walnut-offline': String(copiesAsOf() ?? 0), 'x-walnut-offline-why': offlineWhy() })

  const dispatcher: Dispatcher = createDispatcher({
    route: () => { look(); return routeNow() },
    // The copies' age, never the presence time (0: not known).
    asOf: () => copiesAsOf() ?? 0,
    offlineWhy,
    presenceHeaders: () => ({ [PRESENCE_SEQ_HEADER]: String(told().seq), [PRESENCE_BOOT_HEADER]: boot }),
    connect: (kind) => link.openStream(kind === 'leader' ? 'primary' : 'companion', 'web'),
    suspect: onSuspect,
    answered: (kind) => { marks.answered(kind) },
    followerOp: (params, timeoutMs) => link.request('follower.op', params, timeoutMs),
    // An older daemon has no follower.op: its away writes need the Mac (needs_leader daemon_needs_upgrade).
    followerOpCap: () => {
      const caps = link.capabilities()
      return caps === null ? null : caps.includes(REPLICA_OPS_CAP)
    },
    linked: () => link.linkState() === 'following',
    // WP6: a session or a file of this host is read here, through the follower link (self-host.ts).
    localHere: (req, decision) => (decision.row?.local ? isLocalHere(req.url ?? '', decision.row.local, lookupSessionHost, decision.row.cap) : true),
    ownUpgrade: (req, socket, head) => {
      if (ownUpgrade) return ownUpgrade(req, socket, head)
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    },
    log: (level, msg, data) => log.web[level](msg, { host: env.label, ...data }),
    // The front runs before the auth middleware: an away write's body is read only for a known device.
    authorized: (req) => {
      const h = req.headers.authorization
      return typeof h === 'string' && h.startsWith('Bearer ') && verifyReplicaToken(h.slice(7)) !== null
    },
    // The same answer as the /api auth: a wrong token counts toward the shared limit.
    refuse: (req) => replicaRefusal(req.headers.authorization),
    ...(opts.writeBudgetMs ? { writeBudgetMs: opts.writeBudgetMs } : {}),
  })

  function presenceEventOf(t: ToldPresence): PresenceEvent {
    return { answers: t.answers, asOf: copiesAsOf(), host: env.label, hostKey: opts.hostKey?.trim() || null, why: t.why, seq: t.seq, boot }
  }

  function status(): Record<string, unknown> {
    const view = link.view()
    const route = routeNow()
    const p = last ?? presenceOf(input())
    return {
      version: build.version,
      commit: build.commit,
      pid: process.pid,
      startedAt,
      port: env.publicPort,
      program: 'replica',
      role: role(),
      placement: placement(),
      route: route.kind === 'alone' ? { kind: 'alone', why: route.why } : { kind: route.kind },
      presence: { answers: p.answers, why: p.why, asOf: p.asOf },
      daemon: { state: link.linkState(), lastError: link.lastError(), at: view?.at ?? null },
      expose: expose.status(),
      deviceCopy: opts.devices.hash(),
      forwards: dispatcher.counts(),
    }
  }

  link.start()
  const reportTimer = setInterval(() => { link.report(status()) }, REPORT_MS)
  reportTimer.unref?.()
  const tick = setInterval(() => { look() }, PRESENCE_TICK_MS)
  tick.unref?.()
  log.web.info('replica: front started', { port: env.publicPort, host: env.label, home: env.leaderHome, walnutId: env.walnutId })

  return {
    middleware(req, res, next) {
      // No alone page here (WP7): away, a page is the console, served from this
      // replica's copies; the alone page stays the plain host server's. One left
      // open from before the host switched program polls /_alone/state forever
      // unless it is told the console answers: it then reloads into it.
      if (req.method === 'GET' && (req.url ?? '').split('?')[0] === ALONE_STATE_PATH) {
        const text = JSON.stringify({ route: 'console', label: env.label })
        res.writeHead(200, {
          'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text),
          [PRESENCE_SEQ_HEADER]: String(told().seq), [PRESENCE_BOOT_HEADER]: boot,
        })
        res.end(text)
        return
      }
      dispatcher.middleware(req, res, next)
    },
    upgrade(req, socket, head, own) {
      ownUpgrade = own
      dispatcher.upgrade(req, socket, head)
    },
    rpcGate(method) {
      // While the Mac answers, /ws is spliced to it, so a socket here is an away
      // one, also in the moment between the Mac's return and its 4002 close: a
      // write on it is refused whoever leads, never run on this replica.
      const row = rpcAway(method)
      if (row.away === 'read') return null
      return `needs_leader: ${row.why ?? 'needs_mac'}`
    },
    route: () => { look(); return routeNow() },
    presence: () => look(),
    presenceEvent: () => { look(); return presenceEventOf(told()) },
    told: () => { look(); return told() },
    boot,
    offlineHeaders,
    status,
    link,
    dispatcher,
    async stop() {
      clearInterval(reportTimer)
      clearInterval(tick)
      link.stop()
      clearSelfHost()
      await expose.stop()
    },
  }
}
