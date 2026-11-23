/**
 * The cloud companion's listener door (`/host-listen`, listener-wire.ts; manifest:
 * capabilities/bridge-door.ts): a host that runs and judges its own sessions dials in with its own
 * /bridge machine token, and the companion listens to its session channel (companion-listener.ts).
 *
 *   1. before the upgrade: the bearer is a machine token (verifyCloudUpgrade in ws/handler.ts, which
 *      counts failures toward the address's rate limit), a host's `bridge-<alias>` record with more
 *      than status-only scope; the Mac's own (`bridge-local`) is no host's and is refused
 *   2. the door is open only while the leader's heartbeat says its switch host_runs_sessions is on
 *      (or this box's own switch is) and the companion knows the Walnut it serves (the heartbeat's
 *      walnutId): else 503, and the host tries again later
 *   3. the host's hello must name that Walnut and the alias the token was minted for (as the
 *      /bridge registry binds a token to its host, bridge-registry.ts tokenBoundAlias), else 4001
 *   4. the welcome names the listener role and the Walnut: no proof (the companion proves itself by
 *      TLS on its own domain, as for /bridge) and no standing (it never leads)
 *
 * Revoke: a revoke in this process closes that host's socket at once (onCredentialsRevoked) and
 * forgets what it told (companion-listener.ts forgetHostListener); every socket checks its token
 * again every LISTEN_RECHECK_MS, and the door's own state with it: a door that shut meanwhile (the
 * Mac turned the switch off, or another Walnut) closes the link.
 *
 * The bearer rides the Authorization header or a subprotocol entry only: a `?token=` in the URL
 * (it would reach a proxy's access log) is refused before anything reads it.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from '#ws'
import { selectWsProtocol } from '../../lib/ws-bearer-protocol.js'
import { closeGoingAway } from '../../lib/ws-going-away.js'
import { log } from '../../logging/index.js'
import { isListenerFrame, LISTEN_CLOSE, type ListenerFrame } from './listener-wire.js'
import { attachHostListener, forgetHostListener } from './companion-listener.js'

export const LISTEN_RECHECK_MS = 60_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_PAYLOAD = 64 * 1024 * 1024

/** The credential verifyCloudUpgrade answers (ws/handler.ts). */
export interface ListenerCredential { name: string; kind: string; bridgeScope?: 'status-only'; stillValid: () => Promise<boolean> }

/** The host alias a machine token was minted for (`bridge-<alias>`, cloud-bridge-config.ts), or null for the Mac's own. */
export function aliasOfBridgeToken(name: string): string | null {
  if (!name.startsWith('bridge-')) return null
  const alias = name.slice('bridge-'.length)
  return alias && alias !== 'local' ? alias : null
}

/** Is the door open now, and for which Walnut: the leader's heartbeat (or this box's switch) and its Walnut id. */
export async function listenerDoorWalnut(): Promise<string | null> {
  const [{ getBackupLeader }, { hostRunsSessionsAnyNow }] = await Promise.all([import('../leader/backup-leader.js'), import('./switch.js')])
  const status = (await getBackupLeader())?.status() ?? null
  if (!status?.walnutId) return null
  return status.hostRunsSessions || await hostRunsSessionsAnyNow() ? status.walnutId : null
}

let wss: WebSocketServer | null = null
let unlisten: (() => void) | null = null
/** Live sockets by credential name, for a revoke. */
const live = new Map<string, Set<WebSocket>>()

const STATUS_LINE = { 400: 'Bad Request', 401: 'Unauthorized', 503: 'Service Unavailable' } as const

function refuse(socket: Duplex, status: 400 | 401 | 503): void {
  if (!socket.destroyed) socket.write(`HTTP/1.1 ${status} ${STATUS_LINE[status]}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function server(): WebSocketServer {
  // A bearer offered as a subprotocol entry is never echoed back (ws-bearer-protocol.ts).
  wss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, handleProtocols: (protocols) => selectWsProtocol(protocols) })
  if (!unlisten) {
    void import('../device-auth.js').then(({ onCredentialsRevoked }) => {
      unlisten ??= onCredentialsRevoked((names) => {
        for (const name of names) {
          for (const ws of live.get(name) ?? []) { try { ws.close(LISTEN_CLOSE.revoked, 'revoked') } catch { ws.terminate() } }
          const alias = aliasOfBridgeToken(name)
          if (alias) forgetHostListener(alias)
        }
      })
    }, () => {})
  }
  return wss
}

/** The server stops: every listener socket closes going away (its host dials again), and the door's server goes. */
export function closeHostListenerDoor(): number {
  let n = 0
  for (const set of live.values()) for (const ws of set) { n++; closeGoingAway(ws) }
  live.clear()
  unlisten?.()
  unlisten = null
  wss?.close()
  wss = null
  return n
}

/** The `/host-listen` upgrade (src/web/ws/handler.ts): `verify` runs before anything else. */
export async function handleHostListenUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, o: { verify: () => Promise<ListenerCredential | null>; walnut?: () => Promise<string | null> }): Promise<void> {
  if (new URL(request.url ?? '/', 'http://door').searchParams.has('token')) return refuse(socket, 400)
  let cred: ListenerCredential | null = null
  try { cred = await o.verify() } catch { cred = null }
  if (!cred || cred.kind !== 'machine' || cred.bridgeScope === 'status-only' || !cred.name.startsWith('bridge-')) return refuse(socket, 401)
  const alias = aliasOfBridgeToken(cred.name)
  if (!alias) return refuse(socket, 401)
  const doorWalnut = o.walnut ?? listenerDoorWalnut
  const walnutId = await doorWalnut().catch(() => null)
  if (!walnutId || socket.destroyed) return refuse(socket, 503)
  const c = cred
  server().handleUpgrade(request, socket, head, (ws) => attachListenerSocket(ws, { alias, walnutId, name: c.name, stillValid: c.stillValid, doorWalnut }))
}

/** One listener socket: the hello, the welcome, then companion-listener.ts takes it. */
export function attachListenerSocket(ws: WebSocket, o: { alias: string; walnutId: string; name: string; stillValid(): Promise<boolean>; doorWalnut?: () => Promise<string | null>; recheckMs?: number }): void {
  const close = (code: number, why: string): void => { try { ws.close(code, why.slice(0, 100)) } catch { ws.terminate() } }
  if (!live.has(o.name)) live.set(o.name, new Set())
  live.get(o.name)!.add(ws)
  const helloTimer = setTimeout(() => close(LISTEN_CLOSE.mismatch, 'no_hello'), HELLO_TIMEOUT_MS)
  helloTimer.unref?.()
  const recheck = setInterval(() => {
    void o.stillValid().then(async (ok) => {
      if (!ok) { close(LISTEN_CLOSE.revoked, 'revoked'); forgetHostListener(o.alias); return }
      // The door shut meanwhile (the switch off on the Mac, or another Walnut): the link goes too.
      if (o.doorWalnut && await o.doorWalnut().catch(() => null) !== o.walnutId) close(LISTEN_CLOSE.shut, 'door_shut')
    }, () => {})
  }, o.recheckMs ?? LISTEN_RECHECK_MS)
  recheck.unref?.()
  let handlers: ReturnType<typeof attachHostListener> | null = null
  ws.on('message', (raw) => {
    const text = String(raw)
    if (handlers) { handlers.onText(text); return }
    let f: unknown
    try { f = JSON.parse(text) } catch { f = null }
    const hello = isListenerFrame(f) && f.op === 'hello' ? f : null
    if (!hello || hello.v !== 1 || hello.role !== 'listener' || hello.walnutId !== o.walnutId || hello.hostAlias !== o.alias) {
      log.web.warn('listener door: a hello did not name this Walnut and the token\'s host; closed', { host: o.alias })
      close(LISTEN_CLOSE.mismatch, 'mismatch')
      return
    }
    clearTimeout(helloTimer)
    const welcome: ListenerFrame = { ch: 'door', op: 'welcome', role: 'listener', walnutId: o.walnutId }
    ws.send(JSON.stringify(welcome))
    void import('./companion-host-ops.js').then((ops) => ops.watchMacAway(), () => {})
    handlers = attachHostListener(o.alias, o.walnutId, {
      send: (t) => { if (ws.readyState === ws.OPEN) ws.send(t) },
      close: (code, why) => close(code, why),
    })
  })
  ws.on('close', () => {
    clearTimeout(helloTimer)
    clearInterval(recheck)
    live.get(o.name)?.delete(ws)
    if (live.get(o.name)?.size === 0) live.delete(o.name)
    handlers?.onClose()
  })
  ws.on('error', () => { /* a close follows */ })
}
