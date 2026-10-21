/**
 * The paired primary's read-only view of ONE remote daemon session. Native
 * records and cursors cross unchanged; neither a phone SSE parser nor a daemon
 * command socket is exposed. Closing a reader never stops or detaches the CLI.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { selectWsProtocol } from '../../lib/ws-bearer-protocol.js'

export const BRIDGE_SESSION_STREAM_PATH = '/bridge/session-stream'
const MAX_BUFFER_BYTES = 32 * 1024 * 1024
const HEARTBEAT_MS = 30_000
const UPGRADE_DEADLINE_MS = 20_000
const HOST = /^[A-Za-z0-9_.-]{1,128}$/
const SID = /^[A-Za-z0-9_-]{1,128}$/

export interface SessionStreamCredential {
  name: string
  kind: 'device' | 'api_key' | 'machine'
  bridgeScope?: 'status-only'
  stillValid: () => Promise<boolean>
}

interface Reader { close: (code: number, reason: string) => void; shutdown: () => void }
const readers = new Set<Reader>()
const pendingUpgrades = new Set<Duplex>()
let streamWss: WebSocketServer | null = null
let generation = 0

function wssFor(): WebSocketServer {
  return streamWss ??= new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: MAX_BUFFER_BYTES,
    handleProtocols: (protocols) => selectWsProtocol(protocols),
  })
}

function refuse(socket: Duplex, status: 400 | 401 | 403 | 409 | 503): void {
  if (socket.destroyed || socket.writableEnded) return
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 409: 'Conflict', 503: 'Service Unavailable' }[status]
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

async function valid(check: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      check(),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); timer.unref?.() }),
    ])
  } catch { return false } finally { if (timer) clearTimeout(timer) }
}

/** Auth runs before query validation or session lookup. The caller supplies the shared upgrade gate. */
export async function handleBridgeSessionStreamUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: { verify: () => Promise<SessionStreamCredential | null> },
): Promise<void> {
  const startedGeneration = generation
  pendingUpgrades.add(socket)
  let cancelled = false
  const deadline = setTimeout(() => { cancelled = true; pendingUpgrades.delete(socket); refuse(socket, 503) }, UPGRADE_DEADLINE_MS)
  deadline.unref?.()
  const available = () => !cancelled && !socket.destroyed && !socket.writableEnded && generation === startedGeneration
  try {
    const cred = await deps.verify()
    if (!available()) return
    if (!cred) { refuse(socket, 401); return }
    if (cred.kind !== 'machine' || cred.name !== 'bridge-local' || cred.bridgeScope === 'status-only') {
      refuse(socket, 403)
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const host = url.searchParams.get('host')
    const sid = url.searchParams.get('sessionId')
    const rawOffset = url.searchParams.get('fromOffset')
    const fromOffset = rawOffset !== null && /^\d+$/.test(rawOffset) ? Number(rawOffset) : NaN
    if (!host || !HOST.test(host) || host === '__local__' || host === '__cloudbox__'
      || !sid || !SID.test(sid) || !Number.isSafeInteger(fromOffset) || fromOffset < 0
      || ['host', 'sessionId', 'fromOffset'].some((key) => url.searchParams.getAll(key).length !== 1)) {
      refuse(socket, 400)
      return
    }
    const registry = await import('./bridge-registry.js')
    const supported = () => registry.bridgeHasCapability(host, 'send-dedupe-v1')
      && registry.bridgeHasCapability(host, 'send-lost-line-v1')
      && registry.bridgeHosts({ executionOnly: true }).some((bridge) => bridge.hostAlias === host)
    if (!supported()) { refuse(socket, 503); return }
    const { resolveCloudSessionHost } = await import('../../core/sessions/cloud-session-host.js')
    const target = await resolveCloudSessionHost(sid)
    if (!available()) return
    if (!target || target.host !== host) { refuse(socket, 409); return }
    // Lookup can wait on a relay. A revoke or bridge drop while it waited must
    // not open a reader under stale authority or against a dead connection.
    const { onCredentialsRevoked } = await import('../../core/device-auth.js')
    if (!await valid(cred.stillValid)) { refuse(socket, 401); return }
    if (!available()) return
    if (!supported()) { refuse(socket, 503); return }
    clearTimeout(deadline)
    pendingUpgrades.delete(socket)
    wssFor().handleUpgrade(request, socket, head, (ws) => {
      let closed = false
      let alive = true
      let checking = false
      let checkAgain = false
      let stopEvents: (() => void) | undefined
      let stopRevokes: (() => void) | undefined
      let heartbeat: NodeJS.Timeout | undefined
      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        stopEvents?.()
        stopRevokes?.()
        readers.delete(reader)
      }
      const close = (code: number, reason: string) => {
        if (closed) return
        cleanup()
        try { ws.close(code, reason) } catch { ws.terminate() }
        setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate() }, 2_000).unref?.()
      }
      const reader: Reader = { close, shutdown: () => { cleanup(); ws.terminate() } }
      readers.add(reader)
      const revalidate = () => {
        if (closed) return
        if (checking) { checkAgain = true; return }
        checking = true
        checkAgain = false
        void valid(cred.stillValid).then((ok) => {
          checking = false
          if (!ok) close(4401, 'credential revoked')
          else if (checkAgain) revalidate()
        })
      }
      const send = (msg: Record<string, unknown>, rawFrame?: string, frameBytes?: number) => {
        if (closed || ws.readyState !== WebSocket.OPEN) return
        const frame = rawFrame ?? JSON.stringify(msg)
        if (ws.bufferedAmount + (frameBytes ?? Buffer.byteLength(frame)) > MAX_BUFFER_BYTES) {
          close(1009, 'stream buffer full')
          return
        }
        ws.send(frame, (err) => { if (err) close(1011, 'stream write failed') })
      }
      ws.on('close', cleanup)
      ws.on('error', () => close(1011, 'stream socket failed'))
      // There is no app command protocol here, not even a ping command. Only
      // WebSocket control pings/pongs may come from the reader.
      ws.on('message', () => close(1008, 'read-only stream'))
      ws.on('pong', () => { alive = true })
      ws.on('ping', () => { alive = true })
      stopRevokes = onCredentialsRevoked((names) => { if (names.includes(cred.name)) revalidate() })
      heartbeat = setInterval(() => {
        if (closed) return
        if (!alive || ws.bufferedAmount > MAX_BUFFER_BYTES) { cleanup(); ws.terminate(); return }
        alive = false
        try { ws.ping() } catch { close(1011, 'stream heartbeat failed'); return }
        revalidate()
      }, HEARTBEAT_MS)
      heartbeat.unref?.()
      // cmdAttach sends catch-up BEFORE its reply, so subscribe before asking.
      stopEvents = registry.addBridgeSessionEventHandler(host, sid, (msg, rawFrame, frameBytes) => {
        send(msg, rawFrame, frameBytes)
        if (msg.ev === 'bridge-offline') close(1012, 'bridge offline')
      })
      void registry.bridgeRequest(host, 'attach', { sid, fromOffset }).then((reply) => {
        send({ ...reply, ev: 'attached' })
        if (reply.ok !== true) close(1011, 'attach refused')
      }, () => close(1012, 'bridge unavailable'))
    })
  } catch { refuse(socket, 503) } finally { clearTimeout(deadline); pendingUpgrades.delete(socket) }
}

/** Server shutdown ends readers only; daemons and their sessions are untouched. */
export function closeAllBridgeSessionStreams(): void {
  generation++
  for (const socket of pendingUpgrades) socket.destroy()
  pendingUpgrades.clear()
  for (const reader of [...readers]) reader.shutdown()
  if (streamWss) { streamWss.close(); streamWss = null }
}
