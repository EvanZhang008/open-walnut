/**
 * A server that starts later finds the daemon that still runs after the temp cleanup removed its
 * files (src/providers/daemon-lost-files.ts). 2026-11-25: a Mac updated from an older release; its
 * daemon of 15 days, started by a Walnut older than the daemon's own file keeper, had lost
 * daemon.port, daemon.pid and daemon.instance while it served three sessions. The new server saw
 * no daemon and started one, which yielded to the dir's instance lock and exited, so every session
 * start failed with "Local daemon failed to start: port file not created within 10s".
 *
 * In real processes (a daemon program, a fake CLI, each server's own LocalDaemon and
 * RemoteSessionManager):
 *   1. a server starts a session on its daemon program, then is gone (the app closed);
 *   2. the temp cleanup removes the daemon's identity files; the daemon and the CLI run on;
 *   3. a server starts again, and the same session answers its next turn in the same CLI:
 *      a. with a daemon program of its own (what a declined in-process start falls back to): the
 *         running program is found and kept, its files are back;
 *      b. with the daemon in its own process (experiment in_process_daemon, on by default): the running program is found and
 *         stopped first, and the runtime in the server adopts the session.
 *   4. the same on a remote host, where the leader starts the daemon with a shell command that
 *      waits for daemon.port and a live daemon.pid (daemon-start-cmd.ts): the daemon it starts
 *      yields to the running one and writes that daemon's files back, so the command answers with
 *      the running daemon's port instead of "the session daemon did not come up".
 *
 * MACHINE SAFETY: one temp root per scene (HOME, data, daemon dir); the processes signalled are the
 * ones this test started and the fake CLI, checked by its command line under the temp root first.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { startSessionSide } from '../helpers/walnut-session-side.js'
import { DOOR_FILE_NAMES } from '../../src/providers/daemon-lost-files.js'
import { buildDaemonStartCmd } from '../../src/providers/daemon-start-cmd.js'

const BUN = process.versions.bun ? process.execPath : null
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const roots: string[] = []
const spawned: ChildProcess[] = []
const clis: Array<{ pid: number; root: string }> = []

function alive(pid: number): boolean {
  try { return !/^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
}
function cmdline(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') } catch { return '' }
}
afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null && c.pid && c.pid > 1) { try { process.kill(c.pid, 'SIGTERM') } catch { /* gone */ } }
  for (const { pid, root } of clis) if (pid > 1 && alive(pid) && cmdline(pid).includes(root)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 300))
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

/** Steps 1 and 2: a session on a daemon program, its server gone, the daemon's identity files removed. */
async function sweptDaemon(): Promise<{ root: string; dir: string; program: ChildProcess; programExit: Promise<number | null>; sid: string; cli: number; envOf: (inProcess: '0' | '1') => NodeJS.ProcessEnv; file: (n: string) => string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lost-files-')))
  roots.push(root)
  const dir = path.join(root, 'd')
  const account = path.join(root, 'home')
  fs.mkdirSync(account, { recursive: true })
  // One Walnut, restarted: the same account, data dir and daemon dir each time. WALNUT_DAEMON_PERSISTENT:
  // a temp dir keeps its sessions over a daemon's stop, as the production dir does.
  const envOf = (inProcess: '0' | '1'): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: account, WALNUT_HOME_OVERRIDE: account, OPEN_WALNUT_HOME: path.join(root, 'walnut'),
      WALNUT_DAEMON_DIR: dir, WALNUT_DAEMON_PERSISTENT: '1', WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
      WALNUT_IN_PROCESS_DAEMON: inProcess, WALNUT_NET_NO_DOWNLOAD: '1', SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'),
    }
    for (const k of ['WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID', 'XDG_STATE_HOME']) delete env[k]
    return env
  }
  // The daemon an older Walnut started: it has no keeper of its own files (the hourly clock never runs here).
  let programOut = ''
  const program = spawn(BUN!, [STANDALONE, '--start'], { env: { ...envOf('0'), WALNUT_DAEMON_KEEP_SESSIONS: '1', WALNUT_RUNTIME_KEEP_MS: String(24 * 3600_000) }, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(program)
  program.stderr!.on('data', (c) => { programOut = (programOut + c).slice(-4000) })
  const programExit = new Promise<number | null>((r) => program.once('exit', (code) => r(code)))
  await new Promise<void>((resolve, reject) => {
    let text = ''
    const t = setTimeout(() => reject(new Error(`the daemon program printed no port: ${programOut}`)), 30_000)
    program.stdout!.on('data', (c) => { text += c; if (/^\d+$/m.test(text)) { clearTimeout(t); resolve() } })
    program.once('exit', (code) => { clearTimeout(t); reject(new Error(`the daemon program exited ${code}: ${programOut}`)) })
  })
  const before = await startSessionSide(envOf('0'), path.join(root, 'side-before'), spawned)
  const first = await before.call({ op: 'start' })
  expect(first, before.output()).toMatchObject({ ok: true, result: 'answer one', turns: 1 })
  const cli = Number(first.pid)
  clis.push({ pid: cli, root })
  // The server is gone (no stop of anything: its process ends); the daemon and the CLI run on.
  await before.stop()
  const file = (n: string) => path.join(dir, n)
  expect(fs.readFileSync(file('daemon.pid'), 'utf8').trim()).toBe(String(program.pid))
  for (const n of DOOR_FILE_NAMES) fs.rmSync(file(n))
  expect(program.exitCode === null && alive(cli), 'the daemon and the CLI outlive the cleanup').toBe(true)
  return { root, dir, program, programExit, sid: String(first.sid), cli, envOf, file }
}

describe.skipIf(!BUN || process.platform !== 'linux')('a server that starts after the temp cleanup removed a running daemon\'s files', () => {
  it('finds the daemon program through its instance lock, keeps it, and the session answers its next turn', async () => {
    const s = await sweptDaemon()
    const after = await startSessionSide(s.envOf('0'), path.join(s.root, 'side-after'), spawned)
    const ensured = await after.call({ op: 'ensure' })
    expect(ensured, after.output()).toMatchObject({ ok: true, inProcess: false })
    // The same daemon serves, found by its files again: an update of it later stops this pid, not none.
    expect(s.program.exitCode, 'the running daemon is kept').toBeNull()
    expect(fs.readFileSync(s.file('daemon.pid'), 'utf8').trim()).toBe(String(s.program.pid))
    expect(ensured.wsUrl).toBe(`ws://localhost:${fs.readFileSync(s.file('daemon.port'), 'utf8').trim()}`)
    expect(fs.existsSync(s.file('daemon.instance'))).toBe(true)
    const again = await after.call({ op: 'attach', sid: s.sid, word: 'two' })
    expect(again, after.output()).toMatchObject({ ok: true, alive: true, pid: s.cli, written: true, result: 'answer two', turns: 2 })
    await after.call({ op: 'exit' })
    await after.stop()
  }, 180_000)

  it('with the daemon in the server\'s own process: the program is found, stopped first, and its session adopted', async () => {
    const s = await sweptDaemon()
    const after = await startSessionSide(s.envOf('1'), path.join(s.root, 'side-after'), spawned)
    expect(await after.call({ op: 'ensure' }), after.output()).toMatchObject({ ok: true, inProcess: true })
    await Promise.race([s.programExit, new Promise((r) => setTimeout(r, 20_000))])
    expect(s.program.exitCode !== null || s.program.signalCode !== null, 'the daemon program is stopped').toBe(true)
    expect(alive(s.cli), 'the CLI outlives the program').toBe(true)
    const again = await after.call({ op: 'attach', sid: s.sid, word: 'two' })
    expect(again, after.output()).toMatchObject({ ok: true, alive: true, pid: s.cli, written: true, result: 'answer two', turns: 2 })
    await after.call({ op: 'exit' })
    await after.stop()
  }, 180_000)

  it('a host\'s start command answers with the running daemon\'s port, and its files are back', async () => {
    const s = await sweptDaemon()
    // The daemon file on a host, started the way the leader starts it over ssh.
    const exec = path.join(s.root, 'daemon-on-host')
    fs.writeFileSync(exec, `#!/bin/sh\nexec ${JSON.stringify(BUN!)} ${JSON.stringify(STANDALONE)} "$@"\n`, { mode: 0o755 })
    const env = s.envOf('0')
    const pass: Record<string, string> = {}
    for (const k of ['HOME', 'WALNUT_HOME_OVERRIDE', 'OPEN_WALNUT_HOME', 'WALNUT_DAEMON_DIR', 'WALNUT_DAEMON_PERSISTENT', 'WALNUT_LEGACY_STREAMS_DIR', 'PATH']) pass[k] = String(env[k])
    const cmd = buildDaemonStartCmd({ execPath: exec, dir: s.dir, env: pass })
    const ran = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      execFile('/bin/sh', ['-c', cmd], { env: { PATH: String(env.PATH), HOME: String(env.HOME) }, timeout: 90_000 }, (error, out, err) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(out), err: String(err) })
      })
    })
    const port = fs.existsSync(s.file('daemon.port')) ? fs.readFileSync(s.file('daemon.port'), 'utf8').trim() : ''
    expect(ran.code, `${ran.out}\n${ran.err}\n${fs.existsSync(s.file('daemon-start.log')) ? fs.readFileSync(s.file('daemon-start.log'), 'utf8') : ''}`).toBe(0)
    expect(port).toMatch(/^\d+$/)
    expect(ran.out.split('\n')[0]).toBe(port)
    expect(s.program.exitCode, 'the running daemon is kept').toBeNull()
    // What the host's stop command reads: the running daemon's pid, so an update stops it.
    expect(fs.readFileSync(s.file('daemon.pid'), 'utf8').trim()).toBe(String(s.program.pid))
    expect(alive(s.cli)).toBe(true)
  }, 180_000)
})
