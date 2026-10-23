/**
 * The companion's side of /bridge/build (src/core/companion-build/box.ts) on a
 * real tree in a temp root: chunked uploads, the real host install script (the
 * bun this runs on, an empty dependency set, so nothing is fetched), the
 * real smoke boot of a tiny fake build, and the trial confirm. The box's free
 * disk and its restart are the only hooks.
 *
 * The fake build is a dist/cli.js that prints a version for `--version` and,
 * for `web --port N`, either serves /api/v1/instance (and starts a fake daemon
 * that writes daemon.pid, as the real server's local daemon does), exits, or
 * never answers. It writes what it saw (its env, its pid) to a notes file.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _setBoxHooksForTesting, boxBuildStatus, putPackageChunk, runningBuild, startActivate, startInstall, startTrialConfirm, installEnv, smokeRuntime,
  dependencyInstallProblem,
} from '../../src/core/companion-build/box.js'
import { MAX_CHUNK_BYTES, MAX_PACKAGE_BYTES, type InstallRequest } from '../../src/core/companion-build/wire.js'

const ENV_KEYS = [
  'WALNUT_COMPANION_ROOT', 'WALNUT_COMPANION_LAUNCHER', 'WALNUT_COMPANION_MAC_BUILDS', 'WALNUT_COMPANION_BUILD',
  'WALNUT_COMPANION_TRIAL', 'WALNUT_COMPANION_SMOKE_MS', 'WALNUT_COMPANION_CONFIRM_MS',
  // What the live server has and the smoke server must not inherit.
  'WALNUT_STREAMS_DIR', 'WALNUT_GIT_HUB_DIR', 'WALNUT_SETUP_TOKEN_FILE', 'WALNUT_SETUP_TOKEN', 'OPEN_WALNUT_EPHEMERAL',
]
let saved: Record<string, string | undefined> = {}
let R = ''
let free: number | null = 100 * 1024 ** 3
let restarts = 0
const pids: number[] = []
const children: ChildProcess[] = []

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const read = (rel: string) => fs.readFileSync(path.join(R, rel), 'utf8').trim()
const has = (rel: string) => fs.existsSync(path.join(R, rel))
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true })
  fs.writeFileSync(path.join(R, rel), text)
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(what: string, fn: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Kind = 'serve' | 'exit' | 'hang'
const notesOf = (id: string) => path.join(R, `notes-${id}.json`)

/** A build package: package/dist/cli.js, gzipped tar, as the Mac sends it. */
function makePackage(id: string, kind: Kind): Buffer {
  const cli = `import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('9.9.9'); process.exit(0) }
const port = Number(args[args.indexOf('--port') + 1])
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(WALNUT_|OPEN_WALNUT_|VITEST)/.test(k)))
const note = { pid: process.pid, port, cwd: process.cwd(), env }
const kind = ${JSON.stringify(kind)}
const notes = ${JSON.stringify(notesOf(id))}
if (kind === 'exit') {
  fs.writeFileSync(notes, JSON.stringify(note))
  console.error('boom: the build cannot start')
  process.exit(3)
} else if (kind === 'hang') {
  fs.writeFileSync(notes, JSON.stringify(note))
  setInterval(() => {}, 1000)
} else {
  const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'walnut-fake-daemon'], { detached: true, stdio: 'ignore' })
  d.unref()
  fs.mkdirSync(process.env.WALNUT_DAEMON_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.WALNUT_DAEMON_DIR, 'daemon.pid'), String(d.pid))
  note.daemonPid = d.pid
  fs.writeFileSync(notes, JSON.stringify(note))
  http.createServer((req, res) => {
    res.writeHead(req.url === '/api/v1/instance' ? 200 : 404, { 'content-type': 'application/json' })
    res.end('{}')
  }).listen(port, '127.0.0.1')
}
`
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-box-pkg-'))
  try {
    fs.mkdirSync(path.join(work, 'package', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(work, 'package', 'dist', 'cli.js'), cli)
    execFileSync('tar', ['-czf', path.join(work, 'p.tgz'), '-C', work, 'package'])
    return fs.readFileSync(path.join(work, 'p.tgz'))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function notes(id: string): { pid: number; daemonPid?: number; cwd: string; env: Record<string, string> } {
  const n = JSON.parse(fs.readFileSync(notesOf(id), 'utf8'))
  for (const p of [n.pid, n.daemonPid]) if (typeof p === 'number') pids.push(p)
  return n
}

async function upload(id: string, bytes: Buffer, chunk = 1000): Promise<void> {
  for (let off = 0; off < bytes.length; off += chunk) {
    const r = await putPackageChunk({ id, offset: off, size: bytes.length, sha256: sha(bytes) }, bytes.subarray(off, off + chunk))
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}

const installReq = (id: string): InstallRequest => ({
  id, depsHash: 'abcdef01', dependencies: {}, optionalDependencies: {},
  appPackageJson: JSON.stringify({ name: 'open-walnut', version: '9.9.9', private: true, type: 'module' }),
})

async function install(id: string, kind: Kind = 'serve'): Promise<void> {
  await upload(id, makePackage(id, kind))
  const r = await startInstall(installReq(id))
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
  await waitFor(`install of ${id}`, async () => {
    const st = (await boxBuildStatus()).install
    if (st?.state === 'failed') throw new Error(`install failed: ${st.message} ${st.logTail}`)
    return st?.id === id && st.state === 'ready'
  })
  // `.ready` comes before the prune of older builds: the install is over when its
  // script says so (host-server/install.ts installScript ends with `installed`).
  const logFile = path.join(R, 'incoming', `${id}.install.log`)
  await waitFor(`the end of the install script of ${id}`, () => !fs.existsSync(logFile) || /^installed$/m.test(fs.readFileSync(logFile, 'utf8')))
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-box-'))
  process.env.WALNUT_COMPANION_ROOT = R
  process.env.WALNUT_COMPANION_LAUNCHER = '1'
  process.env.WALNUT_COMPANION_MAC_BUILDS = '1'
  free = 100 * 1024 ** 3
  restarts = 0
  _setBoxHooksForTesting({ restartSelf: () => { restarts++ }, freeBytes: async () => free })
})

afterEach(() => {
  for (const c of children.splice(0)) if (c.pid && c.pid > 1 && c.exitCode === null) c.kill('SIGKILL')
  for (const p of pids.splice(0)) if (p > 1 && alive(p)) process.kill(p, 'SIGKILL')
  // Never back to the real restart: a late timer would end this test worker.
  _setBoxHooksForTesting({ restartSelf: () => {} })
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(R, { recursive: true, force: true })
})

describe('the install environment', () => {
  it('carries what bun\'s install needs and none of the box secrets', () => {
    const env = installEnv({
      PATH: process.env.PATH, HOME: '/var/lib/walnut', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy:3128', npm_config_registry: 'https://registry.example',
      BUN_INSTALL_CACHE_DIR: '/var/cache/bun', BUN_CONFIG_REGISTRY: 'https://registry.example',
      AWS_BEARER_TOKEN_BEDROCK: 'planted', ANTHROPIC_API_KEY: 'planted', WALNUT_COMPANION_BUILD: 'x', OPEN_WALNUT_HOME: '/data', WALNUT_SETUP_TOKEN_FILE: '/etc/t',
    })
    expect(env).toEqual({
      PATH: process.env.PATH, HOME: '/var/lib/walnut', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://proxy:3128', npm_config_registry: 'https://registry.example',
      BUN_INSTALL_CACHE_DIR: '/var/cache/bun', BUN_CONFIG_REGISTRY: 'https://registry.example',
    })
  })
})

describe('the runtime a build is tried on', () => {
  it('names the runtime a smoke boot ran on: bun for bun and for the walnut file, else node', () => {
    expect(smokeRuntime({ ...process.versions, bun: '1.4.4' } as NodeJS.ProcessVersions)).toBe('bun')
    const { bun: _bun, ...nodeOnly } = process.versions as NodeJS.ProcessVersions & { bun?: string }
    expect(smokeRuntime(nodeOnly as NodeJS.ProcessVersions)).toBe('node')
  })

  it('on Node installs only a build with no dependencies (the walnut file), and names the fix for one with them', () => {
    const { bun: _bun, ...nodeOnly } = process.versions as NodeJS.ProcessVersions & { bun?: string }
    const onNode = nodeOnly as NodeJS.ProcessVersions
    const onBun = { ...process.versions, bun: '1.4.4' } as NodeJS.ProcessVersions
    const none = { dependencies: {}, optionalDependencies: {} }
    expect(dependencyInstallProblem(none, onNode)).toBeNull()
    expect(dependencyInstallProblem(none, onBun)).toBeNull()
    expect(dependencyInstallProblem({ dependencies: { yaml: '2.0.0' }, optionalDependencies: {} }, onBun)).toBeNull()
    expect(dependencyInstallProblem({ dependencies: { yaml: '2.0.0' }, optionalDependencies: {} }, onNode)).toMatch(/runs Walnut on Node.*scripts\/cloud\/setup\.sh/)
    expect(dependencyInstallProblem({ dependencies: {}, optionalDependencies: { sharp: '0.33.0' } }, onNode)).toMatch(/only bun installs/)
  })
})

describe('the upload', () => {
  it('takes chunks in order, checks the sha256 at the end, and keeps the package', async () => {
    const bytes = crypto.randomBytes(3000)
    const p = { id: 'u1', size: 3000, sha256: sha(bytes) }
    expect(await putPackageChunk({ ...p, offset: 0 }, bytes.subarray(0, 1000))).toEqual({ ok: true, received: 1000, size: 3000, complete: false })
    expect((await boxBuildStatus()).upload).toEqual({ id: 'u1', received: 1000, size: 3000, complete: false })
    expect(await putPackageChunk({ ...p, offset: 1000 }, bytes.subarray(1000, 2000))).toMatchObject({ ok: true, received: 2000 })
    expect(await putPackageChunk({ ...p, offset: 2000 }, bytes.subarray(2000))).toEqual({ ok: true, received: 3000, size: 3000, complete: true })
    expect(fs.readFileSync(path.join(R, 'incoming', 'u1.tgz')).equals(bytes)).toBe(true)
    expect(has('incoming/u1.tgz.part')).toBe(false)
    expect((await boxBuildStatus()).upload).toEqual({ id: 'u1', received: 3000, size: 3000, complete: true })
  })

  it('a chunk out of order is refused with the offset to resume from', async () => {
    const bytes = crypto.randomBytes(3000)
    const p = { id: 'u1', size: 3000, sha256: sha(bytes) }
    await putPackageChunk({ ...p, offset: 0 }, bytes.subarray(0, 1000))
    expect(await putPackageChunk({ ...p, offset: 2000 }, bytes.subarray(2000))).toMatchObject({ ok: false, error: 'offset_mismatch', received: 1000 })
    // An upload this box never started: from the beginning.
    expect(await putPackageChunk({ id: 'u2', size: 3000, sha256: sha(bytes), offset: 1000 }, bytes.subarray(1000, 2000)))
      .toMatchObject({ ok: false, error: 'offset_mismatch', received: 0 })
  })

  it('a repeated chunk says where the upload stands; a repeated complete package is complete at once', async () => {
    const bytes = crypto.randomBytes(3000)
    const p = { id: 'u1', size: 3000, sha256: sha(bytes) }
    await putPackageChunk({ ...p, offset: 0 }, bytes.subarray(0, 1000))
    await putPackageChunk({ ...p, offset: 1000 }, bytes.subarray(1000, 2000))
    expect(await putPackageChunk({ ...p, offset: 1000 }, bytes.subarray(1000, 2000))).toMatchObject({ ok: false, error: 'offset_mismatch', received: 2000 })
    expect(await putPackageChunk({ ...p, offset: 2000 }, bytes.subarray(2000))).toMatchObject({ ok: true, complete: true })
    expect(await putPackageChunk({ ...p, offset: 2000 }, bytes.subarray(2000))).toEqual({ ok: true, received: 3000, size: 3000, complete: true })
    expect(await putPackageChunk({ ...p, offset: 0 }, bytes.subarray(0, 1000))).toMatchObject({ ok: true, complete: true })
    expect(fs.readFileSync(path.join(R, 'incoming', 'u1.tgz')).equals(bytes)).toBe(true)
  })

  it('a package that does not match its sha256 is dropped', async () => {
    const bytes = crypto.randomBytes(2000)
    const p = { id: 'u1', size: 2000, sha256: sha(crypto.randomBytes(10)) }
    await putPackageChunk({ ...p, offset: 0 }, bytes.subarray(0, 1000))
    expect(await putPackageChunk({ ...p, offset: 1000 }, bytes.subarray(1000))).toMatchObject({ ok: false, error: 'sha_mismatch', received: 0 })
    expect(fs.readdirSync(path.join(R, 'incoming'))).toEqual([])
    expect((await boxBuildStatus()).upload).toBeNull()
  })

  it('refuses what is too large or malformed', async () => {
    const s = sha(Buffer.from('x'))
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: MAX_PACKAGE_BYTES + 1, sha256: s }, Buffer.from('x'))).toMatchObject({ error: 'too_large' })
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: MAX_PACKAGE_BYTES, sha256: s }, Buffer.alloc(MAX_CHUNK_BYTES + 1))).toMatchObject({ error: 'too_large' })
    expect(await putPackageChunk({ id: '../up', offset: 0, size: 10, sha256: s }, Buffer.from('x'))).toMatchObject({ error: 'bad_request' })
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: 10, sha256: 'nope' }, Buffer.from('x'))).toMatchObject({ error: 'bad_request' })
    expect(await putPackageChunk({ id: 'u1', offset: 5, size: 10, sha256: s }, Buffer.alloc(6))).toMatchObject({ error: 'bad_request' })
    expect(await putPackageChunk({ id: 'u1', offset: Number.NaN, size: 10, sha256: s }, Buffer.alloc(6))).toMatchObject({ error: 'bad_request' })
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: 10, sha256: s }, Buffer.alloc(0))).toMatchObject({ error: 'bad_request' })
    expect(has('incoming')).toBe(false)
  })

  it('a box that does not take builds refuses every step and says why', async () => {
    const bytes = Buffer.from('package')
    delete process.env.WALNUT_COMPANION_LAUNCHER
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes)).toMatchObject({ ok: false, error: 'refused' })
    expect(await startInstall(installReq('u1'))).toMatchObject({ ok: false, error: 'refused' })
    expect(await startActivate({ id: 'u1' })).toMatchObject({ ok: false, error: 'refused' })
    expect(await boxBuildStatus()).toMatchObject({ accepts: false, refusal: 'launcher_absent' })
    process.env.WALNUT_COMPANION_LAUNCHER = '1'
    process.env.WALNUT_COMPANION_MAC_BUILDS = '0'
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes)).toMatchObject({ ok: false, error: 'refused' })
    expect(await boxBuildStatus()).toMatchObject({ accepts: false, refusal: 'turned_off_on_box' })
    expect(has('incoming')).toBe(false)
  })

  it('a new upload drops the other one, and a package not yet installed', async () => {
    const a = crypto.randomBytes(2000)
    const c = crypto.randomBytes(500)
    await putPackageChunk({ id: 'a1', offset: 0, size: 2000, sha256: sha(a) }, a.subarray(0, 1000))
    await putPackageChunk({ id: 'c1', offset: 0, size: 500, sha256: sha(c) }, c)
    expect(fs.readdirSync(path.join(R, 'incoming')).sort()).toEqual(['c1.tgz', 'c1.upload.json'])
    const b = crypto.randomBytes(2000)
    await putPackageChunk({ id: 'b1', offset: 0, size: 2000, sha256: sha(b) }, b.subarray(0, 1000))
    expect(fs.readdirSync(path.join(R, 'incoming')).sort()).toEqual(['b1.tgz.part', 'b1.upload.json'])
    // The dropped one resumes from the beginning.
    expect(await putPackageChunk({ id: 'a1', offset: 1000, size: 2000, sha256: sha(a) }, a.subarray(1000))).toMatchObject({ error: 'offset_mismatch', received: 0 })
  })

  it('is busy while an install runs, and refuses on a full disk', async () => {
    // An install is the pid of a process whose command line names `<id>.install.sh`
    // (stateScript in src/core/host-server/install.ts), so a reused pid never reads as one.
    const sleeper = spawn('sh', ['-c', 'while :; do sleep 0.2; done', 'bx.install.sh'], { stdio: 'ignore' })
    children.push(sleeper)
    write('companion/install.json', JSON.stringify({ id: 'bx', at: Date.now() }))
    write('incoming/bx.pid', `${sleeper.pid}\n`)
    const bytes = Buffer.from('package')
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes)).toMatchObject({ ok: false, error: 'busy' })
    expect((await boxBuildStatus()).install).toEqual({ id: 'bx', state: 'running' })
    sleeper.kill('SIGKILL')
    await waitFor('the sleeper to end', () => sleeper.exitCode !== null || sleeper.signalCode !== null)
    free = 1024
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes)).toMatchObject({ ok: false, error: 'disk_full' })
    free = null // unknown free space never blocks
    expect(await putPackageChunk({ id: 'u1', offset: 0, size: bytes.length, sha256: sha(bytes) }, bytes)).toMatchObject({ ok: true, complete: true })
    free = 1024
    expect(await startInstall(installReq('u1'))).toMatchObject({ ok: false, error: 'disk_full' })
  })
})

describe('the status', () => {
  it('reads current, trial, attempts and the failed builds newest first', async () => {
    write('companion/current', 'c1\n')
    write('companion/trial', 't1\n')
    write('companion/attempts', '2\n')
    const t0 = Date.now() / 1000 - 1000
    for (let i = 0; i < 12; i++) {
      write(`companion/failed/f${i}`, `smoke: reason ${i}\nsecond line\n`)
      fs.utimesSync(path.join(R, 'companion', 'failed', `f${i}`), t0 + i, t0 + i)
    }
    write('companion/failed/long', `${'x'.repeat(400)}\n`)
    write('companion/failed/.f99.123.tmp', 'half written')
    const st = await boxBuildStatus()
    expect(st).toMatchObject({ ok: true, schema: 1, accepts: true, current: 'c1', trial: { id: 't1', attempts: 2 }, upload: null, install: null, activate: null })
    expect(st.refusal).toBeUndefined()
    expect(st.failed.map((f) => f.id)).toEqual(['long', 'f11', 'f10', 'f9', 'f8', 'f7', 'f6', 'f5', 'f4', 'f3'])
    expect(st.failed[1]!.why).toBe('smoke: reason 11')
    expect(st.failed[0]!.why).toHaveLength(300)
    expect(st).toMatchObject({ platform: process.platform, arch: process.arch, node: process.version, freeBytes: 100 * 1024 ** 3 })
  })

  it('names the running build, base or launched, trial or not; free disk from the filesystem', async () => {
    _setBoxHooksForTesting({ restartSelf: () => { restarts++ } })
    let st = await boxBuildStatus()
    expect(st.running).toMatchObject({ id: runningBuild().id, base: true, trial: false })
    expect(st.freeBytes).toBeGreaterThan(0)
    process.env.WALNUT_COMPANION_BUILD = 'base'
    expect((await boxBuildStatus()).running.base).toBe(true)
    process.env.WALNUT_COMPANION_BUILD = 'b7'
    process.env.WALNUT_COMPANION_TRIAL = '1'
    st = await boxBuildStatus()
    expect(st.running).toMatchObject({ base: false, trial: true })
    expect(st.current).toBeNull()
    expect(st.trial).toBeNull()
  })
})

describe('install and activate on a real tree', () => {
  it('a good build installs, passes the smoke boot, becomes the trial, and the box restarts', async () => {
    write('companion/failed/g1', 'smoke: an earlier try\n')
    write('companion/attempts', '1\n')
    Object.assign(process.env, {
      WALNUT_STREAMS_DIR: '/live/streams', WALNUT_GIT_HUB_DIR: '/live/git', WALNUT_SETUP_TOKEN_FILE: '/live/setup-token',
      WALNUT_SETUP_TOKEN: 'live-token', OPEN_WALNUT_EPHEMERAL: '1', WALNUT_COMPANION_BUILD: 'base',
    })
    await upload('g1', makePackage('g1', 'serve'))
    expect(await startInstall(installReq('g1'))).toEqual({ ok: true, state: 'running' })
    expect(['running', 'ready']).toContain((await startInstall(installReq('g1'))).state)
    await waitFor('the install', async () => (await boxBuildStatus()).install?.state === 'ready')
    expect(has('app/g1/.ready')).toBe(true)
    // The script removes the package right after it marks the build ready.
    await waitFor('the package to be removed', () => !has('incoming/g1.tgz'), 5_000)
    expect(await startInstall(installReq('g1'))).toEqual({ ok: true, state: 'ready' })

    expect(await startActivate({ id: 'g1' })).toEqual({ ok: true, state: 'smoking' })
    expect(await startActivate({ id: 'g1' })).toEqual({ ok: true, state: 'smoking' })
    expect(await startActivate({ id: 'other' })).toMatchObject({ ok: false })
    await waitFor('the restart', () => restarts === 1)
    expect(read('companion/trial')).toBe('g1')
    // The launcher runs a dist build only on the runtime its smoke boot passed on.
    expect(read('app/g1/.runtime')).toBe(process.versions.bun ? 'bun' : 'node')
    expect(has('companion/attempts')).toBe(false)
    expect(has('companion/failed/g1')).toBe(false)
    expect((await boxBuildStatus()).activate).toMatchObject({ id: 'g1', state: 'restarting' })
    expect(await startActivate({ id: 'g1' })).toEqual({ ok: true, state: 'restarting' })

    // What the smoke server saw: an isolated home, none of the launcher's variables.
    const n = notes('g1')
    expect(n.env.OPEN_WALNUT_HOME!.startsWith(path.join(os.tmpdir(), 'walnut-smoke-'))).toBe(true)
    const smokeDir = path.dirname(n.env.OPEN_WALNUT_HOME!)
    expect(n.env.WALNUT_DAEMON_DIR).toBe(path.join(smokeDir, 'daemon'))
    expect(n.env.WALNUT_GIT_HUB_DIR).toBe(path.join(smokeDir, 'git'))
    expect(n.env).toMatchObject({ WALNUT_DISABLE_SEARCH: '1', WALNUT_DAEMON_HEARTBEAT_MS: '2000', WALNUT_STT_AUTO_SETUP: '0', WALNUT_NO_AUTO_UPDATE: '1' })
    const dropped = ['VITEST', 'WALNUT_STREAMS_DIR', 'WALNUT_SETUP_TOKEN_FILE', 'WALNUT_SETUP_TOKEN', 'OPEN_WALNUT_EPHEMERAL']
    expect(Object.keys(n.env).filter((k) => k.startsWith('WALNUT_COMPANION_') || dropped.includes(k))).toEqual([])
    expect(fs.realpathSync(n.cwd)).toBe(fs.realpathSync(path.join(R, 'app', 'g1')))
    // The server, its daemon and the temp dir are gone.
    expect(alive(n.pid)).toBe(false)
    await waitFor('the fake daemon to stop', () => !alive(n.daemonPid!), 5_000)
    expect(fs.existsSync(path.dirname(n.env.OPEN_WALNUT_HOME!))).toBe(false)
  })

  it('a build that exits before it serves is given up, and says why', async () => {
    await install('e1', 'exit')
    expect(await startActivate({ id: 'e1' })).toEqual({ ok: true, state: 'smoking' })
    await waitFor('the smoke to fail', async () => (await boxBuildStatus()).activate?.state === 'failed')
    const st = await boxBuildStatus()
    expect(st.activate!.message).toMatch(/^the build exited \(code 3\) before it served \/api\/v1\/instance\. Last lines: .*boom: the build cannot start/)
    expect(read('companion/failed/e1')).toBe('in a test start, the build exited (code 3) before it served /api/v1/instance')
    expect(st.failed.map((f) => f.id)).toEqual(['e1'])
    expect(has('companion/trial')).toBe(false)
    expect(restarts).toBe(0)
    notes('e1')
  })

  it('a build that never answers fails at the smoke deadline and is stopped', async () => {
    process.env.WALNUT_COMPANION_SMOKE_MS = '1500'
    await install('h1', 'hang')
    expect(await startActivate({ id: 'h1' })).toEqual({ ok: true, state: 'smoking' })
    await waitFor('the smoke to time out', async () => (await boxBuildStatus()).activate?.state === 'failed', 20_000)
    expect(read('companion/failed/h1')).toBe('in a test start, the build did not serve /api/v1/instance within 2 s')
    expect(alive(notes('h1').pid)).toBe(false)
    expect(restarts).toBe(0)
  })

  it('activate needs an installed build; the running build is already running; install needs a package', async () => {
    expect(await startActivate({ id: 'nope' })).toMatchObject({ ok: false, error: 'not_installed' })
    expect(await startActivate({ id: runningBuild().id })).toEqual({ ok: true, state: 'running' })
    expect(await startActivate({ id: '../x' })).toMatchObject({ ok: false, error: 'bad_request' })
    expect(await startInstall(installReq('nope'))).toMatchObject({ ok: false, error: 'no_package' })
    expect(await startInstall({ id: 'x' })).toMatchObject({ ok: false, error: 'bad_request' })
  })

  it('a box running the compiled file installs with it as bun, and from source with this bun', async () => {
    await install('s1')
    const fromSource = fs.readFileSync(path.join(R, 'incoming', 's1.install.sh'), 'utf8')
    expect(fromSource).toContain(`BUN='${process.execPath}'`)
    expect(fromSource).toContain('unset BUN_BE_BUN')
    const { setSingleFile } = await import('../../src/lib/single-file.js')
    setSingleFile({ root: '/rt', daemonVersion: 'd', modules: {} })
    try {
      // bun itself ignores BUN_BE_BUN, so the install still runs here.
      await install('s2')
    } finally {
      delete (globalThis as Record<string, unknown>).__WALNUT_SINGLE_FILE__
    }
    const compiled = fs.readFileSync(path.join(R, 'incoming', 's2.install.sh'), 'utf8')
    expect(compiled).toContain(`BUN='${process.execPath}'`)
    expect(compiled).toContain('export BUN_BE_BUN=1')
  })

  it('the current and the trial build are never pruned', async () => {
    await install('k1')
    write('companion/current', 'k1\n')
    for (const id of ['k2', 'k3', 'k4']) await install(id)
    // k2 went (the prune keeps the newest other build, k3); k1 is current.
    expect(fs.readdirSync(path.join(R, 'app')).sort()).toEqual(['k1', 'k3', 'k4'])
    write('companion/trial', 'k3\n')
    await install('k5')
    expect(fs.readdirSync(path.join(R, 'app')).sort()).toEqual(['k1', 'k3', 'k4', 'k5'])
  })
})

describe('the trial confirm', () => {
  it('a trial that ran its time becomes current; the old current becomes previous', async () => {
    process.env.WALNUT_COMPANION_TRIAL = '1'
    process.env.WALNUT_COMPANION_BUILD = 't9'
    process.env.WALNUT_COMPANION_CONFIRM_MS = '30'
    write('companion/current', 'old1\n')
    write('companion/trial', 't9\n')
    write('companion/attempts', '1\n')
    expect(await startTrialConfirm()).toBe(true)
    expect(read('companion/current')).toBe('t9')
    expect(read('companion/previous')).toBe('old1')
    expect(has('companion/trial')).toBe(false)
    expect(has('companion/attempts')).toBe(false)
  })

  it('a first trial has no previous; a trial file naming another build changes nothing', async () => {
    process.env.WALNUT_COMPANION_TRIAL = '1'
    process.env.WALNUT_COMPANION_BUILD = 't9'
    process.env.WALNUT_COMPANION_CONFIRM_MS = '30'
    write('companion/trial', 't9\n')
    expect(await startTrialConfirm()).toBe(true)
    expect(read('companion/current')).toBe('t9')
    expect(has('companion/previous')).toBe(false)
    write('companion/trial', 'newer\n')
    expect(await startTrialConfirm()).toBe(false)
    expect(read('companion/current')).toBe('t9')
    expect(read('companion/trial')).toBe('newer')
  })

  it('a box that is not a trial does nothing', async () => {
    write('companion/trial', 't9\n')
    expect(await startTrialConfirm()).toBe(false)
    expect(has('companion/current')).toBe(false)
  })
})
