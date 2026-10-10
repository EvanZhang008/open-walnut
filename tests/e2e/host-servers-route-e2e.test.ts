/**
 * /api/host-servers and the config write, on a real server
 * (docs/plan/walnut-servers-everywhere.md, "A server on a host"): who may turn a
 * host's Walnut on, what lands in config.yaml, and that the Remote Hosts editor,
 * which sends the whole hosts map without it, never turns one off.
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
import { bus, EventNames } from '../../src/core/event-bus.js'

let server: HttpServer
let port: number

const SESSION = { 'content-type': 'application/json', 'x-walnut-caller-sid': 'sess-1' }
const PERSON = { 'content-type': 'application/json' }

function api(pathname: string, init?: RequestInit) {
  return fetch(`http://localhost:${port}${pathname}`, init)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
  // Off as a host, so nothing dials it.
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.invalid', label: 'Dev box', enabled: false } } })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a host\'s Walnut, as a setting', () => {
  it('lists every host, off', async () => {
    const res = await api('/api/host-servers')
    expect(res.status).toBe(200)
    const body = await res.json() as { hosts: Array<Record<string, any>>; providers: unknown[] }
    expect(body.hosts).toEqual([expect.objectContaining({
      hostKey: 'devbox', label: 'Dev box',
      settings: { enabled: false, expose: { enabled: false, provider: null, options: {} } },
    })])
    expect(Array.isArray(body.providers)).toBe(true)
  })

  it('a session may not turn one on, here or through the config write', async () => {
    expect((await api('/api/host-servers/devbox', { method: 'PUT', headers: SESSION, body: JSON.stringify({ enabled: true }) })).status).toBe(403)
    expect((await api('/api/host-servers/devbox/retry', { method: 'POST', headers: SESSION })).status).toBe(403)
    const viaConfig = await api('/api/config', {
      method: 'PUT', headers: SESSION,
      body: JSON.stringify({ hosts: { devbox: { hostname: 'devbox.invalid', enabled: false, server: { enabled: true } } } }),
    })
    expect(viaConfig.status).toBe(403)
    expect((await getConfig()).hosts?.devbox?.server).toBeUndefined()
  })

  it('the person at this machine turns it on, with a tunnel; it waits for the host', async () => {
    const changed: unknown[] = []
    bus.subscribe('test-host-servers-config', (event) => { changed.push(event.data) }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
    const res = await api('/api/host-servers/devbox', {
      method: 'PUT', headers: PERSON,
      body: JSON.stringify({ enabled: true, expose: { enabled: true, provider: 'mytunnel', options: { name: 'devbox' } } }),
    })
    expect(res.status).toBe(200)
    const { host } = await res.json() as { host: Record<string, any> }
    expect(host.settings).toEqual({ enabled: true, expose: { enabled: true, provider: 'mytunnel', options: { name: 'devbox' } } })
    expect((await getConfig()).hosts?.devbox?.server).toEqual({ enabled: true, expose: { enabled: true, provider: 'mytunnel', options: { name: 'devbox' } } })
    // Settings (and the Remote Hosts card) re-read the config on this.
    bus.unsubscribe('test-host-servers-config')
    expect(changed).toEqual([expect.objectContaining({ config: expect.objectContaining({ hosts: expect.objectContaining({ devbox: expect.objectContaining({ server: expect.objectContaining({ enabled: true }) }) }) }) })])
    const view = await (async () => {
      for (let i = 0; i < 50; i++) {
        const h = ((await (await api('/api/host-servers')).json()) as { hosts: Array<Record<string, any>> }).hosts[0]!
        if (h.view?.phase === 'waiting-for-host') return h.view
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    })()
    expect(view).toMatchObject({ enabled: true, phase: 'waiting-for-host' })
    // A change of one field keeps the rest.
    await api('/api/host-servers/devbox', { method: 'PUT', headers: PERSON, body: JSON.stringify({ expose: { enabled: false } }) })
    expect((await getConfig()).hosts?.devbox?.server).toEqual({ enabled: true, expose: { enabled: false, provider: 'mytunnel', options: { name: 'devbox' } } })
  })

  it('the Remote Hosts editor sending the hosts map without it keeps it, from the person and from a session', async () => {
    const before = (await getConfig()).hosts?.devbox?.server
    const map = { devbox: { hostname: 'devbox.invalid', label: 'Dev box 2', enabled: false } }
    expect((await api('/api/config', { method: 'PUT', headers: PERSON, body: JSON.stringify({ hosts: map }) })).status).toBe(200)
    expect((await getConfig()).hosts?.devbox).toMatchObject({ label: 'Dev box 2', server: before })
    expect((await api('/api/config', { method: 'PUT', headers: SESSION, body: JSON.stringify({ hosts: { ...map, devbox: { ...map.devbox, label: 'Dev box 3' } } }) })).status).toBe(200)
    expect((await getConfig()).hosts?.devbox).toMatchObject({ label: 'Dev box 3', server: before })
  })

  it('says what is wrong with a bad change', async () => {
    const put = (body: unknown) => api('/api/host-servers/devbox', { method: 'PUT', headers: PERSON, body: JSON.stringify(body) })
    expect((await put({ enabled: 'yes' })).status).toBe(400)
    expect((await put({ expose: { provider: 'Not An Id' } })).status).toBe(400)
    expect((await put({ expose: { options: { name: 'x'.repeat(201) } } })).status).toBe(400)
    expect((await api('/api/host-servers/nohost', { method: 'PUT', headers: PERSON, body: '{}' })).status).toBe(404)
  })

  it('turning it off writes it off', async () => {
    expect((await api('/api/host-servers/devbox', { method: 'PUT', headers: PERSON, body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    expect((await getConfig()).hosts?.devbox?.server).toMatchObject({ enabled: false })
  })

  it('a host removed from config.yaml while its server is on is torn down', async () => {
    await api('/api/host-servers/devbox', { method: 'PUT', headers: PERSON, body: JSON.stringify({ enabled: true }) })
    const phase = async () => ((await (await api('/api/host-servers')).json()) as { hosts: Array<{ hostKey: string }> }).hosts
    await expect.poll(async () => (await import('../../src/core/host-server/index.js')).getHostServerManager()?.view('devbox').phase, { timeout: 5_000 }).toBe('waiting-for-host')
    // The person removes it in the Remote Hosts editor: the whole map, without it.
    expect((await api('/api/config', { method: 'PUT', headers: PERSON, body: JSON.stringify({ hosts: {} }) })).status).toBe(200)
    expect(await phase()).toEqual([])
    await expect.poll(async () => (await import('../../src/core/host-server/index.js')).getHostServerManager()?.view('devbox').phase, { timeout: 5_000 }).toBe('off')
  })
})
