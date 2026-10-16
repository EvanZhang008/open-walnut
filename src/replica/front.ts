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
 *   /_alone/*  the host server's own answers (host-server/alone-api.ts), kept
 *              until WP7 retires the alone page
 *   the tunnel supervisor (host-server/expose.ts) the Mac sets through the daemon
 *
 * The report loop and the link start before the server's heavy init, so the
 * Mac sees a first report within seconds of the spawn.
 */

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
import { createAloneApi, ALONE_PREFIX } from '../host-server/alone-api.js'
import { sendAlone } from '../host-server/pages.js'
import type { DeviceCopy } from '../host-server/device-copy.js'
import { chooseReplicaRoute, presenceOf, quietWindow, SuspectMarks, wireLeaderPresence, type Presence, type PresenceInput } from './presence.js'
import { createDispatcher, type Dispatcher } from './dispatch.js'
import { rpcAway } from './ws-rpc-table.js'
import { replicaRefusal, verifyReplicaToken } from './auth.js'

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
  const { look, onSuspect } = wireLeaderPresence({
    input,
    marks,
    dispatcher: () => dispatcher,
    probe: async () => {
      const stream = await link.openStream('primary', 'web')
      stream.on('error', () => { /* a probe: nothing is sent on it */ })
      stream.destroy()
    },
    changed: (p) => {
      last = p
      setLeaderPresence(p.answers, p.why)
      log.web.info('replica: presence', { answers: p.answers, why: p.why, asOf: p.asOf, host: env.label, home: env.leaderHome })
      opts.broadcast?.('replica:presence', { answers: p.answers, asOf: p.asOf, host: env.label, why: p.why })
    },
    closeOwnSockets: () => opts.closeOwnSockets?.(4002, 'leader_back'),
    failed: (kind, err, skipMs) => {
      log.web.warn('replica: a forward failed', { to: kind, host: env.label, error: err.message, skipMs, failures: marks.failures(kind) })
    },
  })

  const dispatcher: Dispatcher = createDispatcher({
    route: () => { look(); return routeNow() },
    asOf: () => look().asOf,
    connect: (kind) => link.openStream(kind === 'leader' ? 'primary' : 'companion', 'web'),
    suspect: onSuspect,
    answered: (kind) => { marks.answered(kind) },
    answerAlone: (req, res, why) => sendAlone(req, res, env.label, why),
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

  const aloneApi = createAloneApi({
    label: env.label,
    route: routeNow,
    devices: opts.devices,
    request: (cmd, params, timeoutMs) => link.request(cmd, params, timeoutMs),
    transcript: async (sid, jsonl) => (await import('../core/sessions/transcript-from-jsonl.js')).transcriptFromJsonl(sid, jsonl),
    log: (level, msg, data) => log.web[level](msg, data),
  })

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
      // This replica's own answers, whoever leads (the alone page asks /_alone/state).
      if ((req.url ?? '').startsWith(ALONE_PREFIX)) { void aloneApi.handle(req, res); return }
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
