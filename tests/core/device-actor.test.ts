/**
 * Who may change an existing device record (core/device-actor.ts), applied by
 * device-auth.ts inside the auth.json lock. The takeover these rules close
 * (2026-09-29): a phone re-paired the Mac's name (`replace:true`) and got a
 * token that minted the Mac's machine credential; or it removed the Mac's
 * pairing, cleared its own self-report, and minted as "not a phone".
 *
 * Pure decisions first, then the same rules on a real auth.json (a throwaway
 * data dir), including the `walnut device revoke` CLI, which is local.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-device-actor', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, createDevice, listDeviceRecords, onCredentialsRevoked, revokeDevice, rotateDevice, setDeviceInfo, verifyDeviceToken,
  type DeviceRecord,
} from '../../src/core/device-auth.js'
import {
  DeviceChangeRefused, LOCAL_ACTOR, deviceChangeDecision, deviceChangeRefusal, isPhoneRecord, newDeviceId, platformFromInfo, recordForToken,
  type DeviceActor,
} from '../../src/core/device-actor.js'
import { mintMachineCredential } from '../../src/core/machine-credentials.js'
import { runDeviceRevoke } from '../../src/commands/device.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const now = new Date().toISOString()
const rec = (name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ name, id: `id-${name}`, tokenHash: sha(`${name}-token`), createdAt: now, ...extra })
const as = (name: string): DeviceActor => ({ token: `${name}-token` })

async function writeAuth(devices: unknown[]): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}
const raw = async () => (JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>> }).devices
const find = async (name: string) => (await listDeviceRecords()).find((d) => d.name === name)

describe('deviceChangeDecision (pure)', () => {
  const owner = rec('mac-primary')
  const other = rec('mac-second')
  const phone = rec('my-phone', { platform: 'ios' })
  const cred = rec('bridge-local', { kind: 'machine', ownerId: owner.id })
  const devices = [owner, other, phone, cred]

  it('a device may rotate or remove itself', () => {
    for (const change of ['rotate', 'revoke'] as const) {
      expect(deviceChangeDecision(devices, as('my-phone'), change, 'my-phone', true)).toEqual({ ok: true, by: 'self' })
      expect(deviceChangeDecision(devices, as('mac-second'), change, 'mac-second', true)).toEqual({ ok: true, by: 'self' })
    }
  })

  it('the Mac that owns the machine credentials may rotate or remove any other device', () => {
    for (const change of ['rotate', 'revoke'] as const) {
      for (const name of ['my-phone', 'mac-second']) {
        expect(deviceChangeDecision(devices, as('mac-primary'), change, name, true)).toEqual({ ok: true, by: 'owner' })
      }
    }
  })

  it('this machine itself (the `walnut device` CLI) may change anything', () => {
    for (const change of ['rotate', 'revoke'] as const) {
      expect(deviceChangeDecision(devices, LOCAL_ACTOR, change, 'mac-primary', true)).toEqual({ ok: true, by: 'local' })
    }
  })

  it('everyone else hears 403 with a plain sentence: a phone, another Mac, an API key, a machine token', () => {
    for (const by of [as('my-phone'), as('mac-second'), { apiKey: 'ops' }, as('bridge-local'), as('stranger')] as DeviceActor[]) {
      for (const change of ['rotate', 'revoke'] as const) {
        const d = deviceChangeDecision(devices, by, change, 'mac-primary', true)
        expect(d.ok).toBe(false)
        if (d.ok) continue
        expect(d.refusal).toBeInstanceOf(DeviceChangeRefused)
        expect(d.refusal).toMatchObject({ status: 403, code: 'device_change_refused' })
        expect(d.refusal.message).toBe('Only mac-primary itself or the Mac this companion serves can remove or re-pair mac-primary. On the companion, `walnut device revoke mac-primary` works too.')
      }
    }
    expect(deviceChangeRefusal('my-phone', false)).toBe('Only my-phone itself or this Mac can remove or re-pair my-phone.')
  })

  it('an owner never reaches a machine credential through these rules', () => {
    expect(deviceChangeDecision(devices, as('mac-primary'), 'revoke', 'bridge-local', true)).toMatchObject({ ok: false })
  })

  it('a phone may not pair a new device; anyone else paired may', () => {
    expect(deviceChangeDecision(devices, as('my-phone'), 'create', 'laundered', true)).toMatchObject({ ok: false, refusal: { status: 403, code: 'phone_cannot_pair' } })
    expect(deviceChangeDecision(devices, as('mac-second'), 'create', 'new-phone', true)).toEqual({ ok: true, by: 'new' })
    expect(deviceChangeDecision(devices, LOCAL_ACTOR, 'create', 'new-phone', true)).toEqual({ ok: true, by: 'new' })
  })

  it('an owner whose ownerId no longer matches a live pairing owns nothing', () => {
    const renamedAway = [rec('mac-primary', { id: 'id-new' }), other, phone, cred]
    expect(deviceChangeDecision(renamedAway, as('mac-primary'), 'revoke', 'my-phone', true)).toMatchObject({ ok: false })
  })

  it('helpers: ids are fresh, a platform comes from the report, a token finds its record', () => {
    expect(newDeviceId()).toMatch(/^d[0-9a-f]{16}$/)
    expect(newDeviceId()).not.toBe(newDeviceId())
    expect(platformFromInfo({ model: 'iPhone17,1' })).toBe('ios')
    expect(platformFromInfo({ model: 'iPad14,1' })).toBe('ios')
    expect(platformFromInfo({ os: 'iPadOS 18.0' })).toBe('ios')
    expect(platformFromInfo({ model: 'Mac15,3', os: 'macOS 26.0' })).toBe('other')
    expect(platformFromInfo({})).toBeUndefined()
    expect(platformFromInfo(undefined)).toBeUndefined()
    expect(isPhoneRecord({ platform: 'ios' })).toBe(true)
    expect(isPhoneRecord({ platform: 'other' })).toBe(false)
    expect(isPhoneRecord({})).toBe(false)
    expect(recordForToken(devices, 'my-phone-token')).toBe(phone)
    expect(recordForToken(devices, 'nope')).toBeUndefined()
  })
})

describe('the rules on a real auth.json', () => {
  let t: Record<string, string>
  const by = (name: string): DeviceActor => ({ token: t[name] })

  beforeEach(async () => {
    await writeAuth([])
    t = {}
    for (const name of ['mac-primary', 'mac-second', 'my-phone']) t[name] = (await createDevice(name)).token
    await setDeviceInfo('my-phone', { model: 'iPhone17,1', os: 'iOS 26.1', deviceName: 'Phone' })
    await mintMachineCredential('bridge-local', { by: by('mac-primary') })
  })

  it('TAKEOVER: a phone re-pairing the Mac\'s name is refused, and nothing changes', async () => {
    const before = await raw()
    await expect(rotateDevice('mac-primary', { by: by('my-phone') })).rejects.toMatchObject({ status: 403, code: 'device_change_refused' })
    expect(await raw()).toEqual(before)
    expect(await verifyDeviceToken(t['mac-primary'])).toEqual({ name: 'mac-primary' })
  })

  it('TAKEOVER: a phone removing the Mac\'s pairing is refused, and so is another Mac', async () => {
    for (const who of ['my-phone', 'mac-second']) {
      await expect(revokeDevice('mac-primary', { by: by(who) })).rejects.toMatchObject({ status: 403, code: 'device_change_refused' })
    }
    expect((await listDeviceRecords()).map((d) => d.name).sort()).toEqual(['bridge-local', 'mac-primary', 'mac-second', 'my-phone'])
  })

  it('TAKEOVER: a phone may not pair a device to launder itself', async () => {
    await expect(createDevice('fresh-mac', { by: by('my-phone') })).rejects.toMatchObject({ status: 403, code: 'phone_cannot_pair' })
    await expect(rotateDevice('fresh-mac', { by: by('my-phone') })).rejects.toMatchObject({ status: 403, code: 'phone_cannot_pair' })
    expect(await find('fresh-mac')).toBeUndefined()
  })

  it('the platform a device claimed at its first report is kept: a cleared or Mac report changes nothing', async () => {
    const id = (await find('my-phone'))!.id
    for (const report of [{}, { model: 'Mac15,3', os: 'macOS 26.0' }]) {
      expect(await setDeviceInfo('my-phone', report)).toBe(true)
      const phone = (await find('my-phone'))!
      expect(phone.platform).toBe('ios')
      expect(phone.id).toBe(id)
    }
    // The report itself is display only, and shows what was sent.
    expect((await find('my-phone'))!.info).toMatchObject({ model: 'Mac15,3', os: 'macOS 26.0' })
  })

  it('a Mac\'s first report records it as other, for good', async () => {
    await setDeviceInfo('mac-second', { model: 'Mac15,3', os: 'macOS 26.0' })
    await setDeviceInfo('mac-second', { model: 'iPhone17,1', os: 'iOS 26.1' })
    expect((await find('mac-second'))!.platform).toBe('other')
  })

  it('self-rotate: a new token for the same device (id, platform and report kept)', async () => {
    const before = (await find('my-phone'))!
    const heard: string[][] = []
    const off = onCredentialsRevoked((names) => heard.push(names))
    try {
      const r = await rotateDevice('my-phone', { by: by('my-phone') })
      expect(r.replaced).toBe(true)
      expect(await verifyDeviceToken(t['my-phone'])).toBeNull()
      expect(await verifyDeviceToken(r.token)).toEqual({ name: 'my-phone' })
    } finally { off() }
    const after = (await find('my-phone'))!
    expect(after).toMatchObject({ id: before.id, platform: 'ios', info: before.info, createdAt: before.createdAt })
    expect(heard).toEqual([['my-phone']])
  })

  it('self-unpair: a device removes itself', async () => {
    expect(await revokeDevice('mac-second', { by: by('mac-second') })).toBe(true)
    expect(await find('mac-second')).toBeUndefined()
  })

  it('the owner Mac removes a lost phone, and re-pairs one (a new pairing: new id)', async () => {
    const oldId = (await find('my-phone'))!.id
    const repaired = await rotateDevice('my-phone', { by: by('mac-primary') })
    const fresh = (await find('my-phone'))!
    expect(fresh.id).not.toBe(oldId)
    expect(fresh.platform).toBeUndefined() // it claims again on its first report
    expect(await verifyDeviceToken(t['my-phone'])).toBeNull()
    expect(await revokeDevice('my-phone', { by: by('mac-primary') })).toBe(true)
    expect(await verifyDeviceToken(repaired.token)).toBeNull()
    // The owner removes the other Mac too; its machine credential is untouched.
    expect(await revokeDevice('mac-second', { by: by('mac-primary') })).toBe(true)
    expect(await find('bridge-local')).toMatchObject({ kind: 'machine' })
  })

  it('a machine credential never goes through revokeDevice for a paired caller, even its owner', async () => {
    await expect(revokeDevice('bridge-local', { by: by('mac-primary') })).rejects.toMatchObject({ status: 403 })
    expect(await find('bridge-local')).toBeDefined()
  })

  it('the box-local CLI (`walnut device revoke`) removes the Mac, and its machine credentials with it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runDeviceRevoke('mac-primary', {} as never)
    } finally { log.mockRestore() }
    expect((await listDeviceRecords()).map((d) => d.name).sort()).toEqual(['mac-second', 'my-phone'])
    // The handover: the other Mac mints now.
    await mintMachineCredential('bridge-local', { by: by('mac-second') })
    expect(await find('bridge-local')).toMatchObject({ ownerId: (await find('mac-second'))!.id })
  })
})

describe('records from an older build', () => {
  it('get an id, the platform their report says, and lose the name-keyed owner, in the first locked write', async () => {
    await writeAuth([
      { name: 'mac-primary', tokenHash: sha('mac-token'), createdAt: now },
      { name: 'my-phone', tokenHash: sha('phone-token'), createdAt: now, info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
      { name: 'bridge-local', tokenHash: sha('machine-token'), createdAt: now, kind: 'machine', owner: 'mac-primary', daemonKey: 'mac-primary' },
    ])
    // A read changes nothing on disk.
    await listDeviceRecords()
    expect((await raw()).every((d) => d.id === undefined)).toBe(true)
    // The first locked write (here: the phone clearing its report) migrates every record.
    await setDeviceInfo('my-phone', {})
    const after = await raw()
    for (const d of after) expect(String(d.id)).toMatch(/^d[0-9a-f]{16}$/)
    expect(after.find((d) => d.name === 'my-phone')?.platform).toBe('ios')
    expect(after.find((d) => d.name === 'mac-primary')?.platform).toBeUndefined()
    const local = after.find((d) => d.name === 'bridge-local')!
    expect('owner' in local).toBe(false)
    expect(local.platform).toBeUndefined()
    // A migrated phone is still a phone after the cleared report.
    expect(isPhoneRecord(after.find((d) => d.name === 'my-phone') as never)).toBe(true)
    // Ids are stable from then on.
    await setDeviceInfo('my-phone', { model: 'iPhone17,1' })
    expect((await raw()).map((d) => d.id)).toEqual(after.map((d) => d.id))
  })
})
