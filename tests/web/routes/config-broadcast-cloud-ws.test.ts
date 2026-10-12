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
 * nested two objects down, a vendor's `STRIPE_KEY`, a `GITHUB_PAT`, plural
 * `api_tokens`, `DB_PASS`, the value of a `{ name, value }` entry named like a
 * secret), so is an engine's environment, and so is the password of a URL in any
 * value (`database_url`, each URL of a list, a provider's `base_url`); a whole
 * round trip of what GET answered writes
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
const STRIPE_KEY = `acme-stripe-${crypto.randomBytes(8).toString('hex')}`
const PAT = `acme-pat-${crypto.randomBytes(8).toString('hex')}`
const API_TOKENS = `acme-api-tokens-${crypto.randomBytes(8).toString('hex')}`
const DB_PASSWORD = `acme-db-pw-${crypto.randomBytes(8).toString('hex')}`
const ENGINE_VENDOR_KEY = `acme-engine-vendor-${crypto.randomBytes(8).toString('hex')}`
const PROXY_PASSWORD = `acme-proxy-pw-${crypto.randomBytes(8).toString('hex')}`
const IMAP_1 = `acme-imap-1-${crypto.randomBytes(8).toString('hex')}`
const IMAP_2 = `acme-imap-2-${crypto.randomBytes(8).toString('hex')}`
const DB_PASS = `acme-db-pass-${crypto.randomBytes(8).toString('hex')}`
const LISTED = `acme-listed-${crypto.randomBytes(8).toString('hex')}`
const SMTP_PASS = `acme-smtp-pass-${crypto.randomBytes(8).toString('hex')}`
const dbUrl = (password: string) => `postgres://acme:${password}@db.acme.invalid:5432/acme`
const proxyUrl = (password: string) => `https://proxy:${password}@proxy.acme.invalid/v1`
const imap = (n: number, password: string) => `imap://acme:${password}@h${n}.acme.invalid/`
const URL_MASK = '\u2022'.repeat(8)
const PLUGIN_SECRETS = [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN, NESTED_KEY, STRIPE_KEY, PAT, API_TOKENS, DB_PASSWORD, ENGINE_VENDOR_KEY, IMAP_1, IMAP_2, DB_PASS, LISTED, SMTP_PASS]
const SECRETS = [BEARER, API_KEY, AWS_SECRET, PUSH, CLAIM, PROXY_PASSWORD, ...PLUGIN_SECRETS]
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
  // A typed provider field holding a URL with a password: the password masked, the rest as it is.
  expect(config.providers.proxy).toEqual({ api: 'anthropic', base_url: proxyUrl(URL_MASK) })
  expect(config.push_tokens.map((r: { token: string }) => r.token)).toEqual([masked(PUSH)])
  expect(config.push_tokens.filter((r: object) => 'claims' in r)).toEqual([])
  // A plugin's settings, by the shape of each key, at any depth.
  expect(config.plugins['acme-sync']).toEqual({
    enabled: true, client_id: 'id-of-the-app', base_url: 'https://acme.invalid',
    client_secret: masked(CLIENT_SECRET), access_token: masked(ACCESS_TOKEN), refresh_token: masked(REFRESH_TOKEN),
    oauth: { signing: { private_key: masked(NESTED_KEY) } },
    STRIPE_KEY: masked(STRIPE_KEY), GITHUB_PAT: masked(PAT), api_tokens: masked(API_TOKENS),
    database_url: dbUrl('\u2022'.repeat(8)),
    servers: [imap(1, URL_MASK), imap(2, URL_MASK)], DB_PASS: masked(DB_PASS),
    secrets: [{ name: 'GITHUB_TOKEN', value: masked(LISTED) }, { name: 'REGION', value: 'us-west-2' }],
  })
  expect(config.engines.custom.env).toEqual({ OPENAI_KEY: masked(ENGINE_VENDOR_KEY), ANTHROPIC_BASE_URL: 'https://proxy.acme.invalid', SMTP_PASS: masked(SMTP_PASS) })
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
      proxy: { api: 'anthropic', base_url: proxyUrl(PROXY_PASSWORD) },
    },
    push_tokens: [
      { token: PUSH, platform: 'ios', kind: 'apns', environment: 'production', key_name: 'acme-phone', registered_at: new Date().toISOString(), origin: 'relay', claims: [CLAIM] },
    ],
    plugins: {
      'acme-sync': {
        enabled: true, client_id: 'id-of-the-app', base_url: 'https://acme.invalid',
        client_secret: CLIENT_SECRET, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN,
        oauth: { signing: { private_key: NESTED_KEY } },
        STRIPE_KEY, GITHUB_PAT: PAT, api_tokens: API_TOKENS, database_url: dbUrl(DB_PASSWORD),
        servers: [imap(1, IMAP_1), imap(2, IMAP_2)], DB_PASS,
        secrets: [{ name: 'GITHUB_TOKEN', value: LISTED }, { name: 'REGION', value: 'us-west-2' }],
      },
    },
    engines: { custom: { env: { OPENAI_KEY: ENGINE_VENDOR_KEY, ANTHROPIC_BASE_URL: 'https://proxy.acme.invalid', SMTP_PASS } } },
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
    expect(onDisk.providers.proxy.base_url).toBe(proxyUrl(PROXY_PASSWORD))
  })

  it('a list of URLs edited on the companion keeps each host\'s own password, and a masked one moved to another host is refused', async () => {
    const { config } = await (await api('/api/config')).json() as { config: Record<string, any> }
    const plugin = config.plugins['acme-sync']
    const write = (patch: Record<string, unknown>) => api('/api/config', { method: 'PUT', body: JSON.stringify({ plugins: { ...config.plugins, 'acme-sync': { ...plugin, ...patch } } }) })
    const disk = async () => yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>
    // Delete the first: the second keeps its own password, never the first's.
    expect((await write({ servers: [plugin.servers[1]] })).status).toBe(200)
    expect((await disk()).plugins['acme-sync'].servers).toEqual([imap(2, IMAP_2)])
    // Swapped back in with the first typed again: each in its place with its own.
    expect((await write({ servers: [plugin.servers[1], imap(1, IMAP_1)] })).status).toBe(200)
    expect((await disk()).plugins['acme-sync'].servers).toEqual([imap(2, IMAP_2), imap(1, IMAP_1)])
    // A masked password on a host that has none stored: 400 naming the field, nothing written.
    const before = await fs.readFile(CONFIG_FILE, 'utf-8')
    const refused = await write({ servers: [imap(9, URL_MASK)] })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ code: 'masked_value_unmatched', field: 'plugins.acme-sync.servers[0]' })
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(before)
    // Back as seeded, for the cases after this one.
    expect((await write({ servers: [imap(1, IMAP_1), imap(2, IMAP_2)] })).status).toBe(200)
  })

  it('a hidden value with other text typed next to it, written on the companion, is refused as edited_mask and nothing is written', async () => {
    const { config } = await (await api('/api/config')).json() as { config: Record<string, any> }
    const plugin = config.plugins['acme-sync']
    const write = (patch: Record<string, unknown>) => api('/api/config', { method: 'PUT', body: JSON.stringify({ plugins: { ...config.plugins, 'acme-sync': { ...plugin, ...patch } } }) })
    const before = await fs.readFile(CONFIG_FILE, 'utf-8')
    for (const [label, patch, field] of [
      ['a space after a hidden value', { client_secret: `${plugin.client_secret} ` }, 'plugins.acme-sync.client_secret'],
      ['a key typed after a hidden value', { DB_PASS: `${plugin.DB_PASS}, typed` }, 'plugins.acme-sync.DB_PASS'],
      ['a `{ name, value }` value with text after it', { secrets: [{ ...plugin.secrets[0], value: `${plugin.secrets[0].value} x-new` }, plugin.secrets[1]] }, 'plugins.acme-sync.secrets[0].value'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const refused = await write(patch)
      expect(refused.status, label).toBe(400)
      const body = await refused.json() as { error: string }
      expect(body, label).toMatchObject({ code: 'masked_value_unmatched', field, reason: 'edited_mask' })
      expect(body.error, label).toMatch(/Keep the hidden value exactly as it was shown, or replace it with the full value of /)
      expect(await fs.readFile(CONFIG_FILE, 'utf-8'), label).toBe(before)
    }
    expect(before).not.toContain('\u2022')
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
    expect(onDisk.plugins['acme-sync']).toMatchObject({ STRIPE_KEY, GITHUB_PAT: PAT, api_tokens: API_TOKENS, database_url: dbUrl(DB_PASSWORD) })
    expect(onDisk.plugins['acme-sync']).toMatchObject({ servers: [imap(1, IMAP_1), imap(2, IMAP_2)], DB_PASS, secrets: [{ name: 'GITHUB_TOKEN', value: LISTED }, { name: 'REGION', value: 'us-west-2' }] })
    expect(onDisk.providers.proxy.base_url).toBe(proxyUrl(PROXY_PASSWORD))
    expect(onDisk.engines.custom.env).toMatchObject({ OPENAI_KEY: ENGINE_VENDOR_KEY, SMTP_PASS })
  })

  it('no frame the client received carries a secret, and the box kept every one', async () => {
    expect(configFrames().length).toBeGreaterThanOrEqual(6)
    expect(frames.map((t, i) => ({ i, leak: leakIn(t) })).filter((f) => f.leak)).toEqual([])
    const onDisk = await fs.readFile(CONFIG_FILE, 'utf-8')
    for (const s of SECRETS) expect(onDisk).toContain(s)
  })
})
