/**
 * What can happen around a revoke's auth.json write, and why none of it lets
 * a revoked phone keep a push row or come back:
 *
 *  - the revoke queue's drain runs between the write-ahead and the auth.json
 *    write: it judges under the auth lock, so it never takes the revoke for one
 *    that will not land (it used to drop both parts, and the CLI said "queued"
 *    over an empty queue);
 *  - a registration the old token authenticated lands late: before the
 *    auth.json write it is older than the cutoff (the revoke time is taken after
 *    that write); after it, the register route finds the pairing gone (the Mac
 *    checks and writes under the auth lock, so it never writes; the companion
 *    takes its relayed write back, see push-register-takeback.test.ts);
 *  - a revoked token hash is recorded in auth.json for good: it never
 *    authenticates again and is never adopted back from the other box.
 *
 * One process, a private data dir. CLOUD_MODE is a getter: on for the
 * companion, off while a relayed call runs as the primary (its real push relay
 * and registry, the same config.yaml, its rows `origin: relay`). The bridge is
 * the one fake.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../helpers/mock-constants.js'

const box = vi.hoisted(() => ({ cloud: true }))
vi.mock('../../src/constants.js', () => ({
  ...createMockConstants('walnut-device-revoke-races', { CLOUD_MODE: true }),
  get CLOUD_MODE() { return box.cloud },
}))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: { kind: string; message: string; notSent?: boolean } }
const primary = vi.hoisted(() => ({
  mode: 'offline' as 'offline' | 'ok' | 'real',
  calls: [] as Array<{ action: string; params: Record<string, unknown> }>,
}))
vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  return {
    ...real,
    callPrimaryControl: async (action: string, _sid: string, params: Record<string, unknown> = {}): Promise<Reply> => {
      const mode = primary.mode
      if (mode === 'offline') return { ok: false, failure: { kind: 'bridge_offline', message: 'no bridge in this test', notSent: true } }
      primary.calls.push({ action, params })
      if (action === 'server.devices.revoke-by-hash') return { ok: true, result: { name: 'twin', revoked: true } }
      if (mode === 'ok') return { ok: true, result: action === 'server.push.revoke-device' ? { removed: 1 } : {} }
      const { handlePushRelayAction } = await import('../../src/core/push/relay.js')
      box.cloud = false
      try {
        return { ok: true, result: await handlePushRelayAction(action.replace('server.push.', ''), JSON.parse(JSON.stringify(params)) as Record<string, unknown>) }
      } finally {
        box.cloud = true
      }
    },
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, _settleRevokeWorkForTesting, createDevice, listDeviceRecords, revokePairing, rotateDevice, setDeviceInfo, verifyDeviceToken,
} from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import { adoptDeviceRecord, revokeAdoptedByHash } from '../../src/core/device-adoption.js'
import { getConfig, updatePushTokens } from '../../src/core/config-manager.js'
import { handlePushRelayAction } from '../../src/core/push/relay.js'
import { registerPushToken, revokeDevicePushTokens } from '../../src/core/push/registry.js'
import { drainRevokeQueue, queuedRevokeSteps } from '../../src/core/devices/revoke-queue.js'
import { _resetDeviceTwinsForTesting } from '../../src/web/routes/device-twins.js'
import { pushRouter } from '../../src/web/routes/push.js'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { runDeviceRevoke } from '../../src/commands/device.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const MAC = 'a1'.repeat(16)
const PHONE = 'c3'.repeat(16)
const OLD_ROW = 'd4'.repeat(32)
const LATE_ROW = 'e5'.repeat(32)
const AUTH = () => path.join(WALNUT_HOME, 'auth.json')

async function seed(): Promise<void> {
  const now = new Date().toISOString()
  await fs.writeFile(AUTH(), JSON.stringify({ devices: [
    { name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(MAC), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000b2', tokenHash: sha('machine-cred'), createdAt: now, kind: 'machine', ownerId: 'd00000000000000a1' },
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE), createdAt: now, platform: 'ios' },
  ] }, null, 2), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

/** The phone's rows: relayed ones on the primary (companion) or local ones (Mac). */
async function phoneRows(origin: 'relay' | 'local'): Promise<string[]> {
  return ((await getConfig()).push_tokens ?? []).filter((t) => t.key_name === 'my-phone' && t.origin === origin).map((t) => t.token).sort()
}

/** The primary's real register handler, as the phone's relayed registration reaches it. */
async function registerOnPrimary(token: string): Promise<void> {
  const was = box.cloud
  box.cloud = false
  try {
    await handlePushRelayAction('register', { token, platform: 'ios', environment: 'production', keyName: 'my-phone' })
  } finally {
    box.cloud = was
  }
}

/** Run `during` once, right before the next rename that replaces auth.json (the revoke's own write). */
function atAuthWrite(during: () => Promise<void>): { fired: () => boolean } {
  const real = fs.rename.bind(fs)
  let fired = false
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!fired && String(to) === AUTH()) {
      fired = true
      await during()
    }
    return real(from, to)
  })
  return { fired: () => fired }
}

const pushCalls = () => primary.calls.filter((c) => c.action === 'server.push.revoke-device')
const twinCalls = () => primary.calls.filter((c) => c.action === 'server.devices.revoke-by-hash')

let out: string[]
let exitBefore: typeof process.exitCode

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  box.cloud = true
  primary.mode = 'offline'
  primary.calls.length = 0
  await seed()
  _resetDeviceTwinsForTesting()
  out = []
  exitBefore = process.exitCode
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
})

afterEach(async () => {
  vi.restoreAllMocks()
  primary.mode = 'offline'
  await _settleRevokeWorkForTesting()
  setSelfApiRoot(null)
  _resetDeviceTwinsForTesting()
  box.cloud = true
  process.exitCode = exitBefore
})

describe('a drain while a revoke is between its queue writes and auth.json', () => {
  it('walnut device revoke with the primary down: the drain leaves both parts, and they finish once the primary is back', async () => {
    let inWindow: unknown = null
    const hook = atAuthWrite(async () => { inWindow = await drainRevokeQueue() })
    await runDeviceRevoke('my-phone', {} as never)
    expect(hook.fired()).toBe(true)
    // Under the revoke's own lock: nothing judged, nothing dropped, nothing run.
    expect(inWindow).toEqual({ done: 0, left: 2 })
    expect(out.join('\n')).toMatch(/server finishes the rest/)
    expect((await queuedRevokeSteps()).map((s) => s.step).sort()).toEqual(['push', 'twin'])
    primary.mode = 'ok'
    expect(await drainRevokeQueue()).toEqual({ done: 2, left: 0 })
    expect(pushCalls().map((c) => c.params.keyName)).toEqual(['my-phone'])
    expect(twinCalls().map((c) => c.params.tokenHash)).toEqual([sha(PHONE)])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('a console revoke on the server: the push part it reported queued is still queued, and finishes once the primary is back', async () => {
    setSelfApiRoot('http://127.0.0.1:9') // this process is the server
    let inWindow: unknown = null
    const hook = atAuthWrite(async () => { inWindow = await drainRevokeQueue() })
    const res = await revokePairing('my-phone')
    expect(hook.fired()).toBe(true)
    expect(inWindow).toEqual({ done: 0, left: 2 })
    expect(res.push).toMatchObject({ pending: expect.any(String), retry: true, queued: true })
    expect((await queuedRevokeSteps()).map((s) => s.step)).toContain('push')
    _resetDeviceTwinsForTesting() // the restart: its in-memory retries are gone
    primary.mode = 'ok'
    await drainRevokeQueue()
    expect(pushCalls().map((c) => c.params.keyName)).toEqual(['my-phone'])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('while something else holds the auth lock, a drain judges nothing and leaves every part to the next one', async () => {
    await runDeviceRevoke('my-phone', {} as never)
    expect(await queuedRevokeSteps()).toHaveLength(2)
    const lock = `${AUTH()}.lock`
    await fs.mkdir(lock)
    await fs.writeFile(path.join(lock, 'pid'), String(process.pid)) // a live holder
    primary.mode = 'ok'
    try {
      expect(await drainRevokeQueue()).toEqual({ done: 0, left: 2 })
      expect(primary.calls).toEqual([])
    } finally {
      await fs.rm(lock, { recursive: true, force: true })
    }
    expect(await drainRevokeQueue()).toEqual({ done: 2, left: 0 })
    expect(await queuedRevokeSteps()).toEqual([])
  })
})

describe('a registration the old token authenticated, landing late', () => {
  it('on the primary, between the queue writes and auth.json: older than the cutoff, so it goes', async () => {
    await registerOnPrimary(OLD_ROW)
    primary.mode = 'real'
    const hook = atAuthWrite(() => registerOnPrimary(LATE_ROW))
    await revokePairing('my-phone')
    expect(hook.fired()).toBe(true)
    expect(await phoneRows('relay')).toEqual([])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('on the Mac (local rows), the same: the late row is removed, not only held back', async () => {
    box.cloud = false
    await registerPushToken({ token: OLD_ROW, platform: 'ios', keyName: 'my-phone', origin: 'local' })
    const hook = atAuthWrite(async () => {
      await registerPushToken({ token: LATE_ROW, platform: 'ios', keyName: 'my-phone', origin: 'local' })
    })
    await revokePairing('my-phone')
    expect(hook.fired()).toBe(true)
    expect(await phoneRows('local')).toEqual([])
  })

  it('queued in an outage: the drain later uses the time after the auth.json write, so the late row still goes', async () => {
    await registerOnPrimary(OLD_ROW)
    const hook = atAuthWrite(() => registerOnPrimary(LATE_ROW)) // straight onto the primary, while the companion cannot reach it
    await revokePairing('my-phone')
    expect(hook.fired()).toBe(true)
    expect(await phoneRows('relay')).toEqual([LATE_ROW])
    expect((await queuedRevokeSteps()).map((s) => s.step)).toContain('push')
    primary.mode = 'real'
    await drainRevokeQueue()
    expect(await phoneRows('relay')).toEqual([])
  })

  it('a row registered in the very millisecond of the cutoff counts as old', async () => {
    const at = new Date(Date.now() - 1_000)
    await updatePushTokens(() => [{ token: LATE_ROW, platform: 'ios', key_name: 'my-phone', origin: 'local', registered_at: at.toISOString() }])
    expect(await revokeDevicePushTokens('my-phone', 'local', { registeredBefore: at.getTime() })).toEqual({ removed: 1 })
  })

  /**
   * POST /api/push/register as the phone, with `between` run after the route
   * has checked the pairing and before it writes the row: the first auth.json
   * read after the request starts is that check.
   */
  async function registerWith(between: () => Promise<void>): Promise<request.Response> {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { deviceName?: string }).deviceName = 'my-phone' // what the auth middleware verified
      next()
    })
    app.use('/api/push', pushRouter)
    const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>
    let armed = true
    vi.spyOn(fs, 'readFile').mockImplementation((async (...a: unknown[]) => {
      const content = await real(...a)
      if (armed && String(a[0]) === AUTH()) {
        armed = false
        await between()
      }
      return content
    }) as typeof fs.readFile)
    return request(app).post('/api/push/register').set('Authorization', `Bearer ${PHONE}`)
      .send({ token: LATE_ROW, platform: 'ios', environment: 'production' })
  }

  it('through the companion\'s register route, written after the revoke landed: taken back, and the phone told 401', async () => {
    primary.mode = 'real'
    const res = await registerWith(async () => { await revokePairing('my-phone') })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('token_refused')
    expect(await phoneRows('relay')).toEqual([])
  })

  it('the same on the Mac: it checks under the auth lock, so the row is never written', async () => {
    box.cloud = false
    const res = await registerWith(async () => { await revokePairing('my-phone') })
    expect(res.status).toBe(401)
    expect(await phoneRows('local')).toEqual([])
  })

  it('a device rotating its own token meanwhile stays the same pairing: its row is kept', async () => {
    box.cloud = false
    const res = await registerWith(async () => { await rotateDevice('my-phone', { by: { token: PHONE } }) })
    expect(res.status).toBe(200)
    expect(await phoneRows('local')).toEqual([LATE_ROW])
  })

  it('a token already revoked when the route checks it stores nothing', async () => {
    box.cloud = false
    await revokePairing('my-phone')
    const res = await registerWith(async () => {})
    expect(res.status).toBe(401)
    expect(await phoneRows('local')).toEqual([])
  })

  it('on the companion, a token already revoked is not even relayed', async () => {
    await revokePairing('my-phone')
    primary.mode = 'real'
    primary.calls.length = 0
    const res = await registerWith(async () => {})
    expect(res.status).toBe(401)
    expect(primary.calls.map((c) => c.action)).not.toContain('server.push.register')
    expect(await phoneRows('relay')).toEqual([])
  })
})

describe('a revoked pairing never comes back', () => {
  it('after its queue entries are gone, the other box offering its copy back is still refused', async () => {
    await runDeviceRevoke('my-phone', {} as never)
    primary.mode = 'ok'
    await drainRevokeQueue()
    expect(await queuedRevokeSteps()).toEqual([])
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'primary' })).rejects.toThrow(/revoked here/)
    expect((await listDeviceRecords()).some((d) => d.tokenHash === sha(PHONE))).toBe(false)
    // Another pairing is copied as before.
    expect(await adoptDeviceRecord({ name: 'acme-tablet', tokenHash: sha('tablet'), adoptedFrom: 'primary' })).toMatchObject({ adopted: true })
  })

  it('the box that removes its copy by hash records it too, and never adopts it back', async () => {
    expect(await revokeAdoptedByHash(sha(PHONE))).toBe('my-phone')
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'cloud' })).rejects.toThrow(/revoked here/)
  })

  it('a revoked token never authenticates again, even when its record comes back', async () => {
    expect(await verifyDeviceToken(PHONE)).toMatchObject({ name: 'my-phone' })
    await revokePairing('my-phone')
    // An old backup restored by hand: the record is back, the record of the revoke kept.
    const auth = JSON.parse(await fs.readFile(AUTH(), 'utf-8')) as { devices: unknown[]; revokedHashes?: string[] }
    expect(auth.revokedHashes).toContain(sha(PHONE))
    auth.devices.push({ name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE), createdAt: new Date().toISOString() })
    await fs.writeFile(AUTH(), JSON.stringify(auth), { mode: 0o600 })
    _resetDeviceAuthForTesting()
    expect(await verifyDeviceToken(PHONE)).toBeNull()
    expect(await verifyDeviceToken(MAC)).toMatchObject({ name: 'mac-primary' })
  })

  it('the record of revoked hashes survives every other auth.json write', async () => {
    await revokePairing('my-phone')
    await createDevice('acme-tablet')
    await setDeviceInfo('acme-tablet', { model: 'iPad13,1', appVersion: '1.0 (99)' })
    await rotateDevice('acme-tablet', { by: LOCAL_ACTOR })
    const auth = JSON.parse(await fs.readFile(AUTH(), 'utf-8')) as { revokedHashes?: string[] }
    expect(auth.revokedHashes).toContain(sha(PHONE))
    const backup = JSON.parse(await fs.readFile(`${AUTH()}.bak`, 'utf-8')) as { revokedHashes?: string[] }
    expect(backup.revokedHashes).toContain(sha(PHONE))
  })

  it('a device rotating its own token retires the old one for good', async () => {
    box.cloud = false
    const fresh = await rotateDevice('my-phone', { by: { token: PHONE } })
    await _settleRevokeWorkForTesting() // the old token's copy is removed and its queue entry cleared
    expect(await queuedRevokeSteps()).toEqual([])
    expect(await verifyDeviceToken(fresh.token)).toMatchObject({ name: 'my-phone' })
    expect(await verifyDeviceToken(PHONE)).toBeNull()
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'cloud' })).rejects.toThrow(/revoked here/)
  })
})
