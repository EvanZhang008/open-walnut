/**
 * Who owns a cloud companion (core/device-store.ts `owner`): the Mac it
 * belongs to. Only what proves it records an owner: the setup claim of a
 * device that says it is a computer (tests/core/device-owner-kinds.test.ts has
 * the claims that record none), the box
 * operator, the unowned bridge-local's token, or (with none recorded) the
 * first paired device that is not a phone to mint a machine credential. Never
 * a self-report, and never which record is oldest (2026-10-05 gate: a guess
 * from the record order handed a companion to a laptop paired before the Mac,
 * and locked the Mac's bridge out).
 *
 * The upgrade case first: an auth.json exactly as a build without owners
 * wrote it, which every existing companion has. Then the claim (one at a time,
 * even when two race), the operator's commands, and what removing the owner
 * does. Real files in a throwaway data dir, through the real locked write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-device-owner', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, claimInstance, createDevice, getSetupTokenIfUnclaimed, readDeviceRegistry, revokeDevice, setDeviceInfo,
} from '../../src/core/device-auth.js'
import { companionOwnerRecord, ownerRecord } from '../../src/core/device-actor.js'
import { mintMachineCredential } from '../../src/core/machine-credentials.js'
import { runDeviceAdd, runDeviceList, runDeviceOwner } from '../../src/commands/device.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const created = '2026-09-01T00:00:00.000Z'
const IPHONE = { model: 'iPhone17,1', os: 'iOS 26.1', reportedAt: created }
const AMAC = { model: 'Mac15,3', os: 'macOS 26.0', reportedAt: created }
const file = () => path.join(WALNUT_HOME, 'auth.json')
const onDisk = async () => JSON.parse(await fs.readFile(file(), 'utf-8')) as { devices: Array<Record<string, unknown>>; owner?: { id: string; via: string } | null }

/** Exactly how a build without owners writes auth.json (saveAuth: 2-space JSON, a newline). */
async function writeHeadAuth(devices: unknown[]): Promise<string> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const text = JSON.stringify({ devices }, null, 2) + '\n'
  await fs.writeFile(file(), text, { mode: 0o600 })
  await fs.rm(`${file()}.bak`, { force: true })
  _resetDeviceAuthForTesting()
  return text
}

async function cli(run: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = []
  const err: string[] = []
  const l = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m ?? '')) })
  const e = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { err.push(String(m ?? '')) })
  const before = process.exitCode
  process.exitCode = 0
  try { await run() } finally { l.mockRestore(); e.mockRestore() }
  const exitCode = Number(process.exitCode ?? 0)
  process.exitCode = before
  return { out: out.join('\n'), err: err.join('\n'), exitCode }
}

const HEAD_COMPANION = [
  { name: 'mac-primary', tokenHash: sha('mac'), createdAt: created, info: AMAC },
  { name: 'mac-second', tokenHash: sha('second'), createdAt: created, info: AMAC },
  { name: 'phone-a', tokenHash: sha('phone'), createdAt: created, info: IPHONE },
  { name: 'tablet-new', tokenHash: sha('tablet'), createdAt: created },
  { name: 'bridge-local', tokenHash: sha('local'), createdAt: created, kind: 'machine' },
]

describe('upgrading an auth.json a build without owners wrote', () => {
  beforeEach(() => { _resetDeviceAuthForTesting() })

  it('a read changes nothing on disk, and no owner is guessed; the first real change records ids and platforms, never an owner', async () => {
    const text = await writeHeadAuth(HEAD_COMPANION)
    const read = await readDeviceRegistry()
    expect(read.owner).toBeNull()
    expect(companionOwnerRecord(read)).toBeUndefined()
    expect(await fs.readFile(file(), 'utf-8')).toBe(text)
    // The ids a read gives are the same on every read (derived from the token hash), before any write.
    expect((await readDeviceRegistry()).devices.map((d) => d.id)).toEqual(read.devices.map((d) => d.id))
    // A real change (here a phone's launch report) brings the file up to date.
    expect(await setDeviceInfo('phone-a', { model: 'iPhone17,1', os: 'iOS 26.2' })).toBe(true)
    const after = await onDisk()
    for (const d of after.devices) expect(String(d.id)).toMatch(/^d[0-9a-f]{16}$/)
    expect(after.devices.map((d) => d.id)).toEqual(read.devices.map((d) => d.id))
    expect(Object.fromEntries(after.devices.map((d) => [d.name, d.platform]))).toEqual({ 'mac-primary': 'other', 'mac-second': 'other', 'phone-a': 'ios', 'tablet-new': undefined, 'bridge-local': undefined })
    expect(after).not.toHaveProperty('owner')
  })

  it('a no-op writes nothing: a report that changes nothing, a revoke of a name that is not there', async () => {
    await writeHeadAuth(HEAD_COMPANION.map((d) => (d.name === 'phone-a' ? { ...d, platform: 'ios', id: 'd00000000000000a1', info: { model: 'iPhone17,1', os: 'iOS 26.1' } } : d)))
    const text = await fs.readFile(file(), 'utf-8')
    expect(await setDeviceInfo('phone-a', { model: 'iPhone17,1', os: 'iOS 26.1' })).toBe(true)
    expect(await revokeDevice('nobody')).toBe(false)
    expect(await fs.readFile(file(), 'utf-8')).toBe(text)
    await expect(fs.stat(`${file()}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('with none recorded, whatever the record order, the unowned bridge-local decides: no proof, no mint', async () => {
    for (const order of [HEAD_COMPANION, [HEAD_COMPANION[2], HEAD_COMPANION[3], HEAD_COMPANION[1], HEAD_COMPANION[0], HEAD_COMPANION[4]]]) {
      await writeHeadAuth(order)
      for (const t of ['mac', 'second', 'tablet']) {
        await expect(mintMachineCredential('bridge-devbox', { by: { token: t } })).rejects.toMatchObject({ status: 409, code: 'other_mac_connected' })
      }
      await expect(mintMachineCredential('bridge-devbox', { by: { token: 'phone' } })).rejects.toMatchObject({ status: 403 })
      expect((await mintMachineCredential('bridge-devbox', { by: { token: 'mac' }, proof: 'local' })).name).toBe('bridge-devbox')
      const reg = await readDeviceRegistry()
      expect(ownerRecord(reg)?.name).toBe('mac-primary')
      expect(reg.owner?.via).toBe('proof')
    }
  })

  it('an owner whose record is gone (removed by an older build) is no owner', async () => {
    await writeHeadAuth([])
    await fs.writeFile(file(), JSON.stringify({ devices: [{ name: 'mac', id: 'd1', tokenHash: sha('mac'), createdAt: created }], owner: { id: 'd-gone', via: 'claim' } }))
    expect((await readDeviceRegistry()).owner).toBeNull()
  })

  it('an owner recorded as \'inferred\' (a build that guessed) is read as none', async () => {
    await writeHeadAuth([])
    await fs.writeFile(file(), JSON.stringify({ devices: [{ name: 'laptop', id: 'd1', tokenHash: sha('laptop'), createdAt: created }], owner: { id: 'd1', via: 'inferred' } }))
    expect((await readDeviceRegistry()).owner).toBeNull()
  })
})

describe('the claim records the owner', () => {
  beforeEach(async () => {
    await writeHeadAuth([])
    await fs.rm(file(), { force: true })
    _resetDeviceAuthForTesting()
  })

  it('the computer that claims with the setup token is the owner, by claim', async () => {
    const setup = await getSetupTokenIfUnclaimed()
    const { token } = await claimInstance(setup!.token, 'my-mac', AMAC)
    const reg = await readDeviceRegistry()
    expect(ownerRecord(reg)?.name).toBe('my-mac')
    expect(reg.owner?.via).toBe('claim')
    await expect(claimInstance(setup!.token, 'second')).rejects.toThrow('Instance already claimed')
    expect((await mintMachineCredential('bridge-local', { by: { token } })).name).toBe('bridge-local')
  })

  it('two claims at once: exactly one lands, and its device is the owner', async () => {
    const setup = await getSetupTokenIfUnclaimed()
    const results = await Promise.allSettled([claimInstance(setup!.token, 'mac-1', AMAC), claimInstance(setup!.token, 'mac-2', AMAC)])
    const won = results.filter((r): r is PromiseFulfilledResult<{ name: string; token: string; owner: boolean }> => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(String(lost[0].reason?.message ?? lost[0].reason)).toMatch(/Instance already claimed|Invalid or expired setup token/)
    const disk = await onDisk()
    expect(disk.devices.map((d) => d.name)).toEqual([won[0].value.name])
    expect(disk.owner).toEqual({ id: disk.devices[0].id, via: 'claim' })
  })
})

describe('the box operator names the owner (`walnut device owner`, `device add --owner`)', () => {
  beforeEach(async () => {
    await writeHeadAuth([
      { name: 'mac-old', id: 'd-old', tokenHash: sha('old'), createdAt: created, platform: 'other' },
      { name: 'mac-new', id: 'd-new', tokenHash: sha('new'), createdAt: created },
      { name: 'phone-a', id: 'd-phone', tokenHash: sha('phone'), createdAt: created, platform: 'ios' },
    ])
    await fs.writeFile(file(), JSON.stringify({ ...(await onDisk()), owner: { id: 'd-old', via: 'claim' } }))
    await mintMachineCredential('bridge-local', { by: { token: 'old' } })
  })

  it('passing the companion to another Mac removes the old one\'s connections', async () => {
    const r = await cli(() => runDeviceOwner('mac-new', {} as never))
    expect(r.exitCode).toBe(0)
    expect(r.out).toMatch(/now belongs to "mac-new"/)
    expect(r.out).toMatch(/bridge-local/)
    const reg = await readDeviceRegistry()
    expect(reg.owner).toEqual({ id: 'd-new', via: 'operator' })
    expect(reg.devices.some((d) => d.kind === 'machine')).toBe(false)
    expect((await mintMachineCredential('bridge-local', { by: { token: 'new' } })).name).toBe('bridge-local')
    await expect(mintMachineCredential('bridge-x', { by: { token: 'old' } })).rejects.toMatchObject({ status: 409, code: 'other_mac_connected' })
  })

  it('a phone, a machine credential or an unknown name is refused in one sentence, exit 1, nothing changed', async () => {
    const before = await onDisk()
    for (const [name, sentence] of [
      ['phone-a', 'phone-a is a phone; the owner is the Mac this cloud companion belongs to.'],
      ['bridge-local', "bridge-local is a computer's connection, not a paired device."],
      ['nobody', 'Device "nobody" not found.'],
    ]) {
      const r = await cli(() => runDeviceOwner(name, {} as never))
      expect(r.exitCode).toBe(1)
      expect(r.err).toContain(sentence)
    }
    expect(await onDisk()).toEqual(before)
  })

  it('`device add --owner` pairs and names it in one step; `device list` marks the owner', async () => {
    const r = await cli(() => runDeviceAdd('mac-third', { json: true } as never, { owner: true }))
    expect(JSON.parse(r.out)).toMatchObject({ name: 'mac-third', owner: true })
    const listed = await cli(() => runDeviceList({ json: true } as never))
    expect(JSON.parse(listed.out).owner).toBe('mac-third')
    const text = await cli(() => runDeviceList({} as never))
    expect(text.out).toMatch(/mac-third.*\(owner\)/)
  })

  it('`device revoke` of the owner says what happens next; no owner is recorded until something proves one', async () => {
    const r = await cli(() => import('../../src/commands/device.js').then((m) => m.runDeviceRevoke('mac-old', {} as never)))
    expect(r.out).toMatch(/The next Mac to connect becomes its owner, or name one with: walnut device owner <name>/)
    expect((await onDisk()).owner).toBeUndefined()
    expect(await revokeDevice('mac-new')).toBe(true)
  })
})

describe('a Mac\'s own registry (no companion)', () => {
  it('no owner is shown there: the Mac has no owner but itself', async () => {
    await writeHeadAuth([{ name: 'studio-mac', tokenHash: sha('s'), createdAt: created }])
    await createDevice('lan-phone')
    const listed = await cli(() => runDeviceList({ json: true } as never))
    expect(JSON.parse(listed.out).owner).toBeNull()
  })
})
