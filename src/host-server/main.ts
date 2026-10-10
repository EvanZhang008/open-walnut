/**
 * A Walnut server on a host the user picked, following the leader
 * (docs/plan/walnut-servers-everywhere.md, "A server on a host").
 *
 *   browser ── this host's tunnel ── public port ─┐
 *                                                 │ one link (loopback)
 *        the Mac ──── its link ───► host daemon ◄─┘
 *        the companion ── its link ──┘
 *
 * The host's daemon starts it and keeps it running (`server.configure`), and it
 * links to that daemon only. Everything goes over that one link: who leads,
 * the settings the Mac gave it (its tunnel), the streams a browser's requests
 * ride to the Mac or the companion, the streams the Mac opens to it (its copy),
 * and the report the Mac reads back. It opens no other connection and listens
 * on one port. It keeps no data of its own beyond its tunnel settings and the
 * copies the Mac sends.
 */

import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { getBuildInfo } from '../lib/build-info.js'
import { setLeaderPresence } from '../core/server-role.js'
import { readHostServerEnv, type HostServerEnv } from './env.js'
import { createDaemonLink, type DaemonLink, type FollowerView } from './daemon-link.js'
import { chooseRoute, leaderAnswers, SUSPECT_MS, type Route } from './route.js'
import { forwardHttp, forwardUpgrade, type ForwardTarget } from './proxy.js'
import { createHostExpose, type HostExpose } from './expose.js'
import { aloneJson } from './pages.js'
import { alonePage, aloneContentSecurityPolicy } from './alone-page.js'
import { createAloneApi, ALONE_PREFIX } from './alone-api.js'
import { createDeviceCopy } from './device-copy.js'

const REPORT_MS = 5_000
/** A browser's request waits this long for the Mac or the companion to take its stream. */
const OPEN_TIMEOUT_MS = 4_000

export interface HostServer {
  route(): Route
  stop(): Promise<void>
  port: number
}

export interface HostServerOptions {
  env?: HostServerEnv
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as { port: number }).port)
    })
  })
}

export async function startHostServer(opts: HostServerOptions = {}): Promise<HostServer> {
  const env = opts.env ?? readHostServerEnv()
  const startedAt = Date.now()
  const build = getBuildInfo()
  const suspect: { leader?: number; companion?: number } = {}
  let lastRoute: Route['kind'] | null = null
  let exposeKey = ''
  let exposeRetry: unknown = undefined

  // Streams the Mac opens to this server land here; it listens on no port.
  const fromLeader = http.createServer((req, res) => { void handleFromLeader(req, res) })

  const expose: HostExpose = createHostExpose({
    port: env.publicPort,
    stateFile: path.join(WALNUT_HOME, 'host-expose.json'),
    log: { info: (m, d) => log.web.info(m, d), warn: (m, d) => log.web.warn(m, d) },
  })

  const link: DaemonLink = createDaemonLink({
    daemonDir: env.daemonDir, walnutId: env.walnutId, home: env.leaderHome, token: env.followerToken,
    openTimeoutMs: OPEN_TIMEOUT_MS,
    accept: (info) => (info.from === 'primary' ? (stream: Duplex) => { fromLeader.emit('connection', stream) } : null),
    onView: (view) => { applySettings(view); routeNow() },
    log: (level, msg, data) => log.web[level](msg, data),
  })

  /** The Mac's settings for this server, as the daemon holds them. */
  function applySettings(view: FollowerView): void {
    const s = view.settings as { expose?: unknown; exposeRetry?: unknown }
    if (s.expose && typeof s.expose === 'object') {
      const key = JSON.stringify(s.expose)
      if (key !== exposeKey) {
        exposeKey = key
        void expose.apply(s.expose as never).catch((err) => {
          log.web.warn('host server: the tunnel settings were refused', { error: err instanceof Error ? err.message : String(err) })
        })
      }
    }
    if (exposeRetry !== undefined && s.exposeRetry !== exposeRetry) expose.retry()
    exposeRetry = s.exposeRetry ?? null
  }

  // The Mac's copy of the signed-in devices: what the alone answers check tokens against.
  const devices = createDeviceCopy(path.join(WALNUT_HOME, 'replica', 'devices.json'))
  const aloneApi = createAloneApi({
    label: env.label,
    route: () => routeNow(),
    devices,
    request: (cmd, params, timeoutMs) => link.request(cmd, params, timeoutMs),
    transcript: async (sid, jsonl) => (await import('../core/sessions/transcript-from-jsonl.js')).transcriptFromJsonl(sid, jsonl),
    log: (level, msg, data) => log.web[level](msg, data),
  })

  function routeNow(): Route {
    const input = { view: link.view(), now: Date.now(), suspect }
    const presence = leaderAnswers(input)
    setLeaderPresence(presence.answers, presence.why)
    const route = chooseRoute(input)
    if (route.kind !== lastRoute) {
      lastRoute = route.kind
      log.web.info('host server: browsers now reach ' + (route.kind === 'alone' ? 'this server alone' : `the ${route.kind}`), {
        route: route.kind, ...(route.kind === 'alone' ? { why: route.why } : {}),
      })
    }
    return route
  }

  function target(route: Exclude<Route, { kind: 'alone' }>): ForwardTarget {
    return route.kind === 'leader'
      ? { kind: 'leader', connect: () => link.openStream('primary', 'web') }
      : { kind: 'companion', origin: route.origin, connect: () => link.openStream('companion', 'web') }
  }

  /** A stream to `kind` failed: skip it for a few seconds. */
  function suspectOf(kind: 'leader' | 'companion', err: Error): void {
    suspect[kind] = Date.now() + SUSPECT_MS
    log.web.warn('host server: a forward failed', { to: kind, error: err.message })
  }

  function answerAlone(req: IncomingMessage, res: ServerResponse, why: string): void {
    if (res.headersSent || res.destroyed) return
    if ((req.url ?? '').startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      sendJson(res, 503, aloneJson(env.label, why))
      return
    }
    // A working page of its own: this Walnut's sessions here, once the browser's token holds (alone-page.ts).
    const nonce = crypto.randomBytes(16).toString('base64')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': aloneContentSecurityPolicy(nonce), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    })
    res.end(alonePage(env.label, why, nonce))
  }

  function handlePublic(req: IncomingMessage, res: ServerResponse): void {
    // This server's own answers, whoever leads: the page asks /_alone/state to know when to leave.
    if ((req.url ?? '').startsWith(ALONE_PREFIX)) {
      void aloneApi.handle(req, res)
      return
    }
    const route = routeNow()
    if (route.kind === 'alone') return answerAlone(req, res, route.why)
    forwardHttp(req, res, target(route), (err) => {
      suspectOf(route.kind, err)
      const next = routeNow()
      // A read may go to the next one; a write that may have reached the first is never repeated.
      if (next.kind !== 'alone' && next.kind !== route.kind && (req.method === 'GET' || req.method === 'HEAD')) {
        forwardHttp(req, res, target(next), (err2) => { suspectOf(next.kind, err2); answerAlone(req, res, 'nobody-answers') })
        return
      }
      answerAlone(req, res, next.kind === 'alone' ? next.why : 'nobody-answers')
    })
  }

  function handlePublicUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = routeNow()
    if (route.kind === 'alone') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    forwardUpgrade(req, socket, head, target(route), (err) => {
      suspectOf(route.kind, err)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
  }

  function statusBody(): Record<string, unknown> {
    const view = link.view()
    const route = routeNow()
    return {
      version: build.version,
      commit: build.commit,
      pid: process.pid,
      startedAt,
      port: env.publicPort,
      route: route.kind === 'alone' ? { kind: 'alone', why: route.why } : { kind: route.kind },
      daemon: { state: link.state(), lastError: link.lastError(), at: view?.at ?? null },
      expose: expose.status(),
      // Which device list the alone answers check against (null: none from the Mac yet).
      deviceCopy: devices.hash(),
    }
  }

  let replicaRouter: http.RequestListener | null = null
  async function handleFromLeader(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://follower')
      if (req.method === 'GET' && url.pathname === '/host-api/status') return sendJson(res, 200, { ok: true, ...statusBody() })
      if (url.pathname === '/bridge/replica') {
        if (!replicaRouter) {
          const [{ default: express }, { createLinkedReplicaRouter }] = await Promise.all([
            import('express'), import('../web/routes/bridge-replica.js'),
          ])
          const app = express()
          app.use('/bridge/replica', createLinkedReplicaRouter({ devices: (body) => devices.put(body) }))
          replicaRouter = app
        }
        replicaRouter(req, res)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not_found' })
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const publicServer = http.createServer(handlePublic)
  publicServer.on('upgrade', handlePublicUpgrade)
  publicServer.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* gone */ } })
  const port = await listen(publicServer, env.publicPort)
  // The leader's search index copy (core/replication/search-replica-store.ts):
  // the Mac's rounds reach it on /bridge/replica above; semantic search while it is away.
  const { startSearchReplicaStore } = await import('../core/replication/search-replica-store.js')
  const searchCopy = startSearchReplicaStore()
  link.start()
  const reportTimer = setInterval(() => { link.report(statusBody()) }, REPORT_MS)
  reportTimer.unref?.()
  log.web.info('host server: listening', { port, version: build.version, commit: build.commit })

  return {
    route: routeNow,
    port,
    async stop() {
      clearInterval(reportTimer)
      link.stop()
      await searchCopy.stop().catch(() => {})
      // An embed run still in flight at exit aborts the process (libc++abi, exit 134).
      await (await import('../core/search/wiring.js')).closeSearchV2Index().catch(() => {})
      await expose.stop()
      publicServer.closeAllConnections?.()
      fromLeader.closeAllConnections?.()
      await new Promise<void>((r) => publicServer.close(() => r()))
    },
  }
}

/** `open-walnut host-server`: run until the daemon stops it. */
export async function runHostServer(): Promise<void> {
  const server = await startHostServer()
  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    log.web.info('host server: stopping', { signal })
    const force = setTimeout(() => process.exit(0), 8_000)
    force.unref?.()
    void server.stop().finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}
