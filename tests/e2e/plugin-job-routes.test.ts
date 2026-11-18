/**
 * A plugin whose job serves routes, through a REAL server (web/plugin-route-dispatcher.ts,
 * core/plugin-jobs/serve.ts): the server half's routes answer first; a path none of them
 * answers goes to the job's layer, which on a test server (it places no job) answers 503
 * at once with the plain reason, never a hang or a bare 404. A plugin with no serving job
 * keeps its 404. The forward itself to a real daemon and job process is
 * tests/integration/plugin-jobs-serve-twins.test.ts: a test server dials no daemon.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-job-routes'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

let server: HttpServer
let port: number

const SERVER = `
export function activate(walnut) {
  walnut.http.route('GET', '/local', () => ({ json: { from: 'server half' } }))
}
export const jobs = {
  async worker(walnut, signal) {
    walnut.http.route('GET', '/queue', () => ({ json: { from: 'job' } }))
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
  },
}
`

async function plugin(id: string, jobs: Record<string, unknown>): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', id)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', jobs,
  }))
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), SERVER)
}

async function get(route: string): Promise<{ status: number; body: any; retryAfter: string | null }> {
  const r = await fetch(`http://localhost:${port}${route}`, { headers: { Authorization: 'Bearer never-forwarded' } })
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body, retryAfter: r.headers.get('retry-after') }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await plugin('acme-door', { worker: { kind: 'long-running', serves: true } })
  await plugin('acme-plain', { worker: { kind: 'long-running' } })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // Plugins activate after the server listens.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const [a, b] = await Promise.all([get('/api/plugins/acme-door/local'), get('/api/plugins/acme-plain/local')])
    if (a.status === 200 && b.status === 200) break
    await new Promise((r) => setTimeout(r, 200))
  }
}, 90_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('plugin job routes through the real server', () => {
  it('the server half answers its own routes', async () => {
    const r = await get('/api/plugins/acme-door/local')
    expect(r).toMatchObject({ status: 200, body: { from: 'server half' } })
  })

  it('a path the server half does not answer goes to the job, and a test server says plainly why it cannot', async () => {
    const started = Date.now()
    const r = await get('/api/plugins/acme-door/queue')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ error: expect.stringMatching(/^this plugin's routes come from its job, and plugin jobs do not run on a test server/) })
  })

  it('a plugin without a serving job keeps its 404', async () => {
    expect((await get('/api/plugins/acme-plain/queue')).status).toBe(404)
  })
})
