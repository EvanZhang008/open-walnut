/**
 * /daemon-tunnel (cloud mode only): the paired Mac reaching ITS daemon on this
 * box, so the box is an exec host without SSH (core/hosts/cloud-box-host.ts).
 *
 *   Mac DaemonConnection ─wss─▶ Caddy ─▶ this route ─ws 127.0.0.1─▶ tunnel daemon
 *
 * One Mac socket = one loopback socket, frames piped verbatim both ways (text
 * and binary alike), so everything above the transport is the daemon protocol
 * the Mac already speaks. The daemon stays on loopback; nothing here opens a
 * port.
 *
 * Who may open it: ONLY the primary's machine credential, the very token its
 * own daemon dials /bridge with (`bridge-local`, bound to `__local__`). A
 * phone's device token, an API key, another host's machine token or no token
 * are all refused: a daemon socket spawns processes, which is more than any of
 * those may do on this box. `cloud.exec.enabled` off refuses too, with a header
 * the Mac turns into "Cloud companion has session hosting turned off", and
 * closes an open tunnel within one heartbeat (the daemon itself stays up).
 *
 * Which daemon: the one of the Mac that owns the credential (its `daemonKey`,
 * core/machine-credentials.ts), in a dir of its own, so a Mac never lands on
 * another Mac's sessions. One companion serves one Mac: a second Mac cannot
 * mint the credential at all (409), and revoking or rotating it closes its
 * open tunnel at once (TUNNEL_CLOSE_REVOKED) or, for a revoke made by another
 * process, within one heartbeat.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { log } from '../../logging/index.js'
import { TUNNEL_PROBE_HEADER, TUNNEL_REFUSAL_HEADER } from '../../core/hosts/cloud-box-host.js'

export type TunnelCredential = { name: string; kind: 'device' | 'api_key' | 'machine' } | null

export type TunnelAdmission =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; refusal: string; message: string }

/** The machine token a primary's own daemon uses, and so the tunnel's only key. */
const PRIMARY_MACHINE_DEVICE = 'bridge-local'

/**
 * Admission, pure. Identity first, then the operator's switch: a caller that
 * may not open the tunnel learns nothing about how the box is configured.
 */
export function tunnelAdmission(cred: TunnelCredential, execEnabled: boolean): TunnelAdmission {
  if (!cred) return { ok: false, status: 401, refusal: 'unauthorized', message: 'a machine credential is required' }
  if (cred.kind !== 'machine' || cred.name !== PRIMARY_MACHINE_DEVICE) {
    return { ok: false, status: 403, refusal: 'not_primary', message: 'only the paired primary may open the daemon tunnel' }
  }
  if (!execEnabled) {
    return { ok: false, status: 403, refusal: 'cloud_exec_off', message: 'session hosting is turned off on this companion (cloud.exec.enabled)' }
  }
  return { ok: true }
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' }

function refuse(socket: Duplex, a: Extract<TunnelAdmission, { ok: false }>): void {
  const body = a.message
  socket.write(
    `HTTP/1.1 ${a.status} ${STATUS_TEXT[a.status]}\r\n`
    + 'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n'
    + `${TUNNEL_REFUSAL_HEADER}: ${a.refusal}\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
  socket.destroy()
}

/** Cold daemon start bound: past this the Mac hears 503 and its loop retries. */
const DAEMON_START_DEADLINE_MS = 20_000
const LOOPBACK_OPEN_DEADLINE_MS = 5_000
/** The replica's own check on the Mac side, so a vanished Mac frees its daemon socket. */
const MAC_PING_INTERVAL_MS = 30_000
/** Same frame ceiling the Mac's DaemonConnection accepts (a git.diff can be ~64MB). */
const MAX_FRAME_BYTES = 100 * 1024 * 1024

let tunnelWss: WebSocketServer | null = null
interface LiveTunnel { mac: WebSocket; daemon: WebSocket; credName: string; close: (why: string, code?: number) => void }
const liveTunnels = new Set<LiveTunnel>()

function wssFor(): WebSocketServer {
  // autoPong off: the Mac's liveness pings are forwarded to the daemon and its
  // pong comes back, so a hung daemon reads as a dead link, not a healthy one.
  tunnelWss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, autoPong: false })
  return tunnelWss
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(t))
}

function openLoopback(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: LOOPBACK_OPEN_DEADLINE_MS })
    ws.once('open', () => resolve(ws))
    ws.once('error', (err) => reject(err))
  })
}

export interface TunnelDeps {
  verify: () => Promise<TunnelCredential>
  execEnabled: () => Promise<boolean>
  /** The loopback ws URL of the daemon that serves this credential's owner. */
  ensureDaemon: (cred: Extract<TunnelCredential, object>) => Promise<string>
  /** Is the credential that opened this tunnel still valid? Asked every heartbeat. */
  stillValid: () => Promise<boolean>
  /** Test seam: the heartbeat period (MAC_PING_INTERVAL_MS by default). */
  heartbeatMs: number
  /** Test seam: the daemon start bound (DAEMON_START_DEADLINE_MS by default). */
  daemonStartDeadlineMs: number
}

/** App close code for "hosting was turned off while this tunnel was open". */
export const TUNNEL_CLOSE_EXEC_OFF = 4403
/** App close code for "the credential that opened this tunnel was revoked or rotated". */
export const TUNNEL_CLOSE_REVOKED = 4401

/** The bearer the upgrade presented (header, or the ?token= the daemons' bridge client uses). */
function presentedToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  try {
    return new URL(request.url ?? '/', 'http://x').searchParams.get('token')
  } catch { return null }
}

async function defaultStillValid(request: IncomingMessage, name: string): Promise<boolean> {
  const token = presentedToken(request)
  if (!token) return false
  const { verifyDeviceToken } = await import('../../core/device-auth.js')
  const cred = await verifyDeviceToken(token)
  return cred?.kind === 'machine' && cred.name === name
}

async function defaultExecEnabled(): Promise<boolean> {
  const [{ getConfig }, { cloudExecStatus }, { CLOUD_MODE }] = await Promise.all([
    import('../../core/config-manager.js'), import('../../core/cloud-exec.js'), import('../../constants.js'),
  ])
  try {
    return cloudExecStatus(await getConfig(), CLOUD_MODE).enabled
  } catch {
    return false // unreadable config: stay a relay, as the server's startup does
  }
}

/** The owning Mac's own daemon: every owner has its own dir, sessions and streams. */
async function defaultEnsureDaemon(cred: Extract<TunnelCredential, object>): Promise<string> {
  const [{ ensureTunnelDaemon }, { machineCredentialDaemonKey }] = await Promise.all([
    import('../../providers/cloud-tunnel-daemon.js'), import('../../core/machine-credentials.js'),
  ])
  return ensureTunnelDaemon(await machineCredentialDaemonKey(cred.name))
}

let revokeWatch: (() => void) | null = null

/** Close every open tunnel a just-revoked credential opened (this process's revokes; others wait for a heartbeat). */
async function watchRevocations(): Promise<void> {
  if (revokeWatch) return
  const { onCredentialsRevoked } = await import('../../core/device-auth.js')
  revokeWatch ??= onCredentialsRevoked((names) => {
    for (const t of [...liveTunnels]) if (names.includes(t.credName)) t.close('credential_revoked', TUNNEL_CLOSE_REVOKED)
  })
}

/** Handle one upgrade on /daemon-tunnel. Never throws; every failure answers the socket. */
export async function handleDaemonTunnelUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: Partial<TunnelDeps> & Pick<TunnelDeps, 'verify'>,
): Promise<void> {
  const execEnabled = deps.execEnabled ?? defaultExecEnabled
  const ensureDaemon = deps.ensureDaemon ?? defaultEnsureDaemon
  try {
    const cred = await deps.verify()
    if (request.headers[TUNNEL_PROBE_HEADER]) {
      // Credential check only: nothing else is said, nothing is started.
      if (cred?.kind === 'machine') {
        socket.write(`HTTP/1.1 204 No Content\r\nConnection: close\r\n${TUNNEL_REFUSAL_HEADER}: credential_ok\r\n\r\n`)
        socket.destroy()
      } else refuse(socket, cred ? { ok: false, status: 403, refusal: 'not_primary', message: 'not a machine credential' } : { ok: false, status: 401, refusal: 'unauthorized', message: 'a machine credential is required' })
      return
    }
    const admission = tunnelAdmission(cred, cred?.kind === 'machine' ? await execEnabled() : true)
    if (!admission.ok || !cred) {
      if (!admission.ok) {
        log.ws.warn('daemon tunnel refused', { refusal: admission.refusal, name: cred?.name, kind: cred?.kind })
        refuse(socket, admission)
      } else socket.destroy()
      return
    }
    void watchRevocations().catch(() => { /* heartbeats still re-verify */ })
    const stillValid = deps.stillValid ?? (() => defaultStillValid(request, cred.name))

    let daemon: WebSocket
    try {
      const url = await withDeadline(ensureDaemon(cred), deps.daemonStartDeadlineMs ?? DAEMON_START_DEADLINE_MS, 'starting the session daemon')
      daemon = await openLoopback(url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.ws.error('daemon tunnel: session daemon unavailable', { error: message })
      refuse(socket, { ok: false, status: 503, refusal: 'daemon_start_failed', message })
      return
    }
    if (socket.destroyed) { daemon.terminate(); return }

    // Frames the daemon sends before the Mac side is up (a broadcast) wait here.
    const early: Array<{ data: RawData; isBinary: boolean }> = []
    let mac: WebSocket | null = null
    daemon.on('message', (data, isBinary) => {
      if (mac) { if (mac.readyState === WebSocket.OPEN) mac.send(data, { binary: isBinary }) }
      else early.push({ data, isBinary })
    })
    daemon.on('error', () => { /* close follows */ })

    wssFor().handleUpgrade(request, socket, head, (ws) => {
      mac = ws
      const pair: LiveTunnel = { mac: ws, daemon, credName: cred.name, close: (why, code) => closeBoth(why, code) }
      liveTunnels.add(pair)
      log.ws.info('daemon tunnel open', { tunnels: liveTunnels.size })
      for (const f of early.splice(0)) ws.send(f.data, { binary: f.isBinary })

      ws.on('message', (data, isBinary) => { if (daemon.readyState === WebSocket.OPEN) daemon.send(data, { binary: isBinary }) })
      ws.on('ping', (data) => { if (daemon.readyState === WebSocket.OPEN) daemon.ping(data) })
      daemon.on('pong', (data) => { if (ws.readyState === WebSocket.OPEN) ws.pong(data) })

      let macAlive = true
      ws.on('pong', () => { macAlive = true })
      const heartbeat = setInterval(() => {
        if (!macAlive) { ws.terminate(); return }
        macAlive = false
        try { ws.ping() } catch { /* closing */ }
        // Off means off for an open tunnel too, not just the next dial: the
        // Mac's redial then hears 403 cloud_exec_off and says hosting is off.
        void execEnabled().then((on) => { if (!on) closeBoth('cloud_exec_off', TUNNEL_CLOSE_EXEC_OFF) }, () => {})
        // So is a revoked or rotated credential, even one revoked by another
        // process (the `walnut device` CLI), which the revoke listener misses.
        void stillValid().then((ok) => { if (!ok) closeBoth('credential_revoked', TUNNEL_CLOSE_REVOKED) }, () => {})
      }, deps.heartbeatMs ?? MAC_PING_INTERVAL_MS)
      heartbeat.unref?.()

      let closed = false
      const closeBoth = (why: string, code = 1001) => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        liveTunnels.delete(pair)
        log.ws.info('daemon tunnel closed', { why, tunnels: liveTunnels.size })
        // Only the sockets end. The daemon and every CLI it runs stay up, so
        // the Mac's reconnect finds its sessions where it left them.
        try { ws.close(code) } catch { /* gone */ }
        try { daemon.close(1000) } catch { /* gone */ }
        setTimeout(() => { ws.terminate(); daemon.terminate() }, 2_000).unref?.()
      }
      ws.on('close', () => closeBoth('mac'))
      ws.on('error', () => closeBoth('mac-error'))
      daemon.on('close', () => closeBoth('daemon'))
    })
  } catch (err) {
    log.ws.error('daemon tunnel upgrade failed', { error: err instanceof Error ? err.message : String(err) })
    socket.destroy()
  }
}

/** Server shutdown: drop every tunnel (the daemon itself keeps running). */
export function closeAllDaemonTunnels(): void {
  for (const { mac, daemon } of [...liveTunnels]) {
    try { mac.terminate() } catch { /* gone */ }
    try { daemon.terminate() } catch { /* gone */ }
  }
  liveTunnels.clear()
}

/** Test seam: how many tunnels are piping right now. */
export function liveDaemonTunnelCount(): number {
  return liveTunnels.size
}
