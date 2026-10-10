/**
 * What a host server answers itself while it is alone (src/host-server/alone-api.ts):
 * the real API over a real HTTP server, with the daemon link and the route as
 * stand-ins. Who may ask (a device token the copy names), when (only alone,
 * /state always), what reaches the daemon, and how its refusals read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createAloneApi } from '../../src/host-server/alone-api.js'
import { createDeviceCopy } from '../../src/host-server/device-copy.js'
import type { Route } from '../../src/host-server/route.js'

const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const TOKEN = 'browser-token'
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

let dir = ''
let server: http.Server
let port = 0
let route: Route = { kind: 'alone', why: 'mac-away' }
let calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
let answer: (cmd: string, params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
let devices: ReturnType<typeof createDeviceCopy>

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alone-api-'))
  devices = createDeviceCopy(path.join(dir, 'devices.json'))
  devices.put({ devices: [{ name: 'browser-a1b2c3', tokenHash: sha(TOKEN) }] })
  route = { kind: 'alone', why: 'mac-away' }
  calls = []
  answer = () => ({ ok: true })
  const api = createAloneApi({
    label: 'devbox',
    route: () => route,
    devices,
    request: async (cmd, params) => { calls.push({ cmd, params }); return answer(cmd, params) },
    transcript: async (sid, jsonl) => ({ sessionId: sid, lines: jsonl.split('\n').filter(Boolean).length }),
    log: () => {},
  })
  server = http.createServer((req, res) => { void api.handle(req, res).then((mine) => { if (!mine) { res.writeHead(418); res.end() } }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function ask(method: string, p: string, opts: { token?: string | null; body?: unknown; raw?: string } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? TOKEN}` }),
      ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  })
  const text = await res.text()
  let json: Record<string, any> = {}
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers }
}

describe('who may ask, and when', () => {
  it('/state answers anyone, names no session, and says whether the token holds', async () => {
    expect((await ask('GET', '/_alone/state', { token: null })).json).toEqual({ route: 'alone', why: 'mac-away', label: 'devbox', auth: 'no_token' })
    expect((await ask('GET', '/_alone/state')).json.auth).toBe('ok')
    expect((await ask('GET', '/_alone/state', { token: 'nope' })).json.auth).toBe('unknown_token')
    route = { kind: 'leader' }
    expect((await ask('GET', '/_alone/state')).json).toEqual({ route: 'leader', label: 'devbox', auth: 'ok' })
    expect(calls).toHaveLength(0)
  })

  it('everything else needs a token the copy names', async () => {
    for (const token of [null, 'nope', '']) {
      const r = await ask('GET', '/_alone/sessions', { token })
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe('unauthorized')
    }
    expect(calls).toHaveLength(0)
  })

  it('without a copy from the Mac it says so', async () => {
    const empty = createDeviceCopy(path.join(dir, 'none.json'))
    const api = createAloneApi({ label: 'devbox', route: () => route, devices: empty, request: async () => ({ ok: true }), transcript: async () => ({}), log: () => {} })
    const s = http.createServer((req, res) => { void api.handle(req, res) })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/_alone/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })
      expect(r.status).toBe(401)
      expect((await r.json()).error.code).toBe('no_device_copy')
    } finally {
      await new Promise<void>((r) => s.close(() => r()))
    }
  })

  it('while the Mac or the companion answers, nothing but /state: the page opens the full console', async () => {
    for (const r of [{ kind: 'leader' }, { kind: 'companion', origin: 'https://companion.example' }] as Route[]) {
      route = r
      const res = await ask('POST', `/_alone/sessions/${SID}/messages`, { body: { text: 'hi' } })
      expect(res.status).toBe(409)
      expect(res.json.error.code).toBe('leader_answers')
    }
    expect(calls).toHaveLength(0)
  })

  it('a path outside /_alone/ is not its own', async () => {
    expect((await ask('GET', '/api/tasks')).status).toBe(418)
  })
})

describe('what reaches the daemon', () => {
  it('the list, as the daemon gave it', async () => {
    answer = () => ({ ok: true, host: 'devbox', asOf: '2026-10-05T10:00:00.000Z', sessions: [{ sid: SID, state: 'idle' }] })
    const r = await ask('GET', '/_alone/sessions')
    expect(r.json).toEqual({ host: 'devbox', asOf: '2026-10-05T10:00:00.000Z', sessions: [{ sid: SID, state: 'idle' }] })
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(calls).toEqual([{ cmd: 'follower.sessions', params: {} }])
  })

  it('a transcript read is a tail read, shaped by the parser', async () => {
    answer = () => ({ ok: true, main: '{"a":1}\n{"b":2}\n' })
    const r = await ask('GET', `/_alone/sessions/${SID}/transcript`)
    expect(r.json).toEqual({ sessionId: SID, lines: 2 })
    expect(calls).toEqual([{ cmd: 'read-history', params: { sid: SID, tailBytes: 512 * 1024 } }])
  })

  it('a message: trimmed, a message id of the daemon\'s shape passed on, another one dropped', async () => {
    answer = (_c, p) => ({ ok: true, delivered: true, messageId: p.messageId ?? 'qm-offline-1' })
    const r = await ask('POST', `/_alone/sessions/${SID}/messages`, { body: { text: '  hello  ', messageId: 'qm-alone-1' } })
    expect(r.json).toEqual({ status: 'delivered', sessionId: SID, messageId: 'qm-alone-1' })
    await ask('POST', `/_alone/sessions/${SID}/messages`, { body: { text: 'again', messageId: '../x' } })
    expect(calls.map((c) => c.params)).toEqual([{ sid: SID, text: 'hello', messageId: 'qm-alone-1' }, { sid: SID, text: 'again' }])
  })

  it('a permission answer, every field as given', async () => {
    answer = (_c, p) => ({ ok: true, status: 'resolved', requestId: p.requestId, allow: p.allow })
    const r = await ask('POST', `/_alone/sessions/${SID}/permission`, { body: { requestId: 'perm-1', allow: true, answers: { 'Which one?': 'A' } } })
    expect(r.json).toEqual({ status: 'resolved', requestId: 'perm-1', allow: true })
    expect(calls).toEqual([{ cmd: 'follower.permission', params: { sid: SID, requestId: 'perm-1', allow: true, answers: { 'Which one?': 'A' } } }])
  })

  it('refuses before the daemon: an empty or too long text, a bad id, bad JSON, a body too large', async () => {
    expect((await ask('POST', `/_alone/sessions/${SID}/messages`, { body: { text: '  ' } })).status).toBe(400)
    expect((await ask('POST', `/_alone/sessions/${SID}/messages`, { body: { text: 'x'.repeat(100_001) } })).status).toBe(413)
    expect((await ask('GET', '/_alone/sessions/..%2Fetc/transcript')).status).toBe(400)
    expect((await ask('GET', '/_alone/sessions/short/transcript')).status).toBe(400)
    expect((await ask('POST', `/_alone/sessions/${SID}/messages`, { raw: '{nope' })).status).toBe(400)
    expect((await ask('POST', `/_alone/sessions/${SID}/messages`, { raw: JSON.stringify({ text: 'x'.repeat(300 * 1024) }) })).status).toBe(413)
    expect((await ask('DELETE', `/_alone/sessions/${SID}/messages`)).status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})

describe('the daemon\'s refusals, as the Mac\'s API says them', () => {
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ ok: false, error: 'follower.send: not a session of this Walnut on this host', errorKind: 'not_found' }, 404, 'not_found'],
    [{ ok: false, error: 'follower.send: this session is not running', errorKind: 'not_running' }, 409, 'not_running'],
    [{ ok: false, error: 'follower.permission: bad allow', errorKind: 'bad_request' }, 400, 'bad_request'],
    [{ ok: false, error: 'follower.send: a Walnut server answers', errorKind: 'leader_answers' }, 409, 'leader_answers'],
    [{ ok: false, error: 'follower.send: this host already holds 5000 records', errorKind: 'queue_full' }, 503, 'busy'],
    [{ ok: false, error: 'only the leader sends follower.send', errorKind: 'follower_refused' }, 503, 'daemon_needs_upgrade'],
    [{ ok: false, error: 'closed' }, 502, 'daemon_error'],
  ]
  for (const [reply, status, code] of cases) {
    it(`${String(reply.errorKind ?? 'no kind')} → ${status} ${code}`, async () => {
      answer = () => reply
      const r = await ask('POST', `/_alone/sessions/${SID}/messages`, { body: { text: 'hi' } })
      expect(r.status).toBe(status)
      expect(r.json.error.code).toBe(code)
      // The command name is not part of what a person reads.
      if (code !== 'daemon_needs_upgrade') expect(r.json.error.message).not.toMatch(/^follower\./)
    })
  }

  it('a daemon that does not answer is a 503', async () => {
    const api = createAloneApi({ label: 'devbox', route: () => route, devices, request: async () => { throw new Error('follower.sessions timed out') }, transcript: async () => ({}), log: () => {} })
    const s = http.createServer((req, res) => { void api.handle(req, res) })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/_alone/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })
      expect(r.status).toBe(503)
      expect((await r.json()).error.code).toBe('no_daemon')
    } finally {
      await new Promise<void>((r) => s.close(() => r()))
    }
  })
})
