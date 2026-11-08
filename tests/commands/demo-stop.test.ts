/**
 * `walnut demo reset` clears data only after stopDemoProcesses (src/commands/demo-server.ts)
 * confirmed every Demo session stopped through its owning daemon. These tests pin that:
 * no daemon is started when there is nothing to stop, a remote or unconfirmed session
 * keeps the data, each live daemon session is stopped through its owner, and only a
 * fully quiet daemon (no live session, no running command) is stopped last.
 *
 * Every module the function imports dynamically is mocked with a LEAF factory (no
 * importOriginal), so the real daemon, tracker and connection singletons are never
 * loaded and no process starts. vi.mock also covers dynamic import(), and the mocked
 * module is one instance for the whole file, so each fn is held in vi.hoisted and
 * reset in beforeEach instead of re-importing modules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const m = vi.hoisted(() => ({
  homedir: '',
  ensureRunning: vi.fn(),
  stopIfIsolated: vi.fn(),
  listSessions: vi.fn(),
  stopThroughOwner: vi.fn(),
  stopAcpThroughOwner: vi.fn(),
  getDirectDaemonConnection: vi.fn(),
  send: vi.fn(),
  lifted: vi.fn(),
}))

vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: m.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))
vi.mock('../../src/providers/local-daemon.js', () => ({
  localDaemon: { ensureRunning: m.ensureRunning, stopIfIsolated: m.stopIfIsolated },
}))
vi.mock('../../src/core/session-tracker.js', () => ({ listSessions: m.listSessions }))
vi.mock('../../src/commands/demo-terminals.js', () => ({ stopDemoTerminals: async () => {} }))
vi.mock('../../src/core/sessions/owner-stop.js', () => ({
  stopThroughOwner: m.stopThroughOwner, stopAcpThroughOwner: m.stopAcpThroughOwner,
}))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDirectDaemonConnection: m.getDirectDaemonConnection,
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { 'dev-box': { hostname: 'dev-box.example.test' }, 'demo-box': { hostname: 'demo-box.example.test' } } }),
}))
// Which hosts the Demo runs its own daemon on (src/providers/demo-remote-host.ts); the stop of those runs before this.
vi.mock('../../src/providers/demo-remote-host.js', () => ({ isDemoLiftedHost: m.lifted }))

import { stopDemoProcesses } from '../../src/commands/demo-server.js'
import { demoPaths, type DemoPaths } from '../../src/commands/demo-home.js'

const PORT = 47123
const caps = { hostExec: true }
const conn = { send: m.send, hasCapability: (cap: string) => cap !== 'host-exec-v1' || caps.hostExec }
let base: string
let paths: DemoPaths
let dataFile: string

type Answers = { list?: unknown[]; remaining?: unknown; exec?: unknown; firstList?: unknown; quiet?: unknown; acpRuntimes?: unknown[] }

function daemon(answers: Answers = {}): void {
  let lists = 0
  m.send.mockImplementation(async (cmd: string) => {
    if (cmd === 'demo.quiesce') return 'quiet' in answers ? answers.quiet : { ok: true, quiet: true, acpRuntimes: answers.acpRuntimes ?? [] }
    if (cmd === 'list') {
      lists++
      if (lists === 1) return { sessions: 'firstList' in answers ? answers.firstList : (answers.list ?? []) }
      return { sessions: 'remaining' in answers ? answers.remaining : [] }
    }
    if (cmd === 'acpState') return { ok: false, errorKind: 'no_worker' }
    if (cmd === 'exec.list') return { jobs: 'exec' in answers ? answers.exec : [] }
    throw new Error(`unexpected daemon command ${cmd}`)
  })
}

function withPortFile(): void {
  fs.mkdirSync(paths.daemon, { recursive: true })
  fs.writeFileSync(path.join(paths.daemon, 'daemon.port'), String(PORT))
}

async function keepsData(promise: Promise<void>, message: RegExp): Promise<void> {
  await expect(promise).rejects.toThrow(message)
  expect(m.stopIfIsolated).not.toHaveBeenCalled()
  expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
}

beforeEach(() => {
  for (const fn of [m.ensureRunning, m.stopIfIsolated, m.listSessions, m.stopThroughOwner,
    m.stopAcpThroughOwner, m.getDirectDaemonConnection, m.send, m.lifted]) fn.mockReset()
  m.lifted.mockReturnValue(false)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-stop-')))
  m.homedir = path.join(base, 'account')
  paths = demoPaths(path.join(base, 'open-walnut-demo'), 'g')
  dataFile = path.join(paths.data, 'tasks.json')
  fs.mkdirSync(paths.data, { recursive: true })
  fs.writeFileSync(dataFile, 'keep')
  m.ensureRunning.mockResolvedValue(PORT)
  m.getDirectDaemonConnection.mockResolvedValue(conn)
  m.stopIfIsolated.mockResolvedValue(undefined)
  m.listSessions.mockResolvedValue([])
  m.stopThroughOwner.mockResolvedValue('stopped')
  m.stopAcpThroughOwner.mockResolvedValue('stopped')
  daemon()
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('Demo server startup ownership', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/commands/demo-server.ts'), 'utf8')
  const body = source.slice(source.indexOf('  const markerDeadline ='), source.indexOf('  const { startServer,'))
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const check = new Function('readDemoState', 'paths', 'token', 'generation', 'process', 'Date', 'setTimeout', `return (async () => { ${js} })()`)

  it('waits past a launcher marker, another child and another generation before accepting its own record', async () => {
    const record = { token: 'launch-token', pid: 1234, generation: 'g1' }
    const read = vi.fn().mockResolvedValueOnce({ ...record, pid: 2345 })
      .mockResolvedValueOnce({ ...record, generation: 'g2' })
      .mockResolvedValueOnce({ ...record, token: 'other-token' })
      .mockResolvedValue(record)
    await check(read, { state: 'fake-state' }, record.token, record.generation, { pid: record.pid }, { now: () => 0 }, (fn: () => void) => fn())
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('a child never recorded by its launcher stops before loading the server', async () => {
    const read = vi.fn().mockResolvedValue({ token: 'launch-token', pid: 2345, generation: 'g1' })
    let now = 0
    await expect(check(read, { state: 'fake-state' }, 'launch-token', 'g1', { pid: 1234 }, { now: () => now += 10_000 }, (fn: () => void) => fn()))
      .rejects.toThrow('Demo launcher did not record this child')
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('Demo server origin inherited by its children', () => {
  it('keeps both server URL writes and browser pairing on the canonical host only in Demo', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/web/server.ts'), 'utf8')
    const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
    const writes: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(tree) === 'process.env.WALNUT_SERVER_URL') writes.push(node.getText(tree))
      ts.forEachChild(node, visit)
    }
    visit(tree)
    expect(writes).toHaveLength(2)
    for (const write of writes) {
      const js = ts.transpileModule(write, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      for (const demo of [true, false]) {
        const fake = { env: { WALNUT_SERVER_URL: '' } }
        new Function('process', 'IS_DEMO', 'port', 'bound', js)(fake, demo, 3458, { port: 3458 })
        expect(fake.env.WALNUT_SERVER_URL).toBe(`http://${demo ? '127.0.0.1' : 'localhost'}:3458`)
      }
    }
    const browser = fs.readFileSync(path.join(import.meta.dirname, '../../src/web/routes/browser-v1.ts'), 'utf8')
    const browserTree = ts.createSourceFile('browser-v1.ts', browser, ts.ScriptTarget.Latest, true)
    const declaration = browserTree.statements.filter(ts.isVariableStatement)
      .flatMap(statement => [...statement.declarationList.declarations])
      .find(node => node.name.getText(browserTree) === 'ownUrl')!
    const js = ts.transpileModule(declaration.initializer!.getText(browserTree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    for (const demo of [true, false]) {
      const ownUrl = new Function('IS_DEMO', 'return ' + js)(demo)
      expect(ownUrl({ socket: { localPort: 3458 } })).toBe(`http://${demo ? '127.0.0.1' : 'localhost'}:3458`)
    }
    expect(browser).toContain('getPairingTargets(ownUrl(req)!, port)')
  })
})

describe('stopDemoProcesses without a daemon port file', () => {
  it('returns at once with no sessions, never starting a daemon', async () => {
    await expect(stopDemoProcesses(paths)).resolves.toBeUndefined()
    expect(m.ensureRunning).not.toHaveBeenCalled()
    expect(m.getDirectDaemonConnection).not.toHaveBeenCalled()
    expect(m.send).not.toHaveBeenCalled()
    expect(m.stopIfIsolated).not.toHaveBeenCalled()
  })

  it('refuses when a session record still names a process', async () => {
    m.listSessions.mockResolvedValue([{ claudeSessionId: 's1', host: null, pid: 1234 }])
    await keepsData(stopDemoProcesses(paths), /daemon is unavailable/)
    expect(m.ensureRunning).not.toHaveBeenCalled()
  })

  it('refuses when a session record still names an ACP runtime', async () => {
    m.listSessions.mockResolvedValue([{ claudeSessionId: 's1', host: '__local__', acpRuntimeId: 'rt-1' }])
    await keepsData(stopDemoProcesses(paths), /daemon is unavailable/)
    expect(m.ensureRunning).not.toHaveBeenCalled()
  })

  it('when recovering, still starts and connects to its own isolated daemon', async () => {
    daemon({ list: [{ sid: 's1', alive: true }] })
    await expect(stopDemoProcesses(paths, true)).resolves.toBeUndefined()
    expect(m.ensureRunning).toHaveBeenCalledTimes(1)
    expect(m.getDirectDaemonConnection).toHaveBeenCalledWith('__local__', `ws://127.0.0.1:${PORT}`)
    expect(m.stopThroughOwner).toHaveBeenCalledTimes(1)
    expect(m.stopIfIsolated).toHaveBeenCalledTimes(1)
  })
})

describe('stopDemoProcesses refusals', () => {
  it.each([
    { ok: false, error: 'unknown command' },
    { ok: true, quiet: false, acpRuntimes: [] },
    { ok: true, quiet: true },
    { ok: true, quiet: true, acpRuntimes: [null] },
    { ok: true, quiet: true, acpRuntimes: [{ sid: '' }] },
  ])('keeps data when the daemon cannot prove admission is quiet: %j', async quiet => {
    withPortFile()
    daemon({ quiet })
    await keepsData(stopDemoProcesses(paths), /pending work settled/)
    expect(m.stopThroughOwner).not.toHaveBeenCalled()
    expect(m.stopAcpThroughOwner).not.toHaveBeenCalled()
    expect(m.send.mock.calls.map(call => call[0])).toEqual(['demo.quiesce'])
  })

  it('refuses remote sessions before touching any daemon', async () => {
    withPortFile()
    m.listSessions.mockResolvedValue([
      { claudeSessionId: 'local', host: '__local__' },
      { claudeSessionId: 'remote', host: 'dev-box' },
    ])
    await keepsData(stopDemoProcesses(paths), /remote sessions/)
    expect(m.ensureRunning).not.toHaveBeenCalled()
    expect(m.getDirectDaemonConnection).not.toHaveBeenCalled()
  })

  it('a remote session on a host the Demo runs its own daemon on does not block: that host was stopped before', async () => {
    withPortFile()
    m.lifted.mockImplementation((host: string) => host === 'demo-box')
    m.listSessions.mockResolvedValue([
      { claudeSessionId: 'local', host: '__local__' },
      { claudeSessionId: 'remote', host: 'demo-box', acpRuntimeId: 'rt-remote' },
    ])
    await expect(stopDemoProcesses(paths)).resolves.toBeUndefined()
    // Its rows never reach the local daemon's stops.
    expect(m.stopAcpThroughOwner).not.toHaveBeenCalled()
    expect(m.stopIfIsolated).toHaveBeenCalledTimes(1)
    // Any other remote host still blocks.
    m.stopIfIsolated.mockClear()
    m.listSessions.mockResolvedValue([{ claudeSessionId: 'remote', host: 'dev-box' }])
    await keepsData(stopDemoProcesses(paths), /remote sessions/)
  })

  it('refuses when an ACP agent does not confirm its stop, keeping data', async () => {
    withPortFile()
    const row = { claudeSessionId: 's1', host: null, acpRuntimeId: 'rt-1' }
    m.listSessions.mockResolvedValue([row])
    m.stopAcpThroughOwner.mockResolvedValue('refused')
    await keepsData(stopDemoProcesses(paths), /agent did not confirm its stop/)
    expect(m.stopAcpThroughOwner).toHaveBeenCalledWith(row, 'demo_reset', expect.any(Object))
    expect(m.send.mock.calls.map(call => call[0])).toEqual(['demo.quiesce'])
  })

  it('refuses when an ACP stop answered before its worker exited', async () => {
    withPortFile()
    m.listSessions.mockResolvedValue([{ claudeSessionId: 's1', host: null, acpRuntimeId: 'rt-1' }])
    m.send.mockImplementation(async (cmd: string) => cmd === 'demo.quiesce'
      ? { ok: true, quiet: true, acpRuntimes: [] } : { ok: true, result: {} })
    await keepsData(stopDemoProcesses(paths), /agent is still stopping/)
  })

  it('refuses when the owner refuses a live session, never stopping the daemon', async () => {
    withPortFile()
    daemon({ list: [{ sid: 'a', alive: true }, { sid: 'b', alive: true }] })
    m.stopThroughOwner.mockImplementation(async (target: { claudeSessionId: string }) =>
      target.claudeSessionId === 'b' ? 'refused' : 'stopped')
    await keepsData(stopDemoProcesses(paths), /session did not confirm its stop/)
  })

  it('refuses when the daemon does not list its sessions', async () => {
    withPortFile()
    daemon({ firstList: undefined })
    await keepsData(stopDemoProcesses(paths), /did not list its sessions/)
  })

  it('refuses when a session is still live after the stops', async () => {
    withPortFile()
    daemon({ list: [{ sid: 'a', alive: true }], remaining: [{ sid: 'a', alive: true }] })
    await keepsData(stopDemoProcesses(paths), /still has live sessions/)
  })

  it('refuses when the second list is not a list', async () => {
    withPortFile()
    daemon({ remaining: null })
    await keepsData(stopDemoProcesses(paths), /still has live sessions/)
  })

  it('refuses while a command is still running', async () => {
    withPortFile()
    daemon({ exec: [{ id: 'j1', running: false }, { id: 'j2', running: true }] })
    await keepsData(stopDemoProcesses(paths), /commands running/)
  })

  it('refuses when the daemon does not list its commands', async () => {
    withPortFile()
    daemon({ exec: undefined })
    await keepsData(stopDemoProcesses(paths), /did not list its commands/)
  })

  it('does not ask a daemon without host_exec for its commands: it never ran one', async () => {
    withPortFile()
    daemon()
    caps.hostExec = false
    try {
      await stopDemoProcesses(paths)
    } finally {
      caps.hostExec = true
    }
    expect(m.send.mock.calls.map(call => call[0])).not.toContain('exec.list')
    expect(m.stopIfIsolated).toHaveBeenCalledTimes(1)
  })
})

describe('stopDemoProcesses when every stop is confirmed', () => {
  it('stops an ACP worker admitted before the fence even if its tracker row is not written yet', async () => {
    withPortFile()
    daemon({ acpRuntimes: [{ sid: 'rt-pending' }] })
    await expect(stopDemoProcesses(paths)).resolves.toBeUndefined()
    expect(m.send).toHaveBeenNthCalledWith(1, 'demo.quiesce', { home: paths.data }, 30_000)
    expect(m.stopAcpThroughOwner).toHaveBeenCalledWith({
      claudeSessionId: 'rt-pending', host: '__local__', acpRuntimeId: 'rt-pending',
    }, 'demo_reset', expect.any(Object))
    expect(m.send).toHaveBeenNthCalledWith(2, 'acpState', { sid: 'rt-pending' }, 10_000)
    expect(m.stopIfIsolated).toHaveBeenCalledTimes(1)
  })

  it('stops each live daemon session through its owner, then stops the isolated daemon last', async () => {
    withPortFile()
    const acp = { claudeSessionId: 'acp', host: '__local__', acpRuntimeId: 'rt-1' }
    m.listSessions.mockResolvedValue([acp, { claudeSessionId: 'x', host: null }])
    daemon({
      list: [{ sid: 'a', alive: true }, { sid: 'b', alive: false }, { sid: 'c', alive: true }],
      remaining: [{ sid: 'a', alive: false }, { sid: 'c', alive: false }],
      exec: [{ id: 'j1', running: false }],
    })

    await expect(stopDemoProcesses(paths)).resolves.toBeUndefined()

    expect(m.ensureRunning).toHaveBeenCalledTimes(1)
    expect(m.getDirectDaemonConnection).toHaveBeenCalledWith('__local__', `ws://127.0.0.1:${PORT}`)
    expect(m.stopAcpThroughOwner).toHaveBeenCalledTimes(1)
    expect(m.stopAcpThroughOwner).toHaveBeenCalledWith(acp, 'demo_reset', expect.any(Object))
    expect(m.stopThroughOwner.mock.calls.map(call => call[0])).toEqual([
      { claudeSessionId: 'a', host: '__local__' }, { claudeSessionId: 'c', host: '__local__' },
    ])
    for (const call of m.stopThroughOwner.mock.calls) {
      expect(call.slice(1, 3)).toEqual(['user', 'demo_reset'])
      expect(call[4]).toBe('human')
      await expect((call[3] as { connection: () => Promise<unknown> }).connection()).resolves.toBe(conn)
    }
    const acpDeps = m.stopAcpThroughOwner.mock.calls[0][2] as { connection: () => Promise<unknown> }
    await expect(acpDeps.connection()).resolves.toBe(conn)

    expect(m.send.mock.calls.map(call => call[0])).toEqual(['demo.quiesce', 'acpState', 'list', 'list', 'exec.list'])
    expect(m.stopIfIsolated).toHaveBeenCalledTimes(1)
    const last = m.stopIfIsolated.mock.invocationCallOrder[0]
    const earlier = [
      ...m.send.mock.invocationCallOrder, ...m.stopThroughOwner.mock.invocationCallOrder,
      ...m.stopAcpThroughOwner.mock.invocationCallOrder, ...m.ensureRunning.mock.invocationCallOrder,
    ]
    expect(earlier.every(order => order < last)).toBe(true)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('keep')
  })

  it('stops the daemon with nothing live to stop', async () => {
    withPortFile()
    daemon({ list: [{ sid: 'a', alive: false }] })
    await expect(stopDemoProcesses(paths)).resolves.toBeUndefined()
    expect(m.stopThroughOwner).not.toHaveBeenCalled()
    expect(m.stopIfIsolated).toHaveBeenCalledTimes(1)
  })
})
