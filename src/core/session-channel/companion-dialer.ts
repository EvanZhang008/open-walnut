/**
 * The host's link to its cloud companion's listener door (listener-wire.ts), a module of the host's
 * one Walnut service beside its leader dialer (host-dialer.ts), started by host-boot.ts. While the
 * switch is on and the session runtime this service holds has a bridge link configured for this
 * Walnut, it dials the companion's /host-listen with that link's own machine token, and:
 *
 *   1. sends its hello (this Walnut, the link's host alias) and waits for the welcome;
 *   2. checks the welcome names the listener role and this Walnut, else closes;
 *   3. attaches the session channel (HostChannel.attach) on the socket and lets only the
 *      companion's `listen` reach it: a resume, an ack or a resync from this link is dropped here,
 *      so the companion never leads, confirms or trims anything;
 *   4. answers the companion's call frames on LISTENER_CALLS only, through the host's own session
 *      routes (host-routes.ts call), the same table and checks the leader's calls go through.
 *
 * The credential: the bridge link's token as the runtime keeps it, in `<runtime dir>/walnuts/<key>/
 * bridge.json` (the per-Walnut file both daemon twins write on the leader's `bridge.configure`,
 * named for the home it was configured for). It is read again at every dial, so a token the leader
 * rotates (revalidateBridgeToken) is the one used next; it is never copied anywhere. A 401 means the
 * companion does not know that token: it is not dialed again with it until the file holds another.
 * Any other failure waits the backoff (1 s doubling to 60 s, with jitter).
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isChannelFrame, type HostChannel } from './channel.js'
import { dialerBackoff } from './host-dialer.js'
import { isListenerFrame, listenerCallRefusal, listenerUrlOf, type ListenerFrame } from './listener-wire.js'
import type { HostSessionRoutes } from './host-routes.js'

/** The companion link the runtime keeps for this Walnut: where to dial and with what. */
export interface CompanionLink { url: string; token: string; hostAlias: string }

const BRIDGE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/

/**
 * The bridge link of `home` in the runtime dir `runtimeDir`, or null: an enabled config with a URL a
 * host may send its token to (listenerUrlOf), a token and a host alias. Reads only.
 */
export async function readCompanionLink(runtimeDir: string, home: string): Promise<CompanionLink | null> {
  if (!runtimeDir || !home) return null
  const root = path.join(runtimeDir, 'walnuts')
  let names: string[] = []
  try { names = await fsp.readdir(root) } catch { return null }
  for (const n of names) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) continue
    let raw: Record<string, unknown> | null = null
    try { raw = JSON.parse(await fsp.readFile(path.join(root, n, 'bridge.json'), 'utf8')) as Record<string, unknown> } catch { continue }
    if (!raw || raw.enabled !== true || typeof raw.home !== 'string' || path.resolve(raw.home) !== path.resolve(home)) continue
    const url = listenerUrlOf(raw.url)
    if (!url || typeof raw.token !== 'string' || !BRIDGE_TOKEN_RE.test(raw.token)) continue
    if (typeof raw.hostAlias !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(raw.hostAlias) || raw.hostAlias === '__local__') continue
    return { url, token: raw.token, hostAlias: raw.hostAlias }
  }
  return null
}

/** The link of the runtime this service holds (server-role.ts serviceRuntime), or null for none. */
async function serviceCompanionLink(): Promise<CompanionLink | null> {
  const { serviceRuntime } = await import('../server-role.js')
  const rt = serviceRuntime()
  return rt ? readCompanionLink(rt.dir, rt.home) : null
}

export interface CompanionDialerOptions {
  walnutId: string
  enabled(): Promise<boolean>
  channel(): HostChannel | null
  routes(): HostSessionRoutes | null
  /** The companion link now (default: the service runtime's bridge.json). */
  readLink?(): Promise<CompanionLink | null>
  backoffMs?(attempt: number): number
  welcomeTimeoutMs?: number
  /** How often it looks again while there is nothing to dial. */
  idleRecheckMs?: number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface CompanionDialer {
  /** Is the companion's listener door linked and welcomed now? */
  linked(): boolean
  /** Look for a link now (a configure just changed it). */
  poke(): void
  stop(): void
}

type Outcome = 'welcomed' | 'unknown_token' | 'failed'

/** The only channel frame a listener link may hand the host's channel. */
const LISTENER_CHANNEL_OPS: ReadonlySet<string> = new Set(['listen'])

export function startCompanionDialer(o: CompanionDialerOptions): CompanionDialer {
  const say = o.log ?? (() => {})
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let current: { close(): void } | null = null
  let up = false
  /** sha256 of the tokens the companion answered 401 to: not dialed again with them. */
  const unknownTokens = new Set<string>()

  const wake = (ms: number): void => {
    if (stopped || timer) return
    timer = setTimeout(() => { timer = null; void turn() }, ms)
    timer.unref?.()
  }

  async function turn(): Promise<void> {
    if (stopped || running || current) return
    running = true
    try {
      const link = await (o.readLink ?? serviceCompanionLink)().catch(() => null)
      const on = link ? await o.enabled().catch(() => false) : false
      const key = link ? crypto.createHash('sha256').update(link.token).digest('hex') : ''
      if (!link || !on || unknownTokens.has(key)) { wake(o.idleRecheckMs ?? 60_000); return }
      const outcome = await dialOnce(link)
      if (outcome === 'welcomed') return
      if (outcome === 'unknown_token') {
        unknownTokens.add(key)
        say('warn', 'companion listener: the companion does not know this host\'s bridge token; waiting for another', { door: link.url })
        wake(o.idleRecheckMs ?? 60_000)
        return
      }
      wake((o.backoffMs ?? dialerBackoff)(attempt++))
    } finally {
      running = false
    }
  }

  async function dialOnce(link: CompanionLink): Promise<Outcome> {
    const { WebSocket } = await import('#ws')
    return new Promise<Outcome>((resolve) => {
      let settled = false
      const done = (v: Outcome): void => { if (!settled) { settled = true; resolve(v) } }
      const ws = new WebSocket(link.url, { headers: { authorization: `Bearer ${link.token}` }, handshakeTimeout: 20_000, maxPayload: 64 * 1024 * 1024 })
      const close = (why: string): void => { try { ws.close(1000, why.slice(0, 100)) } catch { ws.terminate() } }
      current = { close: () => close('stopping') }
      let welcomed = false
      let linkedAt = 0
      let handlers: ReturnType<HostChannel['attach']> | null = null
      const welcomeTimer = setTimeout(() => { if (!welcomed) close('no_welcome') }, o.welcomeTimeoutMs ?? 15_000)
      welcomeTimer.unref?.()
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0
        say('warn', 'companion listener: the companion refused the dial', { door: link.url, status })
        try { ws.terminate() } catch { /* gone */ }
        done(status === 401 ? 'unknown_token' : 'failed')
      })
      ws.on('error', (err) => { say('warn', 'companion listener: the dial failed', { door: link.url, error: err.message }) })
      ws.on('open', () => {
        const hello: ListenerFrame = { ch: 'door', op: 'hello', v: 1, role: 'listener', walnutId: o.walnutId, hostAlias: link.hostAlias }
        ws.send(JSON.stringify(hello))
      })
      ws.on('message', (raw) => {
        let frame: unknown
        try { frame = JSON.parse(String(raw)) } catch { return }
        if (!welcomed) {
          if (!isListenerFrame(frame) || frame.op !== 'welcome' || frame.role !== 'listener' || frame.walnutId !== o.walnutId) {
            say('warn', 'companion listener: the welcome did not name this Walnut\'s listener; closed', { door: link.url })
            close('bad_welcome')
            return
          }
          const channel = o.channel()
          if (!channel) { close('no_channel'); return }
          welcomed = true
          linkedAt = Date.now()
          clearTimeout(welcomeTimer)
          up = true
          say('info', 'companion listener: linked to the companion', { door: link.url })
          handlers = channel.attach({
            send: (f) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)) },
            close: (why) => close(why ?? 'closed'),
          })
          done('welcomed')
          return
        }
        // A listener only listens: any other channel frame from it never reaches the channel.
        if (isChannelFrame(frame)) { if (LISTENER_CHANNEL_OPS.has(frame.op)) handlers?.onFrame(frame); return }
        if (isListenerFrame(frame) && frame.op === 'call') void answerCall(ws, frame)
      })
      ws.on('close', () => {
        clearTimeout(welcomeTimer)
        handlers?.onClose()
        current = null
        if (welcomed) {
          up = false
          if (Date.now() - linkedAt >= 60_000) attempt = 0
          say('info', 'companion listener: the link to the companion closed', { door: link.url })
          wake((o.backoffMs ?? dialerBackoff)(attempt++))
        }
        done('failed')
      })
    })
  }

  async function answerCall(ws: import('#ws').WebSocket, f: Extract<ListenerFrame, { op: 'call' }>): Promise<void> {
    const refused = listenerCallRefusal(f.method, f.path, f.body)
    const routes = o.routes()
    const r = refused ? { status: 403, body: { ok: false, error: refused } }
      : !routes ? { status: 503, body: { ok: false, error: 'host_runs_sessions_off' } }
        : await routes.call(String(f.method), String(f.path), f.body).catch((err: unknown) => ({ status: 500, body: { ok: false, error: err instanceof Error ? err.message : String(err) } }))
    const reply: ListenerFrame = { ch: 'door', op: 'reply', id: String(f.id), status: r.status, body: r.body }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply))
  }

  void turn()
  return {
    linked: () => up,
    poke() {
      if (stopped || current) return
      if (timer) { clearTimeout(timer); timer = null }
      attempt = 0
      void turn()
    },
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      current?.close()
      current = null
    },
  }
}
