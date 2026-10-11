/**
 * Which companion tunnel daemon a machine credential is served by
 * (core/machine-credentials.ts, core/device-store.ts ownByProof), and
 * that every credential this process revokes is heard at once by whoever holds
 * a socket opened with it (core/device-auth.ts onCredentialsRevoked).
 *
 *  - an owner with nothing from before owners were recorded gets a daemon of
 *    its own, keyed by its id, and keeps it across revokes and re-mints;
 *  - the Mac that proves it owns such older credentials (the unowned
 *    bridge-local's token) takes the unkeyed daemon they always used, so its
 *    sessions stay; without the proof nobody acts on them, as before;
 *  - a rotation keeps the daemon that serves the credential;
 *  - the box operator naming another owner gives that one a daemon of its own.
 *
 * Real auth.json in a throwaway data dir, through the routes' locked writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-machine-creds-tunnel', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, createDevice, listDeviceRecords, onCredentialsRevoked, revokeDevice, revokeDeviceAs, rotateDevice, setCompanionOwner,
} from '../../src/core/device-auth.js'
import {
  adoptMachineCredential, machineCredentialDaemonKey, mintMachineCredential, revokeMachineCredential,
} from '../../src/core/machine-credentials.js'
import { LOCAL_ACTOR, type DeviceActor } from '../../src/core/device-actor.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const now = new Date().toISOString()
const record = async (name: string) => (await listDeviceRecords()).find((d) => d.name === name)

let heard: string[][] = []
let off: (() => void) | null = null

async function writeAuth(file: unknown): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify(file), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

beforeEach(() => {
  heard = []
  off = onCredentialsRevoked((names) => heard.push(names))
})
afterEach(() => { off?.(); off = null })

describe('an owner that claimed a fresh companion', () => {
  let tokens: Record<string, string>
  const by = (name: string): DeviceActor => ({ token: tokens[name] })

  beforeEach(async () => {
    await writeAuth({ devices: [] })
    tokens = {}
    tokens['mac-a'] = (await createDevice('mac-a', { owner: true })).token
    tokens['mac-b'] = (await createDevice('mac-b')).token
  })

  it('its first credential gets a daemon of its own, recorded on the Mac too; every later one lands there', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const mac = (await record('mac-a'))!
    expect(mac.tunnelDaemon).toEqual({ key: mac.id })
    expect(await record('bridge-local')).toMatchObject({ ownerId: mac.id, daemonKey: mac.id })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(mac.id)
    // Revoked and minted again: the same daemon, and the revoke was heard.
    expect(await revokeMachineCredential('bridge-local', { by: by('mac-a') })).toBe(true)
    expect(heard).toEqual([['bridge-local']])
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    await mintMachineCredential('bridge-devbox', { by: by('mac-a') })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(mac.id)
    expect(await machineCredentialDaemonKey('bridge-devbox')).toBe(mac.id)
    // A name that is not a machine credential serves nothing.
    expect(await machineCredentialDaemonKey('mac-a')).toBeUndefined()
    expect(await machineCredentialDaemonKey('nothing')).toBeUndefined()
  })

  it('a rotation keeps the daemon that serves the credential, and its sockets are told', async () => {
    await mintMachineCredential('bridge-devbox', { by: by('mac-a') })
    const auth = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>> }
    await writeAuth({ ...auth, devices: auth.devices.map((d) => (d.name === 'bridge-devbox' ? { ...d, daemonKey: 'id-served-daemon' } : d)) })
    const rotated = await mintMachineCredential('bridge-devbox', { by: by('mac-a'), replace: true })
    expect(rotated.replaced).toBe(true)
    expect(await machineCredentialDaemonKey('bridge-devbox')).toBe('id-served-daemon')
    expect(heard).toEqual([['bridge-devbox']])
  })

  it('a refused caller changes no daemon and tells nobody', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    await expect(mintMachineCredential('bridge-local', { by: by('mac-b'), replace: true })).rejects.toMatchObject({ status: 409 })
    await expect(revokeMachineCredential('bridge-local', { by: by('mac-b') })).rejects.toMatchObject({ status: 409 })
    expect((await record('mac-b'))!.tunnelDaemon).toBeUndefined()
    expect(heard).toEqual([])
  })

  it('the owner\'s pairing removed: every credential goes, and all of them are heard at once', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    await mintMachineCredential('bridge-devbox', { by: by('mac-a') })
    expect(await revokeDeviceAs('mac-a', { by: by('mac-a') })).toBe(true)
    expect(heard).toEqual([['mac-a', 'bridge-local', 'bridge-devbox']])
    expect((await listDeviceRecords()).map((d) => d.name)).toEqual(['mac-b'])
  })

  it('the box operator names another owner: the old one\'s credentials are heard gone, and the new owner gets a daemon of its own', async () => {
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    const macA = (await record('mac-a'))!
    expect(await setCompanionOwner('mac-b')).toEqual({ removedCredentials: ['bridge-local'], changed: true })
    expect(heard).toEqual([['bridge-local']])
    await mintMachineCredential('bridge-local', { by: by('mac-b') })
    const macB = (await record('mac-b'))!
    expect(macB.tunnelDaemon).toEqual({ key: macB.id })
    expect(await machineCredentialDaemonKey('bridge-local')).toBe(macB.id)
    expect(macB.id).not.toBe(macA.id)
  })

  it('a device re-paired or removed is heard too (its own sockets close)', async () => {
    tokens['my-phone'] = (await createDevice('my-phone')).token
    await rotateDevice('my-phone', { by: LOCAL_ACTOR })
    expect(heard).toEqual([['my-phone']])
    expect(await revokeDevice('my-phone')).toBe(true)
    expect(heard).toEqual([['my-phone'], ['my-phone']])
    // `device add --owner` from the operator: whatever the old owner had is heard gone.
    await mintMachineCredential('bridge-local', { by: by('mac-a') })
    heard = []
    await createDevice('mac-c', { owner: true })
    expect(heard).toEqual([['bridge-local']])
  })
})

describe('a companion from before owners were recorded', () => {
  const T = { mac: 'legacy-mac-token', second: 'legacy-second-token', local: 'legacy-local-token', devbox: 'legacy-devbox-token' }
  /** auth.json exactly as a build without owners wrote it. */
  async function writeLegacy(): Promise<void> {
    await writeAuth({ devices: [
      { name: 'mac-primary', tokenHash: sha(T.mac), createdAt: now },
      { name: 'mac-second', tokenHash: sha(T.second), createdAt: now },
      { name: 'bridge-local', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
      { name: 'bridge-devbox', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine' },
    ] })
  }

  it('the Mac proving itself takes the unkeyed daemon they used; its next credentials land there too', async () => {
    await writeLegacy()
    expect(await adoptMachineCredential('bridge-local', { by: { token: T.mac }, proof: T.local })).toBe('adopted')
    expect((await record('mac-primary'))!.tunnelDaemon).toEqual({})
    expect(await machineCredentialDaemonKey('bridge-local')).toBeUndefined()
    await mintMachineCredential('bridge-newhost', { by: { token: T.mac } })
    expect(await machineCredentialDaemonKey('bridge-newhost')).toBeUndefined()
    // Revoked and minted again: still the unkeyed daemon, no keyed one ever made.
    expect(await revokeMachineCredential('bridge-local', { by: { token: T.mac } })).toBe(true)
    await mintMachineCredential('bridge-local', { by: { token: T.mac } })
    expect(await machineCredentialDaemonKey('bridge-local')).toBeUndefined()
    expect(heard).toEqual([['bridge-local']])
  })

  it('a proof sent on a device route (the console relay) settles the daemon the same way', async () => {
    await writeLegacy()
    await createDevice('my-phone')
    expect(await revokeDeviceAs('my-phone', { by: { token: T.mac }, proof: T.local })).toBe(true)
    expect((await record('mac-primary'))!.tunnelDaemon).toEqual({})
    expect((await record('bridge-local'))!.ownerId).toBe((await record('mac-primary'))!.id)
    await mintMachineCredential('bridge-newhost', { by: { token: T.mac } })
    expect(await machineCredentialDaemonKey('bridge-newhost')).toBeUndefined()
  })

  it('a Mac without the proof (a lost cache on an older build) is refused as before, and no daemon is settled', async () => {
    await writeLegacy()
    await expect(revokeMachineCredential('bridge-local', { by: { token: T.mac } })).rejects.toMatchObject({ status: 409, code: 'other_mac_connected' })
    expect((await record('mac-primary'))!.tunnelDaemon).toBeUndefined()
    expect(heard).toEqual([])
  })
})
