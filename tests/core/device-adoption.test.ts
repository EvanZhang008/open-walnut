/**
 * Device adoption (src/core/device-adoption.ts): copying another box's pairing
 * hash into this registry, and revoking it by hash.
 *
 * The rules pinned here: the same hash twice changes nothing; a taken name gets
 * a suffix and the existing record is never touched; a phone cannot adopt; a
 * revoke by hash removes exactly that pairing and is heard like any revoke.
 * auth.json lives in the mocked WALNUT_HOME, written fresh for every case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-device-adoption'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  createDevice, getInstanceId, listDevices, onCredentialsRevoked, verifyDeviceToken, _resetDeviceAuthForTesting,
} from '../../src/core/device-auth.js'
import { AdoptionError, adoptDeviceRecord, revokeAdoptedByHash } from '../../src/core/device-adoption.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const authFile = () => path.join(WALNUT_HOME, 'auth.json')
type Rec = Record<string, unknown>
const records = async () => (JSON.parse(await fs.readFile(authFile(), 'utf-8')) as { devices: Rec[]; instanceId?: string }).devices
const raw = async () => fs.readFile(authFile(), 'utf-8')

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
})

async function seed(devices: Rec[]): Promise<void> {
  await fs.writeFile(authFile(), JSON.stringify({ devices }), { mode: 0o600 })
}

describe('adoptDeviceRecord', () => {
  it('a free name: a new record with the source\'s id, platform and report, marked adoptedFrom; the token now verifies here', async () => {
    const token = tok()
    const out = await adoptDeviceRecord({
      name: 'evan-iphone', tokenHash: sha(token), id: 'd0123456789abcdef', platform: 'ios',
      info: { model: 'iPhone17,1', os: 'iOS 26.1', appVersion: '1.0 (84)', reportedAt: '2026-09-30T08:00:00.000Z', extra: 'dropped' },
      adoptedFrom: 'cloud',
    })
    expect(out).toEqual({ name: 'evan-iphone', adopted: true })
    const [r] = await records()
    expect(r).toEqual({
      name: 'evan-iphone', id: 'd0123456789abcdef', tokenHash: sha(token), createdAt: expect.any(String), platform: 'ios',
      info: { model: 'iPhone17,1', os: 'iOS 26.1', appVersion: '1.0 (84)', reportedAt: '2026-09-30T08:00:00.000Z' },
      adoptedFrom: 'cloud',
    })
    expect(r).not.toHaveProperty('kind')
    expect(await verifyDeviceToken(token)).toEqual({ name: 'evan-iphone' })
    expect((await listDevices())[0]).toMatchObject({ name: 'evan-iphone', adoptedFrom: 'cloud' })
  })

  it('the same hash again is a no-op: same answer, file untouched', async () => {
    const token = tok()
    await adoptDeviceRecord({ name: 'evan-iphone', tokenHash: sha(token), adoptedFrom: 'primary' })
    const before = await raw()
    // Even under another requested name: the pairing is already here.
    expect(await adoptDeviceRecord({ name: 'renamed', tokenHash: sha(token), adoptedFrom: 'primary' })).toEqual({ name: 'evan-iphone', adopted: false })
    expect(await raw()).toBe(before)
  })

  it('a name taken by another pairing: the copy gets name-2, name-3; the original keeps its hash and id', async () => {
    const original = { name: 'evan-iphone', id: 'd00000000000000a1', tokenHash: sha(tok()), createdAt: '2026-09-01T00:00:00.000Z', platform: 'ios' }
    await seed([original, { name: 'evan-iphone-2', id: 'd00000000000000a2', tokenHash: sha(tok()), createdAt: '2026-09-01T00:00:00.000Z' }])
    const h3 = sha(tok())
    expect(await adoptDeviceRecord({ name: 'evan-iphone', tokenHash: h3, adoptedFrom: 'cloud' })).toEqual({ name: 'evan-iphone-3', adopted: true })
    const all = await records()
    expect(all.find((d) => d.name === 'evan-iphone')).toEqual(original)
    expect(all.find((d) => d.name === 'evan-iphone-3')).toMatchObject({ tokenHash: h3, adoptedFrom: 'cloud' })
    expect(all).toHaveLength(3)
  })

  it('a suffix never breaks the 64-char name rule', async () => {
    const long = `a${'b'.repeat(63)}`
    await seed([{ name: long, id: 'd00000000000000a1', tokenHash: sha(tok()), createdAt: '2026-09-01T00:00:00.000Z' }])
    const out = await adoptDeviceRecord({ name: long, tokenHash: sha(tok()), adoptedFrom: 'cloud' })
    expect(out.name).toBe(`a${'b'.repeat(61)}-2`)
    expect(out.name).toHaveLength(64)
  })

  it('an id another record here already uses (as its own or as an owner) is replaced by a fresh one', async () => {
    await seed([
      { name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(tok()), createdAt: '2026-09-01T00:00:00.000Z' },
      { name: 'bridge-local', id: 'd00000000000000b2', tokenHash: sha(tok()), createdAt: '2026-09-01T00:00:00.000Z', kind: 'machine', ownerId: 'd00000000000000c3' },
    ])
    for (const id of ['d00000000000000a1', 'd00000000000000c3', 'not-an-id']) {
      const hash = sha(tok())
      await adoptDeviceRecord({ name: `copy-${id.slice(-2)}`, tokenHash: hash, id, adoptedFrom: 'cloud' })
      const r = (await records()).find((d) => d.tokenHash === hash)!
      expect(r.id, id).not.toBe(id)
      expect(r.id).toMatch(/^d[0-9a-f]{16}$/)
    }
  })

  it('a phone without a recorded platform stays a phone here (its report says so)', async () => {
    await adoptDeviceRecord({ name: 'old-phone', tokenHash: sha(tok()), info: { model: 'iPhone15,2', os: 'iOS 18.0' }, adoptedFrom: 'cloud' })
    expect((await records())[0].platform).toBe('ios')
  })

  it('refuses a malformed hash or name, and never writes', async () => {
    for (const tokenHash of ['', 'ABC', 'A'.repeat(64), 'g'.repeat(64), sha('x').slice(1), 42, null]) {
      await expect(adoptDeviceRecord({ name: 'ok-name', tokenHash, adoptedFrom: 'cloud' })).rejects.toBeInstanceOf(AdoptionError)
    }
    for (const name of ['', 'has space', 'evan (2)', '-leading-dash', 'x'.repeat(65), 7]) {
      await expect(adoptDeviceRecord({ name, tokenHash: sha(tok()), adoptedFrom: 'cloud' })).rejects.toThrow(/Invalid device name/)
    }
    await expect(fs.access(authFile())).rejects.toThrow()
  })

  it('a phone may not adopt (phone_cannot_pair); the Mac\'s token and an API key may', async () => {
    const phoneTok = tok()
    const macTok = tok()
    await seed([
      { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(phoneTok), createdAt: '2026-09-01T00:00:00.000Z', platform: 'ios' },
      { name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(macTok), createdAt: '2026-09-01T00:00:00.000Z' },
    ])
    await expect(adoptDeviceRecord({ name: 'laundered', tokenHash: sha(tok()), adoptedFrom: 'primary' }, { by: { token: phoneTok } }))
      .rejects.toMatchObject({ status: 403, code: 'phone_cannot_pair' })
    expect(await adoptDeviceRecord({ name: 'via-mac', tokenHash: sha(tok()), adoptedFrom: 'primary' }, { by: { token: macTok } })).toMatchObject({ adopted: true })
    expect(await adoptDeviceRecord({ name: 'via-key', tokenHash: sha(tok()), adoptedFrom: 'primary' }, { by: { apiKey: 'script' } })).toMatchObject({ adopted: true })
    expect((await records()).map((d) => d.name).sort()).toEqual(['mac-primary', 'my-phone', 'via-key', 'via-mac'])
  })

  it('concurrent adoptions of one hash leave exactly one record', async () => {
    const hash = sha(tok())
    const outs = await Promise.all(Array.from({ length: 5 }, () => adoptDeviceRecord({ name: 'racer', tokenHash: hash, adoptedFrom: 'cloud' })))
    expect(outs.filter((o) => o.adopted)).toHaveLength(1)
    expect(outs.every((o) => o.name === 'racer')).toBe(true)
    expect(await records()).toHaveLength(1)
  })
})

describe('revokeAdoptedByHash', () => {
  it('removes exactly the record with that hash and is heard by revoke listeners', async () => {
    const keep = await createDevice('evan-iphone')
    const token = tok()
    await adoptDeviceRecord({ name: 'evan-iphone', tokenHash: sha(token), adoptedFrom: 'cloud' }) // lands as evan-iphone-2
    const heard: string[][] = []
    const off = onCredentialsRevoked((names) => heard.push(names))
    try {
      expect(await revokeAdoptedByHash(sha(token))).toBe('evan-iphone-2')
    } finally {
      off()
    }
    expect(heard).toEqual([['evan-iphone-2']])
    expect((await records()).map((d) => d.name)).toEqual(['evan-iphone'])
    expect(await verifyDeviceToken(token)).toBeNull()
    expect(await verifyDeviceToken(keep.token)).toEqual({ name: 'evan-iphone' })
    // Already gone: null, and nothing else moves.
    expect(await revokeAdoptedByHash(sha(token))).toBeNull()
  })

  it('never removes the pairing that owns this box\'s machine credentials (the Mac on a companion)', async () => {
    const macTok = tok()
    await seed([
      { name: 'mac-primary', id: 'd00000000000000a1', tokenHash: sha(macTok), createdAt: '2026-09-01T00:00:00.000Z' },
      { name: 'bridge-local', id: 'd00000000000000b2', tokenHash: sha(tok()), createdAt: '2026-09-01T00:00:00.000Z', kind: 'machine', ownerId: 'd00000000000000a1' },
    ])
    expect(await revokeAdoptedByHash(sha(macTok))).toBeNull()
    expect((await records()).map((d) => d.name)).toEqual(['mac-primary', 'bridge-local'])
  })

  it('never removes a machine credential, and refuses a malformed hash', async () => {
    const machineTok = tok()
    await seed([{ name: 'bridge-local', id: 'd00000000000000b2', tokenHash: sha(machineTok), createdAt: '2026-09-01T00:00:00.000Z', kind: 'machine' }])
    expect(await revokeAdoptedByHash(sha(machineTok))).toBeNull()
    expect(await records()).toHaveLength(1)
    await expect(revokeAdoptedByHash('nope')).rejects.toBeInstanceOf(AdoptionError)
  })
})

describe('getInstanceId', () => {
  it('mints 16 random bytes in hex once, keeps it across reads and every later write', async () => {
    const id = await getInstanceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(await getInstanceId()).toBe(id)
    await createDevice('later-phone')
    await adoptDeviceRecord({ name: 'later-copy', tokenHash: sha(tok()), adoptedFrom: 'cloud' })
    expect(JSON.parse(await raw()).instanceId).toBe(id)
    expect(await getInstanceId()).toBe(id)
  })

  it('concurrent first reads agree on one id', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => getInstanceId()))
    expect(new Set(ids).size).toBe(1)
    expect(JSON.parse(await raw()).instanceId).toBe(ids[0])
  })

  it('a corrupt auth.json is left alone (and its .bak): the id is kept in memory instead', async () => {
    await fs.writeFile(authFile(), '{ not json', { mode: 0o600 })
    await fs.writeFile(`${authFile()}.bak`, JSON.stringify({ devices: [{ name: 'kept', tokenHash: sha('t'), createdAt: 'x' }] }), { mode: 0o600 })
    const id = await getInstanceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(await getInstanceId()).toBe(id)
    expect(await raw()).toBe('{ not json')
    expect(JSON.parse(await fs.readFile(`${authFile()}.bak`, 'utf-8')).devices[0].name).toBe('kept')
  })

  it('a lost auth.json recovered from its .bak keeps the id the backup carried', async () => {
    const id = await getInstanceId()
    await createDevice('phone') // mirrors to .bak with the id
    await fs.rm(authFile())
    expect(await getInstanceId()).toBe(id)
  })
})
