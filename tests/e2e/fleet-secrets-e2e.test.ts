/**
 * Fleet secrets through a REAL server (core/secrets/fleet-secrets.ts,
 * routes/secrets-v1.ts, ops/secrets.ts): the user adds a secret on the Mac and
 * picks its hosts; each host gets its copy (0600 in a 0700 dir); a host that is
 * away gets a rotate when it connects again; a revoke and a delete reach every
 * host; a host's own secret the Mac never sent is left alone; no response, op
 * result or log line carries a value; a session may list but never change.
 *
 * Real: the server, the master store, the fleet file, the routes and the op
 * executor, and the host side (secrets-core.ts on a temp dir). Fake: only the
 * transport to the host, which runs the host store in-process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-fleet-secrets-e2e'))

import { WALNUT_HOME, LOG_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import * as daemonConnections from '../../src/providers/daemon-connection.js'
import { createSecretStore } from '../../src/providers/secrets-core.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { resetFleetSecretsForTest, secretsPromptLine, setFleetSecretsActiveForTest } from '../../src/core/secrets/fleet-secrets.js'
import { resetLinkTargetsForTest } from '../../src/core/hosts/link.js'
import { log } from '../../src/logging/index.js'
import { flushLogBufferNow } from '../../src/logging/logger.js'

let server: HttpServer
let port: number
let root: string
let hostDir: string
const SID = 'fleet-secrets-e2e-session'
let online = true
const listeners: Array<(host: string) => void> = []
const connected = (host: string) => { for (const l of listeners) l(host) }
const VALUE = `v1-${randomBytes(18).toString('hex')}`
const ROTATED = `v2-${randomBytes(18).toString('hex')}`

async function api(method: string, p: string, body?: unknown, sid?: string): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, text }
}

const secret = async (name: string) => ((await api('GET', '/api/v1/secrets')).body.secrets as any[]).find((s) => s.name === name)
const onHost = (name: string) => { try { return fs.readFileSync(path.join(hostDir, name), 'utf8') } catch { return null } }

async function until(fn: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeAll(async () => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fleet-secrets-e2e-')))
  process.env.WALNUT_SECRETS_MASTER_DIR = path.join(root, 'master')
  hostDir = path.join(root, 'devbox-secrets')
  setFleetSecretsActiveForTest(true)
  resetFleetSecretsForTest()
  // The host's daemon, in-process: the real host store on a temp dir.
  const hostStore = createSecretStore(hostDir)
  const devbox = {
    connected: true, hostKey: 'devbox', connect: async () => {},
    hasCapability: (c: string) => c === 'secrets-v1',
    send: async (cmd: string, params: Record<string, unknown> = {}) => {
      if (!online) throw new Error('not connected')
      try {
        const op = cmd.slice('secrets.'.length) as 'list' | 'put' | 'remove'
        return { ok: true, ...(hostStore[op] as (p: unknown) => Record<string, unknown>)(params) }
      } catch (err) {
        return { ok: false, error: `${cmd} failed: ${(err as Error).message}`, code: (err as { code?: string }).code }
      }
    },
  }
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) => {
    if (key !== 'devbox') return real(key, target)
    if (!online) throw new Error('devbox is away')
    return devbox as unknown as daemonConnections.DaemonConnection
  })
  const add = daemonConnections.addOnDaemonHostConnected
  vi.spyOn(daemonConnections, 'addOnDaemonHostConnected').mockImplementation((cb) => { listeners.push(cb); return add(cb) })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { devbox: { hostname: 'devbox.example' } } })
  resetLinkTargetsForTest()
  const t = await api('POST', '/api/v1/tasks', { title: 'CI health' })
  await createSessionRecord(SID, t.body.task?.id ?? t.body.id, '', '/home/me/repo', { host: 'devbox', title: 'ci', initialProcessStatus: 'stopped' } as never)
  await until(() => listeners.length > 0, 'the boot job to listen for hosts')
}, 120_000)

afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
  setFleetSecretsActiveForTest(null)
  resetFleetSecretsForTest()
  delete process.env.WALNUT_SECRETS_MASTER_DIR
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  if (root.includes('walnut-fleet-secrets-e2e-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('fleet secrets', () => {
  it('copies a secret to the hosts the user picks, owner-only, and never shows its value', async () => {
    const put = await api('PUT', '/api/v1/secrets/github-read', { value: VALUE, hosts: ['devbox'], env: 'GH_TOKEN', sessions: true, description: 'GitHub, read only' })
    expect(put.status).toBe(200)
    expect(put.text).not.toContain(VALUE)
    expect(put.body.secret).toMatchObject({ name: 'github-read', hosts: ['devbox'], env: 'GH_TOKEN', sessions: true, version: 1, copies: { devbox: { version: 1 } } })
    expect(onHost('github-read')).toBe(VALUE)
    expect(fs.statSync(hostDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(hostDir, 'github-read')).mode & 0o777).toBe(0o600)
    const master = process.env.WALNUT_SECRETS_MASTER_DIR!
    expect(fs.statSync(master).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(master, '.fleet.json'), 'utf8')).not.toContain(VALUE)

    // A session lists names and states, never a value, and may not change anything.
    const listed = await api('GET', '/api/v1/secrets?host=devbox', undefined, SID)
    expect(listed.status).toBe(200)
    expect(listed.text).not.toContain(VALUE)
    expect(listed.body.secrets.map((s: any) => s.name)).toEqual(['github-read'])
    expect((await api('GET', '/api/v1/secrets?host=otherbox')).body.secrets).toEqual([])
    expect(await api('PUT', '/api/v1/secrets/github-read', { value: 'x' }, SID)).toMatchObject({ status: 403, body: { code: 'human_only' } })
    expect(await api('DELETE', '/api/v1/secrets/github-read', undefined, SID)).toMatchObject({ status: 403, body: { code: 'human_only' } })
    const viaOp = await executeOp('secret_list', {}, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID })
    expect(JSON.stringify(viaOp)).not.toContain(VALUE)
    expect(String((viaOp as any).result.outcome)).toContain('github-read: devbox (sessions get $GH_TOKEN)')

    // The prompt of a session on that host names it and how to use it.
    expect(await secretsPromptLine('devbox')).toContain('github-read (already in your environment as $GH_TOKEN): GitHub, read only')
    expect(await secretsPromptLine('__local__')).toBe('')

    // Bad input is refused without echoing it.
    const bad = await api('PUT', '/api/v1/secrets/Bad Name', { value: VALUE })
    expect(bad.status).toBe(400)
    expect(bad.text).not.toContain(VALUE)
    expect((await api('PUT', '/api/v1/secrets/x1', { value: VALUE, hosts: ['nosuch'] })).body.code).toBe('unknown_host')
    expect((await api('PUT', '/api/v1/secrets/x2', { value: VALUE, env: 'PATH', sessions: true })).body.code).toBe('bad_env')
    // Add never rotates by accident; names that are object internals are only misses.
    expect(await api('PUT', '/api/v1/secrets/github-read', { value: 'other', create: true })).toMatchObject({ status: 409, body: { code: 'exists' } })
    expect(onHost('github-read')).toBe(VALUE)
    for (const name of ['__proto__', 'constructor']) {
      expect((await api('DELETE', `/api/v1/secrets/${name}`)).status).toBe(404)
    }
    expect(({} as Record<string, unknown>).hosts).toBeUndefined()
    expect((await api('GET', '/api/v1/secrets')).body.secrets.map((s: any) => s.name)).toEqual(['github-read'])
  }, 60_000)

  it('a rotate while the host is away reaches it when it connects again', async () => {
    online = false
    const put = await api('PUT', '/api/v1/secrets/github-read', { value: ROTATED })
    expect(put.status).toBe(200)
    expect(put.body.secret).toMatchObject({ version: 2, copies: { devbox: { version: 1, error: expect.any(String) } } })
    expect(onHost('github-read')).toBe(VALUE)
    online = true
    connected('devbox')
    await until(async () => (await secret('github-read'))?.copies.devbox.version === 2, 'the copy on reconnect')
    expect(onHost('github-read')).toBe(ROTATED)
    expect((await secret('github-read')).copies.devbox.error).toBeUndefined()
  }, 30_000)

  it('a host\'s own secret the Mac never sent is left alone; a revoke removes only what the Mac sent', async () => {
    createSecretStore(hostDir).put({ name: 'someone-elses', version: 1, value: 'theirs' })
    expect((await api('PUT', '/api/v1/secrets/github-read', { hosts: [] })).body.secret).toMatchObject({ hosts: [], copies: { devbox: { version: null } } })
    expect(onHost('github-read')).toBeNull()
    expect(onHost('someone-elses')).toBe('theirs')
    // Shared again: the same version goes back.
    expect((await api('PUT', '/api/v1/secrets/github-read', { hosts: ['devbox'] })).body.secret.copies.devbox.version).toBe(2)
    expect(onHost('github-read')).toBe(ROTATED)
  }, 30_000)

  it('a delete while the host is away stays pending until it connects, then the secret is gone everywhere', async () => {
    online = false
    const del = await api('DELETE', '/api/v1/secrets/github-read')
    expect(del.body).toMatchObject({ name: 'github-read', pending: ['devbox'] })
    expect(await secret('github-read')).toMatchObject({ hosts: [] })
    online = true
    connected('devbox')
    await until(async () => (await secret('github-read')) === undefined, 'the delete to finish')
    expect(onHost('github-read')).toBeNull()
    expect(fs.existsSync(path.join(process.env.WALNUT_SECRETS_MASTER_DIR!, 'github-read'))).toBe(false)
  }, 30_000)

  it('a damaged list of secrets refuses changes instead of forgetting them', async () => {
    const file = path.join(process.env.WALNUT_SECRETS_MASTER_DIR!, '.fleet.json')
    const good = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, '{ not json')
    try {
      expect(await api('PUT', '/api/v1/secrets/another', { value: VALUE })).toMatchObject({ status: 500, body: { code: 'fleet_unreadable' } })
      expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')
    } finally {
      fs.writeFileSync(file, good)
    }
  })

  it('no value ever reached a log', async () => {
    // The logger buffers for 2 s: write a marker line and flush, so the files read below are the
    // ones this run's server writes and hold everything it logged (2026-10-31: on CI the dir was
    // still empty when read, and the check proved nothing).
    const marker = `fleet-secrets-e2e-${randomBytes(6).toString('hex')}`
    log.session.info('fleet secrets e2e: log marker', { marker })
    await flushLogBufferNow(5_000)
    const logs = fs.readdirSync(LOG_DIR).map((f) => path.join(LOG_DIR, f)).filter((f) => fs.statSync(f).isFile())
    expect(logs.some((f) => fs.readFileSync(f, 'utf8').includes(marker)), `no log file in ${LOG_DIR} holds this run's lines`).toBe(true)
    for (const f of logs) {
      const text = fs.readFileSync(f, 'utf8')
      expect(text).not.toContain(VALUE)
      expect(text).not.toContain(ROTATED)
    }
  })

  it('a throwaway server keeps no secrets', async () => {
    setFleetSecretsActiveForTest(false)
    try {
      expect((await api('GET', '/api/v1/secrets')).body).toEqual({ active: false, secrets: [] })
      expect(await api('PUT', '/api/v1/secrets/github-read', { value: VALUE })).toMatchObject({ status: 409, body: { code: 'isolated_server' } })
    } finally {
      setFleetSecretsActiveForTest(true)
    }
  })
})
