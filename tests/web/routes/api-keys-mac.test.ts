/**
 * API keys on the Mac (primary mode), by caller class: only this Mac itself
 * makes or removes them (its own console, a local client), and such a key is
 * bound to no device, like one the operator writes into config.yaml. A phone
 * paired here, another Mac, or a key may not: the same laundering the
 * companion closes (api-keys-caller-class.test.ts), on this side of the relay.
 * Real server and auth middleware; "through a tunnel" is a proxy header, which
 * is what makes a loopback request not this machine's own.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-api-keys-mac'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { getConfig, updateConfig } from '../../../src/core/config-manager.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const created = '2026-09-01T00:00:00.000Z'
let T: { phone: string; studio: string }

let server: HttpServer
let port = 0
let ip = 0
let sshIsolation: SshIsolation | null = null

async function seed(): Promise<void> {
  T = { phone: tok(), studio: tok() }
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  fs.writeFileSync(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'studio-mac', id: 'dm000000000000a01', tokenHash: sha(T.studio), createdAt: created, platform: 'other', info: { model: 'Mac15,3', os: 'macOS 26.0' } },
    { name: 'field-phone', id: 'dm000000000000b02', tokenHash: sha(T.phone), createdAt: created, platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
  ] }), { mode: 0o600 })
  await updateConfig({ api_keys: [] })
  _resetDeviceAuthForTesting()
}

/** `console`: this Mac's own browser; anything else comes through a tunnel with its bearer. */
async function call(who: 'console' | string, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (who === 'console') headers.origin = `http://localhost:${port}`
  else { headers.authorization = `Bearer ${who}`; headers['x-forwarded-for'] = `10.66.0.${++ip}` }
  const r = await fetch(`http://localhost:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null }
}

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await seed()
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)
afterAll(async () => {
  await stopServer()
  sshIsolation?.restore()
})
beforeEach(() => seed())

describe('API keys on the Mac', () => {
  it('this Mac\'s console makes and removes keys; they are bound to no device', async () => {
    const made = await call('console', 'POST', '/api/auth/keys', { name: 'script' })
    expect(made.status).toBe(200)
    const entry = ((await getConfig()).api_keys ?? []).find((k) => k.name === 'script')
    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('device_id')
    // The key works from elsewhere, and still changes no device.
    expect((await call(String(made.body?.key), 'GET', '/api/tasks')).status).toBe(200)
    expect(await call(String(made.body?.key), 'POST', '/api/devices', { name: 'laundered' })).toMatchObject({ status: 403, body: { code: 'api_key_cannot_pair' } })
    expect((await call('console', 'DELETE', '/api/auth/keys/script')).status).toBe(200)
  })

  it('a phone or another Mac paired here may not make or remove keys', async () => {
    await updateConfig({ api_keys: [{ name: 'keep', key: 'wlnt_sk_keep_me_0001', created_at: created }] })
    for (const t of [T.phone, T.studio, 'wlnt_sk_keep_me_0001']) {
      expect(await call(t, 'POST', '/api/auth/keys', { name: 'mine' })).toEqual({ status: 403, body: { error: 'Only this Mac itself can create or remove API keys.', code: 'api_keys_refused' } })
      expect((await call(t, 'DELETE', '/api/auth/keys/keep')).status).toBe(403)
    }
    expect(((await getConfig()).api_keys ?? []).map((k) => k.name)).toEqual(['keep'])
  })
})
