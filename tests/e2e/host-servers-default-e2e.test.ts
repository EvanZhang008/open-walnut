/**
 * GET /api/host-servers with the experiment follower_on_every_host on (src/core/experimental.ts,
 * src/core/host-server/follower-default.ts), on a real server: `settings.enabled` reads true
 * for a host the person never set, `settings.chosenBy` says whose the value is, the person's
 * off is stored as theirs and stays off, the experiment off turns every unset host off,
 * and the shape older clients read (`view.phase`, `knownAs`, `settings.carriesTunnel`) keeps
 * its meaning. No host here is reachable: none dials anything.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port: number

const PERSON = { 'content-type': 'application/json' }
type Entry = { hostKey: string; settings: Record<string, any>; view: Record<string, any> | null; knownAs?: unknown }

function api(pathname: string, init?: RequestInit) {
  return fetch(`http://localhost:${port}${pathname}`, init)
}

async function list(): Promise<{ hosts: Entry[]; followerByDefault: boolean }> {
  const res = await api('/api/host-servers')
  expect(res.status).toBe(200)
  return await res.json() as { hosts: Entry[]; followerByDefault: boolean }
}

const entry = async (key: string) => (await list()).hosts.find((h) => h.hostKey === key)!

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
  // The experiment on, in this test run's own config (its own WALNUT_HOME).
  await updateConfig({
    experimental: { follower_on_every_host: true },
    hosts: {
      // Never set: on by default.
      devbox: { hostname: 'devbox.invalid', label: 'Dev box' },
      // The person turned it off (an older Walnut wrote the same field): stays off.
      quietbox: { hostname: 'quietbox.invalid', server: { enabled: false } },
      // The person turned it on when it was opt-in: stays on.
      oldbox: { hostname: 'oldbox.invalid', server: { enabled: true } },
      // A host turned off as a host: no follower.
      offbox: { hostname: 'offbox.invalid', enabled: false },
    },
  })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a host\'s follower, on by default', () => {
  it('reads on for a host never set, off for the person\'s off, and says whose each value is', async () => {
    const body = await list()
    expect(body.followerByDefault).toBe(true)
    const byKey = Object.fromEntries(body.hosts.map((h) => [h.hostKey, h.settings]))
    expect(byKey.devbox).toMatchObject({ enabled: true, chosenBy: 'default', byDefault: true })
    expect(byKey.quietbox).toMatchObject({ enabled: false, chosenBy: 'user' })
    expect(byKey.oldbox).toMatchObject({ enabled: true, chosenBy: 'user' })
    expect(byKey.offbox).toMatchObject({ enabled: false, chosenBy: 'default' })
    // Only a host on by the experiment's default says so (the label "On (default)" reads it).
    for (const k of ['quietbox', 'oldbox', 'offbox']) expect(byKey[k].byDefault).toBeUndefined()
    // The fields older clients read keep their meaning: no tunnel placed, no second alias.
    for (const h of body.hosts) {
      expect(h.settings.carriesTunnel).toBeUndefined()
      expect(h.knownAs).toBeUndefined()
      expect(Object.keys(h.settings).filter((k) => k !== 'byDefault').sort()).toEqual(['chosenBy', 'copies', 'enabled', 'expose'])
    }
    // Nothing is written for the default: the stored rows are as the person left them.
    const stored = (await getConfig()).hosts!
    expect(stored.devbox!.server).toBeUndefined()
    expect(stored.quietbox!.server).toEqual({ enabled: false })
  })

  it('a host on by default and not connected waits for it; nothing is set up', async () => {
    await api('/api/host-servers/devbox/retry', { method: 'POST', headers: PERSON })
    await vi.waitFor(async () => expect((await entry('devbox')).view).toMatchObject({ enabled: true, phase: 'waiting-for-host' }), { timeout: 5_000 })
  })

  it('the person\'s off is stored as theirs and stays off; their on again is theirs too', async () => {
    const off = await api('/api/host-servers/devbox', { method: 'PUT', headers: PERSON, body: JSON.stringify({ enabled: false }) })
    expect(off.status).toBe(200)
    expect(((await off.json()) as { host: Entry }).host.settings).toMatchObject({ enabled: false, chosenBy: 'user' })
    expect((await getConfig()).hosts!.devbox!.server).toEqual({ enabled: false })
    await vi.waitFor(async () => expect((await entry('devbox')).view).toMatchObject({ enabled: false, phase: 'off' }), { timeout: 5_000 })
    const on = await api('/api/host-servers/devbox', { method: 'PUT', headers: PERSON, body: JSON.stringify({ enabled: true }) })
    expect(((await on.json()) as { host: Entry }).host.settings).toMatchObject({ enabled: true, chosenBy: 'user' })
  })

  it('the experiment off turns every host never set off, and keeps the person\'s own on', async () => {
    await updateConfig({ experimental: { follower_on_every_host: false } })
    // A new host, never set.
    const hosts = { ...(await getConfig()).hosts, newbox: { hostname: 'newbox.invalid' } }
    await updateConfig({ hosts })
    const body = await list()
    expect(body.followerByDefault).toBe(false)
    const byKey = Object.fromEntries(body.hosts.map((h) => [h.hostKey, h.settings]))
    expect(byKey.newbox).toMatchObject({ enabled: false, chosenBy: 'default' })
    expect(byKey.newbox.byDefault).toBeUndefined()
    expect(byKey.devbox).toMatchObject({ enabled: true, chosenBy: 'user' })
    expect(byKey.oldbox).toMatchObject({ enabled: true, chosenBy: 'user' })
    await updateConfig({ experimental: { follower_on_every_host: true } })
    expect(((await entry('newbox')).settings)).toMatchObject({ enabled: true, chosenBy: 'default', byDefault: true })
  })
})
