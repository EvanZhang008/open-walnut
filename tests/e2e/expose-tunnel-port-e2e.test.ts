/**
 * The tunnel port and a tunnel in front of it, end to end (docs/plan/walnut-servers-everywhere.md).
 *
 * Real server, real child process: the built-in `command` provider runs a fake
 * tunnel that is a bare TCP pipe from its own loopback port to the tunnel port,
 * adding no header at all (the shape of `ssh -R` or socat), and prints its
 * address the way a tunnel CLI does. Through it a request carries a loopback
 * Host and no Origin, which the main port trusts; the tunnel port must not.
 *
 *   - turning it on opens the tunnel port, runs the provider, reads its address;
 *   - through the tunnel: no token is 401 not_paired, HTTP and WebSocket alike;
 *   - the main port keeps trusting this machine;
 *   - a browser code minted at this machine trades once for a token that works
 *     through the tunnel; a wrong code is refused; a session cannot mint one;
 *   - turning it off ends the child and closes the port;
 *   - a provider nobody provides is `unavailable`, with the reason.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port: number
let fakeTunnel: string
let pidFile: string

const FAKE_TUNNEL = `
const net = require('node:net')
const fs = require('node:fs')
const target = Number(process.argv[2])
const proxy = net.createServer((client) => {
  const upstream = net.connect(target, '127.0.0.1')
  client.pipe(upstream).pipe(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
})
proxy.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[3], String(process.pid))
  // The shape of a CLI that prints its address before the connection is up.
  console.log('connecting to edge...')
  console.log('Public: http://127.0.0.1:' + proxy.address().port + '.')
  setTimeout(() => console.log('Connected! Forwarding requests'), 300)
})
process.on('SIGTERM', () => process.exit(0))
`

async function api(pathname: string, init?: RequestInit) {
  return fetch(`http://localhost:${port}${pathname}`, init)
}

async function exposeStatus(): Promise<Record<string, any>> {
  return (await (await api('/api/expose')).json()).status
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function wsOpens(url: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => resolve(-1))
  })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  fakeTunnel = path.join(WALNUT_HOME, 'fake-tunnel.cjs')
  pidFile = path.join(WALNUT_HOME, 'fake-tunnel.pid')
  await fs.writeFile(fakeTunnel, FAKE_TUNNEL)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
  await updateConfig({
    expose: { command: { command: process.execPath, args: [fakeTunnel, '{port}', pidFile], url_pattern: 'http://127\\.0\\.0\\.1:\\d+', ready_pattern: 'connected!' } },
  })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the tunnel port, through a bare pipe of a tunnel', () => {
  let tunnelUrl = ''
  let token = ''

  it('is off until asked; the command provider is listed once config names a command', async () => {
    const body = await (await api('/api/expose')).json()
    expect(body.status).toMatchObject({ enabled: false, state: 'off' })
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['command'])
  })

  it('turning it on runs the provider and reads its address', async () => {
    const res = await api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, provider: 'command' }) })
    expect(res.status).toBe(200)
    const status = await waitFor(async () => { const s = await exposeStatus(); return s.state === 'connected' ? s : null })
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(status.port).toBeGreaterThan(0)
    expect(status.port).not.toBe(port)
    tunnelUrl = status.url
  })

  it('through the tunnel, no token is refused, though Host is loopback and no proxy header came', async () => {
    const res = await fetch(`${tunnelUrl}/api/tasks`)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('not_paired')
    expect(await wsOpens(`${tunnelUrl.replace('http', 'ws')}/ws`)).not.toBe('open')
  })

  it('the main port still trusts this machine', async () => {
    expect((await api('/api/tasks')).status).toBe(200)
    expect(await wsOpens(`ws://localhost:${port}/ws`)).toBe('open')
  })

  it('a session cannot mint a browser code; the person at this machine can', async () => {
    const asSession = await api('/api/devices/browser-code', { method: 'POST', headers: { 'x-walnut-caller-sid': 'sess-1' } })
    expect(asSession.status).toBe(403)
    const throughTunnel = await fetch(`${tunnelUrl}/api/devices/browser-code`, { method: 'POST' })
    expect(throughTunnel.status).toBe(401)
    const res = await api('/api/devices/browser-code', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(body.link).toBe(`${tunnelUrl}/#pair=${body.code}`)

    const pair = (code: string) => fetch(`${tunnelUrl}/api/v1/browser-pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    })
    const wrong = await pair('ZZZZ-ZZZZ')
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error.code).toBe('invalid_code')
    const right = await pair(body.code.toLowerCase())
    expect(right.status).toBe(200)
    const paired = await right.json()
    expect(paired.name).toMatch(/^browser-[0-9a-f]{6}$/)
    token = paired.token
    expect((await pair(body.code)).status).toBe(400)
  })

  it('the token works through the tunnel, HTTP and WebSocket', async () => {
    const res = await fetch(`${tunnelUrl}/api/tasks`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(await wsOpens(`${tunnelUrl.replace('http', 'ws')}/ws?token=${token}`)).toBe('open')
  })

  it('a browser still holding a removed token can sign in with a fresh code, and its new token works at once', async () => {
    // Through a tunnel every caller is loopback, so this is one address's count.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${tunnelUrl}/api/tasks`, { headers: { authorization: 'Bearer removed-token' } })
      expect(res.status).toBe(401)
    }
    expect((await fetch(`${tunnelUrl}/api/tasks`, { headers: { authorization: 'Bearer removed-token' } })).status).toBe(429)
    const { code } = await (await api('/api/devices/browser-code', { method: 'POST' })).json()
    const right = await fetch(`${tunnelUrl}/api/v1/browser-pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.replace('-', '') }),
    })
    expect(right.status).toBe(200)
    const fresh = (await right.json()).token
    expect((await fetch(`${tunnelUrl}/api/tasks`, { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(200)
  })

  it('turning it off ends the child and closes the port', async () => {
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    const tunnelPort = (await exposeStatus()).port as number
    expect(alive(pid)).toBe(true)
    const res = await api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect((await res.json()).status).toMatchObject({ enabled: false, state: 'off' })
    await waitFor(async () => !alive(pid))
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect(tunnelPort, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve(false) })
      s.on('error', () => resolve(true))
    })
    expect(refused).toBe(true)
  })

  it('a command that is not installed is missing, with the reason and the next try', async () => {
    await updateConfig({ expose: { command: { command: path.join(WALNUT_HOME, 'no-such-tunnel'), args: ['{port}'] } } })
    const res = await api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, provider: 'command' }) })
    expect(res.status).toBe(200)
    const status = await waitFor(async () => { const s = await exposeStatus(); return s.state === 'missing' ? s : null })
    expect(status.lastError).toMatch(/not installed here/)
    expect(status.nextRetryAt).toBeGreaterThan(Date.now())
    await api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    await updateConfig({
      expose: { command: { command: process.execPath, args: [fakeTunnel, '{port}', pidFile], url_pattern: 'http://127\\.0\\.0\\.1:\\d+', ready_pattern: 'connected!' } },
    })
  })

  it('a provider nobody provides is unavailable, with the reason', async () => {
    const res = await api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, provider: 'not-installed' }) })
    const status = (await res.json()).status
    expect(status).toMatchObject({ enabled: true, provider: 'not-installed', state: 'unavailable' })
    expect(status.lastError).toMatch(/No tunnel provider named "not-installed"/)
    await api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
  })

  it('a session cannot change it', async () => {
    const res = await api('/api/expose', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': 'sess-1' }, body: JSON.stringify({ enabled: true, provider: 'command' }),
    })
    expect(res.status).toBe(403)
    // Nor through the general config write, a session or a signed-in browser alike.
    const viaConfig = await api('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': 'sess-1' }, body: JSON.stringify({ expose: { enabled: true, command: { command: '/bin/sh' } } }),
    })
    expect(viaConfig.status).toBe(403)
    expect((await exposeStatus()).enabled).toBe(false)
    // A write that carries the section back unchanged is not a change.
    const current = (await (await api('/api/expose')).json()).settings
    expect(current.enabled).toBe(false)
    const read = await (await api('/api/config')).json() as { config?: Record<string, unknown> } & Record<string, unknown>
    const config = read.config ?? read
    const roundTrip = await api('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': 'sess-1' }, body: JSON.stringify({ expose: config.expose ?? {} }),
    })
    expect(roundTrip.status).toBe(200)
  })
})
