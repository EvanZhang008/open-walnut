/**
 * vscode-server-core — lifecycle unit tests with a FAKE code-server.
 *
 * A real code-server is ~100MB and boots in seconds; these tests plant a tiny
 * node script at the exact path findCodeServerEntry() probes
 * (~/.local/lib/code-server-<ver>/out/node/entry.js under a temp HOME) that
 * answers /healthz like the real thing. That exercises every line of our
 * lifecycle code (discovery, spawn, health wait, instance persistence,
 * adoption, idle reaping, kill) without the download.
 */
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'

let tempHome: string

// The fake entry.js: an HTTP server that binds --bind-addr and answers
// /healthz 200. Mirrors the two code-server behaviors our core depends on.
const FAKE_ENTRY = `
const http = require('node:http')
const args = process.argv.slice(2)
const bindIdx = args.indexOf('--bind-addr')
const [host, port] = args[bindIdx + 1].split(':')
const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return }
  res.writeHead(200); res.end('fake code-server')
})
srv.listen(Number(port), host)
`

async function plantFakeCodeServer(version: string): Promise<string> {
  const dir = path.join(tempHome, '.local', 'lib', `code-server-${version}`, 'out', 'node')
  await fs.mkdir(dir, { recursive: true })
  const entry = path.join(dir, 'entry.js')
  await fs.writeFile(entry, FAKE_ENTRY)
  return entry
}

async function loadCore() {
  // Fresh module per call: the core caches start attempts in module state,
  // and the "owner restart" tests need a clean module to prove disk-record
  // adoption. resetModules invalidates vitest's module registry so the next
  // import re-evaluates the file.
  vi.resetModules()
  return await import('../../src/providers/vscode-server-core.js')
}

function httpGet(port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-vscode-core-'))
  process.env.WALNUT_HOME_OVERRIDE = tempHome
  // As an isolated test daemon: its exit stops the instances spawned under this dir.
  process.env.WALNUT_DAEMON_DIR = path.join(tempHome, 'daemon')
})

afterEach(async () => {
  // Kill anything the test started (instance.json records the pid).
  try {
    const rec = JSON.parse(
      fss.readFileSync(path.join(tempHome, '.open-walnut', 'code-server', 'instance.json'), 'utf-8'),
    ) as { pid: number }
    try { process.kill(-rec.pid, 'SIGKILL') } catch { try { process.kill(rec.pid, 'SIGKILL') } catch { /* gone */ } }
  } catch { /* none */ }
  delete process.env.WALNUT_HOME_OVERRIDE
  delete process.env.WALNUT_DAEMON_DIR
  await fs.rm(tempHome, { recursive: true, force: true })
})

describe('findCodeServerEntry', () => {
  it('returns null when nothing is installed', async () => {
    const core = await loadCore()
    expect(await core.findCodeServerEntry()).toBeNull()
  })

  it('finds a planted install and prefers the newest version', async () => {
    await plantFakeCodeServer('4.90.0')
    const newest = await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    const found = await core.findCodeServerEntry()
    expect(found?.entry).toBe(newest)
    expect(found?.version).toBe('4.98.2')
  })

  it('skips a version dir without entry.js', async () => {
    // Broken newer dir + valid older one → the older wins.
    await fs.mkdir(path.join(tempHome, '.local', 'lib', 'code-server-9.99.9'), { recursive: true })
    const valid = await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    expect((await core.findCodeServerEntry())?.entry).toBe(valid)
  })
})

describe('ensureCodeServer lifecycle', () => {
  it('noInstall probe reports installed=false without downloading', async () => {
    const core = await loadCore()
    const res = await core.ensureCodeServer({ noInstall: true })
    expect(res.ok).toBe(false)
    expect(res.installed).toBe(false)
    expect(res.installHint).toContain('code-server')
  })

  it('starts the planted server, answers healthz, persists instance.json', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    const res = await core.ensureCodeServer()
    expect(res.ok).toBe(true)
    expect(res.running).toBe(true)
    expect(res.port).toBeGreaterThan(0)
    expect(res.token).toMatch(/^[0-9a-f]{32}$/)
    expect(await httpGet(res.port!, '/healthz')).toBe(200)

    const rec = JSON.parse(await fs.readFile(
      path.join(tempHome, '.open-walnut', 'code-server', 'instance.json'), 'utf-8',
    ))
    expect(rec.port).toBe(res.port)
    expect(rec.token).toBe(res.token)
  })

  it('second ensure adopts the live instance (same port + token, no respawn)', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    const first = await core.ensureCodeServer()
    const second = await core.ensureCodeServer()
    expect(second.port).toBe(first.port)
    expect(second.token).toBe(first.token)
  })

  it('a FRESH module (simulated owner restart) adopts via instance.json', async () => {
    await plantFakeCodeServer('4.98.2')
    const core1 = await loadCore()
    const first = await core1.ensureCodeServer()
    const core2 = await loadCore() // new module state = restarted owner
    const adopted = await core2.ensureCodeServer()
    expect(adopted.port).toBe(first.port)
    expect(adopted.token).toBe(first.token)
  })

  it('restarts when the recorded instance is dead', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    const first = await core.ensureCodeServer()
    // Kill it behind the core's back.
    const rec = JSON.parse(await fs.readFile(
      path.join(tempHome, '.open-walnut', 'code-server', 'instance.json'), 'utf-8',
    )) as { pid: number }
    try { process.kill(-rec.pid, 'SIGKILL') } catch { process.kill(rec.pid, 'SIGKILL') }
    await new Promise((r) => setTimeout(r, 200))

    // Fresh module: the in-module start cooldown must not block the restart.
    const core2 = await loadCore()
    const second = await core2.ensureCodeServer()
    expect(second.ok).toBe(true)
    expect(await httpGet(second.port!, '/healthz')).toBe(200)
    // Truly respawned: new pid on record (port may be reused by the OS).
    const rec2 = JSON.parse(await fs.readFile(
      path.join(tempHome, '.open-walnut', 'code-server', 'instance.json'), 'utf-8',
    )) as { pid: number }
    expect(rec2.pid).not.toBe(rec.pid)
    void first
  })
})

describe('idle reaping', () => {
  it('does not reap a fresh instance', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    await core.ensureCodeServer()
    expect(core.reapIdleCodeServer(Date.now())).toBe(false)
  })

  it('reaps when past the idle window and removes instance.json', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    const res = await core.ensureCodeServer()
    const future = Date.now() + core.VSCODE_IDLE_KILL_MS + 60_000
    expect(core.reapIdleCodeServer(future)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    await expect(httpGet(res.port!, '/healthz')).rejects.toThrow()
    expect(fss.existsSync(path.join(tempHome, '.open-walnut', 'code-server', 'instance.json'))).toBe(false)
  })

  it('a live heartbeat file blocks reaping even past the window', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    await core.ensureCodeServer()
    // code-server touches data/heartbeat while a browser is connected — fake it fresh.
    const hb = path.join(tempHome, '.open-walnut', 'code-server', 'data', 'heartbeat')
    await fs.mkdir(path.dirname(hb), { recursive: true })
    const future = Date.now() + core.VSCODE_IDLE_KILL_MS + 60_000
    await fs.writeFile(hb, '')
    await fs.utimes(hb, new Date(future - 1000), new Date(future - 1000))
    expect(core.reapIdleCodeServer(future)).toBe(false)
  })
})

describe('stopCodeServer', () => {
  it('kills the instance and clears the record', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    const res = await core.ensureCodeServer()
    core.stopCodeServer()
    await new Promise((r) => setTimeout(r, 300))
    await expect(httpGet(res.port!, '/healthz')).rejects.toThrow()
    expect((await core.codeServerStatus()).running).toBe(false)
  })
})

// 2026-10-26: instance.json outlives its process (a reboot), and the reapers signalled the
// GROUP of whatever pid it named after checking only that the pid was alive.
describe('a record that no longer names its code-server', () => {
  const instancePath = () => path.join(tempHome, '.open-walnut', 'code-server', 'instance.json')
  const dataArg = () => path.join(tempHome, '.open-walnut', 'code-server', 'data')
  let stranger: ChildProcess | null = null

  /** A live process of our own standing in for whoever got the recorded pid. */
  async function plantStrangerRecord(argv: string[], extra: Record<string, unknown> = {}): Promise<number> {
    stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...argv], { detached: true, stdio: 'ignore' })
    const pid = stranger.pid!
    await new Promise((r) => setTimeout(r, 200))
    await fs.mkdir(path.dirname(instancePath()), { recursive: true })
    await fs.writeFile(instancePath(), JSON.stringify({
      port: 1, token: 't', pid, version: '4.98.2', startedAt: Date.now() - 10 * 3_600_000, runtime: 'node', ...extra,
    }))
    return pid
  }
  const strangerAlive = () => stranger !== null && stranger.exitCode === null && stranger.signalCode === null
  const lookAlike = () => ['/h/.local/lib/code-server-4.98.2/out/node/entry.js', '--user-data-dir', dataArg()]
  const pastIdle = (core: { VSCODE_IDLE_KILL_MS: number }) => Date.now() + core.VSCODE_IDLE_KILL_MS + 60_000

  afterEach(() => {
    if (strangerAlive()) stranger!.kill('SIGKILL')
    stranger = null
  })

  it('an old record (no start time) naming a VS Code Remote server is not ours: alive, record dropped', async () => {
    const core = await loadCore()
    await plantStrangerRecord(['/h/.vscode-server/bin/abc/server-main.js', '--start-server'])
    expect(core.reapIdleCodeServer(pastIdle(core))).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(strangerAlive()).toBe(true)
    expect(fss.existsSync(instancePath())).toBe(false)
  })

  it('a recorded start time that differs means another process, even one that looks exactly like ours', async () => {
    const core = await loadCore()
    await plantStrangerRecord(lookAlike(), { startTime: 'Thu Jan  1 00:00:00 2026' })
    expect(core.reapIdleCodeServer(pastIdle(core))).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(strangerAlive()).toBe(true)
  })

  it('when ps cannot answer, nothing is signalled and the record is kept for the next scan', async () => {
    const savedPath = process.env.PATH
    const noPs = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-no-ps-'))
    let core: Awaited<ReturnType<typeof loadCore>>
    try {
      process.env.PATH = noPs  // the module reads its ps env at load
      core = await loadCore()
    } finally {
      process.env.PATH = savedPath
    }
    // spawnedIn here, so stopCodeServer gets as far as asking ps.
    await plantStrangerRecord(lookAlike(), { spawnedIn: process.env.WALNUT_DAEMON_DIR })
    expect(core!.reapIdleCodeServer(pastIdle(core!))).toBe(false)
    core!.stopCodeServer()
    await new Promise((r) => setTimeout(r, 300))
    expect(strangerAlive()).toBe(true)
    expect(fss.existsSync(instancePath())).toBe(true)
    await fs.rm(noPs, { recursive: true, force: true })
  })

  it("an isolated daemon's exit leaves an instance another daemon dir spawned, record and all", async () => {
    const core = await loadCore()
    await plantStrangerRecord(lookAlike(), { spawnedIn: '/tmp/open-walnut' })
    core.stopCodeServer()
    await new Promise((r) => setTimeout(r, 300))
    expect(strangerAlive()).toBe(true)
    expect(fss.existsSync(instancePath())).toBe(true)
  })

  it('a dead pid drops its record, so it never names whoever gets that pid next', async () => {
    const core = await loadCore()
    await plantStrangerRecord(lookAlike())
    stranger!.kill('SIGKILL')
    await new Promise((r) => stranger!.once('exit', r))
    expect(core.reapIdleCodeServer(Date.now())).toBe(false)
    expect(fss.existsSync(instancePath())).toBe(false)
  })

  it('a spawned instance records its start time and daemon dir', async () => {
    await plantFakeCodeServer('4.98.2')
    const core = await loadCore()
    await core.ensureCodeServer()
    const rec = JSON.parse(fss.readFileSync(instancePath(), 'utf-8')) as { startTime?: string; spawnedIn?: string }
    expect(rec.startTime).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/)
    expect(rec.spawnedIn).toBe(process.env.WALNUT_DAEMON_DIR)
  })

  it('identity rules', async () => {
    const core = await loadCore()
    const ours = `/usr/bin/node /h/.local/lib/code-server-4.98.2/out/node/entry.js --auth none --user-data-dir ${dataArg()} --extensions-dir x`
    const id = core.parseProcIdentity(`Mon Oct 26 10:15:01 2026 ${ours}\n`)
    expect(id).toEqual({ startTime: 'Mon Oct 26 10:15:01 2026', command: ours })
    expect(core.parseProcIdentity('Mon Oct  6 09:05:01 2026 x')?.startTime).toBe('Mon Oct  6 09:05:01 2026')
    expect(core.parseProcIdentity('')).toBeNull()
    expect(core.isRecordedInstance({ pid: 5, startTime: id!.startTime }, id)).toBe(true)
    expect(core.isRecordedInstance({ pid: 5, startTime: 'Tue Oct 27 10:15:01 2026' }, id)).toBe(false)
    expect(core.isRecordedInstance({ pid: 5 }, id)).toBe(true)
    // Same start time, another program: a start-time tie alone is not enough.
    expect(core.isRecordedInstance({ pid: 5, startTime: id!.startTime }, { startTime: id!.startTime, command: '/bin/zsh -l' })).toBe(false)
    expect(core.isRecordedInstance({ pid: 5 }, { startTime: id!.startTime, command: 'node /h/.vscode-server/bin/a/server-main.js code-server' })).toBe(false)
    // Another Walnut home's code-server is not this one.
    expect(core.isRecordedInstance({ pid: 5 }, { startTime: id!.startTime, command: ours.replace(dataArg(), '/other/.open-walnut/code-server/data') })).toBe(false)
    expect(core.isRecordedInstance({ pid: 5 }, null)).toBe(false)
  })
})

describe('resolveOpenTarget', () => {
  it('prefers an existing .code-workspace file (alphabetically first)', async () => {
    const dir = path.join(tempHome, 'proj')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'zz.code-workspace'), '{}')
    await fs.writeFile(path.join(dir, 'aa.code-workspace'), '{}')
    const core = await loadCore()
    const target = await core.resolveOpenTarget(dir)
    expect(target).toEqual({ kind: 'workspace', path: path.join(dir, 'aa.code-workspace') })
  })

  it('falls back to the directory as a folder', async () => {
    const dir = path.join(tempHome, 'plain')
    await fs.mkdir(dir, { recursive: true })
    const core = await loadCore()
    expect(await core.resolveOpenTarget(dir)).toEqual({ kind: 'folder', path: dir })
  })

  it('expands ~ against the home dir', async () => {
    const dir = path.join(tempHome, 'homework')
    await fs.mkdir(dir, { recursive: true })
    const core = await loadCore()
    expect(await core.resolveOpenTarget('~/homework')).toEqual({ kind: 'folder', path: dir })
  })
})
