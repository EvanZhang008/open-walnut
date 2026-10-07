/**
 * Push routing through the real server: no notification text reaches Expo for a
 * device that is not an Expo device, incidents never reach a phone, and no server
 * log line carries a device token.
 *
 * The production leak took this chain: a turn trips a forensic invariant, the
 * incident asked the general subscriber for a push, and that subscriber posted the
 * iPhone's APNs token, the title and the incident text to exp.host. Incidents no
 * longer push at all. The general subscriber is still driven here, through the
 * server's own bus, because its events can be wired to a producer later; letters
 * are the producer that pushes today and ride the same delivery.
 *
 * Real: the HTTP routes that register tokens, config.yaml, the bus, the incident
 * sink and its store, both push subscribers, the WebSocket count, the log file.
 * Stubbed: the APNs sender at its module boundary, and global `fetch` for every
 * non-loopback URL (Expo gets an ok ticket, anything else a 503), so no request
 * leaves the machine.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('push-routing-e2e'))

const sendApns = vi.hoisted(() => vi.fn(async (targets: unknown[]) => ({
  attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[],
})))
vi.mock('../../src/core/push/apns.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/push/apns.js')>()),
  sendApns,
}))

import { LOG_DIR, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { recordTurn } from '../../src/core/observability/recorder.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { flushLogBufferNow } from '../../src/logging/logger.js'

const APNS_TOKEN = '9a'.repeat(32)
const EXPO_TOKEN = 'ExponentPushToken[acme-old-phone]'
const REPLY = 'Weekly review is ready: 3 tasks moved to Friday.'

interface Outbound { url: string; body: string }
/** Every fetch the process made to anything but loopback. */
const outbound: Outbound[] = []
/** Every non-loopback URL the run tried, kept across tests for the report below. */
const blockedUrls = new Set<string>()
const realFetch = globalThis.fetch

let server: HttpServer
let port: number

function isLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url)
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (isLoopback(url)) return realFetch(input, init)
    const body = typeof init?.body === 'string' ? init.body : ''
    outbound.push({ url, body })
    blockedUrls.add(url.split('?')[0])
    if (url.startsWith('https://exp.host/')) {
      const messages = JSON.parse(body || '[]') as unknown[]
      return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 'ticket' })) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('blocked by the test: no real network', { status: 503 })
  })
}

function expoRequests(): Array<{ to: string[]; raw: string; messages: Array<Record<string, unknown>> }> {
  return outbound
    .filter((o) => o.url.startsWith('https://exp.host/'))
    .map((o) => {
      const messages = JSON.parse(o.body || '[]') as Array<Record<string, unknown>>
      return { to: messages.map((m) => String(m.to)), raw: o.body, messages }
    })
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** Make exactly these devices registered, through the real routes. */
async function useDevices(devices: Array<{ token: string; environment?: string }>): Promise<void> {
  for (const token of [APNS_TOKEN, EXPO_TOKEN]) {
    const res = await api('DELETE', '/api/push/register', { token })
    expect(res.status).toBe(200)
  }
  for (const d of devices) {
    const res = await api('POST', '/api/push/register', { platform: 'ios', ...d })
    expect(res.status).toBe(200)
  }
  const status = await api('GET', '/api/push/status')
  expect(status.json.count).toBe(devices.length)
}

const BOTH_DEVICES = [{ token: APNS_TOKEN, environment: 'production' }, { token: EXPO_TOKEN }]

/** A finished turn that trips `empty-success`, exactly as the session runner records it. */
function tripIncident(sessionId: string): void {
  recordTurn({ sessionId, isError: false, subtype: 'success', resultLen: 0, stopReason: 'end_turn' })
}

/** A background agent reply, put on the server's own bus for the general subscriber. */
function emitAgentReply(): void {
  bus.emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron', agentId: 'general' } as never, ['push-notifications'], { source: 'test' })
}

/** Wait until both transports have been quiet for a while (fire-and-forget handlers). */
async function settle(minMs = 300): Promise<void> {
  const count = (): number => outbound.length + sendApns.mock.calls.length
  const start = Date.now()
  let seen = -1
  while (Date.now() - start < minMs || seen !== count()) {
    seen = count()
    await new Promise((r) => setTimeout(r, 100))
    if (Date.now() - start > 15_000) break
  }
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  stubFetch()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  // Evidence that nothing reached the network: every outbound URL was answered by the stub.
  console.log(`[push-routing-e2e] stubbed outbound URLs: ${JSON.stringify([...blockedUrls])}`)
  await stopServer()
  vi.unstubAllGlobals()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await settle(100)
  outbound.length = 0
  sendApns.mockClear()
})

describe('device registration', () => {
  it('registers one native APNs device and one legacy Expo device through the real route', async () => {
    const apns = await api('POST', '/api/push/register', { token: APNS_TOKEN, platform: 'ios', environment: 'production' })
    expect(apns.status).toBe(200)
    expect(apns.json).toMatchObject({ ok: true, kind: 'apns' })
    const expo = await api('POST', '/api/push/register', { token: EXPO_TOKEN, platform: 'ios' })
    expect(expo.status).toBe(200)
    expect(expo.json).toMatchObject({ ok: true, kind: 'expo' })
    const status = await api('GET', '/api/push/status')
    expect(status.json.count).toBe(2)
  })
})

describe('a forensic incident', () => {
  it('is recorded for the console and pushes nothing to either service', async () => {
    await useDevices(BOTH_DEVICES)
    tripIncident('e2e-incident-sid-1')
    await vi.waitFor(async () => {
      const list = await api('GET', '/api/incidents')
      expect((list.json.incidents as Array<{ sessionId: string }>).map((i) => i.sessionId)).toContain('e2e-incident-sid-1')
    }, { timeout: 15_000, interval: 100 })
    // The rest of the sink (the evidence bundle) runs after the store write.
    await settle(1_500)
    expect(sendApns).not.toHaveBeenCalled()
    expect(outbound).toEqual([])
  })
})

describe('a general notification while no client is watching', () => {
  it('reaches the APNs device through Apple and the Expo device through Expo, once each', async () => {
    await useDevices(BOTH_DEVICES)
    emitAgentReply()
    await vi.waitFor(() => expect(outbound.length + sendApns.mock.calls.length).toBeGreaterThan(1), { timeout: 15_000, interval: 50 })
    await settle()

    // The leak: no request to any third party carries the APNs token.
    for (const o of outbound) expect(o.body).not.toContain(APNS_TOKEN)
    expect(sendApns).toHaveBeenCalledTimes(1)
    const [targets, payload] = sendApns.mock.calls[0] as unknown as [Array<{ token: string }>, Record<string, any>]
    expect(targets.map((t) => t.token)).toEqual([APNS_TOKEN])
    expect(payload.aps.alert).toEqual({ title: 'Walnut', body: REPLY })

    const expo = expoRequests()
    expect(expo).toHaveLength(1)
    expect(expo[0].to).toEqual([EXPO_TOKEN])
    expect(expo[0].messages[0]).toMatchObject({ title: 'Walnut', body: REPLY })
  })

  it('with only the APNs device left, no request goes to exp.host at all', async () => {
    await useDevices([{ token: APNS_TOKEN, environment: 'production' }])
    emitAgentReply()
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 50 })
    await settle()

    expect(expoRequests()).toEqual([])
    for (const o of outbound) {
      expect(o.body).not.toContain(APNS_TOKEN)
      expect(o.body).not.toContain(REPLY)
    }
    expect((sendApns.mock.calls[0] as unknown as [Array<{ token: string }>])[0].map((t) => t.token)).toEqual([APNS_TOKEN])
  })
})

describe('letters take the same delivery, and only their own path', () => {
  it('a letter reaches each device once, by its service, and the general subscriber adds nothing', async () => {
    await useDevices(BOTH_DEVICES)
    const sent = await api('POST', '/api/v1/human-inbox', {
      subject: 'Migration window decided', type: 'review', markdown: 'The window moved to Friday.',
    })
    expect(sent.status).toBe(201)
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 50 })
    await settle()

    expect(sendApns).toHaveBeenCalledTimes(1)
    const [targets, payload] = sendApns.mock.calls[0] as unknown as [Array<{ token: string }>, Record<string, any>]
    expect(targets.map((t) => t.token)).toEqual([APNS_TOKEN])
    expect(payload.type).toBe('human_inbox_letter')
    const expo = expoRequests()
    expect(expo).toHaveLength(1)
    expect(expo[0].to).toEqual([EXPO_TOKEN])
    expect(expo[0].raw).not.toContain(APNS_TOKEN)
  })
})

describe('while a web client is watching', () => {
  it('a general notification is skipped on both services, and a letter still pushes', async () => {
    await useDevices(BOTH_DEVICES)
    const ws = await connectWs()
    try {
      emitAgentReply()
      await settle(1_000)
      expect(sendApns).not.toHaveBeenCalled()
      expect(expoRequests()).toEqual([])

      const sent = await api('POST', '/api/v1/human-inbox', {
        subject: 'Review ready', type: 'review', markdown: 'One file changed.',
      })
      expect(sent.status).toBe(201)
      await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 50 })
      await settle()
      expect(sendApns).toHaveBeenCalledTimes(1)
      expect((sendApns.mock.calls[0] as unknown as [unknown, Record<string, any>])[1].type).toBe('human_inbox_letter')
      expect(expoRequests()).toHaveLength(1)
    } finally {
      ws.close()
    }
  })
})

describe('the server log', () => {
  it('never carries a device token, or the slice of one the old log lines printed', async () => {
    await flushLogBufferNow(5_000)
    const files = (await fs.readdir(LOG_DIR)).filter((f) => f.endsWith('.log'))
    expect(files.length).toBeGreaterThan(0)
    const text = (await Promise.all(files.map((f) => fs.readFile(`${LOG_DIR}/${f}`, 'utf-8')))).join('\n')
    // Registration and delivery really logged, so the absence below means something.
    expect(text).toContain('push: token registered')
    expect(text).toContain('letter push')
    for (const piece of [APNS_TOKEN, APNS_TOKEN.slice(0, 12), EXPO_TOKEN, 'acme-old-phone']) {
      expect(text, `log leaks ${piece}`).not.toContain(piece)
    }
  })
})
