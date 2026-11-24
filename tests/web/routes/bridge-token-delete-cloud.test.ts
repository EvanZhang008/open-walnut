/**
 * The companion's side of a revoked host's bridge token delete, on a real CLOUD_MODE server.
 *
 * When the leader revokes a host (session-channel/leader-issue.ts revokeHostDoorNow), it deletes
 * that host's `bridge-<alias>` machine token at the companion with the request
 * cloud-bridge-config.ts revokeBridgeTokens sends: DELETE /api/devices/bridge-<alias>, the Mac's
 * device token as the bearer and its bridge-local token as the machine proof. Pinned here, on the
 * companion, for a host linked on both doors its token opens (/bridge and /host-listen):
 *
 *   - the delete closes both open sockets at once (devices.ts -> machine-credentials.ts
 *     revokeMachineCredential -> notifyRevoked -> bridge-registry.ts watchBridgeRevocations and
 *     listener-door.ts's revoke listener), with no reconnect needed;
 *   - nothing the companion relays reaches the host any more (a phone command over the bridge, a
 *     call over its listener link), the host's rows are forgotten, and the backup leader no longer
 *     counts it among the hosts it could lead;
 *   - a new dial with the old token is refused on both doors (401), and so is its use on the REST
 *     API;
 *   - another host's link (the Mac's own bridge) is not touched.
 *
 * The companion keeps no ban list of its own: whoever leads, a revoked host reaches it only with a
 * token it holds, so the deleted token is the whole ban here.
 *
 * auth.json is written fresh (tokens known to the test, ids made up); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-token-delete-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { MACHINE_PROOF_HEADER } from '../../../src/core/machine-credentials.js'
import { bridgeForHost, bridgeHosts, bridgeRequest } from '../../../src/web/ws/bridge-registry.js'
import { getBackupLeader } from '../../../src/core/leader/backup-leader.js'
import { listenerDoorWalnut } from '../../../src/core/session-channel/listener-door.js'
import { _resetCompanionListenerForTesting, callListenedHost, claimedBy, ListenerNotLinked, listenedRow, listenerLinked } from '../../../src/core/session-channel/companion-listener.js'

let server: HttpServer
let port = 0
let sshIsolation: SshIsolation | null = null

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { mac: tok(), local: tok(), devbox: tok() }
const MAC_ID = 'd00000000000000a1'
const WALNUT = 'ab'.repeat(16)

async function seed(): Promise<void> {
  const now = new Date().toISOString()
  const devices = [
    { name: 'mac-primary', id: MAC_ID, tokenHash: sha(T.mac), createdAt: now, platform: 'other', info: { model: 'Mac15,3', os: 'macOS 26.0' } },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine', ownerId: MAC_ID },
    { name: 'bridge-devbox', id: 'd00000000000000e5', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine', ownerId: MAC_ID },
  ]
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices }), { mode: 0o600 })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  _resetDeviceAuthForTesting()
}

let ip = 0
/** Each dial from its own address: the auth failures this test causes never rate limit the next one. */
const fromAddress = () => ({ 'x-forwarded-for': `203.0.113.${(++ip % 250) + 1}` })

interface Dialed { ws: WebSocket; frames: Record<string, unknown>[]; opened: Promise<number | 'open'>; closed: Promise<number> }

/** Dial `door` with `token`; `opened` is 'open' or the refusal's HTTP status, `closed` the close code. */
function dial(door: '/bridge' | '/host-listen', token: string, onFrame?: (d: Dialed, f: Record<string, unknown>) => void): Dialed {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${door}`, { headers: { authorization: `Bearer ${token}`, ...fromAddress() } })
  const frames: Record<string, unknown>[] = []
  let d!: Dialed
  const opened = new Promise<number | 'open'>((resolve) => {
    ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
    ws.on('open', () => resolve('open'))
  })
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  ws.on('error', () => { /* a refusal or a close follows */ })
  d = { ws, frames, opened, closed }
  ws.on('message', (m) => {
    let f: Record<string, unknown>
    try { f = JSON.parse(String(m)) } catch { return }
    frames.push(f)
    onFrame?.(d, f)
  })
  return d
}

/** A host's daemon on /bridge: dials and says its hello. */
async function bridgeOf(alias: string, token: string): Promise<Dialed> {
  const d = dial('/bridge', token)
  expect(await d.opened).toBe('open')
  d.ws.send(JSON.stringify({ ev: 'hello', hostAlias: alias, sids: [] }))
  await vi.waitFor(() => expect(bridgeForHost(alias).connected).toBe(true), { timeout: 10_000 })
  return d
}

/**
 * `p`, or a throw once `ms` passed: a close that only the credential clocks would bring (the
 * bridge's 30 s recheck, the listener's LISTEN_RECHECK_MS) fails the test instead of passing late.
 */
async function before<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms) })
  try { return await Promise.race([p, late]) } finally { clearTimeout(timer) }
}

const row = { claudeSessionId: 's-devbox-1', taskId: 't1', judge: 'host', host: 'devbox', process_status: 'idle', startedAt: '', lastActiveAt: '' }

/** The host's service on /host-listen: the door hello, its channel hello, then its rows. */
async function listenerOf(): Promise<Dialed> {
  const d = dial('/host-listen', T.devbox, (me, f) => {
    if (f.op === 'welcome') me.ws.send(JSON.stringify({ ch: 'sf', op: 'hello', walnutId: WALNUT, hostId: 'devbox', logId: 'L', floor: 1, head: 1 }))
    if (f.op === 'listen') me.ws.send(JSON.stringify({ ch: 'sf', op: 'rows', rows: [row], upTo: 1, rowsAt: 1, logId: 'L' }))
  })
  expect(await d.opened).toBe('open')
  d.ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 1, role: 'listener', walnutId: WALNUT, hostAlias: 'devbox' }))
  await vi.waitFor(() => expect(listenedRow(row.claudeSessionId)).toMatchObject({ alias: 'devbox' }), { timeout: 10_000 })
  return d
}

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await seed()
  _resetCompanionListenerForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)

afterAll(async () => {
  await stopServer()
  sshIsolation?.restore()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a revoked host\'s bridge token deleted at the companion', () => {
  it('closes its open sockets at once, cuts every relay to it, refuses the old token everywhere, and leaves the Mac\'s own bridge up', async () => {
    const mac = await bridgeOf('__local__', T.local)
    // The Mac's heartbeat names its Walnut with the switch on: the listener door is open.
    ;(await getBackupLeader())!.noteHeartbeat({ walnutId: WALNUT, hostRunsSessions: true })
    await vi.waitFor(async () => expect(await listenerDoorWalnut()).toBe(WALNUT))

    const bridge = await bridgeOf('devbox', T.devbox)
    const listener = await listenerOf()
    expect(listenerLinked('devbox')).toBe(true)
    expect(bridgeHosts({ executionOnly: true }).map((h) => h.hostAlias)).toContain('devbox')

    // The leader's delete, as revokeBridgeTokens sends it.
    const del = await fetch(`http://127.0.0.1:${port}/api/devices/bridge-devbox`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${T.mac}`, [MACHINE_PROOF_HEADER]: T.local, ...fromAddress() },
    })
    expect(del.status).toBe(200)

    // Both sockets close now, not at the host's next dial or the credential clock.
    expect(await before(bridge.closed, 10_000, 'the bridge socket closes')).toBe(4001)
    expect(await before(listener.closed, 10_000, 'the listener socket closes')).toBe(4003)

    // Nothing the companion relays reaches it: a phone's command, a call on its listener link.
    expect(bridgeForHost('devbox').connected).toBe(false)
    await expect(bridgeRequest('devbox', 'ping', {}, 2_000)).rejects.toThrow()
    expect(listenerLinked('devbox')).toBe(false)
    expect(listenedRow(row.claudeSessionId)).toBeNull()
    expect(await claimedBy(row.claudeSessionId)).toBeNull()
    await expect(callListenedHost('devbox', '/send', { sid: row.claudeSessionId, text: 'hi' }, 2_000)).rejects.toBeInstanceOf(ListenerNotLinked)
    // Not among the hosts the backup leader could lead while the Mac is away.
    expect(bridgeHosts({ executionOnly: true }).map((h) => h.hostAlias)).not.toContain('devbox')

    // The old token opens neither door again, nor the REST API.
    expect(await dial('/bridge', T.devbox).opened).toBe(401)
    expect(await dial('/host-listen', T.devbox).opened).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { headers: { Authorization: `Bearer ${T.devbox}`, ...fromAddress() } })).status).toBe(401)

    // The Mac's own bridge is another credential: still up.
    expect(bridgeForHost('__local__').connected).toBe(true)
    expect(mac.ws.readyState).toBe(WebSocket.OPEN)
    mac.ws.close()
  }, 60_000)
})
