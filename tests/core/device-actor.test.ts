/**
 * Who may change an existing device record (core/device-actor.ts), applied by
 * device-auth.ts inside the auth.json lock. The takeovers these rules close
 * (2026-09-29): a phone re-paired the Mac's name (`replace:true`) and acted as
 * the Mac; or removed the Mac's pairing to clear its way. And the laundering
 * the 2026-10-03 gate found: a phone made an API key, the key paired a device
 * nothing recorded as a phone, and that device took the companion over.
 *
 * Pure decisions first, then the same rules on a real auth.json (a throwaway
 * data dir), including the `walnut device` CLI, which is this machine itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-device-actor', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, createDevice, createDeviceAs, listDeviceRecords, readDeviceRegistry, revokeDevice, revokeDeviceAs, rotateDevice,
  setDeviceInfo, verifyDeviceToken, type DeviceRecord, type DeviceRegistry,
} from '../../src/core/device-auth.js'
import {
  CLOUD_RELAY_REFUSAL, DeviceChangeRefused, LOCAL_ACTOR, SELF_CALL_CANNOT_PAIR, apiKeyDecision, cloudRelayDecision, deviceChangeDecision,
  deviceChangeRefusal, isPhoneRecord, machineTargetRefusal, newDeviceId, notADeviceRefusal, platformFromInfo, proofClaim, recordForToken,
  type DeviceActor,
} from '../../src/core/device-actor.js'
import { machineCredentialDecision, mintMachineCredential } from '../../src/core/machine-credentials.js'
import { runDeviceRevoke } from '../../src/commands/device.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const now = new Date().toISOString()
const rec = (name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ name, id: `id-${name}`, tokenHash: sha(`${name}-token`), createdAt: now, ...extra })
const as = (name: string): DeviceActor => ({ token: `${name}-token` })

async function writeAuth(file: unknown): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify(file), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}
const raw = async () => JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>>; owner?: unknown }
const find = async (name: string) => (await listDeviceRecords()).find((d) => d.name === name)

describe('deviceChangeDecision (pure)', () => {
  const owner = rec('mac-primary', { platform: 'other' })
  const other = rec('mac-second', { platform: 'other' })
  const phone = rec('my-phone', { platform: 'ios' })
  const tablet = rec('tablet-new')
  const cred = rec('bridge-local', { kind: 'machine', ownerId: owner.id })
  const reg: DeviceRegistry = { devices: [owner, other, phone, tablet, cred], owner: { id: owner.id!, via: 'claim' } }

  it('a device may rotate or remove itself', () => {
    for (const change of ['rotate', 'revoke'] as const) {
      for (const name of ['my-phone', 'mac-second', 'tablet-new', 'mac-primary']) {
        expect(deviceChangeDecision(reg, as(name), change, name, true)).toEqual({ ok: true, by: 'self' })
      }
    }
  })

  it('the owner may rotate or remove any other device; with none recorded, the device that owns the machine credentials may (the rule of the builds before)', () => {
    const unowned: DeviceRegistry = { devices: [owner, other, phone, tablet, rec('bridge-local', { kind: 'machine' })], owner: null }
    for (const change of ['rotate', 'revoke'] as const) {
      for (const name of ['my-phone', 'mac-second', 'tablet-new']) {
        expect(deviceChangeDecision(reg, as('mac-primary'), change, name, true)).toEqual({ ok: true, by: 'owner' })
        expect(deviceChangeDecision({ ...reg, owner: null }, as('mac-primary'), change, name, true)).toEqual({ ok: true, by: 'owner' })
        // Nothing recorded and nothing owned: nobody has the rights, whichever record is first.
        expect(deviceChangeDecision(unowned, as('mac-primary'), change, name, true)).toMatchObject({ ok: false })
      }
    }
  })

  it('ownership is the recorded owner id, whatever owns machine credentials and however the record reports', () => {
    // mac-second minted a credential once; it is still not the owner.
    const r2: DeviceRegistry = { ...reg, devices: [...reg.devices, rec('bridge-x', { kind: 'machine', ownerId: other.id })] }
    expect(deviceChangeDecision(r2, as('mac-second'), 'revoke', 'my-phone', true)).toMatchObject({ ok: false })
    // A record that only shares the owner's NAME owns nothing.
    const renamed: DeviceRegistry = { devices: [rec('mac-primary', { id: 'id-new' }), phone], owner: { id: owner.id!, via: 'claim' } }
    expect(deviceChangeDecision(renamed, as('mac-primary'), 'revoke', 'my-phone', true)).toMatchObject({ ok: false })
  })

  it('this machine itself (the `walnut device` CLI, the Mac\'s own console) may change anything', () => {
    for (const change of ['rotate', 'revoke', 'create'] as const) {
      expect(deviceChangeDecision(reg, LOCAL_ACTOR, change, 'mac-primary', true)).toEqual({ ok: true, by: 'local' })
    }
  })

  it('everyone else hears 403 with one plain sentence: a phone, another Mac, a tablet, a machine token, a stranger', () => {
    for (const by of [as('my-phone'), as('mac-second'), as('tablet-new'), as('bridge-local'), as('stranger')] as DeviceActor[]) {
      for (const change of ['rotate', 'revoke'] as const) {
        const d = deviceChangeDecision(reg, by, change, 'mac-primary', true)
        expect(d.ok).toBe(false)
        if (d.ok) continue
        expect(d.refusal).toBeInstanceOf(DeviceChangeRefused)
        expect(d.refusal).toMatchObject({ status: 403, code: 'device_change_refused' })
        expect(d.refusal.message).toBe('Only mac-primary itself or the Mac this cloud companion belongs to can remove or re-pair mac-primary.')
      }
    }
    expect(deviceChangeRefusal('my-phone', false)).toBe('Only my-phone itself or this Mac can remove or re-pair my-phone.')
  })

  it('with no owner recorded, a device that owns no machine credential hears the same sentence', () => {
    const d = deviceChangeDecision({ ...reg, owner: null }, as('mac-second'), 'revoke', 'my-phone', true)
    expect(d).toMatchObject({ ok: false, refusal: { status: 403, code: 'device_change_refused' } })
    if (!d.ok) expect(d.refusal.message).toBe('Only my-phone itself or the Mac this cloud companion belongs to can remove or re-pair my-phone.')
  })

  it('an API key changes no device, and pairs none: not even one the owner made', () => {
    for (const change of ['rotate', 'revoke', 'create'] as const) {
      expect(deviceChangeDecision(reg, { apiKey: 'ops' }, change, change === 'create' ? 'laundered' : 'my-phone', true))
        .toEqual({ ok: false, refusal: expect.objectContaining({ status: 403, code: 'api_key_cannot_pair', message: 'An API key cannot pair, re-pair or remove devices.' }) })
    }
  })

  it('a paired caller never reaches a machine credential here, even the owner, and hears why (pinned: the gate\'s G17)', () => {
    for (const by of [as('mac-primary'), as('my-phone')]) {
      for (const change of ['rotate', 'revoke'] as const) {
        const d = deviceChangeDecision(reg, by, change, 'bridge-local', true)
        expect(d).toMatchObject({ ok: false, refusal: { status: 403, code: 'device_change_refused' } })
        if (!d.ok) expect(d.refusal.message).toBe('Only the Mac this cloud companion belongs to can add or remove bridge-local.')
      }
    }
    expect(machineTargetRefusal('bridge-x', false)).toBe('Only this Mac itself can add or remove bridge-x.')
    expect(notADeviceRefusal('bridge-x')).toBe("bridge-x is a computer's connection to this server, not a device you can re-pair.")
  })

  it('a phone may not pair a new device; any other paired device may', () => {
    expect(deviceChangeDecision(reg, as('my-phone'), 'create', 'laundered', true))
      .toEqual({ ok: false, refusal: expect.objectContaining({ status: 403, code: 'phone_cannot_pair', message: 'Pair new devices from the Mac, in Settings › Phones & Cloud, not from a phone.' }) })
    for (const name of ['mac-second', 'tablet-new', 'mac-primary']) {
      expect(deviceChangeDecision(reg, as(name), 'create', 'new-phone', true)).toEqual({ ok: true, by: 'new' })
    }
  })

  it('on the Mac (not a companion) a recorded owner means nothing: the rule is the one the builds before had', () => {
    // The owner recorded is mac-second; the machine credential is mac-primary's.
    const mac: DeviceRegistry = { ...reg, owner: { id: other.id!, via: 'claim' } }
    expect(deviceChangeDecision(mac, as('mac-second'), 'revoke', 'my-phone', false)).toMatchObject({ ok: false, refusal: { message: 'Only my-phone itself or this Mac can remove or re-pair my-phone.' } })
    expect(deviceChangeDecision(mac, as('mac-primary'), 'revoke', 'my-phone', false)).toEqual({ ok: true, by: 'owner' })
    // Without machine credentials (a Mac's own registry has none), a paired device changes only itself.
    const plain: DeviceRegistry = { devices: [owner, other, phone], owner: null }
    expect(deviceChangeDecision(plain, as('mac-primary'), 'revoke', 'my-phone', false)).toMatchObject({ ok: false })
    expect(deviceChangeDecision(plain, as('my-phone'), 'revoke', 'my-phone', false)).toEqual({ ok: true, by: 'self' })
  })

  it('the unowned bridge-local\'s token records an owner only while none is recorded, and never replaces one', () => {
    const unowned = rec('bridge-local', { kind: 'machine', tokenHash: sha('first-bridge-token') })
    const devices = [owner, other, phone, unowned]
    expect(proofClaim({ devices, owner: null }, other, 'first-bridge-token')).toEqual({ id: other.id, via: 'proof' })
    // With an owner recorded (here the operator's word), the same proof records nothing.
    expect(proofClaim({ devices, owner: { id: owner.id!, via: 'operator' } }, other, 'first-bridge-token')).toBeNull()
    // A phone is never made the owner, and another token proves nothing.
    expect(proofClaim({ devices, owner: null }, phone, 'first-bridge-token')).toBeNull()
    expect(proofClaim({ devices, owner: null }, other, 'mac-second-token')).toBeNull()
  })

  it('the cloud relay is this machine\'s alone; a phone hears the phone sentence for a pairing', () => {
    expect(cloudRelayDecision(reg.devices, LOCAL_ACTOR, 'revoke')).toEqual({ ok: true, by: 'local' })
    expect(cloudRelayDecision(reg.devices, as('my-phone'), 'create')).toMatchObject({ ok: false, refusal: { code: 'phone_cannot_pair' } })
    for (const by of [as('mac-primary'), as('tablet-new'), { apiKey: 'k' }] as DeviceActor[]) {
      expect(cloudRelayDecision(reg.devices, by, 'rotate')).toMatchObject({ ok: false, refusal: { code: 'device_change_refused', message: CLOUD_RELAY_REFUSAL } })
    }
  })

  it('the refusals are plain sentences that name the one place it works (pinned, not compared to themselves)', () => {
    expect(CLOUD_RELAY_REFUSAL).toBe('Only this Mac itself can pair or remove devices on the cloud companion, in Settings › Phones & Cloud on this Mac.')
    expect(SELF_CALL_CANNOT_PAIR).toBe('Only this Mac itself can pair new devices, in Settings › Phones & Cloud on this Mac.')
  })

  describe('a loopback self-call made for a caller off this Mac (the op executor, x-walnut-origin)', () => {
    // A session on another exec host, a paired client, and a header sent twice.
    const remote: DeviceActor[] = [{ onBehalfOf: 'host:devbox' }, { onBehalfOf: 'remote-http' }, { onBehalfOf: 'unknown' }]

    it('pairs nothing: whoever it acts for showed no credential', () => {
      for (const actor of remote) {
        for (const cloudMode of [false, true]) {
          const d = deviceChangeDecision(reg, actor, 'create', 'laundered', cloudMode)
          expect(d).toMatchObject({ ok: false, refusal: { status: 403, code: 'device_change_refused' } })
          if (!d.ok) expect(d.refusal.message).toBe('Only this Mac itself can pair new devices, in Settings › Phones & Cloud on this Mac.')
        }
      }
    })

    it('removes and re-pairs nothing either, not even a device of that name', () => {
      for (const actor of remote) {
        for (const change of ['rotate', 'revoke'] as const) {
          for (const name of ['mac-primary', 'my-phone', 'tablet-new']) {
            const d = deviceChangeDecision(reg, actor, change, name, false)
            expect(d).toMatchObject({ ok: false, refusal: { status: 403, code: 'device_change_refused' } })
            if (!d.ok) expect(d.refusal.message).toBe(`Only ${name} itself or this Mac can remove or re-pair ${name}.`)
          }
        }
      }
    })

    it('never uses the relay, makes no API key and mints no machine credential', () => {
      for (const actor of remote) {
        for (const change of ['list', 'create', 'rotate', 'revoke'] as const) {
          expect(cloudRelayDecision(reg.devices, actor, change)).toMatchObject({ ok: false, refusal: { status: 403, code: 'device_change_refused', message: CLOUD_RELAY_REFUSAL } })
        }
        expect(apiKeyDecision(reg, actor, false)).toMatchObject({ ok: false, refusal: { status: 403, code: 'api_keys_refused', message: 'Only this Mac itself can create or remove API keys.' } })
        for (const action of ['mint', 'adopt'] as const) {
          expect(machineCredentialDecision(reg, { by: actor, name: 'bridge-devbox', action })).toMatchObject({ ok: false, status: 403, code: 'machine_needs_device' })
        }
      }
    })
  })

  it('API keys: this machine (unbound) and the companion\'s owner (bound to its id) only', () => {
    expect(apiKeyDecision(reg, LOCAL_ACTOR, true)).toEqual({ ok: true })
    expect(apiKeyDecision(reg, as('mac-primary'), true)).toEqual({ ok: true, deviceId: owner.id })
    for (const by of [as('my-phone'), as('mac-second'), as('tablet-new'), { apiKey: 'k' }, as('stranger')] as DeviceActor[]) {
      expect(apiKeyDecision(reg, by, true)).toMatchObject({ ok: false, refusal: { status: 403, code: 'api_keys_refused', message: 'Only the Mac this cloud companion belongs to can create or remove API keys.' } })
    }
    // On the Mac, the owner of a companion is nobody: only this machine.
    expect(apiKeyDecision(reg, as('mac-primary'), false)).toMatchObject({ ok: false, refusal: { message: 'Only this Mac itself can create or remove API keys.' } })
    // None recorded: the device that owns the machine credentials; with none owned, nobody.
    expect(apiKeyDecision({ ...reg, owner: null }, as('mac-primary'), true)).toEqual({ ok: true, deviceId: owner.id })
    expect(apiKeyDecision({ devices: [owner, phone, rec('bridge-local', { kind: 'machine' })], owner: null }, as('mac-primary'), true)).toMatchObject({ ok: false })
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
    expect(recordForToken(reg.devices, 'my-phone-token')).toBe(phone)
    expect(recordForToken(reg.devices, 'nope')).toBeUndefined()
  })
})

describe('the rules on a real auth.json', () => {
  let t: Record<string, string>
  const by = (name: string): DeviceActor => ({ token: t[name] })

  beforeEach(async () => {
    await writeAuth({ devices: [] })
    t = {}
    // The operator pairs the Mac as the owner (as a claim would), then the rest.
    t['mac-primary'] = (await createDevice('mac-primary', { owner: true })).token
    for (const name of ['mac-second', 'my-phone']) t[name] = (await createDevice(name)).token
    await setDeviceInfo('my-phone', { model: 'iPhone17,1', os: 'iOS 26.1', deviceName: 'Phone' })
    // The owner's own daemon connects (its credential is the owner's).
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
      await expect(revokeDeviceAs('mac-primary', { by: by(who) })).rejects.toMatchObject({ status: 403, code: 'device_change_refused' })
    }
    expect((await listDeviceRecords()).map((d) => d.name).sort()).toEqual(['bridge-local', 'mac-primary', 'mac-second', 'my-phone'])
  })

  it('TAKEOVER: a phone may not pair a device to launder itself; another device that pairs one gains nothing', async () => {
    await expect(createDeviceAs('fresh-mac', { by: by('my-phone') })).rejects.toMatchObject({ status: 403, code: 'phone_cannot_pair' })
    await expect(rotateDevice('fresh-mac', { by: by('my-phone') })).rejects.toMatchObject({ status: 403, code: 'phone_cannot_pair' })
    expect(await find('fresh-mac')).toBeUndefined()
    const fresh = await createDeviceAs('fresh-mac', { by: by('mac-second') })
    await expect(revokeDeviceAs('mac-primary', { by: { token: fresh.token } })).rejects.toMatchObject({ status: 403 })
    expect((await readDeviceRegistry()).owner?.id).toBe((await find('mac-primary'))!.id)
  })

  it('a machine credential through these paths: refused for a paired caller (403) and a re-pair of one is a 400 sentence for this machine', async () => {
    await expect(revokeDeviceAs('bridge-local', { by: by('mac-primary') })).rejects.toMatchObject({ status: 403, message: 'Only the Mac this cloud companion belongs to can add or remove bridge-local.' })
    await expect(createDeviceAs('bridge-x', { by: by('mac-primary'), kind: 'machine' })).rejects.toMatchObject({ status: 403 })
    await expect(rotateDevice('bridge-local', { by: LOCAL_ACTOR })).rejects.toMatchObject({ status: 400, code: 'not_a_device', message: notADeviceRefusal('bridge-local') })
    expect(await find('bridge-local')).toBeDefined()
  })

  it('the platform a device claimed at its first report is kept: a cleared or Mac report changes nothing', async () => {
    const id = (await find('my-phone'))!.id
    for (const report of [{}, { model: 'Mac15,3', os: 'macOS 26.0' }]) {
      expect(await setDeviceInfo('my-phone', report)).toBe(true)
      const phone = (await find('my-phone'))!
      expect(phone.platform).toBe('ios')
      expect(phone.id).toBe(id)
    }
    expect((await find('my-phone'))!.info).toMatchObject({ model: 'Mac15,3', os: 'macOS 26.0' })
  })

  it('a self-report lands on the record its token matched: one in flight across a re-pair of the name lands nowhere', async () => {
    expect(await setDeviceInfo({ token: t['my-phone'] }, { model: 'iPhone17,1', os: 'iOS 26.2' })).toBe(true)
    expect((await find('my-phone'))!.info).toMatchObject({ os: 'iOS 26.2' })
    await rotateDevice('my-phone', { by: by('mac-primary') })
    expect(await setDeviceInfo({ token: t['my-phone'] }, { model: 'Mac15,3', os: 'macOS 26.0' })).toBe(false)
    const fresh = (await find('my-phone'))!
    expect(fresh.info).toBeUndefined()
    expect(fresh.platform).toBeUndefined()
    expect(await setDeviceInfo({ token: t['mac-second'] }, { model: 'Mac15,3', os: 'macOS 26.0' })).toBe(true)
    expect((await find('mac-second'))!.platform).toBe('other')
    expect(await setDeviceInfo({ token: 'not-a-token' }, { model: 'iPhone17,1' })).toBe(false)
  })

  it('self-rotate: a new token for the same device (id, platform, report, being the owner)', async () => {
    const before = (await find('my-phone'))!
    const r = await rotateDevice('my-phone', { by: by('my-phone') })
    expect(r.replaced).toBe(true)
    expect(await verifyDeviceToken(t['my-phone'])).toBeNull()
    expect(await verifyDeviceToken(r.token)).toEqual({ name: 'my-phone' })
    expect(await find('my-phone')).toMatchObject({ id: before.id, platform: 'ios', info: before.info, createdAt: before.createdAt })
    const owner = (await find('mac-primary'))!
    const mac = await rotateDevice('mac-primary', { by: by('mac-primary') })
    expect((await readDeviceRegistry()).owner).toEqual({ id: owner.id, via: 'operator' })
    expect(await revokeDeviceAs('my-phone', { by: { token: mac.token } })).toBe(true)
  })

  it('self-unpair: a device removes itself; the owner removing itself leaves no owner and no machine credential', async () => {
    expect(await revokeDeviceAs('mac-second', { by: by('mac-second') })).toBe(true)
    expect(await find('mac-second')).toBeUndefined()
    expect(await revokeDeviceAs('mac-primary', { by: by('mac-primary') })).toBe(true)
    expect((await listDeviceRecords()).map((d) => d.name)).toEqual(['my-phone'])
    expect((await raw()).owner).toBeUndefined()
  })

  it('the owner removes a lost phone, and re-pairs one (a new pairing: new id)', async () => {
    const oldId = (await find('my-phone'))!.id
    const repaired = await rotateDevice('my-phone', { by: by('mac-primary') })
    const fresh = (await find('my-phone'))!
    expect(fresh.id).not.toBe(oldId)
    expect(fresh.platform).toBeUndefined()
    expect(await verifyDeviceToken(t['my-phone'])).toBeNull()
    expect(await revokeDeviceAs('my-phone', { by: by('mac-primary') })).toBe(true)
    expect(await verifyDeviceToken(repaired.token)).toBeNull()
    expect(await revokeDeviceAs('mac-second', { by: by('mac-primary') })).toBe(true)
    expect(await find('bridge-local')).toMatchObject({ kind: 'machine' })
  })

  it('the box-local CLI (`walnut device revoke`) removes the owner, every machine credential with it, and says how to name the next', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)) })
    try {
      await runDeviceRevoke('mac-primary', {} as never)
    } finally { log.mockRestore() }
    expect((await listDeviceRecords()).map((d) => d.name).sort()).toEqual(['mac-second', 'my-phone'])
    expect((await raw()).owner).toBeUndefined()
    expect(lines.join('\n')).toMatch(/The next Mac to connect becomes its owner, or name one with: walnut device owner <name>/)
    // Nobody inherits it: the other Mac is no owner now.
    await expect(revokeDeviceAs('my-phone', { by: by('mac-second') })).rejects.toMatchObject({ status: 403 })
  })

  it('the operator\'s revoke takes no caller: there is nothing to leave out', async () => {
    expect(revokeDevice.length).toBe(1)
    expect(await revokeDevice('my-phone')).toBe(true)
  })
})
