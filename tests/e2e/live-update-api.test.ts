/**
 * The live update through a real server (startServer): GET /api/system/update's
 * `live` block, the `system:update` WS frame on every check and state change,
 * and the person's POST install / restart answers.
 *
 * The registry is a local HTTP stub and the installer a stub that the test
 * releases by hand (nothing is downloaded or installed). The checker is swapped
 * for one that believes it is an npm install, as update-check-api does.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import http from 'node:http'
import fs from 'node:fs/promises'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-live-update'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { UpdateChecker, setUpdateCheckerForTest } from '../../src/core/self-update/update-check.js'
import { setLiveUpdateDepsForTest, setRestartHandler } from '../../src/core/self-update/live-update.js'
import { resetUserActivityForTest } from '../../src/core/self-update/idle-gate.js'
import type { InstallInfo } from '../../src/core/self-update/install-kind.js'

const NPM: InstallInfo = {
  kind: 'npm', sourceDir: null, packageRoot: '/nonexistent/lib/node_modules/open-walnut', manager: 'npm',
  updateCommand: 'npm install -g open-walnut@latest',
}

let server: HttpServer
let port: number
let registry: HttpServer
let registryUrl: string
let releaseInstall: (() => void) | null = null
const installs: string[] = []
const unverified: unknown[] = []

interface Live {
  state: string; version: string | null; error: string | null; canInstall: boolean; held: string | null; updatesAuto: boolean
  idle: { ready: boolean; userIdleMs: number | null; turnsRunning: number; waitingSince: string | null }
}
interface Status { current: string; latest: string | null; available: boolean; autoUpdate: boolean; live: Live }

const url = (p: string) => `http://localhost:${port}${p}`
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(url(p), { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, data: r.status === 204 ? null : await r.json() }
}

/** Every `system:update` frame, live; `next(pred)` waits for one that matches. */
function watchUpdates(ws: WebSocket) {
  const frames: Status[] = []
  const waiters: Array<{ pred: (s: Status) => boolean; resolve: (s: Status) => void }> = []
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString()) as { type: string; name?: string; data?: Status }
    if (f.type !== 'event' || f.name !== 'system:update' || !f.data) return
    frames.push(f.data)
    for (const w of [...waiters]) if (w.pred(f.data)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f.data) }
  })
  return {
    frames,
    next: (pred: (s: Status) => boolean, ms = 10_000) => new Promise<Status>((resolve, reject) => {
      const seen = frames.find(pred)
      if (seen) { resolve(seen); return }
      const timer = setTimeout(() => reject(new Error('no matching system:update frame')), ms)
      waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s) } })
    }),
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  registry = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ latest: '0.9.0' }))
  })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
  const addr = registry.address()
  registryUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/-/package/open-walnut/dist-tags`
  setLiveUpdateDepsForTest({
    canSelfInstall: (s) => s.install.kind === 'npm',
    held: () => null,
    busy: async () => null,
    install: async (_s, version) => {
      installs.push(version)
      await new Promise<void>((resolve) => { releaseInstall = resolve })
      return { from: '0.5.1' }
    },
    markUnverified: (p) => { unverified.push(p) },
    turnsRunning: async () => 0,
    restartDelayMs: 50,
  })
  // A test run is refused only where the header is honoured (not on a throwaway server by default).
  process.env.WALNUT_TEST_RUN_MARK = '1'
  server = await startServer({ port: 0, dev: true })
  const saddr = server.address()
  port = typeof saddr === 'object' && saddr ? saddr.port : 0
  setUpdateCheckerForTest(new UpdateChecker({ registryUrl, current: '0.5.1', currentKnown: true, install: NPM, env: {} }))
}, 30_000)

afterAll(async () => {
  delete process.env.WALNUT_TEST_RUN_MARK
  setRestartHandler(null)
  setLiveUpdateDepsForTest(null)
  releaseInstall?.()
  await stopServer()
  registry.closeAllConnections()
  await new Promise<void>((resolve) => registry.close(() => resolve()))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('live update API', () => {
  it('GET carries `live` beside every old field; heartbeats from the web and the phone count as the person', async () => {
    resetUserActivityForTest()
    const before = await api('GET', '/api/system/update')
    expect(before.status).toBe(200)
    expect(before.data).toMatchObject({ current: '0.5.1', available: false, autoUpdate: false })
    expect(before.data.live).toMatchObject({ state: 'idle', version: null, error: null, canInstall: false, held: null, updatesAuto: true })
    expect(before.data.live.idle).toMatchObject({ ready: false, userIdleMs: null, turnsRunning: 0, waitingSince: null })

    const sample = { ts: new Date(Date.now() - 30_000).toISOString(), durationMs: 20_000, kind: 'session' }
    expect((await api('POST', '/api/time/heartbeats', { samples: [sample] })).status).toBe(204)
    const web = (await api('GET', '/api/system/update')).data.live.idle.userIdleMs
    expect(web).toBeGreaterThanOrEqual(9_000)
    expect(web).toBeLessThan(60_000)

    resetUserActivityForTest()
    const phone = { ...sample, id: 'phone-1', ts: new Date(Date.now() - 5_000).toISOString(), durationMs: 4_000 }
    const v1 = await api('POST', '/api/v1/time/heartbeats', { samples: [phone] })
    expect(v1.status).toBe(204)
    expect((await api('GET', '/api/system/update')).data.live.idle.userIdleMs).toBeLessThan(10_000)
  })

  it('a test run (a browser under automation) never installs or restarts this Walnut', async () => {
    for (const action of ['install', 'restart']) {
      const r = await fetch(url(`/api/system/update/${action}`), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-test-run': 'webdriver-e2e' }, body: '{}',
      })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { error: string }).error).toBe('test_run')
    }
    expect(installs).toEqual([])
  })

  it('no restart handler: Update answers cannot_install with the command, Restart no_update before an install', async () => {
    const install = await api('POST', '/api/system/update/install', {})
    expect(install.status).toBe(409)
    expect(install.data.error).toBe('cannot_install')
    // This install's prefix is not writable here, so the command is the one the start names for it.
    expect(install.data.fix).toMatch(/npm install -g open-walnut@latest/)
    const restart = await api('POST', '/api/system/update/restart', {})
    expect(restart.status).toBe(409)
    expect(restart.data).toMatchObject({ error: 'no_update' })
  })

  it('a check that finds a newer release installs it in the background, pushed as system:update', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
    const updates = watchUpdates(ws)
    try {
      expect((await api('POST', '/api/system/update/check')).status).toBe(200)
      const downloading = await updates.next((s) => s.live.state === 'downloading')
      expect(downloading).toMatchObject({ latest: '0.9.0', available: true, live: { version: '0.9.0' } })
      // The check itself is pushed too, with the full status.
      expect(updates.frames.some((s) => s.latest === '0.9.0')).toBe(true)
      expect(installs).toEqual(['0.9.0'])
      releaseInstall!()
      const installed = await updates.next((s) => s.live.state === 'installed')
      expect(installed.live).toMatchObject({ version: '0.9.0', error: null, canInstall: false })
      expect(unverified).toEqual([{ version: '0.9.0', from: '0.5.1' }, { version: '0.9.0', from: '0.5.1' }])
      const got = await api('GET', '/api/system/update')
      expect(got.data).toMatchObject({ installed: '0.9.0', live: { state: 'installed', version: '0.9.0' } })
      expect(got.data.live.idle.waitingSince).toEqual(expect.any(String))

      // Installed, but nothing can restart this server: Restart says so.
      const refused = await api('POST', '/api/system/update/restart', {})
      expect(refused.status).toBe(409)
      expect(refused.data).toMatchObject({ error: 'no_restart' })

      // With a handler (what web.ts registers), Restart restarts at once: pushed, then the handler.
      const handler = vi.fn()
      setRestartHandler(handler)
      expect((await api('GET', '/api/system/update')).data.live.canInstall).toBe(true)
      const asked = await fetch(url('/api/system/update/restart'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': 'session-under-test' }, body: '{}',
      })
      expect(asked.status).toBe(202)
      expect(((await asked.json()) as Status).live.state).toBe('restarting')
      await updates.next((s) => s.live.state === 'restarting')
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 5_000 })
      // A second ask while it restarts is the same restart.
      expect((await api('POST', '/api/system/update/install', {})).status).toBe(202)
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      ws.close()
    }
  }, 30_000)
})
