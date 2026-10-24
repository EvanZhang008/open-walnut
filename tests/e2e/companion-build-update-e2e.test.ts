/**
 * The Mac keeps its companion on the Mac's build (docs/plan/walnut-companion-unified-replica.md,
 * stage 1), end to end with real processes: the companion is this tree's BUILD
 * (`dist/cli.js web`, WALNUT_CLOUD_MODE=1) started by the real launcher
 * (scripts/cloud/companion-launch.mjs), restarted by a loop that does what
 * systemd's Restart=always does. The Mac's driver (core/companion-build/mac.ts)
 * runs in this process against it over HTTP with the machine credential, and
 * packs the real companion package (core/companion-build/package.ts: the walnut
 * file plus the dist/cli.js shim); only its endpoint lookup and the walnut file
 * source are stubbed. The "walnut file" of each build is a small sh script that
 * runs this tree's build with that build's own build-info, as the compiled file
 * would (a real compiled file takes minutes to build; tests/e2e/old-box/run.sh
 * runs real ones on a container laid out like a box from before the file).
 *
 *   base A   the box starts on this tree's build, nothing installed
 *   B        a build with another commit: uploaded, installed, smoke booted
 *            through the shim, started as the trial, confirmed, current; a
 *            restart keeps it
 *   C        a build that answers --version but never serves: the smoke boot
 *            fails, the box gives it up and keeps running B, the Mac does not retry it
 *
 * The package's one (empty) dependency set is marked installed by hand: the
 * install script then runs no package manager.
 *
 * Needs the build: `bun run build`, then `cd web && bun x vite build`. Without it
 * the file fails at once and says so (never a skipped test).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = path.join(REPO, 'dist')

const h = vi.hoisted(() => ({
  endpoint: null as { url: string; token: string } | null,
  /** The build this Mac is on: its id, and the walnut file standing in for it. */
  build: null as { id: string; version: string; commit: string; file: string } | null,
  /** Uploads the Mac's driver began: its PUTs of a package's first chunk. */
  uploadsBegun: 0,
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-companion-build-e2e'))
vi.mock('../../src/core/cloud-ingest.js', () => ({
  cloudSessionEndpoint: async () => h.endpoint,
  recoverCloudSessionCredential: async () => {},
}))
vi.mock('../../src/core/host-server/index.js', async () => {
  const crypto = await import('node:crypto')
  const fs = await import('node:fs')
  const zlib = await import('node:zlib')
  return {
    sharedHostFileSource: () => ({
      async buildId() {
        if (!h.build) throw new Error('no build')
        return { id: h.build.id, version: h.build.version, commit: h.build.commit }
      },
      async file(target: string) {
        const b = h.build!
        const body = fs.readFileSync(b.file)
        const gz = zlib.gzipSync(body)
        const sha = (x: Buffer) => crypto.createHash('sha256').update(x).digest('hex')
        return { id: b.id, version: b.version, commit: b.commit, target, gz, sha256: sha(body), gzSha256: sha(gz) }
      },
    }),
  }
})
// Counted in this process, at the call: the box's own log line is buffered for up to
// 2 s (src/logging/logger.ts), so a build that fails fast can be done before it lands.
vi.mock('../../src/core/companion-build/mac-door.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/companion-build/mac-door.js')>()
  return {
    ...real,
    call: (...args: Parameters<typeof real.call>) => {
      if (args[1] === 'PUT' && /^\/package\?.*&offset=0&/.test(args[2])) h.uploadsBegun++
      return real.call(...args)
    },
  }
})
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({ cloud_bridge: { auto_update: true } }),
}))

import { buildIdOf, type BoxBuildStatus } from '../../src/core/companion-build/wire.js'
import { EMPTY_DEPS_HASH } from '../../src/core/companion-build/package.js'
import { _resetCompanionBuildForTesting, companionBuildView, tickCompanionBuild } from '../../src/core/companion-build/mac.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => resolve(a && typeof a === 'object' ? a.port : 0))
    })
  })
}

/**
 * A dist made of links to this tree's dist, with its own build-info (another build
 * id). The entry bundles are copies: the runtime resolves a linked module to its
 * real path, and the bundle reads build-info.json beside where it really is.
 */
async function linkedDist(root: string, info: Record<string, unknown>, cliJs?: string): Promise<{ distDir: string; root: string }> {
  const distDir = path.join(root, 'dist')
  await fsp.mkdir(distDir, { recursive: true })
  for (const name of await fsp.readdir(DIST)) {
    if (name === 'build-info.json' || (cliJs && name === 'cli.js')) continue
    if (name === 'cli.js' || name === 'cli-fast.js') await fsp.copyFile(path.join(DIST, name), path.join(distDir, name))
    else await fsp.symlink(path.join(DIST, name), path.join(distDir, name))
  }
  await fsp.writeFile(path.join(distDir, 'build-info.json'), JSON.stringify(info, null, 2))
  if (cliJs) await fsp.writeFile(path.join(distDir, 'cli.js'), cliJs)
  await fsp.symlink(path.join(REPO, 'package.json'), path.join(root, 'package.json'))
  return { distDir, root }
}

/** The stand-in for a build's compiled walnut file: this runtime running that build's dist. */
async function walnutFileFor(dist: { distDir: string; root: string }): Promise<string> {
  const file = path.join(dist.root, 'walnut')
  await fsp.writeFile(file, [
    '#!/bin/sh',
    // `__selftest` is the compiled file's own command; a dist has none.
    'if [ "$1" = __selftest ]; then echo \'{"ok":true}\'; exit 0; fi',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dist.distDir, 'cli.js'))} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

describe('the Mac keeps its companion on its build (real launcher, real build)', () => {
  let base = ''
  let R = ''
  let port = 0
  const machineToken = crypto.randomBytes(16).toString('hex')
  let launcher: ChildProcess | null = null
  let stopping = false
  let starts = 0
  let log = ''
  let idA = ''
  let buildB: NonNullable<typeof h.build>
  let buildC: NonNullable<typeof h.build>

  const box = { home: '', data: '' }

  function env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      WALNUT_CLOUD_MODE: '1',
      OPEN_WALNUT_HOME: box.data,
      HOME: box.home,
      USERPROFILE: box.home,
      WALNUT_HOME_OVERRIDE: box.home,
      SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: path.join(base, 'daemon'),
      WALNUT_TUNNEL_DAEMON_DIR: path.join(base, 'tunnel'),
      WALNUT_STREAMS_DIR: '',
      WALNUT_GIT_HUB_DIR: path.join(base, 'hub'),
      WALNUT_LOCAL_CLAUDE_PROBE: '0',
      WALNUT_DISABLE_BACKGROUND_AI: '1',
      WALNUT_DISABLE_SEARCH: '1',
      WALNUT_STT_AUTO_SETUP: '0',
      WALNUT_COMPANION_ROOT: R,
      WALNUT_COMPANION_BASE: path.join(base, 'base'),
      WALNUT_COMPANION_MAC_BUILDS: '1',
      WALNUT_COMPANION_CONFIRM_MS: '3000',
      WALNUT_COMPANION_SMOKE_MS: '120000',
      WALNUT_COMPANION_TRIAL_DEADLINE_MS: '240000',
      VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', NODE_ENV: 'production',
    }
  }

  /** systemd's Restart=always: start the launcher again whenever it ends. */
  function startLauncher(): void {
    starts++
    const p = spawn(process.execPath, [path.join(REPO, 'scripts/cloud/companion-launch.mjs'), 'web', '--port', String(port)], {
      cwd: path.join(base, 'base'), env: env(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    const keep = (b: Buffer) => { log = (log + b.toString()).slice(-400_000) }
    p.stdout!.on('data', keep)
    p.stderr!.on('data', keep)
    p.once('exit', () => {
      if (launcher === p) launcher = null
      if (!stopping) setTimeout(() => { if (!stopping) startLauncher() }, 500)
    })
    launcher = p
  }

  /** The box server's own log (LOG_DIR is its WALNUT_DAEMON_DIR). */
  function serverLog(): string {
    const dir = path.join(base, 'daemon')
    try {
      return fs.readdirSync(dir).filter((n) => /^open-walnut-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('')
    } catch { return '' }
  }
  const uploadsStarted = () => (serverLog().match(/package upload started/g) ?? []).length

  async function status(): Promise<BoxBuildStatus | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/bridge/build`, { headers: { Authorization: `Bearer ${machineToken}` }, signal: AbortSignal.timeout(5_000) })
      return r.status === 200 ? await r.json() as BoxBuildStatus : null
    } catch { return null }
  }

  async function waitFor(what: string, ok: (s: BoxBuildStatus) => boolean, ms: number): Promise<BoxBuildStatus> {
    const deadline = Date.now() + ms
    let last: BoxBuildStatus | null = null
    while (Date.now() < deadline) {
      last = await status()
      if (last && ok(last)) return last
      await sleep(500)
    }
    throw new Error(`${what}: not within ${ms} ms. Last status: ${JSON.stringify(last)}\n--- box log ---\n${log.slice(-6000)}`)
  }

  beforeAll(async () => {
    for (const f of [path.join(DIST, 'cli.js'), path.join(DIST, 'build-info.json'), path.join(DIST, 'daemon-binaries', `daemon-${process.platform}-${process.arch}`)]) {
      if (!fs.existsSync(f)) throw new Error(`this test runs a real build and ${f} is missing: bun run build, then cd web && bun x vite build`)
    }
    // Short: socket paths under it must fit in 104 bytes on macOS. Never `open-walnut-*`.
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cbu-'))
    R = path.join(base, 'host')
    box.home = path.join(base, 'home')
    box.data = path.join(base, 'data')
    for (const d of [box.home, box.data, path.join(base, 'hub'), path.join(base, 'base')]) await fsp.mkdir(d, { recursive: true })
    await fsp.symlink(DIST, path.join(base, 'base', 'dist'))
    await fsp.writeFile(path.join(box.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
    const now = new Date().toISOString()
    await fsp.writeFile(path.join(box.data, 'auth.json'), JSON.stringify({ devices: [
      { name: 'bridge-local', id: `d${crypto.randomBytes(8).toString('hex')}`, tokenHash: sha(machineToken), createdAt: now, kind: 'machine' },
    ] }), { mode: 0o600 })

    const infoA = JSON.parse(await fsp.readFile(path.join(DIST, 'build-info.json'), 'utf8'))
    idA = buildIdOf(infoA)
    const infoB = { version: infoA.version, commit: 'e2eb00001', branch: 'main', builtAt: new Date().toISOString(), dirty: false }
    const infoC = { ...infoB, commit: 'e2ec00001' }
    const distB = await linkedDist(path.join(base, 'pkg-b'), infoB)
    // C answers --version (the install's check) and never serves (the smoke boot's).
    const distC = await linkedDist(path.join(base, 'pkg-c'), infoC,
      "if (process.argv.includes('--version')) { console.log('0.0.0'); process.exit(0) }\nconsole.error('build C does not serve'); process.exit(7)\n")
    buildB = { id: buildIdOf(infoB), version: infoB.version, commit: infoB.commit, file: await walnutFileFor(distB) }
    buildC = { id: buildIdOf(infoC), version: infoC.version, commit: infoC.commit, file: await walnutFileFor(distC) }

    // The package's one dependency set (empty), marked installed: no package manager runs.
    const deps = path.join(R, 'deps', EMPTY_DEPS_HASH)
    await fsp.mkdir(path.join(deps, 'node_modules'), { recursive: true })
    await fsp.writeFile(path.join(deps, '.ready'), '')

    port = await freePort()
    h.endpoint = { url: `http://127.0.0.1:${port}/bridge`, token: machineToken }
    process.env.WALNUT_COMPANION_BUILD_POLL_MS = '500'
    startLauncher()
    await waitFor('the base build serves the build door', (s) => s.running.id === idA, 120_000)
  }, 300_000)

  afterAll(async () => {
    stopping = true
    delete process.env.WALNUT_COMPANION_BUILD_POLL_MS
    await _resetCompanionBuildForTesting().catch(() => {})
    const p = launcher
    if (p?.pid && p.pid > 1 && p.exitCode === null) {
      p.kill('SIGTERM')
      await Promise.race([new Promise((r) => p.once('exit', r)), sleep(20_000)])
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
    }
    if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  }, 60_000)

  it('starts on the base: the box takes builds and runs none of the Mac\'s yet', async () => {
    const s = (await status())!
    expect(s.accepts).toBe(true)
    expect(s.running).toMatchObject({ id: idA, base: true, trial: false })
    expect(s.current).toBeNull()
    expect(s.trial).toBeNull()
  })

  it('a Mac on build B brings the box to B: upload, install, smoke, trial, confirm', async () => {
    const idB = buildB.id
    h.build = buildB
    const startsBefore = starts
    await tickCompanionBuild('retry')
    expect(companionBuildView(), log.slice(-4000)).toMatchObject({ state: 'current', mine: idB, theirs: idB })
    const s = (await status())!
    expect(s.running).toMatchObject({ id: idB, base: false })
    expect(s.current).toBe(idB)
    expect(s.trial).toBeNull()
    // One restart into the trial; the box confirmed it itself.
    expect(starts - startsBefore).toBeGreaterThanOrEqual(1)
    // The build is the walnut file and the shim the launcher starts it through.
    const app = path.join(R, 'app', idB)
    expect(fs.existsSync(path.join(app, '.ready'))).toBe(true)
    expect(fs.readFileSync(path.join(app, 'walnut'), 'utf8')).toBe(fs.readFileSync(buildB.file, 'utf8'))
    expect(fs.readFileSync(path.join(app, 'dist', 'cli.js'), 'utf8')).toContain('starts the compiled walnut file beside it')
    // The launcher started B as its trial, and B confirmed itself. The box reports B
    // as current once B writes it; the launcher logs the confirm on its next poll (2 s).
    expect(log).toContain(`[companion-launch] trial ${idB}: start 1 of 2`)
    await vi.waitFor(() => expect(log).toContain(`[companion-launch] trial ${idB} confirmed`), { timeout: 15_000, interval: 200 })
  }, 900_000)

  it('a restart of the box keeps B (current, not a trial)', async () => {
    const p = launcher!
    p.kill('SIGTERM')
    const idB = buildB.id
    await waitFor('the box is back on B after a restart', (s) => s.running.id === idB && !s.running.trial && s.current === idB, 120_000)
    expect(log).toContain(`[companion-launch] running current build ${idB}`)
    // The Mac sees nothing to do.
    await tickCompanionBuild('retry')
    expect(companionBuildView()).toMatchObject({ state: 'current', mine: idB })
  }, 180_000)

  it('a build that never serves is given up after its smoke boot; the box keeps B and the Mac does not try again', async () => {
    // A Mac changes its build only by restarting: the driver keeps its id per process.
    await _resetCompanionBuildForTesting()
    const idB = buildB.id
    const idC = buildC.id
    h.build = buildC
    await tickCompanionBuild('retry')
    const view = companionBuildView()
    expect(view.state, JSON.stringify(view)).toBe('failed')
    expect(view.message ?? '').toMatch(/smoke|serve|exited/i)
    const s = (await status())!
    expect(s.running.id).toBe(idB)
    expect(s.current).toBe(idB)
    expect(s.failed.map((f) => f.id)).toContain(idC)
    // An automatic tick (a probe) does not upload it again. The Mac began two
    // uploads (B, C) and the box logged both; its log lands up to 2 s later.
    const uploadsBefore = h.uploadsBegun
    expect(uploadsBefore).toBeGreaterThanOrEqual(2)
    const logDeadline = Date.now() + 15_000
    while (uploadsStarted() < 2 && Date.now() < logDeadline) await sleep(250)
    expect(uploadsStarted()).toBeGreaterThanOrEqual(2)
    process.env.WALNUT_COMPANION_AUTO_TICKS = '1'
    process.env.WALNUT_COMPANION_BUILD_BOOT_DELAY_MS = '0'
    try {
      await tickCompanionBuild('probe')
    } finally {
      delete process.env.WALNUT_COMPANION_AUTO_TICKS
      delete process.env.WALNUT_COMPANION_BUILD_BOOT_DELAY_MS
    }
    expect(companionBuildView().state).toBe('failed')
    expect(h.uploadsBegun).toBe(uploadsBefore)
  }, 600_000)
})
