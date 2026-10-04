/**
 * The device routes on a companion (CLOUD_MODE), through the real server and
 * auth middleware, one request per way a device might take the companion
 * over (the 2026-09-29 gate's access cases), plus every legitimate flow the
 * rules must keep working.
 *
 *   takeover by rotation   a phone POSTs { name: 'mac-primary', replace: true }
 *                          to get the Mac's pairing, then mints as it;
 *   takeover by removal    a phone DELETEs the Mac's pairing, clears its own
 *                          self-report, and mints as "not a phone";
 *   borrowed proof         a second Mac presents another legacy credential's
 *                          token (bridge-devbox) as proof;
 *   legacy re-mint         the first Mac adopts, revokes and mints again: the
 *                          same (unkeyed) daemon.
 *
 * Who calls these routes for real: the web console (GET/POST/DELETE
 * /api/devices, on the Mac, relayed here with the Mac's own device token),
 * the Mac server itself (machine credential mint, DELETE and adopt), and the
 * iOS app (only POST /api/v1/devices/self).
 *
 * auth.json is written fresh for each case (tokens known to the test, ids
 * fabricated); nothing is copied, no pid anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-device-access-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { MACHINE_PROOF_HEADER, OTHER_MAC_CONNECTED } from '../../../src/core/machine-credentials.js'

let server: HttpServer
let port = 0

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const ID = { mac: 'd00000000000000a1', second: 'd00000000000000b2', phone: 'd00000000000000c3' }
let T: { mac: string; second: string; phone: string; local: string; devbox: string }

/** A companion as a current build leaves it; `owned` = the Mac owns the machine credentials. */
async function seed(owned: boolean, phone: Record<string, unknown> = { platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } }): Promise<void> {
  T = { mac: tok(), second: tok(), phone: tok(), local: tok(), devbox: tok() }
  const now = new Date().toISOString()
  const ownership = owned ? { ownerId: ID.mac, daemonKey: ID.mac } : {}
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', id: ID.mac, tokenHash: sha(T.mac), createdAt: now, ...(owned ? { tunnelDaemon: { key: ID.mac } } : {}) },
    { name: 'mac-second', id: ID.second, tokenHash: sha(T.second), createdAt: now },
    { name: 'my-phone', id: ID.phone, tokenHash: sha(T.phone), createdAt: now, ...phone },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine', ...ownership },
    { name: 'bridge-devbox', id: 'd00000000000000e5', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine', ...ownership },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

async function call(method: string, p: string, bearer: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

const devices = async () => (JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>> }).devices
const find = async (name: string) => (await devices()).find((d) => d.name === name)
const names = async () => (await devices()).map((d) => String(d.name)).sort()

const REFUSED = (name: string) => `Only ${name} itself or the Mac this companion serves can remove or re-pair ${name}. On the companion, \`walnut device revoke ${name}\` works too.`

beforeAll(async () => {
  await seed(true)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a companion whose machine credentials the Mac owns', () => {
  beforeEach(() => seed(true))

  it('TAKEOVER by rotation: a phone re-pairing the Mac\'s name is refused; the Mac\'s token and ownership stay', async () => {
    const before = await devices()
    const r = await call('POST', '/api/devices', T.phone, { name: 'mac-primary', replace: true })
    expect(r).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
    expect(await devices()).toEqual(before.map((d) => (d.name === 'my-phone' ? { ...d, lastUsedAt: expect.any(String) } : d)))
    expect((await call('GET', '/api/devices', T.mac)).status).toBe(200)
    // Nor through a plain re-pair of the machine credential, nor as a kind:'machine' replace.
    for (const body of [{ name: 'bridge-local', replace: true }, { name: 'bridge-local', kind: 'machine', replace: true }]) {
      expect((await call('POST', '/api/devices', T.phone, body)).body.code).toBe('phone_cannot_mint')
    }
  })

  it('TAKEOVER by rotation: another Mac re-pairing or removing the first Mac is refused too', async () => {
    expect(await call('POST', '/api/devices', T.second, { name: 'mac-primary', replace: true })).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
    expect(await call('DELETE', '/api/devices/mac-primary', T.second)).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
    expect(await call('DELETE', '/api/devices/my-phone', T.second)).toEqual({ status: 403, body: { error: REFUSED('my-phone'), code: 'device_change_refused' } })
    expect(await names()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'my-phone'])
  })

  it('TAKEOVER by removal: a phone may not remove the Mac, and clearing or faking its report leaves it a phone', async () => {
    expect(await call('DELETE', '/api/devices/mac-primary', T.phone)).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
    for (const report of [{}, { model: 'Mac15,3', os: 'macOS 26.0' }]) {
      expect((await call('POST', '/api/v1/devices/self', T.phone, report)).status).toBe(200)
      expect((await find('my-phone'))?.platform).toBe('ios')
      for (const [method, p, body] of [
        ['POST', '/api/devices', { name: 'bridge-phone', kind: 'machine' }],
        ['POST', '/api/devices', { name: 'bridge-local', kind: 'machine', replace: true }],
        ['DELETE', '/api/devices/bridge-local', undefined],
        ['POST', '/api/devices/bridge-local/adopt', undefined],
      ] as Array<[string, string, unknown]>) {
        const r = await call(method, p, T.phone, body)
        expect(r.status, `${method} ${p} after ${JSON.stringify(report)}`).toBe(403)
        expect(r.body.code).toBe('phone_cannot_mint')
      }
      // Nor may it pair a new device to launder itself.
      expect(await call('POST', '/api/devices', T.phone, { name: 'laundered' })).toEqual({ status: 403, body: { error: expect.stringMatching(/^A phone cannot pair other devices/), code: 'phone_cannot_pair' } })
    }
    expect(await names()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'my-phone'])
  })

  it('a second Mac is refused every machine credential act (409, the host card sentence)', async () => {
    for (const [method, p, body, headers] of [
      ['POST', '/api/devices', { name: 'bridge-mac2', kind: 'machine' }, {}],
      ['POST', '/api/devices', { name: 'bridge-local', kind: 'machine', replace: true }, {}],
      ['POST', '/api/devices', { name: 'bridge-local', replace: true }, {}],
      ['DELETE', '/api/devices/bridge-local', undefined, {}],
      ['POST', '/api/devices/bridge-local/adopt', undefined, { [MACHINE_PROOF_HEADER]: T.local }],
    ] as Array<[string, string, unknown, Record<string, string>]>) {
      expect(await call(method, p, T.second, body, headers), `${method} ${p}`).toEqual({ status: 409, body: { error: OTHER_MAC_CONNECTED, code: 'other_mac_connected' } })
    }
  })

  it('a rotation of a name inherits nothing: the Mac re-pairs the other Mac, whose new token still owns nothing', async () => {
    const r = await call('POST', '/api/devices', T.mac, { name: 'mac-second', replace: true })
    expect(r.status).toBe(201)
    const repaired = (await find('mac-second'))!
    expect(repaired.id).not.toBe(ID.second)
    expect(await call('POST', '/api/devices', String(r.body.token), { name: 'bridge-local', kind: 'machine', replace: true })).toMatchObject({ status: 409 })
  })

  it('self-rotate: the Mac re-pairs itself and is still the owner (same id, same daemon)', async () => {
    const r = await call('POST', '/api/devices', T.mac, { name: 'mac-primary', replace: true })
    expect(r.status).toBe(201)
    expect(await find('mac-primary')).toMatchObject({ id: ID.mac, tunnelDaemon: { key: ID.mac } })
    expect((await call('GET', '/api/devices', T.mac)).status).toBe(401)
    const minted = await call('POST', '/api/devices', String(r.body.token), { name: 'bridge-local', kind: 'machine', replace: true })
    expect(minted.status).toBe(201)
    expect(await find('bridge-local')).toMatchObject({ ownerId: ID.mac, daemonKey: ID.mac })
  })

  it('the Mac removes a lost phone, and re-pairs one (the console\'s cloud revoke and "Show new QR")', async () => {
    const qr = await call('POST', '/api/devices', T.mac, { name: 'my-phone', replace: true })
    expect(qr.status).toBe(201)
    expect(qr.body.pairingURI).toMatch(/^wn:\/\/pair\?name=my-phone&token=/)
    expect((await find('my-phone'))?.id).not.toBe(ID.phone)
    expect(await call('DELETE', '/api/devices/my-phone', T.mac)).toMatchObject({ status: 200, body: { ok: true } })
    expect(await find('my-phone')).toBeUndefined()
    expect(await names()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second'])
  })

  it('a phone unpairs itself, and rotates its own token', async () => {
    const r = await call('POST', '/api/devices', T.phone, { name: 'my-phone', replace: true })
    expect(r.status).toBe(201)
    expect(await find('my-phone')).toMatchObject({ id: ID.phone, platform: 'ios' })
    expect(await call('DELETE', '/api/devices/my-phone', String(r.body.token))).toMatchObject({ status: 200 })
    expect(await find('my-phone')).toBeUndefined()
  })

  it('the Mac unpairs itself: its machine credentials go with it, and the other Mac may mint', async () => {
    expect(await call('DELETE', '/api/devices/mac-primary', T.mac)).toMatchObject({ status: 200 })
    expect(await names()).toEqual(['mac-second', 'my-phone'])
    const minted = await call('POST', '/api/devices', T.second, { name: 'bridge-local', kind: 'machine' })
    expect(minted.status).toBe(201)
    expect(await find('bridge-local')).toMatchObject({ ownerId: ID.second, daemonKey: ID.second })
  })
})

describe('a companion from before ownership was recorded (legacy credentials)', () => {
  beforeEach(() => seed(false))

  it('borrowed proof: another legacy credential\'s token is no proof for a second Mac', async () => {
    for (const [method, p, body] of [
      ['POST', '/api/devices', { name: 'bridge-gate', kind: 'machine' }],
      ['POST', '/api/devices', { name: 'bridge-local', kind: 'machine', replace: true }],
      ['DELETE', '/api/devices/bridge-local', undefined],
      ['POST', '/api/devices/bridge-local/adopt', undefined],
    ] as Array<[string, string, unknown]>) {
      expect(await call(method, p, T.second, body, { [MACHINE_PROOF_HEADER]: T.devbox }), `${method} ${p}`).toEqual({ status: 409, body: { error: OTHER_MAC_CONNECTED, code: 'other_mac_connected' } })
    }
    expect((await devices()).filter((d) => d.kind === 'machine').map((d) => d.ownerId)).toEqual([undefined, undefined])
  })

  it('TAKEOVER by removal on a legacy companion: refused, and the phone still cannot mint', async () => {
    expect((await call('DELETE', '/api/devices/mac-primary', T.phone)).status).toBe(403)
    expect((await call('POST', '/api/v1/devices/self', T.phone, {})).status).toBe(200)
    const mint = await call('POST', '/api/devices', T.phone, { name: 'bridge-local', kind: 'machine', replace: true }, { [MACHINE_PROOF_HEADER]: T.local })
    expect(mint).toMatchObject({ status: 403, body: { code: 'phone_cannot_mint' } })
  })

  it('the first Mac adopts with bridge-local\'s own token; a revoke and a new mint stay on the legacy daemon', async () => {
    expect(await call('POST', '/api/devices/bridge-local/adopt', T.mac, undefined, { [MACHINE_PROOF_HEADER]: T.local })).toEqual({ status: 200, body: { ok: true, outcome: 'adopted' } })
    expect(await find('mac-primary')).toMatchObject({ tunnelDaemon: {} })
    expect(await call('DELETE', '/api/devices/bridge-local', T.mac)).toMatchObject({ status: 200 })
    const minted = await call('POST', '/api/devices', T.mac, { name: 'bridge-local', kind: 'machine' })
    expect(minted.status).toBe(201)
    const cred = (await find('bridge-local'))!
    expect(cred.ownerId).toBe(ID.mac)
    expect(cred.daemonKey).toBeUndefined()
  })
})

describe('a phone recorded before platforms were', () => {
  // Its self-report says iPhone and nothing else says what it is: the first write records it.
  beforeEach(() => seed(true, { info: { model: 'iPhone17,1', os: 'iOS 26.1' } }))

  it('clearing its report first still leaves it a phone', async () => {
    expect((await call('POST', '/api/v1/devices/self', T.phone, {})).status).toBe(200)
    expect((await find('my-phone'))?.platform).toBe('ios')
    expect((await call('POST', '/api/devices', T.phone, { name: 'bridge-phone', kind: 'machine' })).body.code).toBe('phone_cannot_mint')
  })
})
