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
const SECRETS = [BEARER, API_KEY, AWS_SECRET, PUSH, CLAIM]
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

  it('no frame the client received carries a secret, and the box kept every one', async () => {
    expect(configFrames().length).toBeGreaterThanOrEqual(4)
    expect(frames.map((t, i) => ({ i, leak: leakIn(t) })).filter((f) => f.leak)).toEqual([])
    const onDisk = await fs.readFile(CONFIG_FILE, 'utf-8')
    for (const s of SECRETS) expect(onDisk).toContain(s)
  })
})
