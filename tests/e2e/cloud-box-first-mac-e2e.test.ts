/**
 * A new companion the box operator paired with `walnut device add` (no
 * `--owner`): the first Mac to connect is its owner, end to end
 * (core/machine-credentials.ts, "first come").
 *
 *   this primary (startServer) = `mac-primary`, paired by `walnut device add`,
 *   holding no machine credential yet ──▶ replica (real child process,
 *   WALNUT_CLOUD_MODE=1) whose auth.json is exactly what a build without owners
 *   writes after `walnut device add` (two Macs and a phone, no owner)
 *
 * Builds before owners were recorded let the first Mac to mint have the box.
 * The 2026-10-05 gate found the round before that refusing it instead: no
 * owner was ever recorded, so the Mac heard 409 companion_has_no_owner forever.
 * What this proves, on the real auth.json, routes and tunnel:
 *  1. a phone is never the first: 403, and nothing is recorded;
 *  2. this Mac connects: its mint is answered 201, it is recorded the owner
 *     ('mint'), and it gets a daemon of its own (keyed by its device id);
 *  3. the second Mac then hears that another Mac is connected (409).
 *
 * Isolation as in cloud-box-ownership-e2e.test.ts: one temp base, fresh
 * auth.json, no pid in any fixture, only the CLI is a mock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { buildTestDaemon, stageDaemonRelease } from '../helpers/cloud-box-daemon-build.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloudbox-first-mac'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { CLOUD_BOX_HOST_ALIAS } from '../../src/core/hosts/cloud-box-host.js'
import { refreshCloudBoxHost } from '../../src/core/hosts/cloud-box-probe.js'
import { OTHER_COMPUTER_CONNECTED, OTHER_MAC_CONNECTED } from '../../src/core/machine-credentials.js'

/**
 * What the second Mac hears names the owner as it reported itself
 * (device-self-report.ts): the owner here is this process, a Mac on a Mac and
 * Linux on CI, where the companion truthfully says "Another computer".
 */
const OTHER_OWNER_CONNECTED = process.platform === 'darwin' ? OTHER_MAC_CONNECTED : OTHER_COMPUTER_CONNECTED

let base = ''
let isolation: SshIsolation | null = null
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

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cloudbox-first-'))
  const build = await buildTestDaemon(path.join(base, 'daemon-build'))
  const release = build
    ? { binary: await stageDaemonRelease(build, path.join(base, 'release-1'), 'walnut-daemon-first-mac-e2e'), version: 'walnut-daemon-first-mac-e2e' }
    : undefined
  replica = await startCloudBoxReplica(base, release, { fresh: true })
  companion = `127.0.0.1:${replica.port}`

  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\ndefaults:\n  priority: none\n')
  // This Mac is `mac-primary`, paired by `walnut device add`: no machine credential yet.
  await seedPrimaryPairing(WALNUT_HOME, companion, replica.tokens, { cachedMachineToken: false })

  isolation = isolateFromRealSsh(base)
}, 420_000)

/**
 * This Mac boots in the second test, not here: a primary links its own daemon at
 * boot with no session needed (284df511e, local-daemon-lane.ts), and that link
 * mints its machine credential at once, so a boot here would make this Mac the
 * owner before the phone could try to be the first.
 */
async function bootThisMac(): Promise<void> {
  const server = await startServer({ port: 0, dev: true })
  primaryPort = (server.address() as net.AddressInfo).port
}

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  await replica?.stop()
  isolation?.restore()
  if (process.env.DEBUG_BOX) process.stderr.write(replica?.log().slice(-8000) ?? '')
}, 60_000)

describe('a companion paired by `walnut device add`, with no owner recorded', () => {
  it('a phone is never the first: 403, and no owner is recorded', async () => {
    const r = await box('/api/devices', replica.tokens.phone, { method: 'POST', body: JSON.stringify({ name: 'bridge-phone', kind: 'machine' }) })
    expect(r.status).toBe(403)
    expect((await r.json() as { code?: string }).code).toBe('phone_cannot_mint')
    expect(replica.owner()).toBeUndefined()
    expect(replica.devices().map((d) => d.name)).toEqual(['mac-primary', 'mac-second', 'my-phone'])
  }, 60_000)

  it('this Mac connects first: its mint lands, it is recorded the owner by that mint, on a daemon of its own', async () => {
    await bootThisMac()
    await refreshCloudBoxHost()
    await api(`/api/hosts/${CLOUD_BOX_HOST_ALIAS}/connect`, { method: 'POST' })
    const st = await waitFor(async () => {
      const s = await cloudStatus()
      return s?.connected ? s : null
    }, 120_000, 'Cloud connected on a companion with no owner recorded')
    expect(String(st.error ?? st.lastError ?? '')).not.toMatch(/no owner/i)
    expect(replica.owner()).toEqual({ id: replica.ids['mac-primary'], via: 'mint' })
    expect(replica.devices().find((d) => d.name === 'bridge-local')).toMatchObject({ kind: 'machine', ownerId: replica.ids['mac-primary'], daemonKey: replica.ids['mac-primary'] })
    expect(replica.devices().find((d) => d.name === 'mac-primary')).toMatchObject({ tunnelDaemon: { key: replica.ids['mac-primary'] } })
    expect(replica.tunnelDaemon('mac-primary').pid).toBeGreaterThan(1)
    expect(fs.existsSync(replica.daemonDirOf('mac-second'))).toBe(false)
  }, 240_000)

  it('the second Mac then hears another Mac is connected, and takes nothing', async () => {
    const r = await box('/api/devices', replica.tokens.secondMac, { method: 'POST', body: JSON.stringify({ name: 'bridge-second', kind: 'machine' }) })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: OTHER_OWNER_CONNECTED, code: 'other_mac_connected' })
    expect(replica.owner()).toEqual({ id: replica.ids['mac-primary'], via: 'mint' })
    // Every machine credential there is this Mac's (its own daemon's and the companion host's), none the second Mac's.
    const creds = replica.devices().filter((d) => d.kind === 'machine')
    expect(creds.map((d) => d.name)).toContain('bridge-local')
    expect(creds.map((d) => d.name)).not.toContain('bridge-second')
    for (const c of creds) expect(c.ownerId, c.name).toBe(replica.ids['mac-primary'])
  }, 60_000)
})
