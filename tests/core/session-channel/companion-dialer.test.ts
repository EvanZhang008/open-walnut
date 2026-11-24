/**
 * The host's link to its companion's listener door (src/core/session-channel/companion-dialer.ts):
 * it reads the bridge link the runtime keeps for this Walnut (only an enabled one, of this home, to
 * a URL a bearer may go to), dials with that token in the header, attaches the session channel only
 * after a welcome naming the listener role and this Walnut, hands the channel the companion's
 * `listen` and nothing else (a resume, an ack or a resync from this link is dropped), answers only
 * the fixed list of calls, and never dials again with a token the companion answered 401 to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { readCompanionLink, startCompanionDialer, type CompanionDialer, type CompanionLink } from '../../../src/core/session-channel/companion-dialer.js'
import { listenerCallRefusal, listenerUrlOf } from '../../../src/core/session-channel/listener-wire.js'
import type { HostChannel } from '../../../src/core/session-channel/channel.js'
import type { HostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'

const WALNUT = 'ab'.repeat(16)
const TOKEN = 'f0'.repeat(16)
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) }
}

let dir = ''
let server: http.Server | null = null
let wss: WebSocketServer | null = null
let dialer: CompanionDialer | null = null
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-dialer-')) })
afterEach(async () => {
  dialer?.stop(); dialer = null
  for (const c of wss?.clients ?? []) c.terminate()
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()))
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  wss = null; server = null
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeBridge(key: string, cfg: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(dir, 'walnuts', key), { recursive: true })
  await fs.writeFile(path.join(dir, 'walnuts', key, 'bridge.json'), JSON.stringify(cfg))
}

describe('the companion link the runtime keeps', () => {
  it('is the enabled bridge config of this home, its listener door derived from its URL', async () => {
    await writeBridge('k1', { enabled: true, url: 'wss://box.example/bridge', token: TOKEN, hostAlias: 'devbox', home: '/other/home', scoped: 1 })
    await writeBridge('k2', { enabled: false, url: 'wss://box.example/bridge', token: TOKEN, hostAlias: 'devbox', home: '/mac/data', scoped: 1 })
    expect(await readCompanionLink(dir, '/mac/data')).toBeNull()
    await writeBridge('k3', { enabled: true, url: 'wss://box.example/bridge', token: TOKEN, hostAlias: 'devbox', home: '/mac/data', scoped: 1 })
    expect(await readCompanionLink(dir, '/mac/data')).toEqual({ url: 'wss://box.example/host-listen', token: TOKEN, hostAlias: 'devbox' })
  })

  it('sends the bearer only over wss, or plain ws to a loopback address', () => {
    expect(listenerUrlOf('wss://box.example:8443/bridge')).toBe('wss://box.example:8443/host-listen')
    expect(listenerUrlOf('ws://127.0.0.1:3000/bridge')).toBe('ws://127.0.0.1:3000/host-listen')
    for (const bad of ['ws://box.example/bridge', 'ws://10.0.0.5/bridge', 'https://box.example/bridge', 'wss://u:p@box.example/bridge', '', 7]) expect(listenerUrlOf(bad), String(bad)).toBeNull()
  })

  it('a companion\'s call reaches a send, an interrupt, a prompt\'s answer, a stop and a mode change only', () => {
    expect(listenerCallRefusal('POST', '/host-api/sessions/send', {})).toBeNull()
    expect(listenerCallRefusal('POST', '/host-api/sessions/interrupt', {})).toBeNull()
    for (const member of ['resolvePermissionRequest', 'terminateSession', 'changeSessionModeOf']) {
      expect(listenerCallRefusal('POST', '/host-api/sessions/call', { member }), member).toBeNull()
    }
    for (const [m, p, b] of [
      ['POST', '/host-api/sessions/start', {}], ['POST', '/host-api/sessions/drop', {}], ['POST', '/host-api/credential', {}],
      ['POST', '/host-api/doors', {}], ['POST', '/host-api/sessions/call', { member: 'kill' }], ['POST', '/host-api/sessions/call', { member: 'killSession' }], ['POST', '/host-api/sessions/call', { member: 'changeSessionMode' }],
      ['GET', '/host-api/sessions/send', {}], ['POST', '/host-api/sessions/send/../credential', {}],
    ] as const) expect(listenerCallRefusal(m, p, b), `${m} ${p}`).toBe('not_callable')
  })
})

/** A fake companion: what it does on each frame from the host. */
async function companion(onFrame: (ws: WebSocket, f: any) => void, status?: number): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = []
  server = http.createServer()
  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    auths.push(String(req.headers.authorization ?? ''))
    if (status) { socket.end(`HTTP/1.1 ${status} No\r\nConnection: close\r\n\r\n`); return }
    wss!.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => onFrame(ws, JSON.parse(String(m)))))
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/host-listen`, auths }
}

function fakeChannel(): { channel: HostChannel; frames: any[]; attaches: number } {
  const o = { frames: [] as any[], attaches: 0, channel: null as unknown as HostChannel }
  o.channel = { attach: (link: { send(f: unknown): void }) => {
    o.attaches++
    link.send({ ch: 'sf', op: 'hello', walnutId: WALNUT, hostId: 'devbox', logId: 'L', floor: 1, head: 0 })
    return { onFrame: (f: unknown) => o.frames.push(f), onClose: () => {} }
  } } as unknown as HostChannel
  return o
}

function fakeRoutes(): { routes: HostSessionRoutes; calls: any[] } {
  const calls: any[] = []
  return { calls, routes: { call: async (method: string, p: string, body: unknown) => { calls.push({ method, p, body }); return { status: 200, body: { ok: true } } } } as unknown as HostSessionRoutes }
}

function dial(link: CompanionLink | null, ch: HostChannel, routes: HostSessionRoutes | null = null): CompanionDialer {
  return startCompanionDialer({ walnutId: WALNUT, enabled: async () => true, channel: () => ch, routes: () => routes, readLink: async () => link, backoffMs: () => 30, idleRecheckMs: 60 })
}

describe('the host\'s dial of its companion', () => {
  it('attaches the channel after a good welcome and hands it the listen only: a resume, an ack or a resync is dropped', async () => {
    const c = await companion((ws, f) => {
      if (f.op === 'hello' && f.ch === 'door') {
        expect(f).toEqual({ ch: 'door', op: 'hello', v: 1, role: 'listener', walnutId: WALNUT, hostAlias: 'devbox' })
        ws.send(JSON.stringify({ ch: 'door', op: 'welcome', role: 'listener', walnutId: WALNUT }))
      }
      if (f.ch === 'sf' && f.op === 'hello') {
        for (const x of [
          { ch: 'sf', op: 'resume', walnutId: WALNUT, hostId: 'devbox', permitNumber: 99, epoch: 99, logId: 'L', after: 0 },
          { ch: 'sf', op: 'ack', logId: 'L', upTo: 5 },
          { ch: 'sf', op: 'resync', sids: ['s1'] },
          { ch: 'sf', op: 'listen', walnutId: WALNUT },
        ]) ws.send(JSON.stringify(x))
      }
    })
    const ch = fakeChannel()
    dialer = dial({ url: c.url, token: TOKEN, hostAlias: 'devbox' }, ch.channel)
    await until(() => ch.frames.length > 0 && dialer!.linked())
    await new Promise((r) => setTimeout(r, 100))
    expect(ch.frames).toEqual([{ ch: 'sf', op: 'listen', walnutId: WALNUT }])
    expect(c.auths[0]).toBe(`Bearer ${TOKEN}`)
  })

  it('attaches nothing on a welcome that names another Walnut or no listener role', async () => {
    let n = 0
    const c = await companion((ws, f) => {
      if (f.op !== 'hello') return
      n++
      ws.send(JSON.stringify(n === 1 ? { ch: 'door', op: 'welcome', role: 'listener', walnutId: 'cd'.repeat(16) } : { ch: 'door', op: 'welcome', walnutId: WALNUT, holder: 'x', permitNumber: 0, epoch: 1, proof: '00' }))
    })
    const ch = fakeChannel()
    dialer = dial({ url: c.url, token: TOKEN, hostAlias: 'devbox' }, ch.channel)
    await until(() => n >= 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(ch.attaches).toBe(0)
    expect(dialer.linked()).toBe(false)
  })

  it('answers the fixed list of calls through the host\'s routes and refuses every other', async () => {
    const replies = new Map<string, any>()
    const c = await companion((ws, f) => {
      if (f.ch === 'door' && f.op === 'hello') {
        ws.send(JSON.stringify({ ch: 'door', op: 'welcome', role: 'listener', walnutId: WALNUT }))
        const calls: Array<[string, unknown]> = [
          ['/host-api/sessions/send', { sessionId: 's1', message: 'hi' }], ['/host-api/sessions/start', { taskId: 't', message: 'x' }],
          ['/host-api/sessions/drop', { sids: ['s1'] }], ['/host-api/credential', { check: true }], ['/host-api/doors', {}],
          ['/host-api/sessions/call', { sid: 's1', target: 'session', member: 'kill' }],
          ['/host-api/sessions/call', { sid: 's1', target: 'session', member: 'resolvePermissionRequest', args: ['r1', true] }],
        ]
        calls.forEach(([p, body], i) => ws.send(JSON.stringify({ ch: 'door', op: 'call', id: String(i), method: 'POST', path: p, body })))
      }
      if (f.op === 'reply') replies.set(f.id, f)
    })
    const ch = fakeChannel()
    const r = fakeRoutes()
    dialer = dial({ url: c.url, token: TOKEN, hostAlias: 'devbox' }, ch.channel, r.routes)
    await until(() => replies.size === 7)
    expect([...replies.values()].sort((a, b) => Number(a.id) - Number(b.id)).map((x) => x.status)).toEqual([200, 403, 403, 403, 403, 403, 200])
    expect(r.calls.map((x) => x.p)).toEqual(['/host-api/sessions/send', '/host-api/sessions/call'])
  })

  it('never dials again with a token the companion answered 401 to', async () => {
    const c = await companion(() => {}, 401)
    const ch = fakeChannel()
    dialer = dial({ url: c.url, token: TOKEN, hostAlias: 'devbox' }, ch.channel)
    await until(() => c.auths.length >= 1)
    await new Promise((r) => setTimeout(r, 400))
    expect(c.auths).toHaveLength(1)
  })
})
