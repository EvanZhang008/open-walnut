/**
 * A request in flight to a daemon shutting down for a swap waits for the next daemon and goes
 * on by itself (2026-11-10: a 6.6 MB attachment stopped at 0% with "internal daemon error handling
 * upload.part: Daemon is shutting down; retry after reconnecting" and a Retry button, in the
 * second a deploy replaced the Mac's daemon). The loop itself, then the server's connection to
 * a daemon end to end (a refusal, the socket closing, the next daemon), then the bridge.
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('daemon-drain-resend', { CLOUD_MODE: true }))
import {
  DRAIN_RESEND_EXEMPT, daemonSwapExpected, expectDaemonSwap, isDaemonDrainRefusal, resendThroughSwap, resendsAfter, wakeHostLink, waitHostLink, type SwapLink,
} from '../../src/providers/daemon-drain-resend.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { attachBridge, bridgeRequest, closeAllBridges } from '../../src/web/ws/bridge-registry.js'

const REFUSAL = (cmd: string) => ({ ok: false, error: `internal daemon error handling ${cmd}: Daemon is shutting down; retry after reconnecting` })

/** A link that answers from a script: each entry is a reply, or an error to throw. */
function scripted(steps: Array<Record<string, unknown> | Error>, opts: { swap?: boolean } = {}) {
  let refusedAt = 0
  const tries: number[] = []
  const link: SwapLink<Record<string, unknown>> = {
    once: async () => {
      tries.push(Date.now())
      const step = steps.shift()
      if (!step) throw new Error('script ran out')
      if (step instanceof Error) throw step
      return step
    },
    failure: (err) => ((err as { kind?: string }).kind === 'no-link' ? 'no-link' : (err as { kind?: string }).kind === 'lost' ? 'lost' : null),
    swapUnderway: () => opts.swap === true || Date.now() - refusedAt < 60_000,
    noteRefusal: () => { refusedAt = Date.now() },
    waitLink: (ms) => waitHostLink('test-link', ms, () => false),
  }
  return { link, tries }
}
const fail = (kind: 'no-link' | 'lost' | 'other') => Object.assign(new Error(kind), { kind })

afterEach(() => { closeAllBridges(); vi.useRealTimers() })

describe('the resend loop', () => {
  it('reads the drain refusal by its words or its kind, never another error', () => {
    expect(isDaemonDrainRefusal(REFUSAL('upload.part'))).toBe(true)
    expect(isDaemonDrainRefusal({ ok: false, error: 'upload.part failed: Daemon is shutting down; retry after reconnecting', code: 'shutting_down' })).toBe(true)
    expect(isDaemonDrainRefusal({ ok: false, errorKind: 'daemon_draining' })).toBe(true)
    expect(isDaemonDrainRefusal({ ok: false, error: 'Daemon has active operations; retry after they finish' })).toBe(false)
    expect(isDaemonDrainRefusal({ ok: false, error: 'not found' })).toBe(false)
    expect(isDaemonDrainRefusal({ ok: true, error: 'Daemon is shutting down; retry after reconnecting' })).toBe(false)
    expect(isDaemonDrainRefusal(null)).toBe(false)
  })

  it('sends a refused command again and answers what the next daemon says', async () => {
    const { link, tries } = scripted([REFUSAL('upload.part'), { ok: true, path: '/tmp/x' }])
    const pending = resendThroughSwap('upload.part', link, 30_000)
    setTimeout(() => wakeHostLink('test-link'), 20)
    expect(await pending).toEqual({ ok: true, path: '/tmp/x' })
    expect(tries).toHaveLength(2)
  })

  it('a refusal, then no link while the old daemon exits, then the new daemon: the command goes through', async () => {
    const { link, tries } = scripted([REFUSAL('fs.read'), fail('no-link'), fail('no-link'), { ok: true, content: 'x' }])
    const pending = resendThroughSwap('fs.read', link, 30_000)
    const wakes = setInterval(() => wakeHostLink('test-link'), 15)
    try {
      expect(await pending).toEqual({ ok: true, content: 'x' })
    } finally { clearInterval(wakes) }
    expect(tries).toHaveLength(4)
  })

  it('a reply lost in the swap is sent again only for a command the same done twice', async () => {
    expect(resendsAfter('fs.read', 'lost')).toBe(true)
    // A part the old daemon may still be appending is asked again by the browser, not here.
    expect(resendsAfter('upload.part', 'lost')).toBe(false)
    expect(resendsAfter('send', 'lost')).toBe(false)
    expect(resendsAfter('send', 'refused')).toBe(true)
    const again = scripted([fail('lost'), { ok: true }], { swap: true })
    setTimeout(() => wakeHostLink('test-link'), 10)
    expect(await resendThroughSwap('fs.read', again.link, 30_000)).toEqual({ ok: true })
    const once = scripted([fail('lost'), { ok: true }], { swap: true })
    await expect(resendThroughSwap('send', once.link, 30_000)).rejects.toThrow('lost')
    expect(once.tries).toHaveLength(1)
  })

  it('no link and no swap fails at once, as before', async () => {
    const { link, tries } = scripted([fail('no-link')])
    await expect(resendThroughSwap('fs.read', link, 30_000)).rejects.toThrow('no-link')
    expect(tries).toHaveLength(1)
  })

  it('a command about the old daemon itself gets its refusal', async () => {
    for (const cmd of Object.keys(DRAIN_RESEND_EXEMPT)) {
      const { link, tries } = scripted([REFUSAL(cmd)])
      expect(await resendThroughSwap(cmd, link, 30_000)).toEqual(REFUSAL(cmd))
      expect(tries).toHaveLength(1)
    }
  })

  it('is bounded by the caller\'s own timeout: past it the last answer stands', async () => {
    const steps = Array.from({ length: 100 }, () => REFUSAL('fs.ls'))
    const { link } = scripted(steps)
    const started = Date.now()
    expect(await resendThroughSwap('fs.ls', link, 150)).toEqual(REFUSAL('fs.ls'))
    expect(Date.now() - started).toBeLessThan(2_000)
    const gone = scripted([REFUSAL('fs.ls'), ...Array.from({ length: 10 }, () => fail('no-link'))])
    await expect(resendThroughSwap('fs.ls', gone.link, 150)).rejects.toThrow('no-link')
    // Each later try waits only for what is left of the caller's time.
    const budgets: number[] = []
    let n = 0
    await resendThroughSwap('fs.ls', {
      once: async (budget) => { budgets.push(budget); return n++ === 0 ? REFUSAL('fs.ls') : { ok: true } },
      failure: () => null, swapUnderway: () => true, noteRefusal: () => {},
      waitLink: (ms) => waitHostLink('budget-link', ms, () => false),
    }, 400)
    expect(budgets[0]).toBe(400)
    expect(budgets[1]).toBeLessThan(400)
  })

  it('a link that reads up while its socket still closes never spins the loop', async () => {
    let tries = 0
    const started = Date.now()
    await expect(resendThroughSwap('fs.read', {
      once: async () => { tries++; throw fail('no-link') },
      failure: () => 'no-link', swapUnderway: () => true, noteRefusal: () => {},
      // Always "up": the wait returns at once.
      waitLink: () => Promise.resolve(),
    }, 500)).rejects.toThrow('no-link')
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    expect(tries).toBeLessThan(15)
  })

  it('a swap that ends while a request waits ends its wait at the next look', async () => {
    let swap = true
    setTimeout(() => { swap = false }, 50)
    const started = Date.now()
    await expect(resendThroughSwap('fs.read', {
      once: async () => { throw fail('no-link') },
      failure: () => 'no-link', swapUnderway: () => swap, noteRefusal: () => {},
      waitLink: (ms) => waitHostLink('ending-swap', ms, () => false),
    }, 60_000)).rejects.toThrow('no-link')
    // One slice at most, not the whole minute.
    expect(Date.now() - started).toBeLessThan(7_000)
  })
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) { const p = addr.port; srv.close(() => resolve(p)) } else srv.close(() => reject(new Error('no port')))
    })
  })
}

/** The commands these tests send; the connect's own (hello, the pushes) are answered and not counted. */
const UNDER_TEST = new Set(['upload.part', 'fs.read', 'fs.stat'])

/** A daemon on `port`: `draining` refuses the commands under test the way the real drain does, then closes. */
function daemon(port: number, mode: 'draining' | 'serving', seen: string[]): WebSocketServer {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      const cmd = JSON.parse(raw.toString()) as { id?: number; cmd?: string; offset?: number }
      if (typeof cmd.id !== 'number') return
      if (!UNDER_TEST.has(String(cmd.cmd))) { ws.send(JSON.stringify({ id: cmd.id, ok: true, pong: true, version: 'test', capabilities: [] })); return }
      seen.push(`${mode}:${cmd.cmd}`)
      if (mode === 'draining') {
        ws.send(JSON.stringify({ id: cmd.id, ...REFUSAL(String(cmd.cmd)) }))
        setTimeout(() => ws.close(), 50)
        return
      }
      ws.send(JSON.stringify({ id: cmd.id, ok: true, path: '/staged/file.tiff', offset: cmd.offset }))
    })
  })
  return wss
}

describe('the server connection to a daemon through a swap', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => { for (const close of closers.splice(0)) await close() })
  const keep = (wss: WebSocketServer) => {
    closers.push(() => new Promise<void>((r) => { for (const client of wss.clients) client.terminate(); wss.close(() => r()) }))
    return wss
  }

  it('an upload part the old daemon refused is saved by the new one, with no error to the caller', async () => {
    const seen: string[] = []
    const [oldPort, newPort] = [await freePort(), await freePort()]
    keep(daemon(oldPort, 'draining', seen))
    keep(daemon(newPort, 'serving', seen))
    const conn = new DaemonConnection('swap-host', { hostname: '127.0.0.1', user: undefined, port: undefined })
    closers.push(async () => { conn.disconnect() })
    await conn.connectDirect(`ws://127.0.0.1:${oldPort}`)
    const part = conn.send('upload.part', { uploadId: 'up-1', offset: 0, data: 'AAAA' }, 5_000)
    // The old daemon closes; the new one comes up a moment later (the reconnect).
    await vi.waitFor(() => expect(conn.connected).toBe(false), { timeout: 5_000, interval: 20 })
    await conn.connectDirect(`ws://127.0.0.1:${newPort}`)
    expect(await part).toMatchObject({ ok: true, path: '/staged/file.tiff', offset: 0 })
    expect(seen).toEqual(['draining:upload.part', 'serving:upload.part'])
  })

  it('a command sent while the old daemon has gone and the new one is not up yet waits for it', async () => {
    const seen: string[] = []
    const [oldPort, newPort] = [await freePort(), await freePort()]
    keep(daemon(oldPort, 'draining', seen))
    keep(daemon(newPort, 'serving', seen))
    const conn = new DaemonConnection('swap-host-2', { hostname: '127.0.0.1', user: undefined, port: undefined })
    closers.push(async () => { conn.disconnect() })
    await conn.connectDirect(`ws://127.0.0.1:${oldPort}`)
    const first = conn.send('fs.read', { path: '/a' }, 5_000)
    await vi.waitFor(() => expect(conn.connected).toBe(false), { timeout: 5_000, interval: 20 })
    // In the gap: no link, a swap under way.
    const gap = conn.send('fs.stat', { path: '/b' }, 5_000)
    await conn.connectDirect(`ws://127.0.0.1:${newPort}`)
    expect(await first).toMatchObject({ ok: true })
    expect(await gap).toMatchObject({ ok: true })
    expect(seen).toEqual(['draining:fs.read', 'serving:fs.read', 'serving:fs.stat'])
  })

  it('a request in the gap of an announced restart (no refusal seen yet) waits for the next daemon', async () => {
    const seen: string[] = []
    const newPort = await freePort()
    keep(daemon(newPort, 'serving', seen))
    const conn = new DaemonConnection('swap-host-3', { hostname: '127.0.0.1', user: undefined, port: undefined })
    closers.push(async () => { conn.disconnect() })
    expectDaemonSwap('daemon:swap-host-3')
    const gap = conn.send('upload.part', { uploadId: 'up-3', offset: 0, data: 'AAAA' }, 5_000)
    await conn.connectDirect(`ws://127.0.0.1:${newPort}`)
    expect(await gap).toMatchObject({ ok: true })
    // The link that came up ends the announcement: a later gap fails at once again.
    expect(daemonSwapExpected('daemon:swap-host-3')).toBe(false)
  })

  it('with no swap a host that is not connected still fails at once', async () => {
    const conn = new DaemonConnection('down-host', { hostname: '127.0.0.1', user: undefined, port: undefined })
    await expect(conn.send('fs.read', { path: '/a' }, 1_000)).rejects.toThrow(/not connected/)
  })
})

class Peer extends EventEmitter {
  readyState = 1
  sent: Array<{ id: number; cmd: string }> = []
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  close(code = 1000): void { this.readyState = 3; this.emit('close', code, Buffer.alloc(0)) }
  frame(value: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(value))) }
}
function peer(): Peer {
  const current = new Peer()
  attachBridge(current as never, 'bridge-swap-peer')
  current.frame({ ev: 'hello', hostAlias: 'swap-peer', sids: [] })
  return current
}

describe('the bridge through a swap', () => {
  it('a part the old daemon refused over the bridge is saved once the new daemon dials in', async () => {
    const old = peer()
    const part = bridgeRequest('swap-peer', 'upload.part', { uploadId: 'up-2', offset: 0, data: 'AAAA' })
    await vi.waitFor(() => expect(old.sent).toHaveLength(1))
    old.frame({ id: old.sent[0].id, ...REFUSAL('upload.part') })
    old.close()
    const next = peer()
    await vi.waitFor(() => expect(next.sent.filter((f) => f.cmd === 'upload.part')).toHaveLength(1), { timeout: 5_000, interval: 20 })
    const resent = next.sent.find((f) => f.cmd === 'upload.part')!
    next.frame({ id: resent.id, ok: true, path: '/staged/b.tiff' })
    expect(await part).toMatchObject({ ok: true, path: '/staged/b.tiff' })
  })

  it('a bridge that is gone with no swap fails at once, as before', async () => {
    await expect(bridgeRequest('nobody', 'fs.read', {})).rejects.toThrow(/No live bridge/)
  })
})
