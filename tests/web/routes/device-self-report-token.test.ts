/**
 * A device's self-report (POST /api/v1/devices/self) is bound to the record its
 * bearer token matched, never to whichever record holds the name now.
 *
 * Core: setDeviceInfo({ token }) after the name was re-paired to a new record.
 * Route: the companion's POST /api/v1/devices/self (CLOUD_MODE), with the race
 * the token binding is for forced deterministically: the auth middleware has
 * already matched record X when the name is re-paired to Y, and only then does
 * the write run. A route that passed the NAME instead of the token would land
 * the report on Y; these tests fail it.
 *
 * Also here, because it reads the same records: the companion's device list
 * names its Macs as Macs (its owner, or a record that reported itself as a
 * Mac), so no console offers them a phone QR.
 * auth.json is written fresh per test; nothing is copied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-device-self-report-token', { CLOUD_MODE: true }))

// The race window: runs after the middleware matched the token, before the write.
const race = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }))
vi.mock('../../../src/core/device-auth.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/device-auth.js')>()
  return {
    ...real,
    setDeviceInfo: async (...args: Parameters<typeof real.setDeviceInfo>) => {
      const hook = race.before
      race.before = null
      if (hook) await hook()
      return real.setDeviceInfo(...args)
    },
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting, rotateDevice, setDeviceInfo } from '../../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../../src/core/device-actor.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const IPHONE = { model: 'iPhone17,1', os: 'iOS 26.1', deviceName: 'Field Phone' }
const MAC = { model: 'Mac15,3', os: 'macOS 26.0', deviceName: 'Desk' }

let T: { owner: string; x: string; other: string }
type Rec = Record<string, unknown> & { name: string; id?: string; tokenHash?: string; platform?: string; info?: Record<string, unknown> }
const records = async () => (JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Rec[] }).devices
const named = async (n: string) => (await records()).filter((d) => d.name === n)

async function seed(extra: Rec[] = []): Promise<void> {
  T = { owner: tok(), x: tok(), other: tok() }
  const now = new Date().toISOString()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'owner-mac', id: 'dg000000000000a01', tokenHash: sha(T.owner), createdAt: now },
    { name: 'field-phone', id: 'dg000000000000b02', tokenHash: sha(T.x), createdAt: now },
    { name: 'spare-tablet', id: 'dg000000000000c03', tokenHash: sha(T.other), createdAt: now },
    { name: 'bridge-local', id: 'dg000000000000d04', tokenHash: sha(tok()), createdAt: now, kind: 'machine', ownerId: 'dg000000000000a01' },
    ...extra,
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

let server: HttpServer
let port = 0
let ip = 0
async function report(bearer: string, body: unknown): Promise<number> {
  ip++
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/devices/self`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'x-forwarded-for': `10.91.0.${ip}` },
    body: JSON.stringify(body),
  })
  await r.text()
  return r.status
}

// A server under test sweeps the hosts in ~/.ssh/config over ssh: never the real ones.
let sshIsolation: SshIsolation | null = null

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await seed()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)
afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  sshIsolation?.restore()
})
beforeEach(async () => { race.before = null; await seed() })

describe('setDeviceInfo by token (core)', () => {
  it('a report with X\'s token lands on X; after the name is re-paired to Y it lands nowhere, and Y is untouched', async () => {
    expect(await setDeviceInfo({ token: T.x }, IPHONE)).toBe(true)
    const x = (await named('field-phone'))[0]
    expect(x).toMatchObject({ id: 'dg000000000000b02', platform: 'ios', info: expect.objectContaining({ model: 'iPhone17,1' }) })
    // Re-paired by someone other than the device (here the box's own CLI): a new record Y.
    const y = await rotateDevice('field-phone', { by: LOCAL_ACTOR })
    const [yRec] = await named('field-phone')
    expect(yRec.id).not.toBe('dg000000000000b02')
    expect(yRec.platform).toBeUndefined()
    expect(await setDeviceInfo({ token: T.x }, MAC)).toBe(false)
    const [after] = await named('field-phone')
    expect(after.platform).toBeUndefined()
    expect(after.info).toBeUndefined()
    // Y's own token reports for Y.
    expect(await setDeviceInfo({ token: y.token }, IPHONE)).toBe(true)
    expect((await named('field-phone'))[0]).toMatchObject({ platform: 'ios' })
  })

  it('two records that share a name (as an older auth.json can hold): each token lands on its own record', async () => {
    const tY = tok()
    await seed([{ name: 'field-phone', id: 'dg000000000000e05', tokenHash: '', createdAt: new Date().toISOString() }])
    const raw = await records()
    raw[raw.length - 1].tokenHash = sha(tY)
    await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: raw }), { mode: 0o600 })
    _resetDeviceAuthForTesting()
    expect(await setDeviceInfo({ token: tY }, MAC)).toBe(true)
    const [x, y] = await named('field-phone')
    expect(x.id).toBe('dg000000000000b02')
    expect(x.info).toBeUndefined()
    expect(x.platform).toBeUndefined()
    expect(y).toMatchObject({ id: 'dg000000000000e05', platform: 'other' })
    expect(await setDeviceInfo({ token: T.x }, IPHONE)).toBe(true)
    const [x2, y2] = await named('field-phone')
    expect(x2).toMatchObject({ platform: 'ios' })
    expect(y2).toMatchObject({ platform: 'other', info: expect.objectContaining({ model: 'Mac15,3' }) })
  })

  it('an unknown token lands nowhere', async () => {
    const before = JSON.stringify(await records())
    expect(await setDeviceInfo({ token: tok() }, IPHONE)).toBe(false)
    expect(JSON.stringify(await records())).toBe(before)
  })
})

describe('POST /api/v1/devices/self on a companion (route, real middleware)', () => {
  it('a report authenticated as X, with the name re-paired to Y before the write, never lands on Y (404)', async () => {
    let yToken = ''
    race.before = async () => { yToken = (await rotateDevice('field-phone', { by: LOCAL_ACTOR })).token }
    expect(await report(T.x, MAC)).toBe(404)
    expect(yToken).not.toBe('')
    const [y] = await named('field-phone')
    expect(y.id).not.toBe('dg000000000000b02')
    expect(y.platform).toBeUndefined()
    expect(y.info).toBeUndefined()
    // Y itself reports and lands on Y, as an iPhone.
    expect(await report(yToken, IPHONE)).toBe(200)
    expect((await named('field-phone'))[0]).toMatchObject({ platform: 'ios', info: expect.objectContaining({ deviceName: 'Field Phone' }) })
  })

  it('without the race, X\'s report lands on X and never on another record, whatever name the body carries', async () => {
    expect(await report(T.x, { ...IPHONE, deviceName: 'spare-tablet', name: 'spare-tablet' })).toBe(200)
    expect((await named('field-phone'))[0]).toMatchObject({ platform: 'ios' })
    const [other] = await named('spare-tablet')
    expect(other.platform).toBeUndefined()
    expect(other.info).toBeUndefined()
  })
})

describe('GET /api/devices on a companion: Macs are listed as Macs', () => {
  it('the owner and a Mac that reported itself are role mac; a phone stays a phone', async () => {
    expect(await report(T.other, { model: 'Mac', os: 'macOS', appVersion: '0.5.1' })).toBe(200)
    expect(await report(T.x, IPHONE)).toBe(200)
    const r = await fetch(`http://127.0.0.1:${port}/api/devices`, {
      headers: { authorization: `Bearer ${T.owner}`, 'x-forwarded-for': `10.91.1.${++ip}` },
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { devices: Array<{ name: string; role: string }> }
    const roles = Object.fromEntries(body.devices.map((d) => [d.name, d.role]))
    expect(roles).toMatchObject({ 'owner-mac': 'mac', 'spare-tablet': 'mac', 'field-phone': 'phone' })
    // Display only: the Mac that reported itself is not a phone, and still not an owner.
    const [tablet] = await named('spare-tablet')
    expect(tablet.platform).toBe('other')
  })
})
