/**
 * The sessions running on a machine whose server ran its daemon in its own process (experiment
 * `in_process_daemon`, the default) across a leader switch: real code paths end to end (the server's
 * LocalDaemon start, the runtime, the switch stop's daemon step, the handed-over standby's hold), only the
 * Claude CLI mocked. Each process of the machine is a process of its own (fixtures/switch-stop-sessions.ts):
 *
 *   1. A directory that keeps its sessions at a stop (the production one, /tmp/open-walnut; here the
 *      persistent switch that makes a temp dir behave so): the switch stop does not kill the CLI; until
 *      the next process takes the runtime nothing watches it; the standby the home boots into holds the
 *      runtime again, which adopts the same CLI and answers through the door the new leader dials; the
 *      standby's stop (a switch back, a rollback's leader start) keeps it; the leader after it adopts it again.
 *   2. An isolated dir (tests, sandbox): any stop ends its CLIs, the switch stop's too; nothing is left behind.
 *   3. A machine whose daemon is a program of its own (in_process_daemon off): the standby holds nothing
 *      (that program outlived the server).
 *
 * MACHINE SAFETY: everything lives in a temp root; the fixture signals nothing itself, and a CLI left
 * behind by a failed step is ended here only when its command line is the temp root's fake CLI.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../../../setup/exec-guard.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/switch-stop-sessions.ts')
const BUN = process.versions.bun ? process.execPath : null
const DROPPED_ENV = ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID', 'WALNUT_DAEMON_PERSISTENT', 'WALNUT_IN_PROCESS_DAEMON']
const roots: string[] = []
const cliPids: Array<{ pid: number; root: string }> = []

function alive(pid: number): boolean {
  if (pid <= 1) return false
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const st = s.slice(s.lastIndexOf(')') + 2)[0]; return st !== 'Z' && st !== 'X' } catch { return false }
}

afterAll(() => {
  for (const { pid, root } of cliPids) {
    let cmd = ''
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
    if (pid > 1 && alive(pid) && cmd.includes(root)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-stop-sessions-'))
  roots.push(root)
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const walnutHome = path.join(root, 'walnut-home')
  fs.mkdirSync(walnutHome, { recursive: true })
  // A data home with a file in it: the standby must leave it byte for byte.
  fs.writeFileSync(path.join(walnutHome, 'config.yaml'), 'experimental:\n  switchable_leader: true\n')
  const dir = path.join(root, 'd')
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      WALNUT_HOME_OVERRIDE: home,
      OPEN_WALNUT_HOME: walnutHome,
      WALNUT_DAEMON_DIR: dir,
      WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
      SHELL: '/bin/sh',
      PATH: guardedPath([], '/usr/bin:/bin'),
    }
    for (const k of DROPPED_ENV) delete e[k]
    return { ...e, ...extra }
  }
  const run = (phase: string, extra: Record<string, string>, ...rest: string[]) => new Promise<Record<string, any>>((resolve, reject) => {
    execFile(BUN!, [FIXTURE, root, phase, ...rest], { env: env(extra), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const line = String(stdout).trim().split('\n').pop() ?? ''
      // The phase's whole answer in the test output: an assertion below names one field, this says the rest.
      try { const r = JSON.parse(line); console.log(`${phase}: ${line}`); resolve(r) } catch { reject(new Error(`${phase}: no result (${error?.message ?? ''})\n${String(stderr).slice(-2000)}`)) }
    })
  })
  return { root, dir, run }
}

/** No daemon serves the dir: no door published, or nothing answers on it. */
async function noDaemonServes(dir: string): Promise<boolean> {
  let port = 0
  try { port = Number(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim()) } catch { return true }
  if (!port) return true
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }).then(() => false, () => true)
}

const ON = { WALNUT_IN_PROCESS_DAEMON: '1' }
const KEEP = { ...ON, WALNUT_DAEMON_PERSISTENT: '1' }

describe.skipIf(!BUN)('sessions of a machine whose daemon runs in its server, across a leader switch', () => {
  it('a dir that keeps its sessions: the switch stop keeps the CLI, the standby adopts it and serves it to the new leader, the leader after it adopts it again', async () => {
    const m = machine()
    const leader = await m.run('leader', KEEP, 'start')
    expect(leader.error, leader.error).toBeUndefined()
    expect(leader.inProcess).toBe(true)
    expect(leader.result).toBe('answer one')
    cliPids.push({ pid: leader.cliPid, root: m.root })
    // The switch stop ended the runtime with the server and did not kill the CLI.
    expect(leader.stopCode).toBe(0)
    expect(leader.inProcessAfterStop).toBe(false)
    expect(leader.cliAliveAtExit).toBe(true)
    expect(leader.registryHasSession).toBe(true)
    // Between that stop and the standby, nothing watches it: the CLI runs and no daemon serves the dir.
    expect(alive(leader.cliPid)).toBe(true)
    expect(await noDaemonServes(m.dir)).toBe(true)

    // The handed-over standby the home boots into holds the runtime again: the same CLI, adopted, and the
    // door the new leader dials (daemon.port) says the session exists; one round through it is answered.
    const standby = await m.run('standby', { ...KEEP, SWITCH_STOP_CLI_PID: String(leader.cliPid) }, '', leader.sid)
    expect(standby.error, standby.error).toBeUndefined()
    expect(standby.held).toBe(true)
    expect(standby.state).toEqual({ held: 'in-process', dir: m.dir })
    expect(standby.door).toMatchObject({ hello: true, exists: true, alive: true, pid: leader.cliPid })
    expect(standby.attached).toEqual({ alive: true, pid: leader.cliPid, result: 'answer standby' })
    // The standby's stop keeps the CLI, and its data home is as it was.
    expect(standby.inProcessAfterRelease).toBe(false)
    expect(standby.cliAliveAtExit).toBe(true)
    expect(standby.homeUnchanged).toBe(true)

    // The leader after it (a switch back, or a rollback's restart) adopts the same CLI. This last process
    // runs without the keep switch, so its stop ends the CLI as an isolated dir's stop does (the cleanup).
    const again = await m.run('leader', { ...ON, SWITCH_STOP_CLI_PID: String(leader.cliPid) }, 'adopt', leader.sid)
    expect(again.error, again.error).toBeUndefined()
    expect(again.adopted).toEqual({ alive: true, pid: leader.cliPid, result: 'answer again' })
    expect(again.cliAliveAtExit).toBe(false)
  }, 120_000)

  it('an isolated dir: the switch stop ends the CLI (nothing orphaned), and the standby holds a runtime with no session', async () => {
    const m = machine()
    const leader = await m.run('leader', ON, 'start')
    expect(leader.error, leader.error).toBeUndefined()
    cliPids.push({ pid: leader.cliPid, root: m.root })
    expect(leader.inProcess).toBe(true)
    expect(leader.stopCode).toBe(0)
    expect(leader.cliAliveAtExit).toBe(false)
    const standby = await m.run('standby', ON, '', leader.sid)
    expect(standby.error, standby.error).toBeUndefined()
    expect(standby.held).toBe(true)
    // Its record is known, as an ended session: nothing to adopt.
    expect(standby.door).toMatchObject({ hello: true, alive: false })
    expect(standby.attached).toBeUndefined()
  }, 120_000)

  it('a daemon program of its own (in_process_daemon off): the standby holds nothing', async () => {
    const m = machine()
    const standby = await m.run('standby', { WALNUT_IN_PROCESS_DAEMON: '0' }, '', 'no-session')
    expect(standby.error, standby.error).toBeUndefined()
    expect(standby.held).toBe(false)
    expect(standby.state).toMatchObject({ held: false })
    expect(String(standby.state.why)).toMatch(/program of its own/)
    expect(standby.inProcess).toBe(false)
    expect(standby.door.port).toBeNull()
    expect(standby.homeUnchanged).toBe(true)
  }, 60_000)
})
