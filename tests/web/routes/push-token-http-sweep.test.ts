/**
 * No HTTP response carries a push device token, whole or in part.
 *
 * A push token is a send capability: with the APNs key it puts a notification
 * on that phone's lock screen. `GET /api/config` used to return the whole
 * `push_tokens` list on the Mac, and phone builds that predate token tags upload a
 * 12-character slice of their token in every push log line, which the bug report
 * quoted.
 *
 * This file does not trust a list of routes someone remembered. It records every
 * route the real server registers (by wrapping the router's `route` and `use`
 * before the server's modules load), requests EVERY GET route against a seeded
 * registry, and scans each body for the full tokens and for every 10-character
 * window of them, in any letter case. The legacy `token_prefix` (8 characters)
 * stays under that bar on purpose; a tag is a hash and contains no window.
 *
 * A relayed row's `claims` (core/push/claims.ts) are forbidden the same way:
 * each claim whole and every 10-character window of it, whatever field would
 * carry it. So are a plugin's own secrets (`plugins.<id>.client_secret`,
 * `access_token`, `refresh_token`, a token inside its `auth` object): any
 * paired device can read every one of these routes.
 *
 * A real WebSocket client is connected the whole time, as a console window is.
 * Every frame it receives, during the sweep and the writes after it (a Settings
 * save, a hook toggled each way the hooks route writes, a relay re-emitting the
 * change under a computed name, a host's server settings changed), is scanned the
 * same way: two hooks routes once sent every client the raw config, full tokens
 * and claims included, and so did the host servers route when it landed.
 *
 * Seeded on disk before the sweep, the way a real box looks after an upgrade:
 * an APNs row and an Expo row in config.yaml, a relayed APNs row with two
 * claims, a paired phone, a host that is turned off (so nothing dials it), an iOS
 * client log written by a build that predates token tags (raw slices), and an old
 * server log line.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import yaml from 'js-yaml'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-push-token-sweep'))

// Record every route the server registers.
// Express 5 keeps a route's path on `layer.route.path`, but not the path a
// router was mounted at, so `use` is wrapped to remember it. The router module
// is resolved from express's own location: the instance express uses.
type RouterFn = { stack: Layer[] } & ((...a: unknown[]) => unknown)
interface Layer { route?: { path: unknown; methods: Record<string, boolean> }; handle?: unknown }
const requireFromExpress = createRequire(createRequire(import.meta.url).resolve('express'))
const RouterProto = (requireFromExpress('router') as { prototype: { use: (...a: unknown[]) => unknown } }).prototype
const mounts = new WeakMap<object, Array<{ parent: object; path: unknown }>>()
const originalUse = RouterProto.use
RouterProto.use = function patchedUse(this: object, ...args: unknown[]) {
  // The router's own reading of its arguments: a leading non-function is the path.
  let first: unknown = args[0]
  while (Array.isArray(first) && first.length > 0) first = first[0]
  const hasPath = typeof first !== 'function'
  const mountPath = hasPath ? args[0] : '/'
  for (const fn of args.slice(hasPath ? 1 : 0).flat(Infinity)) {
    if (typeof fn === 'function' && Array.isArray((fn as Partial<RouterFn>).stack)) {
      const list = mounts.get(fn) ?? []
      list.push({ parent: this, path: mountPath })
      mounts.set(fn, list)
    }
  }
  return originalUse.apply(this, args)
}

const { WALNUT_HOME, CONFIG_FILE, LOG_DIR } = await import('../../../src/constants.js')

const { pushClaimOf } = await import('../../../src/core/push/claims.js')

const PHONE = 'acme-phone'
const TABLET = 'acme-tablet'
/** A host this Mac knows, turned off so nothing dials it: the host servers route writes its settings. */
const HOST = 'acme-box'
const APNS = crypto.randomBytes(32).toString('hex')
const EXPO_INNER = crypto.randomBytes(11).toString('hex')
const EXPO = `ExponentPushToken[${EXPO_INNER}]`
/** A row the companion relayed, with the claims of the two pairings that registered it. */
const RELAYED = crypto.randomBytes(32).toString('hex')
const CLAIMS = [pushClaimOf(crypto.randomBytes(32).toString('hex')), pushClaimOf(crypto.randomBytes(32).toString('hex'))]
const windowsOf = (secrets: string[]) =>
  [...new Set(secrets.flatMap((s) => Array.from({ length: s.length - 9 }, (_, i) => s.slice(i, i + 10).toLowerCase())))]
/** Every 10-character window of each secret part (the Expo head is a fixed public string). */
const WINDOWS = windowsOf([APNS, EXPO_INNER, RELAYED])
const CLAIM_WINDOWS = windowsOf(CLAIMS)
/** A plugin's own secrets, in its free-form settings: client secret, access, refresh, and a nested auth token. */
const PLUGIN_SECRETS = Array.from({ length: 4 }, () => crypto.randomBytes(16).toString('hex'))
const PLUGIN_WINDOWS = windowsOf(PLUGIN_SECRETS)

/** What a body leaks, if anything: a token or a claim, whole or a 10-character window. */
function leakIn(text: string): string | null {
  const lower = text.toLowerCase()
  if (lower.includes(APNS)) return 'full APNs token'
  if (lower.includes(RELAYED)) return 'full relayed APNs token'
  if (text.includes(EXPO)) return 'full Expo token'
  if (CLAIMS.some((c) => lower.includes(c))) return 'a whole claim'
  const w = WINDOWS.find((x) => lower.includes(x))
  if (w) return w
  const c = CLAIM_WINDOWS.find((x) => lower.includes(x))
  if (c) return `claim window ${c}`
  const p = PLUGIN_WINDOWS.find((x) => lower.includes(x))
  return p ? `plugin secret window ${p}` : null
}

function joinPath(a: string, b: string): string {
  const joined = `${a}/${b}`.replace(/\/+/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

/** Concrete paths for a route pattern: params become a real-looking value, optional groups are kept. */
function concrete(pattern: string): string {
  return pattern
    .replace(/:(\w+)/g, PHONE)
    .replace(/\*(\w+)/g, PHONE)
    .replace(/[{}]/g, '')
}

function collectGets(router: RouterFn, prefix: string, out: Set<string>, skipped: string[], seen: Set<object>): void {
  if (seen.has(router)) return
  seen.add(router)
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = layer.route.methods ?? {}
      if (!methods.get && !methods._all) continue
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
      for (const p of paths) {
        if (typeof p === 'string') out.add(concrete(joinPath(prefix, p)))
        else skipped.push(`${prefix} ${String(p)}`)
      }
      continue
    }
    const child = layer.handle as Partial<RouterFn> | undefined
    if (typeof child !== 'function' || !Array.isArray(child.stack)) continue
    const at = (mounts.get(child) ?? []).filter((m) => m.parent === router).map((m) => m.path)
    for (const p of new Set(at.length > 0 ? at : ['/'])) {
      const list = Array.isArray(p) ? p : [p]
      for (const one of list) {
        if (typeof one === 'string') collectGets(child as RouterFn, joinPath(prefix, one), out, skipped, new Set(seen))
        else skipped.push(`${prefix} mount ${String(one)}`)
      }
    }
  }
}

/** `text` is kept for the routes that read the rows (ROW_ROUTES); the bug report answers once per 5 s. */
interface Hit { path: string; status: number; leak: string | null; bytes: number; text?: string }

/**
 * The routes that read the push rows. Each must answer, or the sweep proves
 * nothing about it, so each gets a deadline a loaded machine still meets (the
 * bug report does real work: logs, git, host tables).
 */
const ROW_ROUTES = ['/api/config', '/api/push/status', '/api/bug-report']

/** GET one path; read at most 4 MB, an event stream for at most 1 s. Never throws. */
async function sweepOne(port: number, p: string, timeoutMs = 6_000): Promise<Hit> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: ctrl.signal, redirect: 'manual' })
    const isStream = (res.headers.get('content-type') ?? '').includes('event-stream')
    if (isStream) setTimeout(() => ctrl.abort(), 1_000)
    let text = ''
    const reader = res.body?.getReader()
    const decoder = new TextDecoder()
    try {
      while (reader && text.length < 4_000_000) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch { /* aborted stream: scan what arrived */ }
    return { path: p, status: res.status, leak: leakIn(text), bytes: text.length, ...(ROW_ROUTES.includes(p) ? { text } : {}) }
  } catch {
    return { path: p, status: 0, leak: null, bytes: 0 }
  } finally {
    clearTimeout(timer)
  }
}

let server: HttpServer
let port = 0
let stopServer: () => Promise<void>
let routes: string[] = []
let skipped: string[] = []
let hits: Hit[] = []
/** Every frame the connected web client received, in order. */
const frames: string[] = []
let ws: WebSocket | null = null

/** The `config:changed` frames that carry a config, parsed. */
function configFrames(): Array<{ text: string; config: Record<string, unknown> }> {
  return frames.flatMap((text) => {
    const f = JSON.parse(text) as { type?: string; name?: string; data?: { config?: Record<string, unknown> } }
    return f.type === 'event' && f.name === 'config:changed' && f.data?.config ? [{ text, config: f.data.config }] : []
  })
}

/** Wait until the client has received `n` config-carrying frames (frames arrive after the HTTP answer). */
async function untilConfigFrames(n: number): Promise<void> {
  for (let i = 0; i < 250 && configFrames().length < n; i++) await new Promise((r) => setTimeout(r, 20))
  expect(configFrames().length).toBeGreaterThanOrEqual(n)
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const { createDevice, _resetDeviceAuthForTesting } = await import('../../../src/core/device-auth.js')
  _resetDeviceAuthForTesting()
  await createDevice(PHONE)
  const now = new Date().toISOString()
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    push_tokens: [
      { token: APNS, platform: 'ios', kind: 'apns', environment: 'production', key_name: PHONE, registered_at: now, mode: 'always', origin: 'local' },
      { token: EXPO, platform: 'ios', key_name: 'acme-old-phone', registered_at: now, origin: 'local' },
      { token: RELAYED, platform: 'ios', kind: 'apns', environment: 'production', key_name: TABLET, registered_at: now, mode: 'always', origin: 'relay', claims: CLAIMS },
    ],
    hosts: { [HOST]: { hostname: 'acme-box.invalid', label: 'Acme box', enabled: false } },
    plugins: {
      'acme-sync': {
        client_id: 'acme-client-id', client_secret: PLUGIN_SECRETS[0], access_token: PLUGIN_SECRETS[1],
        refresh_token: PLUGIN_SECRETS[2], auth: { type: 'api-token', token: PLUGIN_SECRETS[3] },
      },
    },
  }))
  // What a build without token tags left on disk before this fix: raw slices under its `m_` keys.
  const day = now.slice(0, 10)
  await fs.mkdir(path.join(LOG_DIR, 'ios-client'), { recursive: true })
  await fs.writeFile(path.join(LOG_DIR, 'ios-client', `${PHONE}-${day}.log`), [
    { device: PHONE, appVersion: '1.0.0 (99)', ts: now, level: 'info', subsystem: 'push', message: 'apns token minted', m_tokenPrefix: APNS.slice(0, 12) },
    { device: PHONE, appVersion: '1.0.0 (99)', ts: now, level: 'warn', subsystem: 'push', message: 'registration refresh', m_memoTokenPrefix: APNS.slice(0, 12) },
    { device: PHONE, appVersion: '1.0.0 (99)', ts: now, level: 'error', subsystem: 'push', message: `upload failed for ${APNS}` },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')

  const srv = await import('../../../src/web/server.js')
  stopServer = srv.stopServer
  server = await srv.startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const timer = setTimeout(() => reject(new Error('the web client did not connect')), 30_000)
    client.on('open', () => { clearTimeout(timer); resolve(client) })
    client.on('error', (err) => { clearTimeout(timer); reject(err) })
    client.on('message', (data) => { frames.push(data.toString()) })
  })

  // A build without token tags uploading through the real route, with the full token too.
  const upload = await fetch(`http://127.0.0.1:${port}/api/v1/client-logs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: PHONE, appVersion: '1.0.0 (99)', os: 'iOS 26.0', lines: [
      { ts: now, level: 'info', subsystem: 'push', message: 'apns token minted', m_tokenPrefix: APNS.slice(0, 12) },
      { ts: now, level: 'info', subsystem: 'push', message: `token ${APNS}` },
    ] }),
  })
  expect(upload.status).toBe(200)

  const app = server.listeners('request').find((l) => typeof (l as unknown as { router?: unknown }).router === 'function') as unknown as { router: RouterFn } | undefined
  if (!app) throw new Error('the Express app is not a request listener of the server')
  const found = new Set<string>()
  collectGets(app.router, '/', found, skipped, new Set())
  routes = [...found].sort()
  // A few at a time: some routes do real work (git, file scans) on purpose.
  const queue = [...routes]
  const workers = Array.from({ length: 4 }, async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) hits.push(await sweepOne(port, p, ROW_ROUTES.includes(p) ? 60_000 : 6_000))
  })
  await Promise.all(workers)
  const byStatus = hits.reduce<Record<string, number>>((acc, h) => { acc[h.status] = (acc[h.status] ?? 0) + 1; return acc }, {})
  console.info(`[sweep] ${routes.length} GET routes requested; answers by status: ${JSON.stringify(byStatus)}`)
}, 600_000)

afterAll(async () => {
  ws?.close()
  await stopServer?.()
  RouterProto.use = originalUse
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('every GET route, against a seeded push registry', () => {
  it('the sweep found the server\'s routes, including the ones that hold push rows', () => {
    expect(routes.length).toBeGreaterThan(150)
    for (const p of ['/api/config', '/api/push/status', '/api/devices', '/api/bug-report']) expect(routes).toContain(p)
    // A route only a param can reach is still swept, with the device's name in it.
    expect(routes.some((p) => p.includes(PHONE))).toBe(true)
    expect(skipped).toEqual([])
  })

  it('no response body carries a token, whole or any 10-character window of it', () => {
    const leaks = hits.filter((h) => h.leak).map((h) => `${h.path} (${h.status}): ${h.leak}`)
    expect(leaks).toEqual([])
    // Most routes answered: a sweep that only collected timeouts proves nothing.
    expect(hits.filter((h) => h.status > 0).length).toBeGreaterThan(routes.length * 0.9)
  })

  it('the routes that read the rows answered, so their silence is real', () => {
    const byPath = new Map(hits.map((h) => [h.path, h]))
    for (const p of ROW_ROUTES) {
      expect(byPath.get(p)?.status, p).toBe(200)
      expect(byPath.get(p)?.bytes, p).toBeGreaterThan(0)
    }
  })
})

describe('the routes that carry a row, by shape', () => {
  const masked = (t: string) => `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${t.slice(-4)}`

  it('GET /api/config masks every row\'s token to its last 4 characters', async () => {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json() as { config: { push_tokens: Array<{ token: string; key_name: string }> } }
    expect(body.config.push_tokens.map((r) => r.token)).toEqual([masked(APNS), masked(EXPO), masked(RELAYED)])
    expect(body.config.push_tokens.map((r) => r.key_name)).toEqual([PHONE, 'acme-old-phone', TABLET])
  })

  it('GET /api/config and GET /api/bug-report never carry a relayed row\'s claims', async () => {
    // The sweep's own answers (the bug report answers once per 5 s).
    const byPath = new Map(hits.map((h) => [h.path, h]))
    const config = byPath.get('/api/config')
    expect(config?.status).toBe(200)
    const rows = (JSON.parse(config?.text ?? '{}') as { config?: { push_tokens?: Array<Record<string, unknown>> } }).config?.push_tokens ?? []
    // The relayed row is there, so its silence is real; it has no `claims` field at all.
    expect(rows.find((r) => r.key_name === TABLET)).toMatchObject({ token: masked(RELAYED), origin: 'relay' })
    expect(rows.filter((r) => 'claims' in r)).toEqual([])
    expect(leakIn(config?.text ?? '')).toBeNull()

    const report = byPath.get('/api/bug-report')
    expect(report?.status).toBe(200)
    // Its config section lists the relayed row (by name; the report masks every token as
    // `[REDACTED]`), without the claims.
    expect(report?.text).toMatch(/=== config \(secrets masked\) ===[\s\S]*"key_name": "acme-tablet"[\s\S]*=== recent server log ===/)
    expect(leakIn(report?.text ?? '')).toBeNull()

    // The registry's own copy keeps them: dropping them is for answers only.
    const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { push_tokens: Array<{ key_name: string; claims?: string[] }> }
    expect(onDisk.push_tokens.find((r) => r.key_name === TABLET)?.claims).toEqual(CLAIMS)
  })

  it('GET /api/push/status names a row by its tag, and the 8-character prefix older apps match on', async () => {
    const { tokenTag } = await import('../../../src/core/push/send.js')
    const body = await (await fetch(`http://127.0.0.1:${port}/api/push/status`)).json() as { tokens: Array<Record<string, unknown>> }
    const apns = body.tokens.find((t) => t.token_tag === tokenTag(APNS))
    expect(apns).toMatchObject({ token_prefix: `${APNS.slice(0, 8)}...`, key_name: PHONE })
  })

  it('PUT /api/config cannot replace a row with the masked value read back', async () => {
    // What Settings does: read the config, save it back whole.
    const read = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json() as { config: Record<string, unknown> }
    expect(JSON.stringify(read.config.push_tokens)).toContain('\u2022')
    // The save is broadcast to every connected client (`web-ui`): that copy is masked too.
    const { bus, EventNames } = await import('../../../src/core/event-bus.js')
    const changed: string[] = []
    bus.subscribe('sweep-config-probe', (event) => {
      if (event.name === EventNames.CONFIG_CHANGED) changed.push(JSON.stringify(event.data))
    }, { global: true })
    try {
      const put = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(read.config),
      })
      expect(put.status).toBe(200)
    } finally {
      bus.unsubscribe('sweep-config-probe')
    }
    const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { push_tokens: Array<{ token: string; claims?: string[] }>; plugins: Record<string, any> }
    expect(onDisk.push_tokens.map((r) => r.token)).toEqual([APNS, EXPO, RELAYED])
    expect(onDisk.push_tokens[2]?.claims).toEqual(CLAIMS)
    // The plugin's secrets were read masked and saved back as masks: each kept its stored value.
    const plugin = onDisk.plugins['acme-sync']
    expect([plugin.client_secret, plugin.access_token, plugin.refresh_token, plugin.auth.token]).toEqual(PLUGIN_SECRETS)
    const broadcast = changed.find((c) => c.includes('push_tokens'))
    expect(broadcast).toBeDefined()
    expect(broadcast).toContain('\u2022')
    expect(leakIn(broadcast ?? '')).toBeNull()
  })

  it('the client log the phone uploaded reached disk scrubbed', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const stored = await fs.readFile(path.join(LOG_DIR, 'ios-client', `${PHONE}-${day}.log`), 'utf-8')
    const uploaded = stored.split('\n').filter((l) => l.includes('"os":"iOS 26.0"'))
    expect(uploaded).toHaveLength(2)
    for (const line of uploaded) {
      expect(line.toLowerCase()).not.toContain(APNS.slice(0, 10))
    }
  })
})

describe('what a connected web client receives', () => {
  /** The same events as the server's own subscribers hear them, before the WebSocket exit. */
  const onBus: string[] = []
  beforeAll(async () => {
    const { bus, EventNames } = await import('../../../src/core/event-bus.js')
    bus.subscribe('sweep-ws-bus-probe', (event) => {
      if (event.name === EventNames.CONFIG_CHANGED) onBus.push(JSON.stringify(event.data ?? null))
    }, { global: true })
  })
  afterAll(async () => {
    const { bus } = await import('../../../src/core/event-bus.js')
    bus.unsubscribe('sweep-ws-bus-probe')
  })
  const masked = (t: string) => `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${t.slice(-4)}`
  type Row = { token: string; key_name: string; claims?: unknown }
  const rowsOf = (config: Record<string, unknown>) => (config.push_tokens ?? []) as Row[]
  const hookOf = async (mutable: string) => {
    const hooks = await (await fetch(`http://127.0.0.1:${port}/api/hooks`)).json() as Array<{ id: string; mutable: string; enabled?: boolean }>
    const hook = hooks.find((h) => h.mutable === mutable)
    expect(hook, mutable).toBeDefined()
    return hook!
  }
  const patchHook = (id: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/hooks/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  /** The newest config frame: the rows as the client got them, and no token or claim anywhere in it. */
  const expectClientView = () => {
    const frame = configFrames().at(-1)!
    expect(leakIn(frame.text)).toBeNull()
    expect(rowsOf(frame.config).map((r) => r.token)).toEqual([masked(APNS), masked(EXPO), masked(RELAYED)])
    expect(rowsOf(frame.config).filter((r) => 'claims' in r)).toEqual([])
  }

  it('toggling a hook override sends config:changed in the client view', async () => {
    const before = configFrames().length
    const busBefore = onBus.length
    const hook = await hookOf('config-override')
    expect((await patchHook(hook.id, { enabled: false })).status).toBe(200)
    await untilConfigFrames(before + 1)
    expectClientView()
    // Already in the client view at the source, not only at the exit.
    const heard = onBus.slice(busBefore).filter((t) => t.includes('push_tokens'))
    expect(heard).toHaveLength(1)
    expect(heard.map(leakIn)).toEqual([null])
  })

  it('toggling a daemon policy sends config:changed in the client view', async () => {
    const before = configFrames().length
    const hook = await hookOf('config-path')
    // Its current value: the route writes and announces it all the same.
    const busBefore = onBus.length
    expect((await patchHook(hook.id, { enabled: hook.enabled === true })).status).toBe(200)
    await untilConfigFrames(before + 1)
    expectClientView()
    const heard = onBus.slice(busBefore).filter((t) => t.includes('push_tokens'))
    expect(heard).toHaveLength(1)
    expect(heard.map(leakIn)).toEqual([null])
  })

  it('changing a host\'s server settings sends config:changed in the client view', async () => {
    const before = configFrames().length
    const busBefore = onBus.length
    // Off, as it was: the route writes the setting and announces it all the same.
    const put = await fetch(`http://127.0.0.1:${port}/api/host-servers/${HOST}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    })
    expect(put.status).toBe(200)
    await untilConfigFrames(before + 1)
    expectClientView()
    expect((configFrames().at(-1)!.config.hosts as Record<string, { server?: unknown }>)[HOST]?.server).toEqual({ enabled: false })
    const heard = onBus.slice(busBefore).filter((t) => t.includes('push_tokens'))
    expect(heard).toHaveLength(1)
    expect(heard.map(leakIn)).toEqual([null])
  })

  it('a relay that re-emits the change under a computed name still sends the client view', async () => {
    const before = configFrames().length
    const { bus } = await import('../../../src/core/event-bus.js')
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    expect(JSON.stringify(raw)).toContain(CLAIMS[0])
    const name = ['config', 'changed'].join(':')
    bus.emit(name, { config: raw }, ['web-ui'], { source: 'relay-probe' })
    await untilConfigFrames(before + 1)
    expectClientView()
  })

  it('no frame the client received in this file carries a token or a claim, and the registry kept both', async () => {
    // The Settings save, both hook writes, the host server setting and the relay: at least five config frames.
    expect(configFrames().length).toBeGreaterThanOrEqual(5)
    const leaks = frames.map((text, i) => ({ i, leak: leakIn(text) })).filter((f) => f.leak)
    expect(leaks).toEqual([])
    const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { push_tokens: Array<{ token: string; claims?: string[] }> }
    expect(onDisk.push_tokens.map((r) => r.token)).toEqual([APNS, EXPO, RELAYED])
    expect(onDisk.push_tokens[2]?.claims).toEqual(CLAIMS)
  })
})
