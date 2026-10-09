/**
 * One connection dials once. A caller that needs the local daemon while the
 * connection's own reconnect loop is waiting or dialling joins that loop; it
 * never dials beside it (runner gate r3, section 4).
 *
 * The race this pins: a send that hears its link closed asks again at once
 * (RemoteSessionManager.confirmSend), so its ensureConnected runs while the
 * reconnect loop is dialling. getDirectDaemonConnection used to call
 * connectDirect on the same instance, which checked `_connected` once and set
 * no `_connecting`: two sockets. The later one became `this.ws`, the abandoned
 * one's close tore the good link down, and connectDirect dialled the URL the
 * caller held even after the daemon had restarted on another port.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-single-dial'))

const fakeLocal = vi.hoisted(() => ({ wsUrl: '' as string, pid: null as number | null, ensureRunning: async () => {} }))
vi.mock('../../src/providers/local-daemon.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  localDaemon: fakeLocal,
}))

import {
  DaemonConnection, disconnectAllDaemons, getDirectDaemonConnection, setPooledConnectionForTest,
} from '../../src/providers/daemon-connection.js'
import { REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const p = addr.port
        srv.close(() => resolve(p))
      } else srv.close(() => reject(new Error('no port')))
    })
  })
}

/** A daemon that answers every command, `hello` after `helloDelayMs`. */
interface FakeDaemon { url: string; sockets: WebSocket[]; stop(): Promise<void> }

async function startDaemon(helloDelayMs: number, instanceId: string): Promise<FakeDaemon> {
  const port = await freePort()
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  const sockets: WebSocket[] = []
  wss.on('connection', (ws: WebSocket) => {
    sockets.push(ws)
    ws.on('message', (raw) => {
      let cmd: { id?: number; cmd?: string }
      try { cmd = JSON.parse(raw.toString()) } catch { return }
      if (typeof cmd.id !== 'number') return
      const body = cmd.cmd === 'hello'
        ? { version: 'fake', capabilities: [...REQUIRED_DAEMON_CAPABILITIES], instanceId, startedAt: Date.now(), uptimeSec: 0 }
        : { sessions: [] }
      const reply = () => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: cmd.id, ok: true, ...body })) }
      if (cmd.cmd === 'hello') setTimeout(reply, helloDelayMs)
      else reply()
    })
  })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  return {
    url: `ws://127.0.0.1:${port}`, sockets,
    stop: async () => {
      for (const s of sockets) s.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const reconnectDelay = DaemonConnection as unknown as { RECONNECT_DELAY_MS: number }

/**
 * Every dial of a connection's own socket (connectWebSocket), by URL. The
 * server's socket count cannot tell them from the bulk channel's, which every
 * connect opens beside the main socket on purpose. `dialled(n)` resolves once n
 * dials have started: a test waits on the dial itself, never on a guess of how
 * long the loop takes to get there (a loaded machine made 80 ms too short).
 */
function watchDials(): { urls: string[]; dialled: (n: number) => Promise<void> } {
  const urls: string[] = []
  const waiting: Array<{ n: number; resolve: () => void }> = []
  const proto = DaemonConnection.prototype as unknown as Record<string, (...args: unknown[]) => Promise<void>>
  const real = proto.connectWebSocket
  vi.spyOn(proto, 'connectWebSocket').mockImplementation(function (this: unknown, ...args: unknown[]) {
    urls.push(String(args[0]))
    for (const w of waiting.filter((x) => urls.length >= x.n)) {
      waiting.splice(waiting.indexOf(w), 1)
      w.resolve()
    }
    return real.apply(this, args)
  })
  const dialled = (n: number) => urls.length >= n
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiting.push({ n, resolve }) })
  return { urls, dialled }
}

/** Resolves once `cond` holds; the test's own timeout bounds it. */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await sleep(5)
}

describe('DaemonConnection: one connection, one dial', () => {
  const daemons: FakeDaemon[] = []
  let savedDelay = 0

  beforeEach(() => { savedDelay = reconnectDelay.RECONNECT_DELAY_MS })

  afterEach(async () => {
    disconnectAllDaemons()
    vi.restoreAllMocks()
    reconnectDelay.RECONNECT_DELAY_MS = savedDelay
    for (const d of daemons.splice(0)) await d.stop().catch(() => {})
  })

  it('a dial while the reconnect loop is dialling joins it, and the link stays up', async () => {
    const daemon = await startDaemon(300, 'one')
    daemons.push(daemon)
    fakeLocal.wsUrl = daemon.url
    reconnectDelay.RECONNECT_DELAY_MS = 20
    const conn = await getDirectDaemonConnection('__local__', daemon.url)
    const { urls: dials, dialled } = watchDials()

    // The link drops; the loop re-dials after 20 ms and waits 300 ms for hello.
    daemon.sockets[0].terminate()
    await dialled(1)
    expect(conn.reconnectInFlight).not.toBeNull()
    // A send that heard the close asks again now (confirmSend -> ensureConnected).
    const joined = await getDirectDaemonConnection('__local__', daemon.url)
    expect(joined).toBe(conn)
    expect(conn.connected).toBe(true)
    expect(dials).toEqual([daemon.url])

    // Nothing tears the link down afterwards, and it still answers.
    await sleep(400)
    expect(conn.connected).toBe(true)
    expect(dials).toEqual([daemon.url])
    await expect(conn.send('ping', {}, 2_000)).resolves.toMatchObject({ ok: true })
  })

  it('a dial while the loop waits on its backoff runs the loop now, at the daemon\'s new address', async () => {
    const before = await startDaemon(0, 'old')
    daemons.push(before)
    fakeLocal.wsUrl = before.url
    reconnectDelay.RECONNECT_DELAY_MS = 30_000
    const conn = await getDirectDaemonConnection('__local__', before.url)
    expect(conn.daemonInstanceId).toBe('old')

    // The daemon restarts on another port; the caller still holds the old URL.
    const after = await startDaemon(0, 'new')
    daemons.push(after)
    await before.stop()
    fakeLocal.wsUrl = after.url
    await until(() => conn.reconnectPending)
    expect(conn.connected).toBe(false)
    const { urls: dials } = watchDials()

    const joined = await getDirectDaemonConnection('__local__', before.url)
    expect(joined).toBe(conn)
    expect(conn.connected).toBe(true)
    expect(conn.daemonInstanceId).toBe('new')
    expect(dials).toEqual([after.url])
    expect(conn.reconnectPending).toBe(false)
  })

  it('a Connect now and a send\'s retry at once share one dial', async () => {
    const daemon = await startDaemon(200, 'shared')
    daemons.push(daemon)
    fakeLocal.wsUrl = daemon.url
    reconnectDelay.RECONNECT_DELAY_MS = 30_000
    const conn = await getDirectDaemonConnection('__local__', daemon.url)
    daemon.sockets[0].terminate()
    await until(() => conn.reconnectPending)
    const { urls: dials } = watchDials()

    const [a, b] = await Promise.all([
      conn.reconnectNow().then(() => conn),
      getDirectDaemonConnection('__local__', daemon.url),
    ])
    expect(a).toBe(conn)
    expect(b).toBe(conn)
    expect(conn.connected).toBe(true)
    expect(dials).toEqual([daemon.url])
  })

  it('a reconnect asked for while a first dial runs joins that dial', async () => {
    const daemon = await startDaemon(200, 'first')
    daemons.push(daemon)
    fakeLocal.wsUrl = daemon.url
    const conn = new DaemonConnection('__local__', null)
    setPooledConnectionForTest(`direct:${daemon.url}`, conn)
    const { urls: dials, dialled } = watchDials()
    const first = conn.connectDirect(daemon.url)
    await dialled(1)
    // The hello is still on its way: a Connect now joins this dial.
    await Promise.all([first, conn.reconnectNow()])
    expect(conn.connected).toBe(true)
    expect(dials).toEqual([daemon.url])
  })
})
