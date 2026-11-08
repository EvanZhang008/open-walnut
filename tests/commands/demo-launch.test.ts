/**
 * `walnut demo` / `walnut demo reset` (runDemo in src/commands/demo.ts), run for real
 * against a temp Demo root with the real state file, real prepare/clear and the real
 * withFileLock. Only the edges are fakes: the OS account (a temp home), spawn (an
 * EventEmitter child that writes its state like the real child), the port probe, fetch
 * (the child's control channel and /api/config) and process.kill, which answers only
 * signal 0 from a table of live pids and fails the test on any other signal.
 *
 * Pinned: a launch is idempotent and spawns once even when two run at the same time;
 * reset clears only after the server answered `stopped` AND its pid is gone (ESRCH),
 * then starts a new generation; an occupied port is refused with no signal and no
 * deletion; every failure or refusal keeps the data and never prints Ready.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const m = vi.hoisted(() => ({
  homedir: '',
  spawn: vi.fn(),
  createServer: vi.fn(),
  prepare: vi.fn(),
  clear: vi.fn(),
}))

vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: m.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))
// The process sweep before clearing reads the real process table; it has its own tests.
const sweep = vi.hoisted(() => ({ assert: vi.fn(), report: vi.fn() }))
vi.mock('../../src/commands/demo-residual-processes.js', async (orig) => ({
  assertNoDemoResidualProcesses: sweep.assert, sweepDemoResidualProcesses: sweep.report,
  // The verdict on a look already taken is the real one: it reads only the report it is given.
  assertResidualReportClean: (await orig<typeof import('../../src/commands/demo-residual-processes.js')>()).assertResidualReportClean,
}))
const sweepReport = (r: Record<string, unknown> = {}) => ({ supported: true, complete: true, matched: 0, unknown: 0, why: { envHidden: 0, cwdUnreadable: 0, unreadable: 0, raced: 0 }, ...r })
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, default: { ...actual, spawn: m.spawn }, spawn: m.spawn }
})
vi.mock('../../src/commands/demo-home.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/commands/demo-home.js')>()
  return { ...actual, prepareDemoHome: m.prepare, clearDemoHome: m.clear }
})
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, default: { ...actual, createServer: m.createServer }, createServer: m.createServer }
})

// Pass-through: every test runs the real runDemo unless the command-registration guard
// below installs a stand-in for one test.
const demoStub = vi.hoisted(() => ({ runDemo: null as null | ((...args: unknown[]) => Promise<void>) }))
vi.mock('../../src/commands/demo.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/commands/demo.js')>()
  return { ...actual, runDemo: (...args: Parameters<typeof actual.runDemo>) => (demoStub.runDemo ?? actual.runDemo)(...args) }
})

import { Command } from 'commander'
import { registerCommands } from '../../src/commands/index.js'
import { runDemo } from '../../src/commands/demo.js'
import { DEMO_PORT, DEMO_URL, demoPaths } from '../../src/commands/demo-home.js'
import { removeDemoTerminalDir } from '../../src/lib/demo-terminal-dir.js'
const processIdentity = vi.hoisted(() => ({ starts: new Map<number, string>() }))
vi.mock('../../src/commands/demo-process.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/commands/demo-process.js')>('../../src/commands/demo-process.js')
  return { ...actual, demoProcessStart: async () => 'proc:123456', demoServerGroupGone: async (state: { pid: number; startTime?: string }) => {
    try { process.kill(state.pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
    return state.startTime !== undefined && state.startTime !== processIdentity.starts.get(state.pid)
  } }
})

type Behavior = 'ready' | 'failed' | 'exit' | 'silent'
interface FakeServer {
  state: { v: 1; generation: string; token: string; controlPort: number; pid: number; status: string; error?: string }
  reply: Record<string, unknown>
  down: boolean
  /** What POST /stop does. */
  onStop: 'stop-and-exit' | 'stop-stay-alive' | 'refuse'
}

let base: string
let root: string
let stateFile: string
let alive: Set<number>
let servers: Map<number, FakeServer>
let behavior: Behavior
let onStop: FakeServer['onStop']
let portBusy: boolean
let configStatus: number
let nextPid: number
let nextPort: number
let signals: Array<[number, unknown]>
let logs: string[]
let killHook: (() => void) | null
const sims: Array<Promise<void>> = []

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function writeState(value: unknown): void {
  const temp = `${stateFile}.sim-${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(temp, JSON.stringify(value))
  fs.renameSync(temp, stateFile)
}

function readState(): FakeServer['state'] {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

/** Plays the real child: waits for the launcher's `starting` marker, then reports. */
async function simulateChild(child: EventEmitter & { pid: number; exitCode: number | null }, env: NodeJS.ProcessEnv): Promise<void> {
  const token = env.WALNUT_DEMO_TOKEN!
  const generation = env.WALNUT_DEMO_GENERATION!
  for (let i = 0; i < 500; i++) {
    try { if (readState().token === token && readState().pid === child.pid) break } catch { /* not written yet */ }
    await sleep(5)
  }
  if (behavior === 'silent') return
  if (behavior === 'exit') {
    child.exitCode = 1
    alive.delete(child.pid)
    child.emit('exit', 1, null)
    return
  }
  const controlPort = nextPort++
  const state = {
    v: 1 as const, generation, token, controlPort, pid: child.pid,
    status: behavior === 'ready' ? 'ready' : 'failed',
    ...(behavior === 'failed' ? { error: 'Demo startup failed: boom' } : {}),
  }
  servers.set(controlPort, { state, reply: {}, down: behavior !== 'ready', onStop })
  writeState(state)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function fakeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input)
  if (url === `${DEMO_URL}/api/config`) return json({}, configStatus)
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/(status|stop|exit)$/.exec(url)
  if (!match) throw new Error(`test fetch refused: ${url}`)
  const server = servers.get(Number(match[1]))
  if (!server || server.down) throw new TypeError('fetch failed')
  if ((init.headers as Record<string, string>)['x-walnut-demo-token'] !== server.state.token) return new Response(null, { status: 403 })
  if (match[2] === 'status') {
    if (init.method !== 'GET') return new Response(null, { status: 404 })
    return json({ ...server.state, ...server.reply })
  }
  if (init.method !== 'POST') return new Response(null, { status: 404 })
  if (match[2] === 'exit') {
    if (server.state.status !== 'failed') return json({ ...server.state, error: 'Only a Demo whose stop failed exits this way' }, 409)
    alive.delete(server.state.pid); server.down = true
    return json(server.state)
  }
  if (server.onStop === 'refuse') {
    server.state = { ...server.state, status: 'failed', error: 'Demo session did not confirm its stop; data was kept' }
    return json(server.state, 409)
  }
  server.state = { ...server.state, status: 'stopped' }
  if (server.onStop === 'stop-and-exit') { alive.delete(server.state.pid); server.down = true }
  return json({ ...server.state, ...server.reply })
}

beforeEach(async () => {
  const actualHome = await vi.importActual<typeof import('../../src/commands/demo-home.js')>('../../src/commands/demo-home.js')
  m.prepare.mockReset().mockImplementation(actualHome.prepareDemoHome)
  m.clear.mockReset().mockImplementation(actualHome.clearDemoHome)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-launch-')))
  m.homedir = path.join(base, 'home')
  fs.mkdirSync(m.homedir)
  root = path.join(m.homedir, '.local', 'share', 'open-walnut-demo')
  stateFile = path.join(root, 'state.json')
  alive = new Set()
  servers = new Map()
  behavior = 'ready'
  onStop = 'stop-and-exit'
  portBusy = false
  configStatus = 200
  nextPid = 70001
  nextPort = 41001
  signals = []
  logs = []
  sweep.assert.mockReset().mockResolvedValue(undefined)
  sweep.report.mockReset().mockResolvedValue(sweepReport())
  killHook = null
  sims.length = 0
  processIdentity.starts.clear()
  processIdentity.starts.set(process.pid, 'proc:123456')
  m.prepare.mockClear()

  m.spawn.mockReset()
  m.spawn.mockImplementation((_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), {
      pid: nextPid++, exitCode: null as number | null, signalCode: null, unref: vi.fn(),
    })
    alive.add(child.pid)
    sims.push(simulateChild(child, options.env))
    return child
  })
  m.createServer.mockReset()
  m.createServer.mockImplementation(() => {
    const probe = new EventEmitter() as EventEmitter & { listen: Function; close: Function }
    probe.listen = (_port: number, _host: string, cb: () => void) => {
      queueMicrotask(() => portBusy ? probe.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' })) : cb())
      return probe
    }
    probe.close = (cb: (error?: Error) => void) => { queueMicrotask(() => cb()); return probe }
    return probe
  })
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    signals.push([pid, signal])
    if (signal !== 0) throw new Error(`test refuses signal ${String(signal)} to ${pid}`)
    killHook?.()
    if (pid === process.pid || alive.has(pid)) return true
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  }) as typeof process.kill)
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
})

afterEach(async () => {
  demoStub.runDemo = null
  await Promise.allSettled(sims)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // No path may signal anything but the liveness probe.
  expect(signals.every(([, signal]) => signal === 0)).toBe(true)
  const data = path.join(root, 'data')
  if (fs.existsSync(data)) for (const generation of fs.readdirSync(data)) {
    const paths = demoPaths(root, generation)
    await removeDemoTerminalDir(paths.terminals, paths.data)
  }
  fs.rmSync(base, { recursive: true, force: true })
})

const launch = () => runDemo(undefined, { _headless: true })
const reset = () => runDemo('reset', { _headless: true })
const homeOf = (generation: string) => demoPaths(root, generation).home
const ready = () => logs.some(line => line.includes('Ready'))
const RESET_LINES = [
  'Stopping demo sessions... [████████████████████] Done',
  'Clearing demo data...     [████████████████████] Done',
  'Starting a fresh demo...  [████████████████████] Ready',
  `Walnut Demo is at ${DEMO_URL}. This is a new-user first run.`,
  'Your real Walnut and data are unchanged.',
]
const KEPT_LINE = {
  unknown: 'Clearing demo data...     Kept for now: a background process could not be checked. A later reset clears it.',
  unread: 'Clearing demo data...     Kept for now: this computer was too busy to list its processes in time. A later reset clears it.',
}
/** The generation each clearDemoHome call was given, in order. */
const clearedGenerations = () => m.clear.mock.calls.map(([paths]) => path.basename((paths as { home: string }).home))

function plant(generation: string): string {
  const marker = path.join(demoPaths(root, generation).data, 'tasks.json')
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, 'keep')
  return marker
}

describe('runDemo launch', () => {
  it('starts one isolated child, waits for its proof and the first-run page', async () => {
    await launch()
    expect(m.spawn).toHaveBeenCalledTimes(1)
    const [file, args, options] = m.spawn.mock.calls[0] as [string, string[], { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }]
    expect(file).toBe(process.execPath)
    expect(args.slice(-3)).toEqual(['demo', '--_child', '--_ephemeral-child'])
    const state = readState()
    expect(state.status).toBe('ready')
    expect(options.cwd).toBe(homeOf(state.generation))
    expect(options.env.HOME).toBe(homeOf(state.generation))
    expect(options.env.WALNUT_DEMO_TOKEN).toBe(state.token)
    expect(options.env.WALNUT_DEMO_RECOVER).toBeUndefined()
    expect(options.detached).toBe(true)
    expect(fs.readFileSync(path.join(demoPaths(root, state.generation).data, 'config.yaml'), 'utf8')).toContain('auto: false')
    expect(vi.mocked(fetch).mock.calls.map(call => String(call[0]))).toContain(`${DEMO_URL}/api/config`)
    expect(m.createServer).toHaveBeenCalledTimes(1)
    expect(ready()).toBe(true)
  })

  it('keeps a starting identity before prepare; after an interrupted launcher exits it recovers the same files', async () => {
    const prepare = m.prepare.getMockImplementation()!
    m.prepare.mockImplementationOnce(async paths => {
      expect(readState()).toMatchObject({ pid: process.pid, controlPort: 0, status: 'starting', startTime: 'proc:123456' })
      await prepare(paths)
      throw new Error('Interrupted before spawn')
    })
    await expect(launch()).rejects.toThrow('Interrupted before spawn')
    const first = readState()
    const marker = plant(first.generation)
    expect(m.spawn).not.toHaveBeenCalled()
    expect(ready()).toBe(false)
    await expect(launch()).rejects.toThrow('fetch failed')
    expect(m.spawn).not.toHaveBeenCalled()
    processIdentity.starts.set(process.pid, 'proc:123457')
    await launch()
    expect(readState()).toMatchObject({ generation: first.generation, status: 'ready' })
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
    expect(m.spawn.mock.calls[0][2].env.WALNUT_DEMO_RECOVER).toBe('1')
  })

  it('is idempotent: a second launch proves the running child and spawns nothing', async () => {
    await launch()
    const first = readState()
    await launch()
    expect(m.spawn).toHaveBeenCalledTimes(1)
    expect(readState()).toEqual(first)
  })

  it('two launches at once spawn exactly one child', async () => {
    await Promise.all([launch(), launch()])
    expect(m.spawn).toHaveBeenCalledTimes(1)
    expect(readState().status).toBe('ready')
  })

  it('refuses an occupied port: no spawn, no signal, no deletion', async () => {
    portBusy = true
    await expect(launch()).rejects.toThrow(new RegExp(`Port ${DEMO_PORT} is in use`))
    expect(m.spawn).not.toHaveBeenCalled()
    expect(signals).toEqual([])
    expect(fs.existsSync(stateFile)).toBe(false)
    expect(ready()).toBe(false)
  })

  it('refuses an occupied port after a stopped Demo and keeps its data', async () => {
    await launch()
    const { generation } = readState()
    const marker = plant(generation)
    writeState({ ...readState(), status: 'stopped' })
    alive.clear()
    portBusy = true
    await expect(launch()).rejects.toThrow(/is in use/)
    expect(m.spawn).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
  })

  it('keeps data and never says Ready when the child reports failed after its marker', async () => {
    behavior = 'failed'
    await expect(launch()).rejects.toThrow(/boom/)
    const state = readState()
    expect(state.status).toBe('failed')
    expect(fs.existsSync(path.join(demoPaths(root, state.generation).data, 'config.yaml'))).toBe(true)
    expect(ready()).toBe(false)
  })

  it('keeps data when the child exits before it is ready', async () => {
    behavior = 'exit'
    await expect(launch()).rejects.toThrow(/could not start. Its data was kept/)
    expect(fs.existsSync(homeOf(readState().generation))).toBe(true)
    expect(ready()).toBe(false)
  })

  it('does not say Ready when the ready child answers with another identity', async () => {
    const original = m.spawn.getMockImplementation()!
    m.spawn.mockImplementation((...args: unknown[]) => {
      const child = (original as (...a: unknown[]) => { pid: number })(...args)
      void sims[sims.length - 1]!.then(() => { for (const s of servers.values()) s.reply = { pid: 4242 } })
      return child
    })
    await expect(launch()).rejects.toThrow(/did not prove its Demo identity/)
    expect(ready()).toBe(false)
  })

  it('does not say Ready when the first-run page does not answer', async () => {
    configStatus = 503
    await expect(launch()).rejects.toThrow(/not serving its first-run page/)
    expect(ready()).toBe(false)
  })

  it('recovers a child that died (ESRCH) in the same generation, keeping its data', async () => {
    await launch()
    const { generation } = readState()
    const marker = plant(generation)
    for (const s of servers.values()) s.down = true
    alive.clear()
    await launch()
    expect(m.spawn).toHaveBeenCalledTimes(2)
    const options = m.spawn.mock.calls[1]![2] as { env: NodeJS.ProcessEnv }
    expect(options.env.WALNUT_DEMO_RECOVER).toBe('1')
    expect(readState().generation).toBe(generation)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
  })

  it('recovers its data when the recorded pid was reused by another process', async () => {
    await launch()
    const original = { ...readState(), startTime: 'proc:111' }
    writeState(original)
    processIdentity.starts.set(original.pid, 'proc:222')
    for (const server of servers.values()) server.down = true
    const marker = plant(original.generation)
    await launch()
    expect(readState().generation).toBe(original.generation)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(2)
    expect(m.spawn.mock.calls[1][2].env.WALNUT_DEMO_RECOVER).toBe('1')
  })

  it('refuses a stale state whose pid still lives but does not answer', async () => {
    await launch()
    for (const s of servers.values()) s.down = true
    await expect(launch()).rejects.toThrow(/fetch failed/)
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })
})

describe('runDemo reset', () => {
  it('clears only after `stopped` and ESRCH, then starts a new generation', async () => {
    await launch()
    const first = readState()
    const marker = plant(first.generation)
    // A name no generation can have is never taken for one.
    const kept = path.join(root, 'homes', 'other_generation', 'keep.txt')
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.writeFileSync(kept, 'keep')

    await reset()

    const fetches = vi.mocked(fetch).mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${String(url)}`)
    expect(fetches).toContain(`POST http://127.0.0.1:${first.controlPort}/stop`)
    expect(signals.some(([pid]) => pid === first.pid)).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(homeOf(first.generation))).toBe(false)
    expect(fs.existsSync(demoPaths(root, first.generation).daemon)).toBe(false)
    expect(logs.some(line => line.startsWith('Clearing demo data'))).toBe(true)
    expect(fs.readFileSync(kept, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(2)
    const second = readState()
    expect(second.generation).not.toBe(first.generation)
    expect(second.token).not.toBe(first.token)
    expect(second.status).toBe('ready')
    expect(fs.existsSync(path.join(demoPaths(root, second.generation).data, 'config.yaml'))).toBe(true)
  })

  it.each([
    ['unknown processes', { unknown: 4 }, 'unknown'],
    ['an incomplete process table', { complete: false }, 'unread'],
  ] as const)('with %s, keeps the old generation whole, says so in one line, and starts a fresh one', async (_name, answer, why) => {
    await launch()
    const first = readState()
    const old = demoPaths(root, first.generation)
    const marker = plant(first.generation)
    const daemonFile = path.join(old.daemon, 'daemon.port')
    fs.mkdirSync(path.dirname(daemonFile), { recursive: true })
    fs.writeFileSync(daemonFile, 'keep')
    sweep.report.mockResolvedValue(sweepReport(answer))
    sweep.assert.mockRejectedValue(new Error('could not be checked'))

    await reset()

    for (const file of [marker, daemonFile]) expect(fs.readFileSync(file, 'utf8'), file).toBe('keep')
    expect(fs.existsSync(old.home)).toBe(true)
    // One short line in the column of the others, naming no path.
    expect(logs.slice(logs.indexOf(RESET_LINES[0]))).toEqual([RESET_LINES[0], KEPT_LINE[why], ...RESET_LINES.slice(2)])
    const second = readState()
    expect(second.generation).not.toBe(first.generation)
    expect(second.status).toBe('ready')
    const fresh = demoPaths(root, second.generation)
    expect(fresh.daemon).not.toBe(old.daemon)
    const [, , options] = m.spawn.mock.calls[1] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(options.env.WALNUT_DAEMON_DIR).toBe(fresh.daemon)
    expect(options.env.WALNUT_TASK_DIR_ROOT).toBe(path.join(root, 'task-dirs', second.generation))
  })

  /** A launch, then a reset whose sweep cannot check the first generation, so it stays on disk. */
  async function keepFirst() {
    await launch()
    const first = readState()
    const marker = plant(first.generation)
    sweep.report.mockResolvedValue(sweepReport({ unknown: 2 }))
    sweep.assert.mockRejectedValue(new Error('could not be checked'))
    await reset()
    const second = readState()
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(second.generation).not.toBe(first.generation)
    sweep.report.mockReset().mockResolvedValue(sweepReport())
    sweep.assert.mockReset().mockResolvedValue(undefined)
    m.clear.mockClear()
    logs.length = 0
    return { first, second, marker }
  }

  it('the next reset clears a generation an earlier reset kept, and never the new one', async () => {
    const { first, second, marker } = await keepFirst()
    await reset()
    const third = readState()
    expect(fs.existsSync(marker)).toBe(false)
    for (const gone of [first, second].map(s => demoPaths(root, s.generation))) {
      for (const dir of [gone.home, gone.data, gone.daemon]) expect(fs.existsSync(dir), dir).toBe(false)
    }
    expect(fs.readdirSync(path.join(root, 'homes'))).toEqual([third.generation])
    expect(clearedGenerations()).toEqual([second.generation, first.generation])
    for (const [paths, keep] of m.clear.mock.calls) {
      expect(keep).toBe(true)
      expect(paths).toEqual(demoPaths(root, path.basename((paths as { home: string }).home)))
    }
    expect(logs).toEqual(RESET_LINES)
  })

  it.each([
    ['unknown processes', 'report' as const],
    ['a Demo process still running', 'assert' as const],
  ])('a kept generation with %s stays, and the reset still finishes Ready', async (_name, how) => {
    const { first, second, marker } = await keepFirst()
    const isFirst = (paths: unknown) => (paths as { home: string }).home === demoPaths(root, first.generation).home
    sweep.report.mockImplementation(async (paths: unknown) => sweepReport(isFirst(paths) ? (how === 'report' ? { unknown: 3 } : { matched: 1 }) : {}))
    sweep.assert.mockImplementation(async (paths: unknown) => { if (isFirst(paths)) throw new Error('1 process started in the Demo is still running. Demo data was kept.') })
    await reset()
    const third = readState()
    expect(third.status).toBe('ready')
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(fs.existsSync(homeOf(second.generation))).toBe(false)
    expect(fs.readdirSync(path.join(root, 'homes')).sort()).toEqual([first.generation, third.generation].sort())
    expect(clearedGenerations()).toEqual([second.generation, first.generation])
    // The old generation was cleared, so the line says Done; the older one is kept quietly.
    expect(logs).toEqual(RESET_LINES)
  })

  it('an entry in homes/ that is a symlink, a file or no generation name is skipped, and nothing it points to is removed', async () => {
    await launch()
    const first = readState()
    const outside = path.join(base, 'outside')
    fs.mkdirSync(path.join(outside, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    const homes = path.join(root, 'homes')
    fs.symlinkSync(outside, path.join(homes, 'linked-generation'))
    fs.symlinkSync(path.join(outside, 'sub'), path.join(homes, 'abc'))
    fs.writeFileSync(path.join(homes, 'plain-file'), 'keep')
    fs.mkdirSync(path.join(homes, 'not.a.generation'))
    await reset()
    expect(readState().status).toBe('ready')
    expect(clearedGenerations()).toEqual([first.generation])
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(outside, 'sub'))).toBe(true)
    expect(fs.lstatSync(path.join(homes, 'linked-generation')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(homes, 'abc')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(homes, 'plain-file'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(homes, 'not.a.generation'))).toBe(true)
  })

  it('a Demo process still running refuses the reset, keeps the data and starts nothing', async () => {
    await launch()
    const marker = plant(readState().generation)
    sweep.report.mockResolvedValue(sweepReport({ matched: 1 }))
    sweep.assert.mockRejectedValue(new Error('1 process started in the Demo is still running. Demo data was kept.'))
    await expect(reset()).rejects.toThrow()
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps data when the server says stopped but its pid never exits', async () => {
    onStop = 'stop-stay-alive'
    await launch()
    const { generation } = readState()
    const marker = plant(generation)
    vi.useFakeTimers({ toFake: ['Date'] })
    killHook = () => vi.setSystemTime(Date.now() + 1_000)
    await expect(reset()).rejects.toThrow(/still stopping; no data was cleared/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps data when the server refuses to stop', async () => {
    onStop = 'refuse'
    await launch()
    const marker = plant(readState().generation)
    await expect(reset()).rejects.toThrow(/did not confirm its stop/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps data when the stop answer carries another token', async () => {
    await launch()
    const marker = plant(readState().generation)
    for (const s of servers.values()) s.reply = { token: 'ffffffff-1111-1111-1111-111111111111' }
    await expect(reset()).rejects.toThrow(/did not prove its Demo identity/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps data when the server is not answering and its pid lives', async () => {
    await launch()
    const marker = plant(readState().generation)
    for (const s of servers.values()) s.down = true
    await expect(reset()).rejects.toThrow(/not answering/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps data when the server died unexpectedly (asks to recover first)', async () => {
    await launch()
    const marker = plant(readState().generation)
    for (const s of servers.values()) s.down = true
    alive.clear()
    await expect(reset()).rejects.toThrow(/stopped unexpectedly/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })

  it('a stop that failed is not the end: walnut demo brings the Demo back, then the reset goes through', async () => {
    await launch()
    const first = readState().generation
    const marker = plant(first)
    for (const s of servers.values()) s.onStop = 'refuse'
    await expect(reset()).rejects.toThrow(/did not confirm its stop; data was kept\. No data was cleared\. Run walnut demo to bring the Demo back\.$/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    // The same reset again names the failure once, closes the stuck server and keeps the data.
    await expect(reset()).rejects.toThrow(/^Demo session did not confirm its stop; data was kept\. The Demo was closed and data was kept\. Run walnut demo to bring it back, then walnut demo reset\.$/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    onStop = 'stop-and-exit'
    logs = []
    await launch()
    expect(ready()).toBe(true)
    expect(readState().generation).toBe(first)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    await reset()
    expect(readState().generation).not.toBe(first)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('walnut demo on a Demo whose stop failed closes it and recovers the same generation', async () => {
    await launch()
    const first = readState().generation
    for (const s of servers.values()) s.onStop = 'refuse'
    await expect(reset()).rejects.toThrow(/Run walnut demo to bring the Demo back/)
    onStop = 'stop-and-exit'
    logs = []
    await launch()
    expect(ready()).toBe(true)
    expect(readState().generation).toBe(first)
    expect(m.spawn).toHaveBeenCalledTimes(2)
    expect(m.spawn.mock.calls[1]![2].env.WALNUT_DEMO_RECOVER).toBe('1')
  })

  it('keeps data when the port is occupied by another server', async () => {
    await launch()
    const marker = plant(readState().generation)
    portBusy = true
    await expect(reset()).rejects.toThrow(/is in use/)
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
    expect(m.spawn).toHaveBeenCalledTimes(1)
  })
})

describe('runDemo with state.json missing', () => {
  // A lost state file must never be taken for a first run while any generation's files are still there.
  it.each(['d', 'homes', 'data', 'task-dirs'])('refuses while %s/<generation> remains, starts nothing and keeps the files', async name => {
    const kept = path.join(root, name, '0f6e2c1a-5b7d-4e3f-9a8b-1c2d3e4f5a6b', 'keep.txt')
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.writeFileSync(kept, 'keep')
    for (const run of [launch, reset]) {
      await expect(run()).rejects.toThrow(/generation directories/)
      expect(fs.readFileSync(kept, 'utf8')).toBe('keep')
      expect(fs.existsSync(stateFile)).toBe(false)
    }
    expect(m.spawn).not.toHaveBeenCalled()
  })
})

describe('walnut demo command registration', () => {
  // Wired as src/cli.ts wires it: commands registered first, so `demo` has no exit
  // override and Commander's default error path writes stderr and calls process.exit.
  class Exited extends Error { constructor(readonly code: unknown) { super('exited') } }
  let stderr: string[]
  let exit: ReturnType<typeof vi.spyOn>

  function program(): Command {
    const p = new Command('walnut')
    registerCommands(p)
    return p
  }

  beforeEach(() => {
    stderr = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write)
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exited(code) }) as typeof process.exit)
  })

  it('passes the action and options through unchanged on success', async () => {
    const run = vi.fn(async () => {})
    demoStub.runDemo = run
    await program().parseAsync(['demo', 'reset', '--_headless'], { from: 'user' })
    await program().parseAsync(['demo'], { from: 'user' })
    expect(run.mock.calls).toEqual([['reset', { _headless: true }], [undefined, {}]])
    expect(exit).not.toHaveBeenCalled()
    expect(stderr).toEqual([])
  })

  const longStack = `Error: Port 3458 is in use\n${'    at minified (file:///$bunfs/root/walnut:1:99999)\n'.repeat(40)}`
  it.each([
    ['an Error', Object.assign(new Error('Port 3458 is in use by another program'), { stack: longStack }), 'Port 3458 is in use by another program'],
    ['a TypeError', new TypeError('Demo state is invalid; data was kept'), 'Demo state is invalid; data was kept'],
    ['a string', 'Demo sign-in reset refused', 'Demo sign-in reset refused'],
  ])('turns %s into one stderr line and exit 1, no stack and no Ready', async (_kind, thrown, message) => {
    demoStub.runDemo = vi.fn(async () => { throw thrown })
    const parsed = program().parseAsync(['demo', 'reset'], { from: 'user' })
    await expect(parsed).rejects.toBeInstanceOf(Exited)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.join('')).toBe(`${message}\n`)
    expect(stderr.join('')).not.toMatch(/\bat \S+ \(|\$bunfs|Error:/)
    expect(logs.some(line => line.includes('Ready'))).toBe(false)
  })

  it('rethrows the original error in the Demo child, without the one-line exit', async () => {
    const thrown = new Error('Demo startup failed: boom')
    demoStub.runDemo = vi.fn(async () => { throw thrown })
    await expect(program().parseAsync(['demo', '--_child'], { from: 'user' })).rejects.toBe(thrown)
    expect(exit).not.toHaveBeenCalled()
    expect(stderr).toEqual([])
  })
})
