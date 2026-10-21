import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-send', { CLOUD_MODE: true }))
const h = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn(), capability: true, host: 'devbox', stop: undefined as { id: string; state: string } | undefined }))
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeHasCapability: () => h.capability,
  bridgeRequest: h.request,
  bridgeRequestPrepared: (host: string, cmd: string, encoded: string, timeout: number) => h.request(host, cmd, JSON.parse(encoded), timeout),
  BridgeOfflineError: class BridgeOfflineError extends Error {},
}))
vi.mock('../../../src/core/sessions/cloud-session-host.js', () => ({
  resolveCloudSessionHost: async () => { h.lookup(); return { host: h.host, stopRequest: h.stop } },
}))
import { WALNUT_HOME } from '../../../src/constants.js'
import { createBridgeSendRouter } from '../../../src/web/routes/bridge-send.js'
import { BridgeOfflineError } from '../../../src/web/ws/bridge-registry.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { _closeCloudSessionPayloadWorkersForTesting } from '../../../src/lib/cloud-session-payload.js'

const token = crypto.randomBytes(16).toString('hex')
const phone = crypto.randomBytes(16).toString('hex')
const other = crypto.randomBytes(16).toString('hex')
const payload = {
  host: 'devbox', sessionId: 'session-a', message: 'a queued notification',
  uuid: 'aaaaaaaa-1111-4111-8111-111111111111',
  markers: [{ message: 'a queued notification', messageId: 'qm-notice-a' }], stopFence: null,
}
const app = express().use('/bridge/send', createBridgeSendRouter())
const send = (body: unknown = payload, bearer = token) => request(app).post('/bridge/send').set('Authorization', `Bearer ${bearer}`).send(body)

beforeEach(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { id: 'primary', name: 'bridge-local', kind: 'machine', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString() },
    { id: 'phone', name: 'phone', kind: 'device', tokenHash: crypto.createHash('sha256').update(phone).digest('hex'), createdAt: new Date().toISOString() },
    { id: 'other', name: 'bridge-other', kind: 'machine', tokenHash: crypto.createHash('sha256').update(other).digest('hex'), createdAt: new Date().toISOString() },
  ] }))
  _resetDeviceAuthForTesting()
  _resetAuthRateLimitForTesting()
  h.request.mockReset().mockResolvedValue({ ok: true })
  h.lookup.mockReset()
  h.capability = true
  h.host = 'devbox'
  h.stop = undefined
})
afterEach(async () => {
  await _closeCloudSessionPayloadWorkersForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('the primary sends through its companion without SSH', () => {
  it('passes the original UUID, markers and fence to one deduplicated send', async () => {
    const res = await send()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(h.request.mock.calls).toEqual([['devbox', 'send', {
      sid: payload.sessionId, message: payload.message, uuid: payload.uuid, markers: payload.markers, stopFence: null, dedupe: true,
    }, 20_000]])
  })

  it.each([phone, other])('refuses a valid credential that is not the primary machine', async (bearer) => {
    expect((await send(payload, bearer)).status).toBe(403)
    expect(h.request).not.toHaveBeenCalled()
  })

  it('refuses a missing credential before parsing the body', async () => {
    const res = await request(app).post('/bridge/send').set('Content-Type', 'application/json').send('{')
    expect(res.status).toBe(401)
    expect(h.request).not.toHaveBeenCalled()
  })

  it.each([
    { host: '__local__' }, { host: '__cloudbox__' }, { host: 'bad/host' }, { sessionId: '../bad' },
    { uuid: 'invalid' }, { message: '   ' }, { message: 42 }, { markers: [] }, { stopFence: undefined },
    { markers: [{ message: 42, messageId: 'qm-a' }] }, { markers: [{ message: 'hello', messageId: '../bad' }] },
    { lostPid: 1 }, { lostPid: 1.5 }, { host: 'wrong-host' },
  ])('rejects invalid or mismatched delivery inputs without sending', async (change) => {
    const res = await send({ ...payload, ...change })
    expect([400, 409]).toContain(res.status)
    expect(res.body.sent).toBe(false)
    expect(h.request).not.toHaveBeenCalled()
  })

  it.each([600 * 1024, 2 * 1024 * 1024])('accepts %i message bytes and more than a hundred queued markers without truncation', async (size) => {
    const message = 'x'.repeat(size) + String.fromCodePoint(0x4e2d, 0x6587)
    const markers = Array.from({ length: 150 }, (_, i) => ({ message: `line ${i}`, messageId: `qm-batch-${i}` }))
    const res = await send({ ...payload, message, markers })
    expect(res.status).toBe(200)
    expect(h.request.mock.calls[0][2]).toMatchObject({ message, markers })
  })

  it('refuses malformed JSON and ignores non-parameter keys without forwarding them', async () => {
    expect((await request(app).post('/bridge/send').set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json').send('{')).status).toBe(400)
    expect(h.request).not.toHaveBeenCalled()
    expect((await send({ ...payload, id: 700, cmd: 'stop', markers: [{ ...payload.markers[0], cmd: 'start' }] })).status).toBe(200)
    expect(h.request.mock.calls[0][2]).toEqual({
      sid: payload.sessionId, message: payload.message, uuid: payload.uuid, markers: payload.markers, stopFence: null, dedupe: true,
    })
  })

  it('refuses an older host that cannot deduplicate, then recovers when it advertises support', async () => {
    h.capability = false
    expect((await send()).body).toMatchObject({ sent: false })
    expect(h.request).not.toHaveBeenCalled()
    h.capability = true
    expect((await send()).body).toEqual({ ok: true })
  })

  it('preserves a daemon duplicate outcome without a second path', async () => {
    h.request.mockResolvedValue({ ok: true, duplicate: true, fate: 'waiting', state: 'queued' })
    expect((await send()).body).toEqual({ ok: true, duplicate: true, fate: 'waiting', state: 'queued' })
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  it('the host judges the fence even when the companion still lists an older stop', async () => {
    h.stop = { id: 'old-stop', state: 'confirmed' }
    expect((await send({ ...payload, stopFence: 'new-stop' })).body).toEqual({ ok: true })
    expect(h.request.mock.calls[0][2].stopFence).toBe('new-stop')
    h.request.mockResolvedValueOnce({ ok: false, reason: 'session_stopped' })
    expect((await send()).body).toEqual({ ok: false, reason: 'session_stopped' })
  })

  it('an unanswered stop requested through the companion holds the line without a terminal refusal', async () => {
    const { noteStopRequested } = await import('../../../src/core/sessions/cloud-stop-fence.js')
    await noteStopRequested(payload.sessionId)
    const res = await send()
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'stop_pending', sent: false })
    expect(h.request).not.toHaveBeenCalled()
  })

  it('accepts the queued subtask notice id and a dotted host alias', async () => {
    h.host = 'dev.box'
    const res = await send({ ...payload, host: 'dev.box', markers: [{ message: payload.message, messageId: 'sn-child-stopped' }] })
    expect(res.body).toEqual({ ok: true })
    expect(h.request.mock.calls[0][2].markers[0].messageId).toBe('sn-child-stopped')
  })

  it('preserves proof that the CLI read past a line so the host can rewrite it', async () => {
    expect((await send({ ...payload, lostPid: 1234 })).body).toEqual({ ok: true })
    expect(h.request.mock.calls[0][2].lostPid).toBe(1234)
    expect((await send({ ...payload, lostPid: -1 })).status).toBe(400)
  })

  it('answers only a permission request through the narrow daemon command', async () => {
    const body = { host: payload.host, sessionId: payload.sessionId, requestId: 'permission-a', allow: true, answers: { Choice: 'Proceed' } }
    const res = await request(app).post('/bridge/send/permission').set('Authorization', `Bearer ${token}`).send(body)
    expect(res.status).toBe(200)
    expect(h.request.mock.calls[0]).toEqual(['devbox', 'session.permission', {
      sid: payload.sessionId, requestId: 'permission-a', allow: true, answers: body.answers,
    }, 20_000])
    expect((await request(app).post('/bridge/send/permission').set('Authorization', `Bearer ${phone}`).send(body)).status).toBe(403)
    expect((await request(app).post('/bridge/send/permission').set('Authorization', `Bearer ${token}`).send({ ...body, allow: 'yes' })).status).toBe(400)
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  it('subtracts host resolution time from the daemon send deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    h.lookup.mockImplementationOnce(() => { now.mockReturnValue(10_000) })
    try {
      expect((await send()).status).toBe(200)
      expect(h.request.mock.calls[0][3]).toBe(12_000)
    } finally { now.mockRestore() }
  })

  it('distinguishes no bridge from a send whose answer was lost', async () => {
    h.request.mockRejectedValueOnce(new BridgeOfflineError('devbox'))
    expect((await send()).body).toEqual({ error: 'host_unavailable', sent: false })
    h.request.mockRejectedValueOnce(new Error('bridge request timed out'))
    expect((await send()).body).toEqual({ error: 'delivery_unconfirmed', sent: true })
    h.request.mockResolvedValueOnce({ ok: true, duplicate: true, fate: 'ran' })
    expect((await send()).body).toEqual({ ok: true, duplicate: true, fate: 'ran' })
  })
})
