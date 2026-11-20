/**
 * The primary's side of hub forwards (src/core/hosts/hub-ports.ts): `net.hub_ports` is the only
 * way in (nothing listed: every hub stream refused), a stream is taken only for a listed port
 * from a listed host, the address is always this machine's 127.0.0.1 whatever the stream names,
 * at most 32 at once per host, and the status a plugin reads never asks a daemon older than
 * 'hub-forward-v1'. Streams arrive through a real link-stream endpoint; the services are loopback
 * servers this test owns.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hub-ports'))

import { acceptHubStream, hubPortRules, hubPortStatus, hubStreamRefusal, resetHubPortsForTest, type HubDoorDeps, type HubStatusLink } from '../../../src/core/hosts/hub-ports.js'
import { createStreamEndpoint } from '../../../src/lib/link-stream.js'

const servers: net.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  resetHubPortsForTest()
})

async function service(onConn: (c: net.Socket) => void): Promise<number> {
  const s = net.createServer({ allowHalfOpen: true }, (c) => { c.on('error', () => {}); onConn(c) })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as net.AddressInfo).port
}

function deps(hubPorts: unknown, over: Partial<HubDoorDeps> = {}) {
  const connects: Array<{ port: number; host: string }> = []
  const logs: Array<{ level: string; msg: string; data: Record<string, unknown> }> = []
  const d: HubDoorDeps = {
    config: async () => ({ net: { hub_ports: hubPorts } }),
    takes: () => true,
    connect: (port, host) => { connects.push({ port, host }); return net.connect({ port, host, allowHalfOpen: true }) },
    log: (level, msg, data) => { logs.push({ level, msg, data }) },
    now: () => 1_700_000_000_000,
    walnutPorts: async () => [],
    ...over,
  }
  return { d, connects, logs }
}

/** A server's endpoint for `host`'s link whose hub acceptor is the one under test; `frames` is what it sends the daemon. */
function link(host: string, d: HubDoorDeps) {
  const frames: Array<Record<string, unknown>> = []
  const ep = createStreamEndpoint({ send: (f) => { frames.push(f) }, accept: (info) => (info.from === 'hub' ? acceptHubStream(host, info, d) : null) })
  return { ep, frames }
}

async function answered(frames: Array<Record<string, unknown>>, sid: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const f = frames.find((x) => x.sid === sid && (x.cmd === 'stream.accept' || x.cmd === 'stream.close'))
    if (f) return f
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no answer for ${sid}`)
}

describe('net.hub_ports', () => {
  it('nothing written is no rule; bad entries are left out with why', () => {
    expect(hubPortRules({})).toEqual({ rules: [], problems: [] })
    expect(hubPortRules({ net: {} })).toEqual({ rules: [], problems: [] })
    expect(hubPortRules({ net: { hub_ports: 'all' } }).problems).toEqual(['net.hub_ports must be a list'])
    const r = hubPortRules({ net: { hub_ports: [{ port: 18403, hosts: ['home-pc', ' lab '] }, { port: 0, hosts: ['x'] }, { port: 9, hosts: [] }, { port: 9 }] } })
    expect(r.rules).toEqual([{ port: 18403, hosts: ['home-pc', 'lab'] }])
    expect(r.problems).toHaveLength(3)
  })

  it('takes a listed port from a listed host, and refuses an unlisted port, an unlisted host, or any address but 127.0.0.1', () => {
    const rules = [{ port: 18403, hosts: ['home-pc'] }, { port: 9000, hosts: ['lab'] }]
    expect(hubStreamRefusal(rules, 'home-pc', { port: 18403 })).toBeNull()
    expect(hubStreamRefusal(rules, 'home-pc', { port: 18403, host: '127.0.0.1' })).toBeNull()
    expect(hubStreamRefusal(rules, 'home-pc', { port: 18404 })).toBe('port 18404 on this Walnut is not open to hub forwards (net.hub_ports)')
    expect(hubStreamRefusal(rules, 'home-pc', { port: 9000 })).toBe('port 9000 on this Walnut is not open to home-pc (net.hub_ports)')
    expect(hubStreamRefusal(rules, 'stranger', { port: 18403 })).toBe('port 18403 on this Walnut is not open to stranger (net.hub_ports)')
    for (const host of ['10.1.2.3', '0.0.0.0', '169.254.169.254', 'localhost', '::1', 'example.test', 'home-pc']) {
      expect(hubStreamRefusal(rules, 'home-pc', { port: 18403, host })).toMatch(/reaches only this Walnut's own 127\.0\.0\.1, never/)
    }
    expect(hubStreamRefusal(rules, 'home-pc', {})).toMatch(/names a TCP port/)
    expect(hubStreamRefusal([], 'home-pc', { port: 18403 })).toMatch(/not open to hub forwards/)
  })
})

describe('acceptHubStream through a server endpoint', () => {
  it('connects only 127.0.0.1 of a listed port and carries bytes both ways; the record says when', async () => {
    const svc = await service((c) => c.pipe(c))
    const { d, connects, logs } = deps([{ port: svc, hosts: ['home-pc'] }])
    const { ep, frames } = link('home-pc', d)
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    expect((await answered(frames, 'r1')).cmd).toBe('stream.accept')
    expect(connects).toEqual([{ port: svc, host: '127.0.0.1' }])
    ep.handle({ ev: 'stream-data', sid: 'r1', d: Buffer.from('ping').toString('base64') })
    for (let i = 0; i < 100 && !frames.some((f) => f.cmd === 'stream.data'); i++) await new Promise((r) => setTimeout(r, 10))
    const back = frames.find((f) => f.cmd === 'stream.data')
    expect(Buffer.from(String(back?.d), 'base64').toString()).toBe('ping')
    expect(logs.find((l) => l.msg === 'hub port: opened')?.data).toMatchObject({ host: 'home-pc', port: svc })
    const status = await hubPortStatus('home-pc', { config: { net: { hub_ports: [{ port: svc, hosts: ['home-pc'] }] } }, link: null })
    expect(status[0]).toMatchObject({ port: svc, opened: 1, active: 1, lastConnectedAt: 1_700_000_000_000, linked: false, up: false })
    ep.handle({ ev: 'stream-close', sid: 'r1' })
    for (let i = 0; i < 100 && (await hubPortStatus('home-pc', { config: { net: { hub_ports: [{ port: svc, hosts: ['home-pc'] }] } }, link: null }))[0].active; i++) await new Promise((r) => setTimeout(r, 10))
    expect((await hubPortStatus('home-pc', { config: { net: { hub_ports: [{ port: svc, hosts: ['home-pc'] }] } }, link: null }))[0].active).toBe(0)
  })

  it('with nothing listed (the default) every hub stream is refused and nothing is dialled', async () => {
    const svc = await service(() => {})
    const { d, connects, logs } = deps(undefined)
    const { ep, frames } = link('home-pc', d)
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    const a = await answered(frames, 'r1')
    expect(a).toMatchObject({ cmd: 'stream.close', error: `port ${svc} on this Walnut is not open to hub forwards (net.hub_ports)` })
    expect(connects).toEqual([])
    expect(logs.find((l) => l.msg === 'hub port: refused')?.data).toMatchObject({ host: 'home-pc', port: svc })
    // The same refusal again within 5 s is counted, not logged; a new reason is logged at once.
    ep.handle({ ev: 'stream-open', sid: 'r2', from: 'hub', port: svc })
    await answered(frames, 'r2')
    ep.handle({ ev: 'stream-open', sid: 'r3', from: 'hub', port: svc, host: '10.0.0.9' })
    await answered(frames, 'r3')
    expect(logs.filter((l) => l.msg === 'hub port: refused').map((l) => l.data.error)).toEqual([
      `port ${svc} on this Walnut is not open to hub forwards (net.hub_ports)`,
      "a hub stream reaches only this Walnut's own 127.0.0.1, never 10.0.0.9",
    ])
  })

  it('an unlisted host, an unlisted port, and a stream naming another address are refused, never dialled', async () => {
    const svc = await service(() => {})
    const { d, connects } = deps([{ port: svc, hosts: ['lab'] }])
    const { ep, frames } = link('home-pc', d)
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    expect((await answered(frames, 'r1')).error).toBe(`port ${svc} on this Walnut is not open to home-pc (net.hub_ports)`)
    const other = link('lab', d)
    other.ep.handle({ ev: 'stream-open', sid: 'r2', from: 'hub', port: svc + 1 })
    expect((await answered(other.frames, 'r2')).error).toMatch(/not open to hub forwards/)
    other.ep.handle({ ev: 'stream-open', sid: 'r3', from: 'hub', port: svc, host: '10.1.2.3' })
    expect((await answered(other.frames, 'r3')).error).toBe("a hub stream reaches only this Walnut's own 127.0.0.1, never 10.1.2.3")
    other.ep.handle({ ev: 'stream-open', sid: 'r4', from: 'hub', port: svc, host: 'home-pc.example.test' })
    expect((await answered(other.frames, 'r4')).cmd).toBe('stream.close')
    expect(connects).toEqual([])
  })

  it("a listed port that is Walnut's own (its server, its daemon) is refused, never dialled", async () => {
    const svc = await service(() => {})
    const { d, connects } = deps([{ port: svc, hosts: ['home-pc'] }], { walnutPorts: async () => [svc] })
    const { ep, frames } = link('home-pc', d)
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    expect((await answered(frames, 'r1')).error).toBe(`port ${svc} is Walnut's own on this machine (its server or session daemon), which a hub stream never reaches`)
    expect(connects).toEqual([])
  })

  it('a server that is not the primary (a replica) takes none', async () => {
    const svc = await service(() => {})
    const { d, connects } = deps([{ port: svc, hosts: ['home-pc'] }], { takes: () => false })
    const { ep, frames } = link('home-pc', d)
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    expect((await answered(frames, 'r1')).error).toMatch(/takes no hub streams/)
    expect(connects).toEqual([])
  })

  it('nothing listening on the listed port: refused with that reason, counted', async () => {
    const svc = await service(() => {})
    await new Promise<void>((r) => servers.pop()!.close(() => r()))
    const { d } = deps([{ port: svc, hosts: ['home-pc'] }])
    const { ep, frames } = link('home-pc', d)
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    expect((await answered(frames, 'r1')).error).toBe(`nothing is listening on port ${svc} on the primary`)
    const s = await hubPortStatus('home-pc', { config: { net: { hub_ports: [{ port: svc, hosts: ['home-pc'] }] } }, link: null })
    expect(s[0]).toMatchObject({ refused: 1, active: 0, lastError: `nothing is listening on port ${svc} on the primary` })
  })

  it('a port connected for a stream the link dropped before plugging is let go, and its count returns', async () => {
    let closed = false
    // The service (allowHalfOpen) hears the let-go as the end of its connection.
    const svc = await service((c) => { c.resume(); c.on('end', () => { closed = true }); c.on('close', () => { closed = true }) })
    const { d } = deps([{ port: svc, hosts: ['home-pc'] }], { plugWaitMs: 100 })
    const frames: Array<Record<string, unknown>> = []
    const ep = createStreamEndpoint({ send: (f) => { frames.push(f) }, accept: (info) => acceptHubStream('home-pc', info, d) })
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    ep.closeAll('the link closed')
    const config = { net: { hub_ports: [{ port: svc, hosts: ['home-pc'] }] } }
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(true)
    expect(frames).toEqual([])
    expect((await hubPortStatus('home-pc', { config, link: null }))[0].active).toBe(0)
  })

  it('at most 32 hub streams at once per host; another host still gets its own', async () => {
    const svc = await service((c) => c.resume())
    const { d } = deps([{ port: svc, hosts: ['home-pc', 'lab'] }])
    const { ep, frames } = link('home-pc', d)
    for (let i = 1; i <= 33; i++) ep.handle({ ev: 'stream-open', sid: `r${i}`, from: 'hub', port: svc })
    const answers = await Promise.all(Array.from({ length: 33 }, (_, i) => answered(frames, `r${i + 1}`)))
    expect(answers.filter((a) => a.cmd === 'stream.accept')).toHaveLength(32)
    expect(answers.filter((a) => a.cmd === 'stream.close').map((a) => a.error)).toEqual(['more than 32 hub streams from home-pc at once'])
    const lab = link('lab', d)
    lab.ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: svc })
    expect((await answered(lab.frames, 'r1')).cmd).toBe('stream.accept')
    ep.closeAll('the link closed')
    lab.ep.closeAll('the link closed')
  })
})

describe('hubPortStatus', () => {
  const config = { net: { hub_ports: [{ port: 18403, hosts: ['home-pc'] }] } }
  const fakeLink = (caps: string[], answer: unknown = { ok: true, forwards: [{ local_port: 18500, port: 18403, listening: true, error: null }] }) => {
    const sent: string[] = []
    const l: HubStatusLink = { connected: true, hasCapability: (c) => caps.includes(c), send: async (cmd) => { sent.push(cmd); return answer } }
    return { l, sent }
  }

  it('a host no rule names has no hub status', async () => {
    expect(await hubPortStatus('lab', { config, link: null })).toEqual([])
  })

  it('an older daemon (no hub-forward-v1) is never asked: it reads as needing an update', async () => {
    const { l, sent } = fakeLink(['port-stream-v1'])
    const s = await hubPortStatus('home-pc', { config, link: l })
    expect(sent).toEqual([])
    expect(s).toEqual([expect.objectContaining({ port: 18403, linked: true, needsUpdate: true, forward: null, up: false })])
  })

  it('a host whose link is down is not asked, and is not up', async () => {
    const { l, sent } = fakeLink(['hub-forward-v1'])
    const s = await hubPortStatus('home-pc', { config, link: { ...l, connected: false } })
    expect(sent).toEqual([])
    expect(s[0]).toMatchObject({ linked: false, needsUpdate: false, up: false })
  })

  it("a linked daemon's own word says whether its forward listens; it is asked at most every 15 s", async () => {
    const { l, sent } = fakeLink(['hub-forward-v1'])
    const s = await hubPortStatus('home-pc', { config, link: l, now: 100_000 })
    expect(s[0]).toMatchObject({ linked: true, needsUpdate: false, up: true, forward: { localPort: 18500, listening: true, error: null } })
    await hubPortStatus('home-pc', { config, link: l, now: 101_000 })
    expect(sent).toEqual(['hub.status'])
  })

  it('a forward that does not listen (its port in use there) is not up, and says why', async () => {
    const { l } = fakeLink(['hub-forward-v1'], { ok: true, forwards: [{ local_port: 18403, port: 18403, listening: false, error: 'listen EADDRINUSE' }] })
    const s = await hubPortStatus('home-pc', { config, link: l })
    expect(s[0]).toMatchObject({ up: false, forward: { localPort: 18403, listening: false, error: 'listen EADDRINUSE' } })
  })

  it("a forward waiting for a link of its own says why; an older daemon's word reads as no wait", async () => {
    const waiting = 'more than one Walnut leads this host: name one with "walnut" in the forward'
    const { l } = fakeLink(['hub-forward-v1'], { ok: true, forwards: [{ local_port: 18403, port: 18403, listening: false, error: null, waiting }] })
    const s = await hubPortStatus('home-pc', { config, link: l })
    expect(s[0]).toMatchObject({ up: false, forward: { localPort: 18403, listening: false, error: null, waiting } })
    resetHubPortsForTest()
    const older = fakeLink(['hub-forward-v1'])
    expect((await hubPortStatus('home-pc', { config, link: older.l }))[0].forward).toEqual({ localPort: 18500, listening: true, error: null, waiting: null })
  })
})
