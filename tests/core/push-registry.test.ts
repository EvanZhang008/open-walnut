/**
 * The push token registry — the PRIMARY's single store for device tokens.
 *
 * Contract under test (each line here was a real failure mode of the split-brain
 * bug that made iOS letter pushes impossible):
 *   - a registration lands in `config.push_tokens` on THIS box, and re-registering
 *     the same token upserts instead of duplicating.
 *   - a second token from the SAME authenticated device replaces the first (APNs
 *     rotates tokens on reinstall; keeping both pushes to a dead one forever).
 *   - an unauthenticated (trusted-LAN) registration cannot sweep another device's
 *     row, because it carries no identity to key on.
 *   - a malformed token is refused, never stored.
 *   - preferences / the foreground lease are scoped to the calling device, and
 *     answer 404 rather than a fake success when that device has no row.
 *   - the status readout never exposes a full token (it is a send capability).
 *
 * Real config file in a temp dir (this IS the store under test); only the APNs
 * sender is stubbed, so nothing leaves the box.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-push-registry'))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns: vi.fn(async () => ({ attempted: true, sent: 1, failed: 0, deadTokens: [] })),
  apnsStatus: vi.fn(async () => ({
    configured: true, environment: 'production', topic: 'test.topic',
  })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import {
  PushRegistryError,
  localTokenCount,
  pushRegistrationStatus,
  registerPushToken,
  reportDeviceActive,
  revokeDevicePushTokens,
  setDevicePushPreferences,
  unregisterPushToken,
} from '../../src/core/push/registry.js'
import { apnsStatus } from '../../src/core/push/apns.js'
import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import type { PushTokenEntry } from '../../src/core/types.js'

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

async function rows(): Promise<PushTokenEntry[]> {
  const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
  const parsed = (yaml.load(raw) ?? {}) as { push_tokens?: PushTokenEntry[] }
  return parsed.push_tokens ?? []
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  vi.mocked(apnsStatus).mockResolvedValue({
    configured: true, environment: 'production', topic: 'test.topic',
  })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('registerPushToken', () => {
  it('stores the token in this box\'s config and reports deliverability', async () => {
    const out = await registerPushToken({
      token: TOKEN_A, platform: 'ios', environment: 'production', keyName: 'iPhone',
    })
    expect(out).toEqual({ ok: true, kind: 'apns', mode: 'always', deliverable: true })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      token: TOKEN_A, platform: 'ios', kind: 'apns',
      environment: 'production', key_name: 'iPhone', mode: 'always',
    })
    expect(await localTokenCount()).toBe(1)
  })

  it('is idempotent — the same token twice is one row', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    expect(await rows()).toHaveLength(1)
  })

  it('preserves a mode the user chose when the app re-registers without one', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone', mode: 'when-inactive' })
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    expect((await rows())[0]?.mode).toBe('when-inactive')
  })

  it('a rotated token from the same device replaces the old row', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    await registerPushToken({ token: TOKEN_B, platform: 'ios', keyName: 'iPhone' })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.token).toBe(TOKEN_B)
  })

  it('keeps both rows when the requests carry no device identity', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: null })
    await registerPushToken({ token: TOKEN_B, platform: 'ios', keyName: null })
    expect(await rows()).toHaveLength(2)
  })

  it('a same-name device from the OTHER box does not delete the first phone\'s row', async () => {
    // The collision the relay newly makes possible: names are unique only within
    // the box that issued them, and deleting the other row silently drops that
    // phone out of every future send.
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone', origin: 'local' })
    await registerPushToken({ token: TOKEN_B, platform: 'ios', keyName: 'iPhone', origin: 'relay' })
    const stored = await rows()
    expect(stored).toHaveLength(2)
    expect(stored.map((t) => t.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort())
    expect(stored.map((t) => t.origin).sort()).toEqual(['local', 'relay'])
  })

  it('a rotated token still replaces the row from the SAME box', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone', origin: 'relay' })
    await registerPushToken({ token: TOKEN_B, platform: 'ios', keyName: 'iPhone', origin: 'relay' })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ token: TOKEN_B, origin: 'relay' })
  })

  it('treats a legacy row with no origin as local', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    expect((await rows())[0]?.origin).toBe('local')
    // A relayed registration must not sweep it (different box, same name).
    await registerPushToken({ token: TOKEN_B, platform: 'ios', keyName: 'iPhone', origin: 'relay' })
    expect(await rows()).toHaveLength(2)
  })

  it('reports deliverable:false — stored, but this box has no APNs key', async () => {
    vi.mocked(apnsStatus).mockResolvedValue({
      configured: false, reason: 'APNs auth key not configured (missing key_id)',
      environment: 'production', topic: 'test.topic',
    })
    const out = await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    expect(out.deliverable).toBe(false)
    expect(await rows()).toHaveLength(1)
  })

  it('refuses a malformed token and an unknown platform, storing nothing', async () => {
    await expect(registerPushToken({ token: 'nope', platform: 'ios' }))
      .rejects.toBeInstanceOf(PushRegistryError)
    await expect(registerPushToken({ token: '', platform: 'ios' }))
      .rejects.toMatchObject({ status: 400 })
    await expect(registerPushToken({ token: TOKEN_A, platform: 'watchos' }))
      .rejects.toMatchObject({ status: 400 })
    expect(await localTokenCount()).toBe(0)
  })

  it('accepts a legacy Expo token as kind expo (deliverable without an APNs key)', async () => {
    vi.mocked(apnsStatus).mockResolvedValue({
      configured: false, reason: 'no key', environment: 'production', topic: 't',
    })
    const out = await registerPushToken({
      token: 'ExponentPushToken[abc123]', platform: 'ios', keyName: 'oldPhone',
    })
    expect(out.kind).toBe('expo')
    expect(out.deliverable).toBe(true)
  })
})

describe('unregisterPushToken', () => {
  it('removes the row and is a no-op for an unknown token', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    expect(await unregisterPushToken(TOKEN_A)).toEqual({ ok: true, removed: 1 })
    expect(await rows()).toHaveLength(0)
    expect(await unregisterPushToken(TOKEN_A)).toEqual({ ok: true, removed: 0 })
  })

  it('rejects a missing token', async () => {
    await expect(unregisterPushToken(undefined)).rejects.toMatchObject({ status: 400 })
  })
})

describe('revokeDevicePushTokens', () => {
  it('drops that device\'s rows so a revoked phone stops receiving letters', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    expect(await revokeDevicePushTokens('iPhone')).toEqual({ removed: 1 })
    expect(await rows()).toHaveLength(0)
    // Idempotent: revoking twice is not an error.
    expect(await revokeDevicePushTokens('iPhone')).toEqual({ removed: 0 })
  })

  it('only touches the rows from the box that revoked the pairing', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone', origin: 'local' })
    await registerPushToken({ token: TOKEN_B, platform: 'ios', keyName: 'iPhone', origin: 'relay' })
    // A replica revoking its own pairing must not unregister the phone that is
    // still paired directly with the primary.
    expect(await revokeDevicePushTokens('iPhone', 'relay')).toEqual({ removed: 1 })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ token: TOKEN_A, origin: 'local' })
  })
})

describe('preferences and the foreground lease', () => {
  it('scopes to the calling device and 404s when it has no row', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    await expect(setDevicePushPreferences('someoneElse', { mode: 'when-inactive' }))
      .rejects.toMatchObject({ status: 404, code: 'device_not_registered' })
    // Same 404 for a name this box knows but from the OTHER box's name space.
    await expect(setDevicePushPreferences('iPhone', { mode: 'when-inactive' }, 'relay'))
      .rejects.toMatchObject({ status: 404, code: 'device_not_registered' })
    const out = await setDevicePushPreferences('iPhone', {
      mode: 'when-inactive', letterTypes: ['action_required'],
    })
    expect(out).toEqual({ ok: true, mode: 'when-inactive', letterTypes: ['action_required'] })
    expect((await rows())[0]).toMatchObject({
      mode: 'when-inactive', letter_types: ['action_required'],
    })
  })

  it('requires a device identity', async () => {
    await expect(setDevicePushPreferences(null, { mode: 'always' }))
      .rejects.toMatchObject({ status: 400 })
    await expect(reportDeviceActive(null, true)).rejects.toMatchObject({ status: 400 })
  })

  it('writes the lease only for when-inactive devices, and releases it', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    // `always` never reads the value, so the write is skipped entirely.
    expect(await reportDeviceActive('iPhone', true)).toMatchObject({ applied: false })
    expect((await rows())[0]?.active_at).toBeUndefined()

    await setDevicePushPreferences('iPhone', { mode: 'when-inactive' })
    expect(await reportDeviceActive('iPhone', true)).toMatchObject({ applied: true })
    expect(typeof (await rows())[0]?.active_at).toBe('number')

    await reportDeviceActive('iPhone', false)
    expect((await rows())[0]?.active_at).toBeUndefined()
  })
})

describe('pushRegistrationStatus', () => {
  it('reports registration + credential state without leaking a token', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'iPhone' })
    const status = await pushRegistrationStatus('iPhone') as {
      registered: boolean
      registeredThisDevice: boolean
      count: number
      apns: { configured: boolean }
      thisDevice?: { mode: string; kind: string }
      tokens: Array<{ token_prefix: string; key_name: string; origin: string }>
    }
    expect(status.registered).toBe(true)
    expect(status.registeredThisDevice).toBe(true)
    expect(status.tokens[0]?.origin).toBe('local')
    expect(status.count).toBe(1)
    expect(status.apns.configured).toBe(true)
    expect(status.thisDevice).toMatchObject({ mode: 'always', kind: 'apns' })
    expect(status.tokens[0]?.token_prefix).toBe(`${TOKEN_A.slice(0, 12)}...`)
    expect(JSON.stringify(status)).not.toContain(TOKEN_A)
  })

  it('is honest when nothing is registered', async () => {
    const status = await pushRegistrationStatus('iPhone') as { registered: boolean; count: number }
    expect(status).toMatchObject({ registered: false, registeredThisDevice: false, count: 0 })
  })

  it('separates "some phone is registered" from "THIS phone is" — the self-heal signal', async () => {
    await registerPushToken({ token: TOKEN_A, platform: 'ios', keyName: 'otherPhone' })
    const status = await pushRegistrationStatus('iPhone') as {
      registered: boolean; registeredThisDevice: boolean; thisDevice?: unknown
    }
    // A client that only reads `registered` concludes it is set up when it is not.
    expect(status.registered).toBe(true)
    expect(status.registeredThisDevice).toBe(false)
    expect(status.thisDevice).toBeUndefined()
  })
})
