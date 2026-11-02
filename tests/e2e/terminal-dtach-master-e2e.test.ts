/**
 * A persistent terminal's dtach master through a real server, ended by the pid
 * it recorded and never by a pattern (src/web/terminal/dtach-master.ts).
 *
 *   ws terminal:open -> spawn (`<dtach> -A <socket> ... /bin/sh -c <record> <shell>`)
 *   -> the record names the master -> reattach -> terminal:kill -> SIGTERM to
 *   that proved pid only.
 *
 * What it pins, on a real pty and a real dtach build:
 *  - a new terminal records its master's pid and start time beside its socket,
 *    the foreground check walks from that master, and a reattach keeps it;
 *  - a master an older Walnut started (no record) still reattaches through the
 *    server and is ended through its socket's owner;
 *  - the ephemeral server's exit path (removeEphemeralRuntimeDirs on its runtime
 *    dir) ends the masters of its terminals;
 *  - in every case a shell whose command line only names the socket (which the
 *    old `pkill -f <socket>` signalled) is left running.
 *
 * The socket dir is a short path under /tmp shaped like an ephemeral runtime dir
 * (`open-walnut-eph-<n>-<six>/term`), so dtach can bind it (104-byte limit on
 * macOS) and the exit path accepts it. Every process here is started by this
 * file and ended through the code under test or the handle it holds.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'

vi.mock('../../src/constants.js', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const { createMockConstants } = await import('../helpers/mock-constants.js')
  const root = nodeFs.mkdtempSync('/tmp/wdme-')
  return createMockConstants('walnut-e2e-dtach-master', { DTACH_SOCKET_DIR: nodePath.join(root, 'open-walnut-eph-1-E2eAbC', 'term') })
})

import { WALNUT_HOME, DTACH_SOCKET_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { hasForegroundProcess } from '../../src/web/terminal/dtach-lifecycle.js'
import { dtachSocketPath, dtachPidPath } from '../../src/web/terminal/spawn.js'
import { localDtachPath } from '../../src/web/terminal/dtach-provision.js'
import { chooseDtachMaster, dtachProbeScript, localShellRunner, parseDtachProbe, stopDtachMaster } from '../../src/web/terminal/dtach-master.js'
import { removeEphemeralRuntimeDirs } from '../../src/commands/ephemeral-registry.js'
import { loadPty, type Pty } from '../../src/lib/pty.js'

const RUNTIME_DIR = path.dirname(DTACH_SOCKET_DIR)
const NEW_SID = 'dtach-e2e-new'
const OLD_SID = 'dtach-e2e-old'
const EXIT_SID = 'dtach-e2e-exit'

let server: HttpServer
let serverUp = false
let port = 0
let savedShell: string | undefined
const bystanders: ChildProcess[] = []
const ptys: Pty[] = []

interface Frame { type: string; id?: string; ok?: boolean; payload?: Record<string, unknown>; error?: string; name?: string; data?: Record<string, unknown> }

class Client {
  output = ''
  private terminalId = ''
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.type === 'event' && this.terminalId && frame.name === `terminal:data:${this.terminalId}`) this.output += String(frame.data?.data ?? '')
    })
  }

  static async connect(): Promise<Client> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://localhost:${port}/ws`)
      s.on('open', () => resolve(s))
      s.on('error', reject)
    })
    return new Client(ws)
  }

  rpc(method: string, payload: unknown): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const id = `t-${Math.random().toString(36).slice(2)}`
      const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 30_000)
      const onMessage = (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as Frame
        if (frame.type !== 'res' || frame.id !== id) return
        clearTimeout(timer)
        this.ws.off('message', onMessage)
        resolve(frame)
      }
      this.ws.on('message', onMessage)
      this.ws.send(JSON.stringify({ type: 'req', id, method, payload }))
    })
  }

  async open(sessionId: string): Promise<Record<string, unknown>> {
    this.terminalId = sessionId
    const res = await this.rpc('terminal:open', { sessionId, cols: 100, rows: 30 })
    expect(res.ok, res.error).toBe(true)
    expect(res.payload?.ok, JSON.stringify(res.payload)).toBe(true)
    return res.payload ?? {}
  }

  async input(data: string): Promise<void> {
    const res = await this.rpc('terminal:input', { terminalId: this.terminalId, data })
    expect(res.ok, res.error).toBe(true)
  }

  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!pattern.test(this.output)) {
      if (Date.now() > deadline) throw new Error(`no ${pattern} in terminal output: ${JSON.stringify(this.output.slice(-600))}`)
      await sleep(50)
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null

function running(pid: number): Promise<boolean> {
  return new Promise((resolve) => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (err, out) => resolve(!err && !!out.trim() && !out.trim().startsWith('Z'))))
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** The proved master(s) of a socket, read through the guard's own probe. */
async function mastersOf(sock: string): Promise<{ pids: number[]; source: string }> {
  const choice = chooseDtachMaster(parseDtachProbe((await localShellRunner(dtachProbeScript(sock))).stdout), sock)
  return { pids: choice.targets.map((t) => t.pid), source: choice.source }
}

/** A shell started here whose command line names `target` (what `pkill -f <socket>` matched). */
function bystander(target: string): ChildProcess {
  const c = spawn('/bin/sh', ['-c', `ls ${target} >/dev/null 2>&1; sleep 30; exit 0`, 'sh', '-A', target], { stdio: 'ignore' })
  bystanders.push(c)
  return c
}

beforeAll(async () => {
  savedShell = process.env.SHELL
  process.env.SHELL = '/bin/sh' // a login zsh in an empty HOME stops at its first-run menu
  await fs.promises.mkdir(WALNUT_HOME, { recursive: true })
  for (const sid of [NEW_SID, OLD_SID, EXIT_SID]) {
    const cwd = path.join(WALNUT_HOME, 'work', sid)
    await fs.promises.mkdir(cwd, { recursive: true })
    await createSessionRecord(sid, `task-${sid}`, '', cwd)
  }
  server = await startServer({ port: 0, dev: true })
  serverUp = true
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 90_000)

afterAll(async () => {
  for (const p of ptys) { try { p.kill() } catch { /* gone */ } }
  // Masters outlive the server by design: end what a failed case left, through the guard.
  for (const sid of [NEW_SID, OLD_SID, EXIT_SID]) {
    const sock = dtachSocketPath(sid)
    if (fs.existsSync(sock)) await stopDtachMaster(localShellRunner, sock).catch(() => {})
  }
  if (serverUp) await stopServer()
  for (const c of bystanders) if (alive(c)) c.kill('SIGKILL')
  fs.rmSync(path.dirname(RUNTIME_DIR), { recursive: true, force: true })
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
}, 60_000)

describe('a terminal\'s dtach master is ended by its recorded pid', () => {
  it('records its master, reattaches it, and End terminal stops only that master', async () => {
    const sock = dtachSocketPath(NEW_SID)
    const client = await Client.connect()
    const opened = await client.open(NEW_SID)
    expect(opened.persistent, 'dtach must be available for this test').toBe(true)
    await client.input('echo walnut-$((6*7))\r')
    await client.waitFor(/walnut-42/)

    // The record names the socket's own master, by pid and start time.
    await until('the pid record', () => fs.existsSync(dtachPidPath(NEW_SID)))
    const [pidLine, startLine] = fs.readFileSync(dtachPidPath(NEW_SID), 'utf8').split('\n')
    const master = Number(pidLine)
    expect(startLine).toMatch(/^(?:proc|ps):\S/)
    expect(await mastersOf(sock)).toEqual({ pids: [master], source: 'recorded' })
    const naming = bystander(sock)

    // The foreground check walks from that master.
    expect(await hasForegroundProcess({ claudeSessionId: NEW_SID })).toBe(false)
    await client.input('sleep 30\r')
    await until('a foreground sleep', () => hasForegroundProcess({ claudeSessionId: NEW_SID }))
    await client.input('\x03')
    await until('the shell to be idle again', async () => !(await hasForegroundProcess({ claudeSessionId: NEW_SID })))

    // A reattach from a new connection: same master, scrollback replayed.
    client.ws.close()
    const again = await Client.connect()
    await again.open(NEW_SID)
    await again.waitFor(/walnut-42/)
    expect(Number(fs.readFileSync(dtachPidPath(NEW_SID), 'utf8').split('\n')[0])).toBe(master)
    expect(await running(master)).toBe(true)

    // End terminal.
    const killed = await again.rpc('terminal:kill', { terminalId: NEW_SID })
    expect(killed.ok, killed.error).toBe(true)
    await until('the master to exit', async () => !(await running(master)))
    expect(fs.existsSync(sock)).toBe(false)
    expect(fs.existsSync(dtachPidPath(NEW_SID))).toBe(false)
    await sleep(300)
    expect(alive(naming)).toBe(true)
    again.ws.close()
  }, 120_000)

  it('a master an older Walnut started (no record) reattaches through the server and is ended through its socket owner', async () => {
    const sock = dtachSocketPath(OLD_SID)
    // The argv an older Walnut gave dtach: the login shell directly, no record.
    const dtachBin = await localDtachPath()
    fs.mkdirSync(DTACH_SOCKET_DIR, { recursive: true })
    const pty = (await loadPty()).spawn(dtachBin, ['-A', sock, '-z', '-E', '-r', 'winch', '/bin/sh', '-l'],
      { name: 'xterm-256color', cols: 100, rows: 30, cwd: WALNUT_HOME, env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> })
    ptys.push(pty)
    await until('the old master\'s socket', () => fs.existsSync(sock))
    pty.write('echo old-$((1+2))\r')
    await sleep(500)
    pty.kill() // the old server's attach client goes away; the master stays
    const old = await mastersOf(sock)
    expect(old.source).toBe('socket-owner')
    expect(old.pids).toHaveLength(1)
    expect(fs.existsSync(dtachPidPath(OLD_SID))).toBe(false)
    const naming = bystander(sock)

    const client = await Client.connect()
    await client.open(OLD_SID)
    await client.input('echo again-$((2+3))\r')
    await client.waitFor(/again-5/)
    expect(await mastersOf(sock)).toEqual(old) // the same master, reattached

    const killed = await client.rpc('terminal:kill', { terminalId: OLD_SID })
    expect(killed.ok, killed.error).toBe(true)
    await until('the old master to exit', async () => !(await running(old.pids[0]!)))
    expect(fs.existsSync(sock)).toBe(false)
    await sleep(300)
    expect(alive(naming)).toBe(true)
    client.ws.close()
  }, 120_000)

  it('the ephemeral exit path ends the masters of its runtime dir, and nothing that only names it', async () => {
    const client = await Client.connect()
    await client.open(EXIT_SID)
    await client.input('echo exit-$((3+4))\r')
    await client.waitFor(/exit-7/)
    await until('the pid record', () => fs.existsSync(dtachPidPath(EXIT_SID)))
    const master = Number(fs.readFileSync(dtachPidPath(EXIT_SID), 'utf8').split('\n')[0])
    const naming = bystander(dtachSocketPath(EXIT_SID))
    client.ws.close()

    // What the ephemeral server does on exit: stop serving, then remove its runtime dir.
    await stopServer()
    serverUp = false
    expect(await running(master)).toBe(true) // a master outlives its server by design
    await removeEphemeralRuntimeDirs(RUNTIME_DIR)
    await until('the master to exit', async () => !(await running(master)))
    expect(fs.existsSync(RUNTIME_DIR)).toBe(false)
    await sleep(300)
    expect(alive(naming)).toBe(true)
  }, 120_000)
})
