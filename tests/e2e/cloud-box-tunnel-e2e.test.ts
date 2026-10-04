/**
 * The cloud companion as an automatic exec host of the Mac, end to end.
 *
 *   primary (this process, startServer) ──TCP proxy──▶ replica (real child
 *   process, WALNUT_CLOUD_MODE=1) ──/daemon-tunnel──▶ tunnel daemon (the real
 *   daemon binary the replica starts) ──▶ mock claude CLI
 *
 * Zero mocks on the path: real auth.json on the replica, the real pairing (a
 * `cloud` git remote holding a device token), the real probe, the real daemon.
 * Only the CLI is a mock. The proxy is ours so the test can cut the network
 * between the two servers mid-session and prove the session survives.
 *
 * Isolation: each server has its own HOME, data dir and daemon dirs under one
 * temp base. Nothing is copied from the user's data; no pid in any fixture.
 *
 * The box daemon runs a build of the CURRENT daemon source that reads its
 * version at run time (tests/helpers/cloud-box-daemon-build.ts), so the upgrade
 * case can play two releases of it. Without bun it runs the prebuilt dist
 * binary and the upgrade case is skipped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { buildTestDaemon, findBun, stageDaemonRelease } from '../helpers/cloud-box-daemon-build.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloudbox-primary'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { CLOUD_BOX_HOST_ALIAS, TUNNEL_REFUSAL_HEADER } from '../../src/core/hosts/cloud-box-host.js'
import { refreshCloudBoxHost } from '../../src/core/hosts/cloud-box-probe.js'

let base = ''
let replica: CloudBoxReplica
let primaryPort = 0
/** The runtime-versioned daemon build, when bun is here. */
let daemonBuild: string | null = null

// ── A cuttable TCP proxy between the two servers ────────────────────────────
const proxySockets = new Set<net.Socket>()
let proxy: net.Server | null = null
let proxyPort = 0
function cutProxy(): void { for (const s of proxySockets) s.destroy(); proxySockets.clear() }

const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${primaryPort}${p}`, init)
const post = (p: string, body: unknown) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const streamFile = (sid: string) => replica.streamFile(sid)

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

async function cloudStatus(): Promise<Record<string, unknown> | undefined> {
  const r = await api('/api/hosts/status')
  const body = await r.json() as { hosts?: Array<Record<string, unknown>> }
  return body.hosts?.find((h) => h.host === CLOUD_BOX_HOST_ALIAS)
}

function rpc(method: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${primaryPort}/ws`)
    const id = `rpc-${Math.random().toString(36).slice(2)}`
    const t = setTimeout(() => { ws.terminate(); reject(new Error(`rpc timeout ${method}`)) }, 60_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'req', id, method, payload })))
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>
      if (m.id === id) { clearTimeout(t); ws.close(); resolve(m) }
    })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function dialTunnel(token?: string): Promise<{ status: number; refusal?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/daemon-tunnel`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
    ws.on('unexpected-response', (_q, res) => {
      const h = res.headers[TUNNEL_REFUSAL_HEADER]
      res.resume()
      resolve({ status: res.statusCode ?? 0, refusal: typeof h === 'string' ? h : undefined })
    })
    ws.on('open', () => { ws.close(); resolve({ status: 101 }) })
    ws.on('error', () => { /* unexpected-response answers */ })
    setTimeout(() => reject(new Error('tunnel dial hung')), 30_000).unref()
  })
}

/** The box daemon's pid for a session, from its registry. */
function cliPidOf(sessionId: string): number | undefined {
  const reg = JSON.parse(fs.readFileSync(path.join(replica.box.tunnelDir, 'sessions.json'), 'utf-8')) as Record<string, unknown>
  const entry = (reg.sessions as Record<string, { pid?: number }> | undefined)?.[sessionId] ?? (reg as Record<string, { pid?: number }>)[sessionId]
  return entry?.pid
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cloudbox-e2e-'))
  daemonBuild = await buildTestDaemon(path.join(base, 'daemon-build'))
  const first = daemonBuild
    ? { binary: await stageDaemonRelease(daemonBuild, path.join(base, 'release-1'), 'walnut-daemon-e2e-release-1'), version: 'walnut-daemon-e2e-release-1' }
    : undefined
  replica = await startCloudBoxReplica(base, first)

  // The companion's fixed address (Caddy on a real box): a restart moves the
  // replica to a new port, and the proxy follows it.
  proxy = net.createServer((client) => {
    const up = net.connect(replica.port, '127.0.0.1')
    proxySockets.add(client); proxySockets.add(up)
    client.pipe(up); up.pipe(client)
    const end = () => { client.destroy(); up.destroy(); proxySockets.delete(client); proxySockets.delete(up) }
    client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
  })
  await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', r))
  proxyPort = (proxy.address() as net.AddressInfo).port

  // The Mac: paired through its data repo's `cloud` remote (pointing at the
  // proxy), with the machine credential already cached.
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\ndefaults:\n  priority: none\n')
  await seedPrimaryPairing(WALNUT_HOME, `127.0.0.1:${proxyPort}`, replica.tokens)

  const server = await startServer({ port: 0, dev: true })
  primaryPort = (server.address() as net.AddressInfo).port
}, 420_000)

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  cutProxy()
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()))
  await replica?.stop()
  if (process.env.DEBUG_BOX) process.stderr.write(replica?.log().slice(-8000) ?? '')
}, 60_000)

describe('the cloud box as a host of the Mac', () => {
  it('the replica advertises the tunnel, and refuses every credential but the primary machine one', async () => {
    const status = await (await fetch(`http://127.0.0.1:${proxyPort}/api/v1/status`, { headers: { Authorization: `Bearer ${replica.tokens.phone}` } })).json() as Record<string, unknown>
    expect(status.daemonTunnel).toEqual({ enabled: true })

    expect(await dialTunnel()).toMatchObject({ status: 401 })
    expect(await dialTunnel(replica.tokens.phone)).toMatchObject({ status: 403, refusal: 'not_primary' })
    expect(await dialTunnel(replica.tokens.mac)).toMatchObject({ status: 403, refusal: 'not_primary' })
    expect(await dialTunnel(replica.tokens.otherMachine)).toMatchObject({ status: 403, refusal: 'not_primary' })
    expect(await dialTunnel('0'.repeat(32))).toMatchObject({ status: 401 })
    // The /bridge allowlist is untouched: the primary token still is not a browser credential.
    const ws = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/status`, { headers: { Authorization: `Bearer ${replica.tokens.primaryMachine}` } })
    expect(ws.status).toBe(401)
  }, 120_000)

  it('lists Cloud automatically (never in Settings), connects, and browses the box', async () => {
    await refreshCloudBoxHost()
    const dirs = await (await api('/api/sessions/working-dirs')).json() as { hosts?: Array<{ alias: string; label: string }> }
    expect(dirs.hosts).toContainEqual({ alias: CLOUD_BOX_HOST_ALIAS, label: 'Cloud' })
    // GET /api/config answers { config: { hosts } }; the row is in the live config, never in this one.
    const cfg = await (await api('/api/config')).json() as { config?: { hosts?: Record<string, unknown> } }
    expect(cfg.config).toBeDefined()
    expect(Object.keys(cfg.config?.hosts ?? {})).not.toContain(CLOUD_BOX_HOST_ALIAS)

    const listing = await waitFor(async () => {
      const r = await api(`/api/sessions/list-dirs?host=${CLOUD_BOX_HOST_ALIAS}&prefix=${encodeURIComponent(replica.box.projects + '/')}`)
      if (r.status !== 200) return null
      const body = await r.json() as { dirs?: unknown[] }
      return Array.isArray(body.dirs) && body.dirs.length >= 2 ? body : null
    }, 90_000, 'list-dirs on Cloud')
    expect(JSON.stringify(listing)).toContain('alpha')
    expect(JSON.stringify(listing)).toContain('beta')

    const st = await waitFor(async () => { const s = await cloudStatus(); return s?.connected ? s : null }, 30_000, 'Cloud connected')
    expect(st).toMatchObject({ label: 'Cloud', connected: true })
    // A credential from before ownership was recorded: this Mac proved it holds
    // it and now owns it, on the same token and the same (unkeyed) daemon dir.
    const local = await waitFor(async () => {
      const d = replica.devices().find((r) => r.name === 'bridge-local')
      return d?.ownerId ? d : null
    }, 30_000, 'the Mac to adopt its machine credential')
    // Owned by the Mac's device id, with no daemon key: the unkeyed daemon, which
    // the Mac's record now names as its own.
    expect(local).toEqual({ name: 'bridge-local', id: replica.ids['bridge-local'], kind: 'machine', ownerId: replica.ids['mac-primary'] })
    expect(replica.devices().find((d) => d.name === 'mac-primary')?.tunnelDaemon).toEqual({})
    expect(fs.existsSync(path.join(replica.box.tunnelDir, 'daemon.pid'))).toBe(true)
    expect(fs.existsSync(`${replica.box.tunnelDir}.by-device`)).toBe(false)

    const files = await api(`/api/files/list?host=${CLOUD_BOX_HOST_ALIAS}&path=${encodeURIComponent(path.join(replica.box.projects, 'alpha'))}`)
    expect(files.status).toBe(200)
    expect(JSON.stringify(await files.json())).toContain('README.md')
  }, 180_000)

  let sid = ''

  it('starts a session on Cloud, streams it, and a second message lands in the same CLI', async () => {
    // The CLI reports the daemon's keep-sessions switch as it sees it: the box
    // daemon runs with it, and must not hand it down (P2-7).
    const r = await post('/api/sessions/quick-start', {
      cwd: path.join(replica.box.projects, 'alpha'), host: CLOUD_BOX_HOST_ALIAS,
      message: 'snapshot-clean-turn:first-cloud-turn keep={env:WALNUT_DAEMON_KEEP_SESSIONS}', overrideReadiness: true,
    })
    const body = await r.json() as { sessionId?: string; error?: string }
    expect(r.status, JSON.stringify(body)).toBe(200)
    sid = body.sessionId!
    expect(sid).toBeTruthy()
    await waitFor(async () => fs.existsSync(streamFile(sid)) && fs.readFileSync(streamFile(sid), 'utf-8').includes('"result":"first-cloud-turn keep=<unset>"'), 60_000, 'first turn on the box')

    const rec = await (await api(`/api/sessions/${sid}`)).json() as { host?: string; pid?: number; session?: { host?: string } }
    expect(rec.host ?? rec.session?.host).toBe(CLOUD_BOX_HOST_ALIAS)

    const sent = await rpc('session:send', { sessionId: sid, message: 'snapshot-clean-turn:second-cloud-turn' })
    expect(sent.error).toBeUndefined()
    await waitFor(async () => fs.readFileSync(streamFile(sid), 'utf-8').includes('"result":"second-cloud-turn"'), 60_000, 'second turn')

    // The Mac reads the conversation back through the tunnel.
    const history = await waitFor(async () => {
      const h = await (await api(`/api/sessions/${sid}/history`)).text()
      return h.includes('second-cloud-turn') ? h : null
    }, 30_000, 'history through the tunnel')
    expect(history).toContain('first-cloud-turn')
  }, 240_000)

  it('survives the network between Mac and companion dying mid-session', async () => {
    const pidOf = () => cliPidOf(sid)
    const cliPid = pidOf()
    expect(cliPid).toBeGreaterThan(1)

    cutProxy()
    await waitFor(async () => { const s = await cloudStatus(); return s && !s.connected ? s : null }, 60_000, 'the drop to show')
    await waitFor(async () => { const s = await cloudStatus(); return s?.connected ? s : null }, 120_000, 'the reconnect')

    const sent = await rpc('session:send', { sessionId: sid, message: 'snapshot-clean-turn:after-the-cut' })
    expect(sent.error).toBeUndefined()
    await waitFor(async () => fs.readFileSync(streamFile(sid), 'utf-8').includes('"result":"after-the-cut"'), 90_000, 'a turn after the reconnect')
    // Same process: the session lived on the box the whole time.
    expect(pidOf()).toBe(cliPid)
    process.kill(cliPid!, 0)
  }, 300_000)

  /** One turn through the Mac after the box changed under it, on the same CLI. */
  async function turnLandsOnSameCli(cliPid: number, text: string): Promise<void> {
    await waitFor(async () => (await cloudStatus())?.connected, 120_000, 'the Mac back on Cloud')
    const sent = await rpc('session:send', { sessionId: sid, message: `snapshot-clean-turn:${text}` })
    expect(sent.error).toBeUndefined()
    await waitFor(async () => fs.readFileSync(streamFile(sid), 'utf-8').includes(`"result":"${text}"`), 90_000, `the turn "${text}"`)
    expect(cliPidOf(sid)).toBe(cliPid)
    expect(alive(cliPid)).toBe(true)
  }

  it('a companion restart (systemd, same build) keeps the box daemon and its CLI; the Mac re-attaches to the same process', async () => {
    const cliPid = cliPidOf(sid)!
    const daemon = replica.tunnelDaemon()
    expect(daemon.pid).toBeGreaterThan(1)
    const oldPort = replica.port

    // SIGTERM to the server alone, as KillMode=process does; a new server starts.
    await replica.restart()
    expect(replica.port).not.toBe(oldPort)
    expect(alive(daemon.pid!)).toBe(true)
    expect(alive(cliPid)).toBe(true)

    await turnLandsOnSameCli(cliPid, 'after-a-restart')
    // The new server adopted the running daemon: same process, same instance, no second one.
    expect(replica.tunnelDaemon()).toEqual(daemon)
    expect(replica.log()).toMatch(new RegExp(`local daemon already running[^\\n]*${daemon.instanceId}`))
  }, 300_000)

  it.skipIf(!findBun())('a companion on a new build replaces the box daemon, which adopts the CLI: same process, still talkable', async () => {
    const cliPid = cliPidOf(sid)!
    const before = replica.tunnelDaemon()
    const next = 'walnut-daemon-e2e-release-2'
    const binary = await stageDaemonRelease(daemonBuild!, path.join(base, 'release-2'), next)

    await replica.restart({ binary, version: next })
    // The Mac's redial reaches the new server, which finds the daemon on the old
    // build, stops it, and starts the new one. The old one leaves its CLI behind.
    const after = await waitFor(async () => {
      const d = replica.tunnelDaemon()
      return d.pid && d.pid !== before.pid && d.instanceId && d.instanceId !== before.instanceId ? d : null
    }, 120_000, 'the daemon on the new build')
    expect(alive(before.pid!)).toBe(false)
    expect(alive(after.pid!)).toBe(true)
    expect(replica.log()).toMatch(new RegExp(`local daemon version mismatch — restarting[^\\n]*${before.instanceId}`))

    await turnLandsOnSameCli(cliPid, 'after-an-upgrade')
    expect(replica.tunnelDaemon()).toEqual(after)
  }, 300_000)

  it('the adopted legacy credential revoked and minted again stays on the same daemon: same CLI, no keyed dir', async () => {
    const cliPid = cliPidOf(sid)!
    const before = replica.tunnelDaemon()
    const cache = path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json')
    const token = () => (JSON.parse(fs.readFileSync(cache, 'utf-8')) as Record<string, string>)['bridge-local']
    const old = token()
    // The Mac (the owner now) revokes it on the companion, as a rotation elsewhere would.
    const r = await fetch(`http://127.0.0.1:${proxyPort}/api/devices/bridge-local`, { method: 'DELETE', headers: { Authorization: `Bearer ${replica.tokens.mac}` } })
    expect(r.status).toBe(200)
    // The redial hears 401, drops the token, mints a new one as the owner.
    await waitFor(async () => { const t = token(); return t && t !== old && (await cloudStatus())?.connected }, 120_000, 'the Mac back on Cloud with a new credential')
    const cred = replica.devices().find((d) => d.name === 'bridge-local')!
    expect(cred.ownerId).toBe(replica.ids['mac-primary'])
    expect(cred.daemonKey).toBeUndefined()
    await turnLandsOnSameCli(cliPid, 'after-a-legacy-remint')
    expect(replica.tunnelDaemon()).toEqual(before)
    expect(fs.existsSync(`${replica.box.tunnelDir}.by-device`)).toBe(false)
  }, 300_000)

  it('the phone sees Cloud once, not a second row for the same box', async () => {
    // Relayed to the Mac over its local daemon's /bridge socket. A real Mac has
    // that connection up from its own sessions; a vitest server has no host
    // warmup, so connect it the way the product's lazy callers do
    // (core/routines/trigger-daemon.ts). Its first push dials /bridge.
    const { getDaemonConnection } = await import('../../src/providers/daemon-connection.js')
    await getDaemonConnection('__local__', { hostname: '__local__' })
    const body = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/sessions/launch-options`, { headers: { Authorization: `Bearer ${replica.tokens.phone}` } })
      const b = await r.json() as { hosts?: Array<{ alias: string; label: string }>; primaryOffline?: boolean }
      return r.status === 200 && !b.primaryOffline ? b : null
    }, 90_000, 'launch options relayed from the Mac')
    const aliases = (body.hosts ?? []).map((h) => h.alias)
    expect(aliases).toContain(CLOUD_BOX_HOST_ALIAS)
    expect(aliases).not.toContain('__cloud__')
  }, 120_000)

  it('stops the session through the box daemon', async () => {
    const r = await post(`/api/v1/sessions/${sid}/terminate`, {})
    expect([200, 202]).toContain(r.status)
    await waitFor(async () => {
      const rec = await (await api(`/api/sessions/${sid}`)).json() as { process_status?: string; session?: { process_status?: string } }
      const ps = rec.process_status ?? rec.session?.process_status
      return ps === 'stopped' ? ps : null
    }, 60_000, 'the session to stop')
  }, 120_000)

  it('cloud.exec turned off on the box: the tunnel answers 403 and the Mac says hosting is off', async () => {
    const cfgPath = path.join(replica.box.data, 'config.yaml')
    const original = await fsp.readFile(cfgPath, 'utf-8')
    await fsp.writeFile(cfgPath, original.replace('enabled: true', 'enabled: false'))
    try {
      // The Mac's current machine token (the case above had it minted anew).
      const current = (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'), 'utf-8')) as Record<string, string>)['bridge-local']
      expect(await dialTunnel(current)).toMatchObject({ status: 403, refusal: 'cloud_exec_off' })
      // The open tunnel closes too, within one replica heartbeat (30s): off means
      // off. The Mac's redial hears the 403 and says so.
      const s = await waitFor(async () => { const st = await cloudStatus(); return st && !st.connected && st.error ? st : null }, 120_000, 'the Mac to hear hosting is off')
      expect(String(s.error)).toMatch(/Cloud companion has session hosting turned off/)
      expect(s.kind).toBe('cloud_exec_off')
      const launch = await (await fetch(`http://127.0.0.1:${proxyPort}/api/v1/status`, { headers: { Authorization: `Bearer ${replica.tokens.phone}` } })).json() as Record<string, unknown>
      expect(launch.daemonTunnel).toEqual({ enabled: false, reason: 'not_enabled' })
      // The box daemon (and its sessions) outlive the closed tunnel.
      const pid = Number(fs.readFileSync(path.join(replica.box.tunnelDir, 'daemon.pid'), 'utf-8').trim())
      process.kill(pid, 0)
    } finally {
      await fsp.writeFile(cfgPath, original)
    }
    // Hosting back on: the next probe clears the refusal, and opening the
    // picker on Cloud (a listing) connects again.
    await refreshCloudBoxHost()
    await waitFor(async () => {
      const r = await api(`/api/sessions/list-dirs?host=${CLOUD_BOX_HOST_ALIAS}&prefix=${encodeURIComponent(replica.box.projects + '/')}`)
      return r.status === 200 && (await cloudStatus())?.connected
    }, 120_000, 'Cloud back after hosting is on again')
  }, 300_000)
})
