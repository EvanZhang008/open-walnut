/**
 * The Mac's Phones & Cloud after "Unpair this Mac", and the other Macs on the
 * same companion.
 *
 * A gate review found three things after a confirmed unpair: Cloud Companion
 * still said "Cloud sync · Connected", the device list said in red that "This
 * Mac may have been unpaired there", and the Pairing target still offered
 * Cloud, whose every mint then failed. Now the 401 the companion gives right
 * after our own removal is recorded (core/cloud-unpaired.ts): the list says
 * nothing is wrong, Cloud is no longer a target, and a cloud mint or removal
 * says why it cannot go through. A new token in the remote (paired again) ends
 * all of that.
 *
 * Also: other Macs are listed as Macs (role mac), by the companion's word or
 * by their own report, and a failed request to the companion is said in plain
 * words ("timed out after 8s"), never as JavaScript's error text.
 *
 * A real startServer (not cloud mode) and a fake companion on loopback; only
 * the git remote read (where the pairing lives) is pointed at the fake.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-unpair-self'))

const remote = vi.hoisted(() => ({ domain: '', token: 'mac-token-1' }))
vi.mock('../../../src/integrations/git-sync.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/git-sync.js')>()),
  getCloudRemoteCredentials: () => (remote.domain ? { domain: remote.domain, token: remote.token, secure: false } : null),
  // The pairing targets read the async twin (pairing-targets.ts).
  getCloudRemoteCredentialsAsync: async () => (remote.domain ? { domain: remote.domain, token: remote.token, secure: false } : null),
}))

import { SYNC_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { plainFetchFailure } from '../../../src/web/routes/devices.js'
import { resetCloudUnpairedForTest } from '../../../src/core/cloud-unpaired.js'

const created = '2026-09-01T00:00:00.000Z'
/** The companion: its records, which tokens it still accepts, and what it was asked. */
const box = {
  accepted: new Set<string>(),
  records: [] as Array<Record<string, unknown> & { name: string }>,
  seen: [] as string[],
}
const companion = http.createServer((req, res) => {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
  box.seen.push(`${req.method} ${req.url}`)
  if (!box.accepted.has(token)) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid or revoked token"}'); return }
  if (req.method === 'GET' && req.url === '/api/devices') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ devices: box.records, caller: token === 'mac-token-1' ? 'mac-primary' : 'mac-primary-2' }))
    return
  }
  const del = /^\/api\/devices\/([^/?]+)$/.exec(req.url ?? '')
  if (req.method === 'DELETE' && del) {
    const name = decodeURIComponent(del[1])
    box.records = box.records.filter((d) => d.name !== name)
    if (name === 'mac-primary') box.accepted.delete('mac-token-1')
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    return
  }
  if (req.method === 'POST' && req.url === '/api/devices') {
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'new-phone', token: 'minted', createdAt: created }))
    return
  }
  res.writeHead(404).end()
})

let server: HttpServer
let port = 0
let domain = ''

// A server under test sweeps the hosts in ~/.ssh/config over ssh: never the real ones.
let sshIsolation: SshIsolation | null = null

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await new Promise<void>((r) => companion.listen(0, '127.0.0.1', () => r()))
  domain = `127.0.0.1:${(companion.address() as AddressInfo).port}`
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  await new Promise<void>((r) => companion.close(() => r()))
  sshIsolation?.restore()
})

beforeEach(() => {
  remote.domain = domain
  remote.token = 'mac-token-1'
  box.accepted = new Set(['mac-token-1'])
  box.records = [
    { name: 'mac-primary', createdAt: created },
    // A companion of this build says which records are Macs.
    { name: 'studio-mac', createdAt: created, role: 'mac' },
    // An older companion does not; the Mac's own report still says so.
    { name: 'laptop', createdAt: created, info: { model: 'Mac', os: 'macOS', appVersion: '0.5.1' } },
    { name: 'my-phone', createdAt: created, info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
  ]
  box.seen = []
  fs.rmSync(path.join(SYNC_DIR, 'cloud-unpaired.json'), { force: true })
  resetCloudUnpairedForTest()
})

type Listed = {
  cloudDevices: Array<{ name: string; role: string }>
  cloudError?: string
  cloudUnpaired?: { origin: string }
  cloudRefused?: boolean
  targets: Array<{ kind: string }>
}
const api = async (p: string, init?: RequestInit) => {
  const r = await fetch(`http://localhost:${port}${p}`, init)
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null }
}
const list = async (): Promise<Listed> => {
  const r = await api('/api/devices')
  expect(r.status).toBe(200)
  return r.body as unknown as Listed
}
const UNPAIRED = 'This Mac is no longer paired with the cloud companion. Pairing it again needs a new token made on the companion.'

describe('other Macs on the companion', () => {
  it('are role mac, by the companion\'s word or their own report; phones stay phones and this Mac is self', async () => {
    const roles = Object.fromEntries((await list()).cloudDevices.map((d) => [d.name, d.role]))
    expect(roles).toEqual({ 'mac-primary': 'self', 'studio-mac': 'mac', laptop: 'mac', 'my-phone': 'phone' })
  })
})

describe('after "Unpair this Mac"', () => {
  it('the list is a plain state, Cloud is no longer a target, and cloud changes say why they cannot go through', async () => {
    expect((await list()).targets.map((t) => t.kind)).toContain('cloud')

    const removed = await api('/api/devices/mac-primary?target=cloud', { method: 'DELETE' })
    expect(removed).toEqual({ status: 200, body: { ok: true, target: 'cloud', unpaired: true } })
    expect(JSON.parse(fs.readFileSync(path.join(SYNC_DIR, 'cloud-unpaired.json'), 'utf-8'))).toMatchObject({ origin: `http://${domain}` })
    // The record holds a fingerprint of the token, never the token itself.
    expect(fs.readFileSync(path.join(SYNC_DIR, 'cloud-unpaired.json'), 'utf-8')).not.toContain('mac-token-1')

    box.seen = []
    const after = await list()
    expect(after.cloudDevices).toEqual([])
    expect(after.cloudError).toBeUndefined()
    expect(after.cloudUnpaired).toEqual({ origin: `http://${domain}` })
    expect(after.targets.map((t) => t.kind)).not.toContain('cloud')
    // Nothing to ask the companion: the answer is known.
    expect(box.seen).toEqual([])

    const mint = await api('/api/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'new-phone', target: 'cloud' }) })
    expect(mint).toEqual({ status: 400, body: { error: UNPAIRED } })
    expect(await api('/api/devices/my-phone?target=cloud', { method: 'DELETE' })).toEqual({ status: 400, body: { error: UNPAIRED } })
    expect(box.seen).toEqual([])

    // Paired again: a new token in the remote is a pairing like any other.
    remote.token = 'mac-token-2'
    box.accepted.add('mac-token-2')
    const again = await list()
    expect(again.cloudUnpaired).toBeUndefined()
    expect(again.targets.map((t) => t.kind)).toContain('cloud')
    expect(again.cloudDevices.map((d) => d.name)).toContain('my-phone')
  })

  it('removing a phone is not an unpair; a 401 nobody here caused keeps its warning', async () => {
    expect(await api('/api/devices/my-phone?target=cloud', { method: 'DELETE' })).toEqual({ status: 200, body: { ok: true, target: 'cloud' } })
    expect(fs.existsSync(path.join(SYNC_DIR, 'cloud-unpaired.json'))).toBe(false)
    expect((await list()).cloudDevices.map((d) => d.name)).not.toContain('my-phone')

    // Until then the companion accepts this Mac: nothing says otherwise.
    expect((await list()).cloudRefused).toBeUndefined()
    box.accepted.clear()
    const body = await list()
    expect(body.cloudUnpaired).toBeUndefined()
    expect(body.cloudError).toMatch(/no longer accepts this Mac's token, so/)
    // So the Cloud card stops saying "Connected" (CloudSection reads this).
    expect(body.cloudRefused).toBe(true)
    expect(body.targets.map((t) => t.kind)).toContain('cloud')
  })
})

describe('a failed request to the companion, in plain words', () => {
  it('a timeout reads "timed out after Ns", never the abort text', async () => {
    const held: net.Socket[] = []
    const silent = net.createServer((s) => { held.push(s) })
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    try {
      const err = await fetch(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/`, { signal: AbortSignal.timeout(200) }).catch((e: unknown) => e)
      expect(String((err as Error).message)).toMatch(/aborted/i)
      expect(plainFetchFailure(err, 8_000)).toBe('timed out after 8s')
      const aborted = new AbortController()
      aborted.abort()
      expect(plainFetchFailure(await fetch('http://127.0.0.1:9/', { signal: aborted.signal }).catch((e: unknown) => e), 15_000)).toBe('timed out after 15s')
    } finally {
      held.forEach((s) => s.destroy())
      await new Promise<void>((r) => silent.close(() => r()))
    }
  })

  it('a refused connection says so, through the route as well', async () => {
    const closed = http.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    const gone = `127.0.0.1:${(closed.address() as AddressInfo).port}`
    await new Promise<void>((r) => closed.close(() => r()))
    remote.domain = gone
    expect((await list()).cloudError).toBe("Could not reach the cloud companion (the connection was refused), so the phones paired there can't be listed.")
    const mint = await api('/api/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'new-phone', target: 'cloud' }) })
    expect(mint).toEqual({ status: 502, body: { error: 'Could not reach the cloud companion: the connection was refused.' } })
    expect(await api('/api/devices/my-phone?target=cloud', { method: 'DELETE' })).toEqual({ status: 502, body: { error: 'Could not reach the cloud companion (the connection was refused).' } })
  })
})
