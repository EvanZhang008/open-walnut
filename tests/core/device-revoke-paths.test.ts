/**
 * Every way a pairing ends on the PRIMARY stops that device's pushes, because
 * they all go through one function (device-auth.ts `revokePairing`):
 *  - `walnut device revoke <name>` (the CLI used to remove only the pairing, so
 *    a lost phone kept getting letter subjects on its lock screen);
 *  - a revoke by hash, asked for by the other box (device-adoption.ts);
 *  - a re-pair of the name by anyone but the device itself (a new pairing);
 *  - the console route, pinned in tests/web/routes/device-revoke-push.test.ts.
 * A device rotating its own token stays the same device and keeps its rows.
 *
 * Each revoke also removes the pairing's copy on the other box (device-twins.ts),
 * or the revoked token keeps working there and the phone can register for pushes
 * through it again. That module is the one thing faked here. Both parts are
 * written to the revoke queue (core/devices/revoke-queue.ts) BEFORE the pairing
 * leaves auth.json and cleared when they finish, so a kill at any point leaves
 * them for the server; a part the CLI cannot finish stays queued, and so does
 * every copy removal the server itself starts (its retries end with a restart).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-device-revoke-paths'))

const twins = vi.hoisted(() => ({
  removeTwinOnce: vi.fn(async (_hash: string) => true),
  revokeAdoptionTwin: vi.fn(async (_hash: string) => {}),
}))
vi.mock('../../src/web/routes/device-twins.js', () => twins)

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, _settleRevokeWorkForTesting, createDevice, listDeviceRecords, rotateDevice, revokePairing,
} from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import { revokeAdoptedByHash } from '../../src/core/device-adoption.js'
import { handleDevicesRelayAction } from '../../src/core/devices/relay.js'
import { drainRevokeQueue, enqueueRevokeStep, queuedRevokeSteps } from '../../src/core/devices/revoke-queue.js'
import { registerPushToken } from '../../src/core/push/registry.js'
import { runDeviceRevoke } from '../../src/commands/device.js'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'
import type { PushTokenEntry } from '../../src/core/types.js'

const PHONE_TOKEN = 'a'.repeat(64)
const TABLET_TOKEN = 'b'.repeat(64)
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

async function rows(): Promise<PushTokenEntry[]> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    return ((yaml.load(raw) ?? {}) as { push_tokens?: PushTokenEntry[] }).push_tokens ?? []
  } catch {
    return []
  }
}
const rowNames = async () => (await rows()).map((r) => r.key_name).sort()
const hashOf = async (name: string) => (await listDeviceRecords()).find((d) => d.name === name)?.tokenHash

/** Two paired devices, each with its own push row. Returns their device tokens. */
async function seed(): Promise<{ phone: string; tablet: string }> {
  const phone = (await createDevice('acme-phone')).token
  const tablet = (await createDevice('acme-tablet')).token
  await registerPushToken({ token: PHONE_TOKEN, platform: 'ios', keyName: 'acme-phone', origin: 'local' })
  await registerPushToken({ token: TABLET_TOKEN, platform: 'ios', keyName: 'acme-tablet', origin: 'local' })
  expect(await rowNames()).toEqual(['acme-phone', 'acme-tablet'])
  return { phone, tablet }
}

let out: string[]
let exitCodeBefore: typeof process.exitCode

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  twins.removeTwinOnce.mockReset().mockResolvedValue(true)
  twins.revokeAdoptionTwin.mockReset().mockResolvedValue(undefined)
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  exitCodeBefore = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = exitCodeBefore
})

describe('walnut device revoke <name>', () => {
  it('removes the device\'s push rows (and only its own), and its copy on the other box', async () => {
    await seed()
    const phoneHash = await hashOf('acme-phone')
    await runDeviceRevoke('acme-phone', {} as never)
    expect(out.join('\n')).toContain('Device "acme-phone" revoked.')
    expect(process.exitCode).toBeUndefined()
    expect(await rowNames()).toEqual(['acme-tablet'])
    expect((await listDeviceRecords()).map((d) => d.name)).toEqual(['acme-tablet'])
    // The CLI process has no timer that outlives it: one awaited try.
    expect(twins.removeTwinOnce.mock.calls).toEqual([[phoneHash]])
    expect(twins.revokeAdoptionTwin).not.toHaveBeenCalled()
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('--json reports the rows it removed', async () => {
    await seed()
    await runDeviceRevoke('acme-phone', { json: true } as never)
    expect(JSON.parse(out.join(''))).toEqual({ name: 'acme-phone', revoked: true, pushTokensRevoked: 1, otherBoxCopy: 'done' })
  })

  it('an unknown name changes nothing and exits 1', async () => {
    await seed()
    await runDeviceRevoke('acme-ghost', {} as never)
    expect(process.exitCode).toBe(1)
    expect(await rowNames()).toEqual(['acme-phone', 'acme-tablet'])
    expect(twins.removeTwinOnce).not.toHaveBeenCalled()
  })

  it('the other box unreachable: the copy is queued for the server, which removes it on its next drain', async () => {
    await seed()
    const phoneHash = await hashOf('acme-phone')
    twins.removeTwinOnce.mockResolvedValueOnce(false)
    await runDeviceRevoke('acme-phone', {} as never)
    expect(process.exitCode).toBeUndefined() // queued is not a failure: the server finishes it
    expect(out.join('\n')).toMatch(/server finishes the rest/)
    expect(await rowNames()).toEqual(['acme-tablet']) // the rows here never wait
    expect(await queuedRevokeSteps()).toEqual([{ step: 'twin', tokenHash: phoneHash }])
    // The queue file is local state with the old token's hash: owner-only, not synced.
    const dir = path.join(WALNUT_HOME, 'cache', 'revoke-queue')
    const [file] = await fs.readdir(dir)
    expect((await fs.stat(path.join(dir, file))).mode & 0o777).toBe(0o600)

    // Still unreachable: kept. Reachable: done, and gone from the queue.
    twins.removeTwinOnce.mockResolvedValueOnce(false)
    expect(await drainRevokeQueue()).toEqual({ done: 0, left: 1 })
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    expect(twins.removeTwinOnce.mock.calls.map((c) => c[0])).toEqual([phoneHash, phoneHash, phoneHash])
    expect(await queuedRevokeSteps()).toEqual([])
  })
})

describe('the other revoke paths', () => {
  it('a revoke by hash (the other box removed its copy) removes the push rows and does not ask back', async () => {
    const { phone } = await seed()
    expect(await revokeAdoptedByHash(sha(phone))).toBe('acme-phone')
    expect(await rowNames()).toEqual(['acme-tablet'])
    expect(twins.removeTwinOnce).not.toHaveBeenCalled()
    expect(twins.revokeAdoptionTwin).not.toHaveBeenCalled()
  })

  it('the primary\'s relay handler for `server.devices.revoke-by-hash` does the same', async () => {
    const { tablet } = await seed()
    expect(await handleDevicesRelayAction('revoke-by-hash', { tokenHash: sha(tablet) })).toEqual({ name: 'acme-tablet', revoked: true })
    expect(await rowNames()).toEqual(['acme-phone'])
  })

  it('revokePairing reports what it removed', async () => {
    await seed()
    const outcome = await revokePairing('acme-tablet')
    expect(outcome).toEqual({ revoked: true, push: { removed: 1, relayed: false }, twin: 'done' })
    expect(await revokePairing('acme-tablet')).toEqual({ revoked: false, push: null, twin: null })
  })

  it('a re-pair by someone else is a new pairing: the old one loses its rows and its copy', async () => {
    await seed()
    const oldHash = await hashOf('acme-phone')
    const repaired = await rotateDevice('acme-phone', { by: LOCAL_ACTOR })
    expect(repaired.replaced).toBe(true)
    await _settleRevokeWorkForTesting() // the old pairing's parts run after the new token is handed out
    expect(await rowNames()).toEqual(['acme-tablet'])
    expect(twins.removeTwinOnce.mock.calls).toEqual([[oldHash]])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('a device rotating its own token stays the same device: its rows stay, the old token\'s copy goes', async () => {
    const { phone } = await seed()
    const oldHash = await hashOf('acme-phone')
    await rotateDevice('acme-phone', { by: { token: phone } })
    await _settleRevokeWorkForTesting()
    expect(await rowNames()).toEqual(['acme-phone', 'acme-tablet'])
    expect(twins.removeTwinOnce.mock.calls).toEqual([[oldHash]])
  })

  it('a pushed row whose name is an API key is not touched by a device revoke', async () => {
    await seed()
    await registerPushToken({ token: 'c'.repeat(64), platform: 'ios', keyName: 'acme-script', origin: 'local' })
    await runDeviceRevoke('acme-phone', {} as never)
    expect(await rowNames()).toEqual(['acme-script', 'acme-tablet'])
  })
})

describe('in the running server, the copy\'s removal outlives a restart', () => {
  afterEach(() => setSelfApiRoot(null))

  it('a console revoke with the companion down: tried at once and queued; after the restart the drain removes it', async () => {
    setSelfApiRoot('http://127.0.0.1:1') // this process is the server
    await seed()
    const phoneHash = await hashOf('acme-phone')
    expect(await revokePairing('acme-phone')).toMatchObject({ revoked: true, twin: 'background' })
    // At once, in process. Its retries (faked away here) live in memory, which a restart ends...
    expect(twins.revokeAdoptionTwin.mock.calls).toEqual([[phoneHash]])
    // ...so the removal is on disk too.
    expect(await queuedRevokeSteps()).toEqual([{ step: 'twin', tokenHash: phoneHash }])

    // What the restarted server runs: its start drain while the companion is still down
    // keeps the step; the next one, with the companion back, removes the copy.
    twins.removeTwinOnce.mockResolvedValueOnce(false)
    expect(await drainRevokeQueue()).toEqual({ done: 0, left: 1 })
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    expect(twins.removeTwinOnce.mock.calls).toEqual([[phoneHash], [phoneHash]])
    expect(await queuedRevokeSteps()).toEqual([])
  })
})

describe('write ahead: the parts are queued before the pairing goes', () => {
  /** What the revoke queue held at the moment auth.json was replaced. */
  function queueAtAuthWrite(): Array<Record<string, unknown>[]> {
    const seen: Array<Record<string, unknown>[]> = []
    const real = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(WALNUT_HOME, 'auth.json')) {
        const dir = path.join(WALNUT_HOME, 'cache', 'revoke-queue')
        const names = fsSync.existsSync(dir) ? fsSync.readdirSync(dir).filter((n) => n.endsWith('.json')) : []
        seen.push(names.map((n) => JSON.parse(fsSync.readFileSync(path.join(dir, n), 'utf-8')) as Record<string, unknown>))
      }
      return real(from, to)
    })
    return seen
  }

  it('when auth.json loses the pairing, both parts are already on disk; each is cleared when it finishes', async () => {
    await seed()
    const phoneHash = await hashOf('acme-phone')
    const seen = queueAtAuthWrite()
    await runDeviceRevoke('acme-phone', {} as never)
    // The revoke's own auth.json write (the first one after the spy).
    expect(seen[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'push', name: 'acme-phone', pairingHash: phoneHash, revokedAt: expect.any(String) }),
      expect.objectContaining({ step: 'twin', tokenHash: phoneHash }),
    ]))
    expect(await rowNames()).toEqual(['acme-tablet'])
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('a re-pair writes them ahead too', async () => {
    await seed()
    const oldHash = await hashOf('acme-phone')
    const seen = queueAtAuthWrite()
    await rotateDevice('acme-phone', { by: LOCAL_ACTOR })
    expect(seen[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'push', name: 'acme-phone', pairingHash: oldHash }),
      expect.objectContaining({ step: 'twin', tokenHash: oldHash }),
    ]))
    await _settleRevokeWorkForTesting()
    expect(await queuedRevokeSteps()).toEqual([])
  })

  it('a revoke whose parts wait, then the same name paired again, then the drain: the old pairing\'s row and copy go, the new pairing is untouched', async () => {
    await seed()
    const oldHash = (await hashOf('acme-phone'))!
    // The revoke: its parts are written ahead, then neither can finish here.
    const real = fs.rename.bind(fs)
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === CONFIG_FILE) throw new Error('ENOSPC: no space left on device')
      return real(from, to)
    })
    twins.removeTwinOnce.mockResolvedValueOnce(false)
    await runDeviceRevoke('acme-phone', {} as never)
    fail.mockRestore()
    expect(await queuedRevokeSteps()).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'push', name: 'acme-phone', pairingHash: oldHash }),
      { step: 'twin', tokenHash: oldHash },
    ]))
    // The same name, paired again: a pairing with that NAME is here, but not the revoked one.
    await createDevice('acme-phone')
    const newHash = (await hashOf('acme-phone'))!
    expect(newHash).not.toBe(oldHash)
    twins.removeTwinOnce.mockClear()
    expect(await drainRevokeQueue()).toEqual({ done: 2, left: 0 })
    expect(await rowNames()).toEqual(['acme-tablet']) // the old phone's row is gone
    expect(twins.removeTwinOnce.mock.calls).toEqual([[oldHash]]) // the old copy, never the new one
    expect(await hashOf('acme-phone')).toBe(newHash) // the new pairing is untouched
    // ...and its own row, registered now, is kept by any later drain.
    await registerPushToken({ token: 'd'.repeat(64), platform: 'ios', keyName: 'acme-phone', origin: 'local' })
    expect(await drainRevokeQueue()).toEqual({ done: 0, left: 0 })
    expect(await rowNames()).toEqual(['acme-phone', 'acme-tablet'])
  })

  it('killed before its auth.json write: the drain finds the pairing still here and drops both parts unrun', async () => {
    await seed()
    const phoneHash = (await hashOf('acme-phone'))!
    // What a process killed between the intent and the auth.json write leaves behind.
    await enqueueRevokeStep({ step: 'push', name: 'acme-phone', revokedAt: new Date().toISOString(), pairingHash: phoneHash })
    await enqueueRevokeStep({ step: 'twin', tokenHash: phoneHash })
    expect(await drainRevokeQueue()).toEqual({ done: 2, left: 0 })
    expect(await rowNames()).toEqual(['acme-phone', 'acme-tablet'])
    expect(twins.removeTwinOnce).not.toHaveBeenCalled()
    expect(await queuedRevokeSteps()).toEqual([])
  })
})

describe('walnut device revoke says which part is left', () => {
  it('this machine\'s config write failed: it says so, not that the other box was unreachable; the server finishes it', async () => {
    await seed()
    const real = fs.rename.bind(fs)
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === CONFIG_FILE) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return real(from, to)
    })
    await runDeviceRevoke('acme-phone', {} as never)
    const text = out.join('\n')
    expect(text).toContain('Its push rows on this machine could not be removed yet')
    expect(text).not.toMatch(/could not be reached/)
    expect(text).toMatch(/server finishes the rest/)
    expect(process.exitCode).toBeUndefined()
    expect(await queuedRevokeSteps()).toEqual([expect.objectContaining({ step: 'push', name: 'acme-phone' })])
    // The server's drain, once the disk takes writes again.
    fail.mockRestore()
    expect(await drainRevokeQueue()).toEqual({ done: 1, left: 0 })
    expect(await rowNames()).toEqual(['acme-tablet'])
  })

  it('--json names the part: pushRevokePendingWhere is "here"', async () => {
    await seed()
    const real = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === CONFIG_FILE) throw new Error('ENOSPC: no space left on device')
      return real(from, to)
    })
    await runDeviceRevoke('acme-phone', { json: true } as never)
    expect(JSON.parse(out.join(''))).toMatchObject({ revoked: true, pushRevokePending: true, pushRevokeQueued: true, pushRevokePendingWhere: 'here' })
  })
})
