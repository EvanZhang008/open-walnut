/**
 * The lock-screen card's token on the device's push row (src/core/push/registry.ts
 * setDeviceWorkCard, clearWorkCardTokens): scoped to the calling device, refused when the
 * device has no row, cleared only for the card it names, kept across a re-registration, and
 * relayed from a companion like the other push routes.
 *
 * Real config file in a temp dir; the APNs sender is stubbed, so nothing leaves the box.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-push-work-card'))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns: vi.fn(async () => ({ attempted: true, sent: 1, failed: 0, deadTokens: [] })),
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test.topic' })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import {
  PushRegistryError, clearWorkCardTokens, pushRegistrationStatus, registerPushToken, revokeDevicePushTokens, setDeviceWorkCard,
} from '../../src/core/push/registry.js'
import { handlePushRelayAction } from '../../src/core/push/relay.js'
import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import type { PushTokenEntry } from '../../src/core/types.js'

const DEV_A = 'a'.repeat(64)
const DEV_A2 = 'e'.repeat(64)
const DEV_B = 'b'.repeat(64)
const CARD_1 = 'c'.repeat(64)
const CARD_2 = 'd'.repeat(64)

async function rows(): Promise<PushTokenEntry[]> {
  const parsed = (yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) ?? {}) as { push_tokens?: PushTokenEntry[] }
  return parsed.push_tokens ?? []
}
const rowOf = async (name: string) => (await rows()).find((r) => r.key_name === name)

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await registerPushToken({ token: DEV_A, platform: 'ios', keyName: 'iPhone' })
  await registerPushToken({ token: DEV_B, platform: 'ios', keyName: 'iPad' })
})
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

describe('setDeviceWorkCard', () => {
  it('puts the card token on the calling device\'s row only', async () => {
    expect(await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })).toEqual({ ok: true, stored: true })
    expect((await rowOf('iPhone'))?.work_card).toMatchObject({ token: CARD_1, activity_id: 'act-1' })
    expect((await rowOf('iPad'))?.work_card).toBeUndefined()
    // The device token itself is untouched: letters still go to it.
    expect((await rowOf('iPhone'))?.token).toBe(DEV_A)
  })

  it('the same card again writes nothing; a new card replaces the old one', async () => {
    await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })
    expect(await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })).toEqual({ ok: true, stored: false })
    await setDeviceWorkCard('iPhone', { token: CARD_2, activityId: 'act-2' })
    expect((await rowOf('iPhone'))?.work_card).toMatchObject({ token: CARD_2, activity_id: 'act-2' })
  })

  it('a clear takes off only the card it names: a late "ended" of an old card keeps the new one', async () => {
    await setDeviceWorkCard('iPhone', { token: CARD_2, activityId: 'act-2' })
    expect(await setDeviceWorkCard('iPhone', { token: null, activityId: 'act-1' })).toEqual({ ok: true, stored: false })
    expect((await rowOf('iPhone'))?.work_card?.token).toBe(CARD_2)
    expect(await setDeviceWorkCard('iPhone', { token: null, activityId: 'act-2' })).toEqual({ ok: true, stored: true })
    expect((await rowOf('iPhone'))?.work_card).toBeUndefined()
  })

  it('a late token of a card that already ended never comes back, and never takes the newer card\'s place', async () => {
    // Card 1 ends before its own token write arrives; card 2 starts; then card 1's write lands.
    await setDeviceWorkCard('iPhone', { token: null, activityId: 'act-1' })
    await setDeviceWorkCard('iPhone', { token: CARD_2, activityId: 'act-2' })
    expect(await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })).toEqual({ ok: true, stored: false })
    expect((await rowOf('iPhone'))?.work_card).toMatchObject({ token: CARD_2, activity_id: 'act-2' })
  })

  it('a card the server ended is remembered as ended too; the memory stays short', async () => {
    await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })
    await clearWorkCardTokens([CARD_1])
    expect(await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })).toEqual({ ok: true, stored: false })
    for (let i = 2; i <= 9; i++) await setDeviceWorkCard('iPhone', { token: null, activityId: `act-${i}` })
    expect((await rowOf('iPhone'))?.work_card_ended).toEqual(['act-5', 'act-6', 'act-7', 'act-8', 'act-9'])
    // A repeated "ended" writes nothing.
    const before = await fs.readFile(CONFIG_FILE, 'utf-8')
    await setDeviceWorkCard('iPhone', { token: null, activityId: 'act-9' })
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(before)
  })

  it('refuses a device with no row (404 device_not_registered), no device, a bad token or id', async () => {
    await expect(setDeviceWorkCard('Watch', { token: CARD_1, activityId: 'a' })).rejects.toMatchObject({ code: 'device_not_registered', status: 404 })
    await expect(setDeviceWorkCard(null, { token: CARD_1, activityId: 'a' })).rejects.toBeInstanceOf(PushRegistryError)
    for (const token of ['nothex', '', 42, undefined, 'c'.repeat(20)]) {
      await expect(setDeviceWorkCard('iPhone', { token, activityId: 'a' })).rejects.toMatchObject({ status: 400 })
    }
    for (const activityId of ['', 'a b', 'x'.repeat(101), 7, undefined, '../x/y']) {
      await expect(setDeviceWorkCard('iPhone', { token: CARD_1, activityId })).rejects.toMatchObject({ status: 400 })
    }
    expect((await rowOf('iPhone'))?.work_card).toBeUndefined()
  })

  it('outlives a re-registration and a rotated device token of the same phone', async () => {
    await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })
    await registerPushToken({ token: DEV_A, platform: 'ios', keyName: 'iPhone' })
    expect((await rowOf('iPhone'))?.work_card?.token).toBe(CARD_1)
    await registerPushToken({ token: DEV_A2, platform: 'ios', keyName: 'iPhone' })
    const r = await rowOf('iPhone')
    expect(r?.token).toBe(DEV_A2)
    expect(r?.work_card?.token).toBe(CARD_1)
  })

  it('goes with the device when its pairing is revoked, and the card on that lock screen is ended at once', async () => {
    const { sendApns } = await import('../../src/core/push/apns.js')
    vi.mocked(sendApns).mockClear()
    await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })
    await revokeDevicePushTokens('iPhone')
    expect((await rows()).some((r) => r.work_card)).toBe(false)
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalled())
    const [targets, payload, opts] = vi.mocked(sendApns).mock.calls[0] as unknown as [Array<{ token: string }>, { aps: Record<string, unknown> }, Record<string, unknown>]
    expect(targets.map((t) => t.token)).toEqual([CARD_1])
    expect(payload.aps).toMatchObject({ event: 'end' })
    expect(payload.aps['dismissal-date']).toBe(payload.aps.timestamp)
    for (const loud of ['alert', 'sound', 'badge']) expect(payload.aps).not.toHaveProperty(loud)
    expect(opts).toMatchObject({ pushType: 'liveactivity', priority: 10 })
  })

  it('status says whether this box holds the card, never its token', async () => {
    await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })
    const s = await pushRegistrationStatus('iPhone') as { thisDevice?: { workCard?: boolean }; tokens: Array<{ work_card?: boolean }> }
    expect(s.thisDevice?.workCard).toBe(true)
    expect(s.tokens.filter((t) => t.work_card)).toHaveLength(1)
    expect(JSON.stringify(s)).not.toContain(CARD_1)
  })
})

describe('clearWorkCardTokens', () => {
  it('clears the named card tokens on every row and keeps the rest', async () => {
    await setDeviceWorkCard('iPhone', { token: CARD_1, activityId: 'act-1' })
    await setDeviceWorkCard('iPad', { token: CARD_2, activityId: 'act-2' })
    expect(await clearWorkCardTokens([CARD_1])).toBe(1)
    expect((await rowOf('iPhone'))?.work_card).toBeUndefined()
    expect((await rowOf('iPad'))?.work_card?.token).toBe(CARD_2)
    expect((await rows())).toHaveLength(2)
    expect(await clearWorkCardTokens([])).toBe(0)
  })
})

describe('the companion relay', () => {
  it('a relayed write lands on the relayed row of that name, not a local twin', async () => {
    await registerPushToken({ token: DEV_A2, platform: 'ios', keyName: 'iPhone', origin: 'relay' })
    await handlePushRelayAction('work-card', { keyName: 'iPhone', token: CARD_1, activityId: 'act-1' })
    const all = await rows()
    expect(all.find((r) => r.origin === 'relay')?.work_card?.token).toBe(CARD_1)
    expect(all.find((r) => r.token === DEV_A)?.work_card).toBeUndefined()
  })

  it('a relayed write without the device name is refused', async () => {
    await expect(handlePushRelayAction('work-card', { token: CARD_1, activityId: 'a' })).rejects.toMatchObject({ status: 400 })
  })
})
