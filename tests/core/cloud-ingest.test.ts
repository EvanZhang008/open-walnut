/**
 * Mac side of POST /bridge/ingest (src/core/cloud-ingest.ts), against a real
 * loopback HTTP server standing in for the replica:
 *   - the URL derived from a bridge URL;
 *   - what each answer means: 2xx sent; 404/405/401/403 'unsupported' (the
 *     caller takes the bridge, and the lane rests); 5xx, a timeout or a refused
 *     connection 'failed' (NO bridge retry: the failure this lane exists for is
 *     upload bytes damaged in transit, and the bridge must not carry them);
 *   - the body is gzip'd `{kind, data}`, with the bearer machine token;
 *   - latest-wins serialization per key;
 *   - an ingest whose connection broke under it (a reset, or a TLS error: what
 *     damaged upload bytes look like) goes again on a fresh one, at most twice
 *     more; a refused connection or a deadline does not;
 *   - the replica lane's retries when a connection breaks before any answer
 *     (a pooled keep-alive socket closed under the next step, a big body lost
 *     on the way): at most two more, never after a deadline;
 *   - the documented limits: 2 requests in flight, a request deadline, a
 *     10-minute rest after a refusal that ENDS (the lane is tried again), one
 *     endpoint lookup shared by concurrent cold pushes, and no queued request
 *     sent after a refusal (each would be an auth strike on the Mac's IP).
 * Only the endpoint lookup (the bridge's own config: URL + machine token) is stubbed.
 */
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloud-ingest'))

// What the local daemon's bridge is configured with: the lane derives from it.
let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
let cfgCalls = 0
let cfgDelayMs = 0
let recoveredToken: string | null = null
let recoverCalls = 0
vi.mock('../../src/integrations/git-sync.js', () => ({
  getCloudRemoteCredentialsAsync: async () => ({ domain: 'companion.example', token: 'owner-token', secure: true }),
}))
vi.mock('../../src/integrations/cloud-bridge-config.js', () => ({
  recoverMachineToken: async (_host: string, deadToken: string) => {
    recoverCalls++
    if (recoveredToken && bridgeCfg.token === deadToken) bridgeCfg.token = recoveredToken
    return recoveredToken ? 'reminted' : 'failed'
  },
  getBridgeConfigForHost: async () => {
    cfgCalls++
    if (cfgDelayMs) await new Promise((r) => setTimeout(r, cfgDelayMs))
    return bridgeCfg
  },
}))
// Loaded once up front: under vitest, CONCURRENT first dynamic imports of a
// mocked module can resolve to the real one.
import { getBridgeConfigForHost as warmMock } from '../../src/integrations/cloud-bridge-config.js'
void warmMock

import {
  ingestUrlFromBridgeUrl, postToCloudIngest, runLatestPerKey, cloudIngestResting, _resetCloudIngestForTesting,
  postToCloudReplica, cloudReplicaAvailable, postToCloudSessionSend, postToCloudSessionPermission,
} from '../../src/core/cloud-ingest.js'

let status = 200
let responseBody: string | null = null
/** Answer with an HTML page (an app shell) instead of JSON. */
let htmlBody = false
/** 'hold': keep the answer until the test releases it; 'hang': never answer. */
let answerMode: 'now' | 'hold' | 'hang' = 'now'
/** The next N requests have their socket reset once the body is read, with no answer. */
let resets = 0
const held: Array<() => void> = []
let open = 0
let maxOpen = 0
const seen: Array<{ url: string; auth: string | undefined; encoding: string | undefined; body: unknown }> = []
const replica = http.createServer((req, res) => {
  open++
  maxOpen = Math.max(maxOpen, open)
  res.on('close', () => { open-- })
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    const text = req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8')
    seen.push({ url: req.url ?? '', auth: req.headers.authorization, encoding: req.headers['content-encoding'], body: JSON.parse(text) })
    const code = status
    const answer = (): void => {
      if (htmlBody) { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>app</title>'); return }
      res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(responseBody ?? (code < 300 ? '{"ok":true,"need":["t1"]}' : '{"error":"x"}'))
    }
    if (resets > 0) { resets--; req.socket.resetAndDestroy(); return }
    if (answerMode === 'hang') return
    if (answerMode === 'hold') { held.push(answer); return }
    answer()
  })
})
let port = 0

beforeAll(async () => {
  await new Promise<void>((r) => replica.listen(0, '127.0.0.1', r))
  port = (replica.address() as AddressInfo).port
})
afterAll(async () => {
  replica.closeAllConnections() // fetch keeps its sockets alive; close() would wait on them
  await new Promise<void>((r) => replica.close(() => r()))
})
afterEach(() => {
  vi.useRealTimers()
  replica.closeAllConnections() // a hung or held request must not leak into the next case
  _resetCloudIngestForTesting()
  seen.length = 0; held.length = 0; status = 200; answerMode = 'now'; open = 0; maxOpen = 0; htmlBody = false; resets = 0
  bridgeCfg = { enabled: false }; cfgCalls = 0; cfgDelayMs = 0; responseBody = null; recoveredToken = null; recoverCalls = 0
})
const tail = (sid: string): string => JSON.stringify({ sid, data: { version: 1, sessionId: sid, exportedAt: 'z', truncated: false, messages: [] } })
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

const point = (): void => { bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: 'machine-token-local' } }

describe('postToCloudSessionSend', () => {
  const line = { host: 'devbox', sessionId: 'session-a', message: 'notice', uuid: 'aaaaaaaa-1111-4111-8111-111111111111', markers: [{ message: 'notice', messageId: 'sn-child-stopped' }], stopFence: null }

  it('uses the companion send endpoint and preserves the host reply', async () => {
    point()
    responseBody = '{"ok":true,"duplicate":true,"fate":"ran"}'
    expect(await postToCloudSessionSend(line)).toEqual({ ok: true, duplicate: true, fate: 'ran' })
    expect(seen[0]).toMatchObject({ url: '/bridge/send', auth: 'Bearer machine-token-local', body: line })
  })

  it('forgets a refused machine token, so the next send resolves its current credential', async () => {
    point()
    status = 401
    recoveredToken = 'replacement-machine-token'
    expect(await postToCloudSessionSend(line)).toBeNull()
    await until(() => recoverCalls === 1)
    expect(recoverCalls).toBe(1)
    expect(seen).toHaveLength(1)
    status = 200
    expect(await postToCloudSessionSend(line)).toMatchObject({ ok: true })
    expect(seen[1].auth).toBe('Bearer replacement-machine-token')
  })

  it('uses only the narrow companion permission endpoint for a tool answer', async () => {
    point()
    const answer = { host: 'devbox', sessionId: 'session-a', requestId: 'permission-a', allow: false, message: 'Not now' }
    expect(await postToCloudSessionPermission(answer)).toMatchObject({ ok: true })
    expect(seen[0]).toMatchObject({ url: '/bridge/send/permission', body: answer })
  })

  it('a no-send answer is held while an unanswered request remains unconfirmed', async () => {
    point()
    status = 503
    responseBody = '{"error":"host_unavailable","sent":false}'
    expect(await postToCloudSessionSend(line)).toBeNull()
    responseBody = '{"error":"delivery_unconfirmed","sent":true}'
    await expect(postToCloudSessionSend(line)).rejects.toMatchObject({ name: 'SendOutcomeUnknownError' })
    resets = 1
    await expect(postToCloudSessionSend(line)).rejects.toMatchObject({ name: 'SendOutcomeUnknownError' })
    expect(seen).toHaveLength(3)
  })
})

describe('ingestUrlFromBridgeUrl', () => {
  it.each([
    ['wss://box.example/bridge', 'https://box.example/bridge/ingest'],
    ['ws://127.0.0.1:9/bridge/', 'http://127.0.0.1:9/bridge/ingest'],
    ['wss://box.example/prefix/bridge?x=1', 'https://box.example/prefix/bridge/ingest'],
    ['wss://box.example/elsewhere', 'https://box.example/bridge/ingest'],
  ])('%s -> %s', (from, to) => { expect(ingestUrlFromBridgeUrl(from)).toBe(to) })

  it('refuses what is not a ws/http URL', () => {
    expect(ingestUrlFromBridgeUrl('not a url')).toBeNull()
    expect(ingestUrlFromBridgeUrl('ftp://box.example/bridge')).toBeNull()
  })
})

describe('postToCloudIngest', () => {
  it('sends gzip {kind,data} with the machine token and answers sent', async () => {
    point()
    const data = JSON.stringify({ which: 'tasks', data: { version: 2, exportedAt: 'z', tasks: [] } })
    expect(await postToCloudIngest('projection-upsert', data)).toBe('sent')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      url: '/bridge/ingest', auth: 'Bearer machine-token-local', encoding: 'gzip',
      body: { kind: 'projection-upsert', data: { which: 'tasks', data: { version: 2, tasks: [] } } },
    })
  })

  it.each([404, 405, 401, 403])('%i means this replica cannot take it: unsupported, and the lane rests', async (code) => {
    point()
    status = code
    expect(await postToCloudIngest('transcript-upsert', '{"sid":"s1","data":{}}')).toBe('unsupported')
    expect(cloudIngestResting()).toBe(true)
    // Resting: the next push goes straight to the bridge without a request.
    expect(await postToCloudIngest('transcript-upsert', '{"sid":"s1","data":{}}')).toBe('unsupported')
    expect(seen).toHaveLength(1)
  })

  it.each([500, 502, 429])('%i is a failure, never a reason to use the bridge', async (code) => {
    point()
    status = code
    expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('failed')
    expect(cloudIngestResting()).toBe(false)
  })

  it('a refused connection is a failure, and the lane stays on for the next try', async () => {
    const dead = http.createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
    const deadPort = (dead.address() as AddressInfo).port
    await new Promise<void>((r) => dead.close(() => r()))
    bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${deadPort}/bridge`, token: 'machine-token-local' }
    expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('failed')
    expect(cloudIngestResting()).toBe(false)
  })

  it('a connection that breaks under the upload goes again on a fresh one, with the same bytes', async () => {
    _resetCloudIngestForTesting({ stepRetryMs: [20, 40] })
    point()
    resets = 1
    expect(await postToCloudIngest('transcript-upsert', tail('broken-once'))).toBe('sent')
    expect(seen).toHaveLength(2)
    expect(seen[1]?.body).toEqual(seen[0]?.body)
  })

  it('a TLS failure (what damaged upload bytes look like) is tried at most twice more, then failed', async () => {
    // A server that answers a TLS ClientHello with plain bytes: bun's fetch says
    // EPROTO "The TLS handshake failed", the error a companion's bad_record_mac
    // alert produces in the field; Node's names an ERR_SSL_* cause.
    _resetCloudIngestForTesting({ stepRetryMs: [20, 40] })
    let conns = 0
    const notTls = net.createServer((c) => { conns++; c.once('data', () => c.end('HTTP/1.1 400 Bad Request\r\n\r\n')) })
    await new Promise<void>((r) => notTls.listen(0, '127.0.0.1', r))
    try {
      bridgeCfg = { enabled: true, url: `wss://127.0.0.1:${(notTls.address() as AddressInfo).port}/bridge`, token: 'machine-token-local' }
      expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('failed')
      expect(conns).toBe(3)
      expect(cloudIngestResting()).toBe(false)
    } finally {
      await new Promise<void>((r) => notTls.close(() => r()))
    }
  })

  it('a refused connection and a deadline are not tried again on this lane (the sweep retries)', async () => {
    _resetCloudIngestForTesting({ stepRetryMs: [5_000, 5_000] })
    const dead = http.createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
    const deadPort = (dead.address() as AddressInfo).port
    await new Promise<void>((r) => dead.close(() => r()))
    bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${deadPort}/bridge`, token: 'machine-token-local' }
    const t0 = Date.now()
    expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('failed')
    expect(Date.now() - t0).toBeLessThan(3_000) // never the 5 s retry wait

    _resetCloudIngestForTesting({ timeoutMs: 300, stepRetryMs: [20, 40] })
    point()
    answerMode = 'hang'
    expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('failed')
    expect(seen).toHaveLength(1)
  })

  it('no companion configured (or the bridge turned off): unsupported without a request', async () => {
    bridgeCfg = { enabled: false }
    expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('unsupported')
    expect(seen).toHaveLength(0)
    expect(cloudIngestResting()).toBe(false)
  })
})

describe('the documented limits', () => {
  it('a refusal with a burst queued: only the requests already in flight reach the replica', async () => {
    // Gate finding F3: with the rest checked only before the slot wait, 12
    // queued pushes after a stale token put 11 wrong-token strikes on the Mac's IP.
    point()
    expect(await postToCloudIngest('transcript-upsert', tail('warm'))).toBe('sent')
    seen.length = 0
    status = 401
    const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => postToCloudIngest('transcript-upsert', tail(`b${i}`))))
    expect(outs.every((o) => o === 'unsupported')).toBe(true)
    expect(seen.length).toBeLessThanOrEqual(2)
    expect(cloudIngestResting()).toBe(true)
  })

  it('at most 2 requests in flight at once, across keys', async () => {
    point()
    expect(await postToCloudIngest('transcript-upsert', tail('warm'))).toBe('sent')
    seen.length = 0; maxOpen = 0
    answerMode = 'hold'
    const ps = Array.from({ length: 6 }, (_, i) => postToCloudIngest('transcript-upsert', tail(`k${i}`)))
    await until(() => seen.length >= 2)
    await new Promise((r) => setTimeout(r, 200))
    expect(seen).toHaveLength(2)
    for (let i = 0; i < 300 && (seen.length < 6 || held.length); i++) {
      held.shift()?.()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect((await Promise.all(ps)).every((o) => o === 'sent')).toBe(true)
    expect(seen).toHaveLength(6)
    expect(maxOpen).toBeLessThanOrEqual(2)
  })

  it('a replica that takes the body and never answers is a failure at the deadline', async () => {
    _resetCloudIngestForTesting({ timeoutMs: 300 })
    point()
    answerMode = 'hang'
    const t0 = Date.now()
    expect(await postToCloudIngest('projection-upsert', '{"which":"sessions","data":{}}')).toBe('failed')
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(cloudIngestResting()).toBe(false)
  })

  it('the rest after a refusal ends: at 9m59s still no request, past 10 minutes the lane is tried again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    point()
    status = 404
    expect(await postToCloudIngest('projection-upsert', '{"which":"tasks","data":{}}')).toBe('unsupported')
    vi.setSystemTime(Date.now() + 9 * 60_000 + 59_000)
    expect(await postToCloudIngest('projection-upsert', '{"which":"tasks","data":{}}')).toBe('unsupported')
    expect(seen).toHaveLength(1)
    status = 200
    vi.setSystemTime(Date.now() + 2_000)
    expect(cloudIngestResting()).toBe(false)
    expect(await postToCloudIngest('projection-upsert', '{"which":"tasks","data":{}}')).toBe('sent')
    expect(seen).toHaveLength(2)
  })

  it('concurrent cold pushes share ONE endpoint lookup (a lookup can mint the machine token)', async () => {
    point()
    cfgCalls = 0
    cfgDelayMs = 50
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => postToCloudIngest('transcript-upsert', tail(`c${i}`))))
    expect(outs.every((o) => o === 'sent')).toBe(true)
    expect(cfgCalls).toBe(1)
  })

  it('after a refused token rests the lane, the next try looks the token up again (a re-mint is picked up)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    point()
    expect(await postToCloudIngest('transcript-upsert', tail('warm'))).toBe('sent')
    status = 401
    expect(await postToCloudIngest('transcript-upsert', tail('stale'))).toBe('unsupported')
    const before = cfgCalls
    bridgeCfg = { ...bridgeCfg, token: 'machine-token-reminted' }
    status = 200
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000)
    expect(await postToCloudIngest('transcript-upsert', tail('fresh'))).toBe('sent')
    expect(cfgCalls).toBe(before + 1)
    expect(seen.at(-1)?.auth).toBe('Bearer machine-token-reminted')
  })
})

describe('postToCloudReplica (the companion\'s task copy, beside ingest)', () => {
  it('posts gzip JSON to /bridge/replica with the machine token and returns the answer', async () => {
    point()
    expect(await cloudReplicaAvailable()).toBe(true)
    const r = await postToCloudReplica({ op: 'sync', kind: 'tasks', entries: [] })
    expect(r).toEqual({ ok: true, reply: { ok: true, need: ['t1'] } })
    expect(seen[0]).toMatchObject({ url: '/bridge/replica', auth: 'Bearer machine-token-local', encoding: 'gzip', body: { op: 'sync', kind: 'tasks' } })
  })

  it.each([
    ['a 404', 404, false],
    ['an app shell (HTML 200) for an unknown path', 200, true],
  ] as const)('%s: an older companion; the replica lane rests, the ingest lane does not', async (_label, code, html) => {
    point()
    status = code
    htmlBody = html
    expect(await postToCloudReplica({ op: 'sync' })).toMatchObject({ ok: false, outcome: 'unsupported' })
    expect(await cloudReplicaAvailable()).toBe(false)
    expect(cloudIngestResting()).toBe(false)
    htmlBody = false
    status = 200
    expect(await postToCloudIngest('transcript-upsert', '{"sid":"s1","data":{}}')).toBe('sent')
  })

  it('a refused token rests both lanes; a 5xx is a failure and rests nothing', async () => {
    point()
    status = 500
    expect(await postToCloudReplica({ op: 'sync' })).toMatchObject({ ok: false, outcome: 'failed', status: 500 })
    expect(await cloudReplicaAvailable()).toBe(true)
    status = 401
    expect(await postToCloudReplica({ op: 'sync' })).toMatchObject({ ok: false, outcome: 'unsupported', status: 401 })
    expect(cloudIngestResting()).toBe(true)
  })

  it('a connection that breaks before any answer is tried again on a fresh one, at most twice more', async () => {
    _resetCloudIngestForTesting({ stepRetryMs: [20, 40] })
    point()
    resets = 1
    expect(await postToCloudReplica({ op: 'sync', kind: 'tasks', entries: [] })).toEqual({ ok: true, reply: { ok: true, need: ['t1'] } })
    expect(seen).toHaveLength(2) // the same step, twice
    expect(seen[1]?.body).toEqual(seen[0]?.body)
    seen.length = 0
    resets = 2
    expect(await postToCloudReplica({ op: 'sync', kind: 'tasks', entries: [] })).toEqual({ ok: true, reply: { ok: true, need: ['t1'] } })
    expect(seen).toHaveLength(3)
    seen.length = 0
    resets = 3
    const r = await postToCloudReplica({ op: 'sync' })
    expect(r).toMatchObject({ ok: false, outcome: 'failed' })
    // The code rides along: Node's fetch alone says only "fetch failed" (the code is
    // on its cause), bun's names it in its message.
    expect(r.ok ? '' : r.error).toMatch(/ECONNRESET|EPIPE|UND_ERR_SOCKET/)
    expect(seen).toHaveLength(3) // never a fourth
    expect(await cloudReplicaAvailable()).toBe(true) // a failure rests nothing
  })

  it('the waits: none before the first retry after a socket reset, the second wait before the next', async () => {
    _resetCloudIngestForTesting({ stepRetryMs: [5_000, 400] })
    point()
    resets = 2
    const t0 = Date.now()
    expect(await postToCloudReplica({ op: 'sync' })).toMatchObject({ ok: true })
    const took = Date.now() - t0
    expect(seen).toHaveLength(3)
    expect(took).toBeGreaterThanOrEqual(380)
    expect(took).toBeLessThan(3_000) // never the 5 s first wait: the reset went again at once
  })

  it('a deadline is not retried', async () => {
    _resetCloudIngestForTesting({ timeoutMs: 300 })
    point()
    answerMode = 'hang'
    expect(await postToCloudReplica({ op: 'sync' })).toMatchObject({ ok: false, outcome: 'failed' })
    expect(seen).toHaveLength(1)
  })

  it('no companion set up: not available, and nothing is sent', async () => {
    expect(await cloudReplicaAvailable()).toBe(false)
    expect(await postToCloudReplica({ op: 'sync' })).toMatchObject({ ok: false, outcome: 'unsupported' })
    expect(seen).toHaveLength(0)
  })
})

describe('runLatestPerKey', () => {
  it('runs one at a time per key; while one runs only the newest waiter is sent, and joiners share its result', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = runLatestPerKey('k', async () => { order.push('v1'); await gate; return 'r1' })
    const second = runLatestPerKey('k', async () => { order.push('v2'); return 'r2' })
    const third = runLatestPerKey('k', async () => { order.push('v3'); return 'r3' })
    const other = runLatestPerKey('other', async () => { order.push('o1'); return 'o' })
    expect(await other).toBe('o')
    release()
    expect(await first).toBe('r1')
    expect(await second).toBe('r3')
    expect(await third).toBe('r3')
    expect(order).toEqual(['v1', 'o1', 'v3'])
  })

  it('a rejected run does not wedge the key', async () => {
    await expect(runLatestPerKey('k2', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await runLatestPerKey('k2', async () => 'ok')).toBe('ok')
  })
})
