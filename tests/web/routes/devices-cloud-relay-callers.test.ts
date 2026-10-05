/**
 * The Mac's relay to its cloud companion, by caller class.
 *
 * Pairing a phone "with the cloud", re-pairing a device there, removing one, and
 * the cloud half of the device list are all done by THIS Mac, with its own
 * token on the companion: there, that token is the owner's, so it may re-pair
 * or remove any device. A gate review (2026-10-02) found the relay ran before
 * any check of who asked: a phone paired on this Mac, reaching it through a
 * tunnel, minted companion tokens, re-paired another Mac there and removed
 * devices, while the same phone asking the companion directly was refused.
 *
 * Now only this Mac itself (its own console over loopback, or a local client)
 * may use the relay (device-actor.ts cloudRelayDecision). Every other caller
 * hears 403 before the companion is asked anything: a phone that asks to pair
 * hears the phone's refusal, anyone else the relay's. Each class is a real
 * request through the real auth middleware; "through a tunnel" is a proxy
 * header, which is what makes a loopback request not this machine's own.
 *
 * A second gate review (2026-10-05) found the op executor's loopback
 * self-calls still counted as this Mac: one made for a session on another exec
 * host (x-walnut-origin: host:<key>) or for a paired client (remote-http)
 * could pair, re-pair and remove there. Such a call is now the caller it acts
 * for (src/lib/caller-origin.ts), on the relay and in this Mac's own rules.
 *
 * A real startServer (not cloud mode) and a fake companion on loopback; only
 * the git remote read (where the pairing lives) is pointed at the fake. The
 * server's local daemon runs in a runtime dir of this file's own, and teardown
 * stops it and checks that nothing of it is left.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

// Read by local-daemon.ts at import: this file's server spawns its daemon here.
const runtime = vi.hoisted(() => {
  const previous = process.env.WALNUT_DAEMON_DIR
  const dir = `${(process.env.TMPDIR || '/tmp').replace(/\/+$/, '')}/walnut-relay-callers-daemon-${process.pid}-${Date.now()}`
  process.env.WALNUT_DAEMON_DIR = dir
  return { dir, previous }
})

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-cloud-relay-callers'))

const remote = vi.hoisted(() => ({ domain: '', token: 'mac-own-companion-token' }))
vi.mock('../../../src/integrations/git-sync.js', async (orig) => {
  const real = await orig<typeof import('../../../src/integrations/git-sync.js')>()
  const creds = () => (remote.domain ? { domain: remote.domain, token: remote.token, secure: false } : null)
  return { ...real, getCloudRemoteCredentials: creds, getCloudRemoteCredentialsAsync: async () => creds() }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { localDaemon } from '../../../src/providers/local-daemon.js'

const created = '2026-09-01T00:00:00.000Z'
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')

// The sentences a refused caller hears, written out: compared to the source's
// own constants, an empty or garbled sentence would equal itself.
const RELAY_REFUSAL = 'Only this Mac itself can pair or remove devices on the cloud companion, in Settings › Phones & Cloud on this Mac.'
const SELF_CALL_REFUSAL = 'Only this Mac itself can pair new devices, in Settings › Phones & Cloud on this Mac.'
const changeRefusal = (name: string) => `Only ${name} itself or this Mac can remove or re-pair ${name}.`
/** A config.yaml API key: a credential, but no paired device. */
const API_KEY = tok()

/** The companion: its records and every device request this Mac relayed to it. */
const box = { records: [] as Array<{ name: string; createdAt: string }>, seen: [] as string[] }
const companion = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    const body = (() => { try { return JSON.parse(raw || '{}') as { name?: string; kind?: string } } catch { return {} } })()
    // The Mac's own bridge credential, minted here in the background once its local daemon
    // connects (cloud-bridge-config.ts ensureMachineToken), at a moment no test controls: not
    // the relay, and no device record (the companion lists no machine credential).
    const ownBridgeMint = req.method === 'POST' && req.url === '/api/devices' && body.kind === 'machine'
    // Only the device routes are the relay; anything else this Mac does in the background is not counted.
    if ((req.url ?? '').startsWith('/api/devices') && !ownBridgeMint) box.seen.push(`${req.method} ${req.url}`)
    if (token !== remote.token) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid or revoked token"}'); return }
    if (req.method === 'GET' && req.url === '/api/devices') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ devices: box.records }))
      return
    }
    const del = /^\/api\/devices\/([^/?]+)$/.exec(req.url ?? '')
    if (req.method === 'DELETE' && del) {
      const name = decodeURIComponent(del[1])
      box.records = box.records.filter((d) => d.name !== name)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    if (req.method === 'POST' && req.url === '/api/devices') {
      const name = body.name ?? 'unnamed'
      if (!ownBridgeMint) box.records.push({ name, createdAt: created })
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ name, token: 'minted-on-companion', createdAt: created }))
      return
    }
    res.writeHead(404).end()
  })
})

let server: HttpServer
let port = 0
/** This Mac's paired devices, by class: their tokens here. */
let T: { phone: string; unreported: string; secondMac: string }

async function seedLocalDevices(): Promise<void> {
  T = { phone: tok(), unreported: tok(), secondMac: tok() }
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  fs.writeFileSync(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'field-phone', id: 'dr000000000000a01', tokenHash: sha(T.phone), createdAt: created, platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
    { name: 'spare-tablet', id: 'dr000000000000b02', tokenHash: sha(T.unreported), createdAt: created },
    { name: 'studio-mac', id: 'dr000000000000c03', tokenHash: sha(T.secondMac), createdAt: created, platform: 'other', info: { model: 'Mac15,3', os: 'macOS 26.0' } },
    // Written as an older build wrote records: no id, no platform.
    { name: 'old-phone', tokenHash: sha('legacy-phone-token'), createdAt: created, info: { model: 'iPhone15,2', os: 'iOS 18.1' } },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

/** This Mac's records as the rules see them: who is paired, with which token. */
const authCore = () => (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<{ name: string; tokenHash: string }> })
  .devices.map((d) => `${d.name}:${d.tokenHash}`).sort()

/** The local daemon's process, or any whose command line names this file's runtime dir, by `ps`. */
function leftoverProcesses(pid: number | null): string[] {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' }).split('\n')
    .filter((l) => l.includes(runtime.dir) || (pid !== null && Number(l.trim().split(/\s+/)[0]) === pid))
}

let daemonPid: number | null = null

beforeAll(async () => {
  await new Promise<void>((r) => companion.listen(0, '127.0.0.1', () => r()))
  remote.domain = `127.0.0.1:${(companion.address() as AddressInfo).port}`
  await seedLocalDevices()
  await updateConfig({ api_keys: [{ name: 'ops-script', key: API_KEY, created_at: created }] })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  daemonPid = localDaemon.pid
}, 60_000)

afterAll(async () => {
  try {
    await stopServer()
    await new Promise<void>((r) => companion.close(() => r()))
    // stopServer leaves the local daemon running (a real one outlives server
    // restarts). This one is the file's own, in a dir of its own: stop it.
    await localDaemon.stopIfIsolated()
    const left = leftoverProcesses(daemonPid)
    expect(daemonPid, 'startServer started a local daemon').toBeGreaterThan(1)
    expect(left, 'nothing of the local daemon survives the file').toEqual([])
  } finally {
    if (runtime.previous === undefined) delete process.env.WALNUT_DAEMON_DIR
    else process.env.WALNUT_DAEMON_DIR = runtime.previous
    for (const d of [runtime.dir, `${runtime.dir}-streams`]) fs.rmSync(d, { recursive: true, force: true })
  }
}, 60_000)

beforeEach(async () => {
  box.records = [
    { name: 'mac-primary', createdAt: created },
    { name: 'mac-second', createdAt: created },
    { name: 'my-phone', createdAt: created },
  ]
  box.seen = []
  await seedLocalDevices()
})

/** A caller: the headers its requests carry. */
type Caller = { name: string; headers: Record<string, string> }
let ip = 0
/** Through a tunnel: a proxy header, so the loopback request is not this machine's own. */
const tunnelled = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, 'x-forwarded-for': `10.77.0.${++ip}` })

/** The callers that are not this Mac. Their tokens exist only once beforeAll has seeded them. */
const NOT_THIS_MAC: Array<{ name: string; token: () => string }> = [
  { name: 'a phone paired on this Mac', token: () => T.phone },
  { name: 'a phone paired by an older build (no platform recorded)', token: () => 'legacy-phone-token' },
  { name: 'a device that never reported itself', token: () => T.unreported },
  { name: 'another Mac paired on this Mac', token: () => T.secondMac },
]
const THIS_MAC: Caller[] = [
  // The console in this Mac's browser: same-origin.
  { name: 'the owner, in this Mac\'s console', headers: {} },
  // A local client (curl, the CLI): no Origin.
  { name: 'a local client', headers: {} },
  // A paired token on a bare loopback socket (no proxy header) is a client on this machine.
  { name: 'a phone token on a bare loopback socket', headers: {} },
  // The op executor's self-call for a caller on this Mac (a session on this Mac's own daemon, a local CLI).
  { name: 'a self-call made for a caller on this Mac (x-walnut-origin: __local__)', headers: { 'x-walnut-origin': '__local__' } },
]
/** The op executor's loopback self-calls for a caller off this Mac: no credential, that caller's class in x-walnut-origin. */
const ON_BEHALF_OF: Caller[] = [
  { name: 'a session on another exec host (x-walnut-origin: host:devbox)', headers: { 'x-walnut-origin': 'host:devbox', 'x-walnut-caller-host': 'devbox' } },
  { name: 'a paired client (x-walnut-origin: remote-http)', headers: { 'x-walnut-origin': 'remote-http' } },
  // Node joins a header sent twice with ", ": that is `unknown`, never one of its parts.
  { name: 'an origin header sent twice', headers: { 'x-walnut-origin': '__local__, __local__' } },
]

async function call(caller: Caller, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { ...caller.headers }
  if (caller.name.includes('bare loopback')) headers.authorization = `Bearer ${T.phone}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (caller.name.includes('console')) headers.origin = `http://localhost:${port}`
  const r = await fetch(`http://localhost:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null }
}

describe('only this Mac itself may act on its cloud companion', () => {
  for (const who of NOT_THIS_MAC) {
    it(`refused before the companion is asked: ${who.name}`, async () => {
      const caller: Caller = { name: who.name, headers: tunnelled(who.token()) }
      const isRecordedPhone = caller.name === 'a phone paired on this Mac'

      const pair = await call(caller, 'POST', '/api/devices', { name: 'another-phone', target: 'cloud' })
      expect(pair.status).toBe(403)
      if (caller.name.includes('older build')) {
        // Its platform is recorded at the first locked write (device-auth.ts normalizeDevices),
        // which may or may not have happened yet: either refusal, never a relay.
        expect(['phone_cannot_pair', 'device_change_refused']).toContain(pair.body?.code)
      } else {
        expect(pair.body).toMatchObject(isRecordedPhone
          ? { code: 'phone_cannot_pair' }
          : { code: 'device_change_refused', error: RELAY_REFUSAL })
      }

      const repair = await call(caller, 'POST', '/api/devices', { name: 'mac-second', target: 'cloud', replace: true })
      expect(repair.status).toBe(403)
      expect(repair.body).toMatchObject({ code: 'device_change_refused', error: RELAY_REFUSAL })

      const remove = await call(caller, 'DELETE', '/api/devices/my-phone?target=cloud')
      expect(remove.status).toBe(403)
      expect(remove.body).toMatchObject({ code: 'device_change_refused', error: RELAY_REFUSAL })

      // Its list has no cloud half and no Cloud target: those are this Mac's view there.
      const listed = await call(caller, 'GET', '/api/devices')
      expect(listed.status).toBe(200)
      expect(listed.body?.cloudDevices).toEqual([])
      expect((listed.body?.targets as Array<{ kind: string }>).map((t) => t.kind)).not.toContain('cloud')

      // Nothing reached the companion, and its records are as they were.
      expect(box.seen).toEqual([])
      expect(box.records.map((d) => d.name)).toEqual(['mac-primary', 'mac-second', 'my-phone'])
    })
  }

  it('a caller with no credential still hears the auth middleware first (401), and nothing is relayed', async () => {
    const none: Caller = { name: 'no token, through a tunnel', headers: { 'x-forwarded-for': '10.77.1.1' } }
    expect((await call(none, 'DELETE', '/api/devices/my-phone?target=cloud')).status).toBe(401)
    expect((await call(none, 'POST', '/api/devices', { name: 'x-phone', target: 'cloud' })).status).toBe(401)
    expect(box.seen).toEqual([])
  })

  for (const caller of THIS_MAC) {
    it(`allowed, and relayed with this Mac's token: ${caller.name}`, async () => {
      const listed = await call(caller, 'GET', '/api/devices')
      expect(listed.status).toBe(200)
      expect((listed.body?.cloudDevices as Array<{ name: string }>).map((d) => d.name)).toEqual(['mac-primary', 'mac-second', 'my-phone'])
      expect((listed.body?.targets as Array<{ kind: string }>).map((t) => t.kind)).toContain('cloud')

      const pair = await call(caller, 'POST', '/api/devices', { name: 'another-phone', target: 'cloud' })
      expect(pair.status).toBe(201)
      expect(pair.body).toMatchObject({ name: 'another-phone', token: 'minted-on-companion', target: 'cloud' })

      const repair = await call(caller, 'POST', '/api/devices', { name: 'my-phone', target: 'cloud', replace: true })
      expect(repair.status).toBe(201)

      const remove = await call(caller, 'DELETE', '/api/devices/another-phone?target=cloud')
      expect(remove.status).toBe(200)
      // The list, then every change, in order, with this Mac's token (the fake
      // answers 401 to any other).
      expect(box.seen[0]).toBe('GET /api/devices')
      expect(box.seen.filter((s) => !s.startsWith('GET '))).toEqual([
        'POST /api/devices',
        'DELETE /api/devices/my-phone',
        'POST /api/devices',
        'DELETE /api/devices/another-phone',
      ])
      expect(box.records.map((d) => d.name)).toEqual(['mac-primary', 'mac-second', 'my-phone'])
    })
  }

  it('the local rules are unchanged: a phone still cannot pair a device on this Mac, and may remove itself', async () => {
    const phone: Caller = { name: 'a phone', headers: tunnelled(T.phone) }
    const local = await call(phone, 'POST', '/api/devices', { name: 'tablet-two' })
    expect(local.status).toBe(403)
    expect(local.body).toMatchObject({ code: 'phone_cannot_pair' })
    expect((await call(phone, 'DELETE', '/api/devices/field-phone')).status).toBe(200)
    expect(box.seen.filter((s) => !s.startsWith('POST /api/devices/unadopt'))).toEqual([])
  })
})

/** The relay's three changes, each asked of this Mac. */
const RELAY_CHANGES: Array<[string, string, Record<string, unknown> | undefined]> = [
  ['POST', '/api/devices', { name: 'another-phone', target: 'cloud' }],
  ['POST', '/api/devices', { name: 'mac-second', target: 'cloud', replace: true }],
  ['DELETE', '/api/devices/my-phone?target=cloud', undefined],
]

async function expectNoCloudHalf(caller: Caller): Promise<void> {
  const listed = await call(caller, 'GET', '/api/devices')
  expect(listed.status).toBe(200)
  expect(listed.body?.cloudDevices).toEqual([])
  expect((listed.body?.targets as Array<{ kind: string }>).map((t) => t.kind)).not.toContain('cloud')
}

describe('a self-call made for a caller off this Mac is that caller, never this Mac', () => {
  for (const caller of ON_BEHALF_OF) {
    it(`refused on the relay and in this Mac's own rules, and nothing changes: ${caller.name}`, async () => {
      const before = authCore()
      for (const [method, p, body] of RELAY_CHANGES) {
        const r = await call(caller, method, p, body)
        expect(r.status, `${method} ${p}`).toBe(403)
        expect(r.body).toEqual({ code: 'device_change_refused', error: RELAY_REFUSAL })
      }
      await expectNoCloudHalf(caller)

      // This Mac's own records: it pairs nothing, and re-pairs or removes nothing.
      const pair = await call(caller, 'POST', '/api/devices', { name: 'tablet-two' })
      expect(pair.status).toBe(403)
      expect(pair.body).toEqual({ code: 'device_change_refused', error: SELF_CALL_REFUSAL })
      const machine = await call(caller, 'POST', '/api/devices', { name: 'bridge-devbox', kind: 'machine' })
      expect(machine.status).toBe(403)
      expect(machine.body).toEqual({ code: 'device_change_refused', error: SELF_CALL_REFUSAL })
      // Nor adopts a pairing copied from elsewhere (a hash it chose would be a working token
      // here), nor removes one by its hash.
      expect(await call(caller, 'POST', '/api/devices/adopt', { name: 'twin-x', token_hash: sha(tok()), platform: 'other' }))
        .toEqual({ status: 403, body: { code: 'device_change_refused', error: SELF_CALL_REFUSAL } })
      expect(await call(caller, 'POST', '/api/devices/unadopt', { token_hash: sha(T.unreported) }))
        .toEqual({ status: 403, body: { code: 'device_change_refused', error: SELF_CALL_REFUSAL } })
      for (const [method, body] of [['POST', { name: 'spare-tablet', replace: true }], ['DELETE', undefined]] as const) {
        const r = await call(caller, method, method === 'POST' ? '/api/devices' : '/api/devices/spare-tablet', body)
        expect(r.status, method).toBe(403)
        expect(r.body).toEqual({ code: 'device_change_refused', error: changeRefusal('spare-tablet') })
      }

      expect(box.seen).toEqual([])
      expect(box.records.map((d) => d.name)).toEqual(['mac-primary', 'mac-second', 'my-phone'])
      expect(authCore()).toEqual(before)
    })
  }
})

describe('an API key (config.yaml) is a credential, not a device and not this Mac', () => {
  const KEY_CALLERS: Array<{ name: string; headers: () => Record<string, string> }> = [
    { name: 'through a tunnel', headers: () => tunnelled(API_KEY) },
    // Identified on a trusted socket too; the self-call's origin says it is for a client off this Mac.
    { name: 'on a self-call made for a paired client', headers: () => ({ authorization: `Bearer ${API_KEY}`, 'x-walnut-origin': 'remote-http' }) },
  ]
  for (const k of KEY_CALLERS) {
    it(`the relay refuses it; it may pair a new device here but change no existing one: ${k.name}`, async () => {
      const caller: Caller = { name: `an API key ${k.name}`, headers: k.headers() }
      for (const [method, p, body] of RELAY_CHANGES) {
        const r = await call(caller, method, p, body)
        expect(r.status, `${method} ${p}`).toBe(403)
        expect(r.body).toEqual({ code: 'device_change_refused', error: RELAY_REFUSAL })
      }
      await expectNoCloudHalf(caller)
      for (const [method, body] of [['POST', { name: 'spare-tablet', replace: true }], ['DELETE', undefined]] as const) {
        const r = await call(caller, method, method === 'POST' ? '/api/devices' : '/api/devices/spare-tablet', body)
        expect(r.status, method).toBe(403)
        expect(r.body).toEqual({ code: 'device_change_refused', error: changeRefusal('spare-tablet') })
      }
      expect(box.seen).toEqual([])

      // Pairing a new device on this Mac is what an API key may do (like any paired non-phone).
      const before = authCore()
      const pair = await call(caller, 'POST', '/api/devices', { name: 'script-paired' })
      expect(pair.status).toBe(201)
      expect(authCore()).toEqual([...before, `script-paired:${sha(String(pair.body?.token))}`].sort())
      expect(box.seen).toEqual([])
      expect(box.records.map((d) => d.name)).toEqual(['mac-primary', 'mac-second', 'my-phone'])
    })
  }
})
