/**
 * The leader door of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 1): a SECOND http server that listens on no port. It is fed only by
 * the streams the host daemon accepts from `primary` (the Mac's own link to
 * that daemon, stream-relay-core.ts); the follower link (WP2) hands each such
 * stream to `accept`.
 *
 * Everything the Mac sends a follower comes in here and only here: the copies
 * (`POST /bridge/replica`, every kind), `/host-api/*` and `/git/data`. The
 * linked replica router has no credential of its own (bridge-replica.ts): the
 * door is the credential. The public app answers 404 for `/bridge/*` and
 * `/git/data` (replicaPublicRefusal below), so a browser or anything else
 * reaching the tunnel port can never write a copy.
 *
 * The session routes of a host that runs its sessions (`/host-api/sessions/*` and the
 * `/host-api/session-channel` WebSocket, core/session-channel/host-routes.ts) live here too;
 * without them (the switch off at boot) each answers `host_runs_sessions_off`.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DeviceCopy } from '../host-server/device-copy.js'
import { answerHostSessionsOff, isHostSessionsPath, refuseChannelUpgrade, type HostSessionRoutes } from '../core/session-channel/host-routes.js'

export interface LeaderDoor {
  /** A stream the host daemon accepted from the Mac (`primary`): served here. */
  accept(stream: Duplex): void
  close(): Promise<void>
}

/** Where `/host-api/witness/*` is served (core/leader/switch/witness-route.ts). Tests pass their own; absent: this machine's. */
export interface WitnessDoorOptions {
  /** Whether the experiment `switchable_leader` is on here (a host's config is a copy of the leader's). */
  enabled(): Promise<boolean>
  /** The Walnut this service follows. */
  walnutId(): string | null
  /** Where this machine keeps witness records (default: beside this machine's id file). */
  root?(): string
}

/** The witness route's own prefix, spelled here so the door loads nothing of the switch to compare a path. */
const WITNESS_PATH_PREFIX = '/host-api/witness/'

export interface LeaderDoorOptions {
  devices: DeviceCopy
  /** `/host-api/witness/*`: a machine's witness of the write permission. */
  witness?: WitnessDoorOptions
  /** What `GET /host-api/status` answers (the replica's report). */
  status?: () => Record<string, unknown>
  /** The session routes of a host that runs its sessions, once installed (null: none). */
  sessions?: () => HostSessionRoutes | null
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * A witness call, answered when the experiment `switchable_leader` is on here. Off, nothing of the
 * permit is loaded and the path falls through to the same 404 it has always had.
 */
async function witnessAnswered(req: IncomingMessage, res: ServerResponse, opts: LeaderDoorOptions): Promise<boolean> {
  const own = opts.witness ?? await defaultWitnessDoor()
  if (!(await own.enabled())) return false
  const [{ handleWitnessHttp }, { witnessRoot }] = await Promise.all([import('../core/leader/switch/witness-route.js'), import('../core/leader/switch/machine-id.js')])
  await handleWitnessHttp(req, res, { walnutId: own.walnutId, root: own.root?.() ?? witnessRoot(), log: opts.log })
  return true
}

async function defaultWitnessDoor(): Promise<WitnessDoorOptions> {
  return {
    enabled: async () => {
      const [{ getConfig }, { experimentalEnabled }] = await Promise.all([import('../core/config-manager.js'), import('../core/experimental.js')])
      return experimentalEnabled((await getConfig()).experimental, 'switchable_leader')
    },
    walnutId: () => (process.env.WALNUT_WALNUT_ID ?? '').trim() || null,
  }
}

export function createLeaderDoor(opts: LeaderDoorOptions): LeaderDoor {
  let replicaRouter: http.RequestListener | null = null

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://leader-door')
      if (req.method === 'GET' && url.pathname === '/host-api/status') {
        return sendJson(res, 200, { ok: true, ...(opts.status?.() ?? {}) })
      }
      if (url.pathname.startsWith(WITNESS_PATH_PREFIX) && await witnessAnswered(req, res, opts)) return
      if (url.pathname === '/bridge/replica') {
        if (!replicaRouter) {
          const [{ default: express }, { createLinkedReplicaRouter }] = await Promise.all([
            import('express'), import('../web/routes/bridge-replica.js'),
          ])
          const app = express()
          app.use('/bridge/replica', createLinkedReplicaRouter({ devices: (body) => opts.devices.put(body) }))
          replicaRouter = app
        }
        replicaRouter(req, res)
        return
      }
      if (isHostSessionsPath(url.pathname)) {
        const routes = opts.sessions?.() ?? null
        if (routes?.handle(req, res)) return
        req.resume()
        return answerHostSessionsOff(res)
      }
      // `/git/data` and the rest of `/bridge/*` belong here too; a host replica
      // keeps no data hub yet, so they answer 404 on this side as well.
      sendJson(res, 404, { ok: false, error: 'not_found' })
    } catch (err) {
      opts.log?.('warn', 'leader door: a request failed', { path: req.url, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res) })
  server.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* gone */ } })
  // Only the session channel upgrades here; any other upgrade is refused.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => { /* a stream that went: nothing to answer */ })
    const routes = opts.sessions?.() ?? null
    if (routes?.upgrade(req, socket, head)) return
    const pathname = new URL(req.url ?? '/', 'http://leader-door').pathname
    if (isHostSessionsPath(pathname)) return refuseChannelUpgrade(socket)
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })

  return {
    accept(stream) {
      server.emit('connection', stream)
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Paths the PUBLIC app of a host replica refuses with 404 (they live on the leader door only). */
export function isLeaderDoorPath(raw: string): boolean {
  // Express routes case-insensitively and a client may double a slash or encode one.
  let pathname = raw
  try { pathname = decodeURIComponent(raw) } catch { /* keep it as sent */ }
  pathname = pathname.toLowerCase().replace(/\/{2,}/g, '/')
  return pathname === '/bridge' || pathname.startsWith('/bridge/')
    || pathname === '/git/data' || pathname.startsWith('/git/data/')
    || pathname === '/host-api' || pathname.startsWith('/host-api/')
}

/** Express middleware for the public app of a host replica: the leader door's paths are 404 here. */
export function replicaPublicRefusal(req: IncomingMessage & { path?: string }, res: ServerResponse, next: () => void): void {
  const pathname = req.path ?? new URL(req.url ?? '/', 'http://public').pathname
  if (!isLeaderDoorPath(pathname)) { next(); return }
  sendJson(res, 404, { ok: false, error: 'not_found' })
}
