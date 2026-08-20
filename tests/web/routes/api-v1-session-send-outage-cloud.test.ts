/**
 * Phone sends must survive a bridge outage LONGER than the client's patience.
 *
 * Incident this pins (2026-08-20): a ~7-minute `__local__` bridge outage (Wi-Fi
 * loss → dial timeout → exponential redial backoff) while a healthy remote-host
 * session kept streaming to the phone. The user's send died twice at the app's
 * own 30s URLSession timeout and settled on the red "Not sent — tap to retry"
 * — the exact "not the connection, just delivery failed… but it IS streaming"
 * report. Two structural gaps, both covered here:
 *
 *  1. Durability began one hop too late. The `session.message` relay is
 *     exactly-once by messageId, but only AFTER it reached the primary. With no
 *     bridge socket the route answered 503 having stored NOTHING, so the ONLY
 *     thing covering the window was the client's 120s ladder — and a real outage
 *     is not bounded by 120s. Now the replica banks the send (core/send-queue.ts)
 *     and answers 202, draining on bridge reconnect.
 *  2. The route could take longer to answer than the client would wait. The
 *     relay gets 50s; the phone gives up at 30s and does not auto-retry a
 *     timed-out POST. A budget the client won't wait for is not a budget — the
 *     route now answers inside SEND_ANSWER_DEADLINE_MS and banks the remainder.
 *
 * Real startServer({ port: 0 }) in CLOUD_MODE with the bridge mocked at its
 * module seam (the daemon lives on another machine).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-send-outage', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
let bridgeConnected = true
/** Handlers registered by core/send-queue.ts via addPrimaryBridgeConnectedHandler. */
const primaryConnectedHandlers = new Set<() => void>()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: bridgeConnected }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
  setPrimaryBridgeConnectedHandler: () => {},
  addPrimaryBridgeConnectedHandler: (h: () => void) => {
    primaryConnectedHandlers.add(h)
    return () => primaryConnectedHandlers.delete(h)
  },
}))

import { WALNUT_HOME, SEND_QUEUE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { queuedSessionSendCount, flushSendQueue } from '../../../src/core/send-queue.js'

let server: HttpServer
let port: number
let deviceToken: string

const SID = 'outage-sid-0001'
const HOST = 'devbox'

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

async function postMessage(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${port}/api/v1/sessions/${SID}/messages`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  })
}

/** Every bridge RPC rejects exactly as it does with no socket registered. */
function bridgeDown(): void {
  bridgeConnected = false
  bridgeRequestMock.mockImplementation(async (host: string) => { throw new BridgeOfflineError(host) })
}

/** Bridge back up: session.message relays into the primary's durable queue. */
function bridgeUp(seen?: Array<Record<string, unknown>>): void {
  bridgeConnected = true
  bridgeRequestMock.mockImplementation(async (_host: string, cmd: string, params: Record<string, unknown> = {}) => {
    if (cmd === 'session.message') {
      seen?.push(params)
      return { ok: true, result: { messageId: params.messageId } }
    }
    return { ok: true }
  })
}

async function bankedFiles(): Promise<Array<Record<string, unknown>>> {
  let names: string[]
  try {
    names = (await fs.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const out: Array<Record<string, unknown>> = []
  for (const n of names) {
    out.push(JSON.parse(await fs.readFile(path.join(SEND_QUEUE_DIR, n), 'utf-8')))
  }
  return out
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  await fs.mkdir(path.join(WALNUT_HOME, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [{
      id: SID, host: HOST, process_status: 'running',
      started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
      message_count: 1, cwd: '/home/user/repo',
    }],
  }))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  deviceToken = (await createDevice('outage-test-phone')).token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  bridgeRequestMock.mockReset()
  bridgeConnected = true
  await fs.rm(SEND_QUEUE_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('phone send during a bridge outage (CLOUD_MODE)', () => {
  it('banks the send and answers 202 instead of 503 — no bridge, nothing lost', async () => {
    bridgeDown()
    const res = await postMessage({ text: 'ship it', messageId: 'qm-mobile-aaaabbbbcccc' })
    expect(res.status).toBe(202)
    const body = await res.json() as Record<string, unknown>
    // The phone keeps ITS id, so a later retry still dedupes end to end.
    expect(body.messageId).toBe('qm-mobile-aaaabbbbcccc')
    expect(body.queued).toBe(true)

    const banked = await bankedFiles()
    expect(banked).toHaveLength(1)
    expect(banked[0]).toMatchObject({
      sessionId: SID, host: HOST, message: 'ship it', messageId: 'qm-mobile-aaaabbbbcccc',
    })
  })

  it('an outage FAR longer than the client 120s retry budget still delivers on reconnect', async () => {
    // The whole point: the client ladder is irrelevant once the send is banked.
    bridgeDown()
    expect((await postMessage({ text: 'first', messageId: 'qm-mobile-000000000001' })).status).toBe(202)
    expect((await postMessage({ text: 'second', messageId: 'qm-mobile-000000000002' })).status).toBe(202)
    expect(await queuedSessionSendCount()).toBe(2)

    // ~7 real minutes of outage compressed: nothing in the queue is time-gated
    // below the 24h expiry, so age is simulated by rewriting `at`.
    const stale = new Date(Date.now() - 10 * 60_000).toISOString()
    for (const name of (await fs.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json'))) {
      const file = path.join(SEND_QUEUE_DIR, name)
      const op = JSON.parse(await fs.readFile(file, 'utf-8'))
      await fs.writeFile(file, JSON.stringify({ ...op, at: stale }))
    }

    const seen: Array<Record<string, unknown>> = []
    bridgeUp(seen)
    expect(await flushSendQueue()).toBe(2)
    expect(await queuedSessionSendCount()).toBe(0)
    // Order preserved (opIds sort chronologically) — a conversation is not LWW.
    expect(seen.map((p) => p.message)).toEqual(['first', 'second'])
    expect(seen.map((p) => p.messageId)).toEqual(['qm-mobile-000000000001', 'qm-mobile-000000000002'])
  })

  it('the bridge-reconnect hook drains automatically — no human retry needed', async () => {
    bridgeDown()
    expect((await postMessage({ text: 'auto', messageId: 'qm-mobile-000000000003' })).status).toBe(202)
    expect(await queuedSessionSendCount()).toBe(1)

    const seen: Array<Record<string, unknown>> = []
    bridgeUp(seen)
    // Exactly what bridge-registry fires on a primary hello.
    expect(primaryConnectedHandlers.size).toBeGreaterThan(0)
    for (const h of primaryConnectedHandlers) h()
    await vi.waitFor(async () => { expect(await queuedSessionSendCount()).toBe(0) }, { timeout: 5_000 })
    expect(seen.map((p) => p.message)).toEqual(['auto'])
  })

  it('answers inside the client timeout when the relay hangs, and banks the rest', async () => {
    // The literal 2026-08-20 failure: the relay never answers, so the route used
    // to sit on its 50s budget while the phone abandoned the POST at 30s.
    bridgeConnected = true
    bridgeRequestMock.mockImplementation((_host: string, cmd: string) => {
      if (cmd === 'session.message') return new Promise(() => { /* never settles */ })
      return Promise.resolve({ ok: true })
    })
    const started = Date.now()
    const res = await postMessage({ text: 'hangs', messageId: 'qm-mobile-000000000004' })
    const elapsed = Date.now() - started
    expect(res.status).toBe(202)
    expect((await res.json() as Record<string, unknown>).queued).toBe(true)
    // Under the phone's 30s URLSession ceiling, with real margin.
    expect(elapsed).toBeLessThan(28_000)
    expect(await queuedSessionSendCount()).toBe(1)
  }, 40_000)

  it('a live bridge still answers synchronously — no queue, no behavior change', async () => {
    const seen: Array<Record<string, unknown>> = []
    bridgeUp(seen)
    const res = await postMessage({ text: 'normal', messageId: 'qm-mobile-000000000005' })
    expect(res.status).toBe(202)
    const body = await res.json() as Record<string, unknown>
    expect(body.messageId).toBe('qm-mobile-000000000005')
    // No `queued` marker on the synchronous path.
    expect(body.queued).toBeUndefined()
    expect(await queuedSessionSendCount()).toBe(0)
    expect(seen).toHaveLength(1)
  })

  it('replaying the same messageId never banks a duplicate turn', async () => {
    bridgeDown()
    expect((await postMessage({ text: 'dup', messageId: 'qm-mobile-000000000006' })).status).toBe(202)
    expect((await postMessage({ text: 'dup', messageId: 'qm-mobile-000000000006' })).status).toBe(202)
    // Both rows carry ONE id, so the primary's queue collapses them; the flush
    // relays each with that id and the dedupe there is the exactly-once anchor.
    const seen: Array<Record<string, unknown>> = []
    bridgeUp(seen)
    await flushSendQueue()
    expect(new Set(seen.map((p) => p.messageId)).size).toBe(1)
    expect(await queuedSessionSendCount()).toBe(0)
  })

  it('an IMAGE send is never banked — it keeps the honest 503', async () => {
    // The attachments only exist as host-side files created THROUGH the bridge;
    // banking the text alone would deliver a turn whose pictures vanished.
    bridgeDown()
    const res = await postMessage({
      text: 'look',
      messageId: 'qm-mobile-000000000007',
      images: [{
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        mediaType: 'image/png',
      }],
    })
    expect(res.status).toBe(503)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('bridge_offline')
    expect(await queuedSessionSendCount()).toBe(0)
  })

  it('a domain rejection from the primary drops the row instead of wedging the queue', async () => {
    bridgeDown()
    expect((await postMessage({ text: 'gone', messageId: 'qm-mobile-000000000008' })).status).toBe(202)
    bridgeConnected = true
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: false, error: 'Session not found: x', errorKind: 'not_found' }
      return { ok: true }
    })
    await flushSendQueue()
    expect(await queuedSessionSendCount()).toBe(0)
  })

  it('keeps the row when the primary server is not connected to its daemon yet', async () => {
    bridgeDown()
    expect((await postMessage({ text: 'wait', messageId: 'qm-mobile-000000000009' })).status).toBe(202)
    bridgeConnected = true
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: false, error: 'session.message: no primary server connected' }
      return { ok: true }
    })
    expect(await flushSendQueue()).toBe(0)
    // Still banked — this is transport, not a refusal.
    expect(await queuedSessionSendCount()).toBe(1)
  })
})
