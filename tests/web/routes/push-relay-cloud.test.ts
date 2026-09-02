/**
 * /api/push/* on a CLOUD REPLICA — every route relays to the primary.
 *
 * The bug this pins: the phone pairs with the replica, so `POST /api/push/register`
 * landed there and wrote the REPLICA's `config.yaml` — a file that is permanently
 * excluded from data sync. The token therefore lived on the one box that never
 * sends (the primary holds the APNs key and runs the letter-push subscriber), and
 * nothing logged it. A letter a day for weeks produced zero pushes.
 *
 * Contract under test:
 *   - register / unregister / preferences / active / status all relay over the
 *     EXISTING bridge as `server.push.*`, with the replica's authenticated device
 *     name forwarded as `keyName` so one phone keeps one row on the primary.
 *   - a replica NEVER writes a token row locally, on any path, including failures.
 *   - bridge down answers an honest 503 + `retry: true`, never a fake 200 (iOS
 *     records a token as uploaded only on 2xx, so a fake 200 loses it forever).
 *   - a primary that predates the relay reads as 503 needs-upgrade, not a 4xx the
 *     client would treat as its own fault.
 *   - a domain rejection (bad token) passes the primary's status through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-push-relay-cloud', { CLOUD_MODE: true }))

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
import {
  pushRouter, resetPushRouteWarningsForTests, revokePushTokensForDevice,
} from '../../../src/web/routes/push.js'
import { handlePushRelayAction } from '../../../src/core/push/relay.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'

const TOKEN = 'a'.repeat(64)

/** Stands in for authMiddleware: the phone's paired identity on THIS box. */
function createApp(deviceName = 'iPhone') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { deviceName?: string }).deviceName = deviceName
    next()
  })
  app.use('/api/push', pushRouter)
  app.use(errorHandler)
  return app
}

/** The one frame the relay is supposed to put on the wire. */
function relayCall(index = 0) {
  const call = bridgeRequestMock.mock.calls[index]
  return {
    hostAlias: call?.[0] as string,
    command: call?.[1] as string,
    frame: call?.[2] as { action: string; sessionId: string; params: Record<string, unknown> },
  }
}

/** Whatever the replica may have persisted locally (it must be nothing). */
async function localConfigText(): Promise<string> {
  try {
    return await fs.readFile(CONFIG_FILE, 'utf-8')
  } catch {
    return ''
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  resetPushRouteWarningsForTests()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/push/register on a replica', () => {
  it('relays to the primary and stores nothing locally', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true, result: { ok: true, kind: 'apns', mode: 'always', deliverable: true },
    })
    const res = await request(createApp()).post('/api/push/register')
      .send({ token: TOKEN, platform: 'ios', environment: 'production', mode: 'always' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, kind: 'apns', deliverable: true })

    const { hostAlias, command, frame } = relayCall()
    expect(hostAlias).toBe('__local__')
    expect(command).toBe('session.control')
    expect(frame.action).toBe('server.push.register')
    expect(frame.sessionId).toBe('__server__')
    expect(frame.params).toMatchObject({
      token: TOKEN, platform: 'ios', environment: 'production', mode: 'always',
      // The device identity the REPLICA authenticated, forwarded so the primary
      // scopes the row to this phone (and its rotated tokens) and not another.
      keyName: 'iPhone',
    })

    expect(await localConfigText()).not.toContain('push_tokens')
    expect(await localConfigText()).not.toContain(TOKEN)
  })

  it('re-registering the same token sends the same relay, still writing nothing', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true, result: { ok: true, kind: 'apns', mode: 'always', deliverable: true },
    })
    const app = createApp()
    const body = { token: TOKEN, platform: 'ios', environment: 'production' }
    await request(app).post('/api/push/register').send(body)
    await request(app).post('/api/push/register').send(body)

    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    expect(relayCall(0).frame.params).toEqual(relayCall(1).frame.params)
    expect(await localConfigText()).not.toContain(TOKEN)
  })

  it('answers 503 + retry when the bridge is down, and does not keep the token', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).post('/api/push/register')
      .send({ token: TOKEN, platform: 'ios', environment: 'production' })

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(res.body.retry).toBe(true)
    expect(res.body.error.message).toMatch(/primary box is offline/i)
    // The honest half: nothing was stored anywhere, so the app must send it again.
    expect(await localConfigText()).not.toContain(TOKEN)
  })

  it('answers 503 needs-upgrade when the primary predates the action', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: false, error: 'Unknown control action: server.push.register', errorKind: 'bad_request',
    })
    const res = await request(createApp()).post('/api/push/register')
      .send({ token: TOKEN, platform: 'ios', environment: 'production' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('primary_needs_upgrade')
    expect(res.body.retry).toBe(true)
  })

  it('passes a domain rejection through with the primary\'s status', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: false,
      error: 'Token is not a valid APNs (hex) or Expo push token',
      errorKind: 'bad_request',
    })
    const res = await request(createApp()).post('/api/push/register')
      .send({ token: 'nope', platform: 'ios' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(res.body.error.message).toMatch(/not a valid APNs/)
    expect(res.body.retry).toBeUndefined()
  })
})

describe('the sibling routes on a replica', () => {
  it('DELETE /register relays as server.push.unregister', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { ok: true, removed: 1 } })
    const res = await request(createApp()).delete('/api/push/register').send({ token: TOKEN })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(relayCall().frame).toMatchObject({
      action: 'server.push.unregister', params: { token: TOKEN },
    })
  })

  it('POST /preferences relays with the device identity', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true, result: { ok: true, mode: 'when-inactive' },
    })
    const res = await request(createApp('phone-2')).post('/api/push/preferences')
      .send({ mode: 'when-inactive', letterTypes: ['action_required'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, mode: 'when-inactive' })
    expect(relayCall().frame).toMatchObject({
      action: 'server.push.preferences',
      params: { mode: 'when-inactive', letterTypes: ['action_required'], keyName: 'phone-2' },
    })
  })

  it('passes device_not_registered through — the app\'s cue that its token never landed', async () => {
    // The self-heal signal has to survive the bridge: a phone that believes it
    // uploaded (its own UserDefaults say so) learns otherwise from this code.
    bridgeRequestMock.mockResolvedValue({
      ok: false,
      error: 'This device has no registered push token — register it again',
      errorKind: 'not_found',
      errorCode: 'device_not_registered',
    })
    const res = await request(createApp()).post('/api/push/preferences').send({ mode: 'always' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('device_not_registered')
  })

  it('POST /active relays the lease', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true, result: { ok: true, applied: true, leaseMs: 90_000 },
    })
    const res = await request(createApp()).post('/api/push/active').send({ active: false })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, applied: true })
    expect(relayCall().frame).toMatchObject({
      action: 'server.push.active', params: { active: false, keyName: 'iPhone' },
    })
  })

  it('GET /status reports the PRIMARY\'s registry, marked as relayed', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      result: {
        registered: true, count: 1,
        apns: { configured: true, environment: 'production', topic: 'test.topic' },
        tokens: [{ platform: 'ios', kind: 'apns', key_name: 'iPhone', token_prefix: 'aaaaaaaaaaaa...' }],
      },
    })
    const res = await request(createApp()).get('/api/push/status')
    expect(res.status).toBe(200)
    // Answering from the replica's own (empty) rows is the lie that hid the bug.
    expect(res.body).toMatchObject({ registered: true, count: 1, via: 'primary' })
    expect(relayCall().frame).toMatchObject({
      action: 'server.push.status', params: { keyName: 'iPhone' },
    })
  })

  it('GET /status is honest rather than empty when the bridge is down', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/push/status')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(res.body.registered).toBeUndefined()
  })
})

describe('revoking a device on a replica', () => {
  it('relays the revoke so a revoked phone stops receiving letters', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { removed: 1 } })
    const out = await revokePushTokensForDevice('iPhone')
    expect(out).toMatchObject({ removed: 1, relayed: true })
    expect(relayCall().frame).toMatchObject({
      action: 'server.push.revoke-device', params: { keyName: 'iPhone' },
    })
  })

  it('reports pending rather than pretending, when the bridge is down', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const out = await revokePushTokensForDevice('iPhone')
    expect(out.relayed).toBe(false)
    // The caller surfaces this as `pushRevokePending: true` — the phone may still
    // buzz, and saying nothing would be the privacy failure.
    expect(out.pending).toBeTruthy()
  })

  it('also sweeps orphan local rows left by a pre-relay build', async () => {
    await fs.writeFile(CONFIG_FILE, [
      'push_tokens:',
      `  - token: ${TOKEN}`,
      '    platform: ios',
      '    kind: apns',
      '    key_name: iPhone',
      "    registered_at: '2026-08-01T00:00:00.000Z'",
      '',
    ].join('\n'), 'utf-8')
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { removed: 0 } })
    const out = await revokePushTokensForDevice('iPhone')
    expect(out.removed).toBe(1)
    expect(await localConfigText()).not.toContain(TOKEN)
  })
})

describe('the primary-side handler refuses to run on a replica', () => {
  it('throws instead of writing this box\'s config', async () => {
    // "The replica stores nothing" by construction, not by trusting the daemon to
    // route these actions elsewhere.
    await expect(handlePushRelayAction('register', {
      token: TOKEN, platform: 'ios', keyName: 'iPhone',
    })).rejects.toMatchObject({ status: 500, code: 'wrong_box' })
    expect(await localConfigText()).not.toContain(TOKEN)
  })
})

describe('replica hygiene', () => {
  it('warns once about orphan rows a pre-relay build left behind', async () => {
    // A row exactly like the broken code used to write on this box.
    await fs.writeFile(CONFIG_FILE, [
      'push_tokens:',
      `  - token: ${TOKEN}`,
      '    platform: ios',
      '    kind: apns',
      '    key_name: iPhone',
      "    registered_at: '2026-08-01T00:00:00.000Z'",
      '',
    ].join('\n'), 'utf-8')
    bridgeRequestMock.mockResolvedValue({
      ok: true, result: { ok: true, kind: 'apns', mode: 'always', deliverable: true },
    })
    const res = await request(createApp()).post('/api/push/register')
      .send({ token: TOKEN, platform: 'ios', environment: 'production' })
    expect(res.status).toBe(200)
    // Still a pass-through: the relay is the only writer, so the orphan row is
    // reported (see the log line) and left untouched rather than re-used.
    const after = await localConfigText()
    expect(after).toContain(TOKEN)
    expect(path.basename(CONFIG_FILE)).toBe('config.yaml')
  })
})
