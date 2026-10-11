/**
 * A cloud companion's owner is a computer, never a phone (2026-10-06 gate:
 * the setup banner's own example claimed the companion as "my-phone", and the
 * phone became the owner: it removed and re-paired the Mac, made API keys, and
 * the Mac's bridge was refused). Each path that can record an owner, and the
 * rules that read one, are pinned here:
 *  - the setup claim records the claimer only when its self-report says a
 *    computer (the setup wizard sends one); a claim that says nothing, or says
 *    a phone, records none, and the first computer to mint becomes the owner;
 *  - a phone's first report ends a phone's being the owner, and every rule
 *    that reads the owner skips a phone whatever the file says;
 *  - only a mint records an owner by the first come rule (a revoke does not);
 *  - the operator naming the owner it already named writes nothing;
 *  - the sentence a refused computer hears is true about the owner.
 * Plus the three survivors of the gate's mutants: a failed set-aside stops the
 * write (N02), a box holding only machine credentials is claimed (N08), and a
 * proof records nobody while another device owns machine credentials (N10).
 * Real files in a throwaway data dir, through the real locked write.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-owner-kinds', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  _resetDeviceAuthForTesting, apiKeyMaker, claimInstance, createDevice, getSetupTokenIfUnclaimed, isClaimed, printSetupTokenBanner,
  readDeviceRegistry, revokeDeviceAs, rotateDevice, setCompanionOwner, setDeviceInfo,
} from '../../src/core/device-auth.js'
import { apiKeyDecision, companionOwnerRecord, hasOwnerRights, ownerRecord, proofClaim } from '../../src/core/device-actor.js'
import type { DeviceRecord, DeviceRegistry } from '../../src/core/device-store.js'
import {
  OTHER_COMPUTER_CONNECTED, OTHER_MAC_CONNECTED, machineCredentialDecision, mintMachineCredential, revokeMachineCredential,
} from '../../src/core/machine-credentials.js'
import { computerSelfReport } from '../../src/core/device-self-report.js'
import { runDeviceOwner } from '../../src/commands/device.js'
import { setupRouter } from '../../src/web/routes/setup.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const created = '2026-09-01T00:00:00.000Z'
const IPHONE = { model: 'iPhone17,1', os: 'iOS 26.1' }
const AMAC = { model: 'Mac15,3', os: 'macOS 26.0' }
const LINUX = { model: 'Computer', os: 'Linux' }
const file = () => path.join(WALNUT_HOME, 'auth.json')
type Disk = { devices: Array<Record<string, unknown>>; owner?: { id: string; via: string } | null }
const onDisk = async () => JSON.parse(await fs.readFile(file(), 'utf-8')) as Disk
const ownerName = async () => {
  const d = await onDisk()
  return d.owner ? `${d.devices.find((r) => r.id === d.owner!.id)?.name} via ${d.owner.via}` : null
}

async function writeAuth(content: unknown): Promise<void> {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(file(), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', { mode: 0o600 })
  await fs.rm(`${file()}.bak`, { force: true })
  _resetDeviceAuthForTesting()
}

async function fresh(): Promise<void> {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
}

async function claim(name: string, device?: unknown): Promise<{ token: string; owner: boolean }> {
  const setup = await getSetupTokenIfUnclaimed()
  return claimInstance(setup!.token, name, device)
}

/** Pair `name` the way the box operator does, and have it report what it is. */
async function pair(name: string, info?: Record<string, string>): Promise<string> {
  const { token } = await createDevice(name)
  if (info) await setDeviceInfo({ token }, info)
  return token
}

async function refusal(p: Promise<unknown>): Promise<{ status?: number; code?: string; message: string }> {
  try { await p } catch (err) {
    const e = err as { status?: number; code?: string; message: string }
    return { status: e.status, code: e.code, message: e.message }
  }
  throw new Error('expected a refusal')
}

afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('the setup claim records a computer only', () => {
  beforeEach(fresh)

  it('the setup wizard\'s claim (it says what this computer is) records the claimer as the owner', async () => {
    const r = await claim('mac-studio', computerSelfReport())
    expect(r.owner).toBe(true)
    expect(await ownerName()).toBe('mac-studio via claim')
    const rec = (await onDisk()).devices[0]
    expect(rec.platform).toBe('other')
    expect(rec.info).toMatchObject(computerSelfReport())
    // With its bridge off (it never mints), it still has the owner's rights (the fresh-off, first cell).
    await pair('phone-a', IPHONE)
    await pair('phone-b', IPHONE)
    expect(await revokeDeviceAs('phone-a', { by: { token: r.token } })).toBe(true)
    expect((await rotateDevice('phone-b', { by: { token: r.token } })).replaced).toBe(true)
  })

  it('a phone that claims with its report is recorded as a phone, and owns nothing', async () => {
    const phone = await claim('my-phone', IPHONE)
    expect(phone.owner).toBe(false)
    expect((await onDisk()).owner).toBeUndefined()
    expect((await onDisk()).devices[0].platform).toBe('ios')
    const mac = await pair('gate-mac', AMAC)
    const phoneB = await pair('phone-b', IPHONE)
    const by = { token: phone.token }
    expect(await refusal(revokeDeviceAs('gate-mac', { by }))).toMatchObject({ status: 403, code: 'device_change_refused' })
    expect(await refusal(rotateDevice('gate-mac', { by }))).toMatchObject({ status: 403, code: 'device_change_refused' })
    expect(await refusal(revokeDeviceAs('phone-b', { by }))).toMatchObject({ status: 403, code: 'device_change_refused' })
    expect(await refusal(apiKeyMaker(by))).toMatchObject({ status: 403, code: 'api_keys_refused' })
    expect(await refusal(mintMachineCredential('bridge-x', { by }))).toMatchObject({ status: 403, code: 'phone_cannot_mint' })
    // The Mac's bridge job: the first computer to mint is the owner, and has its rights.
    expect((await mintMachineCredential('bridge-local', { by: { token: mac } })).name).toBe('bridge-local')
    expect(await ownerName()).toBe('gate-mac via mint')
    expect(await revokeDeviceAs('phone-b', { by: { token: mac } })).toBe(true)
    void phoneB
  })

  it('the banner\'s own claim (no report), then the phone reports: no owner ever, the Mac\'s mint is first come', async () => {
    const phone = await claim('my-phone')
    expect(phone.owner).toBe(false)
    await setDeviceInfo({ token: phone.token }, IPHONE)
    const mac = await pair('gate-mac', AMAC)
    await pair('phone-b', IPHONE)
    expect((await readDeviceRegistry()).owner).toBeNull()
    expect(await refusal(revokeDeviceAs('gate-mac', { by: { token: phone.token } }))).toMatchObject({ status: 403 })
    expect((await mintMachineCredential('bridge-local', { by: { token: mac } })).name).toBe('bridge-local')
    expect(await ownerName()).toBe('gate-mac via mint')
  })

  it('not first (the fresh-on, not first cell): a laptop claims by hand, the operator adds the Mac, and the Mac\'s bridge connects', async () => {
    const laptop = await claim('ops-laptop')
    const mac = await pair('gate-mac', AMAC)
    for (const name of ['phone-a', 'phone-b']) await pair(name, IPHONE)
    await pair('tablet-x')
    // The Mac's bridge job, then its new host: the first computer to mint is the owner.
    expect((await mintMachineCredential('bridge-local', { by: { token: mac } })).name).toBe('bridge-local')
    expect((await mintMachineCredential('bridge-devbox0', { by: { token: mac } })).name).toBe('bridge-devbox0')
    expect(await ownerName()).toBe('gate-mac via mint')
    // The laptop now has none of the owner's rights.
    expect(await refusal(revokeDeviceAs('phone-a', { by: { token: laptop.token } }))).toMatchObject({ status: 403 })
    expect(await refusal(mintMachineCredential('bridge-x', { by: { token: laptop.token } }))).toMatchObject({ status: 409 })
    // The cell's steps, as the Mac: remove phone-a, re-pair phone-b, a lost cache (mint again), remove tablet-x.
    expect(await revokeDeviceAs('phone-a', { by: { token: mac } })).toBe(true)
    expect((await rotateDevice('phone-b', { by: { token: mac } })).replaced).toBe(true)
    expect((await mintMachineCredential('bridge-local', { by: { token: mac }, replace: true })).replaced).toBe(true)
    expect(await revokeDeviceAs('tablet-x', { by: { token: mac } })).toBe(true)
    expect(await ownerName()).toBe('gate-mac via mint')
  })

  it('not first, bridge off: nobody mints, so nobody has the owner\'s rights (as before owners were recorded)', async () => {
    const laptop = await claim('ops-laptop')
    const mac = await pair('gate-mac', AMAC)
    await pair('phone-a', IPHONE)
    for (const token of [laptop.token, mac]) {
      expect(await refusal(revokeDeviceAs('phone-a', { by: { token } }))).toMatchObject({ status: 403 })
    }
    expect((await onDisk()).owner).toBeUndefined()
  })

  it('a report that is not an object, or says nothing, records no owner and no platform', async () => {
    for (const device of [{ model: 42, os: ['macOS'] }, {}, null]) {
      await fresh()
      const r = await claim('mystery', device)
      expect(r.owner).toBe(false)
      expect((await onDisk()).owner).toBeUndefined()
      expect((await onDisk()).devices[0].platform).toBeUndefined()
    }
  })

  it('the banner\'s example is a Mac\'s name', () => {
    const out: string[] = []
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true })
    try { printSetupTokenBanner('f'.repeat(32), Date.now()) } finally { w.mockRestore() }
    expect(out.join('')).toContain('"deviceName":"my-mac"')
    expect(out.join('')).not.toMatch(/phone/i)
  })
})

describe('POST /api/v1/setup/claim passes the claimer\'s report on', () => {
  async function postClaim(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const app = express()
    app.use(express.json())
    app.use('/api/v1/setup', setupRouter)
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/setup/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: res.status, json: await res.json() as Record<string, unknown> }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  beforeEach(async () => { await fresh(); _resetAuthRateLimitForTesting() })

  it('a computer\'s report makes it the owner; the answer keeps its shape', async () => {
    const setup = await getSetupTokenIfUnclaimed()
    const r = await postClaim({ setupToken: setup!.token, deviceName: 'route-mac', device: { model: 'Mac', os: 'macOS', appVersion: '1.0' } })
    expect(r.status).toBe(200)
    expect(Object.keys(r.json).sort()).toEqual(['deviceName', 'token'])
    expect(await ownerName()).toBe('route-mac via claim')
  })

  it('a report that is a string, or none, records no owner', async () => {
    const setup = await getSetupTokenIfUnclaimed()
    const r = await postClaim({ setupToken: setup!.token, deviceName: 'route-x', device: 'macOS' })
    expect(r.status).toBe(200)
    expect((await onDisk()).owner).toBeUndefined()
  })
})

describe('a phone is never the owner, whatever the file says (the second line)', () => {
  const PHONE_OWNED = {
    devices: [
      { name: 'my-phone', id: 'd-phone', tokenHash: sha('phone'), createdAt: created, platform: 'ios', info: IPHONE },
      { name: 'gate-mac', id: 'd-mac', tokenHash: sha('mac'), createdAt: created, platform: 'other', info: AMAC },
      { name: 'phone-b', id: 'd-phone-b', tokenHash: sha('phone-b'), createdAt: created, platform: 'ios', info: IPHONE },
    ],
    owner: { id: 'd-phone', via: 'claim' },
  }

  it('an owner recorded as a phone (an earlier build wrote it) is none: no rights, no API key; the Mac\'s mint is first come', async () => {
    await writeAuth(PHONE_OWNED)
    const reg = await readDeviceRegistry()
    const phone = reg.devices.find((d) => d.name === 'my-phone')!
    expect(ownerRecord(reg)).toBeUndefined()
    expect(companionOwnerRecord(reg)).toBeUndefined()
    expect(hasOwnerRights(reg, phone, true)).toBe(false)
    expect(apiKeyDecision(reg, { token: 'phone' }, true).ok).toBe(false)
    const by = { token: 'phone' }
    expect(await refusal(revokeDeviceAs('gate-mac', { by }))).toMatchObject({ status: 403 })
    expect(await refusal(rotateDevice('gate-mac', { by }))).toMatchObject({ status: 403 })
    expect(await refusal(revokeDeviceAs('phone-b', { by }))).toMatchObject({ status: 403 })
    expect(await refusal(apiKeyMaker(by))).toMatchObject({ status: 403, code: 'api_keys_refused' })
    expect((await mintMachineCredential('bridge-local', { by: { token: 'mac' } })).name).toBe('bridge-local')
    expect(await ownerName()).toBe('gate-mac via mint')
  })

  it('a phone holding machine credentials (a hand edited file) has no owner\'s rights either', () => {
    const phone: DeviceRecord = { name: 'my-phone', id: 'd-phone', tokenHash: sha('phone'), createdAt: created, platform: 'ios' }
    const cred: DeviceRecord = { name: 'bridge-local', id: 'd-l', tokenHash: sha('l'), createdAt: created, kind: 'machine', ownerId: 'd-phone' }
    const reg: DeviceRegistry = { devices: [phone, cred], owner: null }
    expect(hasOwnerRights(reg, phone, true)).toBe(false)
    expect(hasOwnerRights(reg, phone, false)).toBe(false)
    expect(companionOwnerRecord(reg)).toBeUndefined()
    expect(apiKeyDecision(reg, { token: 'phone' }, true).ok).toBe(false)
  })

  it('a phone\'s first report ends its being the owner, on disk; a Mac\'s report changes nothing', async () => {
    await fresh()
    const { token } = await createDevice('handheld', { owner: true })
    expect(await ownerName()).toBe('handheld via operator')
    await setDeviceInfo({ token }, IPHONE)
    expect((await onDisk()).owner).toBeUndefined()
    expect((await onDisk()).devices[0].platform).toBe('ios')
    await fresh()
    const mac = await createDevice('desk-mac', { owner: true })
    await setDeviceInfo({ token: mac.token }, AMAC)
    expect(await ownerName()).toBe('desk-mac via operator')
  })

  it('the operator cannot name a phone', async () => {
    await writeAuth({ ...PHONE_OWNED, owner: null })
    expect(await refusal(setCompanionOwner('my-phone'))).toMatchObject({ message: 'my-phone is a phone; the owner is the Mac this cloud companion belongs to.' })
  })
})

describe('only a mint records an owner by the first come rule', () => {
  const tk = { mac: 'a'.repeat(32), laptop: 'b'.repeat(32), phone: 'c'.repeat(32), devbox: 'd'.repeat(32) }
  const LEGACY = {
    devices: [
      { name: 'gate-mac', tokenHash: sha(tk.mac), createdAt: created, info: AMAC },
      { name: 'ops-laptop', tokenHash: sha(tk.laptop), createdAt: created },
      { name: 'phone-a', tokenHash: sha(tk.phone), createdAt: created, info: IPHONE },
      { name: 'bridge-devbox', tokenHash: sha(tk.devbox), createdAt: created, kind: 'machine' },
    ],
  }

  it('removing an unowned credential records nobody; the Mac\'s mint after it is first come', async () => {
    await writeAuth(LEGACY)
    expect(await revokeMachineCredential('bridge-devbox', { by: { token: tk.laptop } })).toBe(true)
    expect((await onDisk()).owner).toBeUndefined()
    expect((await mintMachineCredential('bridge-local', { by: { token: tk.mac } })).name).toBe('bridge-local')
    expect(await ownerName()).toBe('gate-mac via mint')
    expect(await refusal(revokeDeviceAs('phone-a', { by: { token: tk.laptop } }))).toMatchObject({ status: 403 })
    expect(await refusal(revokeDeviceAs('gate-mac', { by: { token: tk.laptop } }))).toMatchObject({ status: 403 })
  })

  it('the decision: a mint or a replace records, a revoke or an adopt does not', () => {
    const mac: DeviceRecord = { name: 'mac', id: 'd-mac', tokenHash: sha('mac'), createdAt: created, platform: 'other' }
    const own: DeviceRecord = { name: 'bridge-own', id: 'd-own', tokenHash: sha('own'), createdAt: created, kind: 'machine', ownerId: 'd-mac' }
    const loose: DeviceRecord = { name: 'bridge-loose', id: 'd-loose', tokenHash: sha('loose'), createdAt: created, kind: 'machine' }
    const owning: DeviceRegistry = { devices: [mac, own, loose], owner: null }
    const nothing: DeviceRegistry = { devices: [mac, loose], owner: null }
    for (const reg of [owning, nothing]) {
      for (const action of ['mint', 'replace'] as const) {
        expect(machineCredentialDecision(reg, { by: { token: 'mac' }, name: 'bridge-new', action })).toMatchObject({ ok: true, record: { id: 'd-mac', via: 'mint' } })
      }
      expect(machineCredentialDecision(reg, { by: { token: 'mac' }, name: 'bridge-loose', action: 'revoke' })).toMatchObject({ ok: true, record: null })
    }
    expect(machineCredentialDecision(owning, { by: { token: 'mac' }, name: 'bridge-loose', action: 'adopt' })).toMatchObject({ ok: true, record: null })
  })
})

describe('the operator naming the owner it already named writes nothing', () => {
  beforeEach(fresh)

  async function noWrite(run: () => Promise<unknown>): Promise<void> {
    const before = await fs.readFile(file(), 'utf-8')
    await fs.rm(`${file()}.bak`, { force: true })
    const m0 = (await fs.stat(file())).mtimeMs
    await new Promise((r) => setTimeout(r, 30))
    await run()
    expect(await fs.readFile(file(), 'utf-8')).toBe(before)
    expect((await fs.stat(file())).mtimeMs).toBe(m0)
    await expect(fs.stat(`${file()}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
  }

  it('`walnut device owner` on the owner: no bytes, no mtime, no .bak; it says nothing changed', async () => {
    const { token } = await createDevice('gate-mac', { owner: true })
    await noWrite(async () => expect(await setCompanionOwner('gate-mac')).toEqual({ removedCredentials: [], changed: false }))
    // Also with its own machine credentials there.
    await mintMachineCredential('bridge-local', { by: { token } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await noWrite(() => runDeviceOwner('gate-mac', {} as never))
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/already belongs to "gate-mac"\. Nothing changed\./)
    } finally { log.mockRestore() }
  })

  it('an owner recorded another way (its first mint) becomes the operator\'s: that is a write, and nothing else changes', async () => {
    const { token } = await createDevice('gate-mac')
    await mintMachineCredential('bridge-local', { by: { token } })
    expect(await ownerName()).toBe('gate-mac via mint')
    expect(await setCompanionOwner('gate-mac')).toEqual({ removedCredentials: [], changed: true })
    expect(await ownerName()).toBe('gate-mac via operator')
    expect((await onDisk()).devices.map((d) => d.name)).toEqual(['gate-mac', 'bridge-local'])
    await noWrite(async () => expect(await setCompanionOwner('gate-mac')).toEqual({ removedCredentials: [], changed: false }))
  })

  it('a credential that is not the owner\'s still goes, and that is a write', async () => {
    await createDevice('gate-mac', { owner: true })
    const disk = await onDisk()
    disk.devices.push({ name: 'bridge-old', tokenHash: sha('old'), createdAt: created, kind: 'machine' })
    await writeAuth(disk)
    expect(await setCompanionOwner('gate-mac')).toEqual({ removedCredentials: ['bridge-old'], changed: true })
    expect((await onDisk()).devices.map((d) => d.name)).toEqual(['gate-mac'])
  })
})

describe('what a refused computer hears is true about the owner', () => {
  beforeEach(fresh)

  it('an owner that said it is a Mac: another Mac; one that said another computer: another computer', async () => {
    for (const [report, sentence] of [[AMAC, OTHER_MAC_CONNECTED], [LINUX, OTHER_COMPUTER_CONNECTED]] as const) {
      await fresh()
      await claim('first-box', report)
      const second = await pair('gate-mac', AMAC)
      expect(await refusal(mintMachineCredential('bridge-local', { by: { token: second } }))).toEqual({ status: 409, code: 'other_mac_connected', message: sentence })
    }
  })

  it('the same with none recorded, when the device owning the credentials said another computer', async () => {
    await writeAuth({
      devices: [
        { name: 'linux-box', id: 'd-linux', tokenHash: sha('linux'), createdAt: created, platform: 'other', info: LINUX },
        { name: 'gate-mac', id: 'd-mac', tokenHash: sha('mac'), createdAt: created, platform: 'other', info: AMAC },
        { name: 'bridge-local', id: 'd-l', tokenHash: sha('l'), createdAt: created, kind: 'machine', ownerId: 'd-linux' },
      ],
    })
    expect(await refusal(mintMachineCredential('bridge-x', { by: { token: 'mac' } }))).toEqual({ status: 409, code: 'other_mac_connected', message: OTHER_COMPUTER_CONNECTED })
  })
})

describe('the gate\'s surviving mutants', () => {
  beforeEach(fresh)

  it('N02: when a file that does not parse cannot be set aside, nothing is written and it keeps its bytes', async () => {
    const BROKEN = '{"devices":[{"name":"mac","tokenHash":"' + 'a'.repeat(30)
    await writeAuth(BROKEN)
    const realRename = fs.rename
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('.unreadable-')) throw Object.assign(new Error('EPERM: refused by the test'), { code: 'EPERM' })
      return realRename(from, to)
    })
    try {
      await expect(createDevice('new-device')).rejects.toThrow(/does not parse and could not be set aside .*nothing was written/)
    } finally { spy.mockRestore() }
    expect(await fs.readFile(file(), 'utf-8')).toBe(BROKEN)
    expect((await fs.readdir(WALNUT_HOME)).filter((f) => f.includes('.unreadable-') || f.startsWith('auth.json.tmp'))).toEqual([])
  })

  it('N08: a box holding only machine credentials is claimed (no setup token, no banner, no claim)', async () => {
    await writeAuth({ devices: [{ name: 'bridge-local', tokenHash: sha('l'), createdAt: created, kind: 'machine' }] })
    expect(await isClaimed()).toBe(true)
    expect(await getSetupTokenIfUnclaimed()).toBeNull()
  })

  it('N10: the unowned bridge-local\'s token records nobody while another device owns machine credentials', async () => {
    const x: DeviceRecord = { name: 'mac-x', id: 'd-x', tokenHash: sha('x'), createdAt: created, platform: 'other' }
    const y: DeviceRecord = { name: 'mac-y', id: 'd-y', tokenHash: sha('y'), createdAt: created, platform: 'other' }
    const local: DeviceRecord = { name: 'bridge-local', id: 'd-l', tokenHash: sha('local-token'), createdAt: created, kind: 'machine' }
    const devbox: DeviceRecord = { name: 'bridge-devbox', id: 'd-db', tokenHash: sha('devbox'), createdAt: created, kind: 'machine', ownerId: 'd-x' }
    expect(proofClaim({ devices: [x, y, local, devbox], owner: null }, y, 'local-token')).toBeNull()
    // The control: without x's credential the same token proves y.
    expect(proofClaim({ devices: [x, y, local], owner: null }, y, 'local-token')).toEqual({ id: 'd-y', via: 'proof' })
    // On a device route (the proof rides a removal): y gains nothing and nobody is recorded.
    await writeAuth({ devices: [x, y, local, devbox] })
    expect(await refusal(revokeDeviceAs('mac-x', { by: { token: 'y' }, proof: 'local-token' }))).toMatchObject({ status: 403 })
    expect((await onDisk()).owner).toBeUndefined()
  })
})
