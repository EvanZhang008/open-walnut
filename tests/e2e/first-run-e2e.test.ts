/**
 * First-run setup on a real server (src/core/first-run.ts, src/web/routes/first-run.ts):
 * a server that starts on an empty data home stamps the config.yaml it creates with the
 * questions it asks, lists them until answered, and records an answer once. The hosts
 * the question offers are the ones ~/.ssh/config holds (a throwaway home here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

let server: HttpServer
let port: number
let isolation: SshIsolation
const prevFlag = process.env.WALNUT_FIRST_RUN_SETUP
const prevMark = process.env.WALNUT_TEST_RUN_MARK

const api = (pathname: string, init?: RequestInit) => fetch(`http://localhost:${port}${pathname}`, init)
const post = (pathname: string, body?: unknown) => api(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const stored = async (): Promise<Record<string, any>> => yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as Record<string, any>

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  // A test server stamps nothing unless asked (its fixture pages would open under the dialog).
  process.env.WALNUT_FIRST_RUN_SETUP = '1'
  // Test-run marking on, as on the person's own server, so an automated browser's answer is told apart.
  process.env.WALNUT_TEST_RUN_MARK = '1'
  isolation = isolateFromRealSsh(path.join(path.dirname(WALNUT_HOME), 'first-run-ssh'))
  await fs.writeFile(path.join(isolation.home, '.ssh', 'config'), [
    'Host lab-mac', '  HostName lab-mac.invalid', '  User sam', '  Port 2222',
    'Host *', '  ServerAliveInterval 30', '',
  ].join('\n'))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  isolation?.restore()
  if (prevFlag === undefined) delete process.env.WALNUT_FIRST_RUN_SETUP
  else process.env.WALNUT_FIRST_RUN_SETUP = prevFlag
  if (prevMark === undefined) delete process.env.WALNUT_TEST_RUN_MARK
  else process.env.WALNUT_TEST_RUN_MARK = prevMark
})

describe('first-run setup on a fresh install', () => {
  it('the config the fresh install created asks the hosts question', async () => {
    const doc = await stored()
    expect(doc.first_run).toMatchObject({ steps: ['hosts'] })
    expect(typeof doc.first_run.at).toBe('string')
    expect(doc.first_run.answered).toBeUndefined()
    expect(await (await api('/api/first-run')).json()).toEqual({ pending: ['hosts'] })
  })

  it('offers the hosts of ~/.ssh/config, waiting for the yes, and dials none of them', async () => {
    const config = (await (await api('/api/config')).json() as { config: { hosts: Record<string, any> } }).config
    expect(config.hosts['lab-mac']).toMatchObject({ hostname: 'lab-mac.invalid', user: 'sam', port: 2222, discovered: true, connect: 'ask', enabled: false })
    expect(Object.keys(config.hosts)).not.toContain('*')
    expect(isolation.calls().join('\n')).not.toContain('lab-mac.invalid')
  })

  it("a test run's answer (an automated browser) records nothing, so the person is still asked", async () => {
    const res = await api('/api/first-run/answer', { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-test-run': 'first-run-e2e' }, body: JSON.stringify({ step: 'hosts' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, recorded: false })
    expect((await stored()).first_run.answered).toBeUndefined()
    expect(await (await api('/api/first-run')).json()).toEqual({ pending: ['hosts'] })
  })

  it('records an answer once, keeps the rest of the config, and asks nothing more', async () => {
    expect((await post('/api/first-run/answer', { step: 'nope' })).status).toBe(400)
    const before = await stored()
    const res = await post('/api/first-run/answer', { step: 'hosts' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pending: [] })
    const doc = await stored()
    const at = doc.first_run.answered.hosts
    expect(typeof at).toBe('string')
    expect(doc.first_run.steps).toEqual(['hosts'])
    expect(doc.agent).toEqual(before.agent)
    // A second answer (another window's Not now) changes nothing.
    await post('/api/first-run/answer', { step: 'hosts' })
    expect((await stored()).first_run.answered.hosts).toBe(at)
    expect(await (await api('/api/first-run')).json()).toEqual({ pending: [] })
  })
})
