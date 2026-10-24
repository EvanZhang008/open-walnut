/**
 * The two daemon twins, booted for real, against a pid file a dead daemon left.
 * A daemon predating the kernel instance lock holds no lock, so a starting
 * daemon still yields to the pid in daemon.pid; but after a restart (a
 * container's above all) that pid may name another live process. The daemon
 * then printed the dead daemon's port and exited, and the dir had no daemon
 * until the pid went away. A live pid is a legacy daemon now only when a daemon
 * answers on its port (`walnut-daemon ok`, what every daemon answers a plain
 * request with). `--status` follows the same rule, and `--stop` signals only a
 * pid that is this dir's daemon: never one a pid file of -1, 0, 1 or garbage
 * names (kill(-1) is every process of the user), never another process.
 *
 * MACHINE SAFETY: every daemon dir, HOME and streams dir is a temp dir; the
 * "other process" and the "legacy daemon" are this test's own children, ended in
 * afterEach; each daemon this test boots is SIGKILLed (no session is started).
 * Every `--stop` runs with process.kill stubbed (a preload that records the call
 * and sends no signal but the existence probe 0, to a pid above 1).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

let sourceText = ''
let root = ''
let killStub = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
/** How a twin runs `action` for `daemonDir` (the source twin from its deployed place, `<dir>/daemon.cjs`), with `preload` first when given. */
type Twin = { name: string; command: (action: string, daemonDir: string, preload?: string) => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: (action, daemonDir, preload) => [process.execPath, [...(preload ? ['--require', preload] : []), deployedSource(daemonDir), action]] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (action: string, _dir: string, preload?: string): [string, string[]] => [BUN, [...(preload ? ['--preload', preload] : []), STANDALONE, action]] }] : []),
]
const children: ChildProcess[] = []
const servers: http.Server[] = []
const execFileAsync = promisify(execFile)

function deployedSource(daemonDir: string): string {
  const p = path.join(daemonDir, 'daemon.cjs')
  if (!fs.existsSync(p)) fs.writeFileSync(p, sourceText, { mode: 0o755 })
  return p
}

function twinEnv(daemonDir: string): Record<string, string | undefined> {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home,
    WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
  }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']) delete env[k]
  return env
}

/** Runs a one-shot twin command (`--status`, `--stop` with process.kill stubbed); its stdout and the kill calls it made. */
async function oneShot(twin: Twin, action: '--status' | '--stop', daemonDir: string): Promise<{ stdout: string; kills: Array<[unknown, unknown]> }> {
  const log = path.join(root, `kills-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  const [cmd, args] = twin.command(action, daemonDir, action === '--stop' ? killStub : undefined)
  const { stdout } = await execFileAsync(cmd, args, { env: { ...twinEnv(daemonDir), WALNUT_TEST_KILL_LOG: log }, timeout: 30_000, encoding: 'utf-8' })
  const kills = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as [unknown, unknown]) : []
  return { stdout, kills }
}

/** A loopback listener this test owns: a daemon's plain-request answer, or another program's. */
function listener(answer: string): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => res.end(answer))
    servers.push(srv)
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port))
  })
}

function freshDaemonDir(): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stale-pid-')))
  const daemonDir = path.join(root, 'daemon')
  fs.mkdirSync(daemonDir, { recursive: true })
  return daemonDir
}

/** Boots the twin in `daemonDir`; resolves with the port it printed and how it ended (null: still running). */
async function boot(twin: Twin, daemonDir: string): Promise<{ port: number; exit: Promise<number | null>; proc: ChildProcess }> {
  const [cmd, args] = twin.command('--start', daemonDir)
  const proc = spawn(cmd, args, { env: twinEnv(daemonDir), stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(proc)
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon printed no port in 30s')), 30_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
  return { port, exit, proc }
}

function hello(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no hello answer')) }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' })))
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === 1) { clearTimeout(timer); ws.close(); resolve(msg) }
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** A port nothing listens on (bound, then closed). */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)) })
  })
}

beforeAll(() => {
  sourceText = getDaemonSource()
  // process.kill, stubbed for --stop: every call is recorded, and only the
  // existence probe (signal 0, to a pid above 1) reaches the real kill.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-kill-stub-'))
  killStub = path.join(dir, 'kill-stub.cjs')
  fs.writeFileSync(killStub, [
    "const fs = require('fs')",
    'const real = process.kill.bind(process)',
    'process.kill = function (pid, sig) {',
    "  fs.appendFileSync(process.env.WALNUT_TEST_KILL_LOG, JSON.stringify([pid, sig === undefined ? null : sig]) + '\\n')",
    "  if (sig === 0 && typeof pid === 'number' && pid > 1) return real(pid, 0)",
    "  if (sig === 0) { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e }",
    '  return true',
    '}',
  ].join('\n'))
})

afterEach(async () => {
  for (const srv of servers.splice(0)) srv.close()
  for (const c of children.splice(0)) {
    if (c.exitCode !== null || c.signalCode !== null) continue
    c.kill('SIGKILL')
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, 2000); c.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('daemon twin at --start: $name', (twin) => {
  it('a pid file naming a live process that is no daemon (nothing on its port): it starts, and leaves that process alone', async () => {
    const daemonDir = freshDaemonDir()
    const other = spawn('sleep', ['60'], { stdio: 'ignore' })
    children.push(other)
    const stale = await closedPort()
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(other.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(stale))

    const { port, proc } = await boot(twin, daemonDir)
    expect(port).not.toBe(stale)
    expect((await hello(port)).ok).toBe(true)
    expect(proc.exitCode).toBeNull()
    expect(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim()).toBe(String(proc.pid))
    expect(other.exitCode).toBeNull()
    expect(() => process.kill(other.pid!, 0)).not.toThrow()
  }, 60_000)

  it('a pid file naming a live process whose port answers as a daemon (one older than the lock): it yields, prints that port and exits', async () => {
    const daemonDir = freshDaemonDir()
    // The legacy daemon: a process that answers a plain request on loopback the way every daemon does.
    const legacy = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end('walnut-daemon ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(legacy)
    const legacyPort = await new Promise<number>((resolve) => legacy.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(legacy.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(legacyPort))

    const { port, exit } = await boot(twin, daemonDir)
    expect(port).toBe(legacyPort)
    expect(await exit).toBe(0)
    expect(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim()).toBe(String(legacy.pid))
  }, 60_000)

  it("a pid file naming a live process whose port is another program's (it answers, but not as a daemon): it starts", async () => {
    const daemonDir = freshDaemonDir()
    const other = spawn('sleep', ['60'], { stdio: 'ignore' })
    children.push(other)
    const foreignPort = await listener('hello from another program')
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(other.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(foreignPort))
    const { port, proc } = await boot(twin, daemonDir)
    expect(port).not.toBe(foreignPort)
    expect((await hello(port)).ok).toBe(true)
    expect(proc.exitCode).toBeNull()
    expect(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim()).toBe(String(proc.pid))
  }, 60_000)
})

describe.each(TWINS)('daemon twin at --status: $name', (twin) => {
  it('a dead daemon\'s files whose pid names another live process, whatever listens on the port: not running', async () => {
    const daemonDir = freshDaemonDir()
    const other = spawn('sleep', ['60'], { stdio: 'ignore' })
    children.push(other)
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(other.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(await closedPort()))
    expect(JSON.parse((await oneShot(twin, '--status', daemonDir)).stdout)).toEqual({ running: false })
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(await listener('hello from another program')))
    expect(JSON.parse((await oneShot(twin, '--status', daemonDir)).stdout)).toEqual({ running: false })
  }, 60_000)

  it('a running daemon: running, with its pid and port', async () => {
    const daemonDir = freshDaemonDir()
    const { port, proc } = await boot(twin, daemonDir)
    expect(JSON.parse((await oneShot(twin, '--status', daemonDir)).stdout)).toMatchObject({ running: true, pid: proc.pid, port })
  }, 60_000)
})

describe.each(TWINS)('daemon twin at --stop: $name', (twin) => {
  it.each(['-1', '0', '1', '', 'abc', '12x', '-4242', '1e3'])('daemon.pid holding %j: no signal at all', async (pidText) => {
    const daemonDir = freshDaemonDir()
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), pidText)
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), '41000')
    const { stdout, kills } = await oneShot(twin, '--stop', daemonDir)
    expect(stdout).toContain('daemon not running')
    expect(kills).toEqual([])
  }, 60_000)

  it('daemon.pid naming a live process that is not this daemon: no signal, and it keeps running', async () => {
    const daemonDir = freshDaemonDir()
    const other = spawn('sleep', ['60'], { stdio: 'ignore' })
    children.push(other)
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(other.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(await listener('walnut-daemon ok')))
    const { stdout, kills } = await oneShot(twin, '--stop', daemonDir)
    expect(stdout).toContain('which is not this daemon')
    expect(kills.filter(([, sig]) => sig !== 0)).toEqual([])
    expect(kills.every(([pid]) => pid === other.pid)).toBe(true)
    expect(other.exitCode).toBeNull()
  }, 60_000)

  it('this dir\'s running daemon: one SIGTERM, to its pid', async () => {
    const daemonDir = freshDaemonDir()
    const { proc } = await boot(twin, daemonDir)
    const { stdout, kills } = await oneShot(twin, '--stop', daemonDir)
    expect(stdout).toContain(`daemon stopped (pid=${proc.pid})`)
    expect(kills.filter(([, sig]) => sig !== 0)).toEqual([[proc.pid, 'SIGTERM']])
  }, 60_000)
})
