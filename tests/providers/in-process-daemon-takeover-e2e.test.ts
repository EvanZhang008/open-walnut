/**
 * The leader's own computer with in_process_daemon on by default: two Walnut servers under one OS
 * account meet in one daemon dir (the production dir is the account's, whatever the data dir).
 * In real processes, each server's own LocalDaemon and RemoteSessionManager:
 *
 *   1. server X (an older build: its daemon a program of its own) has a session running on that
 *      program;
 *   2. server Y (this build) boots and takes the dir over: the program is stopped (its sessions kept,
 *      as the production dir keeps them) and the runtime starts in Y's process, adopting X's session;
 *   3. X loses nothing: the same CLI answers X's next turns (turn 2, 3 of the same conversation),
 *      X reaching it where the dir's daemon serves now (Y's door), through its own LocalDaemon. X's
 *      link drops with the program, as at any daemon restart: its manager is attached again here,
 *      what the server's recovery does for each running session record (DaemonConnection
 *      reattachRecoveredSession -> reattachWatcher), which this harness has no session store for;
 *   4. a third server Z that boots with the runtime in process too is refused, and the refusal
 *      names Y (pid, data dir) and the ways on (in-process-daemon.ts AnotherServiceError).
 *
 * MACHINE SAFETY: one temp root (HOME, data, daemon dirs); the processes signalled are the ones this
 * test started and the fake CLI, checked by its command line under the temp root first.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { startSessionSide } from '../helpers/walnut-session-side.js'
import { anotherServiceHolds } from '../../src/providers/in-process-daemon.js'

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

describe.skipIf(!BUN || process.platform !== 'linux')('a newer server takes over the daemon dir of an older one on the same account', () => {
  it('the older server\'s session is adopted and keeps its conversation; a third server is refused by name', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-takeover-')))
    roots.push(root)
    const dir = path.join(root, 'd')
    const account = path.join(root, 'home')
    fs.mkdirSync(account, { recursive: true })
    // One account, one daemon dir; each server its own data dir. WALNUT_DAEMON_PERSISTENT: a temp dir
    // keeps its sessions over a daemon's stop, as the production dir does.
    const envOf = (name: string, inProcess: '0' | '1'): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = {
        ...process.env, HOME: account, WALNUT_HOME_OVERRIDE: account, OPEN_WALNUT_HOME: path.join(root, `${name}-walnut`),
        WALNUT_DAEMON_DIR: dir, WALNUT_DAEMON_PERSISTENT: '1', WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
        WALNUT_IN_PROCESS_DAEMON: inProcess, WALNUT_NET_NO_DOWNLOAD: '1', SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'),
      }
      for (const k of ['WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID', 'XDG_STATE_HOME']) delete env[k]
      return env
    }

    // ── 1. X's daemon program (what X's own start left running), and X's session on it ──
    let programOut = ''
    const program = spawn(BUN!, [STANDALONE, '--start'], { env: { ...envOf('x', '0'), WALNUT_DAEMON_KEEP_SESSIONS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    spawned.push(program)
    program.stderr!.on('data', (c) => { programOut = (programOut + c).slice(-4000) })
    const programExit = new Promise<number | null>((r) => program.once('exit', (code) => r(code)))
    await new Promise<void>((resolve, reject) => {
      let text = ''
      const t = setTimeout(() => reject(new Error(`the daemon program printed no port: ${programOut}`)), 30_000)
      program.stdout!.on('data', (c) => { text += c; if (/^\d+$/m.test(text)) { clearTimeout(t); resolve() } })
      program.once('exit', (code) => { clearTimeout(t); reject(new Error(`the daemon program exited ${code}: ${programOut}`)) })
    })
    const x = await startSessionSide(envOf('x', '0'), path.join(root, 'x-side'), spawned)
    const first = await x.call({ op: 'start' })
    expect(first, x.output()).toMatchObject({ ok: true, result: 'answer one', turns: 1 })
    const cli = Number(first.pid)
    clis.push({ pid: cli, root })

    // ── 2. Y boots with the runtime in process: the program is stopped, the dir is Y's ──────
    const y = await startSessionSide(envOf('y', '1'), path.join(root, 'y-side'), spawned)
    expect(await y.call({ op: 'ensure' }), y.output()).toMatchObject({ ok: true, inProcess: true })
    await Promise.race([programExit, new Promise((r) => setTimeout(r, 20_000))])
    expect(program.exitCode !== null || program.signalCode !== null, 'X\'s daemon program is stopped').toBe(true)
    expect(alive(cli), 'the CLI outlives the program').toBe(true)
    expect(await anotherServiceHolds(dir)).toEqual({ pid: y.pid, home: path.join(root, 'y-walnut') })

    // ── 3. X's next turn: its link to the stopped program is gone; it reaches the session where
    // the dir's daemon serves now (X's LocalDaemon reads daemon.port again): the same CLI, the same conversation.
    const again = await x.call({ op: 'attach', word: 'two' })
    expect(again, x.output()).toMatchObject({ ok: true, alive: true, pid: cli, written: true, result: 'answer two', turns: 2 })
    expect(await x.call({ op: 'round', word: 'three' })).toMatchObject({ ok: true, written: true, result: 'answer three', turns: 3 })

    // ── 4. A third server with the runtime in process: refused, naming Y ─────────────────
    const z = await startSessionSide(envOf('z', '1'), path.join(root, 'z-side'), spawned)
    const refused = await z.call({ op: 'ensure' })
    expect(refused.ok).toBe(false)
    expect(String(refused.error)).toMatch(new RegExp(`^Another Walnut server \\(pid ${y.pid}, data dir ${path.join(root, 'y-walnut')}\\) already runs the session daemon of ${dir} in its own process`))
    expect(String(refused.error)).toMatch(/stop it first, or start this one with a data dir and a daemon dir of its own \(OPEN_WALNUT_HOME and WALNUT_DAEMON_DIR/)
    // Y still holds the dir, and X's session still answers.
    expect(await anotherServiceHolds(dir)).toMatchObject({ pid: y.pid })
    expect(await x.call({ op: 'round', word: 'four' })).toMatchObject({ ok: true, result: 'answer four', turns: 4 })

    for (const side of [z, x, y]) { await side.call({ op: 'exit' }); await side.stop() }
  }, 180_000)
})
