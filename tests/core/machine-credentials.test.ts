/**
 * Who may mint, rotate, revoke and adopt a machine credential on the companion
 * (core/machine-credentials.ts): with an owner recorded, that owner only; with
 * none recorded, the rules of the builds before owners were recorded, and the
 * device that succeeds is recorded then. Never an owner guessed from which
 * record is oldest (2026-10-05 gate: on a companion where the Mac was not the
 * oldest record, a guess handed it to a laptop and locked the Mac out).
 *
 * The caller is the record its bearer token authenticates as (never a name).
 * Runs against a real auth.json in a throwaway data dir, through the same
 * locked read-modify-write the routes use; the pure decision is pinned first,
 * with the sentence each kind of caller hears.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-machine-creds', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, createDevice, listDeviceRecords, readDeviceRegistry, revokeDeviceAs, rotateDevice, setDeviceInfo, setDeviceKind, verifyDeviceToken,
  type DeviceRecord, type DeviceRegistry,
} from '../../src/core/device-auth.js'
import {
  MachineCredentialRefused, OTHER_MAC_CONNECTED, PRIMARY_MACHINE_CREDENTIAL, adoptMachineCredential, machineCredentialDecision,
  mintMachineCredential, revokeMachineCredential,
} from '../../src/core/machine-credentials.js'
import type { DeviceActor } from '../../src/core/device-actor.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const now = new Date().toISOString()
/** A record whose token is `<name>-token` and whose id is `id-<name>`. */
const device = (name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ name, id: `id-${name}`, tokenHash: sha(`${name}-token`), createdAt: now, ...extra })
const machine = (name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => device(name, { kind: 'machine', ...extra })
/** The caller holding `<name>-token`. */
const as = (name: string): DeviceActor => ({ token: `${name}-token` })
const OWNER_ONLY = 'Only the Mac this cloud companion belongs to can connect computers to it.'

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try { await p } catch (err) {
    if (err instanceof MachineCredentialRefused) return { status: err.status, code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

const record = async (name: string) => (await listDeviceRecords()).find((d) => d.name === name)

describe('machineCredentialDecision (pure)', () => {
  const macA = device('mac-a', { platform: 'other' })
  const macB = device('mac-b', { platform: 'other' })
  const tablet = device('tablet-new')
  const phone = device('my-phone', { platform: 'ios' })
  const owned = (owner: DeviceRecord | null, extra: DeviceRecord[] = []): DeviceRegistry =>
    ({ devices: [macA, macB, tablet, phone, ...extra], owner: owner ? { id: owner.id!, via: 'claim' } : null })

  it('the words a second Mac hears are the host card\'s (pinned)', () => {
    expect(OTHER_MAC_CONNECTED).toBe('Another Mac is connected to this cloud companion. Disconnect it there first.')
  })

  it('a recorded owner may mint, replace, revoke and adopt', () => {
    for (const action of ['mint', 'replace', 'revoke', 'adopt'] as const) {
      expect(machineCredentialDecision(owned(macA), { by: as('mac-a'), name: 'bridge-local', action })).toEqual({ ok: true, me: macA, adopt: [], record: null })
    }
  })

  it.each(['mint', 'replace', 'revoke', 'adopt'] as const)('with an owner recorded, everyone else may not %s, each told in its own words', (action) => {
    const reg = owned(macA, [machine('bridge-local', { ownerId: macA.id })])
    const d = (who: string) => machineCredentialDecision(reg, { by: as(who), name: 'bridge-local', action })
    expect(d('mac-b')).toEqual({ ok: false, status: 409, code: 'other_mac_connected', error: OTHER_MAC_CONNECTED })
    // A device that never said what it is (a tablet, for all the companion knows): not the other-Mac words.
    expect(d('tablet-new')).toEqual({ ok: false, status: 409, code: 'not_companion_owner', error: OWNER_ONLY })
    expect(d('my-phone')).toEqual({ ok: false, status: 403, code: 'phone_cannot_mint', error: OWNER_ONLY })
    for (const by of [{ apiKey: 'k' }, as('bridge-local'), as('nobody'), { local: true }] as DeviceActor[]) {
      expect(machineCredentialDecision(reg, { by, name: 'bridge-local', action })).toEqual({ ok: false, status: 403, code: 'machine_needs_device', error: OWNER_ONLY })
    }
  })

  it('no sentence about machine credentials, and none said to a phone or tablet about another Mac', () => {
    const reg = owned(macA)
    for (const who of ['my-phone', 'tablet-new', 'mac-b']) {
      const d = machineCredentialDecision(reg, { by: as(who), name: 'bridge-x', action: 'mint' })
      if (d.ok) throw new Error('expected a refusal')
      expect(d.error).not.toMatch(/machine credential|mint/i)
      if (who !== 'mac-b') expect(d.error).not.toBe(OTHER_MAC_CONNECTED)
    }
  })

  it('with none recorded and nothing minted: the first paired device that is not a phone may, and is recorded as the owner', () => {
    for (const who of [macA, macB, tablet]) {
      expect(machineCredentialDecision(owned(null), { by: as(who.name), name: 'bridge-local', action: 'mint' }))
        .toEqual({ ok: true, me: who, adopt: [], record: { id: who.id, via: 'mint' } })
    }
    expect(machineCredentialDecision(owned(null), { by: as('my-phone'), name: 'bridge-local', action: 'mint' })).toMatchObject({ ok: false, status: 403, code: 'phone_cannot_mint' })
    // Adopting needs something to adopt.
    expect(machineCredentialDecision(owned(null), { by: as('mac-a'), name: 'bridge-local', action: 'adopt' })).toEqual({ ok: false, status: 409, code: 'other_mac_connected', error: OTHER_MAC_CONNECTED })
  })

  it('with none recorded, the device owning the credentials is the one that may; whoever else asks hears another Mac', () => {
    const legacy = machine('bridge-devbox')
    const reg = owned(null, [machine('bridge-local', { ownerId: macB.id }), legacy])
    expect(machineCredentialDecision(reg, { by: as('mac-b'), name: 'bridge-new', action: 'mint' }))
      .toEqual({ ok: true, me: macB, adopt: [legacy], record: { id: macB.id, via: 'mint' } })
    for (const who of ['mac-a', 'tablet-new']) {
      expect(machineCredentialDecision(reg, { by: as(who), name: 'bridge-new', action: 'mint' })).toEqual({ ok: false, status: 409, code: 'other_mac_connected', error: OTHER_MAC_CONNECTED })
    }
  })

  it('ownership is the owner\'s id: a record that only shares the NAME owns nothing', () => {
    const repaired = device('mac-a', { id: 'id-new-pairing', tokenHash: sha('stolen-token') })
    // The recorded owner and the credential's owner are the old pairing, which is gone.
    const reg: DeviceRegistry = { devices: [repaired, machine('bridge-local', { ownerId: 'id-mac-a' })], owner: { id: 'id-mac-a', via: 'claim' } }
    expect(machineCredentialDecision(reg, { by: { token: 'stolen-token' }, name: 'bridge-local', action: 'replace' })).toMatchObject({ ok: false, status: 409, code: 'other_mac_connected' })
  })

  it('the unowned bridge-local\'s token proves the Mac while none is recorded; another credential\'s token proves nothing', () => {
    const local = machine(PRIMARY_MACHINE_CREDENTIAL)
    const devbox = machine('bridge-devbox')
    const legacy: DeviceRegistry = { devices: [macA, macB, local, devbox], owner: null }
    for (const who of ['mac-a', 'mac-b']) {
      for (const proof of [undefined, 'forged', 'bridge-devbox-token']) {
        expect(machineCredentialDecision(legacy, { by: as(who), name: 'bridge-local', action: 'mint', proof }), `${who} ${proof}`).toMatchObject({ ok: false, status: 409, code: 'other_mac_connected' })
      }
    }
    // Wherever the other credential sits, and when bridge-local is gone, its token is still no proof.
    expect(machineCredentialDecision({ ...legacy, devices: [macA, macB, devbox, local] }, { by: as('mac-b'), name: 'bridge-devbox', action: 'adopt', proof: 'bridge-devbox-token' }))
      .toMatchObject({ ok: false, status: 409, code: 'other_mac_connected' })
    expect(machineCredentialDecision({ ...legacy, devices: [macA, macB, devbox] }, { by: as('mac-b'), name: 'bridge-devbox', action: 'adopt', proof: 'bridge-devbox-token' }))
      .toMatchObject({ ok: false, status: 409, code: 'other_mac_connected' })
    expect(machineCredentialDecision(legacy, { by: as('mac-b'), name: 'bridge-local', action: 'adopt', proof: 'bridge-local-token' }))
      .toEqual({ ok: true, me: macB, adopt: [local, devbox], record: { id: macB.id, via: 'proof' } })
    // Never over a recorded owner, whatever recorded it; never for a phone.
    for (const via of ['claim', 'operator', 'proof', 'mint'] as const) {
      expect(machineCredentialDecision({ ...legacy, owner: { id: macA.id!, via } }, { by: as('mac-b'), name: 'bridge-local', action: 'adopt', proof: 'bridge-local-token' })).toMatchObject({ ok: false, status: 409 })
    }
    expect(machineCredentialDecision({ ...legacy, devices: [...legacy.devices, phone] }, { by: as('my-phone'), name: 'bridge-local', action: 'adopt', proof: 'bridge-local-token' })).toMatchObject({ ok: false, status: 403 })
    // A bridge-local that has a live owner is no proof either.
    const stamped: DeviceRegistry = { devices: [macA, macB, machine(PRIMARY_MACHINE_CREDENTIAL, { ownerId: macA.id })], owner: null }
    expect(machineCredentialDecision(stamped, { by: as('mac-b'), name: 'bridge-local', action: 'adopt', proof: 'bridge-local-token' })).toMatchObject({ ok: false, status: 409 })
  })

  it('a device name is never taken over as a machine credential', () => {
    expect(machineCredentialDecision(owned(macA), { by: as('mac-a'), name: 'mac-b', action: 'replace' })).toEqual({ ok: false, status: 400, code: 'not_machine', error: 'That name already belongs to a paired device.' })
    expect(machineCredentialDecision(owned(null), { by: as('mac-a'), name: 'mac-b', action: 'replace' })).toEqual({ ok: false, status: 400, code: 'not_machine', error: 'That name already belongs to a paired device.' })
  })
})

describe('minting, rotating and revoking on a real auth.json', () => {
  let tokens: Record<string, string>
  const by = (name: string): DeviceActor => ({ token: tokens[name] })

  async function writeAuth(file: unknown): Promise<void> {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify(file), { mode: 0o600 })
    _resetDeviceAuthForTesting()
  }

  beforeEach(async () => {
    await writeAuth({ devices: [] })
    tokens = {}
    tokens['mac-a'] = (await createDevice('mac-a', { owner: true })).token
    for (const name of ['mac-b', 'my-phone']) tokens[name] = (await createDevice(name)).token
    await setDeviceInfo('my-phone', { model: 'iPhone17,1', os: 'iOS 26.1' })
    await setDeviceInfo('mac-b', { model: 'Mac15,3', os: 'macOS 26.0' })
  })

  it('the owner mints; the credential carries its id', async () => {
    const minted = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await verifyDeviceToken(minted.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
    const mac = (await record('mac-a'))!
    expect(await record('bridge-local')).toMatchObject({ kind: 'machine', ownerId: mac.id })
  })

  it('a second Mac is refused every way, and the owner keeps its token', async () => {
    const first = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    for (const attempt of [
      () => mintMachineCredential('bridge-local', { by: by('mac-b'), replace: true }),
      () => mintMachineCredential('bridge-other', { by: by('mac-b') }),
      () => revokeMachineCredential('bridge-local', { by: by('mac-b') }),
      () => adoptMachineCredential('bridge-local', { by: by('mac-b'), proof: first.token }),
    ]) {
      expect(await refusal(attempt())).toEqual({ status: 409, code: 'other_mac_connected', message: OTHER_MAC_CONNECTED })
    }
    expect(await verifyDeviceToken(first.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
    expect((await listDeviceRecords()).map((d) => d.name).sort()).toEqual(['bridge-local', 'mac-a', 'mac-b', 'my-phone'])
  })

  it('a phone is refused minting and revoking, whatever it reports later', async () => {
    expect(await refusal(mintMachineCredential('bridge-local', { by: by('my-phone') }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await refusal(revokeMachineCredential('bridge-local', { by: by('my-phone') }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    for (const report of [{}, { model: 'Mac15,3', os: 'macOS 26.0' }]) {
      await setDeviceInfo('my-phone', report)
      expect((await record('my-phone'))?.platform).toBe('ios')
      expect(await refusal(mintMachineCredential('bridge-x', { by: by('my-phone') }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    }
  })

  it('the owner rotates it: a new token, the old one stops working', async () => {
    const first = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const second = await mintMachineCredential('bridge-local', { by: by('mac-a'), replace: true })
    expect(second.replaced).toBe(true)
    expect(second.token).not.toBe(first.token)
    expect(await verifyDeviceToken(first.token)).toBeNull()
  })

  it('the owner mints a persisted status-only scope and rotation cannot drop it', async () => {
    const first = await mintMachineCredential('bridge-status-peer', { by: by('mac-a'), bridgeScope: 'status-only' })
    expect((await record('bridge-status-peer'))?.bridgeScope).toBe('status-only')
    expect(await verifyDeviceToken(first.token, { touch: false })).toEqual({ name: 'bridge-status-peer', kind: 'machine', bridgeScope: 'status-only' })
    const second = await mintMachineCredential('bridge-status-peer', { by: by('mac-a'), replace: true })
    expect((await record('bridge-status-peer'))?.bridgeScope).toBe('status-only')
    expect(await verifyDeviceToken(first.token, { touch: false })).toBeNull()
    expect(await verifyDeviceToken(second.token, { touch: false })).toMatchObject({ bridgeScope: 'status-only' })
  })

  it('refuses a status-only scope for the primary credential', async () => {
    expect(await refusal(mintMachineCredential('bridge-local', { by: by('mac-a'), bridgeScope: 'status-only' })))
      .toMatchObject({ status: 400, code: 'invalid_bridge_scope' })
    expect(await record('bridge-local')).toBeUndefined()
  })

  it('a scoped machine token cannot mint another credential', async () => {
    const peer = await mintMachineCredential('bridge-status-peer', { by: by('mac-a'), bridgeScope: 'status-only' })
    expect(await refusal(mintMachineCredential('bridge-other', { by: { token: peer.token } }))).toMatchObject({ status: 403, code: 'machine_needs_device' })
  })

  it('without replace an existing name answers "already exists"', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    await expect(mintMachineCredential('bridge-local', { by: by('mac-a') })).rejects.toThrow(/already exists/)
  })

  it('two Macs minting at once: only the owner gets one', async () => {
    const results = await Promise.allSettled([
      mintMachineCredential('bridge-local', { by: by('mac-b') }),
      mintMachineCredential('bridge-local', { by: by('mac-a') }),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect((await listDeviceRecords()).filter((d) => d.kind === 'machine').map((d) => d.ownerId)).toEqual([(await record('mac-a'))!.id])
  })

  it("removing the owner's pairing takes every machine credential and the ownership: nobody is guessed, the next Mac to mint is recorded", async () => {
    const local = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await revokeDeviceAs('mac-a', { by: by('mac-a') })).toBe(true)
    expect(await verifyDeviceToken(local.token)).toBeNull()
    expect((await readDeviceRegistry()).owner).toBeNull()
    expect(await refusal(mintMachineCredential('bridge-local', { by: by('my-phone') }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    expect((await mintMachineCredential('bridge-local', { by: by('mac-b') })).name).toBe('bridge-local')
    expect((await readDeviceRegistry()).owner).toEqual({ id: (await record('mac-b'))!.id, via: 'mint' })
  })

  it('removing a device that is not the owner leaves every machine credential alone', async () => {
    const local = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await revokeDeviceAs('mac-b', { by: by('mac-a') })).toBe(true)
    expect(await verifyDeviceToken(local.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
  })

  it('a Mac rotating its own pairing stays the owner: same id, same credentials', async () => {
    const local = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const id = (await record('mac-a'))!.id
    const rotated = await rotateDevice('mac-a', { by: by('mac-a') })
    expect(await verifyDeviceToken(tokens['mac-a'])).toBeNull()
    expect((await record('mac-a'))!.id).toBe(id)
    expect(await verifyDeviceToken(local.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
    expect((await mintMachineCredential('bridge-local', { by: { token: rotated.token }, replace: true })).replaced).toBe(true)
  })

  it('a re-pair of the owner\'s name by this machine is a NEW pairing: no owner, no credentials, first come again', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const repaired = await rotateDevice('mac-a', { by: { local: true } })
    expect(await record('bridge-local')).toBeUndefined()
    expect((await readDeviceRegistry()).owner).toBeNull()
    expect((await mintMachineCredential('bridge-local', { by: { token: repaired.token } })).name).toBe('bridge-local')
    expect((await readDeviceRegistry()).owner).toEqual({ id: (await record('mac-a'))!.id, via: 'mint' })
  })
})

// A companion paired with `walnut device add` and no `--owner` (2026-10-05 gate): nobody is
// recorded, so the first Mac to mint is, as builds before owners were recorded decided.
describe('a companion with no owner recorded', () => {
  let tokens: Record<string, string>
  const by = (name: string): DeviceActor => ({ token: tokens[name] })

  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [] }), { mode: 0o600 })
    _resetDeviceAuthForTesting()
    tokens = {}
    // The laptop was paired first; the Mac is not the oldest record.
    for (const name of ['laptop', 'gate-mac', 'phone-a']) tokens[name] = (await createDevice(name)).token
    await setDeviceInfo('phone-a', { model: 'iPhone17,1', os: 'iOS 26.1' })
  })

  it('the Mac\'s bridge job mints first and is recorded; then the laptop is refused and removes nobody', async () => {
    expect((await mintMachineCredential('bridge-local', { by: by('gate-mac') })).name).toBe('bridge-local')
    expect((await readDeviceRegistry()).owner).toEqual({ id: (await record('gate-mac'))!.id, via: 'mint' })
    expect(await refusal(mintMachineCredential('bridge-x', { by: by('laptop') }))).toMatchObject({ status: 409, code: 'not_companion_owner' })
    for (const target of ['gate-mac', 'phone-a']) {
      await expect(revokeDeviceAs(target, { by: by('laptop') })).rejects.toMatchObject({ status: 403, code: 'device_change_refused' })
    }
    expect((await listDeviceRecords()).map((d) => d.name).sort()).toEqual(['bridge-local', 'gate-mac', 'laptop', 'phone-a'])
    // The owner may.
    expect(await revokeDeviceAs('phone-a', { by: by('gate-mac') })).toBe(true)
  })

  it('before any mint, nobody but each device itself changes a pairing (no owner is guessed from the order)', async () => {
    for (const [who, target] of [['laptop', 'gate-mac'], ['laptop', 'phone-a'], ['gate-mac', 'laptop']]) {
      await expect(revokeDeviceAs(target, { by: by(who) }), `${who} ${target}`).rejects.toMatchObject({ status: 403 })
    }
    expect((await readDeviceRegistry()).owner).toBeNull()
  })
})

describe('a companion from before owners were recorded', () => {
  const T = { mac: 'legacy-mac-token', second: 'legacy-second-token', phone: 'legacy-phone-token', local: 'legacy-local-token', devbox: 'legacy-devbox-token' }
  /** auth.json exactly as a build without owners wrote it: no ids, no platform, no owner. */
  async function writeLegacy(first: 'mac' | 'phone' = 'mac'): Promise<void> {
    const mac = { name: 'mac-primary', tokenHash: sha(T.mac), createdAt: now }
    const phone = { name: 'my-phone', tokenHash: sha(T.phone), createdAt: now, info: { model: 'iPhone17,1', os: 'iOS 26.1' } }
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
      ...(first === 'mac' ? [mac, phone] : [phone, mac]),
      { name: 'mac-second', tokenHash: sha(T.second), createdAt: now },
      { name: 'bridge-local', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
      { name: 'bridge-devbox', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine' },
    ] }), { mode: 0o600 })
    _resetDeviceAuthForTesting()
  }

  it.each(['mac', 'phone'] as const)('no owner is guessed (%s first): without the proof nobody mints, as before', async (first) => {
    await writeLegacy(first)
    expect((await readDeviceRegistry()).owner).toBeNull()
    for (const t of [T.mac, T.second]) {
      expect(await refusal(mintMachineCredential('bridge-newhost', { by: { token: t } }))).toEqual({ status: 409, code: 'other_mac_connected', message: OTHER_MAC_CONNECTED })
      expect(await refusal(revokeMachineCredential('bridge-local', { by: { token: t } }))).toMatchObject({ status: 409, code: 'other_mac_connected' })
    }
    expect(await refusal(mintMachineCredential('bridge-newhost', { by: { token: T.phone } }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    expect((await readDeviceRegistry()).owner).toBeNull()
  })

  it('adopting with the unowned bridge-local\'s token records its sender as the owner and marks the old credentials', async () => {
    await writeLegacy('phone')
    expect(await adoptMachineCredential('bridge-local', { by: { token: T.mac }, proof: T.local })).toBe('adopted')
    const reg = await readDeviceRegistry()
    const mac = reg.devices.find((d) => d.name === 'mac-primary')!
    expect(reg.owner).toEqual({ id: mac.id, via: 'proof' })
    expect(reg.devices.filter((d) => d.kind === 'machine').map((d) => d.ownerId)).toEqual([mac.id, mac.id])
    expect(await adoptMachineCredential('bridge-local', { by: { token: T.mac }, proof: T.local })).toBe('owned')
    expect(await adoptMachineCredential('bridge-none', { by: { token: T.mac }, proof: T.local })).toBe('missing')
    // The proof is spent: nobody else can use it now.
    expect(await refusal(adoptMachineCredential('bridge-local', { by: { token: T.second }, proof: T.local }))).toMatchObject({ status: 409 })
    expect((await mintMachineCredential('bridge-x', { by: { token: T.mac } })).name).toBe('bridge-x')
  })

  it('another credential\'s token, or a phone with the right one, records nothing', async () => {
    await writeLegacy()
    expect(await refusal(adoptMachineCredential('bridge-local', { by: { token: T.second }, proof: T.devbox }))).toMatchObject({ status: 409, code: 'other_mac_connected' })
    expect(await refusal(adoptMachineCredential('bridge-local', { by: { token: T.phone }, proof: T.local }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    expect((await readDeviceRegistry()).owner).toBeNull()
  })

  it('the lost-cache steps with the proof: the taken name writes nothing, the removal with the proof records the owner', async () => {
    await writeLegacy('phone')
    const before = await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')
    await expect(mintMachineCredential('bridge-local', { by: { token: T.mac }, proof: T.local })).rejects.toThrow(/already exists/)
    expect(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')).toBe(before)
    expect(await revokeMachineCredential('bridge-local', { by: { token: T.mac }, proof: T.local })).toBe(true)
    expect((await readDeviceRegistry()).owner?.via).toBe('proof')
    expect((await mintMachineCredential('bridge-local', { by: { token: T.mac } })).name).toBe('bridge-local')
  })
})

describe('a Mac\'s pairing recorded as a phone (a phone once reported with its token)', () => {
  // 2026-10-21 on a real companion: the Mac's pairing (the token in its data repo's
  // remote) carried `platform: 'ios'` beside a report that says Mac, so every machine
  // credential it asked for was refused, proof or not, and no owner was ever recorded.
  const T = { mac: 'wrong-mac-token', local: 'wrong-local-token', phone: 'wrong-phone-token' }
  async function writeWrong(): Promise<void> {
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
      { name: 'my-mac', id: 'id-my-mac', platform: 'ios', tokenHash: sha(T.mac), createdAt: now, info: { model: 'Mac', os: 'macOS', appVersion: '0.6.14', reportedAt: now } },
      { name: 'bridge-local', id: 'id-bridge-local', kind: 'machine', tokenHash: sha(T.local), createdAt: now },
      { name: 'my-phone', id: 'id-my-phone', platform: 'ios', tokenHash: sha(T.phone), createdAt: now, info: { model: 'iPhone17,1', os: 'iOS 26.1', reportedAt: now } },
    ] }), { mode: 0o600 })
    _resetDeviceAuthForTesting()
  }
  const authBytes = () => fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')

  it('refused as a phone, with its proof, until the operator says it is a computer; then its proof records it as the owner', async () => {
    await writeWrong()
    expect(await refusal(mintMachineCredential('bridge-__cloudbox__', { by: { token: T.mac }, proof: T.local }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    expect(await setDeviceKind('my-mac', 'computer')).toEqual({ changed: true, ownerDropped: false })
    // Said twice: nothing written the second time.
    const before = await authBytes()
    expect(await setDeviceKind('my-mac', 'computer')).toEqual({ changed: false, ownerDropped: false })
    expect(await authBytes()).toBe(before)
    expect((await mintMachineCredential('bridge-__cloudbox__', { by: { token: T.mac }, proof: T.local })).name).toBe('bridge-__cloudbox__')
    const reg = await readDeviceRegistry()
    expect(reg.owner).toEqual({ id: 'id-my-mac', via: 'proof' })
    expect(reg.devices.find((d) => d.name === 'bridge-local')?.ownerId).toBe('id-my-mac')
    // A phone reporting with that token again does not make it a phone again.
    await setDeviceInfo({ token: T.mac }, { model: 'iPhone17,1', os: 'iOS 26.1' })
    expect((await record('my-mac'))?.platform).toBe('other')
    expect((await mintMachineCredential('bridge-next', { by: { token: T.mac } })).name).toBe('bridge-next')
  })

  it('naming the owner a phone drops it as owner; a machine credential or an unknown name is refused', async () => {
    await writeWrong()
    await setDeviceKind('my-mac', 'computer')
    await mintMachineCredential('bridge-x', { by: { token: T.mac }, proof: T.local })
    expect(await setDeviceKind('my-mac', 'phone')).toEqual({ changed: true, ownerDropped: true })
    expect((await readDeviceRegistry()).owner).toBeNull()
    expect(await refusal(mintMachineCredential('bridge-y', { by: { token: T.mac } }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    await expect(setDeviceKind('bridge-local', 'computer')).rejects.toThrow(/computer's connection/)
    await expect(setDeviceKind('nobody', 'computer')).rejects.toThrow(/not found/)
  })

  it('the CLI: `walnut device kind` says what changed, refuses an unknown kind, and `device list` shows what each is', async () => {
    await writeWrong()
    const { runDeviceKind, runDeviceList } = await import('../../src/commands/device.js')
    const out: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const exitBefore = process.exitCode
    try {
      await runDeviceKind('my-mac', 'tablet', {} as never)
      expect(process.exitCode).toBe(1)
      process.exitCode = exitBefore
      expect((await record('my-mac'))?.platform).toBe('ios')
      await runDeviceKind('my-mac', 'computer', {} as never)
      await runDeviceList({} as never)
      const text = out.join('\n')
      expect(text).toContain('Unknown kind "tablet"')
      expect(text).toContain('"my-mac" is now recorded as a computer.')
      expect(text).toMatch(/my-mac.*computer/)
      expect(text).toMatch(/my-phone.*phone/)
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
      process.exitCode = exitBefore
    }
  })
})
