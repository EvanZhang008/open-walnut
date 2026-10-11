/**
 * A hash revoked here stays revoked in every read and write of the device
 * split (device-store.ts, device-pairings.ts), also when its record came back
 * by hand:
 *  - the pairing reads the push code uses (livePairingHashesOf, pairingRefOf,
 *    pairingRefHolds) never count it;
 *  - minting the instance id, a write of its own, keeps the revoked hashes
 *    (one that dropped them would let the token in again).
 *
 * One process, a private data dir, nothing relayed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-device-revoke-split'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, getInstanceId, livePairingHashesOf, pairingRefHolds, pairingRefOf, verifyDeviceToken,
} from '../../src/core/device-auth.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE = 'c3'.repeat(16)
const TABLET = 'd4'.repeat(16)
const AUTH = () => path.join(WALNUT_HOME, 'auth.json')

/** The phone's record is back by hand, but its hash was revoked here; the tablet is a live pairing. */
async function seedCameBack(): Promise<void> {
  const now = new Date().toISOString()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(AUTH(), JSON.stringify({
    devices: [
      { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE), createdAt: now, platform: 'ios' },
      { name: 'my-tablet', id: 'd00000000000000d4', tokenHash: sha(TABLET), createdAt: now, platform: 'ios' },
    ],
    revokedHashes: [sha(PHONE)],
  }, null, 2), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

const onDisk = async () => JSON.parse(await fs.readFile(AUTH(), 'utf-8')) as { instanceId?: string; revokedHashes?: string[] }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await seedCameBack()
})

describe('a revoked hash whose record came back', () => {
  it('is no live pairing for the push code, and its token names no pairing', async () => {
    expect(await livePairingHashesOf('my-phone')).toEqual([])
    expect(await livePairingHashesOf('my-tablet')).toEqual([sha(TABLET)])
    expect(await pairingRefOf(PHONE)).toBeNull()
    expect(await pairingRefOf(TABLET)).toMatchObject({ name: 'my-tablet', tokenHash: sha(TABLET) })
    expect(await pairingRefHolds({ name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(PHONE) })).toBe(false)
    expect(await pairingRefHolds({ name: 'my-tablet', id: 'd00000000000000d4', tokenHash: sha(TABLET) })).toBe(true)
  })

  it('stays revoked through the write that mints the instance id', async () => {
    expect((await onDisk()).instanceId).toBeUndefined()
    const id = await getInstanceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    const after = await onDisk()
    expect(after.instanceId).toBe(id)
    expect(after.revokedHashes).toEqual([sha(PHONE)])
    _resetDeviceAuthForTesting()
    expect(await verifyDeviceToken(PHONE)).toBeNull()
    expect(await verifyDeviceToken(TABLET)).toEqual({ name: 'my-tablet' })
  })
})
