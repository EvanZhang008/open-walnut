/**
 * Send-time check (core/push/paired-rows.ts): a push row whose device is no
 * longer paired is never sent, and is pruned.
 *
 * Revoking removes the rows (device-auth.ts `revokePairing`), but a row can
 * outlive its pairing where no revoke path sees it: auth.json edited or
 * restored behind the registry's back, a CLI revoke racing a config write. The
 * sender therefore checks each row it can judge (origin `local`, a real device
 * name) against auth.json and the API keys, right before it sends.
 *
 * What must hold:
 *  - an unpaired row gets no APNs send and no Expo request, and is removed;
 *  - a phone that paired again and registered a fresh row meanwhile keeps it
 *    (the prune matches `registered_at` too);
 *  - an auth.json that cannot be read is replaced by its sidecar (auth.json.bak)
 *    as the judge, but what the sidecar finds unpaired is only held back, never
 *    pruned (the sidecar can lag the real file);
 *  - when neither can be read, or config.yaml cannot be (its API keys are
 *    unknown then), nothing is judged: every row is sent and none is pruned (a
 *    broken read must never silence every phone);
 *  - relay rows (paired on the companion) and the anonymous LAN row are not
 *    judged here: this box does not hold their pairings.
 *
 * Real config.yaml and auth.json in the mocked data dir; APNs is stubbed at the
 * module boundary and Expo at `fetch`. Nothing leaves the process.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-push-unpaired-rows'))

const sendApns = vi.hoisted(() => vi.fn(async (targets: Array<{ token: string }>) => ({
  attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[],
})))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import { _resetDeviceAuthForTesting, createDevice } from '../../src/core/device-auth.js'
import { updateConfig, updatePushTokens } from '../../src/core/config-manager.js'
import { deliverPush } from '../../src/core/push/deliver.js'
import { pruneUnpairedRows } from '../../src/core/push/paired-rows.js'
import { log } from '../../src/logging/index.js'
import type { PushTokenEntry } from '../../src/core/types.js'

const PAIRED = '1'.repeat(64)
const REVOKED = '2'.repeat(64)
const RELAY = '3'.repeat(64)
const ANON = '4'.repeat(64)
const API_KEY_ROW = '5'.repeat(64)
const REVOKED_EXPO = 'ExponentPushToken[acme-revoked]'
const CONTENT = { title: 'New letter: Marina trip', body: 'Pack the devbox charger', data: { kind: 'letter' } }

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
/** One fixed time, so the rows the sender reads and the rows on disk match exactly. */
const REGISTERED = at(60)
function row(token: string, keyName: string, over: Partial<PushTokenEntry> = {}): PushTokenEntry {
  return { token, platform: 'ios', key_name: keyName, registered_at: REGISTERED, origin: 'local', ...over }
}

async function setRows(entries: PushTokenEntry[]): Promise<void> {
  await updatePushTokens(() => entries)
}
async function storedTokens(): Promise<string[]> {
  const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
  return (((yaml.load(raw) ?? {}) as { push_tokens?: PushTokenEntry[] }).push_tokens ?? []).map((t) => t.token).sort()
}
const apnsTokens = () => sendApns.mock.calls.flatMap((c) => (c[0] as Array<{ token: string }>).map((t) => t.token)).sort()

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  sendApns.mockClear()
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => new Response(JSON.stringify({
    data: (JSON.parse(init.body) as unknown[]).map(() => ({ status: 'ok' })),
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  await createDevice('acme-phone')
  await updateConfig({ api_keys: [{ name: 'acme-script', key: 'wlnt_sk_test', created_at: at(120) }] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Every kind of row, with the revoked device's two rows (APNs and Expo) among them. */
function allRows(): PushTokenEntry[] {
  return [
    row(PAIRED, 'acme-phone'),
    row(REVOKED, 'lost-phone'),
    row(REVOKED_EXPO, 'lost-phone'),
    row(RELAY, 'cloud-only-phone', { origin: 'relay' }),
    row(ANON, 'localhost'),
    row(API_KEY_ROW, 'acme-script'),
  ]
}

describe('a row whose device was revoked behind the registry\'s back', () => {
  it('is never sent (no APNs send, no Expo request) and is pruned; every other row is sent and kept', async () => {
    await setRows(allRows())
    const outcome = await deliverPush(allRows(), CONTENT)
    expect(apnsTokens()).toEqual([PAIRED, RELAY, ANON, API_KEY_ROW].sort())
    expect(fetchMock).not.toHaveBeenCalled() // the only Expo row was the revoked one
    expect(outcome).toMatchObject({ unpaired: 2, apns: 4, expo: 0, sent: 4 })
    expect(await storedTokens()).toEqual([PAIRED, RELAY, ANON, API_KEY_ROW].sort())
  })

  it('and once pruned, the next push does not see it at all', async () => {
    await setRows(allRows())
    await deliverPush(allRows(), CONTENT)
    sendApns.mockClear()
    const next = (await storedTokens()).map((t) => allRows().find((r) => r.token === t)!)
    const outcome = await deliverPush(next, CONTENT)
    expect(outcome.unpaired).toBe(0)
    expect(apnsTokens()).not.toContain(REVOKED)
  })

  it('a phone that paired again and registered a fresh row in the meantime keeps it', async () => {
    const stale = row(REVOKED, 'lost-phone')
    // Between the send-time read and the prune: the phone re-pairs and registers again.
    await createDevice('lost-phone')
    await setRows([row(PAIRED, 'acme-phone'), row(REVOKED, 'lost-phone', { registered_at: at(0) })])
    await pruneUnpairedRows([stale])
    expect(await storedTokens()).toEqual([PAIRED, REVOKED].sort())
  })

  it('a relay row with the same token and name as a stale local row is not pruned with it', async () => {
    const stale = row(REVOKED, 'lost-phone')
    await setRows([stale, { ...stale, origin: 'relay' }])
    await pruneUnpairedRows([stale])
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { push_tokens: PushTokenEntry[] }
    expect(raw.push_tokens).toEqual([{ ...stale, origin: 'relay' }])
  })
})

const AUTH_DAMAGE = [
  ['corrupt', async (file: string) => { await fs.writeFile(file, '{"devices": [') }],
  ['not a device list', async (file: string) => { await fs.writeFile(file, '{"devices": {}}') }],
  ['missing', async (file: string) => { await fs.rm(file) }],
] as const

describe('when auth.json cannot be read, its sidecar judges, and nothing is deleted', () => {
  for (const [label, damage] of AUTH_DAMAGE) {
    it(`${label}: the revoked device's rows are held back, and every row stays stored`, async () => {
      await setRows(allRows())
      const warn = vi.spyOn(log.notif, 'warn')
      await damage(path.join(WALNUT_HOME, 'auth.json'))
      const outcome = await deliverPush(allRows(), CONTENT)
      expect(outcome.unpaired).toBe(2)
      expect(apnsTokens()).toEqual([PAIRED, RELAY, ANON, API_KEY_ROW].sort())
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await storedTokens()).toEqual(allRows().map((r) => r.token).sort())
      // The warning is throttled per process, so only the first case is sure to see it.
      if (label === 'corrupt') {
        expect(warn).toHaveBeenCalledWith('push: auth.json unreadable, judging rows by auth.json.bak (rows it finds unpaired are held back, not removed)')
      }
    })
  }
})

describe('when neither auth.json nor its sidecar can be read, nothing is judged', () => {
  for (const [label, damage] of AUTH_DAMAGE) {
    it(`${label}, and no usable sidecar: every row is sent, none is pruned, and the skipped check is logged`, async () => {
      await setRows(allRows())
      const file = path.join(WALNUT_HOME, 'auth.json')
      await damage(file)
      await fs.writeFile(`${file}.bak`, '{"devices": [')
      const warn = vi.spyOn(log.notif, 'warn')
      const outcome = await deliverPush(allRows(), CONTENT)
      expect(outcome.unpaired).toBe(0)
      expect(apnsTokens()).toEqual([PAIRED, REVOKED, RELAY, ANON, API_KEY_ROW].sort())
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await storedTokens()).toEqual(allRows().map((r) => r.token).sort())
      if (label === 'corrupt') {
        expect(warn).toHaveBeenCalledWith('push: device registry unreadable, sending without the paired-device check', expect.anything())
      }
    })
  }
})

describe('when config.yaml cannot be read, nothing is judged', () => {
  it('an API key\'s row is not taken for an unpaired device: every row is sent, and the file is left alone', async () => {
    await setRows(allRows())
    // Broken after the sender read its rows: getConfig would now answer DEFAULT_CONFIG, with no API keys.
    const garbage = 'push_tokens: [unclosed\n'
    await fs.writeFile(CONFIG_FILE, garbage)
    const outcome = await deliverPush(allRows(), CONTENT)
    expect(outcome.unpaired).toBe(0)
    expect(apnsTokens()).toEqual([PAIRED, REVOKED, RELAY, ANON, API_KEY_ROW].sort())
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(garbage)
  })
})
