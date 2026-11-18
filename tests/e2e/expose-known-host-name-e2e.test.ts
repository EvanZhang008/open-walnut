/**
 * Where the tunnel runs is said by the name the person knows the machine by (2026-11-18, the
 * user read "Connected through <tunnel>, runs on <alias>." where the alias was a row Walnut found
 * in ~/.ssh/config for a machine he named under another row; core/hosts/known-host.ts).
 *
 * One machine, two config.yaml rows: `found-box`, found in ~/.ssh/config, whose hostname the
 * provider names as always on (so the tunnel is placed there), and `big-box`, the row the person
 * named "Big box". Their daemon said they are one (host profile `sameDaemon`). Real server; the
 * hosts never connect.
 *
 *   GET /api/expose        places and the status (moving there, its note) say "Big box", once
 *   GET /api/host-servers  the found row names the machine it is (`knownAs`), its view says "Big box"
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'
import { registerExposeProvider } from '../../src/core/expose/registry.js'
import { getHostServerManager } from '../../src/core/host-server/index.js'
import { HOST_PROFILES_DIR } from '../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest, linkIdentityOf } from '../../src/core/hosts/same-daemon-record.js'
import { resetKnownHostsForTest } from '../../src/core/hosts/known-host.js'

let server: HttpServer
let port: number
let registration: { dispose(): void }

const api = (p: string) => fetch(`http://localhost:${port}${p}`)
const expose = async () => (await (await api('/api/expose')).json()) as Record<string, any>
const hosts = async () => ((await (await api('/api/host-servers')).json()).hosts as Array<Record<string, any>>)

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** The daemon's word that two aliases are one daemon, as the link records it. */
async function recordOneDaemon(a: string, b: string): Promise<void> {
  const rows = (await getConfig()).hosts as Record<string, never>
  const ids = { [a]: await linkIdentityOf(a, rows[a]), [b]: await linkIdentityOf(b, rows[b]) }
  expect(ids[a]).toBeTruthy()
  expect(ids[b]).toBeTruthy()
  await fs.mkdir(HOST_PROFILES_DIR, { recursive: true })
  for (const [self, other] of [[a, b], [b, a]]) {
    await fs.writeFile(path.join(HOST_PROFILES_DIR, `${self}.json`), JSON.stringify({
      host: self, sameDaemon: { [other]: { self: ids[self], other: ids[other], at: '2026-11-16T00:00:00.000Z' } },
    }))
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  // What `ssh -G` resolves each name to: itself (never the real ~/.ssh).
  __setSshResolverForTest(async (name) => ({ hostname: name, port: 22, user: 'someone' }))
  resetKnownHostsForTest()
  await updateConfig({
    hosts: {
      'big-box': { label: 'Big box', hostname: 'big-box.invalid', user: 'someone' },
      'found-box': { hostname: 'always-on-box.invalid', user: 'someone', discovered: true, connect: 'yes' },
    } as never,
  })
  await recordOneDaemon('big-box', 'found-box')
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
  getHostServerManager()
  registration = registerExposeProvider('acme-plugin', {
    id: 'acme-tunnel',
    title: 'Acme Tunnel',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    options: [],
    urlPattern: 'https://[a-z0-9.-]+\\.acme-tunnel\\.example',
    readyPattern: 'connected!',
    probe: false,
    alwaysOnHostPattern: '^always-on-',
  })
}, 60_000)

afterAll(async () => {
  registration?.dispose()
  await stopServer()
  __setSshResolverForTest(null)
  resetKnownHostsForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the tunnel\'s host, by the name the person knows it by', () => {
  it('Runs on lists the machine once, as "Big box", picked where the tunnel is placed', async () => {
    const body = await expose()
    expect(body.settings.placedOn).toBe('found-box')
    expect(body.places).toEqual([
      { id: 'found-box', label: 'Big box', alwaysOn: true },
      { id: 'here', label: 'This computer', alwaysOn: false },
    ])
    expect(JSON.stringify(body.places)).not.toContain('"label":"found-box"')
  })

  it('turned on, it is moving to "Big box", and its note says "Big box", never the found alias', async () => {
    const res = await fetch(`http://localhost:${port}/api/expose`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, provider: 'acme-tunnel' }),
    })
    expect(res.status).toBe(200)
    const status = await waitFor(async () => { const s = (await expose()).status; return s.movingTo?.note ? s : null })
    expect(status.movingTo).toMatchObject({ hostKey: 'found-box', label: 'Big box', note: 'Waiting to connect to Big box.' })
    expect(JSON.stringify(status)).not.toMatch(/\bfound-box\b(?!")/)
  })

  it('Walnut servers: the found row names the machine it is, and its view speaks of "Big box"', async () => {
    const found = await waitFor(async () => (await hosts()).find((h) => h.hostKey === 'found-box' && h.settings.carriesTunnel))
    expect(found.knownAs).toEqual({ hostKey: 'big-box', label: 'Big box' })
    expect(found.label).toBe('found-box')
    if (typeof found.view?.message === 'string') expect(found.view.message).not.toMatch(/\bfound-box\b/)
    // The named row is itself: no knownAs.
    expect((await hosts()).find((h) => h.hostKey === 'big-box')?.knownAs).toBeUndefined()
  })
})
