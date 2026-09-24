/**
 * POST /api/sessions/:sessionId/service-preview — the route and the resolver
 * behind it, against REAL http servers.
 *
 * Only the DaemonConnection is mocked. Its `ensurePortForward` hands back the
 * port of a live local server (standing in for the tunnel end), so every probe
 * here is a real TCP connection and a real HTTP response: refused ports are
 * really closed, X-Frame-Options really arrives in a header.
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const daemonMock = vi.hoisted(() => ({ getDaemonConnection: vi.fn() }))

vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/core/ssh-config-scanner.js', () => ({ scanSshConfig: async () => new Map() }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: daemonMock.getDaemonConnection,
}))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { closeDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, importSessionRecord } from '../../../src/core/session-tracker.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { sessionsRouter } from '../../../src/web/routes/sessions.js'
import { buildSessionServicePreview, frameBlockFromHeaders } from '../../../src/core/session-service-preview.js'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
const servers: http.Server[] = []

async function serve(handler: Handler): Promise<number> {
  const srv = http.createServer(handler)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  servers.push(srv)
  return (srv.address() as AddressInfo).port
}

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const srv = http.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

let livePort = 0
let lastPath = ''
let xfoPort = 0
let cspPort = 0
let cspStarPort = 0
let notFoundPort = 0

beforeAll(async () => {
  livePort = await serve((req, res) => { lastPath = req.url ?? ''; res.end('<h1>visualizer</h1>') })
  xfoPort = await serve((_req, res) => { res.setHeader('X-Frame-Options', 'DENY'); res.end('no') })
  cspPort = await serve((_req, res) => { res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'"); res.end('no') })
  cspStarPort = await serve((_req, res) => { res.setHeader('Content-Security-Policy', 'frame-ancestors *'); res.end('ok') })
  notFoundPort = await serve((_req, res) => { res.statusCode = 404; res.end('nope') })
})

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
})

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', sessionsRouter)
  app.use(errorHandler)
  return app
}

async function writeHostsConfig(): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, [
    'version: 1',
    'hosts:',
    '  studio:',
    '    hostname: dev-box.corp.example.test',
    '    user: developer',
    '  builder:',
    '    hostname: build-box.corp.example.test',
    '',
  ].join('\n'))
}

const post = (sid: string, url: unknown) =>
  request(createApp()).post(`/api/sessions/${sid}/service-preview`).send({ url })

beforeEach(async () => {
  daemonMock.getDaemonConnection.mockReset()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await writeHostsConfig()
  await importSessionRecord({ claudeSessionId: 'local-1', taskId: '', project: 'Fixture', cwd: '/tmp' })
  await importSessionRecord({ claudeSessionId: 'remote-1', taskId: '', project: 'Fixture', cwd: '~/work', host: 'studio' })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('local session: loopback services load as written', () => {
  it('answers the same URL, path and query intact, with no ssh involved', async () => {
    const res = await post('local-1', `http://localhost:${livePort}/stage/view?x=1#top`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      url: `http://localhost:${livePort}/stage/view?x=1#top`,
      via: 'local', host: '__local__', remotePort: livePort, localPort: livePort,
      embeddable: true, reachability: 'ok',
    })
    // The probe asks the origin root, never the linked page: a one-time link
    // (a login callback, a token URL) must reach the iframe unspent.
    expect(lastPath).toBe('/')
    expect(daemonMock.getDaemonConnection).not.toHaveBeenCalled()
  })

  it('a scheme-less wildcard bind becomes a connectable localhost URL', async () => {
    const res = await post('local-1', `0.0.0.0:${livePort}`)
    expect(res.status).toBe(200)
    expect(res.body.url).toBe(`http://localhost:${livePort}/`)
    expect(res.body.requestedUrl).toBe(`http://0.0.0.0:${livePort}/`)
  })

  it('a 404 still means something is listening', async () => {
    const res = await post('local-1', `http://127.0.0.1:${notFoundPort}/missing`)
    expect(res.status).toBe(200)
    expect(res.body.reachability).toBe('ok')
  })

  it('502 unreachable when nothing listens, with a hint', async () => {
    const res = await post('local-1', `http://localhost:${await closedPort()}/`)
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('unreachable')
    expect(res.body.hint).toMatch(/running/)
    // Shown in place by the Web view: the request logger must not mint a red card.
    expect(res.headers['x-walnut-handled-failure']).toBe('1')
  })
})

describe('framing policy', () => {
  it('X-Frame-Options DENY → embeddable false', async () => {
    const res = await post('local-1', `http://localhost:${xfoPort}/`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ embeddable: false, embedBlockedBy: 'x-frame-options' })
  })

  it("frame-ancestors 'self' → blocked; frame-ancestors * → allowed", async () => {
    expect((await post('local-1', `http://localhost:${cspPort}/`)).body).toMatchObject({ embeddable: false, embedBlockedBy: 'frame-ancestors' })
    expect((await post('local-1', `http://localhost:${cspStarPort}/`)).body).toMatchObject({ embeddable: true })
  })

  it('follows a same-origin redirect so the LANDING page decides; stops at another origin', async () => {
    const landingPort = await serve((req, res) => {
      if (req.url === '/') { res.statusCode = 302; res.setHeader('location', '/app'); res.end(); return }
      res.setHeader('X-Frame-Options', 'DENY'); res.end('app')
    })
    expect((await post('local-1', `http://localhost:${landingPort}/`)).body).toMatchObject({ embeddable: false, embedBlockedBy: 'x-frame-options' })
    const awayPort = await serve((_req, res) => { res.statusCode = 302; res.setHeader('location', 'https://auth.example.test/login'); res.end() })
    const away = await post('local-1', `http://localhost:${awayPort}/`)
    expect(away.status).toBe(200)
    expect(away.body).toMatchObject({ embeddable: true, reachability: 'ok' })
  })

  it('header rules', () => {
    expect(frameBlockFromHeaders({ 'x-frame-options': 'DENY, DENY' })).toBe('x-frame-options')
    expect(frameBlockFromHeaders({ 'content-security-policy': "default-src 'self', frame-ancestors 'none'" })).toBe('frame-ancestors')
    expect(frameBlockFromHeaders({ 'content-security-policy': ["script-src 'self'", "frame-ancestors 'self' https://a.test"] })).toBe('frame-ancestors')
    expect(frameBlockFromHeaders({ 'x-frame-options': 'SAMEORIGIN' })).toBe('x-frame-options')
    expect(frameBlockFromHeaders({ 'x-frame-options': 'ALLOW-FROM x' })).toBeUndefined()
    expect(frameBlockFromHeaders({ 'content-security-policy': "script-src 'self'" })).toBeUndefined()
    expect(frameBlockFromHeaders({})).toBeUndefined()
  })
})

describe('remote session: loopback goes through the session host', () => {
  it('forwards the port on the session host and answers the tunnel end', async () => {
    const ensurePortForward = vi.fn().mockResolvedValue(livePort)
    const closePortForward = vi.fn()
    daemonMock.getDaemonConnection.mockResolvedValue({ ensurePortForward, closePortForward })
    const res = await post('remote-1', 'http://localhost:8080/app?q=1')
    expect(res.status).toBe(200)
    expect(daemonMock.getDaemonConnection).toHaveBeenCalledWith('studio', expect.objectContaining({ hostname: 'dev-box.corp.example.test', user: 'developer' }))
    expect(ensurePortForward).toHaveBeenCalledWith(8080, 'localhost', { evictable: true })
    expect(res.body).toMatchObject({
      url: `http://127.0.0.1:${livePort}/app?q=1`, via: 'tunnel', host: 'studio',
      remotePort: 8080, localPort: livePort, embeddable: true,
    })
    expect(lastPath).toBe('/')
    expect(closePortForward).not.toHaveBeenCalled()
  })

  it('an explicit 127.0.0.1 is forwarded as written', async () => {
    const ensurePortForward = vi.fn().mockResolvedValue(livePort)
    const closePortForward = vi.fn()
    daemonMock.getDaemonConnection.mockResolvedValue({ ensurePortForward, closePortForward })
    await post('remote-1', 'http://127.0.0.1:9000/')
    expect(ensurePortForward).toHaveBeenCalledWith(9000, '127.0.0.1', { evictable: true })
  })

  it('502 unreachable when the tunnel opens but nothing answers on the host, and the dead forward is closed', async () => {
    const dead = await closedPort()
    const closePortForward = vi.fn()
    daemonMock.getDaemonConnection.mockResolvedValue({ ensurePortForward: vi.fn().mockResolvedValue(dead), closePortForward })
    const res = await post('remote-1', 'http://localhost:8080/')
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('unreachable')
    expect(res.body.error).toContain('studio')
    expect(closePortForward).toHaveBeenCalledWith(8080, 'localhost')
  })

  it('502 tunnel_failed when the host cannot be reached', async () => {
    daemonMock.getDaemonConnection.mockRejectedValue(new Error('ssh: connect timed out'))
    const res = await post('remote-1', 'http://localhost:8080/')
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('tunnel_failed')
    expect(res.body.error).toContain('ssh: connect timed out')
  })
})

describe('a URL naming a configured host goes to THAT host', () => {
  it("ANOTHER host: only its name, never its loopback (what the URL reaches from anywhere)", async () => {
    const ensurePortForward = vi.fn().mockResolvedValue(livePort)
    daemonMock.getDaemonConnection.mockResolvedValue({ ensurePortForward, closePortForward: vi.fn() })
    const res = await post('local-1', 'http://build-box.corp.example.test:8377/')
    expect(res.status).toBe(200)
    expect(daemonMock.getDaemonConnection).toHaveBeenCalledWith('builder', expect.objectContaining({ hostname: 'build-box.corp.example.test' }))
    expect(ensurePortForward.mock.calls).toEqual([[8377, 'build-box.corp.example.test', { evictable: true }]])
    expect(res.body).toMatchObject({ host: 'builder', localPort: livePort, via: 'tunnel' })
  })

  it("the session's OWN host by name: loopback first, then the name; a refused address is closed", async () => {
    const dead = await closedPort()
    const closePortForward = vi.fn()
    const ensurePortForward = vi.fn(async (_port: number, target: string) => (target === 'localhost' ? dead : livePort))
    daemonMock.getDaemonConnection.mockResolvedValue({ ensurePortForward, closePortForward })
    const res = await post('remote-1', 'http://dev-box.corp.example.test:8377/')
    expect(res.status).toBe(200)
    expect(ensurePortForward.mock.calls).toEqual([
      [8377, 'localhost', { evictable: true }],
      [8377, 'dev-box.corp.example.test', { evictable: true }],
    ])
    expect(closePortForward).toHaveBeenCalledWith(8377, 'localhost')
    expect(res.body).toMatchObject({ host: 'studio', localPort: livePort })
  })

  it('the short name works too, and a failing forward falls through to the next address', async () => {
    const ensurePortForward = vi.fn()
      .mockRejectedValueOnce(new Error('not accepting connections after 10s'))
      .mockResolvedValueOnce(livePort)
    daemonMock.getDaemonConnection.mockResolvedValue({ ensurePortForward, closePortForward: vi.fn() })
    const res = await post('remote-1', 'http://dev-box:8080/')
    expect(res.status).toBe(200)
    expect(res.body.host).toBe('studio')
    expect(ensurePortForward).toHaveBeenCalledTimes(2)
  })

  it('an FQDN that only shares a bare alias as its first label is NOT that host', async () => {
    const res = await post('remote-1', 'http://studio.attacker.test:8080/')
    expect(res.status).toBe(422)
    expect(daemonMock.getDaemonConnection).not.toHaveBeenCalled()
  })
})

describe('refusals', () => {
  it('422 for a host that is neither this machine nor configured', async () => {
    const res = await post('local-1', 'http://example.com:8080/')
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('unknown_host')
    expect(daemonMock.getDaemonConnection).not.toHaveBeenCalled()
  })

  it.each([[''], ['ftp://x/y'], [42], [null]])('400 for a non-http url %j', async (url) => {
    const res = await post('local-1', url)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad_url')
  })

  it('404 for an unknown session', async () => {
    const res = await post('no-such-session', 'http://localhost:8080/')
    expect(res.status).toBe(404)
  })

  it('504 when the host never answers inside the deadline', async () => {
    daemonMock.getDaemonConnection.mockReturnValue(new Promise(() => {}))
    const session = { claudeSessionId: 'remote-1', host: 'studio' } as Parameters<typeof buildSessionServicePreview>[0]
    await expect(buildSessionServicePreview(session, 'http://localhost:8080/', { deadlineMs: 50 }))
      .rejects.toMatchObject({ status: 504, code: 'timeout' })
  })
})

describe('https with a certificate the browser will refuse in a frame', () => {
  it('a self-signed local https service is up but not embeddable (the card offers a tab)', async () => {
    const { execFileSync } = await import('node:child_process')
    const os = await import('node:os')
    const path = await import('node:path')
    const https = await import('node:https')
    let dir = ''
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-svc-tls-'))
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      ], { stdio: 'ignore' })
    } catch {
      return // no openssl on this box: the rule is still pinned by the unit above
    }
    const srv = https.createServer({
      key: await fs.readFile(path.join(dir, 'key.pem')),
      cert: await fs.readFile(path.join(dir, 'cert.pem')),
    }, (_req, res) => res.end('secure'))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const port = (srv.address() as AddressInfo).port
      const res = await post('local-1', `https://localhost:${port}/`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ reachability: 'ok', embeddable: false, embedBlockedBy: 'certificate' })
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
