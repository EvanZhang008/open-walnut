/**
 * The Overview opens on what Walnut read last and reads the hosts again only when the
 * person asks (core/hosts/fleet-cache.ts, fleet-refresh.ts, GET /api/v1/hosts?cached=1,
 * POST /api/v1/hosts/refresh). 2026-11-03: the page sat on "Reading each host..." for
 * half a minute on every open, waiting on its slowest host.
 *
 * Real: the server, its routes, the cache file in a temp WALNUT_HOME, host profiles.
 * Fake: the daemon connections (a test has no remote daemon), so each host answers,
 * hangs or fails under the test's control, and placement's view of each host.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-fleet-cache-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { __setFleetConnectionsForTesting, __setFleetLoadsForTesting } from '../../src/core/hosts/fleet.js'
import { __setFleetRefreshDeadlinesForTesting, fleetRefreshIdle, readHostsOnConnect } from '../../src/core/hosts/fleet-refresh.js'
import { __resetFleetCacheForTesting, flushFleetCacheNow } from '../../src/core/hosts/fleet-cache.js'

let server: HttpServer
let port: number
const CACHE_FILE = () => path.join(WALNUT_HOME, 'local', 'fleet-cache.json')

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any; ms: number }> {
  const started = Date.now()
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, ms: Date.now() - started }
}
const cached = () => api('GET', '/api/v1/hosts?cached=1')
const byHost = (body: { hosts: Array<{ host: string }> }) => new Map(body.hosts.map((h) => [h.host, h as any]))

function vitals(cpuUtil: number) {
  const now = Date.now()
  return {
    ok: true,
    stats: { sampledAt: now, cpus: 8, cpuUtil, load: [1, 1, 1], memTotalBytes: 16, memAvailBytes: 8, uptimeSec: 100, bootedAt: now - 100_000, daemonStartedAt: now - 50_000, linked: true, running: 3 },
    history: { coverageFrom: now - 3_600_000, bucketMinutes: 1440, buckets: [], windows: [{ days: 7, minutes: 60, up: 60, linked: 60, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
    ledger: { lastWriteAt: now, writeErrors: 0, lastError: null },
  }
}

/** A daemon link whose host.vitals answer the test decides, one call at a time. */
function host(answer: () => Promise<Record<string, unknown>>) {
  const h = {
    answer,
    asks: 0,
    conn: {
      connected: true, roundTripMs: 30, daemonVersion: 'test', daemonStartedAt: Date.now(), daemonStartup: 'service', daemonInstanceId: 'i-test',
      hasCapability: (c: string) => c === 'host-vitals-v1',
      send: (cmd: string) => {
        if (cmd !== 'host.vitals') return Promise.resolve({ ok: false, error: 'unknown command' })
        h.asks++
        return h.answer()
      },
    },
  }
  return h
}

let mac: ReturnType<typeof host>, dev: ReturnType<typeof host>, slow: ReturnType<typeof host>
function useHosts(): void {
  __setFleetConnectionsForTesting(() => new Map([['__local__', [mac.conn]], ['devbox', [dev.conn]], ['slowbox', [slow.conn]]]) as never)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example', label: 'Dev box' }, slowbox: { hostname: 'slowbox.example' } } } as never)
}, 120_000)

beforeEach(async () => {
  await fs.rm(CACHE_FILE(), { force: true })
  __setFleetLoadsForTesting(async (hosts) => hosts.map((h) => ({ host: h, label: h, known: false, score: 0, busy: true, reasons: ['its load is unknown'], weight: 50, running: 0, runningLimit: 10 }) as never))
  __setFleetRefreshDeadlinesForTesting({ sendMs: 5_000, hostMs: 1_000 })
  mac = host(async () => vitals(0.1))
  dev = host(async () => vitals(0.5))
  slow = host(async () => vitals(0.3))
  useHosts()
})
afterEach(async () => {
  await fleetRefreshIdle()
  __setFleetConnectionsForTesting(null)
  __setFleetLoadsForTesting(null)
  __setFleetRefreshDeadlinesForTesting(null)
})
afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the cached overview', () => {
  it('answers at once while a host is still being read, and each card lands when its own read ends', async () => {
    // Room for the held host to stay held while the test looks (a busy machine is slow).
    __setFleetRefreshDeadlinesForTesting({ sendMs: 20_000, hostMs: 15_000 })
    let release: () => void = () => {}
    slow.answer = () => new Promise((resolve) => { release = () => resolve(vitals(0.3)) })

    const first = await cached()
    expect(first.status).toBe(200)
    expect(first.body.refreshing).toBe(false)
    expect(first.body.hosts.map((h: { host: string }) => h.host)).toEqual(['__local__', 'devbox', 'slowbox'])
    expect(first.body.hosts.every((h: { readAt: unknown; now: unknown }) => h.readAt === null && h.now === null)).toBe(true)
    expect(dev.asks).toBe(0) // the cached read never asks a host

    const started = await api('POST', '/api/v1/hosts/refresh', {})
    expect(started.status).toBe(202)
    expect(started.body.started).toEqual(['__local__', 'devbox', 'slowbox'])
    expect(started.ms).toBeLessThan(1_000) // it does not wait for the hung host

    // The dev box's card is there while the slow box is still being read.
    await vi.waitFor(async () => expect(byHost((await cached()).body).get('devbox').readAt).not.toBeNull(), { timeout: 5_000 })
    const mid = await cached()
    expect(mid.ms).toBeLessThan(1_000)
    expect(mid.body.refreshing).toBe(true)
    const midHosts = byHost(mid.body)
    expect(midHosts.get('devbox')).toMatchObject({ refreshing: false, readError: null, now: { cpuUtil: 0.5, stale: false } })
    expect(midHosts.get('slowbox')).toMatchObject({ refreshing: true, readAt: null, now: null })

    release()
    await fleetRefreshIdle()
    const done = await cached()
    expect(done.body.refreshing).toBe(false)
    expect(byHost(done.body).get('slowbox')).toMatchObject({ refreshing: false, now: { cpuUtil: 0.3 } })
    expect(byHost(done.body).get('slowbox').readAt).toEqual(expect.any(Number))
  }, 30_000)

  it('a refresh changes only the hosts that answered; one that fails keeps its card and says why', async () => {
    await api('POST', '/api/v1/hosts/refresh', {})
    await fleetRefreshIdle()
    const before = byHost((await cached()).body)
    const slowReadAt = before.get('slowbox').readAt as number
    expect(before.get('slowbox').now.cpuUtil).toBe(0.3)

    dev.answer = async () => vitals(0.9)
    slow.answer = async () => { throw new Error('ssh: connection reset') }
    mac.answer = () => new Promise(() => {}) // never answers: its read ends at its own deadline
    await new Promise((r) => setTimeout(r, 5))
    await api('POST', '/api/v1/hosts/refresh', {})
    await fleetRefreshIdle()
    const after = byHost((await cached()).body)
    expect(after.get('devbox')).toMatchObject({ readError: null, now: { cpuUtil: 0.9, stale: false } })
    expect(after.get('devbox').readAt).toBeGreaterThan(before.get('devbox').readAt)
    // The failed host: the reading it had, marked stale, with the error and when it failed.
    expect(after.get('slowbox')).toMatchObject({ readAt: slowReadAt, readError: 'ssh: connection reset', now: { cpuUtil: 0.3, stale: true } })
    expect(after.get('slowbox').readFailedAt).toBeGreaterThanOrEqual(slowReadAt)
    expect(after.get('__local__')).toMatchObject({ readError: 'it did not answer in 1 s', now: { cpuUtil: 0.1, stale: true } })

    // The next read that works clears the error.
    slow.answer = async () => vitals(0.4)
    await api('POST', '/api/v1/hosts/refresh', { hosts: ['slowbox'] })
    await fleetRefreshIdle()
    expect(byHost((await cached()).body).get('slowbox')).toMatchObject({ readError: null, readFailedAt: null, now: { cpuUtil: 0.4, stale: false } })
  }, 30_000)

  it('a host that is away keeps its last reading, stale, and its link is live without a read', async () => {
    await api('POST', '/api/v1/hosts/refresh', {})
    await fleetRefreshIdle()
    dev.conn.connected = false
    const away = byHost((await cached()).body).get('devbox')
    expect(away.now).toMatchObject({ cpuUtil: 0.5, stale: true })
    // Its session count stays too, with when it was read (2026-11-04: "cache ... until the real data come").
    expect(away.sessions).toMatchObject({ running: 3, source: 'host', at: away.now.at })
    expect(dev.asks).toBe(1)
  }, 30_000)

  it('the cache survives a restart, and a file that does not parse is ignored', async () => {
    await api('POST', '/api/v1/hosts/refresh', {})
    await fleetRefreshIdle()
    await flushFleetCacheNow()
    const stored = JSON.parse(await fs.readFile(CACHE_FILE(), 'utf8'))
    expect(stored.version).toBe(1)
    expect(stored.hosts.devbox.vitals.value.stats.cpuUtil).toBe(0.5)
    const readAt = stored.hosts.devbox.readAt

    // A restart: every in-memory cache gone, and every host away.
    for (const h of [mac, dev, slow]) h.conn.connected = false
    useHosts()
    __resetFleetCacheForTesting()
    const back = byHost((await cached()).body)
    expect(back.get('devbox')).toMatchObject({ readAt, now: { cpuUtil: 0.5, stale: true } })
    expect(dev.asks).toBe(1)

    await fs.writeFile(CACHE_FILE(), '{"version":1,"hosts":{"devbox":')
    __resetFleetCacheForTesting()
    const empty = await cached()
    expect(empty.status).toBe(200)
    expect(empty.body.hosts.every((h: { readAt: unknown }) => h.readAt === null)).toBe(true)
    // The next read writes a good file over it.
    for (const h of [mac, dev, slow]) h.conn.connected = true
    await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox'] })
    await fleetRefreshIdle()
    await flushFleetCacheNow()
    expect(JSON.parse(await fs.readFile(CACHE_FILE(), 'utf8')).hosts.devbox.vitals.value.stats.cpuUtil).toBe(0.5)
  }, 30_000)

  it('after a restart, a fleet read of another kind keeps the readings the file holds', async () => {
    // Placement reads every connected host, as on a real Mac: each such read records its load.
    __setFleetLoadsForTesting(async (hosts) => hosts.map((h) => ({ host: h, label: h, known: true, score: 5, busy: false, reasons: [], weight: 50, running: 0, runningLimit: 10 }) as never))
    await api('POST', '/api/v1/hosts/refresh', {})
    await fleetRefreshIdle()
    await flushFleetCacheNow()
    const readAt = byHost((await cached()).body).get('devbox').readAt
    expect(readAt).toEqual(expect.any(Number))

    // A restart, then the session prompt's read of the fleet (7 days, live) before anyone opens the Overview.
    useHosts()
    expect((await api('GET', '/api/v1/hosts?days=7')).status).toBe(200)
    await flushFleetCacheNow()
    useHosts() // and another restart: the next open reads the file
    const back = byHost((await cached()).body)
    expect(back.get('devbox')).toMatchObject({ readAt, now: { cpuUtil: 0.5 }, placement: { score: expect.any(Number) } })
    expect(back.get('__local__').readAt).toEqual(expect.any(Number))
  }, 30_000)

  it('a reading kept from long ago reads as the last reading, not as now', async () => {
    const at = Date.now() - 2 * 3_600_000
    const old = { readAt: at, vitals: { at, value: vitals(0.5) }, stale: false, load: null, error: null, errorAt: null }
    await fs.mkdir(path.dirname(CACHE_FILE()), { recursive: true })
    await fs.writeFile(CACHE_FILE(), JSON.stringify({ version: 1, hosts: { devbox: old }, spend: null }))
    useHosts() // a restart onto that file; the dev box is connected and answering
    const devbox = byHost((await cached()).body).get('devbox')
    expect(devbox).toMatchObject({ readAt: at, readError: null, now: { cpuUtil: 0.5, stale: true }, sessions: { running: 3, source: 'host', at } })
    expect(devbox.line).toContain('(last reading)')
    expect(dev.asks).toBe(0)
    // A fresh read is now again.
    await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox'] })
    await fleetRefreshIdle()
    expect(byHost((await cached()).body).get('devbox')).toMatchObject({ now: { stale: false }, sessions: { running: 3 } })
  }, 30_000)

  it('the plain read stays live, as older pages and agents expect, and what it reads lands in the cache', async () => {
    const live = await api('GET', '/api/v1/hosts')
    expect(live.status).toBe(200)
    expect(live.body.refreshing).toBeUndefined()
    expect(byHost(live.body).get('devbox').now).toMatchObject({ cpuUtil: 0.5, stale: false })
    await vi.waitFor(async () => expect(byHost((await cached()).body).get('devbox').readAt).not.toBeNull())
  }, 30_000)

  it('a refresh of named hosts reads only those, and a bad list is refused', async () => {
    const one = await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox', 'nosuch'] })
    expect(one).toMatchObject({ status: 202, body: { started: ['devbox'] } })
    await fleetRefreshIdle()
    expect([mac.asks, dev.asks, slow.asks]).toEqual([0, 1, 0])
    expect((await api('POST', '/api/v1/hosts/refresh', { hosts: 'devbox' })).status).toBe(400)
    expect((await api('POST', '/api/v1/hosts/refresh', { hosts: ['bad host!'] })).status).toBe(400)
    // A host already being read is not read twice.
    dev.answer = () => new Promise((r) => setTimeout(() => r(vitals(0.5)), 200))
    const a = await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox'] })
    const b = await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox'] })
    expect(a.body.started).toEqual(['devbox'])
    expect(b.body).toMatchObject({ started: [], refreshing: ['devbox'] })
    await fleetRefreshIdle()
    expect(dev.asks).toBe(2)
  }, 30_000)
})

/**
 * 2026-11-04: a Mac that joined while the Overview was open read "not read yet" with no
 * profile until someone pressed Refresh: its only read had run while it was away, and
 * nothing read it again once it connected (readHostsOnConnect, fleet-refresh.ts).
 */
describe('a host that connects is read once', () => {
  function connects() {
    let fire: (host: string) => void = () => {}
    let subscribed = 0
    const onConnected = (cb: (host: string) => void) => { fire = cb; subscribed++; return () => { fire = () => {}; subscribed-- } }
    return { onConnected, fire: (h: string) => fire(h), subscribed: () => subscribed }
  }

  it('read while away, then connected: its card fills without a press', async () => {
    __setFleetRefreshDeadlinesForTesting({ sendMs: 5_000, hostMs: 1_000, connectReadDelayMs: 10 })
    dev.conn.connected = false
    await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox'] })
    await fleetRefreshIdle()
    const before = byHost((await cached()).body).get('devbox')
    expect(before.readAt).toEqual(expect.any(Number))
    expect(before.now).toBeNull()
    expect(dev.asks).toBe(0)

    const c = connects()
    const off = readHostsOnConnect(c.onConnected)
    dev.conn.connected = true
    c.fire('devbox')
    await vi.waitFor(() => expect(dev.asks).toBe(1), { timeout: 5_000 })
    await fleetRefreshIdle()
    expect(byHost((await cached()).body).get('devbox')).toMatchObject({ now: { cpuUtil: 0.5, stale: false } })
    // The other hosts were not read for it.
    expect(mac.asks + slow.asks).toBe(0)
    off()
    expect(c.subscribed()).toBe(0)
  }, 30_000)

  // 2026-11-04 review: the throttle was set before the read, so a host that dropped inside the
  // delay was not read for 5 minutes after it came back.
  it('a host that drops again before its read is read when it comes back', async () => {
    __setFleetRefreshDeadlinesForTesting({ sendMs: 5_000, hostMs: 1_000, connectReadDelayMs: 10 })
    const c = connects()
    const off = readHostsOnConnect(c.onConnected)
    const asked = dev.asks
    dev.conn.connected = false
    c.fire('devbox')
    await new Promise((r) => setTimeout(r, 100))
    await fleetRefreshIdle()
    expect(dev.asks).toBe(asked)
    dev.conn.connected = true
    c.fire('devbox')
    await vi.waitFor(() => expect(dev.asks).toBe(asked + 1), { timeout: 5_000 })
    await fleetRefreshIdle()
    off()
  }, 30_000)

  it('a fresh card is not read again, a host that keeps reconnecting is read once per window, and an unsubscribe cancels a read not yet started', async () => {
    __setFleetRefreshDeadlinesForTesting({ sendMs: 5_000, hostMs: 1_000, connectReadDelayMs: 10 })
    await api('POST', '/api/v1/hosts/refresh', { hosts: ['devbox'] })
    await fleetRefreshIdle()
    expect(dev.asks).toBe(1)
    const c = connects()
    const off = readHostsOnConnect(c.onConnected)
    c.fire('devbox')
    await new Promise((r) => setTimeout(r, 100))
    await fleetRefreshIdle()
    expect(dev.asks).toBe(1)

    // An older daemon with no host.vitals never reads fresh: one read per window, not one per flap.
    slow.conn.hasCapability = () => false
    let slowReads = 0
    __setFleetLoadsForTesting(async (hosts) => {
      if (hosts.includes('slowbox')) slowReads++
      return hosts.map((h) => ({ host: h, label: h, known: false, score: 0, busy: true, reasons: [], weight: 50, running: 0, runningLimit: 10 }) as never)
    })
    c.fire('slowbox')
    await new Promise((r) => setTimeout(r, 100))
    await fleetRefreshIdle()
    c.fire('slowbox')
    c.fire('slowbox')
    await new Promise((r) => setTimeout(r, 100))
    await fleetRefreshIdle()
    expect(byHost((await cached()).body).get('slowbox').readAt).toEqual(expect.any(Number))
    expect(slowReads).toBe(1)
    off()

    __setFleetRefreshDeadlinesForTesting({ sendMs: 5_000, hostMs: 1_000, connectReadDelayMs: 200 })
    const again = connects()
    const off2 = readHostsOnConnect(again.onConnected)
    again.fire('__local__')
    off2()
    await new Promise((r) => setTimeout(r, 400))
    await fleetRefreshIdle()
    expect(mac.asks).toBe(0)
  }, 30_000)
})
