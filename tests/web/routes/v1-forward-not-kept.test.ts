/**
 * The forward for what the companion does not keep (docs/plan/walnut-companion-unified-replica.md,
 * 4f): src/web/v1-forward/proxy.ts (a kept phone read of a copy turned off, and the console's
 * `consoleCopy`), core/companion-forward.ts (the console's copy-kind reads), and the Mac's door
 * for them (target.ts), with the Mac's choice read from its config.yaml.
 *
 * Pinned:
 *   - a kept phone read of a copy (the chat list, a chat's messages) is answered on the box
 *     while that kind is kept, and goes to the Mac while it is off and the Mac answers; away,
 *     the box's own route answers (which then says it needs the Mac);
 *   - a listed console call goes to the Mac while it answers; away, turned off, or this
 *     server's own call: answered here; an unlisted one never leaves;
 *   - a console read of a kind the box keeps never asks the Mac; of a kind turned off, it
 *     does, and away it reaches the box's route;
 *   - on the Mac: a kept phone read runs only when the Mac's own choice says the kind is off
 *     for the box; a listed console call runs, an unlisted one is refused before any route.
 */
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-v1-forward-not-kept'))

/** The kinds this box's copy holds no more (kinds/gate.ts copyKindOff). */
const off = new Set<string>()
vi.mock('../../../src/core/replication/kinds/gate.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/replication/kinds/gate.js')>()),
  copyKindOff: async (kind: string) => off.has(kind),
  keepsCopies: () => true,
}))

/** The box's forward, as core/companion-forward.ts reaches it (getV1Forward). */
let boxForward: ReturnType<typeof import('../../../src/web/v1-forward/proxy.js').createV1Forward> | null = null
vi.mock('../../../src/web/v1-forward/proxy.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/v1-forward/proxy.js')>()),
  getV1Forward: () => boxForward,
}))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { createV1Forward, type CallOutcome, type PrimarySnapshot } from '../../../src/web/v1-forward/proxy.js'
import { runForwardedCall, ForwardError } from '../../../src/web/v1-forward/target.js'
import { companionUnkeptKindReads } from '../../../src/core/companion-forward.js'
import { setSelfApiRoot } from '../../../src/lib/self-api-root.js'
import { createCompanionDoor } from '../../../src/web/v1-forward/stream-door.js'
import { kindState } from '../../../src/core/replication/replica-status.js'
import http from 'node:http'
import net from 'node:net'

const fresh = (over: Partial<PrimarySnapshot> = {}): PrimarySnapshot => ({
  bridge: true, heard: true, lastSeenAt: Date.now() - 1_000, leading: 0, backupAllowed: true, takeoverMs: 60_000, ...over,
})
const away = (): PrimarySnapshot => fresh({ bridge: false })

const reply = (value: unknown): CallOutcome => {
  const buf = Buffer.from(JSON.stringify(value))
  return { ok: true, result: { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, size: buf.byteLength, data: buf.toString('base64') } }
}

/** The companion: its forward in front of stand-ins for its own routes. */
function box(opts: { primary?: () => PrimarySnapshot; ownToken?: string } = {}) {
  const calls: string[] = []
  const here: string[] = []
  const fwd = createV1Forward({
    now: () => Date.now(),
    enabled: () => true,
    ownCall: (req) => opts.ownToken !== undefined && req.headers.authorization === `Bearer ${opts.ownToken}`,
    primary: async () => (opts.primary ? opts.primary() : fresh()),
    call: async (params) => { calls.push(`${params.method} ${params.url}`); return reply({ from: 'mac' }) },
  })
  boxForward = fwd
  const app = express()
  app.use(express.json())
  app.use('/api/v1', fwd.middleware)
  // The console's copy-kind reads (server.ts mounts it on the companion, before the routes).
  app.use(companionUnkeptKindReads)
  // A notes route that reads the copy: what it does not keep it carries (forwardUnkept).
  app.get('/api/notes-v2/content/*rest', (req, res) => fwd.consoleCopy(req, res, () => { here.push(req.originalUrl); res.json({ from: 'companion' }) }))
  app.all('/api/*rest', (req, res) => { here.push(req.originalUrl); res.json({ from: 'companion' }) })
  return { app, calls, here }
}

beforeEach(() => { off.clear() })

describe('a kept phone read of a copy', () => {
  it('kept: answered on the box, the Mac never asked', async () => {
    const h = box()
    expect((await request(h.app).get('/api/v1/conversations?agentId=general')).body).toEqual({ from: 'companion' })
    expect((await request(h.app).get('/api/v1/conversations/c1/messages')).body).toEqual({ from: 'companion' })
    expect(h.calls).toEqual([])
  })

  it('turned off: the Mac answers it while it answers', async () => {
    off.add('conversations').add('conversation-bodies')
    const h = box()
    const list = await request(h.app).get('/api/v1/conversations?agentId=general')
    expect(list.body).toEqual({ from: 'mac' })
    expect(list.headers['x-walnut-answered-by']).toBe('primary')
    expect((await request(h.app).get('/api/v1/conversations/c1/messages')).body).toEqual({ from: 'mac' })
    expect(h.calls).toEqual(['GET /api/v1/conversations?agentId=general', 'GET /api/v1/conversations/c1/messages'])
    // A kept call of another kind, and a send, stay on the box.
    expect((await request(h.app).post('/api/v1/conversations/c1/messages').send({ text: 'hi' })).body).toEqual({ from: 'companion' })
    expect(h.calls).toHaveLength(2)
  })

  it('turned off, the Mac away: the box\'s own route answers', async () => {
    off.add('conversations')
    const h = box({ primary: away })
    expect((await request(h.app).get('/api/v1/conversations')).body).toEqual({ from: 'companion' })
    expect(h.calls).toEqual([])
  })

  it('only the kind it reads counts: the chat list stays when only the bodies are off', async () => {
    off.add('conversation-bodies')
    const h = box()
    expect((await request(h.app).get('/api/v1/conversations')).body).toEqual({ from: 'companion' })
    expect((await request(h.app).get('/api/v1/conversations/c1/messages')).body).toEqual({ from: 'mac' })
  })
})

describe('the console\'s calls about what the box does not keep', () => {
  it('a notes read the copy leaves out goes to the Mac while it answers; away, it is answered here', async () => {
    const h = box()
    expect((await request(h.app).get('/api/notes-v2/content/Acme/plan')).body).toEqual({ from: 'mac' })
    expect(h.calls).toEqual(['GET /api/notes-v2/content/Acme/plan'])
    const gone = box({ primary: away })
    expect((await request(gone.app).get('/api/notes-v2/content/Acme/plan')).body).toEqual({ from: 'companion' })
    expect(gone.calls).toEqual([])
  })

  it('this server\'s own call is answered here', async () => {
    const h = box({ ownToken: 'self' })
    expect((await request(h.app).get('/api/notes-v2/content/Acme/plan').set('Authorization', 'Bearer self')).body).toEqual({ from: 'companion' })
    expect(h.calls).toEqual([])
  })

  it('a console read of a kind the box keeps never asks the Mac', async () => {
    const h = box()
    for (const p of ['/api/ui-prefs', '/api/favorites', '/api/stt/vocab', '/api/agents/general/conversations', '/api/chat/history?agentId=general', '/api/sessions/ask-walnut-launch', '/api/sessions/host-model-catalogs']) {
      expect([p, (await request(h.app).get(p)).body]).toEqual([p, { from: 'companion' }])
    }
    expect(h.calls).toEqual([])
  })

  it('a console read of a kind turned off goes to the Mac; away, the box\'s route answers (and says it needs the Mac)', async () => {
    off.add('prefs').add('stt-vocab').add('conversations').add('conversation-bodies').add('personas').add('model-catalogs')
    const h = box()
    const reads = ['/api/ui-prefs', '/api/favorites', '/api/stt/vocab', '/api/agents/general/conversations', '/api/chat/history?agentId=general', '/api/sessions/ask-walnut-launch', '/api/sessions/host-model-catalogs']
    for (const p of reads) expect([p, (await request(h.app).get(p)).body]).toEqual([p, { from: 'mac' }])
    expect(h.calls).toEqual(reads.map((p) => `GET ${p}`))
    // A write of one is not a read: it runs here (its own route refuses it while off).
    expect((await request(h.app).put('/api/ui-prefs').send({})).body).toEqual({ from: 'companion' })
    const gone = box({ primary: away })
    for (const p of reads) expect([p, (await request(gone.app).get(p)).body]).toEqual([p, { from: 'companion' }])
    expect(gone.calls).toEqual([])
  })
})

/** This Mac's record that the companion took its last round of `kind` (copy-kind.ts copyKindHeldBy). */
const held = (kind: string, action: string | undefined) => { kindState({ id: 'companion', kind: 'companion', label: 'Cloud companion' }, kind).action = action }

describe('the Mac\'s door for them (target.ts)', () => {
  let server: Server
  const hits: string[] = []

  beforeAll(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    const app = express()
    app.use((req, res) => { hits.push(`${req.method} ${req.originalUrl}`); res.json({ fromMac: true }) })
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const addr = server.address()
    setSelfApiRoot(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`)
  })
  afterAll(async () => {
    setSelfApiRoot(null)
    await new Promise<void>((r) => server.close(() => r()))
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })
  beforeEach(() => { hits.length = 0; held('conversations', 'synced'); held('conversation-bodies', 'synced') })

  const choose = (bridge: Record<string, unknown> | undefined) => fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, ...(bridge ? { cloud_bridge: bridge } : {}) }))
  const refused = async (params: Record<string, unknown>) => {
    const err = await runForwardedCall(params, 'remote-http').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ForwardError)
    return err as ForwardError
  }

  it('a kept phone read of a copy the Mac keeps for the box is refused before any route', async () => {
    await choose(undefined)
    expect(await refused({ method: 'GET', url: '/api/v1/conversations' })).toMatchObject({ code: 'forward_refused', status: 400 })
    await choose({ copies: { prefs: false } })
    expect(await refused({ method: 'GET', url: '/api/v1/conversations/c1/messages' })).toMatchObject({ code: 'forward_refused' })
    expect(hits).toEqual([])
  })

  it('turned on again, and no round of it has reached the box yet: the read runs (the box still holds the off marker)', async () => {
    await choose(undefined)
    for (const action of [undefined, 'off', 'failed', 'unsupported']) {
      held('conversations', action)
      expect([action, (await runForwardedCall({ method: 'GET', url: '/api/v1/conversations' }, 'remote-http')).status]).toEqual([action, 200])
    }
    // Once a round lands, the box answers its copy itself again.
    held('conversations', 'unchanged')
    expect(await refused({ method: 'GET', url: '/api/v1/conversations' })).toMatchObject({ code: 'forward_refused' })
    expect(hits).toEqual(['GET /api/v1/conversations', 'GET /api/v1/conversations', 'GET /api/v1/conversations', 'GET /api/v1/conversations'])
  })

  it('the Mac\'s choice turned the kind off for the box: the read runs', async () => {
    await choose({ copies: { conversations: false } })
    // The bodies ride with the list (copyChoiceFrom): both run.
    expect((await runForwardedCall({ method: 'GET', url: '/api/v1/conversations?agentId=general' }, 'remote-http')).status).toBe(200)
    expect((await runForwardedCall({ method: 'GET', url: '/api/v1/conversations/c1/messages' }, 'remote-http')).status).toBe(200)
    expect(hits).toEqual(['GET /api/v1/conversations?agentId=general', 'GET /api/v1/conversations/c1/messages'])
    // A kept write of the same route is still the box's.
    expect(await refused({ method: 'POST', url: '/api/v1/conversations/c1/messages', headers: { 'content-type': 'application/json' }, data: Buffer.from('{}').toString('base64'), size: 2 })).toMatchObject({ code: 'forward_refused' })
  })

  it('a listed console call runs; anything else under /api is refused', async () => {
    await choose(undefined)
    expect((await runForwardedCall({ method: 'GET', url: '/api/search?q=acme' }, 'remote-http')).status).toBe(200)
    expect((await runForwardedCall({ method: 'GET', url: '/api/ui-prefs' }, 'remote-http')).status).toBe(200)
    const note = Buffer.from(JSON.stringify({ content: '# Plan\n' }))
    expect((await runForwardedCall({ method: 'PUT', url: '/api/notes-v2/content/Acme/plan', headers: { 'content-type': 'application/json' }, data: note.toString('base64'), size: note.byteLength }, 'remote-http')).status).toBe(200)
    expect(hits).toEqual(['GET /api/search?q=acme', 'GET /api/ui-prefs', 'PUT /api/notes-v2/content/Acme/plan'])
    hits.length = 0
    for (const params of [{ method: 'GET', url: '/api/config' }, { method: 'PUT', url: '/api/ui-prefs' }, { method: 'GET', url: '/api/notes-v2/content/../../config' }]) {
      expect(await refused(params)).toMatchObject({ code: 'forward_refused' })
    }
    expect(hits).toEqual([])
  })
})

describe('the Mac\'s two doors run one check (target.ts checkForwardTarget; stream-door.ts)', () => {
  let mac: Server
  let front: net.Server
  let door: ReturnType<typeof createCompanionDoor>
  let frontPort = 0
  const hits: string[] = []

  beforeAll(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    const app = express()
    app.use((req, res) => { hits.push(`${req.method} ${req.originalUrl}`); res.json({ fromMac: true }) })
    mac = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const addr = mac.address()
    const root = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    setSelfApiRoot(root)
    // A stream is any duplex: a socket stands in for the one the Mac's daemon hands over.
    door = createCompanionDoor({ root: () => root })
    front = net.createServer((socket) => door.accept(socket, 'remote-http'))
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()))
    frontPort = (front.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    setSelfApiRoot(null)
    door.close()
    await new Promise<void>((r) => front.close(() => r()))
    await new Promise<void>((r) => mac.close(() => r()))
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })
  beforeEach(() => { hits.length = 0; held('conversations', 'synced'); held('conversation-bodies', 'synced') })

  const choose = (bridge: Record<string, unknown> | undefined) => fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, ...(bridge ? { cloud_bridge: bridge } : {}) }))

  /** One call on a stream to the door, as the companion's stream forward writes it. */
  const onStream = (method: string, url: string, body?: string) => new Promise<{ status: number; refused: boolean }>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: frontPort, method, path: url, agent: false,
      headers: { host: 'primary', ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, refused: res.headers['x-walnut-forward-refused'] === '1' }))
    })
    req.on('error', reject)
    req.end(body)
  })
  /** The same call as one server.http frame. */
  const asFrame = async (method: string, url: string, body?: string): Promise<{ status: number; refused: boolean }> => {
    const data = body !== undefined ? Buffer.from(body) : null
    try {
      const r = await runForwardedCall({ method, url, ...(data ? { headers: { 'content-type': 'application/json' }, data: data.toString('base64'), size: data.byteLength } : {}) }, 'remote-http')
      return { status: r.status, refused: false }
    } catch (err) {
      if (err instanceof ForwardError && err.code === 'forward_refused') return { status: err.status, refused: true }
      throw err
    }
  }

  const NOTE = JSON.stringify({ content: '# Plan \u4e2d\n' })
  const CONSOLE_CALLS: Array<[string, string, string?]> = [
    ['GET', '/api/notes-v2/list'],
    ['GET', '/api/notes-v2/content/health/a.md'],
    ['GET', '/api/search?q=acme%20plan'],
    ['GET', '/api/ui-prefs'],
    ['GET', '/api/memory/global'],
    ['GET', '/api/skills'],
    ['PUT', '/api/notes-v2/content/health/a.md', NOTE],
    ['PUT', '/api/memory/global', JSON.stringify({ content: 'x' })],
    ['POST', '/api/memory/daily-log/compact', '{}'],
  ]

  it('a console call about what the box does not keep runs on a stream as it runs as a frame', async () => {
    await choose(undefined)
    for (const [method, url, body] of CONSOLE_CALLS) {
      const stream = await onStream(method, url, body)
      const frame = await asFrame(method, url, body)
      expect([method, url, stream]).toEqual([method, url, { status: 200, refused: false }])
      expect([method, url, frame]).toEqual([method, url, stream])
    }
    // Each ran twice on the Mac's own route, once per door.
    expect(hits).toEqual(CONSOLE_CALLS.flatMap(([m, u]) => [`${m} ${u}`, `${m} ${u}`]))
  })

  it('a phone read the box keeps: both doors refuse it while the box holds it, both run it when it does not', async () => {
    await choose(undefined)
    const cases: Array<{ copies?: Record<string, boolean>; action?: string; runs: boolean }> = [
      { runs: false },
      { copies: { conversations: false }, runs: true },
      { action: 'off', runs: true },
      { action: undefined, runs: true },
    ]
    for (const c of cases) {
      await choose(c.copies ? { copies: c.copies } : undefined)
      held('conversations', 'action' in c ? c.action : 'synced')
      for (const url of ['/api/v1/conversations?agentId=general']) {
        const stream = await onStream('GET', url)
        const frame = await asFrame('GET', url)
        expect([c, stream.refused]).toEqual([c, !c.runs])
        expect([c, frame]).toEqual([c, stream])
      }
    }
  })

  it('what neither door runs, it refuses before any route: a kept send, a path off the lists, a dot segment', async () => {
    await choose({ copies: { conversations: false } })
    for (const [method, url, body] of [['POST', '/api/v1/conversations/c1/messages', '{}'], ['GET', '/api/config'], ['PUT', '/api/ui-prefs', '{}'], ['GET', '/api/notes-v2/content/../../config']] as Array<[string, string, string?]>) {
      const stream = await onStream(method, url, body)
      const frame = await asFrame(method, url, body)
      expect([method, url, stream.refused, frame.refused]).toEqual([method, url, true, true])
    }
    expect(hits).toEqual([])
  })
})
