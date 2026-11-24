/**
 * Walnut Connect's door (docs/reference/walnut-connect.md): a second HTTP listener on a unix
 * socket, serving the same app, that this Mac's walnut-net pipes each phone stream into.
 *
 * Nothing that arrives here is this machine: a unix socket has no remote address, so
 * local-trust.ts never waives the credential, and every request needs the phone's device
 * token, as on the Wi-Fi route. WebSocket upgrades go to the main server's handler, whose
 * checks see this same socket (the tunnel port's pattern, expose-runtime.ts).
 *
 * The socket sits in a 0700 directory of its own under the data home (`local/connect/`), so
 * only this account reaches it, and it is open only while Walnut Connect is wanted
 * (connect-net.ts connectWanted): at start, and again after each config change.
 */

import fs from 'node:fs'
import http, { type RequestListener, type Server as HttpServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { bus, EventNames } from '../core/event-bus.js'
import { connectWanted, enableNetIfSwitchedOn, scheduleConnectSync, setConnectDoor } from '../core/connect/connect-net.js'

/** macOS keeps a unix socket path to 104 bytes. */
const SUN_PATH_MAX = 100

/** Where the door listens: under the data home, or a short private path when that is too long. */
export function connectSocketPath(home: string = WALNUT_HOME): string {
  const p = path.join(home, 'local', 'connect', 'door.sock')
  if (Buffer.byteLength(p) <= SUN_PATH_MAX) return p
  const tag = crypto.createHash('sha256').update(home).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), `walnut-connect-${tag}`, 'door.sock')
}

/** Does something answer on this socket now (another server of the same data home)? */
function answers(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock)
    const done = (v: boolean) => { c.destroy(); resolve(v) }
    c.once('connect', () => done(true))
    c.once('error', () => done(false))
    setTimeout(() => done(false), 1_000).unref?.()
  })
}

export interface ConnectDoor {
  reconcile(): Promise<void>
  stop(): Promise<void>
}

export function startConnectDoor(opts: { app: RequestListener; mainServer: HttpServer; socketPath?: string }): ConnectDoor {
  const sock = opts.socketPath ?? connectSocketPath()
  let server: HttpServer | null = null
  let chain: Promise<void> = Promise.resolve()
  let stopped = false

  /** The socket file this server made: close removes only that one, never a later server's. */
  let ownIno: number | null = null

  async function open(): Promise<void> {
    if (server) return
    const dir = path.dirname(sock)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // The folder must be this account's own, a real folder (on a shared /tmp another user could
    // have made it, or left a link to somewhere else): else there is no door.
    const st = fs.lstatSync(dir)
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      log.web.warn('walnut connect: the door folder is not this account\'s own; no door', { dir })
      return
    }
    fs.chmodSync(dir, 0o700)
    if (fs.existsSync(sock)) {
      if (await answers(sock)) {
        log.web.warn('walnut connect: another server holds the door; this one stays closed', { socket: sock })
        return
      }
      fs.rmSync(sock, { force: true })
    }
    const s = http.createServer((req, res) => opts.app(req, res))
    s.on('upgrade', (req, socket, head) => { opts.mainServer.emit('upgrade', req, socket, head) })
    s.on('error', (err) => log.web.error('walnut connect: door error', { error: err instanceof Error ? err.message : String(err) }))
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(sock, () => { s.off('error', reject); resolve() })
    })
    fs.chmodSync(sock, 0o600)
    ownIno = fs.statSync(sock).ino
    server = s
    setConnectDoor(sock)
    log.web.info('walnut connect: door open', { socket: sock })
  }

  async function close(): Promise<void> {
    const s = server
    if (!s) return
    server = null
    setConnectDoor(null)
    s.closeAllConnections?.()
    await new Promise<void>((resolve) => s.close(() => resolve()))
    try {
      if (ownIno !== null && fs.statSync(sock).ino === ownIno) fs.rmSync(sock, { force: true })
    } catch { /* already gone */ }
    ownIno = null
    log.web.info('walnut connect: door closed', { socket: sock })
  }

  function reconcile(): Promise<void> {
    chain = chain.then(async () => {
      if (stopped) return
      await enableNetIfSwitchedOn()
      if (await connectWanted()) await open()
      else await close()
    }).catch((err) => log.web.warn('walnut connect: door reconcile failed', { error: err instanceof Error ? err.message : String(err) }))
    return chain
  }

  // The experiment's switch is a config change; so is turning the host network off or on.
  bus.subscribe('walnut-connect-door', () => { void reconcile() }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  const offRevoked = import('../core/device-auth.js').then(({ onCredentialsRevoked, onDevicePaired }) => {
    const a = onCredentialsRevoked(() => scheduleConnectSync('device revoked'))
    const b = onDevicePaired(() => scheduleConnectSync('device paired'))
    return () => { a(); b() }
  })

  return {
    reconcile,
    async stop() {
      stopped = true
      bus.unsubscribe('walnut-connect-door')
      ;(await offRevoked)()
      await chain
      await close()
    },
  }
}
