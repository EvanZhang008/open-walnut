/**
 * Host capabilities through a REAL server (core/hosts/capabilities.ts,
 * host-select.ts): every fleet card carries them, `GET /api/v1/hosts/pick`
 * resolves a `@tag`, and a start that asks for a capability nobody connected
 * has is refused with a sentence, before a task_create makes a task at all.
 *
 * Real: the server, the ops executor, host profiles on a temp WALNUT_HOME.
 * Fake: the daemon connection of this machine (a test has no daemon), so the
 * card's "connected" is under the test's control.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-capability-select'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { __setFleetConnectionsForTesting } from '../../src/core/hosts/fleet.js'
import { recordProbedFacts } from '../../src/core/hosts/host-profile.js'

let server: HttpServer
let port: number

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const op = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN })

const MAC_FACTS = {
  os: { platform: 'darwin', release: '25.1', prettyName: 'macOS 26.1' }, arch: 'arm64', cpus: 12, memBytes: 32 * 1024 ** 3,
  home: '/Users/me', proxyEnv: {}, cloud: { imds: false }, internet: null, tools: { git: 'git version 2.50' }, uptimeSec: 100,
  probedAt: new Date().toISOString(), ios: { xcode: 'Xcode 26.1', runtimes: ['iOS 26.1'] },
  browsers: [{ name: 'chrome', relay: true }], mcp: [{ name: 'playwright' }],
}
function localConn(connected: boolean) {
  return {
    connected, roundTripMs: 1, daemonVersion: 'test', daemonStartedAt: Date.now(), daemonStartup: 'service', daemonInstanceId: 'i-test',
    hasCapability: (c: string) => ['host-facts-v1', 'host-caps-v1'].includes(c),
    send: async (cmd: string) => (cmd === 'host.facts' ? { ok: true, ...MAC_FACTS } : { ok: false, error: 'unknown command' }),
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await recordProbedFacts('__local__', MAC_FACTS as never)
}, 120_000)

afterEach(() => __setFleetConnectionsForTesting(null))
afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('capabilities on the fleet cards', () => {
  it('GET /api/v1/hosts carries each host\'s capabilities, and host_list says them in its line', async () => {
    __setFleetConnectionsForTesting(() => new Map([['__local__', [localConn(true)]]]) as never)
    const r = await api('GET', '/api/v1/hosts')
    expect(r.status).toBe(200)
    const mac = r.body.hosts.find((h: { host: string }) => h.host === '__local__')
    expect(mac.capabilities.tags).toEqual(expect.arrayContaining(['macos', 'ios', 'browser', 'mcp:playwright']))
    expect(mac.capabilities.ios).toEqual({ xcode: 'Xcode 26.1', runtimes: ['iOS 26.1'] })
    expect(mac.line).toContain('iOS (Xcode 26.1, 1 simulator runtime)')
    const listed = await op('host_list', {}) as { outcome?: string; hosts?: Array<{ line: string }> }
    expect(JSON.stringify(listed)).toContain('the user\'s browser (chrome)')
  }, 30_000)
})

describe('@tag host selectors', () => {
  it('resolve to a connected host that has the tag', async () => {
    __setFleetConnectionsForTesting(() => new Map([['__local__', [localConn(true)]]]) as never)
    const r = await api('GET', '/api/v1/hosts/pick?need=ios+browser') // a literal + reads as a space, which also joins
    expect(r.status).toBe(200)
    expect(r.body.pick).toMatchObject({ host: '__local__', tags: ['ios', 'browser'] })
    expect(r.body.pick.reason).toContain('has ios, browser')
  }, 30_000)

  it('refuse when the only host with it is out of reach, and a malformed one, with codes', async () => {
    __setFleetConnectionsForTesting(() => new Map([['__local__', [localConn(false)]]]) as never)
    const off = await api('GET', '/api/v1/hosts/pick?need=ios')
    expect(off.status).toBe(409)
    expect(off.body).toMatchObject({ code: 'no_capable_host' })
    expect(off.body.error).toContain('Every host with ios is out of reach now')
    const bad = await api('GET', '/api/v1/hosts/pick?need=bad%21tag')
    expect(bad).toMatchObject({ status: 400, body: { code: 'bad_selector' } })
  }, 30_000)

  it('task_create with a capability no connected host has makes NO task; task_start answers 409 no_capable_host', async () => {
    __setFleetConnectionsForTesting(() => new Map([['__local__', [localConn(true)]]]) as never)
    const before = (await api('GET', '/api/tasks')).body.tasks?.length ?? 0
    const refused = await op('task_create', { title: 'Needs a GPU', project: 'Caps', host: '@gpu', message: 'train' }) as { ok?: boolean; error?: unknown }
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).toContain('No host Walnut knows has gpu')
    expect((await api('GET', '/api/tasks')).body.tasks?.length ?? 0).toBe(before)

    const made = await api('POST', '/api/tasks', { title: 'Start by capability', project: 'Caps', pinned: false })
    expect(made.status).toBe(201)
    const started = await api('POST', `/api/v1/tasks/${made.body.task.id}/start`, { host: '@gpu', message: 'x' })
    expect(started.status).toBe(409)
    expect(started.body.error).toMatchObject({ code: 'no_capable_host' })
    const malformed = await api('POST', `/api/v1/tasks/${made.body.task.id}/start`, { host: '@bad!tag', message: 'x' })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error).toMatchObject({ code: 'bad_selector' })
  }, 60_000)
})
