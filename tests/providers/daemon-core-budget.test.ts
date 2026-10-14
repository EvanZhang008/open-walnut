import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { budgetControlExempt, createDaemonCore, type CoreSessionData, type DaemonCoreDeps } from '../../src/providers/daemon-core.js'

function fixture(allow: () => Promise<boolean>) {
  const writes: string[] = []
  const fakeFs = {
    constants: fs.constants,
    openSync: vi.fn(() => 10),
    writeSync: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) => {
      writes.push(buffer.subarray(offset, offset + length).toString())
      return length
    }),
    closeSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    fsyncSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
    existsSync: vi.fn(() => false),
  }
  const session: CoreSessionData = {
    pipePath: '/tmp/budget-fixture/input.pipe', jsonlPath: '/tmp/budget-fixture/output.jsonl', pgidPath: '/tmp/budget-fixture/group',
    pid: 1234, state: 'running', exitCode: null, exitReason: null, exitedAt: null,
    parented: true, startTime: 'start', cwd: '/tmp/budget-fixture', args: ['claude'],
    orphanPollTimer: null, mode: 'default', pendingCtrl: null,
  }
  const sessions = new Map([['sid', session]])
  const signal = vi.fn()
  const groupSignal = vi.fn(() => true)
  const allowBudgetFn = vi.fn(allow)
  const deps: DaemonCoreDeps = {
    fs: fakeFs as unknown as typeof fs, clock: () => Date.now(), killFn: signal,
    readStartTimeFn: () => 'start', killProcessGroupFn: groupSignal,
    streamsDir: '/tmp/budget-fixture', registryFile: '/tmp/budget-fixture/registry',
    logger: vi.fn(), broadcastSessionStateFn: vi.fn(), broadcastExitToWatchersFn: vi.fn(),
    sessions, createAdoptedSession: () => session, allowBudgetFn,
  }
  return { core: createDaemonCore(deps), session, fakeFs, writes, signal, groupSignal, allowBudgetFn }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function stopWriterTwin(twin: 'standalone' | 'source', events: string[], rejectSync = false) {
  const file = new URL(`../../src/providers/daemon-${twin}.ts`, import.meta.url)
  const text = fs.readFileSync(file, 'utf8')
  let body = text
  if (twin === 'source') {
    const source = ts.createSourceFile(String(file), text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'DAEMON_SOURCE' && node.initializer && ts.isNoSubstitutionTemplateLiteral(node.initializer)) body = node.initializer.text
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const start = body.indexOf('function persistBudgetStops(')
  const end = body.indexOf('async function budgetGroupMembers(', start)
  if (start < 0 || end < 0) throw new Error('Budget stop writer not found')
  const writer = ts.transpileModule(body.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const mockedFs = {
    constants: fs.constants,
    promises: {
      mkdir: async () => { events.push('mkdir') },
      open: async (_file: string, flags: string | number) => {
        const directory = typeof flags === 'number'
        events.push(directory ? 'directory-open' : 'file-open')
        return {
          writeFile: async () => { events.push('file-write') },
          sync: async () => { events.push(directory ? 'directory-sync' : 'file-sync'); if (directory && rejectSync) throw new Error('Directory sync failed') },
          close: async () => { events.push(directory ? 'directory-close' : 'file-close') },
        }
      },
      rename: async () => { events.push('rename') },
      unlink: async () => { events.push('unlink-temp') },
    },
  }
  return vm.runInNewContext(writer + '\npersistBudgetStops', {
    fs: mockedFs, budgetStopWrites: Promise.resolve(), BUDGET_DIR: '/tmp/budget-fixture',
    budgetStopFile: '/tmp/budget-fixture/stops.map', budgetStopGroups: new Map(),
    crypto: { randomUUID: () => 'fixture' },
    ensureUsageBudgetDirectory: async () => { events.push('mkdir') },
    usageCore: { ensureUsageBudgetDirectory: async () => { events.push('mkdir') } },
  }) as () => Promise<void>
}

function budgetStopSinkTwin(twin: 'standalone' | 'source') {
  const file = new URL(`../../src/providers/daemon-${twin}.ts`, import.meta.url)
  let body = fs.readFileSync(file, 'utf8')
  if (twin === 'source') {
    const wrapper = ts.createSourceFile(String(file), body, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(wrapper) === 'DAEMON_SOURCE' && node.initializer && ts.isNoSubstitutionTemplateLiteral(node.initializer)) body = node.initializer.text
      ts.forEachChild(node, visit)
    }
    visit(wrapper)
  }
  const source = ts.createSourceFile('daemon.ts', body, ts.ScriptTarget.Latest, true)
  const functions = new Map<string, ts.FunctionDeclaration>()
  for (const node of source.statements) if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
  const pause = functions.get('pauseBudgetSession')
  const protocolNames = twin === 'standalone' ? ['enqueueForDrain', 'safeSend', 'sendOk', 'sendError'] : ['sendOk', 'sendError']
  if (!pause) throw new Error('Actual budget pause function not found')
  let sink: ts.VariableDeclaration | undefined
  const visitSink = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sink') sink = node
    ts.forEachChild(node, visitSink)
  }
  visitSink(pause)
  if (!sink?.initializer) throw new Error('Actual budget stop sink not found')
  const protocol = protocolNames.map(name => {
    const fn = functions.get(name)
    if (!fn) throw new Error(`Actual protocol helper not found: ${name}`)
    return fn.getText(source)
  }).join('\n')
  const code = `let reply; const sink = ${sink.initializer.getText(source)};\n${protocol}\n({ sink, sendOk, sendError, reply: () => reply })`
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return vm.runInNewContext(compiled, {
    JSON, SEND_QUEUE_MAX_BYTES: 1024, logMsg: () => {}, wsId: () => 'budget-sink',
  }) as { sink: { data: Record<string, unknown>; readyState: number; send(raw: string): number }; sendOk(ws: unknown, id: number, data: Record<string, unknown>): void; sendError(ws: unknown, id: number, error: string): void; reply(): Record<string, unknown> | undefined }
}

describe('budget stop reply sink in actual daemon twins', () => {
  it.each(['standalone', 'source'] as const)('%s captures a successful stop through its real protocol helper', twin => {
    const actual = budgetStopSinkTwin(twin)
    expect(actual.sink.data).toEqual({})
    expect(actual.sink.readyState).toBe(1)
    expect(() => actual.sendOk(actual.sink, 0, { stopped: true })).not.toThrow()
    expect(actual.reply()).toEqual({ id: 0, ok: true, stopped: true })
    // Bun interprets zero as a dropped frame; an internal sink must return a successful send.
    expect(actual.sink.send('{"stopped":true}')).toBe(1)
    expect(actual.sink.data).toEqual({})
  })

  it.each(['standalone', 'source'] as const)('%s captures a refused stop without a socket-data exception', twin => {
    const actual = budgetStopSinkTwin(twin)
    expect(() => actual.sendError(actual.sink, 0, 'stop: process identity changed')).not.toThrow()
    expect(actual.reply()).toEqual({ id: 0, ok: false, error: 'stop: process identity changed' })
    expect(actual.sink.data).toEqual({})
  })
})

describe('budget stop proof durability in daemon twins', () => {
  it.each(['standalone', 'source'] as const)('%s syncs the renamed stop proof directory before resolving', async twin => {
    const events: string[] = []
    await stopWriterTwin(twin, events)()
    expect(events).toEqual(['mkdir', 'file-open', 'file-write', 'file-sync', 'file-close', 'rename', 'directory-open', 'directory-sync', 'directory-close', 'unlink-temp'])
  })

  it.each(['standalone', 'source'] as const)('%s rejects a failed directory sync and does not run stop controls', async twin => {
    const events: string[] = []
    const sendStop = vi.fn()
    await expect(stopWriterTwin(twin, events, true)().then(sendStop)).rejects.toThrow('Directory sync failed')
    expect(sendStop).not.toHaveBeenCalled()
    expect(events).toContain('directory-close')
    expect(events.at(-1)).toBe('unlink-temp')
  })
})

describe('owning daemon budget FIFO gate', () => {
  it('refuses a paused send before any FIFO bytes or delivery markers', async () => {
    const f = fixture(async () => false)
    expect(await f.core.handleSendCommand('sid', 'continue', undefined, [{ message: 'continue', messageId: 'message-1' }]))
      .toEqual({ ok: false, reason: 'budget_paused' })
    expect(f.fakeFs.openSync).not.toHaveBeenCalled()
    expect(f.fakeFs.writeSync).not.toHaveBeenCalled()
    expect(f.fakeFs.appendFileSync).not.toHaveBeenCalled()
    expect(f.groupSignal).not.toHaveBeenCalled()
    expect(f.session.state).toBe('running')
  })

  it('checks the latest policy after a queued FIFO predecessor finishes', async () => {
    let allowed = true
    const f = fixture(async () => allowed)
    let release!: () => void
    f.session.fifoWriteChain = new Promise<void>(resolve => { release = resolve })
    const result = f.core.handleSendCommand('sid', 'continue')
    await Promise.resolve()
    expect(f.allowBudgetFn).not.toHaveBeenCalled()
    allowed = false
    release()
    expect(await result).toEqual({ ok: false, reason: 'budget_paused' })
    expect(f.writes).toEqual([])
  })

  it.each([
    { type: 'control_request', request: { subtype: 'stop_task', task_id: 'task-1' } },
    { type: 'control_request', request: { subtype: 'interrupt', cancel_queued: true } },
    { type: 'control_request', request: { subtype: 'get_settings' } },
    { type: 'control_response', response: { subtype: 'success', response: { behavior: 'deny' } } },
    { type: 'control_response', response: { subtype: 'error' } },
    { type: 'control_cancel_request', request_id: 'request-1' },
  ])('still delivers a non-cost-producing paused control: %j', async frame => {
    const f = fixture(async () => false)
    const raw = JSON.stringify(frame)
    expect(budgetControlExempt(raw)).toBe(true)
    expect(await f.core.handleSendRawCommand('sid', raw)).toEqual({ ok: true })
    expect(f.writes.join('')).toBe(raw + '\n')
    expect(f.allowBudgetFn).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'user', message: { role: 'user', content: 'continue' } },
    { type: 'control_response', response: { subtype: 'success', response: { behavior: 'allow' } } },
    { type: 'control_request', request: { subtype: 'side_question', question: 'What changed?' } },
    { type: 'control_request', request: { subtype: 'set_model', model: 'example-model' } },
  ])('blocks raw cost-producing input while paused: %j', async frame => {
    const f = fixture(async () => false)
    const raw = JSON.stringify(frame)
    expect(budgetControlExempt(raw)).toBe(false)
    expect(await f.core.handleSendRawCommand('sid', raw)).toEqual({ ok: false, reason: 'budget_paused' })
    expect(f.writes).toEqual([])
    expect(f.fakeFs.appendFileSync).not.toHaveBeenCalled()
  })

  it('does not exempt malformed or multiple raw frames', async () => {
    const f = fixture(async () => false)
    for (const raw of ['not-json', '{"type":"control_request","request":{"subtype":"interrupt"}}\n{"type":"user"}']) {
      expect(budgetControlExempt(raw)).toBe(false)
      expect(await f.core.handleSendRawCommand('sid', raw)).toEqual({ ok: false, reason: 'budget_paused' })
    }
    expect(f.writes).toEqual([])
  })

  it('preserves an ordinary send when the budget permits it', async () => {
    const f = fixture(async () => true)
    expect(await f.core.handleSendCommand('sid', 'continue')).toEqual({ ok: true })
    expect(JSON.parse(f.writes.join(''))).toEqual({ type: 'user', message: { role: 'user', content: 'continue' } })
    expect(f.session.state).toBe('running')
  })

  it('persists the graceful budget stop flag in the running registry', () => {
    const f = fixture(async () => false)
    f.session.budgetGracefulStop = true
    f.core.persistRegistry()
    const body = f.fakeFs.writeFileSync.mock.calls[0]?.[1]
    expect(JSON.parse(String(body)).sessions.sid.budgetGracefulStop).toBe(true)
  })

  it('never escalates a graceful budget stop through the reaper', () => {
    vi.useFakeTimers()
    const f = fixture(async () => false)
    f.session.intentionalStopAt = Date.now()
    f.session.budgetGracefulStop = true
    f.core.reapSession('sid', 1, 'proc-exit')
    vi.advanceTimersByTime(10_000)
    expect(f.session.state).toBe('dead')
    expect(f.session.exitCode).toBe(0)
    expect(f.groupSignal).not.toHaveBeenCalled()
    expect(f.signal.mock.calls.every(call => call[1] === 0)).toBe(true)
  })
})
