/**
 * POST /bridge/ingest on a real CLOUD_MODE server (src/web/routes/bridge-ingest.ts),
 * and the Mac's client (src/core/cloud-ingest.ts) talking to it.
 *
 * Why the lane exists: the bridge's far-side closes lined up with bulk uploads in
 * flight, and the replica's TLS terminator logged corrupted upload records in the
 * same minutes (docs/reference/cloud-sync.md). Uploads now ride short requests, so
 * a damaged one costs one retry instead of the phone's whole connection.
 *
 * Pinned here: only the primary's machine credential writes (a phone token, an
 * API key or another machine's token get 403; none or a wrong one 401); the body
 * may be gzip and the limit is on the INFLATED size; a stored list is what the
 * phone then reads, `syncedAt` included; and the Mac client's 'sent' means the
 * file is on the replica's disk.
 *
 * auth.json is written fresh (tokens known to the test); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-ingest-cloud', { CLOUD_MODE: true }))

// The Mac client's endpoint lookup (its bridge config), pointed at this server.
// Everything else real.
let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { readProjectionCache, readTranscriptCache } from '../../../src/core/projection-cache.js'
import { postToCloudIngest, cloudIngestResting, _resetCloudIngestForTesting } from '../../../src/core/cloud-ingest.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), devbox: tok(), phone: tok() }

const sessionEnvelope = (id: string, exportedAt: string) => ({
  version: 1,
  exportedAt,
  sessions: [{ id, host: '', process_status: 'running', started_at: '2026-09-30T00:00:00.000Z', last_active_at: exportedAt, message_count: 3 }],
})
const tail = (sid: string) => ({
  version: 1, sessionId: sid, exportedAt: '2026-09-30T00:00:00.000Z', truncated: false,
  messages: [{ role: 'user', text: 'hello from the Mac', timestamp: '2026-09-30T00:00:00.000Z' }],
})

async function ingest(bearer: string | null, body: unknown, opts: { gzip?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const json = Buffer.from(JSON.stringify(body), 'utf8')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (opts.gzip) headers['Content-Encoding'] = 'gzip'
  const r = await fetch(`http://127.0.0.1:${port}/bridge/ingest`, {
    method: 'POST', headers, body: opts.gzip ? zlib.gzipSync(json) : json,
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

/** auth.json as the companion holds it; `local` = the Mac's current bridge-local token. */
async function writeAuth(local: string): Promise<void> {
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(local), createdAt: now, kind: 'machine' },
    { name: 'bridge-devbox', id: 'd00000000000000e5', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

/** Raw socket: headers plus 1KB of a 50MB declared body; the status line seen before the body completes. */
async function statusBeforeBody(headers: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no answer before the body in 3s: ${buf.slice(0, 80)}`)) }, 3_000)
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      const nl = buf.indexOf('\r\n')
      if (nl !== -1) { clearTimeout(timer); sock.destroy(); resolve(buf.slice(0, nl)) }
    })
    sock.on('error', () => { /* destroyed after the status line */ })
    sock.write(['POST /bridge/ingest HTTP/1.1', `Host: 127.0.0.1:${port}`, `Content-Length: ${50 * 1024 * 1024}`, ...headers, '', ''].join('\r\n'))
    sock.write(Buffer.alloc(1024, 0x20))
  })
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeAuth(T.local)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  _resetCloudIngestForTesting()
})

describe('who may write', () => {
  const payload = { kind: 'projection-upsert', data: { which: 'sessions', data: sessionEnvelope('s-auth', '2026-09-30T00:00:00.000Z') } }

  it.each([
    ['no token', null, 401],
    ['a wrong token', 'not-a-token', 401],
    ['a phone device token', T.phone, 403],
    ["another host's machine token", T.devbox, 403],
  ] as const)('%s is refused (%i) and nothing is written', async (_label, bearer, status) => {
    const res = await ingest(bearer, payload)
    expect(res.status).toBe(status)
    expect(await readProjectionCache('sessions')).toBeNull()
  })

  it('the /api surface still refuses the machine token', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/recent`, { headers: { Authorization: `Bearer ${T.local}` } })
    expect(r.status).toBe(401)
  })
})

describe('the credential is checked before the body is read', () => {
  // A caller that may not write never makes this box read (or inflate) its body:
  // the answer comes while 50MB are still declared and unsent.
  it.each([
    ['no token, plain json', ['Content-Type: application/json'], '401'],
    ['no token, gzip', ['Content-Type: application/json', 'Content-Encoding: gzip'], '401'],
    ['a wrong token', ['Content-Type: application/json', 'Authorization: Bearer nope'], '401'],
    ['a phone token', ['Content-Type: application/json', `Authorization: Bearer ${T.phone}`], '403'],
  ])('%s: %s before the body', async (_label, headers, code) => {
    expect(await statusBeforeBody(headers)).toContain(` ${code} `)
  })
})

describe('auth strikes per IP (the same limiter as /api)', () => {
  const body = (id: string) => ({ kind: 'projection-upsert', data: { which: 'sessions', data: sessionEnvelope(id, '2026-09-30T00:00:00.000Z') } })
  const from = async (ip: string, bearer: string | null) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    const r = await fetch(`http://127.0.0.1:${port}/bridge/ingest`, { method: 'POST', headers, body: JSON.stringify(body(`rl-${ip}`)) })
    return r.status
  }

  it('10 wrong tokens from one IP lock that IP out, the right token included; another IP is not affected', async () => {
    for (let i = 0; i < 10; i++) expect(await from('203.0.113.7', `wrong-${i}`)).toBe(401)
    expect(await from('203.0.113.7', T.local)).toBe(429)
    expect(await from('203.0.113.8', T.local)).toBe(200)
  })

  it('a missing token is not a strike, and neither is a valid credential of the wrong class', async () => {
    for (let i = 0; i < 12; i++) expect(await from('203.0.113.9', null)).toBe(401)
    for (let i = 0; i < 12; i++) expect(await from('203.0.113.9', T.phone)).toBe(403)
    expect(await from('203.0.113.9', T.local)).toBe(200)
  })
})

describe('what the primary writes lands where the phone reads it', () => {
  it('a gzip session list is stored and served to the phone, syncedAt included', async () => {
    const stamp = '2026-09-30T07:00:00.000Z'
    const res = await ingest(T.local, { kind: 'projection-upsert', data: { which: 'sessions', data: sessionEnvelope('s-gzip', stamp) } }, { gzip: true })
    expect(res).toEqual({ status: 200, body: { ok: true } })
    const phone = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/recent`, { headers: { Authorization: `Bearer ${T.phone}` } })
    expect(phone.status).toBe(200)
    const body = await phone.json() as { sessions: Array<{ id: string }>; syncedAt: string }
    expect(body.sessions.map((s) => s.id)).toEqual(['s-gzip'])
    expect(body.syncedAt).toBe(stamp)
  })

  it('a transcript tail is stored under its session id', async () => {
    const res = await ingest(T.local, { kind: 'transcript-upsert', data: { sid: 's-tail', data: tail('s-tail') } })
    expect(res.status).toBe(200)
    expect(await readTranscriptCache('s-tail')).toEqual(tail('s-tail'))
  })

  it.each([
    ['an unknown kind', { kind: 'session-upsert', data: { id: 'x' } }, 'unknown_kind'],
    ['a list with no which', { kind: 'projection-upsert', data: { data: {} } }, 'invalid_payload'],
    ['a transcript id that is a path', { kind: 'transcript-upsert', data: { sid: '../escape', data: tail('x') } }, 'invalid_payload'],
  ])('%s is a 400', async (_label, body, error) => {
    const res = await ingest(T.local, body)
    expect(res).toEqual({ status: 400, body: { error } })
  })

  it('the size limit is on the inflated body: 7MB that gzips small is still refused', async () => {
    const huge = { kind: 'transcript-upsert', data: { sid: 's-huge', data: { pad: 'x'.repeat(7 * 1024 * 1024) } } }
    const res = await ingest(T.local, huge, { gzip: true })
    expect(res).toEqual({ status: 413, body: { error: 'too_large' } })
    expect(await readTranscriptCache('s-huge')).toBeNull()
  })
})

describe('the Mac client against this route', () => {
  it("'sent' means the replica has the file", async () => {
    bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
    const data = JSON.stringify({ sid: 's-client', data: tail('s-client') })
    expect(await postToCloudIngest('transcript-upsert', data)).toBe('sent')
    expect(await readTranscriptCache('s-client')).toEqual(tail('s-client'))
  })

  it('a token the replica does not accept is unsupported (the Mac falls back to the bridge)', async () => {
    bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.devbox }
    expect(await postToCloudIngest('transcript-upsert', JSON.stringify({ sid: 's-refused', data: tail('s-refused') }))).toBe('unsupported')
    expect(await readTranscriptCache('s-refused')).toBeNull()
  })
})

describe('a stale Mac token with a burst queued (the replica re-minted it)', () => {
  it('spends at most 2 strikes, so the phone and the fresh token on the same IP still get in', async () => {
    _resetCloudIngestForTesting()
    bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
    expect(await postToCloudIngest('transcript-upsert', JSON.stringify({ sid: 's-burst-warm', data: tail('s-burst-warm') }))).toBe('sent')
    const reminted = tok()
    await writeAuth(reminted)
    try {
      const outs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        postToCloudIngest('transcript-upsert', JSON.stringify({ sid: `s-burst-${i}`, data: tail(`s-burst-${i}`) }))))
      expect(outs.every((o) => o === 'unsupported')).toBe(true)
      expect(cloudIngestResting()).toBe(true)
      const phone = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/recent`, { headers: { Authorization: `Bearer ${T.phone}` } })
      expect(phone.status).not.toBe(429)
      expect((await ingest(reminted, { kind: 'transcript-upsert', data: { sid: 's-burst-after', data: tail('s-burst-after') } })).status).toBe(200)
    } finally {
      await writeAuth(T.local)
    }
  })
})
