/**
 * On the Mac, no client reads a plugin's secret, and saving back what it read
 * keeps every one.
 *
 * `GET /api/config` serves the whole config to every paired device (a device
 * token reaches it like the console on this machine), and every `config:changed`
 * carries the same view. It used to carry a plugin's own settings as they were:
 * `client_secret`, `access_token`, `refresh_token`, a token nested in an `auth`
 * object. Now every value whose key names a secret, and the password of every
 * URL in a value, is masked inside the free-form maps (a plugin's settings, a
 * provider's extra headers, an engine's environment, a host server's build env,
 * a tunnel provider's options, a hook action), in every answer that reads them;
 * and every write a client builds from those answers (a Settings save, the
 * plugin form's save, a whole round trip, the tunnel forms) gets the stored
 * value back for each mask it carries. The engine's environment is where the
 * real config keeps an ANTHROPIC_API_KEY, which this view served raw (gate L2).
 *
 * A mask goes back only to the stored value it stands for: a URL's password to
 * the stored URL with the same address, a `{ name, value }` entry's value to
 * the one with its name. Edits to a list (delete, insert, reorder) never hand
 * one host's password to another (gate r6 MED-1), and a mask that stands for
 * nothing stored there (a password left masked on a URL whose host changed) is
 * refused with 400 naming the field and why, and nothing is written. The plugin
 * form shows each entry of a hidden list with its tail, so deleting one of two
 * hidden keys saves the one left (gate r7 MED-A: the delete was dropped while
 * the page said "Saved").
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
  engineKey: `engine-key-${hex()}`,
  vendorKey: `vendor-key-${hex()}`,
  pat: `pat-${hex()}`,
  apiTokens: `api-tokens-${hex()}`,
  dbPassword: `db-pw-${hex()}`,
  dbPass: `db-pass-${hex()}`,
  smtpPass: `smtp-pass-${hex()}`,
  readTokens: `read-tokens-${hex()}`,
  imap1: `imap-1-${hex()}`,
  imap2: `imap-2-${hex()}`,
  imap3: `imap-3-${hex()}`,
  broker1: `broker-1-${hex()}`,
  broker2: `broker-2-${hex()}`,
  listedGh: `listed-gh-${hex()}`,
  listedNpm: `listed-npm-${hex()}`,
  tunnelUrl: `tunnel-url-${hex()}`,
  hostTunnelUrl: `host-tunnel-url-${hex()}`,
  key1: `key-1-${hex()}`,
  key2: `key-2-${hex()}`,
  mbox1: `mbox-1-${hex()}`,
  mbox2: `mbox-2-${hex()}`,
  mirror1: `mirror-1-${hex()}`,
  mirror2: `mirror-2-${hex()}`,
  ciHeader: `ci-header-${hex()}`,
}
const HEX = Object.values(S).map((s) => s.slice(-16))
const B = '\u2022'
const tail = (v: string) => B.repeat(8) + v.slice(-4)
const dbUrl = (password: string, host = 'db.acme.invalid') => `postgres://acme:${password}@${host}:5432/acme`
const ENGINE_URL = 'https://proxy.acme.invalid'
/** What a view shows in place of a URL's password. */
const M = B.repeat(8)
const imap = (n: number, password: string) => `imap://acme:${password}@h${n}.acme.invalid/`
const SERVERS = () => [imap(1, S.imap1), imap(2, S.imap2), imap(3, S.imap3)]
const broker = (first: string, second: string) => `amqp://a:${first}@h4.acme.invalid/x amqp://b:${second}@h5.acme.invalid/y`
const LISTED = () => [{ name: 'GITHUB_TOKEN', value: S.listedGh }, { name: 'NPM_TOKEN', value: S.listedNpm }, { name: 'REGION', value: 'us-west-2' }]
const tunnelUrl = (password: string, host = 'tunnel.acme.invalid') => `https://acme:${password}@${host}/`
const HOST_TUNNEL = 'host-tunnel.acme.invalid'
const KEYS = () => [S.key1, S.key2]
const mailbox = (name: string, n: number, password: string) => ({ name, url: `imap://acme:${password}@m${n}.acme.invalid/` })
const MAILBOXES = () => [mailbox('work', 1, S.mbox1), mailbox('home', 2, S.mbox2)]
/** One address twice, under two passwords: only an unchanged round trip can say which is which. */
const mirror = (first: string, second: string) => `amqp://m:${first}@h8.acme.invalid/q amqp://m:${second}@h8.acme.invalid/q`
const CI_HEADER = () => ({ name: 'GITHUB_TOKEN', value: S.ciHeader })

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
        GITHUB_PAT: S.pat,
        api_tokens: S.apiTokens,
        database_url: dbUrl(S.dbPassword),
        DB_PASS: S.dbPass,
        servers: SERVERS(),
        broker_urls: broker(S.broker1, S.broker2),
        secrets: LISTED(),
        api_keys: KEYS(),
        mailboxes: MAILBOXES(),
        mirror_urls: mirror(S.mirror1, S.mirror2),
        ci_header: CI_HEADER(),
      },
    },
    engines: { custom: { adapter_cmd: ['acme-agent', 'acp'], env: { ANTHROPIC_API_KEY: S.engineKey, ANTHROPIC_BASE_URL: ENGINE_URL, SMTP_PASS: S.smtpPass } } },
    hosts: {
      [HOST]: {
        hostname: 'acme-box.invalid', label: 'Acme box', enabled: false,
        server: {
          enabled: false,
          build_env: { NPM_TOKEN: S.buildEnv, OPENAI_KEY: S.vendorKey, READ_TOKENS: S.readTokens, NODE_OPTIONS: '--max-old-space-size=4096' },
          expose: { enabled: false, options: { tunnel: 'acme', token: S.hostTunnel, endpoint: tunnelUrl(S.hostTunnelUrl, HOST_TUNNEL) } },
        },
      },
    },
    expose: { enabled: false, options: { name: 'acme-tunnel', token: S.tunnel, endpoint: tunnelUrl(S.tunnelUrl) } },
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

/** PUT the plugin's settings as `read` holds them, with `patch` laid over them. */
function putPlugin(read: Record<string, any>, patch: Record<string, unknown>) {
  return api('/api/config', { method: 'PUT', body: JSON.stringify({ plugins: { ...read.plugins, [PLUGIN]: { ...read.plugins[PLUGIN], ...patch } } }) })
}

/** Type the seeded lists and URLs back in, for the cases after this one. */
async function reseedPlugin(read: Record<string, any>): Promise<void> {
  const res = await putPlugin(read, {
    servers: SERVERS(), broker_urls: broker(S.broker1, S.broker2), secrets: LISTED(), database_url: dbUrl(S.dbPassword),
    api_keys: KEYS(), mailboxes: MAILBOXES(), ci_header: CI_HEADER(),
  })
  expect(res.status).toBe(200)
  await expectSecretsKept()
}

/** Every secret still on disk at its own place, and no mask anywhere in the file. */
async function expectSecretsKept(): Promise<void> {
  const { text, config } = await onDisk()
  expect(text).not.toContain(B)
  const p = config.plugins[PLUGIN]
  expect([p.client_secret, p.access_token, p.refresh_token, p.auth.token, p.oauth.signing.private_key])
    .toEqual([S.clientSecret, S.accessToken, S.refreshToken, S.authToken, S.nestedKey])
  expect([p.GITHUB_PAT, p.api_tokens]).toEqual([S.pat, S.apiTokens])
  expect(p.database_url).toMatch(new RegExp(`^postgres://acme:${S.dbPassword}@`))
  expect([p.DB_PASS, p.servers, p.broker_urls, p.secrets]).toEqual([S.dbPass, SERVERS(), broker(S.broker1, S.broker2), LISTED()])
  expect([p.api_keys, p.mailboxes, p.mirror_urls, p.ci_header]).toEqual([KEYS(), MAILBOXES(), mirror(S.mirror1, S.mirror2), CI_HEADER()])
  expect(config.engines.custom.env).toEqual({ ANTHROPIC_API_KEY: S.engineKey, ANTHROPIC_BASE_URL: ENGINE_URL, SMTP_PASS: S.smtpPass })
  expect(config.providers.openai.headers.Authorization).toBe(`Bearer ${S.header}`)
  expect(config.hosts[HOST].server.build_env.NPM_TOKEN).toBe(S.buildEnv)
  expect(config.hosts[HOST].server.build_env.OPENAI_KEY).toBe(S.vendorKey)
  expect(config.hosts[HOST].server.build_env.READ_TOKENS).toBe(S.readTokens)
  expect(config.hosts[HOST].server.expose.options.token).toBe(S.hostTunnel)
  expect(config.hosts[HOST].server.expose.options.endpoint).toBe(tunnelUrl(S.hostTunnelUrl, HOST_TUNNEL))
  expect(config.expose.options.token).toBe(S.tunnel)
  expect(config.expose.options.endpoint).toBe(tunnelUrl(S.tunnelUrl))
  expect(config.hooks.defs[0].action.webhook_secret).toBe(S.hook)
}

/** The client view of the seeded secrets: masked, with what a form shows beside them as it is. */
function expectClientView(config: Record<string, any>): void {
  expect(config.plugins[PLUGIN]).toMatchObject({
    enabled: true, client_id: 'acme-client-id', project_key: 'ACME', token_url: 'https://acme.invalid/oauth/token',
    client_secret: tail(S.clientSecret), access_token: tail(S.accessToken), refresh_token: tail(S.refreshToken),
    auth: { type: 'api-token', email: 'owner@example.invalid', token: tail(S.authToken) },
    oauth: { signing: { private_key: tail(S.nestedKey) } },
    GITHUB_PAT: tail(S.pat), api_tokens: tail(S.apiTokens), database_url: dbUrl(B.repeat(8)),
    DB_PASS: tail(S.dbPass), servers: [imap(1, M), imap(2, M), imap(3, M)], broker_urls: broker(M, M),
    secrets: [{ name: 'GITHUB_TOKEN', value: tail(S.listedGh) }, { name: 'NPM_TOKEN', value: tail(S.listedNpm) }, { name: 'REGION', value: 'us-west-2' }],
    api_keys: [tail(S.key1), tail(S.key2)], mailboxes: [mailbox('work', 1, M), mailbox('home', 2, M)], mirror_urls: mirror(M, M),
    ci_header: { name: 'GITHUB_TOKEN', value: tail(S.ciHeader) },
  })
  expect(config.engines).toEqual({ custom: { adapter_cmd: ['acme-agent', 'acp'], env: { ANTHROPIC_API_KEY: tail(S.engineKey), ANTHROPIC_BASE_URL: ENGINE_URL, SMTP_PASS: tail(S.smtpPass) } } })
  expect(config.providers.openai.headers).toEqual({ Authorization: tail(S.header), 'anthropic-version': '2023-06-01' })
  expect(config.hosts[HOST].server.build_env).toEqual({ NPM_TOKEN: tail(S.buildEnv), OPENAI_KEY: tail(S.vendorKey), READ_TOKENS: tail(S.readTokens), NODE_OPTIONS: '--max-old-space-size=4096' })
  expect(config.hosts[HOST].server.expose.options).toEqual({ tunnel: 'acme', token: tail(S.hostTunnel), endpoint: tunnelUrl(M, HOST_TUNNEL) })
  expect(config.expose.options).toEqual({ name: 'acme-tunnel', token: tail(S.tunnel), endpoint: tunnelUrl(M) })
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
        GITHUB_PAT: B.repeat(6), api_tokens: B.repeat(6), database_url: dbUrl(B.repeat(8)),
        DB_PASS: B.repeat(6), servers: [imap(1, M), imap(2, M), imap(3, M)], broker_urls: broker(M, M),
        secrets: [{ name: 'GITHUB_TOKEN', value: B.repeat(6) }, { name: 'NPM_TOKEN', value: B.repeat(6) }, { name: 'REGION', value: 'us-west-2' }],
        // In the console's form each entry of a hidden list shows its tail, so a delete says which ones
        // are left. The v1 route shows none: the companion can forward a call to it, and it cannot read
        // this machine's GET /api/config.
        api_keys: route === '/api/integrations/settings' ? [tail(S.key1), tail(S.key2)] : [B.repeat(6), B.repeat(6)],
        mailboxes: [mailbox('work', 1, M), mailbox('home', 2, M)], mirror_urls: mirror(M, M),
        ci_header: { name: 'GITHUB_TOKEN', value: B.repeat(6) },
      })
    }
  })

  it('the tunnel forms (GET /api/expose, GET /api/host-servers) mask the options', async () => {
    const expose = await api('/api/expose')
    expect(expose.status).toBe(200)
    const exposeText = await expose.text()
    expect(leakIn(exposeText)).toBeNull()
    expect((JSON.parse(exposeText) as { settings: { options: Record<string, string> } }).settings.options).toEqual({ name: 'acme-tunnel', token: tail(S.tunnel), endpoint: tunnelUrl(M) })
    const hosts = await api('/api/host-servers')
    expect(hosts.status).toBe(200)
    const hostsText = await hosts.text()
    expect(leakIn(hostsText)).toBeNull()
    const mine = (JSON.parse(hostsText) as { hosts: Array<{ hostKey: string; settings: { expose: { options: Record<string, string> } } }> }).hosts.find((h) => h.hostKey === HOST)
    expect(mine?.settings.expose.options).toEqual({ tunnel: 'acme', token: tail(S.hostTunnel), endpoint: tunnelUrl(M, HOST_TUNNEL) })
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

  it('the same round trip from a caller who is not the person at this machine is accepted too', async () => {
    // The tunnel and host-server guards compare what was sent with what is stored; the
    // restore runs before them, so a masked option read back counts as unchanged (gate I4).
    const read = await readConfig()
    const put = await api('/api/config', { method: 'PUT', headers: { 'x-walnut-caller-sid': 'acme-session' }, body: JSON.stringify(read) })
    expect(put.status).toBe(200)
    await expectSecretsKept()
  })

  it('an engine\'s environment saved back as read keeps its key; a typed one replaces it', async () => {
    const config = await readConfig()
    const kept = await api('/api/config', { method: 'PUT', body: JSON.stringify({ engines: config.engines }) })
    expect(kept.status).toBe(200)
    await expectSecretsKept()
    const fresh = `typed-engine-${hex()}`
    const typed = await api('/api/config', { method: 'PUT', body: JSON.stringify({ engines: { custom: { ...config.engines.custom, env: { ...config.engines.custom.env, ANTHROPIC_API_KEY: fresh } } } }) })
    expect(typed.status).toBe(200)
    expect((await onDisk()).config.engines.custom.env.ANTHROPIC_API_KEY).toBe(fresh)
    const back = await api('/api/config', { method: 'PUT', body: JSON.stringify({ engines: { custom: { ...config.engines.custom, env: { ...config.engines.custom.env, ANTHROPIC_API_KEY: S.engineKey } } } }) })
    expect(back.status).toBe(200)
    await expectSecretsKept()
  })

  it('a list of URLs with passwords: delete, insert, swap, and a typed one before a masked one keep each host\'s own password', async () => {
    const read = await readConfig()
    const [m1, m2, m3] = read.plugins[PLUGIN].servers as string[]
    expect([m1, m2, m3]).toEqual([imap(1, M), imap(2, M), imap(3, M)])
    const typed = `typed-${hex()}`
    const cases: Array<[string, string[], string[]]> = [
      ['delete the first', [m2!, m3!], [imap(2, S.imap2), imap(3, S.imap3)]],
      ['delete the middle', [m1!, m3!], [imap(1, S.imap1), imap(3, S.imap3)]],
      ['insert a new one at the top', [imap(0, typed), m1!, m2!, m3!], [imap(0, typed), ...SERVERS()]],
      ['swap the first two', [m2!, m1!, m3!], [imap(2, S.imap2), imap(1, S.imap1), imap(3, S.imap3)]],
      ['reverse', [m3!, m2!, m1!], SERVERS().reverse()],
      ['a typed password before a masked one', [imap(1, typed), m2!], [imap(1, typed), imap(2, S.imap2)]],
    ]
    for (const [label, sent, want] of cases) {
      const put = await putPlugin(read, { servers: sent })
      expect(put.status, label).toBe(200)
      const { text, config } = await onDisk()
      expect(config.plugins[PLUGIN].servers, label).toEqual(want)
      expect(text, label).not.toContain(B)
      await reseedPlugin(read)
    }
  })

  it('one value with two URLs: each masked password goes back to its own host, a typed one is written as typed', async () => {
    const read = await readConfig()
    expect(read.plugins[PLUGIN].broker_urls).toBe(broker(M, M))
    const [first, second] = broker(M, M).split(' ')
    const typed = `typed-${hex()}`
    const cases: Array<[string, string, string]> = [
      ['delete the first', second!, `amqp://b:${S.broker2}@h5.acme.invalid/y`],
      ['swap', `${second} ${first}`, `amqp://b:${S.broker2}@h5.acme.invalid/y amqp://a:${S.broker1}@h4.acme.invalid/x`],
      ['a typed one before both', `amqp://c:${typed}@h6.acme.invalid/z ${first} ${second}`, `amqp://c:${typed}@h6.acme.invalid/z ${broker(S.broker1, S.broker2)}`],
      ['the first typed, the second masked', `amqp://a:${typed}@h4.acme.invalid/x ${second}`, broker(typed, S.broker2)],
    ]
    for (const [label, sent, want] of cases) {
      const put = await putPlugin(read, { broker_urls: sent })
      expect(put.status, label).toBe(200)
      expect((await onDisk()).config.plugins[PLUGIN].broker_urls, label).toBe(want)
      await reseedPlugin(read)
    }
  })

  it('`{ name, value }` entries saved back reordered, with one removed or one added, each keep their own value', async () => {
    const read = await readConfig()
    const [gh, npm, region] = read.plugins[PLUGIN].secrets as Array<{ name: string; value: string }>
    const typed = { name: 'PYPI_TOKEN', value: `typed-${hex()}` }
    const listed = LISTED()
    const cases: Array<[string, unknown[], unknown[]]> = [
      ['reordered', [npm, region, gh], [listed[1], listed[2], listed[0]]],
      ['one removed', [gh, region], [listed[0], listed[2]]],
      ['one added at the top', [typed, gh, npm, region], [typed, ...listed]],
    ]
    for (const [label, sent, want] of cases) {
      const put = await putPlugin(read, { secrets: sent })
      expect(put.status, label).toBe(200)
      expect((await onDisk()).config.plugins[PLUGIN].secrets, label).toEqual(want)
      await reseedPlugin(read)
    }
  })

  it('the plugin form saves a delete from a hidden list: one of two keys left is the one kept', async () => {
    // What the form sends: the plugin's values as GET /api/config read them, with the edited list
    // from the form's own read (each hidden entry with its tail).
    const read = await readConfig()
    const form = (await (await api('/api/integrations/settings')).json()) as Array<{ id: string; values: Record<string, any> }>
    const shown = form.find((p) => p.id === PLUGIN)!.values.api_keys as string[]
    expect(shown).toEqual([tail(S.key1), tail(S.key2)])
    const typed = `typed-${hex()}`
    const cases: Array<[string, string[], string[]]> = [
      ['delete the first', [shown[1]!], [S.key2]],
      ['delete the second', [shown[0]!], [S.key1]],
      ['reorder', [shown[1]!, shown[0]!], [S.key2, S.key1]],
      ['add one', [...shown, typed], [...KEYS(), typed]],
    ]
    for (const [label, sent, want] of cases) {
      const put = await putPlugin(read, { api_keys: sent })
      expect(put.status, label).toBe(200)
      const { text, config } = await onDisk()
      expect(config.plugins[PLUGIN].api_keys, label).toEqual(want)
      expect(text, label).not.toContain(B)
      await reseedPlugin(read)
    }
  })

  it('a list of records whose secret is a URL password: delete one, the other keeps its own, no mask on disk', async () => {
    const read = await readConfig()
    const [work, home] = read.plugins[PLUGIN].mailboxes as Array<{ name: string; url: string }>
    expect(home).toEqual(mailbox('home', 2, M))
    for (const [label, sent, want] of [
      ['delete the first', [home], [MAILBOXES()[1]]],
      ['swap', [home, work], [MAILBOXES()[1], MAILBOXES()[0]]],
    ] as Array<[string, unknown[], unknown[]]>) {
      const put = await putPlugin(read, { mailboxes: sent })
      expect(put.status, label).toBe(200)
      const { text, config } = await onDisk()
      expect(config.plugins[PLUGIN].mailboxes, label).toEqual(want)
      expect(text, label).not.toContain(B)
      await reseedPlugin(read)
    }
  })

  it('a value the server changed after the client read it is refused with advice to reload; after a reload the same edit saves', async () => {
    const stale = await readConfig()
    // Another client rotates the first key (typed in full) after this one read the list.
    const rotated = `rotated-${hex()}`
    expect((await putPlugin(stale, { api_keys: [rotated, S.key2] })).status).toBe(200)
    const before = (await onDisk()).text
    // This client keeps only the first key, as it read it: nothing stored matches that tail now.
    const put = await putPlugin(stale, { api_keys: [stale.plugins[PLUGIN].api_keys[0]] })
    expect(put.status).toBe(400)
    const body = await put.json() as { error: string; field: string; reason: string }
    expect(body).toMatchObject({ field: `plugins.${PLUGIN}.api_keys[0]`, reason: 'unmatched' })
    expect(body.error).toMatch(/Reload to get the current settings/)
    expect((await onDisk()).text).toBe(before)
    // Reloaded, the first key is the rotated one, and keeping it saves.
    const fresh = await readConfig()
    expect((await putPlugin(fresh, { api_keys: [fresh.plugins[PLUGIN].api_keys[0]] })).status).toBe(200)
    expect((await onDisk()).config.plugins[PLUGIN].api_keys).toEqual([rotated])
    await reseedPlugin(fresh)
  })

  it('list entries a tail cannot tell apart show bullets only in every view, and the form still saves edits around them', async () => {
    const read0 = await readConfig()
    // Two with the same last 4 and one of 2 characters, shown as bullets only; one with a comma in its
    // last 4 and one more, which show their tails (the form keeps a list of secrets one value per line).
    const own = { dupA: `dup-a-${hex()}-tl11`, dupB: `dup-b-${hex()}-tl11`, comma: `comma-${hex()}-c,dd`, solo: `solo-${hex()}` }
    const KEEP = [own.dupA, own.dupB, own.comma, 'q7', own.solo]
    const leaks = (text: string) => Object.values(own).some((v) => text.includes(v.slice(4, 20)))
    expect((await putPlugin(read0, { blind_keys: KEEP })).status).toBe(200)
    const shown = [M, M, tail(own.comma), M, tail(own.solo)]
    const read = await readConfig()
    expect(read.plugins[PLUGIN].blind_keys).toEqual(shown)
    const formOf = async (route: string) =>
      ((await (await api(route)).json()) as Array<{ id: string; values: Record<string, any> }>).find((p) => p.id === PLUGIN)!.values
    expect((await formOf('/api/integrations/settings')).blind_keys).toEqual(shown)
    expect((await formOf('/api/v1/integrations/settings')).blind_keys).toEqual(Array(5).fill(B.repeat(6)))
    expect(leaks(JSON.stringify(read))).toBe(false)
    const typed = `typed-${hex()}`
    for (const [label, sent, want] of [
      ['delete the one with a tail', shown.slice(0, 4), KEEP.slice(0, 4)],
      ['move it to the top', [shown[4], ...shown.slice(0, 4)], [own.solo, ...KEEP.slice(0, 4)]],
      ['add one', [...shown, typed], [...KEEP, typed]],
    ] as Array<[string, string[], string[]]>) {
      const put = await putPlugin(read, { blind_keys: sent })
      expect(put.status, label).toBe(200)
      const { text, config } = await onDisk()
      expect(config.plugins[PLUGIN].blind_keys, label).toEqual(want)
      expect(text, label).not.toContain(B)
      expect((await putPlugin(read, { blind_keys: KEEP })).status).toBe(200)
    }
    // One of the bullets-only entries deleted: the two left could each be any of three.
    const before = (await onDisk()).text
    const put = await putPlugin(read, { blind_keys: [M, M, tail(own.comma), tail(own.solo)] })
    expect(put.status).toBe(400)
    const body = await put.json() as { error: string }
    expect(body).toMatchObject({ field: `plugins.${PLUGIN}.blind_keys[0]`, reason: 'ambiguous' })
    expect(body.error).toMatch(new RegExp(`Type the full value of plugins\\.${PLUGIN}\\.blind_keys\\[0\\]\\.$`))
    expect((await onDisk()).text).toBe(before)
    // Copies of one secret: a delete pairs, since any copy is that secret.
    expect((await putPlugin(read0, { blind_keys: [own.dupA, own.dupA, own.solo] })).status).toBe(200)
    const copies = await readConfig()
    expect(copies.plugins[PLUGIN].blind_keys).toEqual([M, M, tail(own.solo)])
    expect((await putPlugin(copies, { blind_keys: [M, tail(own.solo)] })).status).toBe(200)
    expect((await onDisk()).config.plugins[PLUGIN].blind_keys).toEqual([own.dupA, own.solo])
    expect((await putPlugin(copies, { blind_keys: [] })).status).toBe(200)
    await expectSecretsKept()
  })

  it('a mask that stands for nothing stored there is refused with 400 naming the field, and nothing is written', async () => {
    const read = await readConfig()
    const before = (await onDisk()).text
    const field = (f: string) => `plugins.${PLUGIN}.${f}`
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['a URL moved to another host', { database_url: dbUrl(M, 'db-two.acme.invalid') }, field('database_url'), 'missing'],
      ['another path', { database_url: dbUrl(M).replace('5432/acme', '5432/other') }, field('database_url'), 'missing'],
      ['another user', { database_url: `postgres://ops:${M}@db.acme.invalid:5432/acme` }, field('database_url'), 'missing'],
      ['another scheme', { database_url: `mysql://acme:${M}@db.acme.invalid:5432/acme` }, field('database_url'), 'missing'],
      ['another port', { database_url: `postgres://acme:${M}@db.acme.invalid:6432/acme` }, field('database_url'), 'missing'],
      ['a list entry moved to another host', { servers: [imap(9, M), imap(2, M), imap(3, M)] }, field('servers[0]'), 'missing'],
      ['a URL added to a value with its password masked', { broker_urls: `${broker(M, M)} amqp://d:${M}@h7.acme.invalid/w` }, field('broker_urls'), 'missing'],
      // Renamed with its value still masked: leaving the value out would lose it with the old key.
      ['a key renamed with its value masked', { client_secret: undefined, client_secret_v2: tail(S.clientSecret) }, field('client_secret_v2'), 'missing'],
      // Renamed, or with its name removed, the value would show in full on every later read.
      ['a `{ name, value }` entry with no id renamed in a list', { secrets: [{ name: 'GH_TOKEN', value: tail(S.listedGh) }] }, field('secrets[0].name'), 'renamed'],
      ['a `{ name, value }` entry in a list with its name removed', { secrets: [{ value: tail(S.listedGh) }] }, field('secrets[0].name'), 'renamed'],
      ['a `{ name, value }` entry in a list with its name made null', { secrets: [{ name: null, value: tail(S.listedGh) }, LISTED()[2]] }, field('secrets[0].name'), 'renamed'],
      ['a `{ name, value }` entry in a list with its name made a number', { secrets: [{ name: 7, value: tail(S.listedGh) }] }, field('secrets[0].name'), 'renamed'],
      // Renamed onto the name of an entry the same write drops: the namesake's value is not taken.
      ['a hidden value renamed onto the name of an entry the write drops', { secrets: [{ name: 'NPM_TOKEN', value: tail(S.listedGh) }, LISTED()[2]] }, field('secrets[0].name'), 'renamed'],
      ['a `{ name, value }` entry renamed with its value hidden', { ci_header: { name: 'GITHUB_NOTE', value: tail(S.ciHeader) } }, field('ci_header.name'), 'renamed'],
      ['a `{ name, value }` entry at a key with its name removed', { ci_header: { value: tail(S.ciHeader) } }, field('ci_header.name'), 'renamed'],
    ]
    for (const [label, patch, want, reason] of cases) {
      // An edit beside it is refused with it: the write is one.
      const put = await putPlugin(read, { ...patch, base_url: 'https://acme-refused.invalid' })
      expect(put.status, label).toBe(400)
      const body = await put.json() as { error: string }
      expect(body, label).toMatchObject({ code: 'masked_value_unmatched', field: want, reason })
      // None of these is helped by a reload; the message says to type the full value.
      expect(body.error, label).toMatch(/Type the full value of plugins\./)
      expect(body.error, label).not.toMatch(/Reload/)
      expect((await onDisk()).text, label).toBe(before)
    }
    // Typed in again, the same edit is written as sent.
    const moved = dbUrl(`typed-${hex()}`, 'db-two.acme.invalid')
    const typed = await putPlugin(read, { database_url: moved })
    expect(typed.status).toBe(200)
    expect((await onDisk()).config.plugins[PLUGIN].database_url).toBe(moved)
    await reseedPlugin(read)
  })

  it('a hidden value with other text typed next to it is refused as edited_mask on every write path, and no mask reaches disk', async () => {
    const read = await readConfig()
    const before = (await onDisk()).text
    const field = (f: string) => `plugins.${PLUGIN}.${f}`
    const [k1, k2] = [tail(S.key1), tail(S.key2)]
    const edited = (label: string, body: Record<string, unknown>, want: string) => {
      expect(body, label).toMatchObject({ code: 'masked_value_unmatched', field: want, reason: 'edited_mask' })
      expect(body.error, label).toBe(`${want} was sent back hidden, with other text added to it. Keep the hidden value exactly as it was shown, or replace it with the full value of ${want}.`)
    }
    // PUT /api/config, the way the plugin form and any JSON caller write (gate r10 P5c to P5h, H-1).
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a key typed after the last hidden line', { api_keys: [k1, `${k2}, sk-new-${hex()}`] }, field('api_keys[1]')],
      ['comma-separated text over the list', { api_keys: [`${k2}, ${k1}, sk-fox-${hex()}`] }, field('api_keys[0]')],
      ['a space after a hidden line', { api_keys: [`${k1} `, k2] }, field('api_keys[0]')],
      ['a space before a hidden line', { api_keys: [k1, ` ${k2}`] }, field('api_keys[1]')],
      ['a comma after a hidden line', { api_keys: [`${k1},`, k2] }, field('api_keys[0]')],
      ['a hidden value at a key with text after it', { client_secret: `${tail(S.clientSecret)} x` }, field('client_secret')],
      ['a URL password edited next to its bullets', { database_url: dbUrl(`${M}x`) }, field('database_url')],
      ['bullets typed into a setting that is not a secret', { base_url: `https://acme.invalid/${B.repeat(4)}` }, field('base_url')],
      ['a `{ name, value }` value with text after it', { secrets: [{ name: 'GITHUB_TOKEN', value: `${tail(S.listedGh)}, typed` }, LISTED()[1], LISTED()[2]] }, field('secrets[0].value')],
    ]
    for (const [label, patch, want] of cases) {
      const put = await putPlugin(read, patch)
      expect(put.status, label).toBe(400)
      edited(label, await put.json() as Record<string, unknown>, want)
      expect((await onDisk()).text, label).toBe(before)
    }
    // The tunnel forms: a space typed after the token's mask, then Enter (gate r10 T6, H6).
    const expose = (await (await api('/api/expose')).json()) as { settings: { options: Record<string, string> } }
    const putExpose = await fetch(`http://127.0.0.1:${port}/api/expose`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { ...expose.settings.options, token: `${expose.settings.options.token} ` } }),
    })
    expect(putExpose.status).toBe(400)
    edited('expose token', await putExpose.json() as Record<string, unknown>, 'expose.options.token')
    const hosts = (await (await api('/api/host-servers')).json()) as { hosts: Array<{ hostKey: string; settings: { expose: { options: Record<string, string> } } }> }
    const options = hosts.hosts.find((h) => h.hostKey === HOST)!.settings.expose.options
    const putHost = await fetch(`http://127.0.0.1:${port}/api/host-servers/${HOST}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expose: { options: { ...options, token: `${options.token} ` } } }),
    })
    expect(putHost.status).toBe(400)
    edited('host token', await putHost.json() as Record<string, unknown>, `hosts.${HOST}.server.expose.options.token`)
    expect((await onDisk()).text).toBe(before)
    expect(before).not.toContain(B)
    // The same edits made right: the hidden lines kept as shown, the new key on its own line.
    const fresh = `sk-new-${hex()}`
    const right = await putPlugin(read, { api_keys: [k1, k2, fresh] })
    expect(right.status).toBe(200)
    const after = await onDisk()
    expect(after.config.plugins[PLUGIN].api_keys).toEqual([...KEYS(), fresh])
    expect(after.text).not.toContain(B)
    await reseedPlugin(read)
  })

  it('the tunnel forms refuse a masked URL password sent with another host, naming the option', async () => {
    const before = (await onDisk()).text
    const expose = (await (await api('/api/expose')).json()) as { settings: { options: Record<string, string> } }
    const putExpose = await fetch(`http://127.0.0.1:${port}/api/expose`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { ...expose.settings.options, endpoint: tunnelUrl(M, 'elsewhere.acme.invalid') } }),
    })
    expect(putExpose.status).toBe(400)
    expect(await putExpose.json()).toMatchObject({ code: 'masked_value_unmatched', field: 'expose.options.endpoint', reason: 'missing' })
    const hosts = (await (await api('/api/host-servers')).json()) as { hosts: Array<{ hostKey: string; settings: { expose: { options: Record<string, string> } } }> }
    const options = hosts.hosts.find((h) => h.hostKey === HOST)!.settings.expose.options
    const putHost = await fetch(`http://127.0.0.1:${port}/api/host-servers/${HOST}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expose: { options: { ...options, endpoint: tunnelUrl(M, 'elsewhere.acme.invalid') } } }),
    })
    expect(putHost.status).toBe(400)
    expect(await putHost.json()).toMatchObject({ code: 'masked_value_unmatched', field: `hosts.${HOST}.server.expose.options.endpoint`, reason: 'missing' })
    expect((await onDisk()).text).toBe(before)
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
    expect(config.expose.options).toEqual({ name: 'acme-tunnel-two', token: S.tunnel, endpoint: tunnelUrl(S.tunnelUrl) })
    expect(config.hosts[HOST].server.expose.options).toEqual({ tunnel: 'acme-two', token: S.hostTunnel, endpoint: tunnelUrl(S.hostTunnelUrl, HOST_TUNNEL) })
    await expectSecretsKept()
  })

  it('no frame the client received in this file carries a secret', () => {
    expect(configFrames().length).toBeGreaterThanOrEqual(4)
    expect(frames.map((t, i) => ({ i, leak: leakIn(t) })).filter((f) => f.leak)).toEqual([])
  })
})
