/**
 * API keys on a cloud companion, by caller class (core/device-actor.ts
 * apiKeyDecision), through the real server and auth middleware.
 *
 * The 2026-10-03 gate laundered a phone into a non-phone with one: any paired
 * device could POST /api/auth/keys, the key paired a new device (nothing
 * recorded it as a phone), and on a companion with no machine credential that
 * device minted one and removed the Mac. A key also outlived the device that
 * made it. Now only the owner makes keys here, each key is bound to the owner's
 * id and stops working when that pairing goes, and no key pairs, re-pairs or
 * removes a device, the operator's own config.yaml keys included.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-api-keys-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting, revokeDevice, rotateDevice } from '../../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../../src/core/device-actor.js'
import { getConfig, updateConfig } from '../../../src/core/config-manager.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const ID = { mac: 'dk0000000000000a1', second: 'dk0000000000000b2', phone: 'dk0000000000000c3', tablet: 'dk0000000000000d4' }
const AMAC = { model: 'Mac15,3', os: 'macOS 26.0' }
const OPERATOR_KEY = 'wlnt_sk_operator_written_key_0001'
let T: { mac: string; second: string; phone: string; tablet: string }

async function seed(withMachine: boolean): Promise<void> {
  T = { mac: tok(), second: tok(), phone: tok(), tablet: tok() }
  const now = new Date().toISOString()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', id: ID.mac, tokenHash: sha(T.mac), createdAt: now, platform: 'other', info: AMAC },
    { name: 'mac-second', id: ID.second, tokenHash: sha(T.second), createdAt: now, platform: 'other', info: AMAC },
    { name: 'phone-a', id: ID.phone, tokenHash: sha(T.phone), createdAt: now, platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
    { name: 'tablet-new', id: ID.tablet, tokenHash: sha(T.tablet), createdAt: now },
    ...(withMachine ? [{ name: 'bridge-local', id: 'dk0000000000000e5', tokenHash: sha(tok()), createdAt: now, kind: 'machine', ownerId: ID.mac }] : []),
  ] }), { mode: 0o600 })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  await updateConfig({ api_keys: [{ name: 'operator-script', key: OPERATOR_KEY, created_at: now }] })
  _resetDeviceAuthForTesting()
}

let server: HttpServer
let port = 0
let ip = 0
async function call(method: string, p: string, bearer: string | undefined, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${(++ip % 250) + 1}` }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const keys = async () => (await getConfig()).api_keys ?? []
const names = async () => (JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<{ name: string }> }).devices.map((d) => d.name).sort()

const REFUSED = { status: 403, body: { error: 'Only the Mac this cloud companion belongs to can create or remove API keys.', code: 'api_keys_refused' } }

let sshIsolation: SshIsolation | null = null
beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await seed(true)
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

for (const withMachine of [true, false]) {
  describe(withMachine ? 'a companion the Mac owns, its bridge connected' : 'a companion with no machine credential yet (the C-launder-fresh case)', () => {
    beforeEach(() => seed(withMachine))

    it('a phone, a tablet, another Mac and a key may not make or remove keys; nothing is written', async () => {
      for (const bearer of [T.phone, T.tablet, T.second, OPERATOR_KEY]) {
        expect(await call('POST', '/api/auth/keys', bearer, { name: `k-${tok().slice(0, 6)}` })).toEqual(REFUSED)
        expect(await call('DELETE', '/api/auth/keys/operator-script', bearer)).toEqual(REFUSED)
      }
      expect((await keys()).map((k) => k.name)).toEqual(['operator-script'])
    })

    it('the laundering chain stops at its first step, and the Mac is still there', async () => {
      const k = await call('POST', '/api/auth/keys', T.phone, { name: 'gate-key' })
      expect(k.status).toBe(403)
      expect(k.body.key).toBeUndefined()
      expect(await names()).toContain('mac-primary')
    })

    it('the owner makes a key bound to its own id; the key reaches the API but changes no device and makes no key', async () => {
      if (!withMachine) {
        // No owner recorded and nothing minted: nothing proves which Mac this is, so no device makes a key
        // (never a guess from the record order). The Mac's first mint records it the owner.
        expect(await call('POST', '/api/auth/keys', T.mac, { name: 'owner-script' })).toEqual(REFUSED)
        expect((await call('POST', '/api/devices', T.mac, { name: 'bridge-local', kind: 'machine' })).status).toBe(201)
      }
      const made = await call('POST', '/api/auth/keys', T.mac, { name: 'owner-script' })
      expect(made.status).toBe(200)
      const key = String(made.body.key)
      expect((await keys()).find((k) => k.name === 'owner-script')).toMatchObject({ device_id: ID.mac })
      expect((await call('GET', '/api/devices', key)).status).toBe(200)
      expect(await call('POST', '/api/devices', key, { name: 'laundered' })).toMatchObject({ status: 403, body: { code: 'api_key_cannot_pair', error: 'An API key cannot pair, re-pair or remove devices.' } })
      expect((await call('POST', '/api/devices', key, { name: 'phone-a', replace: true })).status).toBe(403)
      expect((await call('DELETE', '/api/devices/mac-primary', key)).status).toBe(403)
      expect((await call('POST', '/api/devices', key, { name: 'bridge-key', kind: 'machine' })).status).toBe(403)
      expect(await call('POST', '/api/auth/keys', key, { name: 'key-from-key' })).toEqual(REFUSED)
      expect(await names()).toEqual(['bridge-local', 'mac-primary', 'mac-second', 'phone-a', 'tablet-new'])
    })

    it('the operator\'s own config.yaml key works for the API and pairs nothing', async () => {
      expect((await call('GET', '/api/devices', OPERATOR_KEY)).status).toBe(200)
      expect(await call('POST', '/api/devices', OPERATOR_KEY, { name: 'laundered' })).toMatchObject({ status: 403, body: { code: 'api_key_cannot_pair' } })
      expect((await call('POST', '/api/devices', OPERATOR_KEY, { name: 'bridge-laundered', kind: 'machine' })).status).toBe(403)
    })
  })
}

describe('a key dies with the pairing that made it (C-apikey-outlives-revoke)', () => {
  beforeEach(() => seed(true))

  it('removed by the box CLI: the key answers 401 at once', async () => {
    const key = String((await call('POST', '/api/auth/keys', T.mac, { name: 'owner-script' })).body.key)
    expect((await call('GET', '/api/devices', key)).status).toBe(200)
    expect(await revokeDevice('mac-primary')).toBe(true)
    expect((await call('GET', '/api/devices', key)).status).toBe(401)
    // The operator's unbound key is untouched.
    expect((await call('GET', '/api/devices', OPERATOR_KEY)).status).toBe(200)
  })

  it('the owner unpairing itself, or its name re-paired by this machine (a new pairing), ends its keys too', async () => {
    const a = String((await call('POST', '/api/auth/keys', T.mac, { name: 'a' })).body.key)
    await rotateDevice('mac-primary', { by: LOCAL_ACTOR })
    expect((await call('GET', '/api/devices', a)).status).toBe(401)
    await seed(true)
    const b = String((await call('POST', '/api/auth/keys', T.mac, { name: 'b' })).body.key)
    expect((await call('DELETE', '/api/devices/mac-primary', T.mac)).status).toBe(200)
    expect((await call('GET', '/api/devices', b)).status).toBe(401)
  })

  it('the owner rotating its own token keeps its keys: the same device', async () => {
    const key = String((await call('POST', '/api/auth/keys', T.mac, { name: 'owner-script' })).body.key)
    expect((await call('POST', '/api/devices', T.mac, { name: 'mac-primary', replace: true })).status).toBe(201)
    expect((await call('GET', '/api/devices', key)).status).toBe(200)
  })

  it('the owner removes a key', async () => {
    await call('POST', '/api/auth/keys', T.mac, { name: 'owner-script' })
    expect((await call('DELETE', '/api/auth/keys/owner-script', T.mac)).status).toBe(200)
    expect((await keys()).map((k) => k.name)).toEqual(['operator-script'])
  })
})
