import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createDaemonCommandDrain } from '../../src/providers/daemon-command-drain.js'
import { DaemonSessionGate } from '../../src/providers/daemon-cron-controller.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { resolveAgentCommand } from '../../src/providers/agent-command-map.js'
import {
  applyTurnRetry, clearTurnRetryStreak, decideTurnRetry, newTurnRetryState, parseTurnErrorLine,
  turnRetryGiveUpText, turnRetryMarkerText, turnRetryMessage, TURN_RETRY_DEFAULTS,
} from '../../src/providers/daemon-core.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function extract(source: string, name: string): string {
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.ES2022, true)
  let found: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    else if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText(parsed) === name) found = node.initializer
    if (!found) ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (!found) throw new Error(`Missing ${name}`)
  return found.getText(parsed)
}

function compile<T>(source: string, environment: Record<string, unknown>): T {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), js)(...Object.values(environment)) as T
}

const standalone = fs.readFileSync(path.resolve('src/providers/daemon-standalone.ts'), 'utf8')
const template = getDaemonSource()
const templateDrain = compile<typeof createDaemonCommandDrain>(
  `return ${extract(template, 'daemonCommands').replace(/\(\)$/, '')};`, {},
)

describe.each([
  ['standalone', standalone, createDaemonCommandDrain],
  ['template', template, templateDrain],
] as const)('%s daemon command drain', (_kind, source, createDrain) => {
  it('cancels only an absent initial start and rejects its late command without spawning', async () => {
    const cancelled = new Set<string>();
    const gate = new DaemonSessionGate();
    const startSessionProcess = vi.fn(async () => ({ pid: 42, offset: 0 }));
    const sendOk = vi.fn();
    const kill = vi.fn();
    const commands = compile<{ cancel: Function; start: Function }>(
      `${extract(source, 'cancelledStartPath')}\n${extract(source, 'cmdCancelPendingStart')}\n${extract(source, 'cmdStart')}\nreturn { cancel: cmdCancelPendingStart, start: cmdStart };`, {
        DAEMON_DIR: '/fixture', path, Buffer, sessionStartGate: gate,
        sessions: new Map(), acp: { hasWorker: () => false }, process: { kill },
        fs: { existsSync: (p: string) => cancelled.has(p), promises: { mkdir: async () => {}, writeFile: async (p: string) => { cancelled.add(p); } } },
        sessionStopVersions: new Map(), cronRuntime: null, startSessionProcess, addSubscriber: vi.fn(), sendOk, sendError: vi.fn(),
      });
    await commands.cancel({}, 1, { sid: 'late-start' });
    expect(sendOk).toHaveBeenCalledWith({}, 1, { cancelled: true, alive: false });
    await expect(commands.start({}, 2, { sid: 'late-start' })).rejects.toThrow('Initial start was cancelled');
    expect(startSessionProcess).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('waits behind a start and leaves its confirmed process untouched', async () => {
    const gate = new DaemonSessionGate();
    const pending = deferred();
    const sessions = new Map<string, unknown>();
    const starting = gate.run('live-start', async () => { await pending.promise; sessions.set('live-start', { state: 'running', pid: 42 }); });
    const writeFile = vi.fn();
    const kill = vi.fn();
    const sendOk = vi.fn();
    const cancel = compile<Function>(`${extract(source, 'cancelledStartPath')}\n${extract(source, 'cmdCancelPendingStart')}\nreturn cmdCancelPendingStart;`, {
      DAEMON_DIR: '/fixture', path, Buffer, sessionStartGate: gate, sessions,
      acp: { hasWorker: () => false }, process: { kill }, fs: { promises: { mkdir: vi.fn(), writeFile } }, sendOk, sendError: vi.fn(),
    });
    const cancelling = cancel({}, 1, { sid: 'live-start' });
    await Promise.resolve();
    expect(sendOk).not.toHaveBeenCalled();
    pending.resolve();
    await starting;
    await cancelling;
    expect(sendOk).toHaveBeenCalledWith({}, 1, { cancelled: false, alive: true, pid: 42 });
    expect(kill).toHaveBeenCalledExactlyOnceWith(42, 0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('closes admission immediately while preserving already accepted work and its result', async () => {
    const drain = createDrain()
    const send = deferred<string>()
    const stop = deferred()
    expect(drain.run(() => 7)).toBe(7)
    expect(drain.run(() => send.promise)).toBe(send.promise)
    drain.run(() => stop.promise)
    let finished = false
    const closing = drain.close().then(() => { finished = true })
    expect(drain.closed).toBe(true)
    const rejectedWork = vi.fn()
    expect(() => drain.run(rejectedWork)).toThrow('shutting down')
    expect(rejectedWork).not.toHaveBeenCalled()
    send.resolve('delivered')
    await send.promise
    expect(finished).toBe(false)
    stop.resolve()
    await closing
    expect(finished).toBe(true)
    await drain.close()
  })

  it.each(['ESRCH', 'EPERM', 'EIO'])('only ESRCH proves that a process group has exited (%s)', (code) => {
    const kill = vi.fn(() => { throw Object.assign(new Error(code), { code }) })
    const alive = compile<(pid: number) => boolean>(`${extract(source, 'isProcessGroupAlive')}\nreturn isProcessGroupAlive;`, { process: { kill } })
    expect(alive(4242)).toBe(code !== 'ESRCH')
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4242, 0)
    kill.mockClear()
    for (const pid of [-1, 0, 1, 1.5, NaN]) expect(alive(pid)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('persists the retry budget with the live process registry', () => {
    const turnRetry = { attempts: 2, streakStartedAt: 100, lastAttemptAt: 200, lastHandledV: 300 }
    const sessions = new Map([['session', { state: 'running', pid: 4242, turnRetry }]])
    const writeFileSync = vi.fn()
    const registryFs = { writeFileSync, openSync: () => 123, fsyncSync: vi.fn(), closeSync: vi.fn(), renameSync: vi.fn() }
    const registrySource = _kind === 'standalone' ? fs.readFileSync(path.resolve('src/providers/daemon-core.ts'), 'utf8') : source
    const persist = compile<() => void>(`${extract(registrySource, 'persistRegistry')}\nreturn persistRegistry;`, {
      sessions, fs: registryFs, deps: { bootId: 'boot' }, daemonBootId: 'boot', clock: () => 0,
      registryFile: '/fixture/sessions.json', REGISTRY_FILE: '/fixture/sessions.json',
      dirname: path.dirname, path, logger: vi.fn(), logMsg: vi.fn(),
    })
    persist()
    expect(JSON.parse(writeFileSync.mock.calls[0][1]).sessions.session.turnRetry).toEqual(turnRetry)
  })

  it('preserves the retry budget when adopting a live CLI without scheduling another message', () => {
    const turnRetry = { attempts: 2, streakStartedAt: 100, lastAttemptAt: 200, lastHandledV: 300 }
    const entry = { pid: 4242, startTime: 'start', bootId: 'boot', jsonlPath: '/fixture/session.jsonl', args: ['cli'], turnRetry }
    const sessions = new Map<string, { turnRetry?: typeof turnRetry; turnRetryTimer?: unknown }>()
    const rebuildFoldStateFromJsonl = () => ({ boundary: 400, state: {} })
    const rebuildTaskStateFromJsonl = () => ({})
    if (_kind === 'standalone') {
      const adopt = compile<(sid: string, value: typeof entry) => { turnRetry?: typeof turnRetry }>(
        `return ${extract(source, 'createAdoptedSession')};`,
        // The adopt also stamps a cron origin; neither call is what this test is
        // about, so both are stubbed to their "nothing known" answers.
        { rebuildFoldStateFromJsonl, rebuildTaskStateFromJsonl, processStartedAtMs: () => null, cronProcess: () => ({ identity: 'fixture' }) },
      )
      sessions.set('session', adopt('session', entry))
    } else {
      const reconcile = compile<() => void>(`${extract(source, 'reconcileRegistry')}\nreturn reconcileRegistry;`, {
        readRegistry: () => ({ session: entry }), sessions, rebuildFoldStateFromJsonl, rebuildTaskStateFromJsonl,
        daemonBootId: 'boot', reapSession: vi.fn(), logMsg: vi.fn(), fs: { readdirSync: () => [] },
        STREAMS_DIR: '/fixture', process: { kill: vi.fn() }, readStartTime: () => 'start',
        logStateTransition: vi.fn(), startOrphanPoll: vi.fn(), broadcastSessionState: vi.fn(),
        processStartedAtMs: () => null, cronProcess: () => ({ identity: 'fixture' }),
      })
      reconcile()
    }
    expect(sessions.get('session')?.turnRetry).toEqual(turnRetry)
    expect(sessions.get('session')?.turnRetryTimer).toBeUndefined()
  })

  it('pauses only when untracked operations have finished and can resume after refusal', async () => {
    const drain = createDrain()
    const download = deferred()
    drain.admit(() => download.promise)
    expect(() => drain.pause()).toThrow('active operations')
    expect(drain.closed).toBe(false)
    download.resolve()
    await download.promise
    const send = deferred()
    drain.admit(() => drain.run(() => send.promise))
    const paused = drain.pause()
    expect(drain.closed).toBe(true)
    expect(drain.stopping).toBe(false)
    expect(() => drain.admit(() => {})).toThrow('shutting down')
    let drained = false
    const waiting = paused.drained.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    send.resolve()
    await waiting
    paused.resume()
    expect(drain.admit(() => 7)).toBe(7)
    const finalPause = drain.pause()
    await drain.close()
    finalPause.resume()
    expect(drain.stopping).toBe(true)
    expect(() => drain.admit(() => {})).toThrow('shutting down')
  })

  it('a rejected command does not strand shutdown or change its rejection', async () => {
    const drain = createDrain()
    const write = deferred()
    const result = drain.run(() => write.promise)
    const closing = drain.close()
    write.reject(new Error('write failed'))
    await expect(result).rejects.toThrow('write failed')
    await closing
    expect(() => createDrain().run(() => { throw new Error('sync failure') })).toThrow('sync failure')
  })

  it.each([
    { cmd: 'start' }, { cmd: 'send' }, { cmd: 'sendRaw' }, { cmd: 'stop' },
    { cmd: 'hooks.configure' }, { cmd: 'cron.supervision' }, { cmd: 'bridgeResume' }, { cmd: 'service.handover' }, { cmd: 'service.update' },
    // walnut-trigger: configure/run/ack all persist, so shutdown must wait for
    // them; triggers.test writes nothing and stays on the plain admit path.
    { cmd: 'triggers.configure' }, { cmd: 'triggers.run' }, { cmd: 'triggers.ack' },
    { cmd: 'agent.start', engine: 'claude' }, { cmd: 'agent.send', engine: 'claude' },
    { cmd: 'agent.steer', engine: 'claude' }, { cmd: 'agent.stop', engine: 'claude' },
  ])('drains accepted native delivery or persistence through the actual dispatcher: %j', async (frame) => {
    const daemonCommands = createDrain()
    const accepted = deferred()
    const operation = vi.fn(() => accepted.promise)
    const sendError = vi.fn()
    const handle = compile<(ws: unknown, msg: string) => void>(`${extract(source, 'handleCommand')}\n${extract(source, 'dispatchCommand')}\nreturn handleCommand;`, {
      daemonCommands, sendError, logMsg: vi.fn(), BRIDGE_ALLOWED_COMMANDS: new Set(), resolveAgentCommand,
      cmdStart: operation, cmdSend: operation, cmdSendRaw: operation, cmdStop: operation,
      cmdHooksConfigure: operation, cmdCronSupervision: operation, cmdBridgeResume: operation, cmdServiceHandover: operation,
      cmdTriggersConfigure: operation, cmdTriggersRun: operation, cmdTriggersAck: operation,
    })
    handle({}, JSON.stringify({ id: 1, ...frame }))
    let closed = false
    const closing = daemonCommands.close().then(() => { closed = true })
    handle({}, JSON.stringify({ id: 2, cmd: 'start' }))
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sendError).toHaveBeenCalledWith({}, 2, expect.stringContaining('shutting down'))
    await Promise.resolve()
    expect(closed).toBe(false)
    accepted.resolve()
    await closing
  })

  function handoverFixture(fault?: 'persist' | 'prepare' | 'published' | 'reply', updating = false, cronDrain = Promise.resolve()) {
    const daemonCommands = createDrain()
    const order: string[] = []
    let closing: Promise<void> | undefined
    const prepare = vi.fn(async () => {
      order.push('prepare')
      if (fault === 'prepare') throw new Error('snapshot refused')
      if (fault === 'published') throw Object.assign(new Error('snapshot sync failed'), { code: 'handover-published' })
    })
    const result = compile<{ handle: (ws: unknown, id: number, cmd: unknown) => Promise<void>; prepared: () => boolean }>(
      `let handoverPrepared = false; let serviceUpdateRequested = false; ${extract(source, 'cmdServiceHandover')}; return { handle: cmdServiceHandover, prepared: () => handoverPrepared };`, {
        daemonCommands, SERVICE_MODE: updating, DAEMON_INSTANCE_ID: 'old-instance', HOME_DIR: '/fixture', REGISTRY_FILE: '/fixture/sessions.json',
        setTimeout, clearTimeout,
        cronRuntime: {
          pause: () => ({ drained: cronDrain, resume: () => { order.push('cronResume') } }),
          close: async () => { order.push('cronClose'); await cronDrain },
        },
        process: { platform: 'linux', pid: 4242 }, os: { userInfo: () => ({ uid: 501 }) },
        readStartTime: () => 'start', readRegistry: () => ({}), daemonHooks: null,
        acp: { workers: new Map() }, sttRelayPending: new Map(), launchRelayPending: new Map(),
        controlRelayPending: new Map(), messageRelayPending: new Map(), gatewayRelayPending: new Map(),
        prepareDaemonServiceHandover: prepare, cronRuntimeCore: { prepareDaemonServiceHandover: prepare },
        persistRegistry: (strict: boolean) => {
          expect(strict).toBe(true)
          order.push('persist')
          if (fault === 'persist') throw new Error('registry refused')
        },
        sendError: (_ws: unknown, _id: number, _error: string, data: unknown) => {
          expect(data).toEqual({ updateStarted: true, instanceId: 'old-instance' })
          order.push('failedUpdateReply')
        },
        sendOk: () => { order.push('reply'); if (fault === 'reply') throw new Error('socket closed') },
        waitForHandoverReceipt: async () => { order.push('receipt') },
        requestDaemonShutdown: () => { order.push('shutdown'); closing = daemonCommands.close() },
      },
    )
    return {
      ...result, daemonCommands, order, prepare, closing: () => closing,
      request: () => daemonCommands.admit(() => daemonCommands.run(() => result.handle({}, 1, {
        cmd: updating ? 'service.update' : 'service.handover', stateDir: '/fixture/service', instanceId: 'old-instance',
      }))),
    }
  }

  it('drains an in-flight send before snapshotting without waiting for its own handover RPC', async () => {
    const fixture = handoverFixture()
    const send = deferred()
    fixture.daemonCommands.admit(() => fixture.daemonCommands.run(() => send.promise))
    const result = fixture.request()
    expect(fixture.daemonCommands.closed).toBe(true)
    expect(fixture.order).toEqual([])
    send.resolve()
    await result
    await fixture.closing()
    expect(fixture.order).toEqual(['persist', 'prepare', 'reply', 'receipt', 'shutdown'])
    expect(fixture.prepared()).toBe(true)
  })

  it.each(['persist', 'prepare'] as const)('reopens admission after a %s refusal without shutting down', async (fault) => {
    const fixture = handoverFixture(fault)
    await expect(fixture.request()).rejects.toThrow('refused')
    expect(fixture.prepared()).toBe(false)
    expect(fixture.daemonCommands.admit(() => 'accepted')).toBe('accepted')
    expect(fixture.order).not.toContain('shutdown')
    expect(fixture.order).not.toContain('reply')
  })

  it('keeps admission closed after snapshot publication even when fsync fails', async () => {
    const fixture = handoverFixture('published')
    await expect(fixture.request()).rejects.toThrow('snapshot sync failed')
    await fixture.closing()
    expect(fixture.prepared()).toBe(true)
    expect(fixture.daemonCommands.closed).toBe(true)
    expect(() => fixture.daemonCommands.admit(() => 'new input')).toThrow('shutting down')
    expect(fixture.order).toEqual(['persist', 'prepare', 'shutdown'])
  })

  it('does not reopen admission when the confirmation reply fails after the snapshot is prepared', async () => {
    const fixture = handoverFixture('reply')
    await expect(fixture.request()).rejects.toThrow('socket closed')
    await fixture.closing()
    expect(fixture.prepared()).toBe(true)
    expect(fixture.daemonCommands.closed).toBe(true)
    expect(fixture.order).toEqual(['persist', 'prepare', 'reply', 'receipt', 'shutdown'])
  })

  it.each([false, true])('managed update closes recovery and persists before shutdown, including persistence failure (%s)', async (fails) => {
    const fixture = handoverFixture(fails ? 'persist' : undefined, true)
    await fixture.request()
    await fixture.closing()
    expect(fixture.prepared()).toBe(true)
    expect(fixture.daemonCommands.closed).toBe(true)
    expect(fixture.prepare).not.toHaveBeenCalled()
    expect(fixture.order).toEqual(['cronClose', 'persist', fails ? 'failedUpdateReply' : 'reply', 'receipt', 'shutdown'])
  })

  it.each(['native', 'cron'] as const)('abandons an update with stuck %s work without dropping it or keeping admission closed', async (kind) => {
    vi.useFakeTimers()
    const pending = deferred()
    try {
      const fixture = handoverFixture(undefined, true, kind === 'cron' ? pending.promise : Promise.resolve())
      if (kind === 'native') fixture.daemonCommands.admit(() => fixture.daemonCommands.run(() => pending.promise))
      let failure: unknown
      let finished = false
      const updating = fixture.request().catch((error) => { failure = error }).finally(() => { finished = true })
      await vi.advanceTimersByTimeAsync(15_000)
      expect(finished).toBe(true)
      expect(String(failure)).toContain('timed out')
      expect(fixture.prepared()).toBe(false)
      expect(fixture.daemonCommands.admit(() => 'accepted')).toBe('accepted')
      expect(fixture.order).toEqual(['cronResume'])
      pending.resolve()
      await updating
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fixture.order).toEqual(['cronResume'])
      await fixture.request()
      await fixture.closing()
      expect(fixture.order).toEqual(['cronResume', 'cronClose', 'persist', 'reply', 'receipt', 'shutdown'])
      expect(vi.getTimerCount()).toBe(0)
    } finally { pending.resolve(); vi.useRealTimers() }
  })

  it.each([0, 40, null])('waits for the confirmation connection to close, bounded when it never closes (%s)', async (closeAfter) => {
    vi.useFakeTimers()
    try {
      const ws = { readyState: closeAfter === 0 ? 3 : 1 }
      const wait = compile<(socket: typeof ws) => Promise<void>>(`${extract(source, 'waitForHandoverReceipt')}\nreturn waitForHandoverReceipt;`, { Date, setTimeout })
      let finished = false
      const receipt = wait(ws).then(() => { finished = true })
      if (closeAfter !== null && closeAfter > 0) setTimeout(() => { ws.readyState = 3 }, closeAfter)
      await vi.advanceTimersByTimeAsync(30)
      expect(finished).toBe(closeAfter === 0)
      await vi.advanceTimersByTimeAsync(1470)
      await receipt
      expect(finished).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('does not wait for a download but still reports its late failure', async () => {
    const daemonCommands = createDrain()
    const download = deferred()
    const cmdVscodeEnsure = vi.fn(() => download.promise)
    const sendError = vi.fn()
    const handle = compile<(ws: unknown, msg: string) => void>(`${extract(source, 'handleCommand')}\n${extract(source, 'dispatchCommand')}\nreturn handleCommand;`, {
      daemonCommands, cmdVscodeEnsure, sendError, logMsg: vi.fn(), BRIDGE_ALLOWED_COMMANDS: new Set(),
    })
    handle({}, JSON.stringify({ id: 1, cmd: 'vscode.ensure' }))
    await daemonCommands.close()
    handle({}, JSON.stringify({ id: 2, cmd: 'vscode.ensure' }))
    expect(cmdVscodeEnsure).toHaveBeenCalledTimes(1)
    expect(sendError).toHaveBeenCalledWith({}, 2, expect.stringContaining('shutting down'))
    download.reject(new Error('download failed'))
    await Promise.resolve()
    expect(sendError).toHaveBeenCalledWith({}, 1, expect.stringContaining('download failed'))
  })

  it.each([[false, false], [true, false], [false, true]])('shutdown drains commands with cron failure=%s and service update=%s', async (cronFails, updating) => {
    const daemonCommands = createDrain()
    const work = deferred()
    daemonCommands.run(() => work.promise)
    const cron = deferred()
    const exited = deferred<number>()
    const order: string[] = []
    const exit = vi.fn((code: number) => { order.push(`exit:${code}`); exited.resolve(code) })
    const stop = compile<() => void>(`let shutdown = null; const stopDaemon = ${extract(source, 'stopDaemon')}; return stopDaemon;`, {
      daemonCommands,
      cronRuntime: { close: vi.fn(() => cron.promise) },
      persistRegistry: () => { order.push('persist') },
      cleanup: () => { order.push('cleanup') },
      server: { stop: () => { order.push('server') } },
      httpServer: { close: () => { order.push('server') } },
      daemonInstanceLock: { release: async () => { order.push('release') } },
      process: { exit }, serviceUpdateRequested: updating, logMsg: vi.fn(),
    })
    stop()
    stop()
    expect(daemonCommands.closed).toBe(true)
    if (cronFails) cron.reject(new Error('cron persistence failed'))
    else cron.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    work.resolve()
    expect(await exited.promise).toBe(cronFails || updating ? 1 : 0)
    expect(order).toEqual(['persist', 'cleanup', 'server', 'release', `exit:${cronFails || updating ? 1 : 0}`])
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('stops every watcher before publishing the final registry without reaping live CLI processes', () => {
    const order: string[] = []
    const sessions = new Map(['first', 'second'].map((sid) => [sid, {
      watcher: { pollTimer: `${sid}-watcher`, offset: 100 },
      orphanPollTimer: `${sid}-orphan`, snapshotTimer: null,
      subscribers: new Set(), offset: 0,
    }]))
    const cleared = new Set<unknown>()
    const persistRegistry = vi.fn(() => {
      order.push('persist')
      return {
        watchersStopped: [...sessions.values()].every((session) => session.watcher === null),
        orphanPollsStopped: [...sessions.keys()].every((sid) => cleared.has(`${sid}-orphan`)),
      }
    })
    const reapAllSessionGroupsSync = vi.fn()
    const kill = vi.fn()
    const cleanup = compile<() => void>(`${extract(source, 'stopSessionWatcher')}\n${extract(source, 'cleanup')}\nreturn cleanup;`, {
      sessions, cronRuntime: null, stopBridge: vi.fn(), vscodeServerCore: null, triggerTickTimer: null,
      shouldReapOnExit: () => false, reapAllSessionGroupsSync, persistRegistry,
      clearInterval: (timer: unknown) => { cleared.add(timer); order.push(String(timer)) },
      fs: { readFileSync: () => '4242', unlinkSync: vi.fn() }, process: { pid: 4242, kill },
      path, agentSubs: new Map(), logMsg: vi.fn(), DAEMON_START_TS: 0,
      PID_FILE: '/fixture/pid', PORT_FILE: '/fixture/port', INSTANCE_ID_FILE: '/fixture/instance',
      SERVICE_FILE: '/fixture/service', VERSION_FILE: '/fixture/version',
      GATEWAY_SOCK_PATH: '/fixture/gateway.sock', GATEWAY_SHIM_PATH: '/fixture/walnut', GATEWAY_SHIM_DIR: '/fixture',
    })
    cleanup()
    expect(persistRegistry).toHaveBeenCalledTimes(1)
    expect(persistRegistry.mock.results[0]?.value).toEqual({ watchersStopped: true, orphanPollsStopped: true })
    expect(order.at(-1)).toBe('persist')
    expect([...sessions.values()].every((session) => session.offset === 100)).toBe(true)
    expect(reapAllSessionGroupsSync).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  function retryFixture(daemonCommands = createDrain()) {
    const session = { turnRetry: newTurnRetryState(), turnRetryTimer: null as ReturnType<typeof setTimeout> | null }
    const cmdBridgeResume = vi.fn()
    const persistRegistry = vi.fn()
    const appendSystemMarker = vi.fn()
    const sessions = new Map<string, typeof session>([['test-session', session]])
    const cronRuntime = { get: vi.fn<() => unknown>(() => undefined) }
    const functions = ['checkTurnRetry', 'fireTurnRetry', 'cancelTurnRetry'].map((name) => extract(source, name)).join('\n')
    const retry = compile<{
      check: (sid: string, session: unknown, line: string, v: number) => void
      cancel: (sid: string, reason: string) => void
    }>(`${functions}\nreturn { check: checkTurnRetry, cancel: cancelTurnRetry };`, {
      daemonCommands, cronRuntime, sessions,
      TURN_RETRY_CFG: { ...TURN_RETRY_DEFAULTS, enabled: true, backoffBaseMs: 1000 },
      applyTurnRetry, clearTurnRetryStreak, decideTurnRetry, newTurnRetryState, parseTurnErrorLine,
      turnRetryGiveUpText, turnRetryMarkerText, turnRetryMessage,
      cmdBridgeResume, persistRegistry, appendSystemMarker, RETRY_WS_SINK: {}, logMsg: vi.fn(),
      setTimeout, clearTimeout,
    })
    return {
      ...retry, session, sessions, cronRuntime, cmdBridgeResume, persistRegistry, appendSystemMarker,
      error: () => retry.check('test-session', session, JSON.stringify({ type: 'result', is_error: true, result: 'overloaded' }), 100),
      success: () => retry.check('test-session', session, JSON.stringify({ type: 'result', is_error: false }), 200),
    }
  }

  it.each(['before', 'during'] as const)('retains a retry scheduled %s a canceled update without spending another attempt', async (when) => {
    vi.useFakeTimers()
    const pending = deferred()
    const fixture = handoverFixture(undefined, true, pending.promise)
    const retry = retryFixture(fixture.daemonCommands)
    let updating: Promise<unknown> | undefined
    try {
      if (when === 'before') retry.error()
      updating = fixture.request().then(() => null, (error: unknown) => error)
      if (when === 'during') retry.error()
      await vi.advanceTimersByTimeAsync(14_000)
      expect(retry.cmdBridgeResume).not.toHaveBeenCalled()
      expect(retry.session.turnRetryTimer).not.toBeNull()
      expect(retry.session.turnRetry.attempts).toBe(1)
      expect(retry.appendSystemMarker).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(String(await updating)).toContain('timed out')
      expect(retry.cmdBridgeResume).toHaveBeenCalledExactlyOnceWith({}, 0, expect.objectContaining({ sid: 'test-session', autoRetry: true }))
      expect(retry.session.turnRetry.attempts).toBe(1)
      pending.resolve()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(retry.cmdBridgeResume).toHaveBeenCalledTimes(1)
      expect(fixture.prepared()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      pending.resolve()
      await updating
      retry.cancel('test-session', 'test cleanup')
      vi.useRealTimers()
    }
  })

  it.each(['success', 'user-stop', 'daemon-close', 'session-gone', 'session-replaced', 'cron-registered'] as const)('does not revive a deferred retry after %s', async (event) => {
    vi.useFakeTimers()
    const daemonCommands = createDrain()
    const retry = retryFixture(daemonCommands)
    try {
      retry.error()
      const pause = daemonCommands.pause()
      await vi.advanceTimersByTimeAsync(1500)
      expect(retry.cmdBridgeResume).not.toHaveBeenCalled()
      expect(retry.session.turnRetryTimer).not.toBeNull()
      if (event === 'success') {
        retry.success()
        expect(retry.session.turnRetry.attempts).toBe(0)
        expect(retry.persistRegistry).toHaveBeenCalledTimes(2)
      } else if (event === 'user-stop') retry.cancel('test-session', 'session-stopped')
      else if (event === 'session-gone') retry.sessions.delete('test-session')
      else if (event === 'session-replaced') retry.sessions.set('test-session', { turnRetry: newTurnRetryState(), turnRetryTimer: null })
      else if (event === 'cron-registered') retry.cronRuntime.get.mockReturnValue({ enabled: true })
      else await daemonCommands.close()
      pause.resume()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(retry.cmdBridgeResume).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      retry.cancel('test-session', 'test cleanup')
      vi.useRealTimers()
    }
  })

  it('does not dispatch an internal retry after admission closes', async () => {
    const daemonCommands = createDrain()
    await daemonCommands.close()
    const cmdBridgeResume = vi.fn()
    const fire = compile<(sid: string, attempt: number, text: null) => Promise<void>>(`${extract(source, 'fireTurnRetry')}\nreturn fireTurnRetry;`, {
      daemonCommands, cronRuntime: null, sessions: new Map([['test-session', {}]]),
      turnRetryMessage: () => 'retry', cmdBridgeResume, RETRY_WS_SINK: {}, logMsg: vi.fn(),
    })
    await fire('test-session', 1, null)
    expect(cmdBridgeResume).not.toHaveBeenCalled()
  })
})

describe('standalone ACP command lifetime', () => {
  it.each([{ cmd: 'acpStart' }, { cmd: 'acpSend' }, { cmd: 'agent.send', engine: 'codex' }])('does not include ACP initialization or provider waits in native draining: %j', async (frame) => {
    const daemonCommands = createDaemonCommandDrain()
    const response = deferred()
    const operation = vi.fn(() => response.promise)
    const sendError = vi.fn()
    const handle = compile<(ws: unknown, msg: string) => void>(`${extract(standalone, 'handleCommand')}\n${extract(standalone, 'dispatchCommand')}\nreturn handleCommand;`, {
      daemonCommands, cmdAcpStart: operation, cmdAcpOp: operation, sendError, resolveAgentCommand,
      logMsg: vi.fn(), BRIDGE_ALLOWED_COMMANDS: new Set(),
    })
    handle({}, JSON.stringify({ id: 1, ...frame }))
    await daemonCommands.close()
    handle({}, JSON.stringify({ id: 2, cmd: 'acpStart' }))
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sendError).toHaveBeenCalledWith({}, 2, expect.stringContaining('shutting down'))
    response.resolve()
    await response.promise
  })

  it.each(['cmdAcpStart', 'cmdAcpOp', 'cmdAcpStop'])('%s returns the operation promise to the dispatcher', async (name) => {
    const operation = deferred<Record<string, unknown>>()
    const handle = compile<(ws: unknown, id: number, cmd: unknown, op?: string) => Promise<unknown>>(`${extract(standalone, name)}\nreturn ${name};`, {
      acp: { acpStart: () => operation.promise, acpOp: () => operation.promise, acpStop: () => operation.promise },
      sendOk: vi.fn(), sendError: vi.fn(), safeSend: vi.fn(), GATEWAY_SOCK_PATH: '/fixture/gateway',
      GATEWAY_SHIM_DIR: '/fixture/bin', process: { env: {} }, path,
      sessionStartGate: new DaemonSessionGate(), cancelledStartPath: () => '/fixture/cancelled-starts/fixture',
      fs: { existsSync: () => false },
    })
    const result = handle({}, 1, { sid: 'fixture', cwd: '/fixture' }, 'getState')
    expect(typeof result?.then).toBe('function')
    operation.resolve({ ok: true })
    await result
  })
})
