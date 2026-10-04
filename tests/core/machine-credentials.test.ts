/**
 * Who may mint, rotate, revoke and adopt a machine credential on the companion
 * (core/machine-credentials.ts): one companion serves one Mac.
 *
 * The caller is the record its bearer token authenticates as (never a name),
 * and ownership is the owner's immutable id. Runs against a real auth.json in a
 * throwaway data dir, through the same locked read-modify-write the routes use;
 * the pure decision is pinned first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-machine-creds'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, createDevice, listDeviceRecords, onCredentialsRevoked, revokeDevice, rotateDevice, setDeviceInfo, verifyDeviceToken,
  type DeviceRecord,
} from '../../src/core/device-auth.js'
import {
  MachineCredentialRefused, OTHER_MAC_CONNECTED, PRIMARY_MACHINE_CREDENTIAL, adoptMachineCredential, machineCredentialDaemonKey,
  machineCredentialDecision, mintMachineCredential, revokeMachineCredential,
} from '../../src/core/machine-credentials.js'
import { isPhoneRecord, type DeviceActor } from '../../src/core/device-actor.js'
import { CLOUD_BOX_OTHER_MAC_SENTENCE } from '../../src/core/hosts/cloud-box-host.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const now = new Date().toISOString()
/** A record whose token is `<name>-token` and whose id is `id-<name>`. */
const device = (name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ name, id: `id-${name}`, tokenHash: sha(`${name}-token`), createdAt: now, ...extra })
const machine = (name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => device(name, { kind: 'machine', ...extra })
/** The caller holding `<name>-token`. */
const as = (name: string): DeviceActor => ({ token: `${name}-token` })

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try { await p } catch (err) {
    if (err instanceof MachineCredentialRefused) return { status: err.status, code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

async function writeAuth(devices: DeviceRecord[]): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

const record = async (name: string) => (await listDeviceRecords()).find((d) => d.name === name)

describe('machineCredentialDecision (pure)', () => {
  const macA = device('mac-a')
  const macB = device('mac-b')
  const phone = device('my-phone', { platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } })

  it('the answer a second Mac hears is the sentence its host card shows', () => {
    expect(OTHER_MAC_CONNECTED).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    expect(OTHER_MAC_CONNECTED).toBe('Another Mac is connected to this cloud companion. Disconnect it there first.')
  })

  it('a fresh companion: the first Mac may mint', () => {
    expect(machineCredentialDecision([macA, macB], { by: as('mac-a'), name: 'bridge-local', action: 'mint' })).toMatchObject({ ok: true, me: macA, adopt: [] })
  })

  it.each(['mint', 'replace', 'revoke', 'adopt'] as const)('a device recorded as a phone may never %s', (action) => {
    const devices = [macA, phone, machine('bridge-local', { ownerId: macA.id })]
    expect(machineCredentialDecision(devices, { by: as('my-phone'), name: 'bridge-local', action })).toMatchObject({ ok: false, status: 403, code: 'phone_cannot_mint' })
  })

  it('what a phone reports about itself no longer decides it: the recorded platform does', () => {
    // A phone that cleared its report, or reports a Mac, is still the phone it claimed to be.
    for (const info of [undefined, { model: 'Mac15,3', os: 'macOS 26.0' }]) {
      const spoofed = device('my-phone', { platform: 'ios', info })
      expect(isPhoneRecord(spoofed)).toBe(true)
      expect(machineCredentialDecision([macA, spoofed], { by: as('my-phone'), name: 'bridge-local', action: 'mint' })).toMatchObject({ ok: false, code: 'phone_cannot_mint' })
    }
  })

  it('an API key, a machine token, an unknown token or a local caller may not mint either', () => {
    const devices = [macA, machine('bridge-local', { ownerId: macA.id })]
    for (const by of [{ apiKey: 'k' }, as('bridge-local'), as('nobody'), { local: true }] as DeviceActor[]) {
      expect(machineCredentialDecision(devices, { by, name: 'bridge-local', action: 'mint' })).toMatchObject({ ok: false, status: 403, code: 'machine_needs_device' })
    }
  })

  it.each(['mint', 'replace', 'revoke'] as const)('while one Mac owns a credential, another may not %s any', (action) => {
    const devices = [macA, macB, machine('bridge-local', { ownerId: macA.id, daemonKey: macA.id })]
    for (const name of ['bridge-local', 'bridge-devbox']) {
      expect(machineCredentialDecision(devices, { by: as('mac-b'), name, action })).toEqual({ ok: false, status: 409, code: 'other_mac_connected', error: OTHER_MAC_CONNECTED })
    }
    // Even holding the credential's own token does not help: ownership is recorded.
    expect(machineCredentialDecision(devices, { by: as('mac-b'), name: 'bridge-local', action, proof: 'bridge-local-token' })).toMatchObject({ ok: false, status: 409 })
    expect(machineCredentialDecision(devices, { by: as('mac-a'), name: 'bridge-local', action })).toMatchObject({ ok: true, me: macA })
  })

  it('ownership is the owner\'s id: a record that only shares the NAME owns nothing', () => {
    // mac-a re-paired by someone else: same name, new id.
    const repaired = device('mac-a', { id: 'id-new-pairing', tokenHash: sha('stolen-token') })
    const devices = [repaired, machine('bridge-local', { ownerId: 'id-mac-a', daemonKey: 'id-mac-a' })]
    // The credential's owner is gone, so it is legacy, and the stolen pairing holds no proof.
    expect(machineCredentialDecision(devices, { by: { token: 'stolen-token' }, name: 'bridge-local', action: 'replace' })).toMatchObject({ ok: false, status: 409 })
    expect(machineCredentialDecision(devices, { by: { token: 'stolen-token' }, name: 'bridge-local', action: 'adopt' })).toMatchObject({ ok: false, status: 409 })
  })

  it('an owner whose pairing is gone owns nothing; with no bridge-local left, the next Mac mints', () => {
    const devices = [macB, machine('bridge-devbox', { ownerId: 'id-gone' })]
    expect(machineCredentialDecision(devices, { by: as('mac-b'), name: 'bridge-local', action: 'mint' })).toMatchObject({ ok: true, adopt: [] })
    expect(machineCredentialDecision(devices, { by: as('mac-b'), name: 'bridge-devbox', action: 'adopt' })).toMatchObject({ ok: false, status: 409 })
  })

  it('credentials from before ownership: only the legacy bridge-local\'s own token proves anything', () => {
    const local = machine(PRIMARY_MACHINE_CREDENTIAL)
    const devbox = machine('bridge-devbox')
    const devices = [macA, macB, local, devbox]
    for (const action of ['mint', 'replace', 'revoke', 'adopt'] as const) {
      for (const proof of [undefined, 'forged', 'bridge-devbox-token']) {
        expect(machineCredentialDecision(devices, { by: as('mac-b'), name: action === 'mint' ? 'bridge-new' : 'bridge-local', action, proof }), `${action} ${proof}`).toMatchObject({ ok: false, status: 409, code: 'other_mac_connected' })
      }
    }
    // The first Mac, with bridge-local's token: every act works, and makes all of them its own.
    for (const action of ['mint', 'replace', 'revoke', 'adopt'] as const) {
      expect(machineCredentialDecision(devices, { by: as('mac-a'), name: action === 'mint' ? 'bridge-new' : 'bridge-local', action, proof: 'bridge-local-token' })).toEqual({ ok: true, me: macA, adopt: [local, devbox] })
    }
  })

  it('a device name is never taken over as a machine credential', () => {
    expect(machineCredentialDecision([macA, macB], { by: as('mac-a'), name: 'mac-b', action: 'replace' })).toMatchObject({ ok: false, status: 400, code: 'not_machine' })
  })
})

describe('minting, rotating and revoking on a real auth.json', () => {
  let tokens: Record<string, string>
  const by = (name: string): DeviceActor => ({ token: tokens[name] })

  beforeEach(async () => {
    await writeAuth([])
    tokens = {}
    for (const name of ['mac-a', 'mac-b', 'my-phone']) tokens[name] = (await createDevice(name)).token
    await setDeviceInfo('my-phone', { model: 'iPhone17,1', os: 'iOS 26.1' })
  })

  it('the first Mac mints and owns it by id; its daemon is its own, recorded on the Mac too', async () => {
    const minted = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await verifyDeviceToken(minted.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
    const mac = (await record('mac-a'))!
    expect(mac.id).toMatch(/^d[0-9a-f]{16}$/)
    expect(await record('bridge-local')).toMatchObject({ kind: 'machine', ownerId: mac.id, daemonKey: mac.id })
    expect(mac.tunnelDaemon).toEqual({ key: mac.id })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(mac.id)
  })

  it('a second Mac is refused every way, and the first keeps its token', async () => {
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

  it('the owner rotates it: a new token, the same daemon, and its sockets are told', async () => {
    const first = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const key = await machineCredentialDaemonKey('bridge-local')
    const heard: string[][] = []
    const off = onCredentialsRevoked((names) => heard.push(names))
    try {
      const second = await mintMachineCredential('bridge-local', { by: by('mac-a'), replace: true })
      expect(second.replaced).toBe(true)
      expect(second.token).not.toBe(first.token)
      expect(await verifyDeviceToken(first.token)).toBeNull()
      expect(heard).toEqual([['bridge-local']])
      expect(await machineCredentialDaemonKey('bridge-local')).toBe(key)
    } finally { off() }
  })

  it('a rotation keeps the daemon that serves the credential, even when the owner\'s own key differs', async () => {
    // bridge-devbox from before ownership (the unkeyed daemon), adopted when mac-a minted with proof.
    const legacyLocal = (await createDevice('bridge-local', { kind: 'machine' })).token
    await createDevice('bridge-devbox', { kind: 'machine' })
    await adoptMachineCredential('bridge-local', { by: by('mac-a'), proof: legacyLocal })
    await revokeMachineCredential('bridge-local', { by: by('mac-a') })
    // mac-a's own tunnel daemon is the unkeyed one; give it a key of its own the way a first mint does.
    const records = await listDeviceRecords()
    const mac = records.find((d) => d.name === 'mac-a')!
    await writeAuth(records.map((d) => (d.name === 'mac-a' ? { ...d, tunnelDaemon: { key: mac.id } } : d.name === 'bridge-devbox' ? { ...d, daemonKey: 'id-served-daemon' } : d)))
    await mintMachineCredential('bridge-devbox', { by: by('mac-a'), replace: true })
    expect(await machineCredentialDaemonKey('bridge-devbox')).toBe('id-served-daemon')
    // A fresh name gets the owner's.
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(mac.id)
  })

  it('without replace an existing name answers "already exists"', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    await expect(mintMachineCredential('bridge-local', { by: by('mac-a') })).rejects.toThrow(/already exists/)
  })

  it('two Macs minting at once: exactly one owns the companion', async () => {
    const results = await Promise.allSettled([
      mintMachineCredential('bridge-local', { by: by('mac-a') }),
      mintMachineCredential('bridge-local', { by: by('mac-b') }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const owners = (await listDeviceRecords()).filter((d) => d.kind === 'machine').map((d) => d.ownerId)
    expect(owners).toHaveLength(1)
  })

  it("revoking the owner's pairing takes its credentials, and the unowned ones, so another Mac can take over", async () => {
    const legacy = (await createDevice('bridge-devbox', { kind: 'machine' })).token
    const local = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const heard: string[][] = []
    const off = onCredentialsRevoked((names) => heard.push(names))
    try {
      // mac-a unpairs itself.
      expect(await revokeDevice('mac-a', { by: by('mac-a') })).toBe(true)
    } finally { off() }
    expect(heard[0]?.sort()).toEqual(['bridge-devbox', 'bridge-local', 'mac-a'])
    expect(await verifyDeviceToken(local.token)).toBeNull()
    expect(await verifyDeviceToken(legacy)).toBeNull()
    // The handover: mac-b mints now, into a daemon of its own.
    const next = await mintMachineCredential('bridge-local', { by: by('mac-b') })
    expect(await verifyDeviceToken(next.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe((await record('mac-b'))!.id)
  })

  it('revoking a device that owns nothing leaves every machine credential alone', async () => {
    const legacy = (await createDevice('bridge-local', { kind: 'machine' })).token
    expect(await revokeDevice('mac-b')).toBe(true)
    expect(await verifyDeviceToken(legacy)).toEqual({ name: 'bridge-local', kind: 'machine' })
  })

  it('a Mac rotating its own pairing stays the owner: same id, same credentials, same daemon', async () => {
    const local = await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const id = (await record('mac-a'))!.id
    const rotated = await rotateDevice('mac-a', { by: by('mac-a') })
    expect(rotated.replaced).toBe(true)
    expect(await verifyDeviceToken(tokens['mac-a'])).toBeNull()
    expect((await record('mac-a'))!.id).toBe(id)
    expect(await verifyDeviceToken(local.token)).toEqual({ name: 'bridge-local', kind: 'machine' })
    // The new token is the owner now.
    expect((await mintMachineCredential('bridge-local', { by: { token: rotated.token }, replace: true })).replaced).toBe(true)
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(id)
  })

  it('a rotation of the Mac\'s pairing by anyone else inherits nothing (the takeover)', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    // Refused for the phone and for the other Mac outright.
    for (const who of ['my-phone', 'mac-b']) {
      await expect(rotateDevice('mac-a', { by: by(who) })).rejects.toMatchObject({ status: 403, code: 'device_change_refused' })
    }
    // A local re-pair of the name is a NEW pairing: new id, and the old one's credentials go.
    const oldId = (await record('mac-a'))!.id
    const repaired = await rotateDevice('mac-a', { by: { local: true } })
    const fresh = (await record('mac-a'))!
    expect(fresh.id).not.toBe(oldId)
    expect(await record('bridge-local')).toBeUndefined()
    // The new pairing starts with no ownership; minting now gets it a daemon of its own id.
    await mintMachineCredential('bridge-local', { by: { token: repaired.token } })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(fresh.id)
    expect(fresh.id).not.toBe(oldId)
  })

  it('adopting records the owner and the legacy daemon, and keeps the token', async () => {
    const legacy = (await createDevice('bridge-local', { kind: 'machine' })).token
    const devbox = (await createDevice('bridge-devbox', { kind: 'machine' })).token
    expect(await refusal(adoptMachineCredential('bridge-local', { by: by('mac-b') }))).toMatchObject({ status: 409 })
    // Another legacy credential's token is no proof.
    expect(await refusal(adoptMachineCredential('bridge-local', { by: by('mac-b'), proof: devbox }))).toMatchObject({ status: 409 })
    expect(await refusal(mintMachineCredential('bridge-local', { by: by('mac-b'), replace: true, proof: devbox }))).toMatchObject({ status: 409 })
    expect(await adoptMachineCredential('bridge-local', { by: by('mac-a'), proof: legacy })).toBe('adopted')
    expect(await adoptMachineCredential('bridge-local', { by: by('mac-a'), proof: legacy })).toBe('owned')
    expect(await adoptMachineCredential('bridge-none', { by: by('mac-a'), proof: legacy })).toBe('missing')
    const mac = (await record('mac-a'))!
    expect(await record('bridge-local')).toMatchObject({ ownerId: mac.id, tokenHash: sha(legacy) })
    expect(await record('bridge-devbox')).toMatchObject({ ownerId: mac.id })
    expect((await record('bridge-local'))?.daemonKey).toBeUndefined() // still the daemon it always had
    expect(mac.tunnelDaemon).toEqual({}) // and that daemon is this Mac's now
    expect(await verifyDeviceToken(legacy)).toEqual({ name: 'bridge-local', kind: 'machine' })
    // Now owned: mac-b is refused without any proof question.
    expect(await refusal(mintMachineCredential('bridge-x', { by: by('mac-b'), proof: legacy }))).toMatchObject({ status: 409 })
  })

  it('an adopted legacy credential revoked and minted again stays on the legacy daemon', async () => {
    const legacy = (await createDevice('bridge-local', { kind: 'machine' })).token
    await adoptMachineCredential('bridge-local', { by: by('mac-a'), proof: legacy })
    expect(await revokeMachineCredential('bridge-local', { by: by('mac-a') })).toBe(true)
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await machineCredentialDaemonKey('bridge-local')).toBeUndefined()
  })

  it('a legacy revoke with proof adopts first, so the re-mint stays on the legacy daemon too', async () => {
    const legacy = (await createDevice('bridge-local', { kind: 'machine' })).token
    expect(await revokeMachineCredential('bridge-local', { by: by('mac-a'), proof: legacy })).toBe(true)
    expect((await record('mac-a'))!.tunnelDaemon).toEqual({})
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    expect(await machineCredentialDaemonKey('bridge-local')).toBeUndefined()
    // mac-b is the other Mac now.
    expect(await refusal(mintMachineCredential('bridge-y', { by: by('mac-b') }))).toMatchObject({ status: 409 })
  })

  it('the owner revokes its own credential: its sockets are told, and a repeat answers false', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const heard: string[][] = []
    const off = onCredentialsRevoked((names) => heard.push(names))
    try {
      expect(await revokeMachineCredential('bridge-local', { by: by('mac-a') })).toBe(true)
      expect(heard).toEqual([['bridge-local']])
      expect(await revokeMachineCredential('bridge-local', { by: by('mac-a') })).toBe(false)
      expect(heard).toEqual([['bridge-local']])
    } finally { off() }
  })
})
