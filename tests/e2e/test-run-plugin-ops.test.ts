/**
 * A plugin op learns that the request it serves is a test run (`walnut.testRun()`), through a
 * REAL server with marking on (`WALNUT_TEST_RUN_MARK=1`), on every way an op is reached from a
 * client: the plugin-runtime op route (the App, a notice button) and the cloud companion's
 * relay to the Mac (`server.plugin-op`, which carries the label in its params).
 *
 * 2026-11-02: a test browser on the user's Walnut started a Rhythm focus block, which held quiet
 * for its hour (the phone too) and turned the Mac's Do Not Disturb on. Rhythm refuses its write
 * ops when this names a test run (tests/plugins/walnut-rhythm/activate.test.ts); this file checks
 * the host hands the label over, and only to the request that carries it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { handlePluginControlRelay } from '../../src/core/plugins/plugin-control-relay.js'

let server: HttpServer
let port: number
const savedMark = process.env.WALNUT_TEST_RUN_MARK

// The op answers with what it read at its start and after an await: the label must survive both.
const PROBE_SERVER = `
export function activate(walnut) {
  walnut.registry.op({
    name: 'who', title: 'who', description: 'Test-run probe', readonly: false, remote: 'allow',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const first = walnut.testRun?.() ?? null
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { first, later: walnut.testRun?.() ?? null }
    },
  })
}
`

async function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

const who = (headers: Record<string, string> = {}) => api('POST', '/api/plugin-runtime/probe/ops/probe_who', {}, headers)

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const dir = path.join(WALNUT_HOME, 'plugins', 'probe')
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs',
  }))
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), PROBE_SERVER)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // Plugins activate after the server listens.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && (await who()).status !== 200) await new Promise((r) => setTimeout(r, 200))
}, 90_000)

afterAll(async () => {
  await stopServer()
  if (savedMark === undefined) delete process.env.WALNUT_TEST_RUN_MARK
  else process.env.WALNUT_TEST_RUN_MARK = savedMark
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('walnut.testRun() in a plugin op', () => {
  it('the op route: a test run\'s request reads its label, across an await; a plain request reads none', async () => {
    const run = await who({ 'x-walnut-test-run': 'webdriver-probe' })
    expect(run.status).toBe(200)
    expect(run.data).toMatchObject({ ok: true, result: { first: 'webdriver-probe', later: 'webdriver-probe' } })
    expect((await who()).data).toMatchObject({ ok: true, result: { first: null, later: null } })
    // `0` is no test run (a page that ended its run).
    expect((await who({ 'x-walnut-test-run': '0' })).data).toMatchObject({ result: { first: null } })
  })

  it('the companion\'s relay: the label in its params reaches the op; none, and the op reads none', async () => {
    const relayed = await handlePluginControlRelay('server.plugin-op', { pluginId: 'probe', opName: 'probe_who', args: {}, testRun: 'companion-run' })
    // The relay's result is the op route's own answer, envelope included.
    expect(relayed).toMatchObject({ ok: true, result: { ok: true, result: { first: 'companion-run', later: 'companion-run' } } })
    const plain = await handlePluginControlRelay('server.plugin-op', { pluginId: 'probe', opName: 'probe_who', args: {} })
    expect(plain).toMatchObject({ ok: true, result: { ok: true, result: { first: null, later: null } } })
  })
})
