/**
 * Which Walnuts a daemon serves (served-walnuts-core.ts), on BOTH daemon twins booted
 * for real: the daemon writes daemon.serves.json beside daemon.version with its
 * version and the capabilities its hello says; a server socket's per-Walnut push is
 * noted under its Walnut's key (an older server's unnamed push as "-"); a test server's
 * probe socket is never noted; the hello carries the same record; a restarted daemon
 * reads it back. A server decides from it whether another Walnut shares this daemon
 * (daemon-shared.ts), so the record is checked against what the server parses.
 *
 * And a server the daemon runs for a leader (`server.configure`) is that leader's Walnut: its
 * own-sessions link pushes `turns.configure` / `workspace.configure` naming its data dir (as a
 * host replica does), which never reads as another Walnut sharing the daemon, and a key an older
 * build filed that data dir under is dropped when the daemon starts (2026-11-23: a leader kept an
 * old daemon for four hours for "another Walnut" that was its own replica).
 *
 * MACHINE SAFETY: HOME and the daemon dir are temp paths; every process is killed after (the
 * placeholder server by the pid it writes).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { parseServes, sharedDaemonVerdict, walnutKeyOf, ourDaemonCapabilities } from '../../src/providers/daemon-shared.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-served-twins-')))
afterAll(() => { if (root.includes('walnut-served-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const TWINS: Array<{ name: string; twin: 'source' | 'binary'; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, twin: 'source', command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', twin: 'binary' as const, command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
const sockets: WebSocket[] = []
let rpcId = 1
/** Placeholder servers the daemons started (they outlive a daemon by design). */
const serverPids = new Set<number>()
afterAll(() => {
  for (const pid of serverPids) { if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
})
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  await stop()
})

async function stop(): Promise<void> {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
}

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<number> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'OPEN_WALNUT_HOME']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
}

async function open(port: number): Promise<WebSocket> {
  const s = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`)
    sock.on('open', () => resolve(sock))
    sock.on('error', reject)
  })
  sockets.push(s)
  return s
}

function rpc(sock: WebSocket, cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 50)) }
  throw new Error('condition not met in time')
}

describe.each(TWINS)('$name', (twin) => {
  it('records the Walnuts it serves beside daemon.version, and the server reads the record', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    const servesFile = path.join(dir, 'daemon', 'daemon.serves.json')
    const port = await boot(twin, dir)
    const a = await open(port)

    const hello = await rpc(a, { cmd: 'hello' })
    expect(hello.ok).toBe(true)
    await until(() => fs.existsSync(servesFile))
    const atBoot = JSON.parse(fs.readFileSync(servesFile, 'utf8'))
    // Whether its runtime can have a pty (pty-stream-v1): the binary always, the source twin under bun only.
    const pty = twin.twin === 'binary' || SOURCE_TWIN.runtime === 'bun'
    expect(atBoot).toMatchObject({ v: 1, version: hello.version, twin: twin.twin, pty, walnuts: {} })
    expect(fs.readFileSync(path.join(dir, 'daemon', 'daemon.version'), 'utf8')).toBe(hello.version)
    // The binary says all this build's daemon has (the source twin adds the rest as its sidecars load).
    if (twin.twin === 'binary') for (const c of ourDaemonCapabilities('binary')) expect(hello.capabilities).toContain(c)
    expect(hello.served).toEqual({ twin: twin.twin, walnuts: {}, pty })

    // Walnut A names its home; an older server pushes with none; a test server's probe is never noted.
    const HOME_A = path.join(dir, 'walnut-a')
    const HOME_PROBE = path.join(dir, 'walnut-probe')
    await rpc(a, { cmd: 'turns.configure', home: HOME_A, enabled: false, keep: 5 })
    // A bridge push naming no home (also a new server whose hello failed) is not another Walnut.
    const unnamedBridge = await open(port)
    await rpc(unnamedBridge, { cmd: 'bridge.configure', enabled: false })
    expect((await rpc(unnamedBridge, { cmd: 'hello' })).served).toEqual({ twin: twin.twin, walnuts: { [walnutKeyOf(HOME_A)]: expect.any(Number) }, pty })
    // A home written with a trailing slash is the same Walnut.
    await rpc(a, { cmd: 'triggers.configure', home: HOME_A + '/', triggers: [] })
    const older = await open(port)
    await rpc(older, { cmd: 'turns.configure', enabled: false, keep: 3 })
    const probe = await open(port)
    expect((await rpc(probe, { cmd: 'client.role', role: 'probe' })).ok).toBe(true)
    await rpc(probe, { cmd: 'turns.configure', home: HOME_PROBE, enabled: false, keep: 1 })

    const after = await rpc(a, { cmd: 'hello' })
    const walnuts = (after.served as { walnuts: Record<string, number> }).walnuts
    expect(Object.keys(walnuts).sort()).toEqual([walnutKeyOf(HOME_A), '-'].sort())
    await until(() => Object.keys(JSON.parse(fs.readFileSync(servesFile, 'utf8')).walnuts).length === 2)
    const file = JSON.parse(fs.readFileSync(servesFile, 'utf8'))
    expect(file.capabilities).toEqual(after.capabilities)

    // A third Walnut on another build reads the record the way DaemonConnection does. The binary
    // has all this build's daemon has: kept. This test loads none of the source twin's sidecars,
    // so that daemon lacks capabilities a real source deploy has: it would be updated.
    const rec = parseServes(fs.readFileSync(servesFile, 'utf8'))
    const verdict = (home: string) => sharedDaemonVerdict({ ourKey: walnutKeyOf(home), runningVersion: String(after.version), running: rec, now: Date.now() })
    if (twin.twin === 'binary') {
      expect(verdict(path.join(dir, 'walnut-c'))).toMatchObject({ keep: true })
      // Walnut A is not held by its own record, only by the older server's "-".
      expect(verdict(HOME_A)).toMatchObject({ keep: true, others: ['-'] })
    } else {
      expect(verdict(path.join(dir, 'walnut-c'))).toMatchObject({ keep: false, shared: true })
    }

    // A restarted daemon reads the record back.
    for (const s of sockets.splice(0)) s.close()
    await stop()
    const port2 = await boot(twin, dir)
    const again = await rpc(await open(port2), { cmd: 'hello' })
    expect(Object.keys((again.served as { walnuts: Record<string, number> }).walnuts).sort()).toEqual([walnutKeyOf(HOME_A), '-'].sort())
  }, 90_000)

  it('a server it runs for a leader is that leader\'s Walnut: its data dir is never another Walnut sharing it', async () => {
    const dir = path.join(root, 'f-' + twin.name.replace(/\W+/g, '-'))
    const servesFile = path.join(dir, 'daemon', 'daemon.serves.json')
    const HOME_A = '/fixture/marina-home'
    const WALNUT_A = 'wmarinaserved01'
    // The layout a leader writes for its server on a host: <host root>/walnuts/<walnut id>/data.
    const data = path.join(dir, 'host-root', 'walnuts', WALNUT_A, 'data')
    const walnutsIn = () => Object.keys(JSON.parse(fs.readFileSync(servesFile, 'utf8')).walnuts as Record<string, number>).sort()
    let port = await boot(twin, dir)

    const leader = await open(port)
    expect((await rpc(leader, { cmd: 'hello' })).ok).toBe(true)
    expect((await rpc(leader, { cmd: 'leader.configure', home: HOME_A, walnutId: WALNUT_A, backup: true })).ok).toBe(true)
    const pidFile = path.join(dir, 'placeholder.pid')
    const spec = {
      v: 1, home: HOME_A, walnutId: WALNUT_A, command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30)`],
      cwd: dir, env: { OPEN_WALNUT_HOME: data }, log: path.join(dir, 'placeholder.log'), port: 41_207 + (twin.twin === 'binary' ? 1 : 0),
      settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
    }
    const configured = await rpc(leader, { cmd: 'server.configure', home: HOME_A, spec })
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    await until(() => fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8')), 20_000)
    serverPids.add(Number(fs.readFileSync(pidFile, 'utf8')))

    // That server's own-sessions link (a host replica's session runner): a hello that binds no
    // Walnut, then the two settings its sessions run under, named by its data dir.
    const own = await open(port)
    expect((await rpc(own, { cmd: 'hello', run: 'fixture-replica-run' })).ok).toBe(true)
    expect((await rpc(own, { cmd: 'turns.configure', home: data, enabled: false, keep: 5 })).ok).toBe(true)
    await rpc(own, { cmd: 'workspace.configure', home: data + '/', config: { providers: [] } })
    const walnuts = ((await rpc(own, { cmd: 'hello', run: 'fixture-replica-run' })).served as { walnuts: Record<string, number> }).walnuts
    expect(Object.keys(walnuts), 'its data dir is filed under its leader').toEqual([walnutKeyOf(HOME_A)])
    await until(() => fs.existsSync(servesFile) && walnutsIn().length > 0)
    expect(walnutsIn()).toEqual([walnutKeyOf(HOME_A)])
    // The leader on another build reads only itself: the daemon is not kept for "another Walnut".
    const rec = parseServes(fs.readFileSync(servesFile, 'utf8'))
    expect(sharedDaemonVerdict({ ourKey: walnutKeyOf(HOME_A), runningVersion: rec!.version, running: rec, now: Date.now() }))
      .toMatchObject({ keep: false, why: 'only this Walnut uses it' })

    // An older build filed the data dir under its own key: the next start drops it from the file,
    // with no socket connected (the leader may read the file before it connects).
    for (const s of sockets.splice(0)) s.close()
    await stop()
    const stale = JSON.parse(fs.readFileSync(servesFile, 'utf8'))
    stale.walnuts[walnutKeyOf(data)] = Date.now()
    fs.writeFileSync(servesFile, JSON.stringify(stale))
    port = await boot(twin, dir)
    await until(() => { try { return walnutsIn().join() === walnutKeyOf(HOME_A) } catch { return false } })
    const again = await rpc(await open(port), { cmd: 'hello' })
    expect(Object.keys((again.served as { walnuts: Record<string, number> }).walnuts)).toEqual([walnutKeyOf(HOME_A)])
  }, 120_000)
})

/**
 * The live case of 2026-11-23: a host's one Walnut service (one process, the binary twin's
 * runtime with its own follower home) whose own-sessions link pushes from the same process
 * (tests/helpers/served-walnuts-self-proc.ts). Its data dir is its leader's Walnut, by the self
 * entry boot() files from the spec the leader configured, not by the service's env (which has no
 * OPEN_WALNUT_HOME); an older build's key of that dir is gone once the runtime started.
 */
describe.skipIf(!BUN)('a host\'s one Walnut service (binary twin, in one process)', () => {
  it('its own data dir is its leader\'s Walnut: the record holds only the leader key, at start and after its pushes', async () => {
    const dir = path.join(root, 'self-service')
    fs.mkdirSync(dir, { recursive: true })
    const FIXTURE = path.resolve(__dirname, '../helpers/served-walnuts-self-proc.ts')
    const out = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const env = { ...process.env, PATH: guardedPath([], '/usr/bin:/bin') }
      delete env.OPEN_WALNUT_HOME
      execFile(BUN!, [FIXTURE, dir], { env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const last = String(stdout).trim().split('\n').pop() ?? ''
        try { resolve(JSON.parse(last) as Record<string, unknown>) } catch { reject(new Error(`${error?.message ?? ''}\n${String(stderr).slice(-3000)}\n${String(stdout).slice(-1500)}`)) }
      })
    })
    const only = [out.leaderKey]
    expect(out.atStart, 'an older build\'s key of the data dir is gone once it started').toEqual(only)
    expect(out.helloAtStart).toEqual(only)
    expect(out.turns).toBe(true)
    expect(out.helloAfterPush, 'its pushes are filed under its leader').toEqual(only)
    expect(out.fileAfterPush).toEqual(only)
    expect(out.stopCode).toBe(0)
    expect(out.exitCalls).toBe(0)
  }, 120_000)
})
