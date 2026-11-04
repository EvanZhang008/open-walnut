/**
 * The phone's Stop and Interrupt & send through the CLOUD companion (REPLICA):
 *   POST /sessions/:id/interrupt            relays the `interrupt` control action to the primary
 *   POST /sessions/:id/messages {interrupt} relays the stop first, then the message; a stop that
 *                                           cannot be delivered sends nothing (the words stay in
 *                                           the composer)
 * Bridge mocked at its module seam, the same way as api-v1-session-lifecycle-cloud.test.ts and
 * session-send-stop-unanswered.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-interrupt-cloud', { CLOUD_MODE: true }))

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
  addPrimaryBridgeConnectedHandler: () => () => {},
  addBridgeConnectedHandler: () => () => {},
}))

const SID = 'cloud-interrupt-sid'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'devbox', host_label: 'Dev box', process_status: 'running',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus',
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { flushSendQueue } from '../../../src/core/send-queue.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionStreamV1Router)
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use(errorHandler)
  return app
}

/** Every bridge call in order, as "<host> <command> <action?>". */
let calls: string[] = []

function wire(control: 'ok' | 'offline' | 'old-primary' | 'missing'): void {
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
    calls.push(`${host} ${cmd}${typeof p.action === 'string' ? ` ${p.action}` : ''}`)
    if (host === '__local__' && cmd === 'session.control' && p.action === 'interrupt') {
      if (control === 'offline') throw new BridgeOfflineError('__local__')
      if (control === 'old-primary') return { ok: false, error: 'Unknown control action: interrupt' }
      if (control === 'missing') return { ok: false, error: 'Session not found', errorKind: 'not_found' }
      return { ok: true, result: { status: 'interrupted', sessionId: SID, wasRunning: true } }
    }
    switch (cmd) {
      case 'session.message': return { ok: true, result: { messageId: p.messageId } }
      case 'ping': return { ok: true }
      case 'status': return { exists: true, alive: true }
      case 'send': return { ok: true }
      case 'bridgeResume': return { ok: true }
      case 'appendUserMarker': return { ok: true }
      case 'read-history': return { ok: true, main: '' }
      default: throw new Error('unexpected command: ' + cmd + ' ' + host)
    }
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  calls = []
  wire('ok')
})

afterEach(async () => {
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/v1/sessions/:id/interrupt on a REPLICA', () => {
  it('relays the interrupt action to the primary and passes its answer through', async () => {
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/interrupt`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'interrupted', sessionId: SID, wasRunning: true })
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control', { action: 'interrupt', sessionId: SID }, 30_000,
    )
  })

  it('an old primary (Unknown control action) is 400 session_control_needs_upgrade', async () => {
    wire('old-primary')
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/interrupt`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('the bridge down is 503 bridge_offline', async () => {
    wire('offline')
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/interrupt`).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('an unknown session on the primary is 404', async () => {
    wire('missing')
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/interrupt`).send({})
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/sessions/:id/messages with interrupt on a REPLICA', () => {
  const post = (body: Record<string, unknown>) =>
    request(createApp()).post(`/api/v1/sessions/${SID}/messages`).send(body)

  it('stops the turn on the primary first, then relays the message', async () => {
    const res = await post({ text: 'do this instead', messageId: 'qm-mobile-ci00000001', interrupt: true })
    expect(res.status).toBe(202)
    await flushSendQueue()
    const stopAt = calls.indexOf('__local__ session.control interrupt')
    const sendAt = calls.findIndex((c) => c.endsWith('session.message'))
    expect(stopAt).toBeGreaterThanOrEqual(0)
    expect(sendAt).toBeGreaterThan(stopAt)
  })

  it('a stop the primary cannot take sends nothing: 503 and no message call', async () => {
    wire('offline')
    const res = await post({ text: 'do this instead', messageId: 'qm-mobile-ci00000002', interrupt: true })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    await flushSendQueue()
    expect(calls.some((c) => c.endsWith('session.message'))).toBe(false)
  })

  it('an old primary that cannot interrupt is 400 session_control_needs_upgrade and sends nothing', async () => {
    wire('old-primary')
    const res = await post({ text: 'do this instead', messageId: 'qm-mobile-ci00000003', interrupt: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
    await flushSendQueue()
    expect(calls.some((c) => c.endsWith('session.message'))).toBe(false)
  })

  it('without interrupt no stop is asked (a plain send is unchanged)', async () => {
    const res = await post({ text: 'just a message', messageId: 'qm-mobile-ci00000004' })
    expect(res.status).toBe(202)
    await flushSendQueue()
    expect(calls.some((c) => c.includes('session.control'))).toBe(false)
  })

  it('a non-boolean interrupt is 400 before anything is relayed', async () => {
    const res = await post({ text: 'x', interrupt: 'now' })
    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })
})
