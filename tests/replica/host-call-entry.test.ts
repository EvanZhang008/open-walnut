/**
 * The host call entry on a host's own Walnut server (replica/host-call-entry.ts), served over real
 * HTTP on its own unix socket (0600 in a 0700 dir) with the daemon's side stood in for: it decides
 * nothing of a call, only whether the line
 * reaches the daemon (`follower.gateway`), whose answer is the call's. A refusal before the line
 * reached the daemon says `entry_unavailable` (the client uses the socket, nothing ran); a line the
 * daemon took whose answer was lost is a hub_timeout answer (it may have run).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { HOST_CALL_CAPABILITY, answerBudgetMs, createHostCallEntry, listenHostCallEntry, type HostCallEntryDeps, type HostCallListener } from '../../src/replica/host-call-entry.js'
import { hostCallSocketPath } from '../../src/providers/host-call-token-core.js'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH, createHostCallClient } from '../../src/providers/host-call-client-core.js'
import { parseGatewayLine } from '../../src/providers/gateway-core.js'
import { notSent } from '../../src/host-server/daemon-link.js'

const TOKEN = 'e'.repeat(64)
const LINE = { v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_update', args: { id: 't1', tags: ['x'] }, callId: 'oc-abcdefgh12' }, waitMs: 30_000 }

type Sent = { cmd: string; params: Record<string, any>; timeoutMs: number }
const listeners: HostCallListener[] = []
const uid = typeof process.getuid === 'function' ? process.getuid() : null
let daemonDir = ''
let n = 0
beforeEach(() => { daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hce-')) })
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((l) => l.close()))
  fs.rmSync(daemonDir, { recursive: true, force: true })
})

/** One request over a unix socket: its status, entry header and JSON body (or text). */
function request(socketPath: string, opts: { method?: string; path?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; entry: string | null; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath, path: opts.path ?? HOST_CALL_PATH, method: opts.method ?? 'POST', agent: false, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        let body: any = b
        try { body = JSON.parse(b) } catch { /* text */ }
        const h = res.headers[HOST_CALL_ANSWER_HEADER]
        resolve({ status: res.statusCode ?? 0, entry: typeof h === 'string' ? h : null, body })
      })
    })
    r.on('error', reject)
    r.end(opts.body ?? '')
  })
}

async function start(over: Partial<HostCallEntryDeps> = {}, reply: (s: Sent) => Promise<Record<string, unknown>> = async () => ({ ok: true, response: { ok: true, result: { done: 1 } } })) {
  const sent: Sent[] = []
  const failures: string[] = []
  const entry = createHostCallEntry({
    request: async (cmd, params, timeoutMs) => { const s = { cmd, params, timeoutMs }; sent.push(s); return reply(s) },
    capabilities: () => [HOST_CALL_CAPABILITY],
    linked: () => true,
    enabled: () => true,
    log: () => {},
    now: () => 1_000,
    ...over,
  })
  const socketPath = hostCallSocketPath(path, crypto, daemonDir, `w${n++}`)
  const l = await listenHostCallEntry(entry, { socketPath, uid, log: () => {} })
  expect(l).not.toBeNull()
  listeners.push(l!)
  const post = async (body: string, auth: string | null = `Bearer ${TOKEN}`, headers: Record<string, string> = {}) =>
    request(socketPath, { body, headers: { ...(auth ? { authorization: auth } : {}), ...headers } })
  return { socketPath, sent, failures, post }
}

describe('host call entry', () => {
  it('listens on a 0600 socket in a 0700 dir of the daemon dir, and takes only a POST to its own path', async () => {
    const { socketPath } = await start()
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true)
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700)
    expect(path.dirname(path.dirname(socketPath))).toBe(path.resolve(daemonDir))
    expect((await request(socketPath, { method: 'GET' })).status).toBe(404)
    expect((await request(socketPath, { path: HOST_CALL_PATH + 'x', body: '{}' })).status).toBe(404)
  })

  it('a request that came through a proxy (any forwarding header) is refused before anything is read or sent', async () => {
    const { sent, post } = await start()
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-host', 'via']) {
      expect(await post(JSON.stringify(LINE), `Bearer ${TOKEN}`, { [h]: '203.0.113.9' }), h).toMatchObject({ status: 403, entry: '1', body: { code: 'forwarded' } })
    }
    expect(sent).toEqual([])
  })

  it('a stale socket a dead follower left is replaced; a dir another may enter is made private; a non-socket at the path is never removed', async () => {
    const entry = createHostCallEntry({ request: async () => ({ ok: true, response: { ok: true, result: {} } }), capabilities: () => [HOST_CALL_CAPABILITY], linked: () => true, enabled: () => true, log: () => {} })
    const p = hostCallSocketPath(path, crypto, daemonDir, 'wstale')
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 })
    fs.chmodSync(path.dirname(p), 0o755)
    // A socket a follower before this one left at the path.
    const old = http.createServer((_req, res) => { res.writeHead(500); res.end() })
    await new Promise<void>((resolve) => old.listen(p, () => resolve()))
    const l = await listenHostCallEntry(entry, { socketPath: p, uid, log: () => {} })
    expect(l).not.toBeNull()
    listeners.push(l!)
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700)
    expect((await request(p, { body: JSON.stringify(LINE), headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    old.close()
    // A regular file at the path: not served, not removed.
    const q = hostCallSocketPath(path, crypto, daemonDir, 'wfile')
    fs.writeFileSync(q, 'keep')
    const warns: string[] = []
    expect(await listenHostCallEntry(entry, { socketPath: q, uid, log: (_l, m, d) => { warns.push(m + ' ' + String(d?.why)) } })).toBeNull()
    expect(fs.readFileSync(q, 'utf8')).toBe('keep')
    expect(warns.join()).toContain('not a socket')
    // A path too long for a unix socket: not served.
    expect(await listenHostCallEntry(entry, { socketPath: path.join(daemonDir, 'x'.repeat(120) + '.sock'), uid, log: () => {} })).toBeNull()
  })

  it('a good token: the line goes to the daemon as it came, with the token and when it came, and the daemon\'s answer is the answer', async () => {
    const { sent, post } = await start()
    const r = await post(JSON.stringify(LINE))
    expect(r).toEqual({ status: 200, entry: '1', body: { ok: true, result: { done: 1 } } })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.cmd).toBe('follower.gateway')
    expect(sent[0]!.params).toEqual({ request: LINE, token: TOKEN, openedAt: 1_000 })
    // The call's own time and a spare, as the socket's gatewayCallPlan gives it.
    expect(sent[0]!.timeoutMs).toBe(answerBudgetMs(30_000))
    expect(answerBudgetMs(undefined)).toBe(20_000 + 15_000)
    expect(answerBudgetMs(999_999)).toBe(180_000 + 15_000)
  })

  it('no token, or not one a daemon gives: 401 before anything is read or sent', async () => {
    const { sent, post } = await start()
    expect(await post(JSON.stringify(LINE), null)).toMatchObject({ status: 401, entry: '1', body: { code: 'no_token' } })
    expect(await post(JSON.stringify(LINE), 'Bearer nothex')).toMatchObject({ status: 401, entry: '1' })
    expect(sent).toEqual([])
  })

  it('a token the daemon did not take: 401 each time, and a caller with its good token is never turned away by them', async () => {
    let good = false
    const { sent, post } = await start({}, async () => (good ? { ok: true, response: { ok: true, result: { done: 1 } } } : { ok: false, error: 'follower.gateway: this token is not the caller\'s', errorKind: 'bad_token' }))
    for (let i = 0; i < 30; i++) expect(await post(JSON.stringify(LINE))).toMatchObject({ status: 401, entry: '1', body: { code: 'token_refused' } })
    good = true
    expect(await post(JSON.stringify(LINE))).toMatchObject({ status: 200, body: { ok: true, result: { done: 1 } } })
    expect(sent).toHaveLength(31)
  })

  it('off, not linked, or a daemon without follower.gateway: entry_unavailable, nothing sent', async () => {
    for (const over of [{ enabled: () => false }, { linked: () => false }, { capabilities: () => ['follower-gateway-v1'] }, { capabilities: () => null }]) {
      const { sent, post } = await start(over)
      const r = await post(JSON.stringify(LINE))
      expect([501, 503]).toContain(r.status)
      expect(r.entry).toBe('1')
      expect(r.body.code).toBe('entry_unavailable')
      expect(sent).toEqual([])
    }
  })

  it('a line the link never sent: entry_unavailable; a daemon refusal before the line ran (draining): entry_unavailable', async () => {
    const a = await start({}, async () => { throw notSent(new Error('not linked to the daemon')) })
    expect(await a.post(JSON.stringify(LINE))).toMatchObject({ status: 503, body: { code: 'entry_unavailable', why: 'no_daemon_link' } })
    const b = await start({}, async () => ({ ok: false, error: 'internal daemon error handling follower.gateway: Daemon is shutting down; retry after reconnecting' }))
    expect(await b.post(JSON.stringify(LINE))).toMatchObject({ status: 503, body: { code: 'entry_unavailable', why: 'daemon_draining' } })
  })

  it('a line the daemon may have taken with no answer back (a timeout, the link closed): hub_timeout, never entry_unavailable', async () => {
    const a = await start({}, async () => { throw new Error('follower.gateway timed out') })
    expect(await a.post(JSON.stringify(LINE))).toMatchObject({ status: 200, entry: '1', body: { ok: false, error: { code: 'hub_timeout' } } })
    const b = await start({}, async () => ({ ok: false, error: 'closed' }))
    expect(await b.post(JSON.stringify(LINE))).toMatchObject({ status: 200, body: { ok: false, error: { code: 'hub_timeout' } } })
  })

  it('a line the socket would refuse gets the socket\'s very answer, and never reaches the daemon', async () => {
    const { sent, post } = await start()
    for (const bad of ['not json', JSON.stringify({ v: 2, op: 'tools.call', sid: 's' }), JSON.stringify({ v: 1, op: 'nope', sid: 's' })]) {
      const r = await post(bad)
      const want = parseGatewayLine(bad)
      expect(want.ok).toBe(false)
      expect(r).toEqual({ status: 200, entry: '1', body: { ok: false, error: (want as { error: unknown }).error } })
    }
    expect(sent).toEqual([])
  })

  it('an approval goes to the daemon socket, where the kernel names its caller: entry_unavailable, nothing sent', async () => {
    const { sent, post } = await start()
    for (const name of ['approval_request', 'approval_consume']) {
      expect(await post(JSON.stringify({ ...LINE, args: { name, args: {}, callId: 'oc-abcdefgh13' } })), name).toMatchObject({ status: 503, entry: '1', body: { code: 'entry_unavailable', why: 'caller_proof_on_socket' } })
    }
    expect(sent).toEqual([])
    await post(JSON.stringify(LINE))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.params).not.toHaveProperty('peerPid')
  })
})

describe('host call client against the entry', () => {
  const client = (socketPath: string) => createHostCallClient({ http, env: { WALNUT_CALL_SOCKET: socketPath, WALNUT_CALL_TOKEN: TOKEN } })

  it('the daemon\'s answer reaches the caller as it is', async () => {
    const { socketPath: url } = await start({}, async () => ({ ok: true, response: { ok: false, error: { code: 'unknown_caller', message: 'session is not tracked by this daemon (a respawn self-heals)' } } }))
    expect(await client(url).post(LINE, 5_000)).toEqual({ kind: 'answer', resp: { ok: false, error: { code: 'unknown_caller', message: 'session is not tracked by this daemon (a respawn self-heals)' } } })
  })

  it('an older daemon, a refused token, the entry off: the caller is told to use the socket (nothing ran)', async () => {
    for (const [over, reply] of [
      [{ capabilities: () => ['follower-gateway-v1'] }, undefined],
      [{}, async () => ({ ok: false, error: 'no', errorKind: 'bad_token' })],
      [{ enabled: () => false }, undefined],
    ] as const) {
      const { socketPath: url } = await start(over, reply)
      expect((await client(url).post(LINE, 5_000)).kind).toBe('not_taken')
    }
  })

  it('a lost answer after the daemon took the line comes back as hub_timeout (the lost-call rules), not as a socket resend', async () => {
    const { socketPath: url } = await start({}, async () => { throw new Error('follower.gateway timed out') })
    const o = await client(url).post(LINE, 5_000)
    expect(o).toMatchObject({ kind: 'answer', resp: { ok: false, error: { code: 'hub_timeout' } } })
  })
})
