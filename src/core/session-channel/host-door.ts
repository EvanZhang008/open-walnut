/**
 * The leader's door a host dials into (`/host-door`, door-wire.ts): served by the leader while the
 * experiment host_runs_sessions is on (leader-doors.ts; the cloud companion serves none in this
 * land). A host's own door is the channel route it already has (`/host-api/session-channel`,
 * host-routes.ts), reached through its daemon link as before: the leader dials that one.
 *
 *   1. the upgrade carries no secret: refused 429 while the address is rate limited (auth failures
 *      of every door count, a failed proof here too), 503 when the door cannot check right now
 *   2. hello: names this Walnut and a machine whose credential this leader keeps, for a host still
 *      in its config (else closed DOOR_CLOSE.unknown, or mismatch for another Walnut)
 *   3. welcome: this leader's proof over both nonces and its standing (leader-boot.ts
 *      leaderStandingOf), one per key the host may hold (the current one, the previous one within
 *      its grace)
 *   4. auth: the host's proof (constant time); until it passed nothing but the hello and the auth
 *      is taken from the socket and nothing but the welcome is sent to it, within AUTH_TIMEOUT_MS
 *      and PRE_AUTH_MAX_BYTES (counted on the raw socket, so a large frame is cut before it is
 *      assembled); at most PRE_AUTH_PER_ADDRESS unauthenticated sockets per address and
 *      PRE_AUTH_TOTAL in all (more answer 429), and at most PENDING_PER_MACHINE of one machine from
 *      one address waiting for their auth (a newer one is refused, never the one waiting)
 *   5. linkDoorSocket: the door list is told, and the socket is handed to the leader side
 *      (leader-side.ts adopt) under the record's host key; host calls ride it as call/reply frames
 *      (leader-links.ts ChannelSocket.call). Another listener that authenticates its own way (the
 *      companion's) hands its sockets to linkDoorSocket too.
 *
 * Revoke: a revoke in this process (host-credentials.ts dropHostCredential, revokeHostDoor, a host
 * removed from the config) closes that machine's sockets at once (onCredentialsRevoked); every
 * linked socket also checks its record again every DOOR_RECHECK_MS (it still exists, still names
 * its host key, that host is still configured, the key it proved with still counts), which is how
 * a revoke made by another process or a previous key past its grace closes it.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import crypto from 'node:crypto'
import { WebSocketServer, type WebSocket } from '#ws'
import { closeGoingAway } from '../../lib/ws-going-away.js'
import { selectWsProtocol } from '../../lib/ws-bearer-protocol.js'
import { HostRequestNotSent, type ChannelSocket } from './leader-links.js'
import { doorKeysOf, hostCredentialName, hostCredentialOf, MACHINE_ID_RE, type DoorKey } from './host-credentials.js'
import { hostRevokedNow } from './revoked-hosts.js'
import { DOOR_CLOSE, DOOR_SECRET_RE, doorSecret, hostDoorProof, isDoorFrame, leaderDoorProof, proofsEqual, type DoorFrame } from './door-wire.js'
import type { LeaderStanding } from './leader-boot.js'

/** How often a linked door socket checks that its credential still stands. */
export const DOOR_RECHECK_MS = 60_000
/** The hello and the auth must both come within this. */
export const AUTH_TIMEOUT_MS = 10_000
/** Bytes a socket may send before its auth passed (the hello and the auth are a few hundred). */
export const PRE_AUTH_MAX_BYTES = 8 * 1024
/** Sockets of one machine from one address that may wait for their auth at once; a newer one is refused. */
export const PENDING_PER_MACHINE = 2
/** Unauthenticated sockets one address may hold at once, and all addresses together; more answer 429. */
export const PRE_AUTH_PER_ADDRESS = 4
export const PRE_AUTH_TOTAL = 64
const MAX_PAYLOAD = 64 * 1024 * 1024

export interface HostDoorDeps {
  walnutId(): Promise<string>
  standing(hostKey: string): LeaderStanding | null
  /** This leader's door list now (session.host_door_urls, cleaned), told once a socket is linked (absent: none). */
  doors?(): Promise<string[]>
  /** Is `hostKey` still a host in this leader's config (absent: every host is)? */
  configured?(hostKey: string): boolean | Promise<boolean>
  /** The leader side takes the socket as `hostKey`'s link (leader-side.ts adopt). */
  adopt(hostKey: string, sock: ChannelSocket): boolean
  recheckMs?: number
  authTimeoutMs?: number
  /** Tests: other caps than PRE_AUTH_PER_ADDRESS and PRE_AUTH_TOTAL. */
  preAuthPerAddress?: number
  preAuthTotal?: number
  now?: () => number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

/** The upgrade's check: go on (with the address failures count against), or refuse with a status. */
export type DoorUpgradeCheck = { ok: true; ip: string } | { ok: false; status: 429 | 503 }

let deps: HostDoorDeps | null = null
let wss: WebSocketServer | null = null
/** Sockets by the credential's device name (host-<machineId>): waiting for their auth, and linked. */
const pending = new Map<string, WebSocket[]>()
/**
 * Revokes per credential name (closeDoorSockets): a handshake that read its keys before a revoke
 * whose close missed it (it was not pending yet) sees the count moved and never links.
 */
const revokes = new Map<string, number>()
/** The address each waiting socket came from. */
const pendingIp = new WeakMap<WebSocket, string>()
/** Unauthenticated sockets now, by address and in all. */
const preAuthByIp = new Map<string, number>()
let preAuthTotal = 0
const live = new Map<string, Set<WebSocket>>()
/** The linked ones, with their host key. */
const linkedSockets = new Map<WebSocket, string>()

/** One failure for `ip`; the same `guess` again within the window counts once (auth-rate-limit.ts). */
const failAuth = async (ip: string, guess?: string): Promise<void> => {
  const { recordAuthFailure } = await import('../../web/middleware/auth-rate-limit.js')
  recordAuthFailure(ip, guess)
}

/** The door's check before the upgrade: the address is not rate limited. The upgrade carries no secret. */
export async function verifyHostDoorUpgrade(_url: URL, request: IncomingMessage): Promise<DoorUpgradeCheck> {
  const [{ rateLimitClientIp }, { isAuthRateLimited }] = await Promise.all([
    import('../../web/middleware/local-trust.js'), import('../../web/middleware/auth-rate-limit.js'),
  ])
  const ip = rateLimitClientIp(request)
  if (isAuthRateLimited(ip)) return { ok: false, status: 429 }
  return { ok: true, ip }
}

function refuse(socket: Duplex, status: 429 | 503): void {
  if (!socket.destroyed) {
    socket.write(status === 429
      ? 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
      : 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }
  socket.destroy()
}

/** The `/host-door` upgrade (src/web/ws/handler.ts): `verify` runs before anything else; a throw answers 503. */
export async function handleHostDoorUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, o: { verify: () => Promise<DoorUpgradeCheck> }): Promise<void> {
  let check: DoorUpgradeCheck
  try { check = await o.verify() } catch { check = { ok: false, status: 503 } }
  if (!check.ok) return refuse(socket, check.status)
  if (!deps || !wss || socket.destroyed) return refuse(socket, 503)
  const d = deps
  const ip = check.ip
  if ((preAuthByIp.get(ip) ?? 0) >= (d.preAuthPerAddress ?? PRE_AUTH_PER_ADDRESS) || preAuthTotal >= (d.preAuthTotal ?? PRE_AUTH_TOTAL)) return refuse(socket, 429)
  // One unauthenticated slot, given back at the auth or the close.
  preAuthByIp.set(ip, (preAuthByIp.get(ip) ?? 0) + 1)
  preAuthTotal++
  let held = true
  let raw = head.length
  const release = (): void => {
    if (!held) return
    held = false
    socket.off('data', count)
    preAuthTotal--
    const n = (preAuthByIp.get(ip) ?? 1) - 1
    if (n > 0) preAuthByIp.set(ip, n)
    else preAuthByIp.delete(ip)
  }
  // Raw bytes before the auth, before ws assembles a message from them: past the cap the socket is
  // cut (a 60 MB frame is never buffered, only the first few KB of it).
  function count(chunk: Buffer): void {
    raw += chunk.length
    if (raw <= PRE_AUTH_MAX_BYTES) return
    release()
    void failAuth(ip)
    d.log('warn', 'host door: an unauthenticated socket sent more than its handshake; cut', { bytes: raw })
    socket.destroy()
  }
  socket.once('close', release)
  if (raw > PRE_AUTH_MAX_BYTES) { release(); socket.destroy(); return }
  socket.prependListener('data', count)
  wss.handleUpgrade(request, socket, head, (ws) => handshakeDoorSocket(ws, ip, d, release))
}

const closeWs = (ws: WebSocket, code: number, why: string): void => { try { ws.close(code, why.slice(0, 100)) } catch { ws.terminate() } }

/** One door socket's handshake (the header, 2 to 4): its hello, the welcome, its auth, then linkDoorSocket. */
export function handshakeDoorSocket(ws: WebSocket, ip: string, d: HostDoorDeps, authed: () => void = () => {}): void {
  const now = d.now ?? Date.now
  let phase: 'hello' | 'looking' | 'auth' | 'done' = 'hello'
  let bytes = 0
  let name = ''
  let hello: Extract<DoorFrame, { op: 'hello' }> | null = null
  let keys: DoorKey[] = []
  /** The revokes of this machine's credential when its record was read (revokes). */
  let revokesAtHello = 0
  let hostKey = ''
  let walnutId = ''
  const nonceD = doorSecret()
  const close = (code: number, why: string): void => { phase = 'done'; closeWs(ws, code, why) }
  const fail = (why: string, guess?: string): void => {
    void failAuth(ip, guess)
    d.log('info', 'host door: closed a socket before its auth', { why })
    close(DOOR_CLOSE.mismatch, why)
  }
  const timer = setTimeout(() => { if (phase !== 'done') fail('no_auth') }, d.authTimeoutMs ?? AUTH_TIMEOUT_MS)
  timer.unref?.()
  const unpend = (): void => {
    const list = pending.get(name)
    if (!list) return
    const rest = list.filter((x) => x !== ws)
    if (rest.length > 0) pending.set(name, rest)
    else pending.delete(name)
  }

  const onMessage = (raw: unknown): void => {
    if (phase === 'done') return
    const text = String(raw)
    bytes += Buffer.byteLength(text)
    if (bytes > PRE_AUTH_MAX_BYTES) { fail('pre_auth_overflow'); return }
    let f: unknown
    try { f = JSON.parse(text) } catch { f = null }
    if (phase === 'hello' && isDoorFrame(f) && f.op === 'hello') { phase = 'looking'; void onHello(f); return }
    if (phase === 'auth' && isDoorFrame(f) && f.op === 'auth') { onAuth(f); return }
    // Anything else before the auth passed: not this door's host.
    fail('unexpected_frame')
  }
  ws.on('message', onMessage)
  ws.on('close', () => { phase = 'done'; clearTimeout(timer); unpend() })
  ws.on('error', () => { /* a close follows */ })

  async function onHello(f: Extract<DoorFrame, { op: 'hello' }>): Promise<void> {
    walnutId = await d.walnutId().catch(() => '')
    if (f.v !== 2 || !walnutId || f.walnutId !== walnutId || typeof f.machineId !== 'string' || !MACHINE_ID_RE.test(f.machineId) || typeof f.nonce !== 'string' || !DOOR_SECRET_RE.test(f.nonce)) {
      d.log('warn', 'host door: a hello did not name this Walnut and a machine; closed', {})
      return fail('mismatch', `hello:${String(f.walnutId)}:${String(f.machineId)}`)
    }
    revokesAtHello = revokes.get(hostCredentialName(f.machineId)) ?? 0
    const rec = await hostCredentialOf(f.machineId).catch(() => null)
    const configured = !!rec?.hostKey && await Promise.resolve(d.configured?.(rec.hostKey) ?? true).catch(() => false)
    // A ban of its machine under another of its names counts too (revoked-hosts.ts).
    keys = rec && configured && !hostRevokedNow(rec.hostKey) ? doorKeysOf(rec, now()) : []
    if (phase === 'done') return
    if (!rec || keys.length === 0) {
      // Counted (a guess at machine ids is a guess); a host the user removed dials it only every few minutes.
      void failAuth(ip, `unknown:${f.machineId}`)
      d.log('info', 'host door: a hello named a machine with no credential here; closed', { machineId: f.machineId })
      return close(DOOR_CLOSE.unknown, 'unknown_credential')
    }
    hostKey = rec.hostKey!
    const standing = d.standing(hostKey)
    if (!standing) return close(1013, 'not_serving')
    hello = f
    name = hostCredentialName(f.machineId)
    // A few sockets of one machine from one address may wait for their auth; a newer one is refused
    // (never the one waiting: a stranger who knows the machine id cannot evict the host's handshake).
    const list = pending.get(name) ?? []
    if (list.filter((x) => pendingIp.get(x) === ip).length >= PENDING_PER_MACHINE) return close(1013, 'busy')
    pendingIp.set(ws, ip)
    pending.set(name, [...list, ws])
    const { permitNumber, epoch } = standing.pair
    const fields = { nonceH: f.nonce, nonceD, walnutId, machineId: f.machineId, permitNumber, epoch }
    const welcome: DoorFrame = {
      ch: 'door', op: 'welcome', walnutId, holder: standing.holder, permitNumber, epoch, nonce: nonceD,
      proofs: keys.map((k) => ({ keyId: k.keyId, proof: leaderDoorProof(k.verifyKey, fields) })),
    }
    phase = 'auth'
    ws.send(JSON.stringify(welcome))
  }

  function onAuth(f: Extract<DoorFrame, { op: 'auth' }>): void {
    const h = hello!
    const key = keys.find((k) => k.keyId === f.keyId)
    const expected = hostDoorProof(key?.verifyKey ?? keys[0]!.verifyKey, { nonceH: h.nonce, nonceD, walnutId, machineId: h.machineId })
    if (!key || !proofsEqual(expected, f.proof)) {
      d.log('warn', 'host door: a host\'s proof did not match its credential; closed', { host: hostKey })
      return fail('bad_proof', typeof f.proof === 'string' ? f.proof : undefined)
    }
    // Revoked since its record was read (a revoke that came while this handshake was not pending yet).
    if ((revokes.get(name) ?? 0) !== revokesAtHello) {
      d.log('info', 'host door: the credential was revoked during the handshake; closed', { host: hostKey })
      return close(DOOR_CLOSE.revoked, 'revoked')
    }
    phase = 'done'
    clearTimeout(timer)
    unpend()
    ws.off('message', onMessage)
    authed()
    void import('../../web/middleware/auth-rate-limit.js').then((m) => m.clearAuthFailures(ip)).catch(() => {})
    d.log('info', 'host door: a host dialed in', { host: hostKey, which: key.which })
    // The host sends nothing more before it heard this (the raw pre-auth cap counts its bytes).
    try { ws.send(JSON.stringify({ ch: 'door', op: 'linked' } satisfies DoorFrame)) } catch { return }
    linkDoorSocket(ws, { hostKey, name, recheck: () => stillStands(h.machineId, hostKey, key.keyId, d) }, d)
  }
}

/** Does `machineId`'s credential still let `keyId`'s socket in for `hostKey`? */
async function stillStands(machineId: string, hostKey: string, keyId: string, d: HostDoorDeps): Promise<boolean> {
  const rec = await hostCredentialOf(machineId)
  if (!rec || rec.hostKey !== hostKey) return false
  if (!(await Promise.resolve(d.configured?.(hostKey) ?? true))) return false
  if (hostRevokedNow(hostKey)) return false
  return doorKeysOf(rec, (d.now ?? Date.now)()).some((k) => k.keyId === keyId)
}

/**
 * An authenticated door socket of `link.hostKey`: tell it the door list, hand it to the leader side,
 * carry its calls. Every socket of the door goes through here once it proved who it is.
 */
export function linkDoorSocket(ws: WebSocket, link: { hostKey: string; name: string; recheck?: () => Promise<boolean> }, d: HostDoorDeps): void {
  const { hostKey, name } = link
  const close = (code: number, why: string): void => closeWs(ws, code, why)
  if (!live.has(name)) live.set(name, new Set())
  live.get(name)!.add(ws)
  linkedSockets.set(ws, hostKey)
  const recheck = link.recheck ? setInterval(() => {
    void link.recheck!().then((ok) => { if (!ok) { d.log('info', 'host door: a credential no longer stands; its socket is closed', { host: hostKey }); close(DOOR_CLOSE.revoked, 'revoked') } }, () => {})
  }, d.recheckMs ?? DOOR_RECHECK_MS) : null
  recheck?.unref?.()

  let onText: ((text: string) => void) | null = null
  const held: string[] = []
  let onGone: (() => void) | null = null
  let closed = false
  const calls = new Map<string, { resolve(v: { status: number; body: unknown }): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>()

  ws.on('message', (raw) => {
    const text = String(raw)
    let frame: unknown
    try { frame = JSON.parse(text) } catch { return }
    if (isDoorFrame(frame)) {
      if (frame.op === 'reply') {
        const p = calls.get(String(frame.id))
        if (!p) return
        calls.delete(String(frame.id))
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
    if (recheck) clearInterval(recheck)
    live.get(name)?.delete(ws)
    if (live.get(name)?.size === 0) live.delete(name)
    linkedSockets.delete(ws)
    for (const [, p] of calls) { clearTimeout(p.timer); p.reject(new Error('the host-dialed link closed before the host answered')) }
    calls.clear()
    onGone?.()
  })

  void (d.doors?.() ?? Promise.resolve([])).catch(() => [] as string[]).then((doors) => {
    if (closed || doors.length === 0) return
    try { ws.send(JSON.stringify({ ch: 'door', op: 'doors', doors } satisfies DoorFrame)) } catch { /* it closes */ }
  })
  const sock: ChannelSocket = {
    kind: 'host-dialed',
    send: (t) => { if (ws.readyState === ws.OPEN) ws.send(t) },
    close: (why) => close(why === 'replaced' ? DOOR_CLOSE.replaced : 1000, why ?? 'closed'),
    onMessage: (fn) => { onText = fn; for (const t of held.splice(0)) fn(t) },
    onClose: (fn) => { onGone = fn; if (closed) fn() },
    call: (method, route, body, timeoutMs) => new Promise((resolve, reject) => {
      if (closed || ws.readyState !== ws.OPEN) { reject(new HostRequestNotSent(hostKey, new Error('the host-dialed link is closed'))); return }
      const id = crypto.randomBytes(9).toString('hex')
      const timer = setTimeout(() => { calls.delete(id); reject(new Error(`the host did not answer ${route} in ${timeoutMs} ms`)) }, timeoutMs)
      timer.unref?.()
      calls.set(id, { resolve, reject, timer })
      const call: DoorFrame = { ch: 'door', op: 'call', id, method, path: route, body }
      try { ws.send(JSON.stringify(call)) } catch (err) {
        calls.delete(id)
        clearTimeout(timer)
        reject(new HostRequestNotSent(hostKey, err))
      }
    }),
  }
  if (!d.adopt(hostKey, sock)) close(1001, 'stopping')
}

/** Send `doors` to every linked door socket now (a `doors` frame): the host keys told. */
export function pushDoorsToDialed(doors: readonly string[]): string[] {
  const told: string[] = []
  const frame = JSON.stringify({ ch: 'door', op: 'doors', doors: [...doors] } satisfies DoorFrame)
  for (const [ws, hostKey] of linkedSockets) {
    if (ws.readyState !== ws.OPEN) continue
    try { ws.send(frame); told.push(hostKey) } catch { /* it closes; its host hears the list at its next link */ }
  }
  return [...new Set(told)]
}

/** Close every door socket (waiting or linked) of these credential names now (a revoke heard in this process). */
export function closeDoorSockets(names: readonly string[]): number {
  let n = 0
  for (const name of names) {
    revokes.set(name, (revokes.get(name) ?? 0) + 1)
    for (const ws of [...(pending.get(name) ?? []), ...(live.get(name) ?? [])]) { n++; closeWs(ws, DOOR_CLOSE.revoked, 'revoked') }
  }
  return n
}

/** Serve the door in this process (leader-boot.ts): returns the stop. */
export async function startHostDoor(d: HostDoorDeps): Promise<() => void> {
  deps = d
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, handleProtocols: (protocols) => selectWsProtocol(protocols) })
  const { onCredentialsRevoked } = await import('../device-auth.js')
  const unlisten = onCredentialsRevoked((names) => {
    const n = closeDoorSockets(names.filter((x) => x.startsWith('host-')))
    if (n > 0) d.log('info', 'host door: closed the sockets of a revoked credential', { sockets: n })
  })
  return () => {
    unlisten()
    for (const set of [...live.values(), ...pending.values()]) for (const ws of set) closeGoingAway(ws)
    live.clear()
    pending.clear()
    linkedSockets.clear()
    wss?.close()
    wss = null
    if (deps === d) deps = null
  }
}
