/**
 * The leader's stream lane (providers/stream-lane.ts): a second link to a
 * host's daemon that carries streams only, on a forward of its own.
 *
 *   - StreamLane against a fake daemon: up after hello + stream.lane; a
 *     refusal, another daemon, a forward that ends or a daemon that stops
 *     answering its beats each take it down and it dials again with a growing
 *     wait; stop() during a dial installs nothing.
 *   - DaemonConnection: a host server wants a lane, so its streams ride it
 *     (not the session socket) while it is up, and the session socket again
 *     once it is not; no lane without 'stream-lane-v1'.
 * The real daemons (both twins) are tests/integration/host-server-twins.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { StreamLane, _setLaneForwardForTesting, type LaneForward } from '../../src/providers/stream-lane.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 5_000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await sleep(20)
  }
}

interface FakeDaemon {
  port: number
  sockets: Set<WebSocket>
  frames: Array<{ cmd: string; sock: WebSocket }>
  refuse: boolean
  instanceId: string
  stop(): Promise<void>
}

async function fakeDaemon(opts: { autoPong?: boolean } = {}): Promise<FakeDaemon> {
  const server = http.createServer()
  const wss = new WebSocketServer({ server, autoPong: opts.autoPong ?? true })
  const d: FakeDaemon = {
    port: 0, sockets: new Set(), frames: [], refuse: false, instanceId: 'd1',
    stop: () => new Promise((r) => { for (const s of d.sockets) s.terminate(); wss.close(); server.close(() => r()) }),
  }
  wss.on('connection', (ws) => {
    d.sockets.add(ws)
    ws.on('close', () => d.sockets.delete(ws))
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>
      d.frames.push({ cmd: String(m.cmd), sock: ws })
      if (m.cmd === 'hello') ws.send(JSON.stringify({ id: m.id, ok: true, instanceId: d.instanceId }))
      else if (m.cmd === 'stream.lane') ws.send(JSON.stringify(d.refuse ? { id: m.id, ok: false, error: 'no', errorKind: 'unknown_walnut' } : { id: m.id, ok: true }))
      else if (m.cmd === 'stream.open') ws.send(JSON.stringify({ ev: 'stream-accept', sid: m.sid }))
    })
  })
  d.port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
  return d
}

/** A forward that can end on its own, like an SSH connection a bad packet killed. */
function killableForward(target: () => number) {
  const state = { opened: 0, stopped: 0, kill: null as null | (() => void) }
  const forward = async (): Promise<LaneForward> => {
    state.opened++
    const conns = new Set<net.Socket>()
    const proxy = net.createServer((c) => {
      const u = net.connect(target(), '127.0.0.1')
      conns.add(c); conns.add(u)
      c.pipe(u).pipe(c)
      c.on('error', () => u.destroy()); u.on('error', () => c.destroy())
      c.on('close', () => u.destroy()); u.on('close', () => c.destroy())
    })
    const port = await new Promise<number>((r) => proxy.listen(0, '127.0.0.1', () => r((proxy.address() as net.AddressInfo).port)))
    let exit: ((why: string) => void) | null = null
    const end = () => { for (const s of conns) s.destroy(); proxy.close() }
    state.kill = () => { end(); exit?.('Corrupted MAC on input') }
    return { port, onExit: (cb) => { exit = cb }, stop: () => { state.stopped++; end() } }
  }
  return { forward, state }
}

const lanes: StreamLane[] = []
const daemons: FakeDaemon[] = []
afterEach(async () => {
  for (const l of lanes.splice(0)) l.stop()
  for (const d of daemons.splice(0)) await d.stop()
})

function lane(d: FakeDaemon, forward: () => Promise<LaneForward>, over: Partial<ConstructorParameters<typeof StreamLane>[0]> = {}): StreamLane {
  const l = new StreamLane({
    hostKey: 'devbox', home: '/h', walnutId: async () => 'w1', daemonInstanceId: () => 'd1',
    forward, accept: () => null, retryMs: 100, maxRetryMs: 400, beatMs: 100, ...over,
  })
  lanes.push(l)
  return l
}

describe('StreamLane', () => {
  it('is up after hello and stream.lane, and its streams ride its own socket', async () => {
    const d = await fakeDaemon(); daemons.push(d)
    const l = lane(d, async () => ({ port: d.port, onExit: () => {}, stop: () => {} }))
    await expect(l.open('follower')).rejects.toThrow(/is not up/)
    l.start()
    await waitFor(() => l.ready, 5_000, 'the lane')
    expect(d.frames.map((f) => f.cmd)).toEqual(['hello', 'stream.lane'])
    const s = await l.open('follower', 'replica')
    expect(d.frames.at(-1)).toMatchObject({ cmd: 'stream.open' })
    s.destroy()
  })

  it('a forward that ends takes it down, and it dials again on a new one', async () => {
    const d = await fakeDaemon(); daemons.push(d)
    const { forward, state } = killableForward(() => d.port)
    const l = lane(d, forward)
    l.start()
    await waitFor(() => l.ready, 5_000, 'the lane')
    const s = await l.open('follower')
    const cut = new Promise<Error>((r) => s.on('error', r))
    state.kill!()
    expect((await cut).message).toBe('the stream lane to devbox closed')
    expect(l.ready).toBe(false)
    await waitFor(() => l.ready && state.opened === 2, 5_000, 'the lane again')
  })

  it('a refusal or another daemon is not a lane, and each try waits longer, up to the cap', async () => {
    const d = await fakeDaemon(); daemons.push(d)
    d.refuse = true
    const tries: number[] = []
    const l = lane(d, async () => { tries.push(Date.now()); return { port: d.port, onExit: () => {}, stop: () => {} } })
    l.start()
    await waitFor(() => tries.length >= 4, 5_000, 'four tries')
    expect(l.ready).toBe(false)
    const gaps = tries.slice(1).map((t, i) => t - tries[i]!)
    expect(gaps[0]!).toBeGreaterThanOrEqual(90)
    expect(gaps[1]!).toBeGreaterThanOrEqual(190)
    expect(gaps[2]!).toBeGreaterThanOrEqual(390)
    l.stop()

    d.refuse = false
    d.instanceId = 'd2'
    const other = lane(d, async () => ({ port: d.port, onExit: () => {}, stop: () => {} }))
    other.start()
    await sleep(300)
    expect(other.ready).toBe(false)
    expect(d.frames.filter((f) => f.cmd === 'stream.lane' && d.sockets.has(f.sock))).toEqual([])
  })

  it('a stream waits for it: up now, back after a drop, never after a dial that failed or a stop', async () => {
    const d = await fakeDaemon(); daemons.push(d)
    const { forward, state } = killableForward(() => d.port)
    const l = lane(d, forward)
    // Not started: no lane to wait for. Started, before its first dial is through: a caller waits.
    expect(await l.waitReady(5_000)).toBe(false)
    l.start()
    expect(l.ready).toBe(false)
    expect(await l.waitReady(5_000)).toBe(true)
    expect(await l.waitReady(0)).toBe(true)
    // A drop: it dials again at once (no backoff for a lane that worked), and the wait sees it back.
    const t0 = Date.now()
    state.kill!()
    expect(l.ready).toBe(false)
    expect(await l.waitReady(5_000)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(state.opened).toBe(2)
    // A dial that fails: nobody waits for it.
    d.refuse = true
    state.kill!()
    await waitFor(() => d.frames.filter((f) => f.cmd === 'stream.lane').length >= 3, 5_000, 'the refused dial')
    await sleep(50)
    const t1 = Date.now()
    expect(await l.waitReady(5_000)).toBe(false)
    expect(Date.now() - t1).toBeLessThan(100)
    // Back once a dial comes up again.
    d.refuse = false
    expect(await l.waitReady(5_000)).toBe(false)
    await waitFor(() => l.ready, 5_000, 'the lane again')
    // A waiter is told when the lane stops.
    state.kill!()
    const waiting = l.waitReady(5_000)
    l.stop()
    expect(await waiting).toBe(false)
    expect(await l.waitReady(5_000)).toBe(false)
  })

  it('a daemon that stops answering its beats is dropped', async () => {
    const d = await fakeDaemon({ autoPong: false }); daemons.push(d)
    const { forward, state } = killableForward(() => d.port)
    const l = lane(d, forward)
    l.start()
    await waitFor(() => l.ready, 5_000, 'the lane')
    // 3 beats of 100 ms without a pong (and no frame): taken for dead, forward stopped.
    await waitFor(() => state.stopped >= 1, 2_000, 'the silent lane to drop')
    expect(state.opened).toBeGreaterThanOrEqual(1)
  })

  it('stop() during a dial installs nothing', async () => {
    const d = await fakeDaemon(); daemons.push(d)
    let release!: () => void
    let stopped = 0
    const l = lane(d, () => new Promise<LaneForward>((r) => { release = () => r({ port: d.port, onExit: () => {}, stop: () => { stopped++ } }) }))
    l.start()
    await sleep(20)
    l.stop()
    release()
    await sleep(100)
    expect(stopped).toBe(1)
    expect(l.ready).toBe(false)
    expect(d.frames).toEqual([])
  })
})

describe('DaemonConnection with a stream lane', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection

  afterEach(async () => {
    _setLaneForwardForTesting(null)
    try { conn.disconnect() } catch { /* best effort */ }
    await daemon.stop()
  })

  async function setUp(): Promise<void> {
    daemon = await createMockDaemon()
    _setLaneForwardForTesting(async () => ({ port: daemon.port, onExit: () => {}, stop: () => {} }))
    conn = new DaemonConnection('lane-host', { hostname: '127.0.0.1', user: undefined, port: undefined })
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn.bulkChannelActive, 5_000, 'the bulk channel')
  }

  it('while a host server wants it, streams ride the lane; without it, the session socket', async () => {
    await setUp()
    // Session socket 0, bulk 1. Nothing asked for a lane yet.
    await expect(conn.openStream('follower')).rejects.toThrow('mock: nobody there')
    expect(daemon.getCommandHistoryFor('stream.open').map((c) => c.connIndex)).toEqual([0])

    conn.keepStreamLane(true)
    await waitFor(() => conn.streamLaneUp, 5_000, 'the lane')
    expect(daemon.getCommandHistoryFor('stream.lane')).toEqual([expect.objectContaining({ connIndex: 2 })])
    await expect(conn.openStream('follower', 'replica')).rejects.toThrow('mock: nobody there')
    expect(daemon.getCommandHistoryFor('stream.open').map((c) => c.connIndex)).toEqual([0, 2])

    conn.keepStreamLane(false)
    expect(conn.streamLaneUp).toBe(false)
    await expect(conn.openStream('follower')).rejects.toThrow('mock: nobody there')
    expect(daemon.getCommandHistoryFor('stream.open').map((c) => c.connIndex)).toEqual([0, 2, 0])
  })

  it('a stream waits for a lane that is dialing again, not the session socket', async () => {
    await setUp()
    conn.keepStreamLane(true)
    await waitFor(() => conn.streamLaneUp, 5_000, 'the lane')
    // The lane is socket 2; it drops, and a stream asked for meanwhile goes on the next one.
    expect(daemon.killClient(2)).toBe(true)
    await waitFor(() => !conn.streamLaneUp, 5_000, 'the lane down')
    await expect(conn.openStream('follower')).rejects.toThrow('mock: nobody there')
    expect(daemon.getCommandHistoryFor('stream.open').map((c) => c.connIndex)).toEqual([3])
  })

  it('goes down with the session link', async () => {
    await setUp()
    conn.keepStreamLane(true)
    await waitFor(() => conn.streamLaneUp, 5_000, 'the lane')
    conn.disconnect()
    expect(conn.streamLaneUp).toBe(false)
  })

  it('a daemon without stream-lane-v1 gets no lane', async () => {
    await setUp()
    const c = conn as unknown as { _capabilities: string[] }
    c._capabilities = c._capabilities.filter((cap) => cap !== 'stream-lane-v1')
    conn.keepStreamLane(true)
    await sleep(200)
    expect(conn.streamLaneUp).toBe(false)
    expect(daemon.getCommandHistoryFor('stream.lane')).toEqual([])
  })
})
