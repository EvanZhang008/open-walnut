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
 * Revoke: a revoke in this process closes that host's socket at once (onCredentialsRevoked), and
 * every socket checks its token again every LISTEN_RECHECK_MS.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from '#ws'
import { selectWsProtocol } from '../../lib/ws-bearer-protocol.js'
import { log } from '../../logging/index.js'
import { isListenerFrame, LISTEN_CLOSE, type ListenerFrame } from './listener-wire.js'
import { attachHostListener } from './companion-listener.js'

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
  const [{ getBackupLeader }, { hostRunsSessionsNow }] = await Promise.all([import('../leader/backup-leader.js'), import('./switch.js')])
  const status = (await getBackupLeader())?.status() ?? null
  if (!status?.walnutId) return null
  return status.hostRunsSessions || await hostRunsSessionsNow() ? status.walnutId : null
}

let wss: WebSocketServer | null = null
let unlisten: (() => void) | null = null
/** Live sockets by credential name, for a revoke. */
const live = new Map<string, Set<WebSocket>>()

function refuse(socket: Duplex, status: 401 | 503): void {
  if (!socket.destroyed) socket.write(status === 401 ? 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n' : 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
  socket.destroy()
}

function server(): WebSocketServer {
  // A bearer offered as a subprotocol entry is never echoed back (ws-bearer-protocol.ts).
  wss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, handleProtocols: (protocols) => selectWsProtocol(protocols) })
  if (!unlisten) {
    void import('../device-auth.js').then(({ onCredentialsRevoked }) => {
      unlisten ??= onCredentialsRevoked((names) => {
        for (const name of names) for (const ws of live.get(name) ?? []) { try { ws.close(LISTEN_CLOSE.revoked, 'revoked') } catch { ws.terminate() } }
      })
    }, () => {})
  }
  return wss
}

/** The `/host-listen` upgrade (src/web/ws/handler.ts): `verify` runs before anything else. */
export async function handleHostListenUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, o: { verify: () => Promise<ListenerCredential | null>; walnut?: () => Promise<string | null> }): Promise<void> {
  let cred: ListenerCredential | null = null
  try { cred = await o.verify() } catch { cred = null }
  if (!cred || cred.kind !== 'machine' || cred.bridgeScope === 'status-only' || !cred.name.startsWith('bridge-')) return refuse(socket, 401)
  const alias = aliasOfBridgeToken(cred.name)
  if (!alias) return refuse(socket, 401)
  const walnutId = await (o.walnut ?? listenerDoorWalnut)().catch(() => null)
  if (!walnutId || socket.destroyed) return refuse(socket, 503)
  const c = cred
  server().handleUpgrade(request, socket, head, (ws) => attachListenerSocket(ws, { alias, walnutId, name: c.name, stillValid: c.stillValid }))
}

/** One listener socket: the hello, the welcome, then companion-listener.ts takes it. */
export function attachListenerSocket(ws: WebSocket, o: { alias: string; walnutId: string; name: string; stillValid(): Promise<boolean>; recheckMs?: number }): void {
  const close = (code: number, why: string): void => { try { ws.close(code, why.slice(0, 100)) } catch { ws.terminate() } }
  if (!live.has(o.name)) live.set(o.name, new Set())
  live.get(o.name)!.add(ws)
  const helloTimer = setTimeout(() => close(LISTEN_CLOSE.mismatch, 'no_hello'), HELLO_TIMEOUT_MS)
  helloTimer.unref?.()
  const recheck = setInterval(() => {
    void o.stillValid().then((ok) => { if (!ok) close(LISTEN_CLOSE.revoked, 'revoked') }, () => {})
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
