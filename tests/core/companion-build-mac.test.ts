/**
 * The Mac's companion build driver (src/core/companion-build/mac.ts) against a
 * fake box: a real HTTP server on loopback that keeps the /bridge/build door's
 * state in memory (wire.ts). The endpoint, this Mac's build id and its package
 * are stubbed; the requests, the chunking, the polling and the record of what
 * was given up are real. Also the /api/cloud/companion-build routes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

const h = vi.hoisted(() => ({
  endpoint: null as { url: string; token: string } | null,
  autoUpdate: true as boolean | undefined,
  mine: '0.6.14-5408d5875',
  mineWhy: 'This server runs from source, not from a build, so it has no build to send to a host.',
  pkgThrows: null as string | null,
  builds: 0,
  tgz: Buffer.alloc(0),
  recovered: [] as string[],
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-companion-build-mac'))
vi.mock('../../src/core/cloud-ingest.js', () => ({
  cloudSessionEndpoint: async () => h.endpoint,
  recoverCloudSessionCredential: async (token: string) => { h.recovered.push(token) },
}))
vi.mock('../../src/core/companion-build/package.js', async (importOriginal) => ({
  boxRunsPackage: (await importOriginal<typeof import('../../src/core/companion-build/package.js')>()).boxRunsPackage,
  companionBuildId: async () => {
    if (!h.mine) throw new Error(h.mineWhy)
    return h.mine
  },
  buildCompanionPackage: async () => {
    h.builds++
    if (h.pkgThrows) throw new Error(h.pkgThrows)
    return {
      id: h.mine, version: '0.6.14', commit: '5408d5875', dependencies: {}, optionalDependencies: {},
      companionDepsHash: 'bbbbbbbbbbbbbbbb', appPackageJson: '{"name":"open-walnut"}', tgz: h.tgz, fileSha256: 'c'.repeat(64),
    }
  },
}))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({ cloud_bridge: h.autoUpdate === undefined ? {} : { auto_update: h.autoUpdate } }),
  updateConfig: async (partial: { cloud_bridge?: { auto_update?: boolean } }) => { h.autoUpdate = partial.cloud_bridge?.auto_update },
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { installRequestProblem, type BoxBuildStatus } from '../../src/core/companion-build/wire.js'
import {
  _companionBuildChangesForTesting, _resetCompanionBuildForTesting, companionAutoUpdateChanged, companionBuildView, retryCompanionBuild, tickCompanionBuild,
} from '../../src/core/companion-build/mac.js'
import { companionBuildRouter } from '../../src/web/routes/companion-build.js'

const TOKEN = 'machine-token'
const OLD = '0.6.13-1111111'

/** The box, reduced to its build door. */
interface Box {
  mode: 'normal' | 'not_found' | 'unauthorized'
  accepts: boolean
  refusal?: BoxBuildStatus['refusal']
  running: BoxBuildStatus['running']
  current: string | null
  failed: BoxBuildStatus['failed']
  upload: { id: string; size: number; sha: string; data: Buffer[]; received: number; complete: boolean } | null
  /** GET leaves the upload out (a box that lost track of it in its status). */
  hideUpload: boolean
  install: BoxBuildStatus['install']
  activate: BoxBuildStatus['activate']
  installPolls: number
  installFails: string | null
  /** Builds installed here (an install of one answers ready at once, like the box). */
  ready: Set<string>
  activatePolls: number
  activateFails: string | null
  /** Answer every PUT with an offset_mismatch naming this offset. */
  alwaysMismatchAt: number | null
  /** Destroy the socket of the PUT with this index (0-based), and of the `dropRun - 1` PUTs after it. */
  dropPut: number | null
  dropRun: number
  gets: number
  puts: Array<{ offset: number; bytes: number }>
  installs: Array<Record<string, unknown>>
  activates: number
  /** The runtime the box reports (process.version on the box). */
  node: string
}

let box: Box
let server: http.Server
let port = 0

function freshBox(): Box {
  return {
    mode: 'normal', accepts: true,
    running: { id: OLD, version: '0.6.13', commit: '1111111', base: true, trial: false },
    current: null, failed: [], upload: null, hideUpload: false, install: null, activate: null,
    installPolls: 2, installFails: null, ready: new Set(), activatePolls: 2, activateFails: null,
    alwaysMismatchAt: null, dropPut: null, dropRun: 1,
    gets: 0, puts: [], installs: [], activates: 0, node: 'v24.3.0',
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  // Every answer closes its connection, so a dropped socket is one attempt of the
  // Mac's: bun's fetch sends a request once more on its own when a connection it
  // reused drops, which would spend the drops a test counts on.
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify(body))
}

/** Each status read moves the box's background work on by one step. */
function advance(): void {
  if (box.install?.state === 'running' && --box.installPolls <= 0) {
    box.install = box.installFails
      ? { id: box.install.id, state: 'failed', message: box.installFails, logTail: 'npm ERR! gyp failed' }
      : { id: box.install.id, state: 'ready' }
    if (box.install.state === 'ready') box.ready.add(box.install.id)
  }
  if (box.activate?.state === 'smoking' && --box.activatePolls <= 0) {
    const id = box.activate.id
    if (box.activateFails) {
      box.failed.unshift({ id, at: Date.now(), why: box.activateFails })
      box.activate = { id, state: 'failed', message: box.activateFails, at: Date.now() }
    } else {
      box.running = { id, version: '0.6.14', commit: '5408d5875', base: false, trial: false }
      box.current = id
      box.activate = null
    }
  }
}

function status(): BoxBuildStatus {
  const u = box.upload
  return {
    ok: true, schema: 1, accepts: box.accepts, ...(box.refusal ? { refusal: box.refusal } : {}),
    running: box.running, current: box.current, trial: null, failed: box.failed,
    upload: u && !box.hideUpload ? { id: u.id, received: u.received, size: u.size, complete: u.complete } : null,
    install: box.install, activate: box.activate,
    platform: 'linux', arch: 'arm64', node: box.node, freeBytes: 10 * 1024 ** 3,
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://box')
  if (box.mode === 'not_found') return json(res, 404, { error: 'not_found' })
  if (box.mode === 'unauthorized' || req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' })
  if (req.method === 'GET' && url.pathname === '/bridge/build') {
    box.gets++
    advance()
    return json(res, 200, status())
  }
  if (req.method === 'PUT' && url.pathname === '/bridge/build/package') {
    const body = await readBody(req)
    const index = box.puts.length
    const offset = Number(url.searchParams.get('offset'))
    const size = Number(url.searchParams.get('size'))
    const id = String(url.searchParams.get('id'))
    const sha = String(url.searchParams.get('sha256'))
    box.puts.push({ offset, bytes: body.length })
    if (box.dropPut !== null && index >= box.dropPut && index < box.dropPut + box.dropRun) { req.socket.destroy(); return }
    if (box.alwaysMismatchAt !== null) return json(res, 409, { ok: false, error: 'offset_mismatch', received: box.alwaysMismatchAt, size, complete: false })
    if (!box.upload || box.upload.id !== id || box.upload.size !== size) box.upload = { id, size, sha, data: [], received: 0, complete: false }
    const u = box.upload
    if (offset !== u.received) return json(res, 409, { ok: false, error: 'offset_mismatch', received: u.received, size, complete: false })
    u.data.push(body)
    u.received += body.length
    if (u.received === size) {
      const got = crypto.createHash('sha256').update(Buffer.concat(u.data)).digest('hex')
      if (got !== sha) { box.upload = null; return json(res, 422, { ok: false, error: 'sha_mismatch', received: 0, size, complete: false }) }
      u.complete = true
    }
    return json(res, 200, { ok: true, received: u.received, size, complete: u.complete })
  }
  if (req.method === 'POST' && url.pathname === '/bridge/build/install') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>
    box.installs.push(body)
    const problem = installRequestProblem(body)
    if (problem) return json(res, 400, { ok: false, error: 'bad_request', message: problem })
    if (box.ready.has(String(body.id))) return json(res, 200, { ok: true, state: 'ready' })
    if (!box.upload?.complete || box.upload.id !== body.id) return json(res, 409, { ok: false, error: 'no_package' })
    box.install = { id: String(body.id), state: 'running' }
    return json(res, 200, { ok: true, state: 'running' })
  }
  if (req.method === 'POST' && url.pathname === '/bridge/build/activate') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as { id: string }
    box.activates++
    if (!box.ready.has(body.id)) return json(res, 409, { ok: false, error: 'not_installed' })
    box.activate = { id: body.id, state: 'smoking', at: Date.now() }
    return json(res, 200, { ok: true, state: 'smoking' })
  }
  json(res, 404, { error: 'not_found' })
}

const gaveUpFile = () => path.join(WALNUT_HOME, 'cache', 'companion-build.json')
const gaveUp = (): Record<string, { why: string }> => {
  try { return (JSON.parse(fs.readFileSync(gaveUpFile(), 'utf8')) as { gaveUp: Record<string, { why: string }> }).gaveUp } catch { return {} }
}

beforeAll(async () => {
  server = http.createServer((req, res) => { void handle(req, res).catch((err) => json(res, 500, { error: String(err) })) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  process.env.WALNUT_COMPANION_AUTO_TICKS = '1'
  process.env.WALNUT_COMPANION_BUILD_BOOT_DELAY_MS = '0'
  process.env.WALNUT_COMPANION_BUILD_POLL_MS = '5'
  process.env.WALNUT_COMPANION_BUILD_CHUNK_BYTES = '4096'
  process.env.WALNUT_COMPANION_BUILD_RETRY_SCALE = '0.001'
  box = freshBox()
  h.endpoint = { url: `http://127.0.0.1:${port}/bridge`, token: TOKEN }
  h.autoUpdate = undefined
  h.mine = '0.6.14-5408d5875'
  h.pkgThrows = null
  h.builds = 0
  h.tgz = crypto.randomBytes(10_000)
  h.recovered = []
  await _resetCompanionBuildForTesting()
  fs.rmSync(gaveUpFile(), { force: true })
})

afterEach(() => {
  for (const k of ['WALNUT_COMPANION_AUTO_TICKS', 'WALNUT_COMPANION_BUILD_BOOT_DELAY_MS', 'WALNUT_COMPANION_BUILD_POLL_MS', 'WALNUT_COMPANION_BUILD_CHUNK_BYTES', 'WALNUT_COMPANION_BUILD_RETRY_SCALE']) delete process.env[k]
})

describe('tickCompanionBuild', () => {
  it('does nothing when the companion runs this build', async () => {
    box.running = { id: h.mine, version: '0.6.14', commit: '5408d5875', base: false, trial: false }
    box.current = h.mine
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'current', mine: h.mine, theirs: h.mine, autoUpdate: true })
    expect(box.puts).toEqual([])
    expect(h.builds).toBe(0)
  })

  it('sends nothing to a box that does not take builds', async () => {
    box.accepts = false
    box.refusal = 'turned_off_on_box'
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'box_off', message: 'turned_off_on_box', theirs: OLD })
    expect(box.puts).toEqual([])
    expect(h.builds).toBe(0)
  })

  it('sends nothing to a box whose runtime cannot start the package, and goes on once the box is set up again', async () => {
    box.node = 'v14.21.3'
    await tickCompanionBuild('probe')
    const view = companionBuildView()
    expect(view).toMatchObject({ state: 'failed', theirs: OLD })
    expect(view.message).toMatch(/runs Node v14\.21\.3, and the build this Mac sends starts with Node 16 or newer, or bun/)
    expect(box.puts).toEqual([])
    expect(h.builds).toBe(0)
    // Not remembered as given up: the box moved to bun, and the next round sends the build.
    box.node = 'v24.3.0'
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'current', mine: h.mine })
    expect(h.builds).toBe(1)
  })

  it('uploads in order, installs, activates, and ends on the new build', async () => {
    await tickCompanionBuild('probe')
    expect(box.puts.map((p) => p.offset)).toEqual([0, 4096, 8192])
    expect(box.puts.map((p) => p.bytes)).toEqual([4096, 4096, 10_000 - 8192])
    expect(Buffer.concat(box.upload!.data).equals(h.tgz)).toBe(true)
    // The walnut file needs nothing installed beside it: one empty dependency set for every build.
    expect(box.installs).toEqual([{
      id: h.mine, depsHash: 'bbbbbbbbbbbbbbbb', dependencies: {},
      optionalDependencies: {}, appPackageJson: '{"name":"open-walnut"}',
    }])
    expect(box.activates).toBe(1)
    expect(companionBuildView()).toMatchObject({ state: 'current', mine: h.mine, theirs: h.mine })
  })

  it('after the update, the copy kinds the older build refused go again now, not after their rest', async () => {
    const status = await import('../../src/core/replication/replica-status.js')
    const companion = { id: 'companion', kind: 'companion' as const, label: 'Cloud companion' }
    const rest = () => Object.assign(status.kindState(companion, 'routines'), { restUntil: Date.now() + 600_000, restWhy: 'unknown_kind', manifest: { hash: 'x' } })
    rest()
    await tickCompanionBuild('probe')
    // This tick updated it from OLD: the rest it had then ended (async, after the tick).
    // Every reset this tick started has landed (the build seen first, then the new
    // one): waiting for the first 0 alone let the second land on the rest set below.
    await _companionBuildChangesForTesting()
    expect(status.peekKindState('companion', 'routines')?.restUntil).toBe(0)
    // The older companion answered unknown_kind: a 10-minute rest, kept while it runs the same build.
    rest()
    await tickCompanionBuild('probe')
    await _companionBuildChangesForTesting()
    expect(status.peekKindState('companion', 'routines')?.restUntil).toBeGreaterThan(Date.now())
    // It changes build (here it went back to the base, and this tick updates it again):
    // the rest ends and the manifest goes again.
    box.running = { id: OLD, version: '0.6.13', commit: '1111111', base: true, trial: false }
    box.current = null
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'current', theirs: h.mine })
    await vi.waitFor(() => expect(status.peekKindState('companion', 'routines')).toMatchObject({ restUntil: 0, manifest: null }))
  })

  it('resumes an upload from what the box already has', async () => {
    box.upload = { id: h.mine, size: h.tgz.length, sha: '', data: [h.tgz.subarray(0, 4096)], received: 4096, complete: false }
    await tickCompanionBuild('probe')
    expect(box.puts.map((p) => p.offset)).toEqual([4096, 8192])
    expect(box.puts.reduce((n, p) => n + p.bytes, 0)).toBe(h.tgz.length - 4096)
    expect(companionBuildView().state).toBe('current')
  })

  it('goes on from the offset an offset_mismatch reply names', async () => {
    box.upload = { id: h.mine, size: h.tgz.length, sha: '', data: [h.tgz.subarray(0, 4096)], received: 4096, complete: false }
    box.hideUpload = true
    await tickCompanionBuild('probe')
    expect(box.puts.map((p) => p.offset)).toEqual([0, 4096, 8192])
    expect(Buffer.concat(box.upload!.data).equals(h.tgz)).toBe(true)
    expect(companionBuildView().state).toBe('current')
  })

  it('stops after three mismatches and leaves the update for the next tick', async () => {
    box.alwaysMismatchAt = 1234
    await tickCompanionBuild('probe')
    expect(box.puts.length).toBe(4)
    expect(companionBuildView()).toMatchObject({ state: 'updating', step: 'uploading' })
    expect(gaveUp()).toEqual({})
  })

  it('a chunk whose connection drops is sent again at once', async () => {
    box.dropPut = 1
    await tickCompanionBuild('probe')
    expect(box.puts.map((p) => p.offset)).toEqual([0, 4096, 4096, 8192])
    expect(companionBuildView().state).toBe('current')
  })

  it('a chunk that keeps failing pauses the upload, and the next tick resumes from the box', async () => {
    // The first send and its three retries all drop.
    box.dropPut = 1
    box.dropRun = 4
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'updating', step: 'uploading' })
    expect(box.puts.map((p) => p.offset)).toEqual([0, 4096, 4096, 4096, 4096])
    box.dropPut = null
    await tickCompanionBuild('probe')
    expect(box.puts.map((p) => p.offset)).toEqual([0, 4096, 4096, 4096, 4096, 4096, 8192])
    expect(companionBuildView().state).toBe('current')
  })

  it('an install the box already has answers ready, and goes straight to activate', async () => {
    box.ready.add(h.mine)
    box.install = { id: 'another-build', state: 'ready' }
    await tickCompanionBuild('probe')
    expect(box.installs.length).toBe(1)
    expect(box.install).toEqual({ id: 'another-build', state: 'ready' })
    expect(box.activates).toBe(1)
    expect(companionBuildView().state).toBe('current')
  })

  it('a Retry of a build the box gave up activates it again, and only a new failure counts', async () => {
    box.ready.add(h.mine)
    box.failed = [{ id: h.mine, at: 1000, why: 'it did not start twice' }]
    box.activate = { id: h.mine, state: 'failed', message: 'it did not start twice', at: 1000 }
    await tickCompanionBuild('probe')
    expect(companionBuildView().state).toBe('failed')
    await retryCompanionBuild()
    await tickCompanionBuild('retry')
    expect(box.activates).toBe(1)
    expect(companionBuildView().state).toBe('current')
  })

  it('never retries a build the box gave up', async () => {
    box.failed = [{ id: h.mine, at: 1000, why: 'it did not start twice' }]
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'failed', message: 'it did not start twice', theirs: OLD })
    expect(box.puts).toEqual([])
    expect(h.builds).toBe(0)
  })

  it('remembers a package it could not build, and a Retry tries again', async () => {
    h.pkgThrows = "this Mac's build has no session daemon for linux-arm64; run scripts/build-daemon.sh and build again"
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'failed', message: h.pkgThrows })
    expect(gaveUp()[h.mine]?.why).toBe(h.pkgThrows)
    await tickCompanionBuild('probe')
    expect(h.builds).toBe(1)
    expect(companionBuildView().state).toBe('failed')
    h.pkgThrows = null
    await retryCompanionBuild()
    expect(gaveUp()[h.mine]).toBeUndefined()
    await tickCompanionBuild('retry')
    expect(h.builds).toBe(2)
    expect(companionBuildView().state).toBe('current')
  })

  it('a failed install is failed with the box message and log, and remembered', async () => {
    box.installFails = 'npm install failed'
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'failed', message: 'npm install failed', logTail: 'npm ERR! gyp failed' })
    expect(gaveUp()[h.mine]?.why).toBe('npm install failed')
    expect(box.activates).toBe(0)
  })

  it('a build that does not start is failed, and the old one keeps running', async () => {
    box.activateFails = 'no answer on /api/config within 150 s'
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'failed', message: 'no answer on /api/config within 150 s', theirs: OLD })
    expect(gaveUp()[h.mine]).toBeDefined()
  })

  it('is off when auto_update is false, and asks the box nothing', async () => {
    h.autoUpdate = false
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'off', autoUpdate: false })
    expect(box.gets).toBe(0)
  })

  it('is off, saying why, when this Mac has no walnut file of its build to send', async () => {
    h.mine = ''
    await tickCompanionBuild('probe')
    expect(companionBuildView()).toMatchObject({ state: 'off', mine: null, message: h.mineWhy })
    expect(box.puts).toEqual([])
    expect(h.builds).toBe(0)
  })

  it('is no_companion without an endpoint', async () => {
    h.endpoint = null
    await tickCompanionBuild('probe')
    expect(companionBuildView().state).toBe('no_companion')
  })

  it('an older companion (404) is unmanaged and rests ten minutes, then looks again', async () => {
    box.mode = 'not_found'
    await tickCompanionBuild('probe')
    expect(companionBuildView().state).toBe('unmanaged')
    // The user updates the box by hand; the next probe inside the rest does not look.
    box.mode = 'normal'
    box.running = { id: h.mine, version: '0.6.14', commit: '5408d5875', base: true, trial: false }
    await tickCompanionBuild('probe')
    expect(box.gets).toBe(0)
    expect(companionBuildView().state).toBe('unmanaged')
    // Ten minutes on, a probe looks again and finds the box on this build.
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000 + 1)
    try {
      await tickCompanionBuild('probe')
    } finally {
      clock.mockRestore()
    }
    expect(box.gets).toBe(1)
    expect(companionBuildView().state).toBe('current')
  })

  it('a refused credential (401) asks for a new one once and rests', async () => {
    box.mode = 'unauthorized'
    await tickCompanionBuild('probe')
    expect(companionBuildView().state).toBe('refused_credential')
    expect(h.recovered).toEqual([TOKEN])
    await tickCompanionBuild('probe')
    expect(h.recovered).toEqual([TOKEN])
  })

  it('runs one flow at a time', async () => {
    box.running = { id: h.mine, version: '0.6.14', commit: '5408d5875', base: false, trial: false }
    const a = tickCompanionBuild('probe')
    const b = tickCompanionBuild('boot')
    expect(b).toBe(a)
    await Promise.all([a, b])
    expect(box.gets).toBe(1)
  })

  it('waits until the process is old enough before an automatic look', async () => {
    box.running = { id: h.mine, version: '0.6.14', commit: '5408d5875', base: false, trial: false }
    process.env.WALNUT_COMPANION_BUILD_BOOT_DELAY_MS = String(Math.ceil(process.uptime() * 1000) + 300)
    const t = tickCompanionBuild('boot')
    await new Promise((r) => setTimeout(r, 50))
    expect(box.gets).toBe(0)
    await t
    expect(box.gets).toBe(1)
  })

  it('turning updates off stops a flow in progress', async () => {
    box.installPolls = 1_000_000
    const run = tickCompanionBuild('probe')
    for (let i = 0; i < 400 && box.installs.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(box.installs.length).toBe(1)
    expect(companionAutoUpdateChanged(false).state).toBe('off')
    await run
    expect(companionBuildView().state).toBe('off')
    expect(box.activates).toBe(0)
  })
})

describe('/api/cloud/companion-build', () => {
  let app: http.Server
  let base = ''
  beforeAll(async () => {
    const e = express()
    e.use(express.json())
    e.use('/api/cloud/companion-build', companionBuildRouter)
    app = http.createServer(e)
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/cloud/companion-build`
  })
  afterAll(async () => { await new Promise<void>((resolve) => app.close(() => resolve())) })

  it('GET answers the view', async () => {
    h.autoUpdate = false
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: 'off', autoUpdate: false })
  })

  it('PUT writes auto_update for the person at this machine only', async () => {
    const refused = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': 'a-session' }, body: JSON.stringify({ auto_update: false }) })
    expect(refused.status).toBe(403)
    expect(h.autoUpdate).toBeUndefined()
    const bad = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_update: 'no' }) })
    expect(bad.status).toBe(400)
    const off = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_update: false }) })
    expect(off.status).toBe(200)
    expect(h.autoUpdate).toBe(false)
    expect(await off.json()).toMatchObject({ state: 'off', autoUpdate: false })
  })

  // Retry changes no setting, so a session on this machine may press it as the person may
  // (2026-10-27); a caller on another host is not at this machine.
  it('POST /retry is for callers on this machine, the person or a session', async () => {
    const refused = await fetch(`${base}/retry`, { method: 'POST', headers: { 'x-walnut-caller-sid': 'a-session', 'x-walnut-origin': 'host:devbox' } })
    expect(refused.status).toBe(403)
    box.running = { id: h.mine, version: '0.6.14', commit: '5408d5875', base: false, trial: false }
    const bySession = await fetch(`${base}/retry`, { method: 'POST', headers: { 'x-walnut-caller-sid': 'a-session' } })
    expect(bySession.status).toBe(200)
    await tickCompanionBuild('retry')
    expect(companionBuildView().state).toBe('current')
    const ok = await fetch(`${base}/retry`, { method: 'POST' })
    expect(ok.status).toBe(200)
    await tickCompanionBuild('retry')
    expect(companionBuildView().state).toBe('current')
  })
})

describe('requestError', () => {
  it('names the cause fetch hides behind "fetch failed"', async () => {
    const { requestError } = await import('../../src/core/companion-build/mac-door.js')
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
    expect(requestError(err)).toBe('fetch failed (UND_ERR_SOCKET)')
    expect(requestError(new Error('plain'))).toBe('plain')
    expect(requestError('text')).toBe('text')
  })
})
