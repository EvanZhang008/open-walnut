/**
 * The /bridge/build door (src/web/routes/bridge-build.ts) on a real Express app
 * on a real port, with the real box steps (src/core/companion-build/box.ts) in a
 * temp root.
 *
 * Pinned: only the primary's machine credential gets in (none or a wrong token
 * 401, a phone's or another machine's 403), and the answer comes before the body
 * is read; each box answer has its status (400, 403, 409, 413, 422, 507, 202 for
 * a step that started); an error inside a step is a plain 500 with no stack.
 *
 * auth.json is written fresh (tokens known to the test); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-build', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { createBridgeBuildRouter } from '../../../src/web/routes/bridge-build.js'
import { _setBoxHooksForTesting, runningBuild } from '../../../src/core/companion-build/box.js'
import { BRIDGE_BUILD_PATH, MAX_CHUNK_BYTES } from '../../../src/core/companion-build/wire.js'

const ENV_KEYS = ['WALNUT_COMPANION_ROOT', 'WALNUT_COMPANION_LAUNCHER', 'WALNUT_COMPANION_MAC_BUILDS', 'WALNUT_COMPANION_BUILD', 'WALNUT_COMPANION_TRIAL']
let saved: Record<string, string | undefined> = {}
let server: HttpServer
let port = 0
let R = ''
let free: number | null = 100 * 1024 ** 3
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), devbox: tok(), phone: tok() }

async function call(method: string, p: string, opts: { bearer?: string | null; body?: Buffer | string; json?: unknown } = {}) {
  const headers: Record<string, string> = {}
  const bearer = opts.bearer === undefined ? T.local : opts.bearer
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  let body: Buffer | string | undefined = opts.body
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = typeof opts.json === 'string' ? opts.json : JSON.stringify(opts.json)
  }
  if (Buffer.isBuffer(body)) headers['Content-Type'] = 'application/octet-stream'
  const r = await fetch(`http://127.0.0.1:${port}${BRIDGE_BUILD_PATH}${p}`, { method, headers, body })
  const text = await r.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, body: json, text }
}

const put = (q: { id: string; offset: number; size: number; sha256: string }, bytes: Buffer, bearer?: string | null) =>
  call('PUT', `/package?id=${encodeURIComponent(q.id)}&offset=${q.offset}&size=${q.size}&sha256=${q.sha256}`, { body: bytes, bearer })

/** Raw socket: headers plus 1KB of a 50MB declared body; the status line seen before the body completes. */
async function statusBeforeBody(headers: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no answer before the body in 3s: ${buf.slice(0, 80)}`)) }, 3_000)
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      const nl = buf.indexOf('\r\n')
      if (nl !== -1) { clearTimeout(timer); sock.destroy(); resolve(buf.slice(0, nl)) }
    })
    sock.on('error', () => { /* destroyed after the status line */ })
    const q = `id=b1&offset=0&size=${50 * 1024 * 1024}&sha256=${sha('x')}`
    sock.write([`PUT ${BRIDGE_BUILD_PATH}/package?${q} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Content-Length: ${50 * 1024 * 1024}`, ...headers, '', ''].join('\r\n'))
    sock.write(Buffer.alloc(1024, 0x20))
  })
}

function makePackage(): Buffer {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-route-pkg-'))
  try {
    fs.mkdirSync(path.join(work, 'package', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(work, 'package', 'dist', 'cli.js'), 'console.log("9.9.9")\n')
    execFileSync('tar', ['-czf', path.join(work, 'p.tgz'), '-C', work, 'package'])
    return fs.readFileSync(path.join(work, 'p.tgz'))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

beforeAll(async () => {
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
    { name: 'bridge-devbox', id: 'd00000000000000e5', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  const app = express()
  app.use(BRIDGE_BUILD_PATH, createBridgeBuildRouter())
  server = await new Promise<HttpServer>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-route-'))
  process.env.WALNUT_COMPANION_ROOT = R
  process.env.WALNUT_COMPANION_LAUNCHER = '1'
  process.env.WALNUT_COMPANION_MAC_BUILDS = '1'
  free = 100 * 1024 ** 3
  _setBoxHooksForTesting({ restartSelf: () => {}, freeBytes: async () => free })
})

afterEach(() => {
  _setBoxHooksForTesting({ restartSelf: () => {} })
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(R, { recursive: true, force: true })
})

describe('who may use the door', () => {
  it.each([
    ['no token', null, 401],
    ['a wrong token', 'not-a-token', 401],
    ['a phone device token', T.phone, 403],
    ["another host's machine token", T.devbox, 403],
  ] as const)('%s is refused (%i) and nothing is written', async (_label, bearer, status) => {
    expect((await call('GET', '/', { bearer })).status).toBe(status)
    const bytes = Buffer.from('package')
    expect((await put({ id: 'b1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes, bearer)).status).toBe(status)
    expect((await call('POST', '/install', { bearer, json: {} })).status).toBe(status)
    expect((await call('POST', '/activate', { bearer, json: { id: 'b1' } })).status).toBe(status)
    expect(fs.readdirSync(R)).toEqual([])
  })

  it('the primary machine reads the status', async () => {
    const r = await call('GET', '/')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, schema: 1, accepts: true, running: { id: runningBuild().id }, upload: null })
  })

  it.each([
    ['no token', [], '401'],
    ['a phone token', [`Authorization: Bearer ${T.phone}`], '403'],
  ] as const)('%s is answered while a 50MB body is still unsent', async (_label, headers, code) => {
    const started = Date.now()
    expect(await statusBeforeBody([...headers])).toContain(` ${code} `)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('the steps and their statuses', () => {
  it('uploads in chunks, then refuses out of order, a bad sha256, too large, a full disk', async () => {
    const bytes = crypto.randomBytes(3000)
    const q = { id: 'b1', size: 3000, sha256: sha(bytes) }
    let r = await put({ ...q, offset: 0 }, bytes.subarray(0, 1500))
    expect(r).toMatchObject({ status: 200, body: { ok: true, received: 1500, complete: false } })
    r = await put({ ...q, offset: 2000 }, bytes.subarray(2000))
    expect(r).toMatchObject({ status: 409, body: { ok: false, error: 'offset_mismatch', received: 1500 } })
    r = await put({ ...q, offset: 1500 }, bytes.subarray(1500))
    expect(r).toMatchObject({ status: 200, body: { ok: true, received: 3000, complete: true } })
    expect((await call('GET', '/')).body.upload).toEqual({ id: 'b1', received: 3000, size: 3000, complete: true })

    const other = crypto.randomBytes(100)
    r = await put({ id: 'b2', offset: 0, size: 100, sha256: sha(Buffer.from('not it')) }, other)
    expect(r).toMatchObject({ status: 422, body: { error: 'sha_mismatch' } })
    // One byte over the cap is the box's own answer; more is the parser's, same shape.
    r = await put({ id: 'b2', offset: 0, size: MAX_CHUNK_BYTES * 2, sha256: sha('x') }, Buffer.alloc(MAX_CHUNK_BYTES + 1))
    expect(r).toMatchObject({ status: 413, body: { ok: false, error: 'too_large' } })
    r = await put({ id: 'b2', offset: 0, size: MAX_CHUNK_BYTES * 2, sha256: sha('x') }, Buffer.alloc(MAX_CHUNK_BYTES + 64))
    expect(r).toMatchObject({ status: 413, body: { ok: false, error: 'too_large', received: 0, complete: false } })
    r = await call('PUT', '/package?id=b2&offset=zero&size=10', { body: Buffer.from('x') })
    expect(r).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    free = 1024
    r = await put({ id: 'b3', offset: 0, size: 100, sha256: sha(other) }, other)
    expect(r).toMatchObject({ status: 507, body: { error: 'disk_full' } })
    process.env.WALNUT_COMPANION_MAC_BUILDS = '0'
    r = await put({ id: 'b3', offset: 0, size: 100, sha256: sha(other) }, other)
    expect(r).toMatchObject({ status: 403, body: { error: 'refused' } })
  })

  it('install: 400 for a bad body, 409 without a package, 202 when it starts, 200 once ready', async () => {
    expect(await call('POST', '/install', { json: { id: 'b1' } })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect(await call('POST', '/install', { json: '{"id":' })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    const req = {
      id: 'b1', depsHash: 'abcdef01', dependencies: {}, optionalDependencies: {},
      appPackageJson: JSON.stringify({ name: 'open-walnut', version: '9.9.9', private: true }),
    }
    expect(await call('POST', '/install', { json: req })).toMatchObject({ status: 409, body: { error: 'no_package' } })
    const pkg = makePackage()
    expect((await put({ id: 'b1', offset: 0, size: pkg.length, sha256: sha(pkg) }, pkg)).body).toMatchObject({ complete: true })
    expect(await call('POST', '/install', { json: req })).toMatchObject({ status: 202, body: { ok: true, state: 'running' } })
    const until = Date.now() + 30_000
    let state: unknown = null
    while (Date.now() < until) {
      const install = (await call('GET', '/')).body.install as { state?: string; message?: string } | null
      state = install?.state
      if (state === 'ready' || state === 'failed') break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(state).toBe('ready')
    expect(await call('POST', '/install', { json: req })).toMatchObject({ status: 200, body: { ok: true, state: 'ready' } })
  })

  it('activate: 409 when not installed, 200 for the build that runs, 400 for a bad id', async () => {
    expect(await call('POST', '/activate', { json: { id: 'nope' } })).toMatchObject({ status: 409, body: { error: 'not_installed' } })
    expect(await call('POST', '/activate', { json: { id: runningBuild().id } })).toMatchObject({ status: 200, body: { ok: true, state: 'running' } })
    expect(await call('POST', '/activate', { json: { id: '../x' } })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
  })

  it('an error inside a step is a plain 500, never a stack trace', async () => {
    const file = path.join(R, 'not-a-dir')
    fs.writeFileSync(file, 'x')
    process.env.WALNUT_COMPANION_ROOT = file
    const bytes = Buffer.from('package')
    const r = await put({ id: 'b1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes)
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ ok: false, message: 'the box could not do this step' })
    expect(r.text).not.toMatch(/ENOTDIR|at .*\.ts/)
  })
})
