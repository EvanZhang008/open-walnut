/**
 * cloudSend (POST /api/v1/sessions/:id/messages on a REPLICA) — the durable
 * relay path added for the 2026-08-13 phone-send data-loss family.
 *
 * Contract under test:
 *   1. Default path: ONE `session.message` bridge RPC carrying the stable
 *      messageId — no marker write, no direct `send`, no bridgeResume (the
 *      primary's durable queue owns delivery).
 *   2. Client-supplied messageId (phone retry) rides through unchanged.
 *   3. errorKind not_found → 404; other relay errors → 503 retryable
 *      bridge_offline (NO silent fallback that could double-deliver).
 *   4. Fallback to the direct sequence ONLY when the primary provably never
 *      saw the message (old daemon / primary not connected) — and the direct
 *      sequence is loss-safe: delivery FIRST, marker AFTER (ghost-bubble fix).
 *   5. Bridge down → 503 bridge_offline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-send', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

const SID = 'cloud-send-sid-1'
let stopRequest: { id: string; state: string } | undefined
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'devbox', process_status: 'running',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest,
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json({ limit: '80mb' }))
  app.use('/api/v1', sessionStreamV1Router)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  stopRequest = undefined
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

function callsByCmd(): string[] {
  return bridgeRequestMock.mock.calls.map((c) => c[1] as string)
}

describe('durable relay path', () => {
  it('sends ONE session.message RPC and never touches marker/send/resume', async () => {
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: true, result: { messageId: 'qm-mobile-abc' } }
      throw new Error('unexpected command: ' + cmd)
    })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hello from phone' })
    expect(res.status).toBe(202)
    expect(res.body.messageId).toMatch(/^qm-mobile-/)
    expect(callsByCmd()).toEqual(['session.message'])
    const [host, , params, timeout] = bridgeRequestMock.mock.calls[0]
    expect(host).toBe('devbox')
    expect((params as Record<string, unknown>).sessionId).toBe(SID)
    expect((params as Record<string, unknown>).message).toBe('hello from phone')
    expect((params as Record<string, unknown>).messageId).toBe(res.body.messageId)
    expect(timeout).toBe(50_000)
  })

  it('keeps the first fence for a retried id and gives only new input the new fence', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true })
    const app = createApp()
    expect((await request(app).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'old', messageId: 'qm-before-stop' })).status).toBe(202)
    stopRequest = { id: 'stop-1', state: 'confirmed' }
    expect((await request(app).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'old', messageId: 'qm-before-stop' })).status).toBe(202)
    expect((await request(app).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'new', messageId: 'qm-after-stop' })).status).toBe(202)
    const sends = bridgeRequestMock.mock.calls.filter((call) => call[1] === 'session.message')
    expect(sends.map((call) => call[2].stopFence)).toEqual([null, null, 'stop-1'])
  })

  it('concurrent callers bind the same message id only once', async () => {
    const { bindSessionSendFence } = await import('../../../src/core/send-queue.js')
    const values = await Promise.all(Array.from({ length: 12 }, (_, index) => bindSessionSendFence(SID, 'qm-racing-fences', `stop-${index}`)))
    expect(new Set(values).size).toBe(1)
    expect(await bindSessionSendFence(SID, 'qm-racing-fences', 'newest-stop')).toBe(values[0])
  })

  it('banks the original fence and does not refresh it while draining', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await request(createApp()).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'old', messageId: 'qm-banked-stop' })).status).toBe(202)
    stopRequest = { id: 'stop-2', state: 'confirmed' }
    bridgeRequestMock.mockResolvedValue({ ok: false, errorKind: 'session_stopped', error: 'Message predates the latest stop' })
    const { flushSendQueue, queuedSessionSendCount } = await import('../../../src/core/send-queue.js')
    expect(await flushSendQueue()).toBe(1)
    expect(bridgeRequestMock.mock.calls.at(-1)?.[2].stopFence).toBeNull()
    expect(await queuedSessionSendCount()).toBe(0)
  })

  it('does not relay or bank new input while a stop is pending', async () => {
    stopRequest = { id: 'stop-3', state: 'pending' }
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'wait' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('stop_pending')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('maps a stale-fence rejection to a domain error without fallback', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, errorKind: 'session_stopped', error: 'Message predates the latest stop' })
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'old' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('session_stopped')
    expect(callsByCmd()).toEqual(['session.message'])
  })

  it('a client-supplied messageId (phone retry) rides through unchanged', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: {} })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'retry me', messageId: 'qm-mobile-deadbeef0001' })
    expect(res.status).toBe(202)
    expect(res.body.messageId).toBe('qm-mobile-deadbeef0001')
    expect((bridgeRequestMock.mock.calls[0][2] as Record<string, unknown>).messageId)
      .toBe('qm-mobile-deadbeef0001')
  })

  it('a malformed client messageId is ignored (fresh id minted)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: {} })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'x', messageId: 'not-a-qm-id; DROP TABLE' })
    expect(res.status).toBe(202)
    expect(res.body.messageId).toMatch(/^qm-mobile-[0-9a-f]{12}$/)
  })

  it('relay errorKind not_found → 404', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Session not found: x', errorKind: 'not_found' })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hi' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('a relay timeout/internal error is 503 retryable — NEVER a fallback double-delivery', async () => {
    // The enqueue MAY have committed on the primary before the failure; the
    // direct fallback would deliver a second copy. The route must refuse.
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session.message: primary server timed out' })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hi' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(callsByCmd()).toEqual(['session.message']) // no status/send/resume followed
  })

  it('bridge fully offline → the send is BANKED and fast-accepted (202 queued)', async () => {
    // Was 503. No socket means the primary provably never saw the message, so
    // the replica persists it (core/send-queue.ts) and drains on reconnect.
    // Before this, the only cover for a bridge outage was the phone's 120s
    // retry ladder — and the 2026-08-20 outage ran ~7 minutes, so the ladder
    // ran out and a healthy, still-streaming session showed "Not sent".
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'hi' })
    expect(res.status).toBe(202)
    expect(res.body.messageId).toMatch(/^qm-mobile-/)
    expect(res.body.queued).toBe(true)
  })

  it('an IMAGE send with no bridge still 503s — never a turn whose pictures vanished', async () => {
    // The attachments only exist as host-side files created THROUGH the bridge,
    // so banking the text alone would silently drop them.
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({
        text: 'look at this',
        images: [{
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          mediaType: 'image/png',
        }],
      })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})

describe('direct fallback (old daemon / primary down)', () => {
  function fallbackImpl(sendOk: boolean, alive = true) {
    return async (_host: string, cmd: string) => {
      switch (cmd) {
        case 'session.message': return { ok: false, error: 'unknown command: session.message' }
        case 'status': return { exists: true, alive }
        case 'send': return sendOk ? { ok: true } : { ok: false, reason: 'ENXIO' }
        case 'appendUserMarker': return { ok: true, size: 123 }
        case 'bridgeResume': return { pid: 4242 }
        default: throw new Error('unexpected command: ' + cmd)
      }
    }
  }

  it.each([true, false])('direct fallback retains the original fence (alive=%s)', async (alive) => {
    stopRequest = { id: 'confirmed-stop', state: 'confirmed' }
    bridgeRequestMock.mockImplementation(fallbackImpl(true, alive))
    const response = await request(createApp()).post(`/api/v1/sessions/${SID}/messages`).send({ text: 'new', messageId: `qm-fallback-${alive}` })
    expect(response.status).toBe(202)
    const delivered = bridgeRequestMock.mock.calls.find((call) => call[1] === (alive ? 'send' : 'bridgeResume'))
    expect(delivered?.[2].stopFence).toBe('confirmed-stop')
  })

  it('falls back on unknown-command and delivers BEFORE writing the marker (live path)', async () => {
    bridgeRequestMock.mockImplementation(fallbackImpl(true))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'fallback live' })
    expect(res.status).toBe(202)
    const cmds = callsByCmd()
    expect(cmds).toEqual(['session.message', 'status', 'send', 'appendUserMarker'])
    // Loss-safe order is the ghost-bubble fix: marker strictly AFTER send.
    expect(cmds.indexOf('send')).toBeLessThan(cmds.indexOf('appendUserMarker'))
  })

  it('failed delivery on the fallback live path writes NO marker (no ghost bubble)', async () => {
    bridgeRequestMock.mockImplementation(fallbackImpl(false))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'fallback dead' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('session_dead')
    expect(callsByCmd()).not.toContain('appendUserMarker')
  })

  it('dead-CLI fallback resumes FIRST, marker after the confirmed respawn', async () => {
    bridgeRequestMock.mockImplementation(fallbackImpl(true, false))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'fallback resume' })
    expect(res.status).toBe(202)
    const cmds = callsByCmd()
    expect(cmds).toEqual(['session.message', 'status', 'bridgeResume', 'appendUserMarker'])
    expect(cmds.indexOf('bridgeResume')).toBeLessThan(cmds.indexOf('appendUserMarker'))
  })

  it('failed resume on the fallback path writes NO marker and is 409', async () => {
    bridgeRequestMock.mockImplementation(async (_host: string, cmd: string) => {
      switch (cmd) {
        case 'session.message': return { ok: false, error: 'session.message: no primary server connected' }
        case 'status': return { exists: true, alive: false }
        case 'bridgeResume': return { error: 'resume failed' }
        default: throw new Error('unexpected command: ' + cmd)
      }
    })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/messages`)
      .send({ text: 'resume fails' })
    expect(res.status).toBe(409)
    expect(callsByCmd()).not.toContain('appendUserMarker')
  })
})
