/**
 * The console door of a host replica on a machine that handed the leader over
 * (docs/reference/leader-switch.md, "The old leader's console"; core/handed-over-console.ts).
 *
 * That machine's leader served the console at an address (http://localhost:3456 for the Mac
 * app). After the switch the machine is a host of the new leader, and this replica (the one its
 * daemon runs for the new leader) opens a second listener there, beside its own public port:
 *
 *   - It opens only while the console stands: this machine's console file for this Walnut names a
 *     home whose own marker says it handed the leader over in that switch (read only, every
 *     second). A cancelled switch, a switch back (the home moved aside) or a missing file closes
 *     it, and the port is free again for the leader that starts there.
 *   - While the port is taken (the standby of the handed-over home, handed-over.ts, holds it
 *     until it sees this replica's holder file) it tries again every second.
 *   - It is the same app and the same WebSocket handler as the public port. The one difference:
 *     a request this machine's leader trusted without a credential (classifyLoopbackClient: a
 *     loopback socket, no proxy header, a loopback Host, its own Origin) gets the console
 *     device's token as its Authorization. From there everything is the device path every
 *     browser of a replica takes: the forward to the leader (which knows the device from the
 *     data the switch moved), the away reads and writes, this replica's own /ws. A request that
 *     brings its own Authorization keeps it. The public port, the tunnel's, trusts nothing.
 *
 * So the console is a device to the new leader, never the person at the leader's machine: what
 * only that person may do (routes behind fromThisMachine and the like) is refused here as for
 * any device.
 *
 * It opens only once this replica's device copy knows the console's token (the new leader sent
 * it the device the switch moved): before that every console request would be refused and counted
 * against the replica's one failure bucket. A token it stops knowing (the device was removed)
 * closes the door again.
 *
 * One answer is never the leader's: GET /api/config's `loginSession`. The Mac app reads it to judge
 * the server on its port (desktop/main.swift replaceEndedSessionServer stops the listener when it
 * reports `user_lookup` or `dns_config`). The listener here is this replica, which the app did not
 * start and cannot restart (this machine's daemon runs it), and the leader's own login session is
 * another machine's: so the door always answers a session with no problem, one the app leaves alone.
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'
import { clearHolder, consoleRefusal, readConsoleFileAsync, writeHolder, type HandedOverConsole } from '../core/handed-over-console.js'
import { classifyLoopbackClient } from '../web/middleware/local-trust.js'

export interface ConsoleDoorOptions {
  walnutId: string
  /** This replica's own (tunnel) port: a console naming it is refused. */
  publicPort: number
  app: http.RequestListener
  /** The server whose 'upgrade' handler serves /ws (the public port's). */
  mainServer: http.Server
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  /** Whether this replica's device copy knows a token (replica/auth.ts verifyReplicaToken). */
  knowsToken: (token: string) => boolean
  /** Tests: the console files' dir and the look interval. */
  dir?: string
  tickMs?: number
}

export interface ConsoleDoorStatus {
  state: 'none' | 'waiting' | 'serving'
  port?: number
  host?: string
  switchId?: string
  to?: string
  why?: string
}

export interface ConsoleDoor {
  status(): ConsoleDoorStatus
  /** One look now (tests; the timer looks every second). */
  look(): Promise<void>
  stop(): Promise<void>
}

/** The credential this machine's console brings, set on a request its leader would have trusted. */
export function stampConsoleCredential(req: http.IncomingMessage, token: string | null): boolean {
  if (!token || req.headers.authorization !== undefined) return false
  if (!classifyLoopbackClient(req).trusted) return false
  req.headers.authorization = `Bearer ${token}`
  return true
}

/** The login session the console reports: no problem, so the Mac app never stops the replica over it (see the header). */
export const CONSOLE_LOGIN_SESSION = Object.freeze({ ok: true, problems: [] as string[], checkedAt: null })

/**
 * GET /api/config answered with CONSOLE_LOGIN_SESSION in place of the leader's (see the header).
 * The leader's answer is held whole (asked uncompressed and unconditional, so it is plain JSON with
 * a body), its `loginSession` replaced, and sent on with its own length; any other answer (an
 * error, not JSON) goes on as it came. A second head (the forward answering again after a failed
 * first try) starts the held answer over.
 */
export function answerConsoleLoginSession(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/api/config') return
  delete req.headers['accept-encoding']
  delete req.headers['if-none-match']
  delete req.headers['if-modified-since']
  const chunks: Buffer[] = []
  const writeHead = res.writeHead.bind(res)
  const end = res.end.bind(res)
  const toBuffer = (chunk: unknown, enc?: unknown): Buffer =>
    Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof enc === 'string' ? enc as BufferEncoding : 'utf8')
  let status: number | null = null
  let message: string | undefined
  res.writeHead = ((code: number, a?: unknown, b?: unknown) => {
    if (status !== null) chunks.length = 0
    status = code
    const headers = typeof a === 'string' ? b : a
    if (typeof a === 'string') message = a
    if (Array.isArray(headers)) {
      // Raw pairs [name, value, name, value, ...] or [[name, value], ...].
      const flat = headers.flat() as unknown[]
      for (let i = 0; i + 1 < flat.length; i += 2) res.setHeader(String(flat[i]), String(flat[i + 1]))
    } else if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (v !== undefined) res.setHeader(k, v as string | string[])
    }
    return res
  }) as typeof res.writeHead
  res.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    if (chunk != null) chunks.push(toBuffer(chunk, enc))
    const done = typeof enc === 'function' ? enc : cb
    if (typeof done === 'function') queueMicrotask(() => (done as () => void)())
    return true
  }) as typeof res.write
  res.end = ((chunk?: unknown, enc?: unknown, cb?: unknown) => {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined } else if (typeof enc === 'function') { cb = enc; enc = undefined }
    if (chunk != null) chunks.push(toBuffer(chunk, enc))
    let body = Buffer.concat(chunks)
    const code = status ?? res.statusCode
    if (code === 200 && /json/i.test(String(res.getHeader('content-type') ?? '')) && !res.getHeader('content-encoding')) {
      try {
        const j = JSON.parse(body.toString('utf8')) as unknown
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          (j as Record<string, unknown>).loginSession = { ...CONSOLE_LOGIN_SESSION, problems: [] }
          body = Buffer.from(JSON.stringify(j))
          res.removeHeader('etag')
        }
      } catch { /* not JSON after all: as it came */ }
    }
    res.removeHeader('transfer-encoding')
    res.setHeader('content-length', String(body.length))
    res.writeHead = writeHead
    if (message !== undefined) writeHead(code, message)
    else writeHead(code)
    return end(body, cb as (() => void) | undefined)
  }) as typeof res.end
}

function listenHost(host: string): string | undefined {
  // The leader listened on every interface when its bind address was unset: the same here.
  return host === '::' || host === '0.0.0.0' || host === '' ? undefined : host
}

export function startConsoleDoor(o: ConsoleDoorOptions): ConsoleDoor {
  const dir = o.dir
  let current: HandedOverConsole | null = null
  let server: http.Server | null = null
  let state: ConsoleDoorStatus['state'] = 'none'
  let why: string | undefined
  let opening: Promise<void> | null = null
  let stopped = false
  let lastBusyLog = 0
  // The WebSockets taken through the door: handed to the main server's handler, so its own
  // closeAllConnections no longer sees them; ended here when the door closes.
  const sockets = new Set<Duplex>()

  const handler: http.RequestListener = (req, res) => {
    stampConsoleCredential(req, current?.token ?? null)
    answerConsoleLoginSession(req, res)
    o.app(req, res)
  }

  function holder(s: 'waiting' | 'serving', c: HandedOverConsole): void {
    try {
      writeHolder(o.walnutId, { pid: process.pid, state: s, port: c.port, host: c.host, since: new Date().toISOString() }, dir)
    } catch (err) {
      o.log('warn', 'console door: the holder file could not be written', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function close(reason: string): Promise<void> {
    const s = server
    server = null
    if (s) {
      s.closeAllConnections?.()
      for (const sock of sockets) sock.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => s.close(() => resolve()))
      o.log('info', 'console door: closed', { reason, port: current?.port })
    }
    if (state !== 'none' || s) clearHolder(o.walnutId, process.pid, dir)
    state = 'none'
    current = null
    why = reason
  }

  async function open(c: HandedOverConsole): Promise<void> {
    if (state !== 'waiting') holder('waiting', c)
    state = 'waiting'
    const s = http.createServer(handler)
    s.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      stampConsoleCredential(req, current?.token ?? null)
      o.mainServer.emit('upgrade', req, socket, head)
    })
    s.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* gone */ } })
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject)
        s.listen(c.port, listenHost(c.host), () => { s.off('error', reject); resolve() })
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (Date.now() - lastBusyLog > 60_000) {
        lastBusyLog = Date.now()
        o.log(code === 'EADDRINUSE' ? 'info' : 'warn', 'console door: the console port is taken; trying again', { port: c.port, error: code ?? String(err) })
      }
      return
    }
    if (stopped || current?.switchId !== c.switchId) { s.close(); return }
    s.on('error', (err) => o.log('warn', 'console door: listener error', { error: err instanceof Error ? err.message : String(err) }))
    server = s
    state = 'serving'
    holder('serving', c)
    o.log('info', 'console door: open', { port: c.port, host: c.host, switchId: c.switchId, to: c.to })
  }

  async function look(): Promise<void> {
    if (stopped) return
    if (opening) return opening
    const c = await readConsoleFileAsync(o.walnutId, dir)
    const refusal = !c ? 'no console file for this Walnut on this machine' : c.port === o.publicPort ? 'the console names this replica\'s own port'
      : consoleRefusal(c) ?? (o.knowsToken(c.token) ? null : 'this replica does not know the console device yet (or it was removed): its device copy comes from the leader')
    if (!c || refusal) {
      if (state !== 'none') await close(refusal ?? 'the console ended')
      else why = refusal ?? undefined
      return
    }
    // Another switch, or another address: the door moves.
    if (current && (current.switchId !== c.switchId || current.port !== c.port || current.host !== c.host)) await close('the console moved')
    current = c
    why = undefined
    if (state === 'serving') return
    opening = open(c).finally(() => { opening = null })
    return opening
  }

  const tick = setInterval(() => { void look().catch(() => {}) }, o.tickMs ?? 1_000)
  tick.unref?.()
  void look().catch(() => {})

  return {
    status: () => ({
      state,
      ...(current ? { port: current.port, host: current.host, switchId: current.switchId, to: current.to } : {}),
      ...(why ? { why } : {}),
    }),
    look,
    async stop() {
      stopped = true
      clearInterval(tick)
      await opening?.catch(() => {})
      await close('the replica stops')
    },
  }
}
