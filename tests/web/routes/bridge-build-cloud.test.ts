/**
 * /bridge/build on a real CLOUD_MODE server (src/web/server.ts mounts it in the
 * companion's door block): a chunk reaches the box byte for byte (no body parser
 * of the server touches it first), only the primary's machine credential gets
 * in, and a trial build confirms itself once the server has booted.
 *
 * auth.json is written fresh (tokens known to the test); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-build-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _setBoxHooksForTesting } from '../../../src/core/companion-build/box.js'

const ENV = {
  WALNUT_COMPANION_LAUNCHER: '1', WALNUT_COMPANION_MAC_BUILDS: '1', WALNUT_COMPANION_TRIAL: '1',
  WALNUT_COMPANION_BUILD: 'trial-1', WALNUT_COMPANION_CONFIRM_MS: '200',
}
let saved: Record<string, string | undefined> = {}
let server: HttpServer
let port = 0
let R = ''
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }

const put = (bearer: string, q: string, body: Buffer) =>
  fetch(`http://127.0.0.1:${port}/bridge/build/package?${q}`, { method: 'PUT', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body })

beforeAll(async () => {
  saved = Object.fromEntries(['WALNUT_COMPANION_ROOT', ...Object.keys(ENV)].map((k) => [k, process.env[k]]))
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-cloud-'))
  Object.assign(process.env, ENV, { WALNUT_COMPANION_ROOT: R })
  fs.mkdirSync(path.join(R, 'companion'), { recursive: true })
  fs.writeFileSync(path.join(R, 'companion', 'current'), 'old-1\n')
  fs.writeFileSync(path.join(R, 'companion', 'trial'), 'trial-1\n')
  fs.writeFileSync(path.join(R, 'companion', 'attempts'), '1\n')
  _setBoxHooksForTesting({ restartSelf: () => {}, freeBytes: async () => 100 * 1024 ** 3 })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)

afterAll(async () => {
  await stopServer()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(R, { recursive: true, force: true })
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

describe('the build door on the companion server', () => {
  it('a chunk reaches the box byte for byte, even sent as JSON', async () => {
    // A JSON-looking body: the server's own JSON parser must not have taken it.
    const bytes = Buffer.from(JSON.stringify({ looks: 'like json', n: 1 }))
    const q = `id=b1&offset=0&size=${bytes.length}&sha256=${sha(bytes)}`
    expect((await put(T.phone, q, bytes)).status).toBe(403)
    const r = await put(T.local, q, bytes)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, received: bytes.length, size: bytes.length, complete: true })
    expect(fs.readFileSync(path.join(R, 'incoming', 'b1.tgz')).equals(bytes)).toBe(true)
    const st = await fetch(`http://127.0.0.1:${port}/bridge/build`, { headers: { Authorization: `Bearer ${T.local}` } })
    expect(await st.json()).toMatchObject({ ok: true, accepts: true, running: { base: false, trial: true }, upload: { id: 'b1', complete: true } })
  })

  it('a trial build confirms itself after boot: current, previous, trial and attempts gone', async () => {
    const until = Date.now() + 15_000
    while (Date.now() < until && fs.existsSync(path.join(R, 'companion', 'trial'))) await new Promise((r) => setTimeout(r, 50))
    expect(fs.readFileSync(path.join(R, 'companion', 'current'), 'utf8').trim()).toBe('trial-1')
    expect(fs.readFileSync(path.join(R, 'companion', 'previous'), 'utf8').trim()).toBe('old-1')
    expect(fs.existsSync(path.join(R, 'companion', 'attempts'))).toBe(false)
  })
})
