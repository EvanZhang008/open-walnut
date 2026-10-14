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
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DeviceCopy } from '../host-server/device-copy.js'

export interface LeaderDoor {
  /** A stream the host daemon accepted from the Mac (`primary`): served here. */
  accept(stream: Duplex): void
  close(): Promise<void>
}

export interface LeaderDoorOptions {
  devices: DeviceCopy
  /** What `GET /host-api/status` answers (the replica's report). */
  status?: () => Record<string, unknown>
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function createLeaderDoor(opts: LeaderDoorOptions): LeaderDoor {
  let replicaRouter: http.RequestListener | null = null

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://leader-door')
      if (req.method === 'GET' && url.pathname === '/host-api/status') {
        return sendJson(res, 200, { ok: true, ...(opts.status?.() ?? {}) })
      }
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
