/**
 * On the Mac, no client reads a plugin's secret, and saving back what it read
 * keeps every one.
 *
 * `GET /api/config` serves the whole config to every paired device (a device
 * token reaches it like the console on this machine), and every `config:changed`
 * carries the same view. It used to carry a plugin's own settings as they were:
 * `client_secret`, `access_token`, `refresh_token`, a token nested in an `auth`
 * object. Now every value whose key names a secret is masked inside the
 * free-form maps (a plugin's settings, a provider's extra headers, a host
 * server's build env, a tunnel provider's options, a hook action), in every
 * answer that reads them; and every write a client builds from those answers
 * (a Settings save, the plugin form's save, a whole round trip, the tunnel
 * forms) gets the stored value back for each mask it carries.
 *
 * A real startServer, a real WebSocket client and HTTP client with a device
 * token, a fixture plugin in the registry (the settings forms list only
 * registered plugins), and the real routes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-plugin-secret-redaction'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { registry } from '../../../src/core/integration-registry.js'
import { createMockPlugin } from '../../core/plugin-test-utils.js'

const PLUGIN = 'acme-sync'
const HOST = 'acme-box'
const hex = () => crypto.randomBytes(8).toString('hex')
/** Each secret is a label and 16 random hex characters; only the hex part is looked for. */
const S = {
  clientSecret: `client-secret-${hex()}`,
  accessToken: `access-${hex()}`,
  refreshToken: `refresh-${hex()}`,
  authToken: `auth-token-${hex()}`,
  nestedKey: `nested-key-${hex()}`,
  header: `header-${hex()}`,
  buildEnv: `npm-${hex()}`,
  hostTunnel: `host-tunnel-${hex()}`,
  tunnel: `tunnel-${hex()}`,
  hook: `hook-${hex()}`,
}
const HEX = Object.values(S).map((s) => s.slice(-16))
const B = '\u2022'
const tail = (v: string) => B.repeat(8) + v.slice(-4)

/** A secret's random part whole, or any 10-character window of it. */
function leakIn(text: string): string | null {
  const lower = text.toLowerCase()
  for (const h of HEX) {
    for (let i = 0; i + 10 <= h.length; i++) if (lower.includes(h.slice(i, i + 10))) return `a window of ${h.slice(0, 4)}...`
  }
  return null
}

function seed() {
  return {
    version: 1,
    user: { name: 'Owner' },
    providers: {
      openai: { api: 'openai-chat', headers: { Authorization: `Bearer ${S.header}`, 'anthropic-version': '2023-06-01' } },
    },
    plugins: {
      [PLUGIN]: {
        enabled: true,
        client_id: 'acme-client-id',
        base_url: 'https://acme.invalid',
        project_key: 'ACME',
        token_url: 'https://acme.invalid/oauth/token',
        client_secret: S.clientSecret,
        access_token: S.accessToken,
        refresh_token: S.refreshToken,
        auth: { type: 'api-token', email: 'owner@example.invalid', token: S.authToken },
        oauth: { signing: { private_key: S.nestedKey } },
      },
    },
    hosts: {
      [HOST]: {
        hostname: 'acme-box.invalid', label: 'Acme box', enabled: false,
        server: {
          enabled: false,
          build_env: { NPM_TOKEN: S.buildEnv, NODE_OPTIONS: '--max-old-space-size=4096' },
          expose: { enabled: false, options: { tunnel: 'acme', token: S.hostTunnel } },
        },
      },
    },
    expose: { enabled: false, options: { name: 'acme-tunnel', token: S.tunnel } },
    hooks: { defs: [{ id: 'acme-hook', on: ['onTurnComplete'], action: { type: 'log', message: 'turn done', webhook_secret: S.hook } }] },
  }
}

let server: HttpServer
let port: number
let token: string
let ws: WebSocket
const frames: string[] = []
const onBus: string[] = []

function api(p: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
}

async function readConfig(): Promise<Record<string, any>> {
  const res = await api('/api/config')
  expect(res.status).toBe(200)
  return ((await res.json()) as { config: Record<string, any> }).config
}

async function onDisk(): Promise<{ text: string; config: Record<string, any> }> {
  const text = await fs.readFile(CONFIG_FILE, 'utf-8')
  return { text, config: yaml.load(text) as Record<string, any> }
}

/** Every secret still on disk at its own place, and no mask anywhere in the file. */
async function expectSecretsKept(): Promise<void> {
  const { text, config } = await onDisk()
  expect(text).not.toContain(B)
  const p = config.plugins[PLUGIN]
  expect([p.client_secret, p.access_token, p.refresh_token, p.auth.token, p.oauth.signing.private_key])
    .toEqual([S.clientSecret, S.accessToken, S.refreshToken, S.authToken, S.nestedKey])
  expect(config.providers.openai.headers.Authorization).toBe(`Bearer ${S.header}`)
  expect(config.hosts[HOST].server.build_env.NPM_TOKEN).toBe(S.buildEnv)
  expect(config.hosts[HOST].server.expose.options.token).toBe(S.hostTunnel)
  expect(config.expose.options.token).toBe(S.tunnel)
  expect(config.hooks.defs[0].action.webhook_secret).toBe(S.hook)
}

/** The client view of the seeded secrets: masked, with what a form shows beside them as it is. */
function expectClientView(config: Record<string, any>): void {
  expect(config.plugins[PLUGIN]).toMatchObject({
    enabled: true, client_id: 'acme-client-id', project_key: 'ACME', token_url: 'https://acme.invalid/oauth/token',
    client_secret: tail(S.clientSecret), access_token: tail(S.accessToken), refresh_token: tail(S.refreshToken),
    auth: { type: 'api-token', email: 'owner@example.invalid', token: tail(S.authToken) },
    oauth: { signing: { private_key: tail(S.nestedKey) } },
  })
  expect(config.providers.openai.headers).toEqual({ Authorization: tail(S.header), 'anthropic-version': '2023-06-01' })
  expect(config.hosts[HOST].server.build_env).toEqual({ NPM_TOKEN: tail(S.buildEnv), NODE_OPTIONS: '--max-old-space-size=4096' })
  expect(config.hosts[HOST].server.expose.options).toEqual({ tunnel: 'acme', token: tail(S.hostTunnel) })
  expect(config.expose.options).toEqual({ name: 'acme-tunnel', token: tail(S.tunnel) })
  expect(config.hooks.defs[0].action).toEqual({ type: 'log', message: 'turn done', webhook_secret: tail(S.hook) })
}

function configFrames(): Array<{ text: string; config: Record<string, any> }> {
  return frames.flatMap((text) => {
    const f = JSON.parse(text) as { type?: string; name?: string; data?: { config?: Record<string, unknown> } }
    return f.type === 'event' && f.name === 'config:changed' && f.data?.config ? [{ text, config: f.data.config }] : []
  })
}

async function untilConfigFrames(n: number): Promise<void> {
  for (let i = 0; i < 250 && configFrames().length < n; i++) await new Promise((r) => setTimeout(r, 20))
  expect(configFrames().length).toBeGreaterThanOrEqual(n)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  await fs.writeFile(CONFIG_FILE, yaml.dump(seed()), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  ;({ token } = await createDevice('acme-browser'))
  registry.register(PLUGIN, createMockPlugin({
    id: PLUGIN, name: 'Acme Sync',
    configSchema: { type: 'object', properties: { base_url: { type: 'string' }, client_id: { type: 'string' }, client_secret: { type: 'string' }, token_url: { type: 'string' }, auth: { type: 'object' } } },
  }))
  bus.subscribe('plugin-secret-bus-probe', (event) => {
    if (event.name === EventNames.CONFIG_CHANGED) onBus.push(JSON.stringify(event.data ?? null))
  }, { global: true })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
    const timer = setTimeout(() => reject(new Error('the web client did not connect')), 30_000)
    client.on('open', () => { clearTimeout(timer); resolve(client) })
    client.on('error', (err) => { clearTimeout(timer); reject(err) })
    client.on('message', (data) => { frames.push(data.toString()) })
  })
}, 120_000)

afterAll(async () => {
  bus.unsubscribe('plugin-secret-bus-probe')
  registry.unregister(PLUGIN)
  ws?.close()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('what a client reads', () => {
  it('GET /api/config, with a device token and from this machine, masks them and keeps what Settings shows', async () => {
    const withToken = await api('/api/config')
    const local = await fetch(`http://127.0.0.1:${port}/api/config`)
    for (const res of [withToken, local]) {
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(leakIn(text)).toBeNull()
      expectClientView((JSON.parse(text) as { config: Record<string, any> }).config)
    }
  })

  it('GET /api/v1/config carries none of them', async () => {
    const res = await api('/api/v1/config')
    expect(res.status).toBe(200)
    expect(leakIn(await res.text())).toBeNull()
  })

  it('the plugin settings forms mask them at any depth, with the mask their save leaves out', async () => {
    for (const route of ['/api/integrations/settings', '/api/v1/integrations/settings']) {
      const res = await api(route)
      expect(res.status, route).toBe(200)
      const text = await res.text()
      expect(leakIn(text), route).toBeNull()
      const mine = (JSON.parse(text) as Array<{ id: string; values: Record<string, any> }>).find((p) => p.id === PLUGIN)
      expect(mine?.values, route).toMatchObject({
        base_url: 'https://acme.invalid', client_id: 'acme-client-id', token_url: 'https://acme.invalid/oauth/token',
        client_secret: B.repeat(6), access_token: B.repeat(6), refresh_token: B.repeat(6),
        auth: { type: 'api-token', email: 'owner@example.invalid', token: B.repeat(6) },
        oauth: { signing: { private_key: B.repeat(6) } },
      })
    }
  })

  it('the tunnel forms (GET /api/expose, GET /api/host-servers) mask the options', async () => {
    const expose = await api('/api/expose')
    expect(expose.status).toBe(200)
    const exposeText = await expose.text()
    expect(leakIn(exposeText)).toBeNull()
    expect((JSON.parse(exposeText) as { settings: { options: Record<string, string> } }).settings.options).toEqual({ name: 'acme-tunnel', token: tail(S.tunnel) })
    const hosts = await api('/api/host-servers')
    expect(hosts.status).toBe(200)
    const hostsText = await hosts.text()
    expect(leakIn(hostsText)).toBeNull()
    const mine = (JSON.parse(hostsText) as { hosts: Array<{ hostKey: string; settings: { expose: { options: Record<string, string> } } }> }).hosts.find((h) => h.hostKey === HOST)
    expect(mine?.settings.expose.options).toEqual({ tunnel: 'acme', token: tail(S.hostTunnel) })
  })
})

describe('what a client writes back', () => {
  it('a Settings save sends config:changed in the client view, at the source and at the exit', async () => {
    const before = configFrames().length
    const busBefore = onBus.length
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify({ user: { name: 'Owner two' } }) })
    expect(put.status).toBe(200)
    await untilConfigFrames(before + 1)
    const frame = configFrames().at(-1)!
    expect(leakIn(frame.text)).toBeNull()
    expectClientView(frame.config)
    const heard = onBus.slice(busBefore).filter((t) => t.includes(PLUGIN))
    expect(heard.length).toBeGreaterThanOrEqual(1)
    expect(heard.map(leakIn)).toEqual(heard.map(() => null))
    await expectSecretsKept()
  })

  it('a whole round trip (GET, then PUT of everything it answered) writes every secret back unchanged', async () => {
    const read = await readConfig()
    expect(JSON.stringify(read)).toContain(B)
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify(read) })
    expect(put.status).toBe(200)
    await expectSecretsKept()
  })

  it('the plugin form\'s save (every plugin, the edited one with its change) keeps them and writes the change', async () => {
    const config = await readConfig()
    const body = { plugins: { ...config.plugins, [PLUGIN]: { ...config.plugins[PLUGIN], base_url: 'https://acme-two.invalid', enabled: true } } }
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) })
    expect(put.status).toBe(200)
    expect((await onDisk()).config.plugins[PLUGIN].base_url).toBe('https://acme-two.invalid')
    await expectSecretsKept()
  })

  it('a secret typed in replaces the stored one; a mask never does', async () => {
    const config = await readConfig()
    const fresh = `typed-${hex()}`
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify({ plugins: { ...config.plugins, [PLUGIN]: { ...config.plugins[PLUGIN], client_secret: fresh } } }) })
    expect(put.status).toBe(200)
    const p = (await onDisk()).config.plugins[PLUGIN]
    expect(p.client_secret).toBe(fresh)
    expect(p.access_token).toBe(S.accessToken)
    // Put the seeded one back for the cases after this one.
    const back = await api('/api/config', { method: 'PUT', body: JSON.stringify({ plugins: { ...config.plugins, [PLUGIN]: { ...config.plugins[PLUGIN], client_secret: S.clientSecret } } }) })
    expect(back.status).toBe(200)
    await expectSecretsKept()
  })

  it('the tunnel forms save every option back: the masked one keeps its stored value, the edited one changes', async () => {
    const expose = (await (await api('/api/expose')).json()) as { settings: { options: Record<string, string> } }
    const putExpose = await fetch(`http://127.0.0.1:${port}/api/expose`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { ...expose.settings.options, name: 'acme-tunnel-two' } }),
    })
    expect(putExpose.status).toBe(200)
    const hosts = (await (await api('/api/host-servers')).json()) as { hosts: Array<{ hostKey: string; settings: { expose: { options: Record<string, string> } } }> }
    const options = hosts.hosts.find((h) => h.hostKey === HOST)!.settings.expose.options
    const putHost = await fetch(`http://127.0.0.1:${port}/api/host-servers/${HOST}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expose: { options: { ...options, tunnel: 'acme-two' } } }),
    })
    expect(putHost.status).toBe(200)
    const { config } = await onDisk()
    expect(config.expose.options).toEqual({ name: 'acme-tunnel-two', token: S.tunnel })
    expect(config.hosts[HOST].server.expose.options).toEqual({ tunnel: 'acme-two', token: S.hostTunnel })
    await expectSecretsKept()
  })

  it('no frame the client received in this file carries a secret', () => {
    expect(configFrames().length).toBeGreaterThanOrEqual(4)
    expect(frames.map((t, i) => ({ i, leak: leakIn(t) })).filter((f) => f.leak)).toEqual([])
  })
})
