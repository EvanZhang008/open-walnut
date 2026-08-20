/**
 * /api/v1 session lifecycle — CLOUD_MODE (REPLICA) behavior. All Wave-1
 * lifecycle endpoints relay through the primary's daemon bridge using NEW
 * actions on the existing `session.control` command (the daemon forwards the
 * action string opaquely, so no daemon change is needed). Bridge mocked at
 * its module seam (same pattern as api-v1-session-control-cloud.test.ts).
 *
 * Covers: relay payload per action, success passthrough, the failure ladder
 * (old daemon/primary → 400 session_control_needs_upgrade, bridge down → 503
 * bridge_offline, errorKind → status), and the errorCode passthrough
 * (terminate's cron_owner surfaces the same code as the local path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-lifecycle-cloud', { CLOUD_MODE: true }))

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

import express from 'express'
import request from 'supertest'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const SID = 'cloud-lc-session-1'

describe('lifecycle relay payloads on a REPLICA', () => {
  it('GET detail relays action detail (10s poll-friendly budget)', async () => {
    const result = { session: { claudeSessionId: SID }, pendingPermissions: [] }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(result)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'detail', sessionId: SID },
      10_000,
    )
  })

  it('PATCH relays action patch with only the provided fields', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { session: { title: 'Renamed' } } })
    const res = await request(createApp())
      .patch(`/api/v1/sessions/${SID}`)
      .send({ title: 'Renamed', archived: false })
    expect(res.status).toBe(200)
    // Metadata-only patches ride the fast-accept path (20s budget — no runner
    // work behind them); mode patches keep the 30s synchronous relay below.
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'patch', sessionId: SID, params: { title: 'Renamed', archived: false } },
      20_000,
    )
  })

  it('PATCH with mode stays a SYNCHRONOUS relay (runner-touching — no fast-accept)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { session: { mode: 'plan' } } })
    const res = await request(createApp())
      .patch(`/api/v1/sessions/${SID}`)
      .send({ mode: 'plan' })
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'patch', sessionId: SID, params: { mode: 'plan' } },
      30_000,
    )
  })

  it('PATCH with an empty body is rejected locally (never relays)', async () => {
    const res = await request(createApp()).patch(`/api/v1/sessions/${SID}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('POST terminate relays action terminate with the force flag', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { status: 'terminated', sessionId: SID } })
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/terminate`).send({ force: true })
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'terminate', sessionId: SID, params: { force: true } },
      30_000,
    )
  })

  it('POST restart / retry / execute-continue relay their actions (no params)', async () => {
    for (const [path, action] of [
      ['restart', 'restart'], ['retry', 'retry'], ['execute-continue', 'execute-continue'],
    ] as const) {
      bridgeRequestMock.mockReset()
      bridgeRequestMock.mockResolvedValue({ ok: true, result: { sessionId: SID } })
      const res = await request(createApp()).post(`/api/v1/sessions/${SID}/${path}`)
      expect(res.status).toBe(200)
      expect(bridgeRequestMock).toHaveBeenCalledWith(
        '__local__', 'session.control',
        { action, sessionId: SID },
        30_000,
      )
    }
  })

  it('POST permission relays requestId/allow/message', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { status: 'resolved', requestId: 'req-9', allow: false } })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/permission`)
      .send({ requestId: 'req-9', allow: false, message: 'no thanks' })
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'permission', sessionId: SID, params: { requestId: 'req-9', allow: false, message: 'no thanks' } },
      30_000,
    )
  })

  it('GET changes relays base/scope/light/refresh', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { groups: [] } })
    const res = await request(createApp())
      .get(`/api/v1/sessions/${SID}/changes?base=uncommitted&scope=all&light=1&refresh=1`)
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'changes', sessionId: SID, params: { base: 'uncommitted', scope: 'all', light: true, refresh: true } },
      30_000,
    )
  })

  it('GET history relays tail (clamped to the max)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { messages: [], total: 0 } })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}/history?tail=99999`)
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'history', sessionId: SID, params: { tail: 2000 } },
      30_000,
    )
  })
})

describe('failure ladder', () => {
  it('old daemon (unknown command) → 400 session_control_needs_upgrade', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'unknown command: session.control' })
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/restart`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('old PRIMARY (Unknown control action) → 400 session_control_needs_upgrade', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: restart', errorKind: 'bad_request' })
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/restart`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('bridge offline → 503 bridge_offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/terminate`).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('daemon up but primary server down + no projection row → 503 bridge_offline', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session.control: no primary server connected' })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}`)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('errorKind not_found passes through as 404', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Session not found', errorKind: 'not_found' })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(res.body.error.message).toBe('Session not found')
  })

  it('detail degrades to the projection row when the primary cannot answer (2026-08-20 incident)', async () => {
    // The Mac lost DNS for ~108 min; clouddev's own bridge stayed up the whole
    // time. The 12s detail poll answered 503 and painted a healthy, streaming
    // clouddev session as unreachable. Read-only status must degrade, not error.
    const path = await import('node:path')
    await fs.mkdir(path.join(WALNUT_HOME, 'sessions'), { recursive: true })
    await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'clouddev', process_status: 'idle', title: 'Blog session',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(), message_count: 3,
      }],
    }))
    // 1st call: the primary relay (no primary server connected).
    // 2nd call: the degraded path's liveness probe against the SESSION host.
    bridgeRequestMock
      .mockResolvedValueOnce({ ok: false, error: 'session.control: no primary server connected' })
      .mockResolvedValueOnce({ exists: true, alive: true })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}`)
    expect(res.status).toBe(200)
    expect(res.body.degraded).toBe(true)
    expect(res.body.session.claudeSessionId).toBe(SID)
    expect(res.body.session.process_status).toBe('idle')
    expect(res.body.pendingPermissions).toEqual([])
    // The probe went to the session's OWN host, not the primary.
    expect(bridgeRequestMock).toHaveBeenLastCalledWith('clouddev', 'status', { sid: SID }, 5_000)
  })

  it('degraded detail corrects liveness from the host daemon (alive=false → stopped)', async () => {
    const path = await import('node:path')
    await fs.mkdir(path.join(WALNUT_HOME, 'sessions'), { recursive: true })
    await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: 'clouddev', process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(), message_count: 1,
      }],
    }))
    bridgeRequestMock
      .mockRejectedValueOnce(new BridgeOfflineError('__local__'))
      .mockResolvedValueOnce({ exists: true, alive: false })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}`)
    expect(res.status).toBe(200)
    expect(res.body.degraded).toBe(true)
    expect(res.body.session.process_status).toBe('stopped')
  })

  it('domain errorCode (cron_owner) rides the relay into the v1 error code', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: false,
      error: 'This session owns recurring scheduled tasks (crons)…',
      errorKind: 'conflict',
      errorCode: 'cron_owner',
    })
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/terminate`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('cron_owner')
  })
})

describe('PATCH fast-accept (metadata patches survive a dead bridge)', () => {
  it('bridge offline → 200 { session, queued:true } and the patch lands in the control queue', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp())
      .patch(`/api/v1/sessions/${SID}`)
      .send({ title: 'Renamed offline' })
    expect(res.status).toBe(200)
    expect(res.body.queued).toBe(true)
    expect(res.body.session.title).toBe('Renamed offline')
    const { queuedSessionPatchCount, flushControlQueue } = await import('../../../src/core/control-queue.js')
    expect(await queuedSessionPatchCount()).toBe(1)

    // Bridge back → the queued patch drains as a normal 'patch' relay.
    bridgeRequestMock.mockReset()
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { session: { title: 'Renamed offline' } } })
    expect(await flushControlQueue()).toBe(1)
    expect(await queuedSessionPatchCount()).toBe(0)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'patch', sessionId: SID, params: { title: 'Renamed offline' } },
      20_000,
    )
  })

  it('mode patch does NOT fast-accept: bridge offline stays an honest 503', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp())
      .patch(`/api/v1/sessions/${SID}`)
      .send({ mode: 'plan' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('a domain rejection is NOT queued — verbatim error passthrough', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Stop session before archiving', errorKind: 'bad_request' })
    const res = await request(createApp())
      .patch(`/api/v1/sessions/${SID}`)
      .send({ archived: true })
    expect(res.status).toBe(400)
    const { queuedSessionPatchCount } = await import('../../../src/core/control-queue.js')
    expect(await queuedSessionPatchCount()).toBe(0)
  })

  it('flush keeps the patch on transport failure and drops it on domain rejection', async () => {
    // Queue one patch via the route.
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    await request(createApp()).patch(`/api/v1/sessions/${SID}`).send({ human_note: 'queued note' })
    const { queuedSessionPatchCount, flushControlQueue } = await import('../../../src/core/control-queue.js')
    expect(await queuedSessionPatchCount()).toBe(1)

    // Still offline → kept.
    expect(await flushControlQueue()).toBe(0)
    expect(await queuedSessionPatchCount()).toBe(1)

    // Primary refuses at apply time → dropped (retry would refuse identically).
    bridgeRequestMock.mockReset()
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session not found', errorKind: 'not_found' })
    expect(await flushControlQueue()).toBe(1)
    expect(await queuedSessionPatchCount()).toBe(0)
  })
})
