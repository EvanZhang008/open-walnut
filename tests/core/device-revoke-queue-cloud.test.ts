/**
 * A revoke on the cloud companion (CLOUD_MODE) has two parts that live on the
 * primary: the phone's push rows (`server.push.revoke-device`) and the
 * primary's copy of the pairing (`server.devices.revoke-by-hash`, which also
 * drops the rows the phone registered there as itself). `walnut device revoke`
 * typed on the companion runs in a process with no bridge, so it can never
 * reach the primary from there; before this, its phone kept getting letter
 * subjects on its lock screen. What a revoke cannot finish now is queued
 * (core/devices/revoke-queue.ts) and the server finishes it: at start, every
 * 60 s, and when the primary bridge connects. A revoke the server itself runs
 * queues the copy's removal as well, because its own retries end with a restart.
 * A queued push part removes only the rows registered before the revoke, so a
 * re-pair of the name before the drain keeps its new row and loses the old one.
 *
 * The bridge is the one thing faked: callPrimaryControl answers per test. Where
 * the primary's part matters, the fake hands the frame to the primary's real
 * push relay in this process, with CLOUD_MODE off while it runs (one data dir:
 * the primary's rows are the `origin: relay` ones).
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
  ...createMockConstants('walnut-revoke-queue-cloud', { CLOUD_MODE: true }),
  get CLOUD_MODE() { return box.cloud },
}))

type Failure = { kind: 'bridge_offline' | 'needs_upgrade' | 'error'; message: string; code?: string; notSent?: boolean }
type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: Failure }
const relay = vi.hoisted(() => ({
  callPrimaryControl: vi.fn(async (_action: string, _sid: string, _params?: Record<string, unknown>, _ms?: number): Promise<Reply> => (
    { ok: false, failure: { kind: 'bridge_offline', message: 'no bridge in this process', notSent: true } }
  )),
}))
vi.mock('../../src/web/routes/v1-control-relay.js', () => relay)

const bridge = vi.hoisted(() => ({ onConnect: [] as Array<() => void> }))
vi.mock('../../src/web/ws/bridge-registry.js', () => ({
  addPrimaryBridgeConnectedHandler: (h: () => void) => {
    bridge.onConnect.push(h)
    return () => { bridge.onConnect = bridge.onConnect.filter((x) => x !== h) }
  },
}))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, _settleRevokeWorkForTesting, createDevice, listDeviceRecords, revokePairing, rotateDevice,
} from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import { getConfig, updateConfig, updatePushTokens } from '../../src/core/config-manager.js'
import { revokePushTokensForDevice } from '../../src/core/push/device-revoke.js'
import { authRouter } from '../../src/web/routes/auth.js'
import { handlePushRelayAction } from '../../src/core/push/relay.js'
import { adoptDeviceRecord } from '../../src/core/device-adoption.js'
import { drainRevokeQueue, enqueueRevokeStep, queuedRevokeSteps, startRevokeQueue, twinRemovalPending } from '../../src/core/devices/revoke-queue.js'
import { _resetDeviceTwinsForTesting } from '../../src/web/routes/device-twins.js'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { runDeviceRevoke } from '../../src/commands/device.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE = 'f0'.repeat(16)
const MAC = 'e0'.repeat(16)
const OK = (result: Record<string, unknown> = {}): Reply => ({ ok: true, result })
const OFFLINE: Reply = { ok: false, failure: { kind: 'bridge_offline', message: 'no bridge in this process', notSent: true } }

async function seed(): Promise<void> {
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(MAC), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000b2', tokenHash: sha('machine'), createdAt: now, kind: 'machine', ownerId: 'd00000000000000a1' },
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE), createdAt: now, platform: 'ios' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

/** The relayed actions, in order, with their params. */
const relayed = () => relay.callPrimaryControl.mock.calls.map((c) => [c[0], c[2]])

let out: string[]
let exitCodeBefore: typeof process.exitCode

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await seed()
  _resetDeviceTwinsForTesting()
  relay.callPrimaryControl.mockReset().mockResolvedValue(OFFLINE)
  bridge.onConnect = []
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  exitCodeBefore = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  setSelfApiRoot(null)
  _resetDeviceTwinsForTesting()
  process.exitCode = exitCodeBefore
})

describe('walnut device revoke on the companion', () => {
  it('cannot reach the primary from the CLI: both parts are queued, and the CLI says the server finishes them', async () => {
    await runDeviceRevoke('my-phone', {} as never)
    expect(out.join('\n')).toContain('Device "my-phone" revoked.')
    expect(out.join('\n')).toMatch(/server finishes the rest/)
    // What is left is on the other box, and the CLI says exactly that.
    expect(out.join('\n')).toContain('The primary could not be reached from here to remove its push rows there.')
    expect(out.join('\n')).toContain('Its copy on the other box could not be removed from here.')
    expect(out.join('\n')).not.toMatch(/on this machine/)
    expect(process.exitCode).toBeUndefined()
    // The two parts run side by side, so neither order is promised.
    const byAction = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]))
    expect(relayed().sort(byAction)).toEqual([
      ['server.devices.revoke-by-hash', { tokenHash: sha(PHONE) }],
      ['server.push.revoke-device', { keyName: 'my-phone', revokedMsAgo: expect.any(Number) }],
    ])
    const queued = await queuedRevokeSteps()
    expect(queued).toHaveLength(2)
    expect(queued).toEqual(expect.arrayContaining([
      { step: 'push', name: 'my-phone', revokedAt: expect.any(String), pairingHash: sha(PHONE) },
      { step: 'twin', tokenHash: sha(PHONE) },
    ]))
  })

  it('the server finishes them when the primary bridge connects, and the queue empties', async () => {
    await runDeviceRevoke('my-phone', {} as never)
    expect(await queuedRevokeSteps()).toHaveLength(2)
    const handle = startRevokeQueue()
    try {
      await drainRevokeQueue() // the start drain: still offline, both kept
      expect(await queuedRevokeSteps()).toHaveLength(2)
      relay.callPrimaryControl.mockReset().mockImplementation(async (action) => (
        action === 'server.push.revoke-device' ? OK({ removed: 1 }) : OK({ name: 'my-phone', revoked: true })
      ))
      await vi.waitFor(() => expect(bridge.onConnect).toHaveLength(1))
      bridge.onConnect[0]()
      await vi.waitFor(async () => expect(await queuedRevokeSteps()).toEqual([]))
      expect(relayed().map((r) => r[0]).sort()).toEqual(['server.devices.revoke-by-hash', 'server.push.revoke-device'])
      expect(relayed()).toContainEqual(['server.push.revoke-device', { keyName: 'my-phone', revokedMsAgo: expect.any(Number) }])
      expect(relayed()).toContainEqual(['server.devices.revoke-by-hash', { tokenHash: sha(PHONE) }])
    } finally {
      handle.stop()
    }
    expect(bridge.onConnect).toEqual([])
  })

  it('a primary that refuses the push revoke is not retried, and the CLI exits 1 saying so', async () => {
    relay.callPrimaryControl.mockImplementation(async (action) => (
      action === 'server.push.revoke-device'
        ? { ok: false, failure: { kind: 'error', code: 'bad_request', message: 'refused' } }
        : OK({ name: 'my-phone', revoked: true })
    ))
    await runDeviceRevoke('my-phone', {} as never)
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toMatch(/push notifications may not have stopped: refused/)
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('an older primary (needs_upgrade) keeps the push part queued for after its upgrade', async () => {
    relay.callPrimaryControl.mockImplementation(async (action) => (
      action === 'server.push.revoke-device'
        ? { ok: false, failure: { kind: 'needs_upgrade', message: 'Unknown control action' } }
        : OK({ name: 'my-phone', revoked: true })
    ))
    await runDeviceRevoke('my-phone', {} as never)
    expect(await queuedRevokeSteps()).toEqual([{ step: 'push', name: 'my-phone', revokedAt: expect.any(String), pairingHash: sha(PHONE) }])
  })

  it('revoking the Mac itself queues nothing: a Mac registers no pushes and its pairing is never copied', async () => {
    await runDeviceRevoke('mac-primary', {} as never)
    expect(process.exitCode).toBeUndefined()
    expect(relayed()).toEqual([])
    expect(await queuedRevokeSteps()).toEqual([])
  })
})

describe('the revoke queue', () => {
  it('runs a push part whose name was paired again since, telling the primary how long ago the revoke was', async () => {
    const revokedAt = new Date(Date.now() - 90_000).toISOString()
    // my-phone is paired (seed), but by a new pairing: the queued part names the old one's hash.
    await enqueueRevokeStep({ step: 'push', name: 'my-phone', revokedAt, pairingHash: sha('the old pairing') })
    relay.callPrimaryControl.mockResolvedValue(OK({ removed: 1 }))
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    const [[action, params]] = relayed() as Array<[string, { keyName: string; revokedMsAgo: number }]>
    expect(action).toBe('server.push.revoke-device')
    expect(params.keyName).toBe('my-phone')
    expect(params.revokedMsAgo).toBeGreaterThanOrEqual(90_000)
    expect(params.revokedMsAgo).toBeLessThan(90_000 + 60_000)
  })

  it('stores one entry per part, however often it is asked', async () => {
    const revokedAt = new Date().toISOString()
    await enqueueRevokeStep({ step: 'push', name: 'gone-phone', revokedAt })
    await enqueueRevokeStep({ step: 'push', name: 'gone-phone', revokedAt })
    expect(await queuedRevokeSteps()).toEqual([{ step: 'push', name: 'gone-phone', revokedAt }])
  })

  it('removes an unreadable entry and drops one older than 7 days, loudly', async () => {
    const dir = path.join(WALNUT_HOME, 'cache', 'revoke-queue')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '000000000000001-junk.json'), '{not json')
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()
    await fs.writeFile(path.join(dir, '000000000000002-old.json'), JSON.stringify({ opId: 'x', at: old, step: 'push', name: 'gone-phone' }))
    // An entry with no revoke time takes its queue time.
    expect(await queuedRevokeSteps()).toEqual([{ step: 'push', name: 'gone-phone', revokedAt: old }])
    expect(await drainRevokeQueue()).toEqual({ done: 0, left: 0 })
    expect(await fs.readdir(dir)).toEqual([])
  })

})

describe('a console revoke on the companion while the primary is down, then a restart', () => {
  /** The server's console revoke, with the bridge down; returns once its in-process try has run. */
  async function revokeDuringOutage(): Promise<void> {
    setSelfApiRoot('http://127.0.0.1:1') // this process is the server
    _resetDeviceTwinsForTesting({ retryMs: 60_000 })
    const outcome = await revokePairing('my-phone')
    expect(outcome).toMatchObject({ revoked: true, push: { pending: 'no bridge in this process', retry: true, queued: true }, twin: 'background' })
    // The copy is tried at once, in process; it fails, and its retry timer lives in memory only.
    await vi.waitFor(() => expect(relayed()).toContainEqual(['server.devices.revoke-by-hash', { tokenHash: sha(PHONE) }]))
  }

  it('both parts are on disk, and the restarted server removes the Mac\'s copy and the rows', async () => {
    await revokeDuringOutage()
    const queued = await queuedRevokeSteps()
    expect(queued).toHaveLength(2)
    expect(queued).toEqual(expect.arrayContaining([
      { step: 'push', name: 'my-phone', revokedAt: expect.any(String), pairingHash: sha(PHONE) },
      { step: 'twin', tokenHash: sha(PHONE) },
    ]))

    // The restart: every in-process retry is gone; the queue on disk is not. The primary is back.
    _resetDeviceTwinsForTesting()
    relay.callPrimaryControl.mockReset().mockImplementation(async (action) => (
      action === 'server.push.revoke-device' ? OK({ removed: 1 }) : OK({ name: 'my-phone', revoked: true })
    ))
    const handle = startRevokeQueue() // drains at start
    try {
      await vi.waitFor(async () => expect(await queuedRevokeSteps()).toEqual([]))
    } finally {
      handle.stop()
    }
    // Every call here is the restarted server's: the in-process try was before the reset.
    expect(relayed()).toContainEqual(['server.devices.revoke-by-hash', { tokenHash: sha(PHONE) }])
    expect(relayed()).toContainEqual(['server.push.revoke-device', { keyName: 'my-phone', revokedMsAgo: expect.any(Number) }])
  })

  it('until the copy is removed, the Mac cannot copy the revoked pairing back here', async () => {
    await revokeDuringOutage()
    // The Mac still takes the revoked token; the phone asks the Mac for its routes,
    // and the Mac offers its copy to this box (instance-routes-v1.ts adoptOnCloud).
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'primary' })).rejects.toThrow(/revoked here/)
    expect((await listDeviceRecords()).some((d) => d.tokenHash === sha(PHONE))).toBe(false)
    // Another pairing is copied as before.
    expect(await adoptDeviceRecord({ name: 'acme-tablet', tokenHash: sha('tablet'), adoptedFrom: 'primary' })).toMatchObject({ adopted: true })
    // Once the removal lands, its entry goes; the refusal does not (auth.json revokedHashes).
    relay.callPrimaryControl.mockReset().mockResolvedValue(OK({ name: 'my-phone', revoked: true }))
    await drainRevokeQueue()
    expect(await twinRemovalPending(sha(PHONE))).toBe(false)
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'primary' })).rejects.toThrow(/revoked here/)
  })
})

describe('the name paired again before the queued push part runs', () => {
  const OLD_ROW = 'a1'.repeat(32)
  const NEW_ROW = 'b2'.repeat(32)

  /** The primary's part, in this process: its real push relay, with CLOUD_MODE off while it runs. */
  async function asPrimary<T>(fn: () => Promise<T>): Promise<T> {
    box.cloud = false
    try {
      return await fn()
    } finally {
      box.cloud = true
    }
  }
  const primaryRows = async () => ((await getConfig()).push_tokens ?? [])
    .filter((t) => t.origin === 'relay' && t.key_name === 'my-phone').map((t) => t.token).sort()
  const newPhoneRegisters = () => asPrimary(() => handlePushRelayAction('register', { token: NEW_ROW, platform: 'ios', keyName: 'my-phone' }))

  const ENDINGS = [
    ['a revoke, then a new pairing of the name', async () => {
      await revokePairing('my-phone')
      await createDevice('my-phone')
    }],
    ['a re-pair that replaces the old pairing', async () => {
      expect(await rotateDevice('my-phone', { by: LOCAL_ACTOR })).toMatchObject({ replaced: true })
    }],
  ] as const

  /** The old phone's relayed row on the primary; then `ending` in the server, with the primary down. */
  async function endDuringOutage(ending: () => Promise<void>): Promise<void> {
    await updatePushTokens(() => [{
      token: OLD_ROW, platform: 'ios', key_name: 'my-phone', origin: 'relay',
      registered_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    }])
    setSelfApiRoot('http://127.0.0.1:1') // this process is the server
    _resetDeviceTwinsForTesting({ retryMs: 60_000 })
    await ending()
    await _settleRevokeWorkForTesting()
    await vi.waitFor(() => expect(relayed()).toContainEqual(['server.devices.revoke-by-hash', { tokenHash: sha(PHONE) }]))
    expect(await queuedRevokeSteps()).toContainEqual({ step: 'push', name: 'my-phone', revokedAt: expect.any(String), pairingHash: sha(PHONE) })
    expect(await primaryRows()).toEqual([OLD_ROW])
    await new Promise((r) => setTimeout(r, 20)) // whatever registers next is later than the revoke
  }

  /** The restart, with the primary back: the start drain runs the queue to empty. */
  async function restartAndDrain(): Promise<void> {
    _resetDeviceTwinsForTesting()
    relay.callPrimaryControl.mockReset().mockImplementation(async (action, _sid, params) => {
      if (action !== 'server.push.revoke-device') return OK({ name: 'my-phone', revoked: true })
      const wire = JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>
      return OK(await asPrimary(() => handlePushRelayAction('revoke-device', wire)))
    })
    const handle = startRevokeQueue()
    try {
      await vi.waitFor(async () => expect(await queuedRevokeSteps()).toEqual([]))
    } finally {
      handle.stop()
    }
    expect(relayed().map((r) => r[0])).toContain('server.push.revoke-device')
  }

  it.each(ENDINGS)('%s; drained before the new phone registers: the old phone\'s row goes', async (_label, ending) => {
    await endDuringOutage(ending)
    await restartAndDrain()
    expect(await primaryRows()).toEqual([])
    await newPhoneRegisters()
    expect(await primaryRows()).toEqual([NEW_ROW])
  })

  it.each(ENDINGS)('%s; the new phone registers first: its row survives the drain', async (_label, ending) => {
    await endDuringOutage(ending)
    await newPhoneRegisters()
    expect(await primaryRows()).toEqual([NEW_ROW])
    await restartAndDrain()
    expect(await primaryRows()).toEqual([NEW_ROW])
  })
})

describe('the parts never hold anything up, and a kill loses none of them', () => {
  /** A primary that takes every call and answers none, until released. */
  function hangingPrimary(): { release: () => void } {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    relay.callPrimaryControl.mockReset().mockImplementation(async (action) => {
      await gate
      return action === 'server.push.revoke-device' ? OK({ removed: 1 }) : OK({ name: 'my-phone', revoked: true })
    })
    return { release }
  }
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([
    p.then((v) => ({ done: true as const, v })),
    new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms)),
  ])

  it('a re-pair hands out the new token at once while the primary does not answer; the old parts finish later', async () => {
    setSelfApiRoot('http://127.0.0.1:1') // the server's console re-pair
    _resetDeviceTwinsForTesting({ retryMs: 60_000 })
    const primary = hangingPrimary()
    const res = await within(rotateDevice('my-phone', { by: LOCAL_ACTOR }), 2_000)
    expect(res.done).toBe(true)
    expect(await queuedRevokeSteps()).toEqual(expect.arrayContaining([
      { step: 'push', name: 'my-phone', revokedAt: expect.any(String), pairingHash: sha(PHONE) },
      { step: 'twin', tokenHash: sha(PHONE) },
    ]))
    primary.release()
    await _settleRevokeWorkForTesting()
    expect(relayed()).toContainEqual(['server.push.revoke-device', { keyName: 'my-phone', revokedMsAgo: expect.any(Number) }])
    // The push part is done and cleared; the copy's entry waits for the drain, which finds it gone.
    expect(await queuedRevokeSteps()).toEqual([{ step: 'twin', tokenHash: sha(PHONE) }])
  })

  it('walnut device revoke killed while the primary is silent: both parts were on disk, and the restarted server finishes them', async () => {
    hangingPrimary() // never released: the CLI process dies waiting
    void runDeviceRevoke('my-phone', {} as never)
    await vi.waitFor(async () => expect((await listDeviceRecords()).some((d) => d.name === 'my-phone')).toBe(false))
    await vi.waitFor(() => expect(relayed().map((r) => r[0]).sort()).toEqual(['server.devices.revoke-by-hash', 'server.push.revoke-device']))
    expect(await queuedRevokeSteps()).toEqual(expect.arrayContaining([
      { step: 'push', name: 'my-phone', revokedAt: expect.any(String), pairingHash: sha(PHONE) },
      { step: 'twin', tokenHash: sha(PHONE) },
    ]))
    // The kill, then the server's start drain with the primary back.
    _resetDeviceTwinsForTesting()
    relay.callPrimaryControl.mockReset().mockImplementation(async (action) => (
      action === 'server.push.revoke-device' ? OK({ removed: 1 }) : OK({ name: 'my-phone', revoked: true })
    ))
    expect(await drainRevokeQueue()).toEqual({ done: 2, left: 0 })
    expect(relayed().map((r) => r[0]).sort()).toEqual(['server.devices.revoke-by-hash', 'server.push.revoke-device'])
    expect(await queuedRevokeSteps()).toEqual([])
  })
})

describe('an API key deleted on the companion: not a pairing, the same push part', () => {
  const KEY_ROW = 'c4'.repeat(32)
  const keyRows = async () => ((await getConfig()).push_tokens ?? [])
    .filter((t) => t.origin === 'relay' && t.key_name === 'acme-script').map((t) => t.token)
  /** The primary in this process: its real push relay, CLOUD_MODE off while it runs. */
  async function asPrimary<T>(fn: () => Promise<T>): Promise<T> {
    box.cloud = false
    try {
      return await fn()
    } finally {
      box.cloud = true
    }
  }
  const realPrimary = () => relay.callPrimaryControl.mockReset().mockImplementation(async (action, _sid, params) => (
    action === 'server.push.revoke-device'
      ? OK(await asPrimary(() => handlePushRelayAction('revoke-device', JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>)))
      : OFFLINE
  ))

  it('its push part, when the primary cannot be reached, is queued (the default), and the drain finishes it', async () => {
    const outcome = await revokePushTokensForDevice('acme-script')
    expect(outcome).toMatchObject({ pending: 'no bridge in this process', retry: true, queued: true, pendingWhere: 'primary' })
    expect(await queuedRevokeSteps()).toEqual([{ step: 'push', name: 'acme-script', revokedAt: expect.any(String) }])
    relay.callPrimaryControl.mockReset().mockResolvedValue(OK({ removed: 1 }))
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    expect(relayed()).toEqual([['server.push.revoke-device', { keyName: 'acme-script', revokedMsAgo: expect.any(Number) }]])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('DELETE /api/auth/keys/:name in an outage: says the push part is pending, queues it, and the row on the primary goes once it is back', async () => {
    await updateConfig({ api_keys: [{ name: 'acme-script', key: `wlnt_sk_${'0'.repeat(48)}`, created_at: new Date().toISOString() }] })
    await asPrimary(() => handlePushRelayAction('register', { token: KEY_ROW, platform: 'ios', keyName: 'acme-script' }))
    expect(await keyRows()).toEqual([KEY_ROW])
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    const res = await request(app).delete('/api/auth/keys/acme-script')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, pushRevokePending: true })
    expect((await getConfig()).api_keys ?? []).toEqual([])
    expect(await queuedRevokeSteps()).toEqual([{ step: 'push', name: 'acme-script', revokedAt: expect.any(String) }])
    expect(await keyRows()).toEqual([KEY_ROW]) // still on the primary while it is unreachable
    realPrimary()
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    expect(await keyRows()).toEqual([])
    expect(await queuedRevokeSteps()).toEqual([])
  })
})
