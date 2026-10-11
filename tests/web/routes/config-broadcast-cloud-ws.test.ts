/**
 * On the companion, a connected web client gets the same redacted config from
 * every `config:changed` that GET /api/config gives it.
 *
 * `GET /api/config` on a replica masks every secret (config-cloud-redaction),
 * because any paired device can read it there. The broadcasts after a Settings
 * save and after each hooks route used to send that same box's config RAW to
 * every connected /ws client, provider keys included: the one path that handed
 * a device off the Mac secrets the GET hides (gate I1).
 *
 * A plugin's own settings are masked by the shape of their keys, wherever they
 * stand (`client_secret`, `access_token`, `refresh_token`, a `private_key`
 * nested two objects down), and a whole round trip of what GET answered writes
 * every stored secret back unchanged: a mask that is saved back keeps the value
 * stored at its place (`restoreMaskedSecrets`). That round trip used to write
 * the masks into the companion's config.yaml in place of the provider keys.
 *
 * A real startServer in CLOUD_MODE, a real WebSocket client with a device
 * token, and the real routes. The last case emits the raw on-disk config under
 * a computed event name, as a relay would: only the WebSocket exit stands
 * between it and the client, so this file also fails if that exit is removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-config-cloud-ws', { CLOUD_MODE: true }))

import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const BEARER = `acme-bedrock-bearer-${crypto.randomBytes(8).toString('hex')}`
const API_KEY = `acme-provider-key-${crypto.randomBytes(8).toString('hex')}`
const AWS_SECRET = `acme-aws-secret-${crypto.randomBytes(8).toString('hex')}`
const PUSH = crypto.randomBytes(32).toString('hex')
const CLAIM = crypto.randomBytes(16).toString('hex')
const CLIENT_SECRET = `acme-client-secret-${crypto.randomBytes(8).toString('hex')}`
const ACCESS_TOKEN = `acme-access-${crypto.randomBytes(8).toString('hex')}`
const REFRESH_TOKEN = `acme-refresh-${crypto.randomBytes(8).toString('hex')}`
const NESTED_KEY = `acme-nested-${crypto.randomBytes(8).toString('hex')}`
const PLUGIN_SECRETS = [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN, NESTED_KEY]
const SECRETS = [BEARER, API_KEY, AWS_SECRET, PUSH, CLAIM, ...PLUGIN_SECRETS]
const masked = (v: string) => `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${v.slice(-4)}`

let server: HttpServer
let port: number
let token: string
let ws: WebSocket
const frames: string[] = []
/** The same events as the server's own subscribers hear them, before the WebSocket exit. */
const onBus: string[] = []

/** A secret whole, or any 10-character window of it. */
function leakIn(text: string): string | null {
  const lower = text.toLowerCase()
  for (const s of SECRETS) {
    for (let i = 0; i + 10 <= s.length; i++) {
      if (lower.includes(s.slice(i, i + 10).toLowerCase())) return `a window of ${s.slice(0, 6)}...`
    }
  }
  return null
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

function api(p: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
}

/** The newest config frame, as the client got it: every secret masked, no claims, no window of any secret. */
function expectRedactedFrame(): void {
  const { text, config } = configFrames().at(-1)!
  expect(leakIn(text)).toBeNull()
  expect(config.provider.bedrock_bearer_token).toBe(masked(BEARER))
  expect(config.providers.openai.api_key).toBe(masked(API_KEY))
  expect(config.providers.bedrock.aws_secret_access_key).toBe(masked(AWS_SECRET))
  expect(config.push_tokens.map((r: { token: string }) => r.token)).toEqual([masked(PUSH)])
  expect(config.push_tokens.filter((r: object) => 'claims' in r)).toEqual([])
  // A plugin's settings, by the shape of each key, at any depth.
  expect(config.plugins['acme-sync']).toEqual({
    enabled: true, client_id: 'id-of-the-app', base_url: 'https://acme.invalid',
    client_secret: masked(CLIENT_SECRET), access_token: masked(ACCESS_TOKEN), refresh_token: masked(REFRESH_TOKEN),
    oauth: { signing: { private_key: masked(NESTED_KEY) } },
  })
  // Non-secret fields ride as they are, so the client still has a config to read.
  expect(config.providers.openai.api).toBe('openai-chat')
}

/** What the bus carried since `from`: the config-carrying events, each already redacted. */
function expectRedactedOnBus(from: number): void {
  const heard = onBus.slice(from).filter((t) => t.includes('providers'))
  expect(heard).toHaveLength(1)
  expect(heard.map(leakIn)).toEqual([null])
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Owner' },
    provider: { bedrock_bearer_token: BEARER },
    providers: {
      bedrock: { api: 'bedrock', aws_secret_access_key: AWS_SECRET },
      openai: { api: 'openai-chat', api_key: API_KEY },
    },
    push_tokens: [
      { token: PUSH, platform: 'ios', kind: 'apns', environment: 'production', key_name: 'acme-phone', registered_at: new Date().toISOString(), origin: 'relay', claims: [CLAIM] },
    ],
    plugins: {
      'acme-sync': {
        enabled: true, client_id: 'id-of-the-app', base_url: 'https://acme.invalid',
        client_secret: CLIENT_SECRET, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN,
        oauth: { signing: { private_key: NESTED_KEY } },
      },
    },
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  ;({ token } = await createDevice('acme-browser'))
  bus.subscribe('cloud-ws-bus-probe', (event) => {
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
  bus.unsubscribe('cloud-ws-bus-probe')
  ws?.close()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a companion web client, connected with a device token', () => {
  it('GET /api/config answers redacted (the view every broadcast below must match)', async () => {
    const res = await api('/api/config')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(leakIn(text)).toBeNull()
    const { config } = JSON.parse(text) as { config: Record<string, any> }
    expect(config.provider.bedrock_bearer_token).toBe(masked(BEARER))
    expect(config.plugins['acme-sync'].client_secret).toBe(masked(CLIENT_SECRET))
  })

  it('GET /api/v1/config carries none of the secrets', async () => {
    const res = await api('/api/v1/config')
    expect(res.status).toBe(200)
    expect(leakIn(await res.text())).toBeNull()
  })

  it('a Settings save (PUT /api/config) sends config:changed redacted', async () => {
    const before = configFrames().length
    const busBefore = onBus.length
    // A partial write: a whole round trip would save the masked values back.
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify({ user: { name: 'Owner two' } }) })
    expect(put.status).toBe(200)
    await untilConfigFrames(before + 1)
    expectRedactedFrame()
    expect(configFrames().at(-1)!.config.user.name).toBe('Owner two')
    expectRedactedOnBus(busBefore)
  })

  it('toggling a hook override (PATCH /api/hooks/:id) sends config:changed redacted', async () => {
    const hooks = await (await api('/api/hooks')).json() as Array<{ id: string; mutable: string; enabled?: boolean }>
    const hook = hooks.find((h) => h.mutable === 'config-override')
    expect(hook).toBeDefined()
    const before = configFrames().length
    const busBefore = onBus.length
    expect((await api(`/api/hooks/${encodeURIComponent(hook!.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    await untilConfigFrames(before + 1)
    expectRedactedFrame()
    expectRedactedOnBus(busBefore)
  })

  it('toggling a daemon policy (PATCH /api/hooks/:id) sends config:changed redacted', async () => {
    const hooks = await (await api('/api/hooks')).json() as Array<{ id: string; mutable: string; enabled?: boolean }>
    const hook = hooks.find((h) => h.mutable === 'config-path')
    expect(hook).toBeDefined()
    const before = configFrames().length
    const busBefore = onBus.length
    // Its current value: the route writes and announces it all the same.
    expect((await api(`/api/hooks/${encodeURIComponent(hook!.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: hook!.enabled === true }) })).status).toBe(200)
    await untilConfigFrames(before + 1)
    expectRedactedFrame()
    expectRedactedOnBus(busBefore)
  })

  it('a relay that re-emits the raw config under a computed name still reaches the client redacted', async () => {
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    expect(JSON.stringify(raw)).toContain(BEARER)
    const before = configFrames().length
    bus.emit(['config', 'changed'].join(':'), { config: raw }, ['web-ui'], { source: 'relay-probe' })
    await untilConfigFrames(before + 1)
    expectRedactedFrame()
  })

  it('a Settings save of the providers section, as GET answered it, keeps the provider keys on disk', async () => {
    // What the companion's Settings sends after a provider edit: the section from a fresh GET.
    const { config } = await (await api('/api/config')).json() as { config: Record<string, any> }
    expect(config.providers.openai.api_key).toBe(masked(API_KEY))
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify({ providers: config.providers }) })
    expect(put.status).toBe(200)
    const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>
    expect(onDisk.providers.openai.api_key).toBe(API_KEY)
    expect(onDisk.providers.bedrock.aws_secret_access_key).toBe(AWS_SECRET)
  })

  it('a whole round trip (GET, then PUT of everything it answered) keeps every stored secret, and its broadcast is redacted', async () => {
    const read = await api('/api/config')
    const { config } = await read.json() as { config: Record<string, any> }
    expect(JSON.stringify(config)).toContain('\u2022')
    const before = configFrames().length
    const put = await api('/api/config', { method: 'PUT', body: JSON.stringify(config) })
    expect(put.status).toBe(200)
    await untilConfigFrames(before + 1)
    expectRedactedFrame()
    const text = await fs.readFile(CONFIG_FILE, 'utf-8')
    expect(text).not.toContain('\u2022')
    const onDisk = yaml.load(text) as Record<string, any>
    expect(onDisk.provider.bedrock_bearer_token).toBe(BEARER)
    expect(onDisk.providers.openai.api_key).toBe(API_KEY)
    expect(onDisk.providers.bedrock.aws_secret_access_key).toBe(AWS_SECRET)
    expect(onDisk.plugins['acme-sync']).toMatchObject({ client_secret: CLIENT_SECRET, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, oauth: { signing: { private_key: NESTED_KEY } } })
  })

  it('no frame the client received carries a secret, and the box kept every one', async () => {
    expect(configFrames().length).toBeGreaterThanOrEqual(6)
    expect(frames.map((t, i) => ({ i, leak: leakIn(t) })).filter((f) => f.leak)).toEqual([])
    const onDisk = await fs.readFile(CONFIG_FILE, 'utf-8')
    for (const s of SECRETS) expect(onDisk).toContain(s)
  })
})
