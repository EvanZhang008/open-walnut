/**
 * Revoking a pairing must revoke its PUSH rows — on the box that holds them.
 *
 * The privacy contract: a revoked or lost phone can no longer log in, but a push
 * row that outlives the revoke keeps delivering letter subjects and up to 300
 * characters of preview to its lock screen. Two routes revoke a pairing and both
 * have to do this:
 *   DELETE /api/devices/:name     (device tokens — the route an iPhone pairs with)
 *   DELETE /api/auth/keys/:name   (API keys)
 *
 * This is the PRIMARY-side half (rows are local). The replica half — relaying
 * `server.push.revoke-device` and reporting `pending` when the bridge is down —
 * lives in push-relay-cloud.test.ts.
 *
 * Historical note this pins: `DELETE /api/devices/:name` never touched push rows
 * at all, and the auth-keys route did it with a non-atomic read-then-write that a
 * concurrent registration could clobber. Both now go through the registry's
 * locked read-modify-write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-device-revoke-push'))

import express from 'express'
import request from 'supertest'
import { devicesRouter } from '../../../src/web/routes/devices.js'
import { authRouter } from '../../../src/web/routes/auth.js'
import { pushRouter } from '../../../src/web/routes/push.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { registerPushToken } from '../../../src/core/push/registry.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import type { PushTokenEntry } from '../../../src/core/types.js'

const TOKEN = 'e'.repeat(64)
const OTHER = 'f'.repeat(64)

function createApp(deviceName?: string) {
  const app = express()
  app.use(express.json())
  if (deviceName) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { deviceName?: string }).deviceName = deviceName
      next()
    })
  }
  app.use('/api/devices', devicesRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/push', pushRouter)
  app.use(errorHandler)
  return app
}

async function rows(): Promise<PushTokenEntry[]> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    return ((yaml.load(raw) ?? {}) as { push_tokens?: PushTokenEntry[] }).push_tokens ?? []
  } catch {
    return []
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('DELETE /api/devices/:name', () => {
  it('revokes the device AND its push rows', async () => {
    await createDevice('iPhone')
    await registerPushToken({ token: TOKEN, platform: 'ios', keyName: 'iPhone' })
    expect(await rows()).toHaveLength(1)

    const res = await request(createApp()).delete('/api/devices/iPhone')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, pushTokensRevoked: 1 })
    expect(res.body.pushRevokePending).toBeUndefined()
    expect(await rows()).toHaveLength(0)
  })

  it('leaves another device\'s push row registered', async () => {
    await createDevice('iPhone')
    await createDevice('iPad')
    await registerPushToken({ token: TOKEN, platform: 'ios', keyName: 'iPhone' })
    await registerPushToken({ token: OTHER, platform: 'ios', keyName: 'iPad' })

    await request(createApp()).delete('/api/devices/iPhone')
    const left = await rows()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ token: OTHER, key_name: 'iPad' })
  })

  it('404s for an unknown device without touching any row', async () => {
    await createDevice('iPhone')
    await registerPushToken({ token: TOKEN, platform: 'ios', keyName: 'iPhone' })
    const res = await request(createApp()).delete('/api/devices/ghost')
    expect(res.status).toBe(404)
    expect(await rows()).toHaveLength(1)
  })
})

describe('the signal a client uses to notice it is not really registered', () => {
  it('POST /api/push/preferences answers 404 device_not_registered', async () => {
    // A phone that already recorded "token uploaded" (against an older build, or
    // another box) has exactly one cheap way to find out it is wrong: change the
    // mode and read this code. It must be machine-readable, not a bare 404.
    const res = await request(createApp('iPhone')).post('/api/push/preferences')
      .send({ mode: 'when-inactive' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('device_not_registered')
    expect(res.body.error.message).toMatch(/register it again/i)
  })

  it('and GET /api/push/status separates "some phone" from "this phone"', async () => {
    await registerPushToken({ token: OTHER, platform: 'ios', keyName: 'someOtherPhone' })
    const res = await request(createApp('iPhone')).get('/api/push/status')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ registered: true, registeredThisDevice: false })
    expect(res.body.thisDevice).toBeUndefined()
  })

  it('stops answering 404 once the device registers', async () => {
    const app = createApp('iPhone')
    await request(app).post('/api/push/register')
      .send({ token: TOKEN, platform: 'ios', environment: 'production' })
    const res = await request(app).post('/api/push/preferences').send({ mode: 'when-inactive' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, mode: 'when-inactive' })
  })
})

describe('DELETE /api/auth/keys/:name', () => {
  it('revokes the key AND its push rows', async () => {
    await updateConfig({
      api_keys: [{ name: 'script', key: 'wlnt_sk_test', created_at: new Date().toISOString() }],
    })
    await registerPushToken({ token: TOKEN, platform: 'ios', keyName: 'script' })

    const res = await request(createApp()).delete('/api/auth/keys/script')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, pushTokensRevoked: 1 })
    expect(await rows()).toHaveLength(0)
    // The key itself is gone too (the delete still does its original job).
    const list = await request(createApp()).get('/api/auth/keys')
    expect(list.body).toEqual([])
  })

  it('preserves unrelated config sections while deleting the row', async () => {
    await updateConfig({
      api_keys: [{ name: 'script', key: 'wlnt_sk_test', created_at: new Date().toISOString() }],
      stt: { engine: 'mlx' },
    })
    await registerPushToken({ token: TOKEN, platform: 'ios', keyName: 'script' })
    await request(createApp()).delete('/api/auth/keys/script')

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    const parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>
    expect(parsed.push_tokens).toEqual([])
    expect(parsed.stt).toMatchObject({ engine: 'mlx' })
  })
})
