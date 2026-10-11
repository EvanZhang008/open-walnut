/**
 * The device routes on a companion (CLOUD_MODE), through the real server and
 * auth middleware, one request per way a device might take the companion
 * over (the 2026-09-29 and 2026-10-03 gates' cases), plus every legitimate
 * flow the rules must keep working.
 *
 *   takeover by rotation   a phone POSTs { name: 'mac-primary', replace: true }
 *                          to get the Mac's pairing, then acts as it;
 *   takeover by removal    a phone DELETEs the Mac's pairing, clears its own
 *                          self-report, and asks as "not a phone";
 *   first come             on a companion with no owner recorded and no machine
 *                          credential yet, a tablet or a second Mac mints one
 *                          first (the rule of the builds before owners were
 *                          recorded: it stands, and is recorded when it happens);
 *   borrowed proof         a second Mac presents another legacy credential's
 *                          token (bridge-devbox) as proof;
 *   the upgrade            a companion whose auth.json a build without owners
 *                          wrote, asked by that same Mac's older build (no
 *                          proof at all): its console relay, a new host, a
 *                          lost token cache, answered as that build did (no
 *                          owner is guessed from which record is oldest).
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
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-device-access-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { MACHINE_PROOF_HEADER, OTHER_MAC_CONNECTED } from '../../../src/core/machine-credentials.js'

let server: HttpServer
let port = 0

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const ID = { mac: 'd00000000000000a1', second: 'd00000000000000b2', phone: 'd00000000000000c3', tablet: 'd00000000000000f6' }
let T: { mac: string; second: string; phone: string; tablet: string; local: string; devbox: string }
const AMAC = { model: 'Mac15,3', os: 'macOS 26.0' }

type Scenario = 'owned' | 'legacy' | 'fresh'
/**
 * owned: the file main writes, the Mac's machine credentials recorded as its, no owner key;
 * legacy: as a build without ids wrote it (no ids, platforms or owner);
 * fresh: the file main writes with no machine credential yet (bridge off).
 */
async function seed(scenario: Scenario, phone: Record<string, unknown> = { platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } }): Promise<void> {
  T = { mac: tok(), second: tok(), phone: tok(), tablet: tok(), local: tok(), devbox: tok() }
  const now = new Date().toISOString()
  const legacy = scenario === 'legacy'
  const id = (v: string) => (legacy ? {} : { id: v })
  const devices: Array<Record<string, unknown>> = [
    { name: 'mac-primary', ...id(ID.mac), tokenHash: sha(T.mac), createdAt: now, ...(legacy ? { info: AMAC } : { platform: 'other', info: AMAC }) },
    { name: 'mac-second', ...id(ID.second), tokenHash: sha(T.second), createdAt: now, ...(legacy ? { info: AMAC } : { platform: 'other', info: AMAC }) },
    { name: 'my-phone', ...id(ID.phone), tokenHash: sha(T.phone), createdAt: now, ...(legacy ? { info: { model: 'iPhone17,1', os: 'iOS 26.1' } } : phone) },
    { name: 'tablet-new', ...id(ID.tablet), tokenHash: sha(T.tablet), createdAt: now },
  ]
  if (scenario !== 'fresh') {
    const ownership = scenario === 'owned' ? { ownerId: ID.mac } : {}
    devices.push(
      { name: 'bridge-local', ...id('d00000000000000d4'), tokenHash: sha(T.local), createdAt: now, kind: 'machine', ...ownership },
      { name: 'bridge-devbox', ...id('d00000000000000e5'), tokenHash: sha(T.devbox), createdAt: now, kind: 'machine', ...ownership },
    )
  }
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices }), { mode: 0o600 })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  _resetDeviceAuthForTesting()
}

let ip = 0
async function call(method: string, p: string, bearer: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    // The companion's own proxy adds X-Forwarded-For to every public request.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'x-forwarded-for': `203.0.113.${(++ip % 250) + 1}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

const file = async () => JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>>; owner?: { id: string; via: string } | null }
const devices = async () => (await file()).devices
const find = async (name: string) => (await devices()).find((d) => d.name === name)
const names = async () => (await devices()).map((d) => String(d.name)).sort()

const REFUSED = (name: string) => `Only ${name} itself or the Mac this cloud companion belongs to can remove or re-pair ${name}.`
const OWNER_ONLY = 'Only the Mac this cloud companion belongs to can connect computers to it.'

// A server under test sweeps the hosts in ~/.ssh/config over ssh: never the real ones.
let sshIsolation: SshIsolation | null = null

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await seed('owned')
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

describe('a companion the Mac owns', () => {
  beforeEach(() => seed('owned'))

  it('TAKEOVER by rotation: a phone re-pairing the Mac\'s name is refused; the Mac\'s token and ownership stay', async () => {
    const before = await devices()
    const r = await call('POST', '/api/devices', T.phone, { name: 'mac-primary', replace: true })
    expect(r).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
    const after = await devices()
    expect(after.map((d) => [d.name, d.tokenHash, d.ownerId])).toEqual(before.map((d) => [d.name, d.tokenHash, d.ownerId]))
    expect((await call('GET', '/api/devices', T.mac)).status).toBe(200)
    // Nor through a plain re-pair of the machine credential, nor as a kind:'machine' replace.
    for (const body of [{ name: 'bridge-local', replace: true }, { name: 'bridge-local', kind: 'machine', replace: true }]) {
      expect(await call('POST', '/api/devices', T.phone, body)).toEqual({ status: 403, body: { error: OWNER_ONLY, code: 'phone_cannot_mint' } })
    }
  })

  it('TAKEOVER by rotation: another Mac or a tablet re-pairing or removing the first Mac is refused too', async () => {
    for (const t of [T.second, T.tablet]) {
      expect(await call('POST', '/api/devices', t, { name: 'mac-primary', replace: true })).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
      expect(await call('DELETE', '/api/devices/mac-primary', t)).toEqual({ status: 403, body: { error: REFUSED('mac-primary'), code: 'device_change_refused' } })
      expect(await call('DELETE', '/api/devices/my-phone', t)).toEqual({ status: 403, body: { error: REFUSED('my-phone'), code: 'device_change_refused' } })
    }
    expect(await names()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'my-phone', 'tablet-new'])
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
      expect(await call('POST', '/api/devices', T.phone, { name: 'laundered' })).toEqual({ status: 403, body: { error: 'Pair new devices from the Mac, in Settings › Phones & Cloud, not from a phone.', code: 'phone_cannot_pair' } })
    }
    expect(await names()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'my-phone', 'tablet-new'])
  })

  it('the list names the record the caller\'s token matched (the Mac finds its own row by it)', async () => {
    expect((await call('GET', '/api/devices', T.mac)).body.caller).toBe('mac-primary')
    expect((await call('GET', '/api/devices', T.second)).body.caller).toBe('mac-second')
    expect((await call('GET', '/api/devices', T.phone)).body.caller).toBe('my-phone')
  })

  it('a self-report from a token that no longer matches is refused before it can land anywhere', async () => {
    const old = T.phone
    expect((await call('POST', '/api/devices', T.mac, { name: 'my-phone', replace: true })).status).toBe(201)
    expect((await call('POST', '/api/v1/devices/self', old, { model: 'Mac15,3', os: 'macOS 26.0' })).status).toBe(401)
    expect(await find('my-phone')).not.toHaveProperty('platform')
  })

  it('a second Mac is refused every machine credential act (409, the host card sentence); a tablet hears the plain rule', async () => {
    for (const [method, p, body, headers] of [
      ['POST', '/api/devices', { name: 'bridge-mac2', kind: 'machine' }, {}],
      ['POST', '/api/devices', { name: 'bridge-local', kind: 'machine', replace: true }, {}],
      ['POST', '/api/devices', { name: 'bridge-local', replace: true }, {}],
      ['DELETE', '/api/devices/bridge-local', undefined, {}],
      ['POST', '/api/devices/bridge-local/adopt', undefined, { [MACHINE_PROOF_HEADER]: T.local }],
    ] as Array<[string, string, unknown, Record<string, string>]>) {
      expect(await call(method, p, T.second, body, headers), `${method} ${p}`).toEqual({ status: 409, body: { error: OTHER_MAC_CONNECTED, code: 'other_mac_connected' } })
      // No owner recorded yet (main's file): the tablet hears what main said, another Mac.
      expect(await call(method, p, T.tablet, body, headers), `${method} ${p}`).toEqual({ status: 409, body: { error: OTHER_MAC_CONNECTED, code: 'other_mac_connected' } })
    }
    // The Mac's next act on its credentials records it as the owner; from then on a tablet hears the plain rule.
    expect((await call('POST', '/api/devices', T.mac, { name: 'bridge-local', kind: 'machine', replace: true })).status).toBe(201)
    expect((await file()).owner).toEqual({ id: ID.mac, via: 'mint' })
    expect(await call('POST', '/api/devices', T.tablet, { name: 'bridge-mac2', kind: 'machine' })).toEqual({ status: 409, body: { error: OWNER_ONLY, code: 'not_companion_owner' } })
    expect(await call('POST', '/api/devices', T.second, { name: 'bridge-mac2', kind: 'machine' })).toEqual({ status: 409, body: { error: OTHER_MAC_CONNECTED, code: 'other_mac_connected' } })
  })

  it('a rotation of a name inherits nothing: the Mac re-pairs the other Mac, whose new token still owns nothing', async () => {
    const r = await call('POST', '/api/devices', T.mac, { name: 'mac-second', replace: true })
    expect(r.status).toBe(201)
    expect((await find('mac-second'))!.id).not.toBe(ID.second)
    expect(await call('POST', '/api/devices', String(r.body.token), { name: 'bridge-local', kind: 'machine', replace: true })).toMatchObject({ status: 409 })
  })

  it('self-rotate: the Mac re-pairs itself and is still the owner (same id, its credentials kept)', async () => {
    const r = await call('POST', '/api/devices', T.mac, { name: 'mac-primary', replace: true })
    expect(r.status).toBe(201)
    expect(await find('mac-primary')).toMatchObject({ id: ID.mac })
    expect(await find('bridge-local')).toMatchObject({ ownerId: ID.mac })
    expect((await call('GET', '/api/devices', T.mac)).status).toBe(401)
    const minted = await call('POST', '/api/devices', String(r.body.token), { name: 'bridge-local', kind: 'machine', replace: true })
    expect(minted.status).toBe(201)
    expect(await find('bridge-local')).toMatchObject({ ownerId: ID.mac })
  })

  it('the Mac removes a lost phone, and re-pairs one (the console\'s cloud revoke and "Show new QR")', async () => {
    const qr = await call('POST', '/api/devices', T.mac, { name: 'my-phone', replace: true })
    expect(qr.status).toBe(201)
    expect(qr.body.pairingURI).toMatch(/^wn:\/\/pair\?name=my-phone&token=/)
    expect((await find('my-phone'))?.id).not.toBe(ID.phone)
    expect(await call('DELETE', '/api/devices/my-phone', T.mac)).toMatchObject({ status: 200, body: { ok: true } })
    expect(await find('my-phone')).toBeUndefined()
    expect(await names()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'tablet-new'])
  })

  it('a phone unpairs itself, and rotates its own token', async () => {
    const r = await call('POST', '/api/devices', T.phone, { name: 'my-phone', replace: true })
    expect(r.status).toBe(201)
    expect(await find('my-phone')).toMatchObject({ id: ID.phone, platform: 'ios' })
    expect(await call('DELETE', '/api/devices/my-phone', String(r.body.token))).toMatchObject({ status: 200 })
    expect(await find('my-phone')).toBeUndefined()
  })

  it('the Mac unpairs itself: every machine credential goes with it, nobody is guessed, and the next Mac to mint is recorded', async () => {
    expect(await call('DELETE', '/api/devices/mac-primary', T.mac)).toMatchObject({ status: 200 })
    expect(await names()).toEqual(['mac-second', 'my-phone', 'tablet-new'])
    expect((await file()).owner).toBeUndefined()
    expect(await call('DELETE', '/api/devices/my-phone', T.second)).toMatchObject({ status: 403 })
    expect((await call('POST', '/api/devices', T.second, { name: 'bridge-local', kind: 'machine' })).status).toBe(201)
    expect((await file()).owner).toEqual({ id: ID.second, via: 'mint' })
    expect(await call('DELETE', '/api/devices/my-phone', T.second)).toMatchObject({ status: 200 })
  })
})

describe('a companion with no machine credential yet (fresh, or the bridge switched off)', () => {
  beforeEach(() => seed('fresh'))

  // No owner recorded (main's file, from before a claim recorded one): main's first come rule,
  // written down when it happens. A claimed companion records its owner at the claim instead.
  it('first come, recorded: whoever mints first (not a phone) is the owner, and the others are refused from then on', async () => {
    expect(await call('POST', '/api/devices', T.phone, { name: 'bridge-local', kind: 'machine' })).toMatchObject({ status: 403 })
    expect((await file()).owner).toBeUndefined()
    expect((await call('POST', '/api/devices', T.mac, { name: 'bridge-local', kind: 'machine' })).status).toBe(201)
    expect((await file()).owner).toEqual({ id: ID.mac, via: 'mint' })
    expect(await call('POST', '/api/devices', T.tablet, { name: 'bridge-x', kind: 'machine' })).toEqual({ status: 409, body: { error: OWNER_ONLY, code: 'not_companion_owner' } })
    expect(await call('POST', '/api/devices', T.second, { name: 'bridge-x', kind: 'machine' })).toEqual({ status: 409, body: { error: OTHER_MAC_CONNECTED, code: 'other_mac_connected' } })
  })

  it('before any mint nobody has the owner\'s rights: the console relay may not re-pair or remove a phone (as before); after the Mac\'s first mint it may', async () => {
    expect(await call('POST', '/api/devices', T.mac, { name: 'my-phone', replace: true })).toEqual({ status: 403, body: { error: REFUSED('my-phone'), code: 'device_change_refused' } })
    expect(await call('DELETE', '/api/devices/my-phone', T.mac)).toEqual({ status: 403, body: { error: REFUSED('my-phone'), code: 'device_change_refused' } })
    expect((await call('POST', '/api/devices', T.mac, { name: 'bridge-local', kind: 'machine' })).status).toBe(201)
    expect((await call('POST', '/api/devices', T.mac, { name: 'my-phone', replace: true })).status).toBe(201)
    expect((await call('DELETE', '/api/devices/my-phone', T.mac)).status).toBe(200)
  })
})

describe('a companion from before owners were recorded, asked by the same Mac\'s older build (no proof)', () => {
  beforeEach(() => seed('legacy'))

  it('the console relay without the proof: pairing a new one works; re-pairing and removing a phone are refused, as that build was', async () => {
    expect(await call('POST', '/api/devices', T.mac, { name: 'my-phone', replace: true })).toMatchObject({ status: 403, body: { code: 'device_change_refused' } })
    expect(await call('DELETE', '/api/devices/my-phone', T.mac)).toMatchObject({ status: 403, body: { code: 'device_change_refused' } })
    expect((await call('POST', '/api/devices', T.mac, { name: 'fresh-cloud' })).status).toBe(201)
    expect((await file()).owner).toBeUndefined()
  })

  it('a new host\'s machine token, and a lost token cache, without the proof: refused while the unowned bridge-local is there, as before', async () => {
    // The Mac's first authenticated call records its lastUsedAt (a real write, which brings the
    // older file up to date); the refusals after it write nothing.
    expect((await call('GET', '/api/devices', T.mac)).status).toBe(200)
    const before = await devices()
    expect(await call('POST', '/api/devices', T.mac, { name: 'bridge-newhost', kind: 'machine' })).toMatchObject({ status: 409, body: { code: 'other_mac_connected' } })
    expect(await call('DELETE', '/api/devices/bridge-local', T.mac)).toMatchObject({ status: 409, body: { code: 'other_mac_connected' } })
    expect(await devices()).toEqual(before)
    // With the proof (a newer Mac sends it on every one of these) the same steps work.
    expect((await call('POST', '/api/devices', T.mac, { name: 'bridge-newhost', kind: 'machine' }, { [MACHINE_PROOF_HEADER]: T.local })).status).toBe(201)
    expect((await file()).owner?.via).toBe('proof')
  })

  it('a second Mac and a phone are still refused', async () => {
    expect(await call('POST', '/api/devices', T.second, { name: 'bridge-x', kind: 'machine' })).toMatchObject({ status: 409, body: { code: 'other_mac_connected' } })
    expect((await call('DELETE', '/api/devices/mac-primary', T.phone)).status).toBe(403)
    expect((await call('POST', '/api/v1/devices/self', T.phone, {})).status).toBe(200)
    expect(await call('POST', '/api/devices', T.phone, { name: 'bridge-local', kind: 'machine', replace: true }, { [MACHINE_PROOF_HEADER]: T.local })).toMatchObject({ status: 403, body: { code: 'phone_cannot_mint' } })
  })

  it('borrowed proof: another legacy credential\'s token is no proof for a second Mac', async () => {
    for (const [method, p, body] of [
      ['POST', '/api/devices', { name: 'bridge-gate', kind: 'machine' }],
      ['POST', '/api/devices', { name: 'bridge-local', kind: 'machine', replace: true }],
      ['DELETE', '/api/devices/bridge-local', undefined],
      ['POST', '/api/devices/bridge-local/adopt', undefined],
      ['DELETE', '/api/devices/my-phone', undefined],
    ] as Array<[string, string, unknown]>) {
      const r = await call(method, p, T.second, body, { [MACHINE_PROOF_HEADER]: T.devbox })
      expect(r.status, `${method} ${p}`).toBe(p === '/api/devices/my-phone' ? 403 : 409)
    }
    expect((await devices()).filter((d) => d.kind === 'machine').map((d) => d.ownerId)).toEqual([undefined, undefined])
  })

  it('the newer Mac adopts with bridge-local\'s own token: the owner by proof, every old credential its own', async () => {
    expect(await call('POST', '/api/devices/bridge-local/adopt', T.mac, undefined, { [MACHINE_PROOF_HEADER]: T.local })).toEqual({ status: 200, body: { ok: true, outcome: 'adopted' } })
    const f = await file()
    const mac = f.devices.find((d) => d.name === 'mac-primary')!
    expect(f.owner).toEqual({ id: mac.id, via: 'proof' })
    expect(f.devices.filter((d) => d.kind === 'machine').map((d) => d.ownerId)).toEqual([mac.id, mac.id])
    expect(await call('POST', '/api/devices/bridge-local/adopt', T.mac, undefined, { [MACHINE_PROOF_HEADER]: T.local })).toEqual({ status: 200, body: { ok: true, outcome: 'owned' } })
  })

  it('the proof also rides a relayed removal, wherever the Mac\'s record sits', async () => {
    // The Mac's record was re-made after the claim, so the oldest record is the
    // other Mac's. No owner is guessed from that; the Mac's relay carries its proof.
    const f = await file()
    await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: f.devices.filter((d) => d.name !== 'mac-primary').concat(f.devices.filter((d) => d.name === 'mac-primary')) }))
    _resetDeviceAuthForTesting()
    expect((await call('DELETE', '/api/devices/my-phone', T.mac)).status).toBe(403)
    expect((await call('DELETE', '/api/devices/my-phone', T.mac, undefined, { [MACHINE_PROOF_HEADER]: T.local })).status).toBe(200)
    expect((await file()).owner?.via).toBe('proof')
  })
})

describe('a phone recorded before platforms were', () => {
  // Its self-report says iPhone and nothing else says what it is: the first write records it.
  beforeEach(() => seed('owned', { info: { model: 'iPhone17,1', os: 'iOS 26.1' } }))

  it('clearing its report first still leaves it a phone', async () => {
    expect((await call('POST', '/api/v1/devices/self', T.phone, {})).status).toBe(200)
    expect((await find('my-phone'))?.platform).toBe('ios')
    expect((await call('POST', '/api/devices', T.phone, { name: 'bridge-phone', kind: 'machine' })).body.code).toBe('phone_cannot_mint')
  })
})
