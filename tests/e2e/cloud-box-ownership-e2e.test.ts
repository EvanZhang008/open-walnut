/**
 * One companion serves one Mac, end to end (core/machine-credentials.ts).
 *
 *   this primary (startServer) = the SECOND Mac, `mac-second`, paired with the
 *   companion but holding no machine credential ──▶ replica (real child process,
 *   WALNUT_CLOUD_MODE=1) whose machine credentials belong to `mac-primary`
 *
 * What it proves, on the real auth.json, the real routes and the real tunnel:
 *  1. the second Mac is refused (409, the host card sentence) and never reaches
 *     the first Mac's daemon; a phone is refused minting and revoking outright,
 *     and neither re-pairing the first Mac's name nor removing it gets it anywhere;
 *  2. the second Mac may not remove the first one either (403, from its own
 *     console); the first Mac unpairing itself is the handover: its open tunnel
 *     closes at once (4401), and this Mac mints and gets a daemon of its own, in
 *     its own dir (keyed by its device id), which its session's CLI does not
 *     inherit the daemon's keep switch from;
 *  3. a revoked machine credential closes this Mac's open tunnel at once (a fresh
 *     close, told by the revoke, not the heartbeat); the Mac hears 401, re-mints
 *     once, and is back on the SAME daemon, the session still talkable.
 *
 * Isolation as in cloud-box-tunnel-e2e.test.ts: one temp base, fresh auth.json,
 * no pid in any fixture, only the CLI is a mock.
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
import { buildTestDaemon, stageDaemonRelease } from '../helpers/cloud-box-daemon-build.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloudbox-owner'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { CLOUD_BOX_HOST_ALIAS, CLOUD_BOX_OTHER_MAC_SENTENCE, TUNNEL_PROBE_HEADER, TUNNEL_REFUSAL_HEADER } from '../../src/core/hosts/cloud-box-host.js'
import { refreshCloudBoxHost } from '../../src/core/hosts/cloud-box-probe.js'

let base = ''
let replica: CloudBoxReplica
let primaryPort = 0
let companion = ''

const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${primaryPort}${p}`, init)
/** Straight to the companion, as a given device. */
const box = (p: string, bearer: string, init: RequestInit = {}) => fetch(`http://${companion}${p}`, {
  ...init, headers: { 'content-type': 'application/json', Authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
})

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
  const body = await (await api('/api/hosts/status')).json() as { hosts?: Array<Record<string, unknown>> }
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

/** Dial /daemon-tunnel with a token; `probe` asks only whether the token is valid. */
function dialTunnel(token: string, probe = false): Promise<{ status: number; refusal?: string; ws?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${companion}/daemon-tunnel`, { headers: { Authorization: `Bearer ${token}`, ...(probe ? { [TUNNEL_PROBE_HEADER]: 'credential' } : {}) } })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('tunnel dial hung')) }, 60_000)
    ws.on('unexpected-response', (_q, res) => {
      clearTimeout(t)
      const h = res.headers[TUNNEL_REFUSAL_HEADER]
      res.resume()
      resolve({ status: res.statusCode ?? 0, refusal: typeof h === 'string' ? h : undefined })
    })
    ws.on('open', () => { clearTimeout(t); resolve({ status: 101, ws }) })
    ws.on('error', () => { /* unexpected-response answers */ })
  })
}

const cachedToken = () => (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'), 'utf-8')) as Record<string, string>)['bridge-local']
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cloudbox-e2e-'))
  // The box runs the CURRENT daemon source when bun is here (what it spawns its CLIs with is under test).
  const build = await buildTestDaemon(path.join(base, 'daemon-build'))
  const release = build
    ? { binary: await stageDaemonRelease(build, path.join(base, 'release-1'), 'walnut-daemon-owner-e2e'), version: 'walnut-daemon-owner-e2e' }
    : undefined
  replica = await startCloudBoxReplica(base, release, { machineOwner: 'mac-primary' })
  companion = `127.0.0.1:${replica.port}`

  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\ndefaults:\n  priority: none\n')
  // This Mac is `mac-second`: paired, but it never minted a machine credential here.
  await seedPrimaryPairing(WALNUT_HOME, companion, replica.tokens, { as: 'mac-second', secondMac: replica.tokens.secondMac, cachedMachineToken: false })

  const server = await startServer({ port: 0, dev: true })
  primaryPort = (server.address() as net.AddressInfo).port
}, 420_000)

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  await replica?.stop()
  if (process.env.DEBUG_BOX) process.stderr.write(replica?.log().slice(-8000) ?? '')
}, 60_000)

describe('one companion serves one Mac', () => {
  it('a second Mac is refused with the card sentence and never reaches the first Mac\'s daemon', async () => {
    await refreshCloudBoxHost()
    await api(`/api/hosts/${CLOUD_BOX_HOST_ALIAS}/connect`, { method: 'POST' })
    const st = await waitFor(async () => {
      const s = await cloudStatus()
      return s && !s.connected && s.kind === 'cloud_other_mac' ? s : null
    }, 60_000, 'the Cloud card to say another Mac is connected')
    expect(st.error).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    expect(String(st.hint)).toMatch(/runs sessions for another Mac/)

    // Every way a device might take the credential over is refused.
    const s = replica.tokens.secondMac
    for (const [p, init] of [
      ['/api/devices', { method: 'POST', body: JSON.stringify({ name: 'bridge-local', kind: 'machine', replace: true }) }],
      ['/api/devices', { method: 'POST', body: JSON.stringify({ name: 'bridge-local', replace: true }) }],
      ['/api/devices', { method: 'POST', body: JSON.stringify({ name: 'bridge-new', kind: 'machine' }) }],
      ['/api/devices/bridge-local', { method: 'DELETE' }],
      ['/api/devices/bridge-local/adopt', { method: 'POST', headers: { 'x-walnut-machine-proof': replica.tokens.primaryMachine } }],
    ] as Array<[string, RequestInit]>) {
      const r = await box(p, s, init)
      expect(r.status, `${init.method} ${p}`).toBe(409)
      expect(await r.json()).toEqual({ error: CLOUD_BOX_OTHER_MAC_SENTENCE, code: 'other_mac_connected' })
    }
    // The first Mac's credential is untouched, and no daemon ran for anyone.
    expect(await dialTunnel(replica.tokens.primaryMachine, true)).toMatchObject({ status: 204 })
    expect(replica.devices().find((d) => d.name === 'bridge-local')).toMatchObject({ ownerId: replica.ids['mac-primary'], daemonKey: replica.ids['mac-primary'] })
    expect(fs.existsSync(replica.daemonDirOf('mac-second'))).toBe(false)
    expect(replica.tunnelDaemon().pid).toBeNull()
  }, 180_000)

  it('a phone can neither mint nor revoke a machine credential, nor take the Mac\'s pairing', async () => {
    const p = replica.tokens.phone
    const refused = `Only mac-primary itself or the Mac this companion serves can remove or re-pair mac-primary. On the companion, \`walnut device revoke mac-primary\` works too.`
    // Re-pairing the first Mac's name, or removing it: refused, and its token still works.
    for (const init of [
      { method: 'POST', body: JSON.stringify({ name: 'mac-primary', replace: true }) },
      { method: 'DELETE' },
    ] as RequestInit[]) {
      const r = await box(init.method === 'POST' ? '/api/devices' : '/api/devices/mac-primary', p, init)
      expect(r.status, `${init.method} mac-primary`).toBe(403)
      expect(await r.json()).toEqual({ error: refused, code: 'device_change_refused' })
    }
    expect((await box('/api/devices', replica.tokens.mac)).status).toBe(200)
    // Clearing its report, or reporting a Mac, leaves it the phone it claimed to be.
    for (const report of [{ model: 'iPhone17,1', os: 'iOS 26.1' }, {}, { model: 'Mac15,3', os: 'macOS 26.0' }]) {
      expect((await box('/api/v1/devices/self', p, { method: 'POST', body: JSON.stringify(report) })).status).toBe(200)
      for (const [path_, init] of [
        ['/api/devices', { method: 'POST', body: JSON.stringify({ name: 'bridge-phone', kind: 'machine' }) }],
        ['/api/devices', { method: 'POST', body: JSON.stringify({ name: 'bridge-local', replace: true }) }],
        ['/api/devices/bridge-local', { method: 'DELETE' }],
      ] as Array<[string, RequestInit]>) {
        const r = await box(path_, p, init)
        expect(r.status, `${init.method} ${path_} after ${JSON.stringify(report)}`).toBe(403)
        expect((await r.json() as { code?: string }).code).toBe('phone_cannot_mint')
      }
    }
    expect(replica.devices().find((d) => d.name === 'my-phone')).toMatchObject({ platform: 'ios', id: replica.ids['my-phone'] })
    expect(replica.devices().map((d) => d.name).sort()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'my-phone'])
  }, 60_000)

  let sid = ''
  let ownDaemonPid = 0

  it('the first Mac unpairing itself hands the companion over: its tunnel closes at once, this Mac gets a daemon of its own', async () => {
    // The first Mac is on its daemon (its own dir, keyed by its device id).
    const first = await dialTunnel(replica.tokens.primaryMachine)
    expect(first.status).toBe(101)
    const firstDaemon = replica.tunnelDaemon('mac-primary')
    expect(firstDaemon.pid).toBeGreaterThan(1)
    expect(fs.existsSync(path.join(`${replica.box.tunnelDir}.by-device`, replica.ids['mac-primary'], 'daemon', 'daemon.pid'))).toBe(true)
    const closed = new Promise<number>((resolve) => first.ws!.once('close', (code) => resolve(code)))

    // This Mac may not remove the other one: its console relays the companion's 403.
    const refusedHere = await api('/api/devices/mac-primary?target=cloud', { method: 'DELETE' })
    expect(refusedHere.status).toBe(403)
    expect(await refusedHere.json()).toEqual({
      error: 'Only mac-primary itself or the Mac this companion serves can remove or re-pair mac-primary. On the companion, `walnut device revoke mac-primary` works too.',
      code: 'device_change_refused',
    })
    expect(replica.devices().map((d) => d.name).sort()).toEqual(['bridge-devbox', 'bridge-local', 'mac-primary', 'mac-second', 'my-phone'])

    // The first Mac unpairs itself (its own console's "Disconnect", with its own token).
    const t0 = Date.now()
    const r = await box('/api/devices/mac-primary', replica.tokens.mac, { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect(await closed).toBe(4401)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(replica.devices().map((d) => d.name).sort()).toEqual(['mac-second', 'my-phone'])

    // Retry: this Mac mints and connects, to a daemon in its own dir.
    await api(`/api/hosts/${CLOUD_BOX_HOST_ALIAS}/connect`, { method: 'POST' })
    await waitFor(async () => (await cloudStatus())?.connected, 90_000, 'Cloud connected after the handover')
    expect(replica.devices().find((d) => d.name === 'bridge-local')).toMatchObject({ kind: 'machine', ownerId: replica.ids['mac-second'], daemonKey: replica.ids['mac-second'] })
    expect(replica.devices().find((d) => d.name === 'mac-second')).toMatchObject({ id: replica.ids['mac-second'], tunnelDaemon: { key: replica.ids['mac-second'] } })
    const mine = replica.tunnelDaemon('mac-second')
    expect(mine.pid).toBeGreaterThan(1)
    expect(mine.pid).not.toBe(firstDaemon.pid)
    ownDaemonPid = mine.pid!

    // A session here lives in this Mac's dir, and its CLI does not inherit the
    // daemon's keep-sessions switch.
    const q = await api('/api/sessions/quick-start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: path.join(replica.box.projects, 'alpha'), host: CLOUD_BOX_HOST_ALIAS, message: 'snapshot-clean-turn:mine keep={env:WALNUT_DAEMON_KEEP_SESSIONS}', overrideReadiness: true }),
    })
    const body = await q.json() as { sessionId?: string }
    expect(q.status, JSON.stringify(body)).toBe(200)
    sid = body.sessionId!
    await waitFor(async () => fs.existsSync(replica.streamFile(sid, 'mac-second')) && fs.readFileSync(replica.streamFile(sid, 'mac-second'), 'utf-8').includes('"result":"mine keep=<unset>"'), 90_000, 'the first turn in this Mac\'s own streams dir')
    expect(fs.existsSync(replica.streamFile(sid, 'mac-primary'))).toBe(false)
    expect(fs.existsSync(replica.streamFile(sid))).toBe(false)
  }, 300_000)

  it('a revoked machine credential closes this Mac\'s tunnel; it re-mints once and is back on the same daemon', async () => {
    const before = cachedToken()
    expect(before).toBeTruthy()
    const closes = () => (replica.log().match(/credential_revoked/g) ?? []).length
    const closesBefore = closes()
    // The owner revokes its own credential (as a rotation elsewhere would).
    const t0 = Date.now()
    const r = await box('/api/devices/bridge-local', replica.tokens.secondMac, { method: 'DELETE' })
    expect(r.status).toBe(200)
    // A FRESH close, told by the revoke itself: the heartbeat would take up to 30s.
    await waitFor(async () => closes() > closesBefore, 5_000, 'the replica to close the revoked tunnel')
    expect(Date.now() - t0).toBeLessThan(5_000)
    // The redial hears 401, drops the dead token, mints a new one, and connects.
    await waitFor(async () => {
      const s = await cloudStatus()
      const t = cachedToken()
      return s?.connected && t && t !== before ? s : null
    }, 120_000, 'the Mac back on Cloud with a new machine credential')
    expect(await dialTunnel(before, true)).toMatchObject({ status: 401 })
    expect(await dialTunnel(cachedToken(), true)).toMatchObject({ status: 204 })
    // Same daemon, same CLI: nothing on the box was restarted.
    expect(replica.tunnelDaemon('mac-second').pid).toBe(ownDaemonPid)
    expect(alive(ownDaemonPid)).toBe(true)
    const sent = await rpc('session:send', { sessionId: sid, message: 'snapshot-clean-turn:after-the-revoke' })
    expect(sent.error).toBeUndefined()
    await waitFor(async () => fs.readFileSync(replica.streamFile(sid, 'mac-second'), 'utf-8').includes('"result":"after-the-revoke"'), 90_000, 'a turn after the re-mint')
  }, 300_000)
})
