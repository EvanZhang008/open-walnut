/**
 * DaemonConnection.ensurePortForward on a host network machine (`via: 'net'`): no
 * SSH at all (every `ssh` spawn and sshExec is refused here), so the forward is a
 * 127.0.0.1 listener whose connections are port streams on the daemon link
 * ('port-stream-v1'). The link is a fake socket wired to the daemon's real relay
 * (stream-relay-core.ts) with real loopback connects to servers this test owns:
 * everything between the browser's socket and the service is the real code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'

const sshSpawns = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'ssh') { sshSpawns.push(args); throw new Error('ssh refused by the test: SSH certificate expired') }
      return original.spawn(cmd, args, opts as never)
    }),
  }
})

// listenLoopback as it is, except where a test asks for a fake listener held at a
// gate: the race cases then own every listener and nothing listens on the system.
type FakeForward = { port: number; readonly listening: boolean; connections(): number; close: ReturnType<typeof vi.fn> }
const loopback = vi.hoisted(() => ({ fake: false, gate: null as Promise<void> | null, made: [] as unknown[], next: 41_000 }))
vi.mock('../../src/lib/link-stream.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/link-stream.js')>()
  return {
    ...original,
    listenLoopback: async (...args: Parameters<typeof original.listenLoopback>) => {
      let fwd: unknown
      if (loopback.fake) {
        let open = true
        fwd = { port: loopback.next++, get listening() { return open }, connections: () => 0, close: vi.fn(() => { open = false }) }
      } else {
        fwd = await original.listenLoopback(...args)
      }
      loopback.made.push(fwd)
      if (loopback.gate) await loopback.gate
      return fwd
    },
  }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createStreamRelay } from '../../src/providers/stream-relay-core.js'

const target = { hostname: 'joined-box.walnut-net.invalid', via: 'net' as const, endpoint: '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b' }
const conns: DaemonConnection[] = []
const servers: net.Server[] = []

type Internals = {
  ws: unknown
  streams: { closeAll(reason: string): void; handle(msg: Record<string, unknown>): boolean } | null
  streamEndpoint(): { handle(msg: Record<string, unknown>): boolean }
  sshExec: (...args: unknown[]) => Promise<string>
}

afterEach(() => {
  loopback.fake = false
  loopback.gate = null
  loopback.made.length = 0
  for (const c of conns.splice(0)) c.disconnect()
  for (const s of servers.splice(0)) s.close()
  sshSpawns.length = 0
  vi.restoreAllMocks()
})

/** A net host's connection whose daemon link is the real relay, in memory. */
function setup(o: { caps?: string[] } = {}) {
  const conn = new DaemonConnection('joined-box', target)
  conns.push(conn)
  const inner = conn as unknown as Internals
  const sshExec = vi.spyOn(inner, 'sshExec').mockRejectedValue(new Error('SSH certificate expired'))
  const caps = o.caps ?? ['stream-relay-v1', 'port-stream-v1']
  vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => caps.includes(cap))
  const link = { up: true }
  const dialled: Array<{ port: number; host: string }> = []
  const relay = createStreamRelay<typeof link>({
    send: (_l, ev, data) => { queueMicrotask(() => { if (link.up) inner.streamEndpoint().handle({ ev, ...data }) }) },
    log: () => {},
    connect: (port, host) => { dialled.push({ port, host }); return net.connect({ port, host, allowHalfOpen: true }) },
  })
  const ws = {
    readyState: 1,
    send: (message: string) => {
      const frame = JSON.parse(message) as Record<string, unknown>
      queueMicrotask(() => {
        const cmd = String(frame.cmd)
        // The daemon's openStreamNow: this is the primary's own socket.
        if (cmd === 'stream.open' && frame.to === 'port') relay.openPort(link, frame.sid, frame.port, frame.host)
        else if (cmd.startsWith('stream.')) relay.frame(link, cmd.slice('stream.'.length), frame)
      })
    },
    close: () => {},
  }
  inner.ws = ws
  /** The link drops (the daemon drops its streams, the Mac closes its own), then comes back. */
  const drop = () => { link.up = false; ws.readyState = 3; relay.dropLink(link); inner.streams?.closeAll('the link to joined-box closed') }
  const restore = () => { link.up = true; ws.readyState = 1 }
  return { conn, relay, dialled, sshExec, drop, restore }
}

async function service(handler: http.RequestListener = (req, res) => res.end(`ok ${req.url}`)): Promise<number> {
  const s = http.createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as net.AddressInfo).port
}

function get(port: number, path = '/'): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (b: Buffer) => parts.push(b))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      res.on('error', reject)
      // A cut mid-answer: never a partial body taken for a whole one.
      res.on('close', () => { if (!res.complete) reject(new Error('the answer was cut')) })
    })
    req.on('error', reject)
  })
}

describe('ensurePortForward over the host network (SSH refused entirely)', () => {
  it('forwards a service preview through the daemon link, with no ssh spawned or run', async () => {
    const { conn, dialled, sshExec } = setup()
    const remote = await service()
    const local = await conn.ensurePortForward(remote, 'localhost', { evictable: true })
    expect(local).not.toBe(remote)
    expect(await get(local, '/app?x=1')).toEqual({ status: 200, body: Buffer.from('ok /app?x=1') })
    expect(dialled[0]).toEqual({ port: remote, host: '127.0.0.1' })
    expect(sshSpawns).toEqual([])
    expect(sshExec).not.toHaveBeenCalled()
  })

  it('carries a binary answer whole, and the embedded VS Code default target works too', async () => {
    const body = Buffer.alloc(2 * 1024 * 1024 + 3)
    for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff
    const { conn } = setup()
    const remote = await service((_req, res) => res.end(body))
    const local = await conn.ensurePortForward(remote)
    const got = await get(local)
    expect(got.body.equals(body)).toBe(true)
  })

  it('concurrent calls for one forward share one listener, and parallel browser connections each get a stream', async () => {
    const { conn, dialled } = setup()
    const remote = await service()
    const ports = await Promise.all([1, 2, 3].map(() => conn.ensurePortForward(remote, 'localhost', { evictable: true })))
    expect(new Set(ports).size).toBe(1)
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => get(ports[0], `/p${i}`)))
    expect(answers.map((a) => a.body.toString())).toEqual(Array.from({ length: 8 }, (_, i) => `ok /p${i}`))
    expect(dialled).toHaveLength(8)
  })

  it('refuses a target that is not the host\'s own loopback and an invalid port, plainly', async () => {
    const { conn, dialled } = setup()
    await expect(conn.ensurePortForward(8080, 'joined-box.example.test', { evictable: true })).rejects.toThrow(/reaches only its own loopback.*not joined-box\.example\.test/)
    await expect(conn.ensurePortForward(8080, '10.0.0.8')).rejects.toThrow(/only its own loopback/)
    for (const bad of [0, 65536, 80.5, Number.NaN]) {
      await expect(conn.ensurePortForward(bad, 'localhost')).rejects.toThrow(/TCP port from 1 to 65535/)
    }
    expect(dialled).toEqual([])
    expect(sshSpawns).toEqual([])
  })

  it('says the daemon needs an update when it has no port streams, and never falls back to ssh', async () => {
    const { conn } = setup({ caps: ['stream-relay-v1'] })
    await expect(conn.ensurePortForward(8080, 'localhost', { evictable: true })).rejects.toThrow(/needs a newer Walnut daemon there/)
    expect(sshSpawns).toEqual([])
  })

  it('a port nobody listens on is closed at the browser, not hung', async () => {
    const { conn } = setup()
    const s = net.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const dead = (s.address() as net.AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    const local = await conn.ensurePortForward(dead, '127.0.0.1', { evictable: true })
    await expect(get(local)).rejects.toThrow()
  })

  it('a link drop cuts live connections, and the same local port works again once the link is back', async () => {
    const { conn, drop, restore } = setup()
    let hold: http.ServerResponse | null = null
    const remote = await service((req, res) => { if (req.url === '/hold') { hold = res; res.write('part') } else res.end('fresh') })
    const local = await conn.ensurePortForward(remote, 'localhost', { evictable: true })
    const held = get(local, '/hold')
    await vi.waitFor(() => { expect(hold).not.toBeNull() }, { timeout: 5_000, interval: 10 })
    drop()
    await expect(held).rejects.toThrow()
    // While the link is down a new connection is refused at once.
    await expect(get(local)).rejects.toThrow()
    restore()
    expect(await conn.ensurePortForward(remote, 'localhost', { evictable: true })).toBe(local)
    expect((await get(local)).body.toString()).toBe('fresh')
  })

  it('closePortForward stops the listener; the next call listens again', async () => {
    const { conn } = setup()
    const remote = await service()
    const local = await conn.ensurePortForward(remote, 'localhost', { evictable: true })
    conn.closePortForward(remote, 'localhost')
    await expect(get(local)).rejects.toThrow()
    const again = await conn.ensurePortForward(remote, 'localhost', { evictable: true })
    expect((await get(again)).body.toString()).toBe('ok /')
  })

  it('keeps at most 12 service forwards, least recently used first, and never evicts VS Code', async () => {
    const { conn } = setup()
    const remote = await service()
    const vscode = await conn.ensurePortForward(remote)
    const byTarget = new Map<string, number>()
    for (let i = 1; i <= 12; i++) byTarget.set(`127.0.0.${i}`, await conn.ensurePortForward(remote, `127.0.0.${i}`, { evictable: true }))
    // Touch the oldest so it becomes the most recent, then add one more.
    await conn.ensurePortForward(remote, '127.0.0.1', { evictable: true })
    await conn.ensurePortForward(remote, '127.0.0.13', { evictable: true })
    await expect(get(byTarget.get('127.0.0.2')!)).rejects.toThrow()
    expect((await get(byTarget.get('127.0.0.1')!)).status).toBe(200)
    expect((await get(vscode)).status).toBe(200)
  })

  it('disconnect stops every forward', async () => {
    const { conn } = setup()
    const remote = await service()
    const a = await conn.ensurePortForward(remote, 'localhost', { evictable: true })
    const b = await conn.ensurePortForward(remote)
    conn.disconnect()
    await expect(get(a)).rejects.toThrow()
    await expect(get(b)).rejects.toThrow()
  })
})

describe('a forward closed while it is opening (fake listeners only)', () => {
  /** Hold every new listener at a gate until `release`. */
  function hold(): () => void {
    let release = () => {}
    loopback.fake = true
    loopback.gate = new Promise<void>((r) => { release = r })
    return () => { loopback.gate = null; release() }
  }
  const made = () => loopback.made as FakeForward[]
  const forwards = (c: DaemonConnection) => (c as unknown as { portForwards: Map<string, unknown> }).portForwards

  it('closePortForward stops a listener that comes up after it, and the next call dials anew', async () => {
    const { conn } = setup()
    const release = hold()
    const opening = conn.ensurePortForward(9000, 'localhost', { evictable: true })
    await vi.waitFor(() => { expect(made()).toHaveLength(1) }, { timeout: 2_000, interval: 5 })
    conn.closePortForward(9000, 'localhost')
    release()
    await expect(opening).rejects.toThrow(/closed while it was opening/)
    expect(made()[0].close).toHaveBeenCalled()
    expect(forwards(conn).size).toBe(0)
    const again = await conn.ensurePortForward(9000, 'localhost', { evictable: true })
    expect(made()).toHaveLength(2)
    expect(again).toBe(made()[1].port)
    expect(made()[1].close).not.toHaveBeenCalled()
  })

  it('disconnect stops a listener that comes up after it: none is left behind', async () => {
    const { conn } = setup()
    const release = hold()
    const opening = conn.ensurePortForward(9001)
    await vi.waitFor(() => { expect(made()).toHaveLength(1) }, { timeout: 2_000, interval: 5 })
    conn.disconnect()
    release()
    await expect(opening).rejects.toThrow(/closed while it was opening/)
    expect(made()[0].close).toHaveBeenCalled()
    expect(forwards(conn).size).toBe(0)
  })

  it('a reuse whose forward is closed while it is checked never puts it back', async () => {
    const { conn } = setup()
    loopback.fake = true
    const first = await conn.ensurePortForward(9002, 'localhost', { evictable: true })
    // The reuse awaits the forward's check; the close lands in between.
    const reusing = conn.ensurePortForward(9002, 'localhost', { evictable: true })
    conn.closePortForward(9002, 'localhost')
    await expect(reusing).rejects.toThrow(/closed while it was opening/)
    expect(made()[0].port).toBe(first)
    expect(made().every((f) => f.close.mock.calls.length > 0)).toBe(true)
    expect(forwards(conn).size).toBe(0)
  })
})
