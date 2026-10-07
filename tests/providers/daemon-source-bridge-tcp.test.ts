/**
 * The JS twin's bridge TCP helpers, run from the daemon source itself
 * (connectBridgeTcp and resetBridgeTcp in daemon-source.ts).
 *
 * Gate 2026-10-06 (F3): connectBridgeTcp dropped its 'error' listener on the
 * TCP socket once TLS was on top, and an 'error' nobody listens for is an
 * uncaught exception, which ends the JS daemon. Node's TLS layer happens to
 * listen on the socket it wraps, so no run crashed; the helper must not
 * depend on that, so here the TLS layer is a stand-in that listens to nothing.
 *
 * MACHINE SAFETY: local servers on 127.0.0.1 only.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

type Holder = { tcp?: net.Socket }
type Done = (err: Error | null, socket?: unknown) => void
type Helpers = {
  connectBridgeTcp: (opts: Record<string, unknown>, secure: boolean, holder: Holder, done: Done) => net.Socket | undefined
  resetBridgeTcp: (holder: Holder) => void
}

const SOURCE = getDaemonSource()
function fnText(name: string): string {
  const start = SOURCE.indexOf(`\nfunction ${name}(`)
  expect(start, `${name} in the daemon source`).toBeGreaterThan(-1)
  return SOURCE.slice(start + 1, SOURCE.indexOf('\n}\n', start) + 2)
}
/** The two helpers as the daemon runs them, with `tlsImpl` as require('tls'). */
function loadHelpers(tlsImpl: unknown): Helpers {
  const req = createRequire(import.meta.url)
  const fakeRequire = (m: string) => (m === 'tls' ? tlsImpl : req(m))
  const body = `${fnText('connectBridgeTcp')}\n${fnText('resetBridgeTcp')}\nreturn { connectBridgeTcp, resetBridgeTcp };`
  return new Function('net', 'require', body)(net, fakeRequire) as Helpers
}

/** A TLS layer that, unlike Node's, puts no listener on the socket it wraps. */
const BARE_TLS = { connect: () => Object.assign(new EventEmitter(), { destroy() {} }) }

const cleanups: Array<() => void> = []
afterEach(() => { for (const c of cleanups.splice(0).reverse()) { try { c() } catch { /* gone */ } } })

async function listen(onSocket: (s: net.Socket) => void = () => {}): Promise<number> {
  const server = net.createServer((s) => { s.on('error', () => {}); onSocket(s) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  cleanups.push(() => server.close())
  return (server.address() as net.AddressInfo).port
}

function dial(helpers: Helpers, port: number, secure: boolean): Promise<{ holder: Holder; err: Error | null; socket: unknown }> {
  return new Promise((resolve) => {
    const holder: Holder = {}
    const returned = helpers.connectBridgeTcp({ host: '127.0.0.1', port }, secure, holder, (err, socket) => resolve({ holder, err, socket }))
    cleanups.push(() => holder.tcp?.destroy())
    if (returned) returned.once('connect', () => resolve({ holder, err: null, socket: returned }))
  })
}

describe('JS twin bridge TCP helpers', () => {
  it('keeps an error listener on the TCP socket under TLS for its whole life', async () => {
    const helpers = loadHelpers(BARE_TLS)
    const { holder, err } = await dial(helpers, await listen(), true)
    expect(err).toBeNull()
    expect(holder.tcp!.listenerCount('error')).toBeGreaterThan(0)
    // A late error on the TCP socket is heard, not thrown.
    expect(() => holder.tcp!.emit('error', new Error('late'))).not.toThrow()
  })

  it('keeps one on the plain TCP socket too, before anyone else listens', async () => {
    const helpers = loadHelpers(BARE_TLS)
    const holder: Holder = {}
    const tcp = helpers.connectBridgeTcp({ host: '127.0.0.1', port: await listen() }, false, holder, () => {})!
    cleanups.push(() => tcp.destroy())
    expect(holder.tcp).toBe(tcp)
    expect(tcp.listenerCount('error')).toBeGreaterThan(0)
    expect(() => tcp.emit('error', new Error('early'))).not.toThrow()
  })

  it('hands a failed connect to done instead of throwing', async () => {
    const helpers = loadHelpers(BARE_TLS)
    const port = await listen()
    // A port that refuses: listen, note it, close it.
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
    })
    expect(closed).not.toBe(port)
    const { err } = await dial(helpers, closed, true)
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
  })

  it('puts real TLS on the TCP socket only once it has connected', async () => {
    let wrappedWhileConnecting: boolean | null = null
    const helpers = loadHelpers({ connect: (o: { socket: net.Socket }) => {
      wrappedWhileConnecting = o.socket.connecting
      const t = tls.connect({ ...o, rejectUnauthorized: false })
      t.on('error', () => {})
      cleanups.push(() => t.destroy())
      return t
    } })
    const { holder, err } = await dial(helpers, await listen(), true)
    expect(err).toBeNull()
    expect(wrappedWhileConnecting).toBe(false)
    expect(holder.tcp!.listenerCount('error')).toBeGreaterThan(0)
  })

  it('resets a connected socket, so the peer reads ECONNRESET, and destroys one still connecting', async () => {
    const helpers = loadHelpers(BARE_TLS)
    let peerSaw: string | null = null
    const port = await listen((s) => {
      s.on('end', () => { peerSaw ??= 'FIN' })
      s.on('error', (e: NodeJS.ErrnoException) => { peerSaw ??= e.code ?? 'error' })
    })
    const { holder } = await dial(helpers, port, false)
    helpers.resetBridgeTcp(holder)
    const t0 = Date.now()
    while (peerSaw === null && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
    expect(peerSaw).toBe('ECONNRESET')

    // Still connecting (a dial that never answers): destroyed now, not after a connect.
    const connecting: Holder = { tcp: new net.Socket() }
    connecting.tcp!.on('error', () => {})
    connecting.tcp!.connect({ host: '10.255.255.1', port: 9 })
    cleanups.push(() => connecting.tcp!.destroy())
    expect(connecting.tcp!.connecting).toBe(true)
    helpers.resetBridgeTcp(connecting)
    expect(connecting.tcp!.destroyed).toBe(true)
  })
})
