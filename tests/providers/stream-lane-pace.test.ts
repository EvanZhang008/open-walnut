/**
 * A background stream's upload on the stream lane is paced, and never put on the
 * session link (2026-11-12: a relay to a dev host ends a connection that uploads at
 * 100 KB/s or more within seconds, and lets one at 20 KB/s live; the copies' rounds
 * rode the session link whenever the lane's last dial had failed).
 *
 *   - StreamLane: a 'replica' stream's bytes leave at the pace; a 'web' stream's at once;
 *     the bytes arrive whole and in order; a dropped lane says what it had sent, by purpose.
 *   - DaemonConnection.openStream: with a lane that is not up, a 'replica' stream fails
 *     with nothing sent; any other purpose still takes the session link.
 *   - Every stream purpose in src/ is classified as background (paced) or a person's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { StreamLane, _setLaneForwardForTesting, laneUploadSummary } from '../../src/providers/stream-lane.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { PACED_STREAM_PURPOSES } from '../../src/providers/ssh-upload-budget.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 5_000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

/** A daemon that takes every stream, acks its data and records when each piece came. */
async function ackingDaemon() {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const got = new Map<string, { at: number[]; bytes: Buffer[] }>()
  const sockets = new Set<WebSocket>()
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>
      if (m.cmd === 'hello') ws.send(JSON.stringify({ id: m.id, ok: true, instanceId: 'd1' }))
      else if (m.cmd === 'stream.lane') ws.send(JSON.stringify({ id: m.id, ok: true }))
      else if (m.cmd === 'stream.open') { got.set(String(m.sid), { at: [], bytes: [] }); ws.send(JSON.stringify({ ev: 'stream-accept', sid: m.sid })) }
      else if (m.cmd === 'stream.data') {
        const b = Buffer.from(String(m.d), 'base64')
        const g = got.get(String(m.sid))!
        g.at.push(Date.now()); g.bytes.push(b)
        ws.send(JSON.stringify({ ev: 'stream-ack', sid: m.sid, n: b.length }))
      }
    })
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
  return {
    port, got,
    stop: () => new Promise<void>((r) => { for (const s of sockets) s.terminate(); wss.close(); server.close(() => r()) }),
  }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  _setLaneForwardForTesting(null)
})

function payload(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7) & 0xff
  return b
}

describe('StreamLane paces a background stream', () => {
  it("a 'replica' stream leaves at the pace, a 'web' one at once, both whole", async () => {
    const d = await ackingDaemon()
    cleanups.push(d.stop)
    const l = new StreamLane({
      hostKey: 'devbox', home: '/h', walnutId: async () => 'w1', daemonInstanceId: () => 'd1',
      forward: async () => ({ port: d.port, onExit: () => {}, stop: () => {} }), accept: () => null,
      // 64 KB pieces as frames: one goes at once, then one every half second.
      pace: { bytesPerSec: 132 * 1024, burstBytes: 70 * 1024 },
    })
    cleanups.push(() => l.stop())
    l.start()
    await waitFor(() => l.ready, 5_000, 'the lane')

    const data = payload(48 * 1024 * 4)
    const web = await l.open('follower', 'web')
    const webStart = Date.now()
    web.end(data)
    await waitFor(() => [...d.got.values()].some((g) => g.bytes.length === 4), 5_000, 'the web stream')
    expect(Date.now() - webStart).toBeLessThan(400)

    const replica = await l.open('follower', 'replica')
    replica.end(data)
    await waitFor(() => [...d.got.values()].filter((g) => g.bytes.length === 4).length === 2, 8_000, 'the replica stream')
    const [webGot, replicaGot] = [...d.got.values()]
    expect(Buffer.concat(webGot!.bytes).equals(data)).toBe(true)
    expect(Buffer.concat(replicaGot!.bytes).equals(data)).toBe(true)
    // Four pieces: the first at once, the next three about 0.5 s apart.
    const span = replicaGot!.at[3]! - replicaGot!.at[0]!
    expect(span).toBeGreaterThan(1_200)
    expect(span).toBeLessThan(3_000)
  })

  it('a lane that drops says what its streams had sent, by purpose', () => {
    const s = laneUploadSummary(new Map([['replica', 3 * 1024 * 1024], ['web', 10 * 1024]]), 1_000, 61_000)
    expect(s).toEqual({ lifeS: 60, sentKB: 3082, sentKBByPurpose: { replica: 3072, web: 10 } })
  })
})

describe('DaemonConnection.openStream keeps a background stream off the session link', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection
  async function setUp(): Promise<void> {
    daemon = await createMockDaemon()
    cleanups.push(() => daemon.stop())
    conn = new DaemonConnection('lane-host', { hostname: '127.0.0.1', user: undefined, port: undefined })
    cleanups.push(() => conn.disconnect())
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'the bulk channel')
  }

  it("with a lane whose dial failed, 'replica' fails with nothing sent; 'web' takes the session link", async () => {
    await setUp()
    _setLaneForwardForTesting(async () => { throw new Error('connection refused') })
    conn.keepStreamLane(true)
    await sleep(200)
    expect(conn.streamLaneUp).toBe(false)
    await expect(conn.openStream('follower', 'replica')).rejects.toThrow(/stream lane to lane-host is not up/)
    expect(daemon.getCommandHistoryFor('stream.open')).toEqual([])
    await expect(conn.openStream('follower', 'web')).rejects.toThrow('mock: nobody there')
    expect(daemon.getCommandHistoryFor('stream.open').map((c) => c.connIndex)).toEqual([0])
  })

  it('with no lane at all (a host off SSH), a background stream rides the link as before', async () => {
    await setUp()
    await expect(conn.openStream('follower', 'replica')).rejects.toThrow('mock: nobody there')
    expect(daemon.getCommandHistoryFor('stream.open').map((c) => c.connIndex)).toEqual([0])
  })
})

describe('every stream purpose is classified', () => {
  // A person's purposes: a browser's page or a door it reaches; they go at once.
  const PERSON = new Set(['web'])
  it('each openStream purpose in src/ is background (paced) or a person\'s', () => {
    const root = path.resolve(__dirname, '../../src')
    const found = new Set<string>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/openStream\(\s*['"][a-z]+['"]\s*,\s*['"]([a-z-]+)['"]/g)) found.add(m[1]!)
        }
      }
    }
    walk(root)
    expect(found.size).toBeGreaterThan(0)
    for (const purpose of found) {
      expect(PACED_STREAM_PURPOSES.has(purpose) || PERSON.has(purpose), `stream purpose '${purpose}' is not classified`).toBe(true)
    }
    expect(found.has('replica')).toBe(true)
  })
})
