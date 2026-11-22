/**
 * The leader's door a host dials into (`/host-door`, door-wire.ts): served by the leader while the
 * experiment host_runs_sessions is on (leader-doors.ts; the cloud companion serves none in this
 * land). A host's own door is the channel route it already has (`/host-api/session-channel`,
 * host-routes.ts), reached through its daemon link as before: the leader dials that one.
 *
 *   1. before the upgrade: the host's door credential (host-credentials.ts), as Authorization:
 *      Bearer or a `walnut.bearer.` subprotocol entry, never `?token=`; a wrong one answers 401 and
 *      counts toward the address's auth rate limit, as every other door's does
 *   2. the host's hello must name this Walnut and the credential's machine (else close 4001)
 *   3. the welcome proves this leader: the HMAC of the verify key that belongs to the token used
 *      over the hello's nonce and this leader's standing (leader-boot.ts leaderStandingOf)
 *   4. the socket is handed to the leader side (leader-side.ts adopt) as the record's host key's
 *      link; host calls ride it as call/reply frames (leader-links.ts ChannelSocket.call)
 *
 * The welcome carries this leader's door list (session.host_door_urls); pushDoorsToDialed sends a
 * changed one to every welcomed socket at once (leader-boot.ts pushHostDoors).
 *
 * Revoke: a revoke in this process (host-credentials.ts dropHostCredential, the device revoke
 * paths) closes that machine's sockets at once (onCredentialsRevoked); every socket also checks
 * its record again every DOOR_RECHECK_MS, which is how a revoke made by another process (the CLI)
 * or a token past its grace closes it.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import crypto from 'node:crypto'
import { WebSocketServer, type WebSocket } from '#ws'
import { upgradeCredential } from '../../web/ws/upgrade-credential.js'
import { selectWsProtocol } from '../../lib/ws-bearer-protocol.js'
import { HostRequestNotSent, type ChannelSocket } from './leader-links.js'
import { verifyHostCredential, type DoorCredentialMatch } from './host-credentials.js'
import { DOOR_CLOSE, DOOR_SECRET_RE, doorProof, isDoorFrame, type DoorFrame } from './door-wire.js'
import type { LeaderStanding } from './leader-boot.js'

/** How often a door socket checks that its credential still stands. */
export const DOOR_RECHECK_MS = 60_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_PAYLOAD = 64 * 1024 * 1024

export interface HostDoorAuth {
  match: DoorCredentialMatch
  /** Is the token this socket opened with still this record's (a recheck)? */
  stillValid(): Promise<boolean>
}

export interface HostDoorDeps {
  walnutId(): Promise<string>
  standing(hostKey: string): LeaderStanding | null
  /** This leader's door list now (session.host_door_urls, cleaned), told in every welcome (absent: none told). */
  doors?(): Promise<string[]>
  /** The leader side takes the socket as `hostKey`'s link (leader-side.ts adopt). */
  adopt(hostKey: string, sock: ChannelSocket): boolean
  recheckMs?: number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

let deps: HostDoorDeps | null = null
let wss: WebSocketServer | null = null
/** Live door sockets, by the credential's device name (host-<machineId>). */
const live = new Map<string, Set<WebSocket>>()
/** The welcomed ones, with their host key. */
const welcomedSockets = new Map<WebSocket, string>()

/**
 * The door's credential check, before the upgrade: the bearer the host presents is one of this
 * leader's host door credentials (constant time, a previous token within its grace). Null: refuse 401.
 */
export async function verifyHostDoorUpgrade(url: URL, request: IncomingMessage): Promise<HostDoorAuth | null> {
  const [{ rateLimitClientIp }, { isAuthRateLimited, recordAuthFailure }] = await Promise.all([
    import('../../web/middleware/local-trust.js'), import('../../web/middleware/auth-rate-limit.js'),
  ])
  const ip = rateLimitClientIp(request)
  if (isAuthRateLimited(ip)) return null
  // The token is a bearer: never taken from the URL, where proxies log it.
  if (url.searchParams.has('token')) { recordAuthFailure(ip); return null }
  const presented = upgradeCredential(request, url)
  if (presented.kind !== 'token') { if (presented.kind === 'malformed') recordAuthFailure(ip, presented.raw); return null }
  const match = await verifyHostCredential(presented.token)
  if (!match) { recordAuthFailure(ip, presented.token); return null }
  const token = presented.token
  return {
    match,
    stillValid: async () => {
      const now = await verifyHostCredential(token)
      return !!now && now.record.name === match.record.name && now.record.machineId === match.record.machineId
    },
  }
}

function refuse(socket: Duplex, status: 401 | 503): void {
  if (!socket.destroyed) socket.write(status === 401 ? 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n' : 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
  socket.destroy()
}

/** The `/host-door` upgrade (src/web/ws/handler.ts): `verify` runs before anything else. */
export async function handleHostDoorUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, o: { verify: () => Promise<HostDoorAuth | null> }): Promise<void> {
  let auth: HostDoorAuth | null = null
  try { auth = await o.verify() } catch { auth = null }
  if (!auth) return refuse(socket, 401)
  if (!deps || !wss || socket.destroyed) return refuse(socket, 503)
  const d = deps
  const a = auth
  wss.handleUpgrade(request, socket, head, (ws) => attachDoorSocket(ws, a, d))
}

/** One door socket: the hello, the welcome, then the leader side's link. */
export function attachDoorSocket(ws: WebSocket, auth: HostDoorAuth, d: HostDoorDeps): void {
  const rec = auth.match.record
  const name = rec.name
  const hostKey = rec.hostKey ?? ''
  const close = (code: number, why: string): void => { try { ws.close(code, why.slice(0, 100)) } catch { ws.terminate() } }
  if (!live.has(name)) live.set(name, new Set())
  live.get(name)!.add(ws)
  const helloTimer = setTimeout(() => close(DOOR_CLOSE.mismatch, 'no_hello'), HELLO_TIMEOUT_MS)
  helloTimer.unref?.()
  const recheck = setInterval(() => {
    void auth.stillValid().then((ok) => { if (!ok) { d.log('info', 'host door: a credential no longer stands; its socket is closed', { host: hostKey }); close(DOOR_CLOSE.revoked, 'revoked') } }, () => {})
  }, d.recheckMs ?? DOOR_RECHECK_MS)
  recheck.unref?.()

  let welcomed = false
  let helloSeen = false
  let onText: ((text: string) => void) | null = null
  const held: string[] = []
  let onGone: (() => void) | null = null
  let closed = false
  const pending = new Map<string, { resolve(v: { status: number; body: unknown }): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>()

  ws.on('message', (raw) => {
    const text = String(raw)
    if (!welcomed) {
      // Only the first frame is the hello; anything after it waits for the welcome with the rest.
      if (helloSeen) { held.push(text); return }
      helloSeen = true
      void welcome(text)
      return
    }
    let frame: unknown
    try { frame = JSON.parse(text) } catch { return }
    if (isDoorFrame(frame)) {
      if (frame.op === 'reply') {
        const p = pending.get(String(frame.id))
        if (!p) return
        pending.delete(String(frame.id))
        clearTimeout(p.timer)
        p.resolve({ status: Number(frame.status) || 0, body: frame.body })
      }
      return
    }
    if (onText) onText(text)
    else held.push(text)
  })
  ws.on('close', () => {
    closed = true
    clearTimeout(helloTimer)
    clearInterval(recheck)
    live.get(name)?.delete(ws)
    if (live.get(name)?.size === 0) live.delete(name)
    welcomedSockets.delete(ws)
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('the host-dialed link closed before the host answered')) }
    pending.clear()
    onGone?.()
  })
  ws.on('error', () => { /* a close follows */ })

  async function welcome(text: string): Promise<void> {
    let f: unknown
    try { f = JSON.parse(text) } catch { f = null }
    const hello = isDoorFrame(f) && f.op === 'hello' ? f : null
    const walnutId = await d.walnutId().catch(() => '')
    if (!hello || hello.v !== 1 || !walnutId || hello.walnutId !== walnutId || hello.machineId !== rec.machineId || typeof hello.nonce !== 'string' || !DOOR_SECRET_RE.test(hello.nonce)) {
      d.log('warn', 'host door: a hello did not name this Walnut and the credential\'s machine; closed', { host: hostKey })
      return close(DOOR_CLOSE.mismatch, 'mismatch')
    }
    const standing = d.standing(hostKey)
    if (!standing || !hostKey) return close(1013, 'not_serving')
    clearTimeout(helloTimer)
    const { permitNumber, epoch } = standing.pair
    const proof = doorProof(auth.match.verifyKey, { nonce: hello.nonce, walnutId, machineId: hello.machineId, permitNumber, epoch })
    const doors = await (d.doors?.() ?? Promise.resolve([])).catch(() => [] as string[])
    const frame: DoorFrame = { ch: 'door', op: 'welcome', walnutId, holder: standing.holder, permitNumber, epoch, ...(doors.length > 0 ? { doors } : {}), proof }
    if (closed) return
    ws.send(JSON.stringify(frame))
    welcomed = true
    welcomedSockets.set(ws, hostKey)
    d.log('info', 'host door: a host dialed in', { host: hostKey, which: auth.match.which })
    const sock: ChannelSocket = {
      kind: 'host-dialed',
      send: (t) => { if (ws.readyState === ws.OPEN) ws.send(t) },
      close: (why) => close(why === 'replaced' ? DOOR_CLOSE.replaced : 1000, why ?? 'closed'),
      onMessage: (fn) => { onText = fn; for (const t of held.splice(0)) fn(t) },
      onClose: (fn) => { onGone = fn; if (closed) fn() },
      call: (method, route, body, timeoutMs) => new Promise((resolve, reject) => {
        if (closed || ws.readyState !== ws.OPEN) { reject(new HostRequestNotSent(hostKey, new Error('the host-dialed link is closed'))); return }
        const id = crypto.randomBytes(9).toString('hex')
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the host did not answer ${route} in ${timeoutMs} ms`)) }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        const call: DoorFrame = { ch: 'door', op: 'call', id, method, path: route, body }
        try { ws.send(JSON.stringify(call)) } catch (err) {
          pending.delete(id)
          clearTimeout(timer)
          reject(new HostRequestNotSent(hostKey, err))
        }
      }),
    }
    if (!d.adopt(hostKey, sock)) close(1001, 'stopping')
  }
}

/** Send `doors` to every welcomed door socket now (a `doors` frame): the host keys told. */
export function pushDoorsToDialed(doors: readonly string[]): string[] {
  const told: string[] = []
  const frame = JSON.stringify({ ch: 'door', op: 'doors', doors: [...doors] } satisfies DoorFrame)
  for (const [ws, hostKey] of welcomedSockets) {
    if (ws.readyState !== ws.OPEN) continue
    try { ws.send(frame); told.push(hostKey) } catch { /* it closes; its host hears the list at its next welcome */ }
  }
  return [...new Set(told)]
}

/** Close every live door socket of these credential names now (a revoke heard in this process). */
export function closeDoorSockets(names: readonly string[]): number {
  let n = 0
  for (const name of names) {
    for (const ws of live.get(name) ?? []) { n++; try { ws.close(DOOR_CLOSE.revoked, 'revoked') } catch { ws.terminate() } }
  }
  return n
}

/** Serve the door in this process (leader-boot.ts): returns the stop. */
export async function startHostDoor(d: HostDoorDeps): Promise<() => void> {
  deps = d
  // A bearer offered as a subprotocol entry is never echoed back (ws-bearer-protocol.ts).
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, handleProtocols: (protocols) => selectWsProtocol(protocols) })
  const { onCredentialsRevoked } = await import('../device-auth.js')
  const unlisten = onCredentialsRevoked((names) => {
    const n = closeDoorSockets(names.filter((x) => x.startsWith('host-')))
    if (n > 0) d.log('info', 'host door: closed the sockets of a revoked credential', { sockets: n })
  })
  return () => {
    unlisten()
    for (const set of live.values()) for (const ws of set) { try { ws.close(1001, 'stopping') } catch { ws.terminate() } }
    live.clear()
    welcomedSockets.clear()
    wss?.close()
    wss = null
    if (deps === d) deps = null
  }
}
