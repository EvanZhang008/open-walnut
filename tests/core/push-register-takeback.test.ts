/**
 * POST /api/push/register against a revoke landing while the registration is
 * on its way, on both boxes:
 *
 *  - the Mac checks the pairing and writes the row under the auth lock, so the
 *    row is older than the revoke's cutoff or is never written;
 *  - a companion relays the write, so it checks again afterwards and takes the
 *    write back (core/push/claims.ts): also when the primary's answer was lost
 *    on the way, and when the pairing went before its own check; queued when the
 *    primary cannot take it now, and kept queued until it can;
 *  - a take-back keeps a row only for a pairing of the name that still holds
 *    (the same phone, paired again under its name), and the claim of a revoked
 *    pairing never keeps a row: not after a re-pair, not after the device
 *    changed its own token.
 *
 * One process, a private data dir. CLOUD_MODE is a getter: on for the
 * companion, off while a relayed call runs as the primary (its real push relay
 * and registry, the same config.yaml). The bridge is the one fake.
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
  ...createMockConstants('walnut-push-register-takeback', { CLOUD_MODE: true }),
  get CLOUD_MODE() { return box.cloud },
}))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: { kind: string; message: string; notSent?: boolean } }
const primary = vi.hoisted(() => ({
  mode: 'offline' as 'offline' | 'real',
  /** Actions answered as unreachable even while the primary is up. */
  unreachable: new Set<string>(),
  calls: [] as Array<{ action: string; params: Record<string, unknown> }>,
  /** Runs inside the next relayed register, before the primary writes the row. */
  beforeRegister: null as null | (() => Promise<void>),
  /** The next relayed register's row is written, and its answer lost on the way back. */
  loseRegisterReply: false,
}))
vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  return {
    ...real,
    callPrimaryControl: async (action: string, _sid: string, params: Record<string, unknown> = {}): Promise<Reply> => {
      if (primary.mode === 'offline' || primary.unreachable.has(action)) {
        return { ok: false, failure: { kind: 'bridge_offline', message: 'no bridge in this test', notSent: true } }
      }
      primary.calls.push({ action, params })
      if (action === 'server.devices.revoke-by-hash') return { ok: true, result: { name: 'twin', revoked: true } }
      if (action === 'server.push.register' && primary.beforeRegister) {
        const f = primary.beforeRegister
        primary.beforeRegister = null
        await f()
      }
      const lose = action === 'server.push.register' && primary.loseRegisterReply
      if (lose) primary.loseRegisterReply = false
      const { handlePushRelayAction } = await import('../../src/core/push/relay.js')
      const was = box.cloud
      box.cloud = false
      let result: Record<string, unknown>
      try {
        result = await handlePushRelayAction(action.replace('server.push.', ''), JSON.parse(JSON.stringify(params)) as Record<string, unknown>)
      } finally {
        box.cloud = was
      }
      return lose ? { ok: false, failure: { kind: 'bridge_offline', message: 'the answer was lost', notSent: false } } : { ok: true, result }
    },
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetDeviceAuthForTesting, _settleRevokeWorkForTesting, createDevice, revokePairing, rotateDevice } from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import { getConfig } from '../../src/core/config-manager.js'
import { handlePushRelayAction } from '../../src/core/push/relay.js'
import { registerPushToken, takeBackPushToken } from '../../src/core/push/registry.js'
import { MAX_CLAIMS, MAX_LIVE_CLAIMS, pushClaimOf, pushClaimOfPairingHash, pushTokenSha } from '../../src/core/push/claims.js'
import { drainRevokeQueue, queuedRevokeSteps } from '../../src/core/devices/revoke-queue.js'
import { _resetDeviceTwinsForTesting } from '../../src/web/routes/device-twins.js'
import { pushRouter } from '../../src/web/routes/push.js'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'
import type { PushTokenEntry } from '../../src/core/types.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const MAC = 'a1'.repeat(16)
const PHONE = 'c3'.repeat(16)
const ROW = 'e5'.repeat(32)
const OTHER_ROW = 'f6'.repeat(32)
const AUTH = () => path.join(WALNUT_HOME, 'auth.json')
const LOCK = () => `${AUTH()}.lock`
const QDIR = () => path.join(WALNUT_HOME, 'cache', 'revoke-queue')
/** registered_at and a revoke's cutoff are milliseconds: keep them apart. */
const tick = () => new Promise((r) => setTimeout(r, 15))

async function seed(): Promise<void> {
  const now = new Date().toISOString()
  await fs.writeFile(AUTH(), JSON.stringify({ devices: [
    { name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(MAC), createdAt: now },
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE), createdAt: now, platform: 'ios' },
  ] }, null, 2), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

const rows = async (): Promise<PushTokenEntry[]> => ((await getConfig()).push_tokens ?? []).filter((t) => t.key_name === 'my-phone')

/** Revoke the name with its push part held back from the primary (queued here), as when it lands after a slow registration. */
async function revokeWithPushPartLate(): Promise<void> {
  primary.unreachable.add('server.push.revoke-device')
  try {
    await revokePairing('my-phone')
    await _settleRevokeWorkForTesting()
  } finally {
    primary.unreachable.delete('server.push.revoke-device')
  }
}

/** The app as the auth middleware leaves a request from the phone (it verified the bearer as `my-phone`). */
function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as express.Request & { deviceName?: string }).deviceName = 'my-phone'
    next()
  })
  a.use('/api/push', pushRouter)
  return a
}
const register = (bearer: string, token = ROW) => request(app()).post('/api/push/register')
  .set('Authorization', `Bearer ${bearer}`).send({ token, platform: 'ios', environment: 'production' })

/** The primary's relay, as a relayed write reaches it (with the claim a companion sends). */
async function onPrimary(sub: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const was = box.cloud
  box.cloud = false
  try {
    return await handlePushRelayAction(sub, params)
  } finally {
    box.cloud = was
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  box.cloud = true
  primary.mode = 'offline'
  primary.unreachable.clear()
  primary.calls.length = 0
  primary.beforeRegister = null
  primary.loseRegisterReply = false
  await seed()
  _resetDeviceTwinsForTesting()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  primary.mode = 'offline'
  await fs.rm(LOCK(), { recursive: true, force: true })
  await _settleRevokeWorkForTesting()
  setSelfApiRoot(null)
  _resetDeviceTwinsForTesting()
  box.cloud = true
})

describe('the companion takes back its relayed write when the pairing went on the way', () => {
  it('the primary\'s answer lost on the way: still checked, taken back, the phone told 401; its retry too', async () => {
    primary.mode = 'real'
    primary.beforeRegister = async () => { await revokePairing('my-phone') }
    primary.loseRegisterReply = true
    const first = await register(PHONE)
    expect(first.status).toBe(401)
    expect(first.body.error.code).toBe('token_refused')
    expect(await rows()).toEqual([])
    const retry = await register(PHONE)
    expect(retry.status).toBe(401)
    expect(await rows()).toEqual([])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('an answer lost while the pairing still holds is the usual 503 retry, and nothing is taken back', async () => {
    primary.mode = 'real'
    primary.loseRegisterReply = true
    const res = await register(PHONE)
    expect(res.status).toBe(503)
    expect(res.body.retry).toBe(true)
    expect(primary.calls.map((c) => c.action)).not.toContain('server.push.take-back')
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
  })

  it('a write that landed after the revoke (its answer lost) is taken back when the phone tries again', async () => {
    await revokePairing('my-phone')
    await _settleRevokeWorkForTesting()
    primary.mode = 'real'
    // The old token's earlier try, landing late on the primary.
    await onPrimary('register', { token: ROW, platform: 'ios', environment: 'production', keyName: 'my-phone', claim: pushClaimOf(PHONE) })
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
    const res = await register(PHONE)
    expect(res.status).toBe(401)
    expect(primary.calls.map((c) => c.action)).not.toContain('server.push.register')
    expect(await rows()).toEqual([])
  })

  it('the same phone paired again under its name, with the same APNs token: the old write lands last, the row stays', async () => {
    primary.mode = 'real'
    let fresh = ''
    primary.beforeRegister = async () => {
      fresh = (await rotateDevice('my-phone', { by: LOCAL_ACTOR })).token // the box shows a new QR for the name
      await _settleRevokeWorkForTesting()
      expect((await register(fresh)).status).toBe(200) // the new pairing registers the same token first
    }
    const res = await register(PHONE)
    expect(res.status).toBe(401)
    const left = await rows()
    expect(left.map((r) => r.token)).toEqual([ROW])
    expect(left[0]?.claims).toEqual([pushClaimOf(fresh)])
    // With no pairing of the name left, a take-back removes it.
    expect(await onPrimary('take-back', { keyName: 'my-phone', tokenSha: pushTokenSha(ROW), liveClaims: [] })).toEqual({ removed: 1, kept: 0 })
  })

  it('the old token tries again after the same phone was paired again: the new pairing\'s row of that token stays', async () => {
    primary.mode = 'real'
    await register(PHONE)
    const fresh = (await rotateDevice('my-phone', { by: LOCAL_ACTOR })).token
    await _settleRevokeWorkForTesting()
    expect((await register(fresh)).status).toBe(200)
    expect((await register(PHONE)).status).toBe(401)
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
  })

  it('the primary cannot take it back now: queued without the push token, and finished once it can', async () => {
    primary.mode = 'real'
    primary.unreachable.add('server.push.take-back')
    primary.beforeRegister = async () => { await revokePairing('my-phone') }
    const res = await register(PHONE)
    expect(res.status).toBe(401)
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
    const queued = await queuedRevokeSteps()
    expect(queued).toContainEqual({ step: 'takeback', name: 'my-phone', tokenSha: pushTokenSha(ROW) })
    for (const f of await fs.readdir(QDIR())) expect(await fs.readFile(path.join(QDIR(), f), 'utf-8')).not.toContain(ROW.slice(0, 16))
    primary.unreachable.clear()
    await drainRevokeQueue()
    expect(await rows()).toEqual([])
    expect((await queuedRevokeSteps()).filter((s) => s.step === 'takeback')).toEqual([])
  })

  it('a queued take-back the primary still cannot run stays queued, and a later drain finishes it', async () => {
    primary.mode = 'real'
    primary.unreachable.add('server.push.take-back')
    primary.beforeRegister = async () => { await revokePairing('my-phone') }
    expect((await register(PHONE)).status).toBe(401)
    expect((await queuedRevokeSteps()).map((s) => s.step)).toEqual(['takeback'])
    expect(await drainRevokeQueue()).toEqual({ done: 0, left: 1 })
    expect((await queuedRevokeSteps()).map((s) => s.step)).toEqual(['takeback'])
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
    primary.unreachable.clear()
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    expect(await rows()).toEqual([])
  })

  it('a queued take-back judges by the pairings of when it runs: the name\'s last pairing revoked meanwhile, the row goes', async () => {
    primary.mode = 'real'
    primary.unreachable.add('server.push.take-back')
    let fresh = ''
    primary.beforeRegister = async () => {
      fresh = (await rotateDevice('my-phone', { by: LOCAL_ACTOR })).token
      await _settleRevokeWorkForTesting()
      await tick()
      expect((await register(fresh)).status).toBe(200)
    }
    expect((await register(PHONE)).status).toBe(401)
    expect((await queuedRevokeSteps()).map((s) => s.step)).toEqual(['takeback'])
    // Queued while the new pairing held the row. That pairing is revoked before the take-back
    // runs, and its own push part cannot reach the primary yet, so the take-back alone decides.
    primary.unreachable.add('server.push.revoke-device')
    await revokePairing('my-phone')
    await _settleRevokeWorkForTesting()
    primary.unreachable.delete('server.push.take-back')
    await drainRevokeQueue()
    expect(primary.calls.filter((c) => c.action === 'server.push.take-back').map((c) => c.params.liveClaims)).toEqual([[]])
    expect(await rows()).toEqual([])
    expect((await queuedRevokeSteps()).map((s) => s.step)).toEqual(['push'])
  })

  it('a queued take-back that runs after the same phone paired again leaves the row its new pairing registered', async () => {
    primary.mode = 'real'
    primary.unreachable.add('server.push.take-back')
    primary.beforeRegister = async () => { await revokePairing('my-phone') }
    expect((await register(PHONE)).status).toBe(401)
    expect((await queuedRevokeSteps()).map((s) => s.step)).toEqual(['takeback'])
    const again = await createDevice('my-phone') // paired again under its name, the same APNs token
    expect((await register(again.token)).status).toBe(200)
    primary.unreachable.clear()
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    const left = await rows()
    expect(left.map((r) => r.token)).toEqual([ROW])
    expect(left[0]?.claims).toEqual([pushClaimOf(again.token)])
  })

  it('a write the primary provably never ran is not checked again: the usual 503', async () => {
    primary.mode = 'real'
    primary.unreachable.add('server.push.register')
    const res = await register(PHONE)
    expect(res.status).toBe(503)
    expect(primary.calls).toEqual([])
  })
})

describe('a revoked pairing\'s claim never keeps a row', () => {
  it('re-pair: the old pairing\'s claim stayed on the row (its re-pair reached the primary late); the new pairing revoked with a write on its way, the row still goes', async () => {
    primary.mode = 'real'
    expect((await register(PHONE)).status).toBe(200)
    // The box pairs the name again while the primary is away: the push part is queued.
    primary.mode = 'offline'
    const fresh = (await rotateDevice('my-phone', { by: LOCAL_ACTOR })).token
    await _settleRevokeWorkForTesting()
    await tick()
    // The primary is back; the new pairing registers the same APNs token before the drain.
    primary.mode = 'real'
    expect((await register(fresh)).status).toBe(200)
    await tick()
    await drainRevokeQueue()
    expect((await rows())[0]?.claims).toEqual([pushClaimOf(PHONE), pushClaimOf(fresh)])
    // The new pairing is revoked while its next registration is on its way, landing after the cutoff.
    primary.beforeRegister = async () => { await revokeWithPushPartLate(); await tick() }
    expect((await register(fresh)).status).toBe(401)
    await tick()
    await drainRevokeQueue()
    expect(await rows()).toEqual([])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('token change: the device rotated its own token (a new claim beside the old); its pairing revoked with a write on its way, the row still goes', async () => {
    primary.mode = 'real'
    expect((await register(PHONE)).status).toBe(200)
    const rotated = (await rotateDevice('my-phone', { by: { token: PHONE } })).token
    await _settleRevokeWorkForTesting()
    await tick()
    expect((await register(rotated)).status).toBe(200)
    expect((await rows())[0]?.claims).toEqual([pushClaimOf(PHONE), pushClaimOf(rotated)])
    primary.beforeRegister = async () => { await revokeWithPushPartLate(); await tick() }
    expect((await register(rotated)).status).toBe(401)
    await tick()
    await drainRevokeQueue()
    expect(await rows()).toEqual([])
  })

  it('re-pair, the old write landing last: the row stays for the new pairing alone, so revoking that one later takes it', async () => {
    primary.mode = 'real'
    let fresh = ''
    primary.beforeRegister = async () => {
      fresh = (await rotateDevice('my-phone', { by: LOCAL_ACTOR })).token
      await _settleRevokeWorkForTesting()
      await tick()
      expect((await register(fresh)).status).toBe(200)
    }
    expect((await register(PHONE)).status).toBe(401)
    expect((await rows())[0]?.claims).toEqual([pushClaimOf(fresh)])
    const sent = primary.calls.filter((c) => c.action === 'server.push.take-back').map((c) => c.params.liveClaims)
    expect(sent).toEqual([[pushClaimOf(fresh)]])
    primary.beforeRegister = async () => { await revokeWithPushPartLate(); await tick() }
    expect((await register(fresh)).status).toBe(401)
    await tick()
    await drainRevokeQueue()
    expect(await rows()).toEqual([])
  })
})

describe('the Mac checks and writes under the auth lock', () => {
  async function registerOnMacWith(between: () => Promise<void>): Promise<request.Response> {
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
    return register(PHONE)
  }

  it('the same phone paired again meanwhile and registered the same token: nothing written for the old one, the row stays', async () => {
    box.cloud = false
    const res = await registerOnMacWith(async () => {
      await rotateDevice('my-phone', { by: LOCAL_ACTOR })
      await _settleRevokeWorkForTesting()
      await registerPushToken({ token: ROW, platform: 'ios', environment: 'production', keyName: 'my-phone', origin: 'local' })
    })
    expect(res.status).toBe(401)
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
  })

  it('a different phone paired under the name right after the check: the write was inside the lock, so the old phone keeps no row', async () => {
    box.cloud = false
    const realRm = fs.rm.bind(fs) as (...a: unknown[]) => Promise<void>
    let armed = true
    vi.spyOn(fs, 'rm').mockImplementation((async (...a: unknown[]) => {
      const out = await realRm(...a)
      if (armed && String(a[0]) === LOCK()) {
        armed = false
        // Right after the register lets go of the auth lock: a write made inside it is older than this re-pair.
        await rotateDevice('my-phone', { by: LOCAL_ACTOR })
        await _settleRevokeWorkForTesting()
        await registerPushToken({ token: OTHER_ROW, platform: 'ios', environment: 'production', keyName: 'my-phone', origin: 'local' })
      }
      return out
    }) as typeof fs.rm)
    expect((await register(PHONE)).status).toBe(200)
    expect(armed).toBe(false)
    expect((await rows()).map((r) => r.token)).toEqual([OTHER_ROW])
  })

  it('the auth lock stays busy: 503 pairings_busy and nothing written; once it is free the write goes ahead', async () => {
    box.cloud = false
    await fs.mkdir(LOCK())
    await fs.writeFile(path.join(LOCK(), 'pid'), String(process.pid)) // a live holder that never lets go
    const res = await register(PHONE)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('pairings_busy')
    expect(res.body.retry).toBe(true)
    expect(await rows()).toEqual([])
    await fs.rm(LOCK(), { recursive: true, force: true })
    expect((await register(PHONE)).status).toBe(200)
    expect((await rows()).map((r) => r.token)).toEqual([ROW])
  }, 30_000)

  it('a different phone paired under the name meanwhile: its row stays, the old phone\'s is never written', async () => {
    box.cloud = false
    const res = await registerOnMacWith(async () => {
      await rotateDevice('my-phone', { by: LOCAL_ACTOR })
      await _settleRevokeWorkForTesting()
      await registerPushToken({ token: OTHER_ROW, platform: 'ios', environment: 'production', keyName: 'my-phone', origin: 'local' })
    })
    expect(res.status).toBe(401)
    expect((await rows()).map((r) => r.token)).toEqual([OTHER_ROW])
  })
})

describe('claims on a relayed row', () => {
  const write = (claim?: string, token = ROW) => onPrimary('register', {
    token, platform: 'ios', environment: 'production', keyName: 'my-phone', ...(claim ? { claim } : {}),
  })

  it('each relayed write of the row adds its claim; a local write keeps none', async () => {
    await write(pushClaimOf('a'))
    await write(pushClaimOf('b'))
    await write(pushClaimOf('a'))
    expect((await rows())[0]?.claims).toEqual([pushClaimOf('b'), pushClaimOf('a')])
    box.cloud = false
    await registerPushToken({ token: OTHER_ROW, platform: 'ios', keyName: 'my-phone', origin: 'local', claim: pushClaimOf('c') })
    expect((await rows()).find((r) => r.token === OTHER_ROW)?.claims).toBeUndefined()
  })

  it('at most the newest MAX_CLAIMS claims are kept', async () => {
    for (let i = 0; i < MAX_CLAIMS + 3; i++) await write(pushClaimOf(`b${i}`))
    const claims = (await rows())[0]?.claims ?? []
    expect(claims).toHaveLength(MAX_CLAIMS)
    expect(claims.at(-1)).toBe(pushClaimOf(`b${MAX_CLAIMS + 2}`))
  })

  it('a take-back keeps the row only for a live claim on it, and then keeps only the live claims', async () => {
    await write(pushClaimOf('a'))
    await write(pushClaimOf('b'))
    // The same phone paired again (claim b), its old pairing (a) gone: the row stays for b alone.
    expect(await takeBackPushToken('my-phone', pushTokenSha(ROW), [pushClaimOf('b')])).toEqual({ removed: 0, kept: 1 })
    expect((await rows())[0]?.claims).toEqual([pushClaimOf('b')])
    // The device changed its own token (a pairing's claim follows its token hash): the old claim
    // goes on the next take-back while the new one holds.
    await write(pushClaimOf('b2'))
    expect(await takeBackPushToken('my-phone', pushTokenSha(ROW), [pushClaimOf('b2')])).toEqual({ removed: 0, kept: 1 })
    expect((await rows())[0]?.claims).toEqual([pushClaimOf('b2')])
    // No live pairing of the name has a claim on it: the row goes.
    expect(await takeBackPushToken('my-phone', pushTokenSha(ROW), [pushClaimOf('z')])).toEqual({ removed: 1, kept: 0 })
    expect(await rows()).toEqual([])
  })

  it('a row with no claims, a stale claim alone, or a live claim the cap pushed out: the take-back removes it', async () => {
    await write(undefined) // an older companion: no claim
    expect(await takeBackPushToken('my-phone', pushTokenSha(ROW), [pushClaimOf('a')])).toEqual({ removed: 1, kept: 0 })
    await write(pushClaimOf('dead'))
    expect(await takeBackPushToken('my-phone', pushTokenSha(ROW), [])).toEqual({ removed: 1, kept: 0 })
    // The live pairing's claim, then MAX_CLAIMS newer ones: it is off the row, so the row goes.
    await write(pushClaimOf('live'))
    for (let i = 0; i < MAX_CLAIMS; i++) await write(pushClaimOf(`b${i}`))
    expect((await rows())[0]?.claims).not.toContain(pushClaimOf('live'))
    expect(await takeBackPushToken('my-phone', pushTokenSha(ROW), [pushClaimOf('live')])).toEqual({ removed: 1, kept: 0 })
    expect(await rows()).toEqual([])
  })

  it('a take-back never touches another name, origin or token', async () => {
    await write(pushClaimOf('a'))
    expect(await takeBackPushToken('acme-tablet', pushTokenSha(ROW), [])).toEqual({ removed: 0, kept: 0 })
    expect(await takeBackPushToken('my-phone', pushTokenSha(OTHER_ROW), [])).toEqual({ removed: 0, kept: 0 })
    box.cloud = false
    await registerPushToken({ token: OTHER_ROW, platform: 'ios', keyName: 'my-phone', origin: 'local' })
    expect(await takeBackPushToken('my-phone', pushTokenSha(OTHER_ROW), [])).toEqual({ removed: 0, kept: 0 })
    expect((await rows()).map((r) => r.token).sort()).toEqual([ROW, OTHER_ROW].sort())
  })

  it('a pairing\'s claim follows its token hash, the one auth.json keeps', () => {
    expect(pushClaimOf(PHONE)).toBe(pushClaimOfPairingHash(sha(PHONE)))
    expect(pushClaimOf(PHONE)).toMatch(/^[0-9a-f]{32}$/)
    expect(sha(PHONE).startsWith(pushClaimOf(PHONE))).toBe(false)
    expect(pushClaimOf(PHONE)).not.toBe(pushClaimOf(MAC))
  })

  it('a malformed take-back is refused', async () => {
    await expect(takeBackPushToken('my-phone', 'abc', [])).rejects.toThrow(/sha256/)
    await expect(takeBackPushToken('my-phone', pushTokenSha(ROW), pushClaimOf('a'))).rejects.toThrow(/live claims/)
    await expect(takeBackPushToken('my-phone', pushTokenSha(ROW), ['not-a-claim'])).rejects.toThrow(/live claims/)
    await expect(takeBackPushToken('my-phone', pushTokenSha(ROW), Array.from({ length: MAX_LIVE_CLAIMS + 1 }, (_, i) => pushClaimOf(`x${i}`)))).rejects.toThrow(/live claims/)
  })
})
