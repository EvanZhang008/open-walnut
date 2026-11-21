/**
 * The host call entry on a host's own Walnut server (replica/host-call-entry.ts), served over real
 * HTTP with the daemon's side stood in for: it decides nothing of a call, only whether the line
 * reaches the daemon (`follower.gateway`), whose answer is the call's. A refusal before the line
 * reached the daemon says `entry_unavailable` (the client uses the socket, nothing ran); a line the
 * daemon took whose answer was lost is a hub_timeout answer (it may have run).
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HOST_CALL_CAPABILITY, answerBudgetMs, createHostCallEntry, type HostCallEntryDeps } from '../../src/replica/host-call-entry.js'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH, createHostCallClient } from '../../src/providers/host-call-client-core.js'
import { parseGatewayLine } from '../../src/providers/gateway-core.js'
import { notSent } from '../../src/host-server/daemon-link.js'

const TOKEN = 'e'.repeat(64)
const LINE = { v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_update', args: { id: 't1', tags: ['x'] }, callId: 'oc-abcdefgh12' }, waitMs: 30_000 }

type Sent = { cmd: string; params: Record<string, any>; timeoutMs: number }
const servers: http.Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(null)) }))) })

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
    limiter: { limited: () => failures.length >= 3, failed: (_k, t) => { failures.push(t) } },
    ...over,
  })
  const server = http.createServer((req, res) => {
    if (entry.takes(req)) { void entry.handle(req, res); return }
    res.writeHead(404); res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${HOST_CALL_PATH}`
  const post = async (body: string, auth: string | null = `Bearer ${TOKEN}`) => {
    const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) } })
    return { status: r.status, entry: r.headers.get(HOST_CALL_ANSWER_HEADER), body: await r.json() as Record<string, any> }
  }
  return { url, sent, failures, post }
}

describe('host call entry', () => {
  it('takes only a POST to its own path', async () => {
    const { url } = await start()
    expect((await fetch(url, { method: 'GET' })).status).toBe(404)
    expect((await fetch(url + 'x', { method: 'POST', body: '{}' })).status).toBe(404)
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

  it('a token the daemon did not take: 401, counted in the entry\'s own bucket, 429 once it is full', async () => {
    const { failures, post } = await start({}, async () => ({ ok: false, error: 'follower.gateway: this token is not the caller\'s', errorKind: 'bad_token' }))
    expect(await post(JSON.stringify(LINE))).toMatchObject({ status: 401, entry: '1', body: { code: 'token_refused' } })
    await post(JSON.stringify(LINE)); await post(JSON.stringify(LINE))
    expect(failures).toHaveLength(3)
    expect(await post(JSON.stringify(LINE))).toMatchObject({ status: 429, entry: '1' })
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

  it('an approval names the process on the connection for the daemon\'s caller proof; other calls look none up', async () => {
    let looked = 0
    const { sent, post } = await start({ peerPid: async () => { looked++; return 4242 } })
    await post(JSON.stringify({ ...LINE, args: { name: 'approval_request', args: {}, callId: 'oc-abcdefgh13' } }))
    await post(JSON.stringify(LINE))
    expect(looked).toBe(1)
    expect(sent[0]!.params.peerPid).toBe(4242)
    expect(sent[1]!.params).not.toHaveProperty('peerPid')
  })
})

describe('host call client against the entry', () => {
  const client = (url: string) => createHostCallClient({ http, env: { WALNUT_CALL_URL: url, WALNUT_CALL_TOKEN: TOKEN } })

  it('the daemon\'s answer reaches the caller as it is', async () => {
    const { url } = await start({}, async () => ({ ok: true, response: { ok: false, error: { code: 'unknown_caller', message: 'session is not tracked by this daemon (a respawn self-heals)' } } }))
    expect(await client(url).post(LINE, 5_000)).toEqual({ kind: 'answer', resp: { ok: false, error: { code: 'unknown_caller', message: 'session is not tracked by this daemon (a respawn self-heals)' } } })
  })

  it('an older daemon, a refused token, the entry off: the caller is told to use the socket (nothing ran)', async () => {
    for (const [over, reply] of [
      [{ capabilities: () => ['follower-gateway-v1'] }, undefined],
      [{}, async () => ({ ok: false, error: 'no', errorKind: 'bad_token' })],
      [{ enabled: () => false }, undefined],
    ] as const) {
      const { url } = await start(over, reply)
      expect((await client(url).post(LINE, 5_000)).kind).toBe('not_taken')
    }
  })

  it('a lost answer after the daemon took the line comes back as hub_timeout (the lost-call rules), not as a socket resend', async () => {
    const { url } = await start({}, async () => { throw new Error('follower.gateway timed out') })
    const o = await client(url).post(LINE, 5_000)
    expect(o).toMatchObject({ kind: 'answer', resp: { ok: false, error: { code: 'hub_timeout' } } })
  })
})
