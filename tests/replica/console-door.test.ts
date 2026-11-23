/**
 * The console door of a host replica (src/replica/console-door.ts): it opens at the address of a
 * handed-over machine's leader only while that console stands, gives a request the console
 * device's token only where that machine's leader would have trusted it without one (the same
 * loopback rule, local-trust.ts), waits for a taken port, and gives the port back when the
 * console ends. Real listeners on ephemeral ports; files in a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readHolder, writeConsoleFile, type HandedOverConsole } from '../../src/core/handed-over-console.js'
import { answerConsoleLoginSession, startConsoleDoor, type ConsoleDoor } from '../../src/replica/console-door.js'

const WALNUT = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf'
const TOKEN = 'c'.repeat(32)

let root: string
let dir: string
let home: string
let main: http.Server
let mainPort: number
let door: ConsoleDoor | null = null
let blockers: net.Server[] = []
/** The tokens this replica's device copy knows (the leader sent it the console device). */
let known = new Set<string>()

/** The leader machine's login session as its GET /api/config reports it: broken (an ended session). */
const LEADER_SESSION = { ok: false, problems: ['user_lookup', 'dns_config'], checkedAt: '2026-01-01T00:00:00.000Z' }

const app: http.RequestListener = (req, res) => {
  if (req.url?.startsWith('/api/config')) {
    // As the forward to the leader answers: its head, then the body in pieces.
    const body = JSON.stringify({ config: { user: { name: 'T' } }, loginSession: LEADER_SESSION, acceptEncoding: req.headers['accept-encoding'] ?? null })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked', etag: 'W/"leader"' })
    res.write(body.slice(0, 10))
    res.end(body.slice(10))
    return
  }
  if (req.url === '/api/broken') { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('leader gone'); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ auth: req.headers.authorization ?? null, localPort: req.socket.localPort }))
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function get(port: number, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/tasks', method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end()
  })
}

function upgrade(port: number, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    req.on('response', (res) => resolve(String(res.headers['x-auth'] ?? '')))
    req.on('upgrade', (res) => resolve(String(res.headers['x-auth'] ?? '')))
    req.on('error', reject)
    req.end()
  })
}

function marker(state: 'switching' | 'handed-over', switchId = 'sw-1'): void {
  const f = path.join(home, 'local', 'leader-switch', 'handed-over.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ switchId, to: 'machine-b', state, at: new Date().toISOString() }))
}

function consoleAt(port: number, over: Partial<HandedOverConsole> = {}): void {
  writeConsoleFile({
    v: 1, walnutId: WALNUT, home, port, host: '127.0.0.1', switchId: 'sw-1', to: 'machine-b',
    device: 'console-machine-a', token: TOKEN, at: new Date().toISOString(), ...over,
  }, dir)
}

function open(): ConsoleDoor {
  door = startConsoleDoor({ walnutId: WALNUT, publicPort: mainPort, app, mainServer: main, log: () => {}, knowsToken: (t) => known.has(t), dir, tickMs: 60_000 })
  return door
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-door-'))
  known = new Set([TOKEN])
  dir = path.join(root, 'console')
  home = path.join(root, 'home')
  fs.mkdirSync(home)
  main = http.createServer(app)
  main.on('upgrade', (req, socket) => {
    socket.end(`HTTP/1.1 418 Teapot\r\nx-auth: ${req.headers.authorization ?? ''}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  })
  await new Promise<void>((r) => main.listen(0, '127.0.0.1', () => r()))
  mainPort = (main.address() as net.AddressInfo).port
})

afterEach(async () => {
  await door?.stop()
  door = null
  for (const b of blockers) await new Promise<void>((r) => b.close(() => r()))
  blockers = []
  main.closeAllConnections?.()
  await new Promise<void>((r) => main.close(() => r()))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the console door', () => {
  it('opens once the console stands, and stamps only what the leader trusted without a credential', async () => {
    const port = await freePort()
    consoleAt(port)
    marker('switching')
    const d = open()
    await d.look()
    expect(d.status().state).toBe('none')
    marker('handed-over')
    await d.look()
    expect(d.status()).toMatchObject({ state: 'serving', port, switchId: 'sw-1', to: 'machine-b' })
    expect(readHolder(WALNUT, dir)).toMatchObject({ pid: process.pid, state: 'serving', port })

    const own = `localhost:${port}`
    // A program on this machine (no Origin), and the console's own page.
    expect((await get(port)).json.auth).toBe(`Bearer ${TOKEN}`)
    expect((await get(port, { host: own, origin: `http://${own}` })).json.auth).toBe(`Bearer ${TOKEN}`)
    // What the leader never trusted without a credential: none is added.
    expect((await get(port, { 'x-forwarded-for': '203.0.113.9' })).json.auth).toBeNull()
    expect((await get(port, { host: 'rebound.example:80' })).json.auth).toBeNull()
    expect((await get(port, { host: own, origin: 'http://evil.example' })).json.auth).toBeNull()
    expect((await get(port, { host: own, origin: `http://localhost:${port + 1}` })).json.auth).toBeNull()
    // A request that brings its own credential keeps it.
    expect((await get(port, { authorization: 'Bearer mine' })).json.auth).toBe('Bearer mine')
    // The WebSocket upgrade goes to the main server's handler, stamped the same way.
    expect(await upgrade(port, { host: own, origin: `http://${own}` })).toBe(`Bearer ${TOKEN}`)
    expect(await upgrade(port, { host: own, origin: 'http://evil.example' })).toBe('')
    // The replica's own (tunnel) port is never stamped.
    expect((await get(mainPort)).json.auth).toBeNull()
  })

  it("answers GET /api/config with a login session the Mac app never acts on, never the leader's (the app stops a listener that reports an ended one)", async () => {
    const port = await freePort()
    consoleAt(port)
    marker('handed-over')
    const d = open()
    await d.look()
    const fetchRaw = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })
    const r = await fetchRaw('/api/config', { 'accept-encoding': 'gzip, br', 'if-none-match': 'W/"leader"' })
    expect(r.status).toBe(200)
    const j = JSON.parse(r.body)
    expect(j.loginSession).toEqual({ ok: true, problems: [], checkedAt: null })
    expect(j.config).toEqual({ user: { name: 'T' } })
    // Asked of the leader uncompressed, so the body is JSON this door can read.
    expect(j.acceptEncoding).toBeNull()
    expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(r.body))
    expect(r.headers.etag).toBeUndefined()
    // A query string is the same route; another route and an error go on as they came.
    expect(JSON.parse((await fetchRaw('/api/config?x=1')).body).loginSession.problems).toEqual([])
    expect(await fetchRaw('/api/broken')).toMatchObject({ status: 502, body: 'leader gone' })
    expect((await get(port)).json.auth).toBe(`Bearer ${TOKEN}`)
    // The tunnel port is not this machine's console: the leader's answer as it is.
    const tunnel = await new Promise<string>((resolve) => http.get({ host: '127.0.0.1', port: mainPort, path: '/api/config' }, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve(b)) }))
    expect(JSON.parse(tunnel).loginSession).toEqual(LEADER_SESSION)
  })

  it('opens only once the device copy knows the console token, and closes when it stops knowing it', async () => {
    const port = await freePort()
    consoleAt(port)
    marker('handed-over')
    known.clear()
    const d = open()
    await d.look()
    // Not yet: no holder file (so the standby keeps the port), nothing listens.
    expect(d.status()).toMatchObject({ state: 'none', why: expect.stringMatching(/device copy/) })
    expect(readHolder(WALNUT, dir)).toBeNull()
    await expect(get(port)).rejects.toThrow()
    known.add(TOKEN)
    await d.look()
    expect(d.status().state).toBe('serving')
    expect((await get(port)).json.auth).toBe(`Bearer ${TOKEN}`)
    // The device was removed on the leader: its copy no longer knows the token.
    known.clear()
    await d.look()
    expect(d.status()).toMatchObject({ state: 'none', why: expect.stringMatching(/device copy/) })
    expect(readHolder(WALNUT, dir)).toBeNull()
  })

  it('ends the WebSockets taken through the door when it closes', async () => {
    const port = await freePort()
    consoleAt(port)
    marker('handed-over')
    main.removeAllListeners('upgrade')
    main.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n') })
    const d = open()
    await d.look()
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket' } })
      req.on('upgrade', (_res, s) => resolve(s))
      req.on('error', reject)
      req.end()
    })
    const closed = new Promise<void>((resolve) => sock.on('close', () => resolve()))
    await d.stop()
    door = null
    await expect(Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 3_000))])).resolves.toBe('closed')
  })

  it('sends one answer when the forward answers again after a failed first try (a second head starts it over)', async () => {
    const s = http.createServer((req, res) => {
      answerConsoleLoginSession(req, res)
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.write('half of a first answer')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ config: { ok: 1 }, loginSession: LEADER_SESSION }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    blockers.push(s as unknown as net.Server)
    const p = (s.address() as net.AddressInfo).port
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: p, path: '/api/config' }, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })) }).on('error', reject)
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ config: { ok: 1 }, loginSession: { ok: true, problems: [], checkedAt: null } })
  })

  it('looks one at a time: looks at once open one listener, and a stop during a look leaves no holder and no listener', async () => {
    const port = await freePort()
    consoleAt(port)
    marker('handed-over')
    const logs: string[] = []
    door = startConsoleDoor({ walnutId: WALNUT, publicPort: mainPort, app, mainServer: main, log: (_l, m) => { logs.push(m) }, knowsToken: (t) => known.has(t), dir, tickMs: 60_000 })
    await Promise.all([door.look(), door.look(), door.look()])
    expect(door.status().state).toBe('serving')
    expect(logs.filter((m) => /open$/.test(m))).toHaveLength(1)
    expect(logs.filter((m) => /taken/.test(m))).toEqual([])
    await door.stop()
    door = null
    // Stopped while its first look still reads the console file.
    const d2 = startConsoleDoor({ walnutId: WALNUT, publicPort: mainPort, app, mainServer: main, log: () => {}, knowsToken: (t) => known.has(t), dir, tickMs: 60_000 })
    await d2.stop()
    expect(d2.status().state).toBe('none')
    expect(readHolder(WALNUT, dir)).toBeNull()
    const s = net.createServer()
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve()) })
    blockers.push(s)
  })

  it('gives the port back when the console ends', async () => {
    const port = await freePort()
    consoleAt(port)
    marker('handed-over')
    const d = open()
    await d.look()
    expect(d.status().state).toBe('serving')
    // A switch back moves the handed-over home aside.
    fs.renameSync(home, `${home}.before-sw-2`)
    fs.mkdirSync(home)
    await d.look()
    expect(d.status().state).toBe('none')
    expect(d.status().why).toMatch(/no handed-over marker/)
    expect(readHolder(WALNUT, dir)).toBeNull()
    const s = net.createServer()
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve()) })
    blockers.push(s)
  })

  it('waits for a taken port, saying so in its holder file, and opens once it is free', async () => {
    const port = await freePort()
    const taker = net.createServer()
    await new Promise<void>((r) => taker.listen(port, '127.0.0.1', () => r()))
    consoleAt(port)
    marker('handed-over')
    const d = open()
    await d.look()
    expect(d.status().state).toBe('waiting')
    expect(readHolder(WALNUT, dir)).toMatchObject({ state: 'waiting', port })
    await new Promise<void>((r) => taker.close(() => r()))
    await d.look()
    expect(d.status().state).toBe('serving')
    expect((await get(port)).json.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('refuses a console that names its own tunnel port, or another Walnut\'s', async () => {
    consoleAt(mainPort)
    marker('handed-over')
    const d = open()
    await d.look()
    expect(d.status()).toMatchObject({ state: 'none', why: expect.stringMatching(/own port/) })
    await d.stop()
    door = startConsoleDoor({ walnutId: 'other0123', publicPort: mainPort, app, mainServer: main, log: () => {}, knowsToken: (t) => known.has(t), dir, tickMs: 60_000 })
    await door.look()
    expect(door.status()).toMatchObject({ state: 'none', why: expect.stringMatching(/no console file/) })
  })

  it('stops stamping the moment it closes: a request in flight after that gets no token', async () => {
    const port = await freePort()
    consoleAt(port)
    marker('handed-over')
    const d = open()
    await d.look()
    await d.stop()
    door = null
    await expect(get(port)).rejects.toThrow()
    expect(readHolder(WALNUT, dir)).toBeNull()
  })
})
