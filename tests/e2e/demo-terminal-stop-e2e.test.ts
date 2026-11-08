/**
 * Demo reset's terminal stop (src/commands/demo-terminals.ts stopDemoTerminals) against
 * a real dtach master and a real child, opened through a real server:
 *
 *   ws terminal:open -> dtach master (records its pid beside its socket) -> login shell
 *   -> terminal:input runs one fixed command of this file -> a child that prints its pid
 *   -> stopDemoTerminals(paths) probes the socket, tracks the master and its descendants
 *      by pid AND start time, TERMs the master through stopDtachMaster, and waits.
 *
 * What it pins:
 *  - a plain shell with its own child: the stop resolves only once the master, the
 *    shell and the child are all gone, and the socket and pid record are removed;
 *  - a child that ignores SIGHUP outlives its master: the stop refuses ("still
 *    stopping; data was kept") and the Demo data stays; once this file ends its own
 *    child (TERM to the pid and start time it recorded, re-checked in the same script)
 *    the stop is retried and resolves.
 *
 * Only the constants are mocked (no Claude CLI runs here). The socket dir is a short
 * scratch path under /tmp (dtach binds a unix socket, 104 bytes on macOS) laid out as
 * a Demo root, so DemoPaths.daemon is the socket dir's own parent and no real account,
 * production dir or daemon is touched. dtach comes from the repo's own provisioning;
 * a missing dtach fails the file. Every signal here goes to a pid this file recorded,
 * re-checked against its start time: no pattern kill, no SIGKILL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('../../src/constants.js', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const { createMockConstants } = await import('../helpers/mock-constants.js')
  const { demoTerminalDir } = await import('../../src/lib/demo-terminal-dir.js')
  const scratch = nodeFs.realpathSync(nodeFs.mkdtempSync('/tmp/wdte-'))
  fixture.root = nodePath.join(scratch, 'open-walnut-demo')
  return createMockConstants('walnut-e2e-demo-terminal-stop', { DTACH_SOCKET_DIR: demoTerminalDir(fixture.root, 'g') })
})

import { WALNUT_HOME, DTACH_SOCKET_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { dtachSocketPath, dtachPidPath } from '../../src/web/terminal/spawn.js'
import { localDtachPath } from '../../src/web/terminal/dtach-provision.js'
import { localShellRunner, START_FN, stopDtachMaster } from '../../src/web/terminal/dtach-master.js'
import { demoPaths, prepareDemoHome, type DemoPaths } from '../../src/commands/demo-home.js'
import { removeDemoTerminalDir } from '../../src/lib/demo-terminal-dir.js'
import { stopDemoTerminals } from '../../src/commands/demo-terminals.js'

const DEMO_ROOT = fixture.root
const SCRATCH = path.dirname(DEMO_ROOT)
const EXIT_SID = 'demo-stop-exit'
const HUP_SID = 'demo-stop-hup'

interface Proc { pid: number; start: string }

let server: HttpServer
let serverUp = false
let port = 0
let savedShell: string | undefined
let paths: DemoPaths
let sentinel = ''
/** Every process this file came to know (masters, shells, children), by pid and start time. */
const tracked: Proc[] = []

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

  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpExecArray> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const m = pattern.exec(this.output)
      if (m) return m
      if (Date.now() > deadline) throw new Error(`no ${pattern} in terminal output: ${JSON.stringify(this.output.slice(-600))}`)
      await sleep(50)
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

function safePid(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error(`refusing pid ${pid}`)
  return pid
}

/** A pid's start time in the product's own form, '' when it is gone. */
async function startOf(pid: number): Promise<string> {
  return (await localShellRunner(`${START_FN}\nwalnut_st ${safePid(pid)}`)).stdout.trim()
}

/** Alive and not a zombie. */
function running(pid: number): Promise<boolean> {
  return new Promise((resolve) => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (err, out) => resolve(!err && !!out.trim() && !out.trim().startsWith('Z'))))
}

/** Still the process this file recorded: running with the same start time. */
async function same(p: Proc): Promise<boolean> {
  return (await running(p.pid)) && (await startOf(p.pid)) === p.start
}

function ppidOf(pid: number): Promise<number> {
  return new Promise((resolve) => execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, out) => resolve(err ? 0 : Number(out.trim()))))
}

async function track(pid: number): Promise<Proc> {
  const p = { pid: safePid(pid), start: await startOf(pid) }
  expect(p.start, `start time of ${pid}`).toMatch(/^(?:proc|ps):\S/)
  tracked.push(p)
  return p
}

/** TERM one recorded process, only while its start time is still the recorded one. */
async function termOwn(p: Proc): Promise<boolean> {
  const script = `${START_FN}\nif [ "$(walnut_st ${safePid(p.pid)})" = ${q(p.start)} ]; then kill -TERM ${p.pid} 2>/dev/null && echo SIGNALLED; else echo CHANGED; fi`
  return /^SIGNALLED$/m.test((await localShellRunner(script)).stdout)
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/**
 * Open a terminal and run `command` in it; the command prints `<tag>:<its pid>`.
 * Returns the master, the login shell and the child, each checked to be the
 * other's parent, so every pid this file may signal is its own.
 */
async function terminalWithChild(sid: string, tag: string, command: string): Promise<{ client: Client; master: Proc; shell: Proc; child: Proc }> {
  const client = await Client.connect()
  const opened = await client.open(sid)
  expect(opened.persistent, 'dtach must be available for this test').toBe(true)
  await until('the pid record', () => fs.existsSync(dtachPidPath(sid)))
  const master = await track(Number(fs.readFileSync(dtachPidPath(sid), 'utf8').split('\n')[0]))
  expect(fs.readFileSync(dtachPidPath(sid), 'utf8').split('\n')[1]).toBe(master.start)
  await client.input(`${command}\r`)
  const m = await client.waitFor(new RegExp(`${tag}:(\\d+)`))
  const child = await track(Number(m[1]))
  const shellPid = await ppidOf(child.pid)
  expect(await ppidOf(shellPid)).toBe(master.pid)
  const shell = await track(shellPid)
  return { client, master, shell, child }
}

beforeAll(async () => {
  savedShell = process.env.SHELL
  process.env.SHELL = '/bin/sh' // a login zsh in an empty HOME stops at its first-run menu
  // The repo's own provisioning; a host where it cannot get dtach fails here, never skips.
  await localDtachPath()
  paths = demoPaths(DEMO_ROOT, 'g')
  expect(paths.terminals).toBe(DTACH_SOCKET_DIR)
  await prepareDemoHome(paths)
  sentinel = path.join(paths.data, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'demo-data-kept')
  await fs.promises.mkdir(WALNUT_HOME, { recursive: true })
  for (const sid of [EXIT_SID, HUP_SID]) {
    const cwd = path.join(WALNUT_HOME, 'work', sid)
    await fs.promises.mkdir(cwd, { recursive: true })
    await createSessionRecord(sid, `task-${sid}`, '', cwd)
  }
  server = await startServer({ port: 0, dev: true })
  serverUp = true
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  // End only what this file started and a failed case left: its children by recorded
  // identity, its masters through the guard.
  for (const p of [...tracked].reverse()) if (await same(p)) await termOwn(p)
  for (const sid of [EXIT_SID, HUP_SID]) {
    const sock = dtachSocketPath(sid)
    if (fs.existsSync(sock)) await stopDtachMaster(localShellRunner, sock).catch(() => {})
  }
  if (serverUp) await stopServer()
  const left: number[] = []
  for (const p of tracked) {
    const gone = await until(`pid ${p.pid} to exit`, async () => !(await same(p)), 10_000).then(() => true, () => false)
    if (!gone) left.push(p.pid)
  }
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
  if (left.length) throw new Error(`processes of this file still run (${left.join(', ')}); kept ${SCRATCH}`)
  if (paths) await removeDemoTerminalDir(paths.terminals, paths.data)
  fs.rmSync(SCRATCH, { recursive: true, force: true })
}, 60_000)

describe('stopDemoTerminals on a real dtach master and child', () => {
  it('a plain shell and its own child: the stop resolves once master, shell and child are gone', async () => {
    const sock = dtachSocketPath(EXIT_SID)
    const { client, master, shell, child } = await terminalWithChild(EXIT_SID, 'own-child',
      `/bin/sh -c 'echo "own-child:$$"; exec sleep 600'`)
    for (const p of [master, shell, child]) expect(await same(p)).toBe(true)
    client.ws.close()

    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    for (const p of [master, shell, child]) expect(await same(p), `pid ${p.pid}`).toBe(false)
    expect(fs.existsSync(sock)).toBe(false)
    expect(fs.existsSync(dtachPidPath(EXIT_SID))).toBe(false)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('demo-data-kept')
  }, 120_000)

  it('a child that ignores SIGHUP: the stop refuses and keeps the data; after its own TERM a retry resolves', async () => {
    const { client, master, shell, child } = await terminalWithChild(HUP_SID, 'hup-child',
      `/bin/sh -c 'trap "" HUP; echo "hup-child:$$"; exec sleep 600'`)
    for (const p of [master, shell, child]) expect(await same(p)).toBe(true)
    client.ws.close()

    await expect(stopDemoTerminals(paths)).rejects.toThrow(/still stopping; data was kept/)
    expect(await same(master)).toBe(false) // the master got its TERM
    expect(await same(shell)).toBe(false) // the shell went with the hangup
    expect(await same(child)).toBe(true) // the child ignored it and still runs as itself
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('demo-data-kept')
    expect(fs.existsSync(path.join(paths.data, 'demo-terminal-stop.json'))).toBe(true)
    await expect(stopDemoTerminals(paths)).rejects.toThrow(/still stopping; data was kept/)
    expect(await same(child)).toBe(true)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('demo-data-kept')

    // This file ends its own child, by the pid and start time it recorded.
    expect(await termOwn(child)).toBe(true)
    await until('the child to exit', async () => !(await same(child)))
    await expect(stopDemoTerminals(paths)).resolves.toBeUndefined()
    expect(fs.existsSync(dtachSocketPath(HUP_SID))).toBe(false)
    expect(fs.existsSync(path.join(paths.data, 'demo-terminal-stop.json'))).toBe(false)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('demo-data-kept')
  }, 120_000)
})
