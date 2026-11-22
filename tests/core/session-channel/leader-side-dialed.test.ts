/**
 * A socket the host dialed into the leader's door, handed to the leader side
 * (src/core/session-channel/leader-side.ts adopt): it is the host's link (its records applied
 * once, its calls riding it as frames, not streams), a newer link replaces the older one (closed
 * `replaced`, the host's channel takes the newer resume), and the leader dials nothing to that
 * host while it is up, whatever its daemon link does; once it closes, the leader dials as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from '#ws'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel, isChannelFrame, type ChannelCursor } from '../../../src/core/session-channel/channel.js'
import { createLeaderSide, type LeaderSide } from '../../../src/core/session-channel/leader-side.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'
import type { SessionRecord } from '../../../src/core/types.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await tick(5) }
}

let dir = ''
let server: http.Server | null = null
let sockets: net.Socket[] = []
let side: LeaderSide | null = null
let log: FactLog
let channel: HostChannel
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leader-dialed-'))
  sockets = []
  log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  const own: SessionRecord[] = [{ claudeSessionId: 's1', taskId: 't', project: 'P', process_status: 'running', mode: 'default', host: 'devbox', judge: 'host' } as SessionRecord]
  channel = new HostChannel({ log, walnutId: 'w1', hostId: 'devbox', ownRows: async () => own })
})
afterEach(async () => {
  side?.stop()
  side = null
  await log.close().catch(() => {})
  for (const s of sockets) s.destroy()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  await fsp.rm(dir, { recursive: true, force: true })
})

/** The host's daemon door: the channel's WebSocket route (the leader-dialed link). */
async function daemonDoor(): Promise<number> {
  const wss = new WebSocketServer({ noServer: true })
  server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, via: 'stream' })) })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const h = channel.attach({ send: (f) => ws.send(JSON.stringify(f)), close: (why) => ws.close(1000, why) })
      ws.on('message', (d: Buffer) => { const f = JSON.parse(d.toString()); if (isChannelFrame(f)) h.onFrame(f) })
      ws.on('close', () => h.onClose())
    })
  })
  server.on('connection', (s) => sockets.push(s))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return (server.address() as net.AddressInfo).port
}

/** A host-dialed socket straight into the host's channel, its calls answered by `answer`. */
function dialedSocket(answer: (route: string, body: unknown) => unknown = () => ({ ok: true, via: 'frames' })) {
  let toLeader: ((t: string) => void) | null = null
  const held: string[] = []
  let gone: (() => void) | null = null
  let open = true
  const calls: string[] = []
  const closes: string[] = []
  const h = channel.attach({
    send: (f) => { const t = JSON.stringify(f); if (toLeader) toLeader(t); else held.push(t) },
    close: (why) => sock.close(why),
  })
  const sock: ChannelSocket = {
    kind: 'host-dialed',
    send: (t) => { if (open) queueMicrotask(() => { const f = JSON.parse(t); if (open && isChannelFrame(f)) h.onFrame(f) }) },
    close: (why) => { if (!open) return; open = false; closes.push(why ?? ''); h.onClose(); gone?.() },
    onMessage: (fn) => { toLeader = fn; for (const t of held.splice(0)) fn(t) },
    onClose: (fn) => { gone = fn; if (!open) fn() },
    call: async (_m, route, body) => { calls.push(route); return { status: 200, body: answer(route, body) } },
  }
  return { sock, calls, closes, get open() { return open } }
}

function makeSide(port: number, opened: string[]) {
  const emitted: number[] = []
  // The leader's position, kept with each apply as the real store keeps it.
  let cursor: ChannelCursor | null = null
  const s = createLeaderSide({
    walnutId: async () => 'w1',
    permit: () => ({ permitNumber: 0, epoch: 1 }),
    flagOn: async () => true,
    openStream: async (_host, purpose) => { opened.push(purpose); return net.connect(port, '127.0.0.1') },
    applyBatch: async (b) => { cursor = b.cursor; return { written: b.rows.map((r) => r.sid), skipped: [] } },
    loadCursor: async () => cursor,
    emit: (_name, data) => { emitted.push((data as { i: number }).i) },
    noteLive: () => {}, noteRename: () => {}, noteHostJudged: () => {},
    ownerOf: () => 'devbox',
    backoffMs: () => 20,
    log: () => {},
  })
  return { side: s, emitted }
}

const fact = async (i: number) => { log.append('s1', 'session:tool-use', { sessionId: 's1', i }); await log.flush() }

describe('a host-dialed link on the leader side', () => {
  it('adopted, it is the host\'s link: records applied once, calls ride it as frames, no stream opened', async () => {
    const port = await daemonDoor()
    const opened: string[] = []
    const made = makeSide(port, opened)
    side = made.side
    const d = dialedSocket()
    expect(side.adopt('devbox', d.sock)).toBe(true)
    await until(() => channel.leaderLive())
    expect(side.linked('devbox')).toBe(true)
    expect(side.linkKind('devbox')).toBe('host-dialed')
    await until(() => side!.hostJudges('devbox'))
    await fact(1)
    await fact(2)
    await until(() => made.emitted.length === 2)
    expect(made.emitted).toEqual([1, 2])
    const a = await side.sendToHost('devbox', { sessionId: 's1', message: 'hi' })
    expect(a).toMatchObject({ ok: true, via: 'frames' })
    expect(d.calls).toEqual(['/host-api/sessions/send'])
    expect(opened).toEqual([])
  })

  it('a newer link replaces the older: the leader-dialed one, then an earlier dial-in, each closed replaced', async () => {
    const port = await daemonDoor()
    const opened: string[] = []
    const made = makeSide(port, opened)
    side = made.side
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linkKind('devbox') === 'leader-dialed' && channel.leaderLive())
    await fact(1)
    await until(() => made.emitted.length === 1)
    const first = dialedSocket()
    side.adopt('devbox', first.sock)
    await until(() => side!.linkKind('devbox') === 'host-dialed' && channel.leaderLive())
    await fact(2)
    await until(() => made.emitted.length === 2)
    const second = dialedSocket()
    side.adopt('devbox', second.sock)
    expect(first.closes).toEqual(['replaced'])
    await until(() => channel.leaderLive())
    await fact(3)
    await until(() => made.emitted.length === 3)
    // Every record once, in order, across both replacements.
    expect(made.emitted).toEqual([1, 2, 3])
    expect(second.open).toBe(true)
    expect(opened.filter((p) => p === 'session-channel')).toHaveLength(1)
  })

  it('no dial while the dialed link is up, whatever the daemon link does; once it closes the leader dials again', async () => {
    const port = await daemonDoor()
    const opened: string[] = []
    const made = makeSide(port, opened)
    side = made.side
    const d = dialedSocket()
    side.adopt('devbox', d.sock)
    await until(() => channel.leaderLive())
    // The daemon link goes and comes back: the dialed link stays, nothing is dialed.
    await side.noteHost('devbox', { connected: false, judges: false })
    expect(side.linkKind('devbox')).toBe('host-dialed')
    await side.noteHost('devbox', { connected: true, judges: true })
    await tick(100)
    expect(opened).toEqual([])
    expect(side.linkKind('devbox')).toBe('host-dialed')
    // The host's socket closes: the leader dials over its daemon link again.
    d.sock.close('gone')
    await until(() => side!.linkKind('devbox') === 'leader-dialed')
    expect(opened).toContain('session-channel')
    await until(() => channel.leaderLive())
    await fact(1)
    await until(() => made.emitted.length === 1)
  })
})
