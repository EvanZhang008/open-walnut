/**
 * The revoke's smaller promises, each pinned on its own:
 *
 *  - the revoke queue's drain waits only briefly for the auth lock (its holder
 *    may be waiting on it), and runs a step with the revoke time stamped after
 *    the auth.json write even when it read the entry before that stamp;
 *  - a hash revoked here stays revoked: on a re-pair by someone else, through a
 *    recovery from auth.json.bak (also when no pairing is left), and in the
 *    drain's judgment when the hash's record came back by hand;
 *  - a re-pair's push part takes its cutoff after the auth.json write;
 *  - a revoke whose auth.json write fails takes its queued parts back inside
 *    the lock, so a second revoke of the pairing keeps its own.
 *
 * One process, a private data dir. CLOUD_MODE is a getter: on for the
 * companion, off while a relayed call runs as the primary. The bridge is the one fake.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const box = vi.hoisted(() => ({ cloud: true }))
vi.mock('../../src/constants.js', () => ({
  ...createMockConstants('walnut-device-revoke-gaps', { CLOUD_MODE: true }),
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
      if (primary.mode === 'offline') return { ok: false, failure: { kind: 'bridge_offline', message: 'no bridge in this test', notSent: true } }
      primary.calls.push({ action, params })
      if (action === 'server.devices.revoke-by-hash') return { ok: true, result: { name: 'twin', revoked: true } }
      if (primary.mode === 'ok') return { ok: true, result: action === 'server.push.revoke-device' ? { removed: 1 } : {} }
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
  _resetDeviceAuthForTesting, _settleRevokeWorkForTesting, listDeviceRecords, revokePairing, rotateDevice, verifyDeviceToken,
} from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import { adoptDeviceRecord } from '../../src/core/device-adoption.js'
import { getConfig } from '../../src/core/config-manager.js'
import { handlePushRelayAction } from '../../src/core/push/relay.js'
import { drainRevokeQueue, enqueueRevokeStep, queuedRevokeSteps, stampRevokedAt } from '../../src/core/devices/revoke-queue.js'
import { _resetDeviceTwinsForTesting } from '../../src/web/routes/device-twins.js'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { runDeviceRevoke } from '../../src/commands/device.js'
import { withFileLock } from '../../src/utils/file-lock.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const MAC = 'a1'.repeat(16)
const PHONE = 'c3'.repeat(16)
const LATE_ROW = 'e5'.repeat(32)
const AUTH = () => path.join(WALNUT_HOME, 'auth.json')
const LOCK = () => `${AUTH()}.lock`
const QDIR = () => path.join(WALNUT_HOME, 'cache', 'revoke-queue')
const PHONE_RECORD = () => ({ name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE), createdAt: new Date().toISOString(), platform: 'ios' })

async function seed(opts: { withMac?: boolean } = {}): Promise<void> {
  const now = new Date().toISOString()
  const devices = [
    ...(opts.withMac === false ? [] : [{ name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(MAC), createdAt: now }]),
    PHONE_RECORD(),
  ]
  await fs.writeFile(AUTH(), JSON.stringify({ devices }, null, 2), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

const relayedRows = async (): Promise<string[]> =>
  ((await getConfig()).push_tokens ?? []).filter((t) => t.key_name === 'my-phone' && t.origin === 'relay').map((t) => t.token)

async function registerOnPrimary(token: string): Promise<void> {
  const was = box.cloud
  box.cloud = false
  try {
    await handlePushRelayAction('register', { token, platform: 'ios', environment: 'production', keyName: 'my-phone' })
  } finally {
    box.cloud = was
  }
}

/** Run `during` once, right before the next rename that replaces auth.json. */
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

const calls = (action: string) => primary.calls.filter((c) => c.action === action)

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  box.cloud = true
  primary.mode = 'offline'
  primary.calls.length = 0
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

describe('the drain and the auth lock', () => {
  it('with the lock held, a drain gives up within a few seconds rather than waiting the lock\'s full timeout', async () => {
    await runDeviceRevoke('my-phone', {} as never)
    expect(await queuedRevokeSteps()).toHaveLength(2)
    await fs.mkdir(LOCK())
    await fs.writeFile(path.join(LOCK(), 'pid'), String(process.pid)) // a live holder that never lets go
    primary.mode = 'ok'
    const drain = drainRevokeQueue()
    const first = await Promise.race([
      drain.then(() => 'drain'),
      new Promise((r) => setTimeout(() => r('timer'), 5_000)),
    ])
    expect(first).toBe('drain')
    expect(await drain).toEqual({ done: 0, left: 2 })
    expect(primary.calls).toEqual([])
  })

  it('an entry read before the revoke stamped it runs with the stamped time', async () => {
    primary.mode = 'ok'
    let judged: { done: number; left: number } | null = null
    // Attempts, each from a fresh queue: the drain gets the lock only while it
    // waits (a quarter second), and a loaded machine can miss that once.
    for (let attempt = 0; attempt < 5 && judged?.done !== 1; attempt++) {
      await fs.rm(QDIR(), { recursive: true, force: true })
      await seed()
      primary.calls.length = 0
      // The revoke's write-ahead, a minute ago; the revoke still holds the lock.
      const opId = await enqueueRevokeStep({ step: 'push', name: 'my-phone', revokedAt: new Date(Date.now() - 60_000).toISOString(), pairingHash: sha(PHONE) })
      expect(opId).not.toBeNull()
      let readFirst!: () => void
      const firstRead = new Promise<void>((r) => { readFirst = r })
      const realReaddir = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>
      const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (...a: unknown[]) => {
        const out = await realReaddir(...a)
        if (String(a[0]) === QDIR()) readFirst()
        return out
      }) as typeof fs.readdir)
      let drain!: Promise<{ done: number; left: number }>
      await withFileLock(AUTH(), async () => {
        drain = drainRevokeQueue()
        await firstRead
        // The revoke's auth.json write, then its stamp, before it lets go.
        await fs.writeFile(AUTH(), JSON.stringify({ devices: [], revokedHashes: [sha(PHONE)] }), { mode: 0o600 })
        await stampRevokedAt(opId!, new Date().toISOString())
      })
      judged = await drain
      spy.mockRestore()
    }
    expect(judged).toEqual({ done: 1, left: 0 })
    const ago = calls('server.push.revoke-device').map((c) => c.params.revokedMsAgo as number)
    expect(ago).toHaveLength(1)
    expect(ago[0]).toBeLessThan(30_000)
  })

  it('a revoked hash whose record came back by hand: its queued parts still run', async () => {
    await runDeviceRevoke('my-phone', {} as never)
    const auth = JSON.parse(await fs.readFile(AUTH(), 'utf-8')) as { devices: unknown[]; revokedHashes?: string[] }
    expect(auth.revokedHashes).toContain(sha(PHONE))
    auth.devices.push(PHONE_RECORD())
    await fs.writeFile(AUTH(), JSON.stringify(auth), { mode: 0o600 })
    primary.mode = 'ok'
    expect(await drainRevokeQueue()).toEqual({ done: 2, left: 0 })
    expect(calls('server.push.revoke-device')).toHaveLength(1)
    expect(calls('server.devices.revoke-by-hash')).toHaveLength(1)
  })
})

describe('a hash revoked here stays revoked', () => {
  async function drainedClean(): Promise<void> {
    primary.mode = 'ok'
    await _settleRevokeWorkForTesting()
    await drainRevokeQueue()
    expect(await queuedRevokeSteps()).toEqual([])
  }

  it('a re-pair by someone else records the old hash: never adopted back, even after its queue entries are gone', async () => {
    await rotateDevice('my-phone', { by: LOCAL_ACTOR })
    await drainedClean()
    const auth = JSON.parse(await fs.readFile(AUTH(), 'utf-8')) as { revokedHashes?: string[] }
    expect(auth.revokedHashes).toContain(sha(PHONE))
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'cloud' })).rejects.toThrow(/revoked here/)
  })

  it('auth.json lost: the recovery from auth.json.bak keeps the list', async () => {
    await revokePairing('my-phone')
    await drainedClean()
    await fs.rm(AUTH())
    _resetDeviceAuthForTesting()
    expect(await verifyDeviceToken(MAC)).toMatchObject({ name: 'mac-primary' }) // recovered from the sidecar
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'cloud' })).rejects.toThrow(/revoked here/)
  })

  it('auth.json lost with no pairing left: the sidecar still carries the list, and the recovery keeps it', async () => {
    await seed({ withMac: false })
    await revokePairing('my-phone')
    await drainedClean()
    expect(await listDeviceRecords()).toEqual([])
    const backup = JSON.parse(await fs.readFile(`${AUTH()}.bak`, 'utf-8')) as { devices: unknown[]; revokedHashes?: string[] }
    expect(backup).toMatchObject({ devices: [], revokedHashes: [sha(PHONE)] })
    await fs.rm(AUTH())
    _resetDeviceAuthForTesting()
    await expect(adoptDeviceRecord({ name: 'my-phone', tokenHash: sha(PHONE), adoptedFrom: 'cloud' })).rejects.toThrow(/revoked here/)
    const restored = JSON.parse(await fs.readFile(AUTH(), 'utf-8')) as { revokedHashes?: string[] }
    expect(restored.revokedHashes).toEqual([sha(PHONE)])
  })
})

describe('a re-pair\'s push part', () => {
  it('takes its cutoff after the auth.json write: a late row the old token registered in its write window goes', async () => {
    await registerOnPrimary('d4'.repeat(32))
    primary.mode = 'real'
    const hook = atAuthWrite(() => registerOnPrimary(LATE_ROW))
    const fresh = await rotateDevice('my-phone', { by: LOCAL_ACTOR })
    await _settleRevokeWorkForTesting()
    expect(hook.fired()).toBe(true)
    expect(await relayedRows()).toEqual([])
    expect(await verifyDeviceToken(fresh.token)).toMatchObject({ name: 'my-phone' })
  })
})

describe('a revoke whose auth.json write fails', () => {
  it('takes its parts back inside the lock: a second revoke started meanwhile keeps its twin part queued', async () => {
    const realRename = fs.rename.bind(fs)
    const realRm = fs.rm.bind(fs) as (...a: unknown[]) => Promise<void>
    const realMkdir = fs.mkdir.bind(fs) as (...a: unknown[]) => Promise<unknown>
    let failOnce = true
    let rollingBack = false
    let lockTried: ((took: boolean) => void) | null = null
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (failOnce && String(to) === AUTH()) {
        failOnce = false
        rollingBack = true
        throw Object.assign(new Error('EIO on the first revoke\'s auth.json write'), { code: 'EIO' })
      }
      return realRename(from, to)
    })
    vi.spyOn(fs, 'mkdir').mockImplementation((async (...a: unknown[]) => {
      const tried = String(a[0]) === LOCK() ? lockTried : null
      try {
        const out = await realMkdir(...a)
        tried?.(true)
        return out
      } catch (err) {
        tried?.(false)
        throw err
      }
    }) as typeof fs.mkdir)
    const later: { second?: ReturnType<typeof revokePairing> } = {}
    vi.spyOn(fs, 'rm').mockImplementation((async (...a: unknown[]) => {
      if (rollingBack && String(a[0]).startsWith(QDIR())) {
        rollingBack = false
        // The second revoke starts right as the first takes its parts back.
        const took = new Promise<boolean>((r) => { lockTried = r })
        later.second = revokePairing('my-phone')
        // Taken: the rollback runs outside the lock, so let the second revoke
        // land in that gap. Not taken (busy): it waits for this rollback.
        if (await took) await later.second
        lockTried = null
      }
      return realRm(...a)
    }) as typeof fs.rm)
    await expect(revokePairing('my-phone')).rejects.toThrow(/EIO/)
    expect(later.second).toBeDefined()
    const out = await later.second!
    expect(out.revoked).toBe(true)
    expect(out.twin).toBe('queued')
    expect((await listDeviceRecords()).some((d) => d.tokenHash === sha(PHONE))).toBe(false)
    const queued = await queuedRevokeSteps()
    expect(queued).toContainEqual({ step: 'twin', tokenHash: sha(PHONE) })
    expect(queued.some((s) => s.step === 'push' && s.name === 'my-phone')).toBe(true)
  })
})
