/**
 * updates.auto turned on in Settings (PUT /api/config) acts at once through a real
 * server: with a newer release already known, the live update installs it now
 * instead of at the next 6-hourly check (2026-11-03 review: the page said
 * "Updating..." and nothing happened for hours). Registry and installer are stubs.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import http from 'node:http'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-live-update-auto-on'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { UpdateChecker, setUpdateCheckerForTest } from '../../src/core/self-update/update-check.js'
import { setLiveUpdateDepsForTest } from '../../src/core/self-update/live-update.js'
import type { InstallInfo } from '../../src/core/self-update/install-kind.js'

const NPM: InstallInfo = {
  kind: 'npm', sourceDir: null, packageRoot: '/nonexistent/lib/node_modules/open-walnut', manager: 'npm',
  updateCommand: 'npm install -g open-walnut@latest',
}

let server: HttpServer
let port: number
let registry: HttpServer
const installs: string[] = []

const url = (p: string) => `http://localhost:${port}${p}`
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(url(p), { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, data: r.status === 204 ? null : await r.json() }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  registry = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ latest: '0.9.0' })) })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
  const addr = registry.address()
  const registryUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/-/package/open-walnut/dist-tags`
  setLiveUpdateDepsForTest({
    canSelfInstall: (s) => s.install.kind === 'npm',
    held: () => null,
    busy: async () => null,
    unverified: () => null,
    install: async (_s, version) => { installs.push(version); return { from: '0.5.1' } },
    markUnverified: () => {},
    installedLater: () => null,
    turnsRunning: async () => 0,
  })
  server = await startServer({ port: 0, dev: true })
  const saddr = server.address()
  port = typeof saddr === 'object' && saddr ? saddr.port : 0
  setUpdateCheckerForTest(new UpdateChecker({ registryUrl, current: '0.5.1', currentKnown: true, install: NPM, env: {} }))
}, 30_000)

afterAll(async () => {
  setLiveUpdateDepsForTest(null)
  await stopServer()
  registry.closeAllConnections()
  await new Promise<void>((resolve) => registry.close(() => resolve()))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('live update: updates.auto turned on', () => {
  it('a release found while auto was off installs as soon as Settings turns auto on', async () => {
    expect((await api('PUT', '/api/config', { updates: { auto: false } })).status).toBe(200)
    await vi.waitFor(async () => expect((await api('GET', '/api/system/update')).data.live.state).toBe('off'))
    expect((await api('POST', '/api/system/update/check')).status).toBe(200)
    await vi.waitFor(async () => expect((await api('GET', '/api/system/update')).data.available).toBe(true))
    expect(installs).toEqual([])

    expect((await api('PUT', '/api/config', { updates: { auto: true } })).status).toBe(200)
    await vi.waitFor(() => expect(installs).toEqual(['0.9.0']), { timeout: 5_000 })
    await vi.waitFor(async () => expect((await api('GET', '/api/system/update')).data.live).toMatchObject({ state: 'installed', version: '0.9.0' }))
  }, 30_000)
})
