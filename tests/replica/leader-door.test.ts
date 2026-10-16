/**
 * The leader door of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 1; R26): the copies the Mac sends come in only on streams the host
 * daemon accepted from `primary`, never through the public (tunnel) port.
 *
 * The real startServer boots as a host replica in this process. The public
 * port is its HTTP listener; "a primary stream" is a TCP socket handed to
 * getHostReplicaLeaderDoor().accept, exactly what the follower link does with a
 * stream the daemon relays (WP2 wires the link itself).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { LEADER_ID, sha256, snapshotFiles, useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-door'))

let home = ''
let env: HostReplicaEnv | null = null
let publicPort = 0
let doorPort = 0
let doorServer: net.Server | null = null
let stopServer: (() => Promise<void>) | null = null
const PHONE_TOKEN = 'marina-phone-token'

const KINDS: Array<Record<string, unknown>> = [
  { op: 'put', kind: 'devices', devices: [{ id: 'd00112233445566', name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }], hash: 'x' },
  { op: 'status', kind: 'search', mode: 'auto' },
  { op: 'sync', kind: 'search', entries: [], asOf: 1 },
  { op: 'sync', kind: 'tasks', entries: [], asOf: 1 },
  { op: 'put', kind: 'tasks', rows: [{ id: 't-acme-1', title: 'acme', phase: 'TODO' }] },
  { op: 'put', kind: 'registry', registry: { projects: {}, task_groups: {}, custom_tiers: [] } },
  { op: 'put', kind: 'sessions', rows: [] },
  { op: 'status', kind: 'sessions', digest: '0.0' },
  { op: 'sync', kind: 'requests', entries: [], asOf: 1 },
  { op: 'sync', kind: 'boards', entries: [], asOf: 1 },
  { op: 'status', kind: 'inbox', digest: '0.0' },
  { op: 'put', kind: 'inbox-bodies', rows: [] },
]

/** The files a copy step could write. */
const copyFiles = (rel: string) => rel.startsWith('replica') || rel.startsWith('cache') || /^(tasks|sessions)\.sqlite/.test(rel)
  || rel.startsWith('boards') || rel.startsWith('human-inbox') || rel === 'session-requests.json'

async function post(port: number, p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: JSON.stringify(body) })
  const text = await r.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) } catch { parsed = { text: text.slice(0, 200) } }
  return { status: r.status, body: parsed }
}

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  home = c.WALNUT_HOME
  env = useHostReplicaEnv(home)
  const role = await import('../../src/core/server-role.js')
  role._resetServerRoleForTesting()
  expect(role.isHostReplica()).toBe(true)
  const server = await import('../../src/web/server.js')
  const http = await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
  publicPort = (http.address() as net.AddressInfo).port
  const door = server.getHostReplicaLeaderDoor()
  expect(door).not.toBeNull()
  doorServer = net.createServer((sock) => door!.accept(sock))
  await new Promise<void>((r) => doorServer!.listen(0, '127.0.0.1', () => r()))
  doorPort = (doorServer.address() as net.AddressInfo).port
}, 120_000)

afterAll(async () => {
  await new Promise<void>((r) => (doorServer ? doorServer.close(() => r()) : r()))
  try { await stopServer?.() } catch { /* already down */ }
  env?.restore()
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
}, 60_000)

describe('the public port of a host replica', () => {
  it('answers 404 for POST /bridge/replica with every kind, devices included, and writes no copy file', async () => {
    const before = snapshotFiles(home, copyFiles)
    for (const body of KINDS) {
      for (const p of ['/bridge/replica', '/BRIDGE/replica', '//bridge/replica', '/bridge/replica/', '/bridge/%72eplica']) {
        const r = await post(publicPort, p, body)
        expect(r.status, `${p} ${JSON.stringify(body).slice(0, 60)}`).toBe(404)
      }
    }
    // A device token does not open it either (there is none yet: the copy is empty).
    expect((await post(publicPort, '/bridge/replica', KINDS[0], { authorization: `Bearer ${PHONE_TOKEN}` })).status).toBe(404)
    expect((await post(publicPort, '/bridge/ingest', { kind: 'tasks' })).status).toBe(404)
    expect(snapshotFiles(home, copyFiles)).toEqual(before)
    expect(fs.existsSync(path.join(home, 'replica', 'devices.json'))).toBe(false)
  })

  it('answers 404 for /git/data and /host-api on every method', async () => {
    for (const p of ['/git/data/info/refs?service=git-upload-pack', '/git/data/git-receive-pack', '/host-api/status']) {
      const get = await fetch(`http://127.0.0.1:${publicPort}${p}`, { headers: { connection: 'close' } })
      expect(get.status, p).toBe(404)
      expect((await post(publicPort, p, {})).status, p).toBe(404)
    }
  })

  it('refuses a /bridge WebSocket upgrade', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const sock = net.connect(publicPort, '127.0.0.1', () => {
        sock.write('GET /bridge HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
      })
      let got = ''
      sock.on('data', (b) => { got += b.toString() })
      sock.on('close', () => resolve(got))
      sock.on('error', () => resolve(got))
      setTimeout(() => { sock.destroy(); resolve(got) }, 5_000)
    })
    expect(outcome).not.toMatch(/101 Switching Protocols/)
  })
})

describe('the leader door (a primary stream)', () => {
  it('takes the device copy (200), at 0600 in a 0700 dir, and the public port then knows that token', async () => {
    expect((await fetch(`http://127.0.0.1:${publicPort}/api/config`, { headers: { authorization: `Bearer ${PHONE_TOKEN}`, connection: 'close' } })).status).toBe(401)
    const r = await post(doorPort, '/bridge/replica', KINDS[0])
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, devices: 1 })
    const file = path.join(home, 'replica', 'devices.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    const ok = await fetch(`http://127.0.0.1:${publicPort}/api/config`, { headers: { authorization: `Bearer ${PHONE_TOKEN}`, connection: 'close' } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ role: 'replica', placement: 'host' })
    const wrong = await fetch(`http://127.0.0.1:${publicPort}/api/config`, { headers: { authorization: 'Bearer not-a-device', connection: 'close' } })
    expect(wrong.status).toBe(401)
  })

  it('/ws: a stranger\'s wrong tokens through the tunnel never refuse the phone\'s upgrade', async () => {
    /** The status line a raw /ws upgrade gets. */
    const upgrade = (token: string) => new Promise<string>((resolve) => {
      const sock = net.connect(publicPort, '127.0.0.1', () => {
        sock.write(`GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
      })
      let got = ''
      let timer: NodeJS.Timeout | undefined
      const done = () => { clearTimeout(timer); sock.destroy(); resolve(got.split('\r\n')[0] ?? '') }
      sock.on('data', (b) => { got += b.toString(); if (got.includes('\r\n')) done() })
      sock.on('close', done)
      sock.on('error', done)
      timer = setTimeout(done, 5_000)
    })
    const wrong: string[] = []
    for (let i = 0; i < 12; i++) wrong.push(await upgrade(`stranger-${i}`))
    expect(wrong.at(-1)).toMatch(/ 429 /)
    expect(wrong.every((l) => / 40[1] | 429 /.test(l))).toBe(true)
    expect(await upgrade(PHONE_TOKEN)).toMatch(/ 101 /)
    const api = await fetch(`http://127.0.0.1:${publicPort}/api/config`, { headers: { authorization: `Bearer ${PHONE_TOKEN}`, connection: 'close' } })
    expect(api.status).toBe(200)
  })

  it('serves every kind: the steps reach their stores (search, tasks, registry and the WP4 copies 200)', async () => {
    const answers: Array<[string, number, unknown]> = []
    for (const body of KINDS.slice(1)) {
      const r = await post(doorPort, '/bridge/replica', body)
      answers.push([`${body.op}:${body.kind}`, r.status, r.body.error ?? null])
      // Never the door's own 404: every step reached the kind dispatcher.
      expect(r.body.error, JSON.stringify(r.body)).not.toBe('not_found')
    }
    expect(answers.find(([k]) => k === 'status:search')?.[1]).toBe(200)
    // WP3: the task copy store is gated on isFollower(), so a host replica takes it.
    for (const [k, status, error] of answers.filter(([k]) => k.endsWith(':tasks') || k.endsWith(':registry'))) {
      expect([k, status, error]).toEqual([k, 200, null])
    }
    // WP4: the sessions, requests, boards and inbox copies are kept on a host replica.
    for (const [k, status, error] of answers.filter(([k]) => /:(sessions|requests|boards|inbox|inbox-bodies)$/.test(k))) {
      expect([k, status, error]).toEqual([k, 200, null])
    }
    expect(answers.filter(([k]) => /:(sessions|requests|boards|inbox|inbox-bodies)$/.test(k))).toHaveLength(6)
    const { listTasks } = await import('../../src/core/task-manager.js')
    expect((await listTasks()).map((t) => t.id)).toContain('t-acme-1')
    // Every file of the replica's data dir is 0600 and every dir 0700, after the
    // copy steps: the task copy's state, the store with its -wal and -shm, any
    // backup a store step made, the device and search copies.
    await new Promise((r) => setTimeout(r, 100))
    const loose: string[] = []
    const seen: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isSymbolicLink()) continue
        const mode = fs.statSync(p).mode & 0o777
        const rel = path.relative(home, p)
        seen.push(rel)
        if (e.isDirectory()) { if (mode !== 0o700) loose.push(`${rel}/ ${mode.toString(8)}`); walk(p) }
        else if (mode !== 0o600) loose.push(`${rel} ${mode.toString(8)}`)
      }
    }
    expect(fs.statSync(home).mode & 0o777).toBe(0o700)
    walk(home)
    expect(seen).toEqual(expect.arrayContaining(['cache/task-replica.json', 'tasks/tasks.sqlite', 'replica/devices.json']))
    expect(loose).toEqual([])
  })

  it('answers its own status and 404 for paths it does not serve', async () => {
    const s = await fetch(`http://127.0.0.1:${doorPort}/host-api/status`, { headers: { connection: 'close' } })
    expect(s.status).toBe(200)
    expect(await s.json()).toMatchObject({ ok: true, role: 'replica', placement: 'host' })
    expect((await post(doorPort, '/api/tasks', {})).status).toBe(404)
  })

  it('/api/v1/instance on the public port is the Mac id, with no token and no auth.json minted', async () => {
    const r = await fetch(`http://127.0.0.1:${publicPort}/api/v1/instance`, { headers: { connection: 'close' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ instance: LEADER_ID, mode: 'REPLICA' })
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false)
  })
})
