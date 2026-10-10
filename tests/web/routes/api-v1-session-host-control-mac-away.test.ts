/**
 * A session's controls on the cloud companion while it leads the session's host
 * (core/leader/host-session-control.ts, docs/plan/walnut-control-plane.md
 * "Session controls while the Mac is away"): the real routes, the real
 * projection copy on disk, the real stop fence; the bridge and the backup
 * leader are stand-ins.
 *
 *   - leading the host: a permission answer, a mode and a stop go to that host
 *     (`leader.control` at the lead's epoch), the host's refusals read as the
 *     Mac's own errors, and the session detail shows the prompt the host keeps;
 *   - not leading, a session on the Mac itself, or another agent's session:
 *     relayed to the Mac as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hostctl-away', { CLOUD_MODE: true }))

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

const leader = vi.hoisted(() => ({
  lastSeenAt: 0,
  leads: new Map<string, { walnutId: string; epoch: number }>(),
}))
vi.mock('../../../src/core/leader/backup-leader.js', () => ({
  getBackupLeader: async () => ({
    status: () => ({
      leading: [...leader.leads].map(([host, l]) => ({ host, epoch: l.epoch, since: 0 })),
      primaryLastSeenAt: leader.lastSeenAt, primaryHeard: true, backupAllowed: true,
      restartingUntil: null, lastDecision: null, takeoverMs: 60_000,
    }),
    leadFor: (host: string) => leader.leads.get(host) ?? null,
    lostHost: (host: string) => { leader.leads.delete(host) },
  }),
}))

import express from 'express'
import request from 'supertest'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { sessionExtrasV1Router } from '../../../src/web/routes/session-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { writeProjectionCache } from '../../../src/core/projection-cache.js'
import { _resetV1ForwardForTesting } from '../../../src/web/v1-forward/proxy.js'
import { _resetHostSessionControlForTesting } from '../../../src/core/leader/host-session-control.js'
import { latestKnownStop, stopAskUnconfirmed } from '../../../src/core/sessions/cloud-stop-fence.js'

const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const M = 'cccccccc-3333-4333-8333-333333333333'
const X = 'eeeeeeee-5555-4555-8555-555555555555'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use('/api/v1', sessionExtrasV1Router)
  app.use(errorHandler)
  return app
}

async function writeCopy(exportedAt = new Date(Date.now() - 60_000).toISOString()) {
  await writeProjectionCache('sessions', {
    version: 1, exportedAt,
    sessions: [
      { id: B, host: 'devbox', title: 'Fix the build', process_status: 'running', started_at: '', last_active_at: '', message_count: 2, mode: 'default' },
      { id: M, host: '', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1 },
      { id: X, host: 'devbox', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1, engine: 'codex' },
    ],
  })
}

const macCalls = () => bridgeRequestMock.mock.calls.filter((c) => c[0] === '__local__')
const hostCalls = (host: string) => bridgeRequestMock.mock.calls.filter((c) => c[0] === host)
/** Answer the host per command; the Mac is offline. */
function hostAnswers(answers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>) {
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, params: Record<string, unknown>) => {
    if (host === '__local__') throw new BridgeOfflineError('__local__')
    const answer = answers[cmd === 'leader.control' ? `control:${String(params.action)}` : cmd]
    if (!answer) throw new Error(`unexpected ${cmd} to ${host}`)
    return answer(params)
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  leader.lastSeenAt = Date.now() - 120_000
  leader.leads.clear()
  leader.leads.set('devbox', { walnutId: 'wtest', epoch: 3 })
  _resetV1ForwardForTesting()
  _resetHostSessionControlForTesting()
  await writeCopy()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a permission prompt while the companion leads the session\'s host', () => {
  it('the detail shows the prompt the host keeps, and the answer goes to that host at the lead\'s epoch', async () => {
    hostAnswers({
      status: () => ({ ok: true, exists: true, alive: true, pendingCtrl: { reqId: 'perm-1', toolName: 'Bash', receivedAt: 1, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls docs/' }, decision_reason: 'not allowed yet' } } }),
      'control:permission': (p) => ({ ok: true, status: 'resolved', requestId: p.requestId, allow: p.allow }),
    })
    const app = createApp()
    const detail = await request(app).get(`/api/v1/sessions/${B}`)
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ degraded: true, session: { claudeSessionId: B, process_status: 'running', mode: 'default' } })
    expect(detail.body.pendingPermissions).toEqual([{ requestId: 'perm-1', toolName: 'Bash', input: { command: 'ls docs/' }, reason: 'not allowed yet' }])

    const res = await request(app).post(`/api/v1/sessions/${B}/permission`).send({ requestId: 'perm-1', allow: true, answers: { q: 'a' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'resolved', requestId: 'perm-1', allow: true, viaCompanion: true })
    expect(hostCalls('devbox').filter((c) => c[1] === 'leader.control')).toEqual([[
      'devbox', 'leader.control', { walnutId: 'wtest', epoch: 3, sid: B, action: 'permission', requestId: 'perm-1', allow: true, answers: { q: 'a' } }, 20_000,
    ]])
  })

  it('a prompt that is gone reads as the Mac\'s 404; a stale lead is let go and reads as offline', async () => {
    hostAnswers({ 'control:permission': () => ({ ok: false, error: 'leader.control: Permission request not found or already resolved', errorKind: 'not_found' }) })
    const gone = await request(createApp()).post(`/api/v1/sessions/${B}/permission`).send({ requestId: 'perm-9', allow: true })
    expect(gone.status).toBe(404)
    expect(gone.body.error.code).toBe('not_found')
    hostAnswers({ 'control:permission': () => ({ ok: false, error: 'stale epoch', errorKind: 'stale_epoch' }) })
    const stale = await request(createApp()).post(`/api/v1/sessions/${B}/permission`).send({ requestId: 'perm-1', allow: true })
    expect(stale.status).toBe(503)
    expect(stale.body.error.code).toBe('bridge_offline')
    expect(leader.leads.has('devbox')).toBe(false)
  })

  it('an older daemon that refuses the command says it upgrades', async () => {
    hostAnswers({ 'control:permission': () => ({ ok: false, error: 'command not permitted over bridge: leader.control' }) })
    const res = await request(createApp()).post(`/api/v1/sessions/${B}/permission`).send({ requestId: 'perm-1', allow: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('a dead prompt is not shown: the host says the process is gone', async () => {
    hostAnswers({ status: () => ({ ok: true, exists: true, alive: false, pendingCtrl: { reqId: 'perm-1', request: { subtype: 'can_use_tool' } } }) })
    const detail = await request(createApp()).get(`/api/v1/sessions/${B}`)
    expect(detail.body.pendingPermissions).toEqual([])
    expect(detail.body.session.process_status).toBe('stopped')
  })
})

describe('the mode while the companion leads the session\'s host', () => {
  it('the controls show the mode it knows, a change goes to the host, and both shapes show the new mode', async () => {
    hostAnswers({ 'control:mode': (p) => ({ ok: true, mode: p.mode, appliedLive: true }) })
    const app = createApp()
    const before = await request(app).get(`/api/v1/sessions/${B}/controls`)
    expect(before.body).toMatchObject({ engine: 'claude', controls: [{ id: 'mode', currentValue: 'default' }] })
    const set = await request(app).post(`/api/v1/sessions/${B}/controls`).send({ id: 'mode', value: 'accept' })
    expect(set.status).toBe(200)
    expect(set.body.controls[0].currentValue).toBe('accept')
    expect((await request(app).get(`/api/v1/sessions/${B}/controls`)).body.controls[0].currentValue).toBe('accept')
    const patch = await request(app).patch(`/api/v1/sessions/${B}`).send({ mode: 'plan' })
    expect(patch.status).toBe(200)
    expect(patch.body).toEqual({ session: { claudeSessionId: B, process_status: 'running', title: 'Fix the build', mode: 'plan' }, viaCompanion: true })
    expect(hostCalls('devbox').map((c) => c[2].mode)).toEqual(['accept', 'plan'])
    expect(macCalls()).toHaveLength(0)
  })

  it('the rest of a patch with a mode goes the metadata way, queued for the Mac', async () => {
    hostAnswers({ 'control:mode': (p) => ({ ok: true, mode: p.mode, appliedLive: false, reason: 'dead' }) })
    const res = await request(createApp()).patch(`/api/v1/sessions/${B}`).send({ mode: 'plan', title: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ session: { mode: 'plan', title: 'Renamed' }, queued: true, viaCompanion: true })
  })

  it('a mode the host refuses changes nothing here', async () => {
    hostAnswers({ 'control:mode': () => ({ ok: false, error: 'leader.control: mode must be one of plan/default', errorKind: 'refused' }) })
    const app = createApp()
    const res = await request(app).post(`/api/v1/sessions/${B}/controls`).send({ id: 'mode', value: 'yolo' })
    expect(res.status).toBe(409)
    expect((await request(app).get(`/api/v1/sessions/${B}/controls`)).body.controls[0].currentValue).toBe('default')
  })

  it('a control that is not the mode is refused like the Mac refuses it', async () => {
    const res = await request(createApp()).post(`/api/v1/sessions/${B}/controls`).send({ id: 'model', value: 'opus' })
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})

describe('a stop while the companion leads the session\'s host', () => {
  it('goes to the host with a fresh stop id, and the fence keeps that stop', async () => {
    hostAnswers({ 'control:stop': () => ({ ok: true, stopped: true }) })
    const res = await request(createApp()).post(`/api/v1/sessions/${B}/terminate`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'terminated', sessionId: B, viaCompanion: true, stopRequest: { state: 'confirmed' } })
    const [call] = hostCalls('devbox')
    expect(call[1]).toBe('leader.control')
    expect(call[2]).toMatchObject({ walnutId: 'wtest', epoch: 3, sid: B, action: 'stop' })
    expect(call[2].stopRequestId).toMatch(UUID_RE)
    expect(call[2].stopRequestId).toBe(res.body.stopRequest.id)
    expect(call[2].force).toBeUndefined()
    // The next message is fenced by this stop, and is not held for an unanswered ask.
    expect((await latestKnownStop(B, null))?.id).toBe(res.body.stopRequest.id)
    expect(await stopAskUnconfirmed(B)).toBe(false)
  })

  it('a session with scheduled jobs needs force; the refusal closes the ask', async () => {
    hostAnswers({ 'control:stop': (p) => (p.force ? { ok: true, stopped: true } : { ok: false, error: 'leader.control: this session owns scheduled jobs; confirm the stop', errorKind: 'cron_owner' }) })
    const refused = await request(createApp()).post(`/api/v1/sessions/${B}/terminate`).send({})
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('cron_owner')
    expect(await stopAskUnconfirmed(B)).toBe(false)
    const forced = await request(createApp()).post(`/api/v1/sessions/${B}/terminate`).send({ force: true })
    expect(forced.status).toBe(200)
    expect(hostCalls('devbox').at(-1)?.[2].force).toBe(true)
  })

  it('a stop the host has not confirmed is the Mac\'s stop_pending, and the ask stays open', async () => {
    hostAnswers({ 'control:stop': () => ({ ok: false, error: 'stop: process did not exit after SIGTERM; automatic recovery remains disabled' }) })
    const res = await request(createApp()).post(`/api/v1/sessions/${B}/terminate`).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('stop_pending')
    expect(await stopAskUnconfirmed(B)).toBe(true)
  })
})

describe('what stays the Mac\'s', () => {
  it('nothing leads the host: relayed to the Mac as before', async () => {
    leader.leads.clear()
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { status: 'resolved', requestId: 'perm-1', allow: true } })
    const res = await request(createApp()).post(`/api/v1/sessions/${B}/permission`).send({ requestId: 'perm-1', allow: true })
    expect(res.body).toEqual({ status: 'resolved', requestId: 'perm-1', allow: true })
    expect(macCalls()).toHaveLength(1)
    expect(hostCalls('devbox')).toHaveLength(0)
  })

  it('a session on the Mac itself, or another agent\'s session on the led host: relayed to the Mac', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    for (const sid of [M, X]) {
      const res = await request(createApp()).post(`/api/v1/sessions/${sid}/permission`).send({ requestId: 'perm-1', allow: true })
      expect(res.status).toBe(503)
      const stop = await request(createApp()).post(`/api/v1/sessions/${sid}/terminate`).send({})
      expect(stop.status).toBe(503)
    }
    expect(hostCalls('devbox')).toHaveLength(0)
  })
})
