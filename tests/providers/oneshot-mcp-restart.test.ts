/**
 * The host's session daemon restarts (SIGKILL, as a crash or a forced replace does) while
 * work it was doing for the server is in flight, on the daemon booted for real:
 *
 * - a one-shot model call ('oneshot-v1', oneshot-client.ts over a real DaemonConnection)
 *   ends with an error naming the dropped link within a few seconds of the kill, never at
 *   the run's own timeout, and the next one-shot on a fresh link to the new daemon runs;
 * - a host MCP call (host_mcp_call, src/core/hosts/host-mcp.ts, whose gate (caller, grant,
 *   dial) is stubbed here; the link, the daemon and the MCP server are real) fails at once
 *   saying the host was lost, the server it had started ends with it, and after a new
 *   daemon starts on the same dirs the next call starts the MCP server again and answers.
 *   The calls the restart lost read back as unknown and give their task's slots back.
 *
 * MACHINE SAFETY: HOME, the daemon dir and Walnut's home are temp paths; the model CLI is
 * tests/helpers/oneshot-fake-claude.cjs and the MCP server tests/fixtures/mcp/host-mcp-fake.cjs,
 * both run by node directly; signals go only to the daemons and children this file started.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-oneshot-mcp-restart'))

/** The link the stubbed dial hands out: the test points it at the daemon that runs now. */
let currentConn: unknown = null
vi.mock('../../src/core/hosts/host-exec.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/hosts/host-exec.js')>()
  return {
    ...real,
    callerOf: async () => ({ sid: 'sid-restart', taskId: 'task-restart', taskTitle: 'restart', host: '__local__' }),
    targetHost: async (h: string) => h,
    grantFor: async () => 'grant-restart',
    assertStillGranted: async () => 'grant-restart',
    dial: async () => currentConn,
  }
})
vi.mock('../../src/core/hosts/exec-grants.js', async (orig) => ({
  ...await orig<typeof import('../../src/core/hosts/exec-grants.js')>(),
  noteRun: async () => {},
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { _setOneShotDaemonForTest, _resetLocalOneShotForTest, startOneShot, type OneShotConn, type OneShotExit } from '../../src/providers/oneshot-client.js'
import { hostMcpCall, hostMcpResult, resetHostMcpForTest, MAX_CALLS_PER_TASK } from '../../src/core/hosts/host-mcp.js'
import { HostExecError } from '../../src/core/hosts/host-exec.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const FAKE_CLI = path.resolve(__dirname, '../helpers/oneshot-fake-claude.cjs')
const FAKE_MCP = path.resolve(__dirname, '../fixtures/mcp/host-mcp-fake.cjs')
/** A drop must settle the caller within this, far under any run or call timeout (15 s to 65 s here). */
const SETTLE_MS = 3_000

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-oneshot-mcp-restart-')))
afterAll(() => { if (root.includes('walnut-oneshot-mcp-restart-')) fs.rmSync(root, { recursive: true, force: true }) })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

const procs: ChildProcess[] = []
const conns: DaemonConnection[] = []
const childPids: number[] = []

afterEach(async () => {
  _setOneShotDaemonForTest(null)
  _resetLocalOneShotForTest()
  resetHostMcpForTest()
  currentConn = null
  for (const c of conns.splice(0)) { try { c.disconnect() } catch { /* closed */ } }
  for (const p of procs.splice(0)) await kill(p)
  for (const pid of childPids.splice(0)) {
    await waitFor(() => !isAlive(pid), 10_000).catch(() => { if (pid > 1) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  }
})

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in ' + ms + 'ms')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** SIGKILL a daemon this file started and wait for its exit. */
async function kill(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return
  const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); p.once('exit', () => { clearTimeout(t); r() }) })
  p.kill('SIGKILL')
  await exited
}

/** Start a daemon on `dir` (the same dir twice is a restart) and open a fresh link to it. */
async function boot(dir: string): Promise<{ proc: ChildProcess; conn: DaemonConnection; home: string }> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'), WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  const proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(proc)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  const conn = new DaemonConnection('__local__', null)
  conns.push(conn)
  await conn.connectDirect(`ws://127.0.0.1:${port}`)
  return { proc, conn, home }
}

/** Kill the daemon and time how long `settled` takes to settle after the kill. */
async function killAndTime<T>(proc: ChildProcess, settled: Promise<T>): Promise<{ ms: number; outcome: PromiseSettledResult<T> }> {
  const t0 = Date.now()
  proc.kill('SIGKILL')
  const outcome = (await Promise.allSettled([Promise.race([settled, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('still waiting after 20s')), 20_000))])]))[0]
  return { ms: Date.now() - t0, outcome }
}

describe.skipIf(!BUN)('standalone daemon (bun)', () => {
  it('a one-shot run in flight when the daemon dies ends at once with the dropped link; the next one runs on the new daemon', async () => {
    const dir = path.join(root, 'oneshot-standalone')
    const a = await boot(dir)
    expect(a.conn.hasCapability('oneshot-v1')).toBe(true)
    let link: DaemonConnection = a.conn
    _setOneShotDaemonForTest(() => link as unknown as OneShotConn)
    const env = { PATH: guardedPath([], '/usr/bin:/bin'), HOME: a.home }

    let exitA!: (e: OneShotExit) => void
    const exitedA = new Promise<OneShotExit>((r) => { exitA = r })
    // "hang": the fake CLI never answers, so only the link's loss can end this run.
    const hung = await startOneShot({ command: process.execPath, args: [FAKE_CLI, '-p'], cwd: a.home, env, input: 'hang', endInput: true, maxMs: 120_000 }, { onExit: (e) => exitA(e) })
    expect(hung.via).toBe('daemon')
    if (hung.pid) childPids.push(hung.pid)

    const { ms, outcome } = await killAndTime(a.proc, exitedA)
    console.log(`[oneshot-restart] standalone: run settled ${ms} ms after the daemon's SIGKILL`)
    expect(outcome.status).toBe('fulfilled')
    const exit = (outcome as PromiseFulfilledResult<OneShotExit>).value
    expect(exit).toMatchObject({ code: null, signal: null })
    expect(exit.error).toMatch(/link to the local daemon dropped/)
    expect(ms).toBeLessThan(SETTLE_MS)
    a.conn.disconnect()

    // A new daemon on the same dirs, a fresh link: the next run is the new daemon's child.
    const b = await boot(dir)
    link = b.conn
    const lines: string[] = []
    let exitB!: (e: OneShotExit) => void
    const exitedB = new Promise<OneShotExit>((r) => { exitB = r })
    const next = await startOneShot({ command: process.execPath, args: [FAKE_CLI, '-p'], cwd: b.home, env, input: 'after restart', endInput: true }, { onLine: (l) => lines.push(l), onExit: (e) => exitB(e) })
    expect(next.via).toBe('daemon')
    expect(await exitedB).toMatchObject({ code: 0 })
    const result = JSON.parse(lines.find((l) => l.includes('"result"'))!) as { result: string }
    expect(result.result.startsWith('reply:after restart')).toBe(true)
    const info = JSON.parse(result.result.slice(result.result.indexOf('{'))) as { ppid: number }
    expect(info.ppid).toBe(b.proc.pid)
  }, 120_000)

  it('a host MCP call in flight when the daemon dies fails at once; the next call starts the server again', async () => {
    const dir = path.join(root, 'mcp-standalone')
    const home = path.join(dir, 'home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP] } } }))
    const a = await boot(dir)
    expect(a.conn.hasCapability('host-mcp-v1')).toBe(true)
    currentConn = a.conn
    const pidOf = (text: unknown) => Number(/\(pid (\d+),/.exec(String(text))?.[1])

    const first = await hostMcpCall({ host: 'devbox', server: 'fake', tool: 'echo', arguments: { text: 'before' } }, 'sid-restart')
    expect(first).toMatchObject({ running: false, isError: false })
    const serverA = pidOf(first.text)
    expect(serverA).toBeGreaterThan(1)
    childPids.push(serverA)

    // Every slot of the task holds a call that would answer only after a minute.
    const inFlight = Array.from({ length: MAX_CALLS_PER_TASK }, () =>
      hostMcpCall({ host: 'devbox', server: 'fake', tool: 'slow', arguments: { ms: 60_000 } }, 'sid-restart'))
    await new Promise((r) => setTimeout(r, 500)) // the calls reached the daemon and the server
    const { ms, outcome } = await killAndTime(a.proc, Promise.all(inFlight.map((p) => p.then(() => null, (e: unknown) => e))))
    console.log(`[mcp-restart] standalone: ${MAX_CALLS_PER_TASK} calls settled ${ms} ms after the daemon's SIGKILL`)
    expect(outcome.status).toBe('fulfilled')
    const errors = (outcome as PromiseFulfilledResult<unknown[]>).value
    expect(ms).toBeLessThan(SETTLE_MS)
    const lostIds: string[] = []
    for (const err of errors) {
      expect(err).toBeInstanceOf(HostExecError)
      const e = err as HostExecError
      expect(e).toMatchObject({ status: 503, code: 'host_offline', data: { mayHaveStarted: true } })
      expect(e.message).toMatch(/Walnut lost devbox while it answered \(daemon command lost: mcp\.call: connection closed/)
      expect(e.message).toMatch(/read it with host_mcp_result/)
      lostIds.push(String(e.data.callId))
    }
    // The server the dead daemon started ends with it (its stdin closed), never an orphan.
    await waitFor(() => !isAlive(serverA), 10_000)
    a.conn.disconnect()

    const b = await boot(dir)
    currentConn = b.conn
    // The lost calls still count until read: the task was told to read them first.
    await expect(hostMcpCall({ host: 'devbox', server: 'fake', tool: 'echo', arguments: { text: 'too soon' } }, 'sid-restart'))
      .rejects.toMatchObject({ code: 'busy' })
    // Reading one back says the new daemon does not know it, and gives its slot back.
    for (const id of lostIds) {
      await expect(hostMcpResult({ host: 'devbox', call_id: id }, 'sid-restart')).rejects.toMatchObject({ status: 404, code: 'unknown_call' })
    }
    const after = await hostMcpCall({ host: 'devbox', server: 'fake', tool: 'echo', arguments: { text: 'after restart' } }, 'sid-restart')
    expect(after).toMatchObject({ running: false, isError: false })
    expect(String(after.text)).toContain('echo: after restart')
    const serverB = pidOf(after.text)
    childPids.push(serverB)
    expect(serverB).toBeGreaterThan(1)
    expect(serverB).not.toBe(serverA)
  }, 120_000)
})
