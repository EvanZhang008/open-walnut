import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-stop-delivery'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import * as daemonConnections from '../../src/providers/daemon-connection.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { sessionStops, SessionStopSupersededError } from '../../src/core/sessions/session-stop.js'
import { enqueueMessage, getQueue, markProcessing, resetCache, loadQueue, unparkMessage } from '../../src/core/session-message-queue.js'
import { bus } from '../../src/core/event-bus.js'

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const SID = '10000000-0000-4000-8000-000000000101'
const HOST = 'stop-test-host'

function manager() {
  const send = vi.fn(async (command: string) => command === 'stop'
    ? { ok: true, stopped: true } : { ok: true })
  const connection = { connected: true, send, hasCapability: () => false }
  vi.spyOn(daemonConnections, 'getConnectedDaemonConnection').mockReturnValue(connection as never)
  const transport = new RemoteSessionManager(SID, HOST, { hostname: '127.0.0.1' })
  Object.assign(transport, { conn: connection, _sid: SID, _hasPipe: true })
  return { transport, send, connection }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'stop-task', 'test', WALNUT_HOME, { host: HOST, initialProcessStatus: 'idle' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  bus.clear()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('stop supersedes delayed delivery', () => {
  it('does not turn a fenced send into a broken FIFO or start a new turn', async () => {
    const { transport, send } = manager()
    const entered = gate<void>()
    const upload = gate<string>()
    vi.spyOn(transport as never, 'prepareOutbound').mockImplementation((async () => {
      entered.resolve()
      return upload.promise
    }) as never)
    const onDispatch = vi.fn()
    const writing = transport.writeMessage('old message', { stopFence: null, onDispatch })
    const rejected = expect(writing).rejects.toBeInstanceOf(SessionStopSupersededError)
    try {
      await entered.promise
      expect((await sessionStops.request(SID)).state).toBe('confirmed')
    } finally { upload.resolve('old message') }
    await rejected
    expect(onDispatch).not.toHaveBeenCalled()
    expect(send.mock.calls.map(([command]) => command)).toEqual(['stop'])
  })

  it('keeps a cancelled mid-turn batch parked through re-entry and a server queue reload', async () => {
    const { transport, send } = manager()
    const entered = gate<void>()
    const upload = gate<string>()
    vi.spyOn(transport as never, 'prepareOutbound').mockImplementation((async () => {
      entered.resolve()
      return upload.promise
    }) as never)
    const queued = await enqueueMessage(SID, 'old batch')
    const session = new ClaudeCodeSession('stop-task', 'test', '/bin/true')
    Object.assign(session, { claudeSessionId: SID, _transport: transport, _processStatus: 'idle', _active: true })
    const runner = new SessionRunner('/bin/true')
    const internals = runner as unknown as {
      sessions: Map<string, ClaudeCodeSession>
      injectMidTurn(sid: string): Promise<void>
      processNext(sid: string): Promise<void>
    }
    internals.sessions.set('stop-task', session)
    const injecting = internals.injectMidTurn(SID)
    try {
      await entered.promise
      expect((await sessionStops.request(SID)).state).toBe('confirmed')
    } finally { upload.resolve('old batch') }
    await injecting
    await vi.waitFor(async () => expect((await getQueue(SID))[0].status).toBe('parked'))
    await loadQueue()
    await internals.processNext(SID)
    expect(await getQueue(SID)).toEqual([expect.objectContaining({ id: queued.id, message: 'old batch', status: 'parked' })])
    expect(send.mock.calls.map(([command]) => command)).toEqual(['stop'])
    expect(session.processStatus).toBe('idle')
    expect((await getSessionByClaudeId(SID))?.process_status).toBe('stopped')
  })

  it('parks an old enqueue that lands after stop; new input and explicit Retry use the new fence', async () => {
    manager()
    const oldFence = await sessionStops.fence(SID)
    const stop = await sessionStops.request(SID)
    expect(stop.state).toBe('confirmed')
    vi.spyOn(sessionStops, 'fence').mockResolvedValueOnce(oldFence)
    const old = await enqueueMessage(SID, 'late old message')
    const fresh = await enqueueMessage(SID, 'new user message')
    expect(old.stopFence).toBeUndefined()
    expect(fresh.stopFence).toBe(stop.id)
    resetCache()
    expect((await markProcessing(SID, stop.id)).map((row) => row.id)).toEqual([fresh.id])
    expect((await getQueue(SID)).find((row) => row.id === old.id)?.status).toBe('parked')
    expect(await unparkMessage(SID, old.id)).toBe(true)
    resetCache()
    expect((await markProcessing(SID, stop.id)).map((row) => row.id)).toEqual([old.id])
    expect((await getQueue(SID)).find((row) => row.id === old.id)?.stopFence).toBe(stop.id)
  })

  it('refuses new input while the host has not acknowledged the saved stop', async () => {
    const { connection, send } = manager()
    connection.connected = false
    expect((await sessionStops.request(SID)).state).toBe('pending')
    await expect(enqueueMessage(SID, 'not yet')).rejects.toBeInstanceOf(SessionStopSupersededError)
    expect(await getQueue(SID)).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('runs the new-turn callback inside the checked dispatch, before the reply can arrive', async () => {
    const { transport, send } = manager()
    vi.spyOn(transport as never, 'prepareOutbound').mockResolvedValue('next message' as never)
    const events: string[] = []
    send.mockImplementation(async () => { events.push('daemon reply'); return { ok: true } })
    expect(await transport.writeMessage('next message', {
      stopFence: null, onDispatch: () => { events.push('new turn') },
    })).toBe(true)
    expect(events).toEqual(['new turn', 'daemon reply'])
  })

  it('interrupting a turn preserves supervision and retains the pipe when stop is unconfirmed', async () => {
    const { transport, send } = manager()
    await transport.interrupt()
    expect(send).toHaveBeenCalledWith('stop', { sid: SID, reason: 'maintenance' }, 10_000)
    expect(transport.hasPipe).toBe(false)
    Object.assign(transport, { _hasPipe: true })
    send.mockResolvedValueOnce({ ok: true, stopped: false })
    await expect(transport.interrupt()).rejects.toThrow('Daemon did not confirm the stop')
    expect(transport.hasPipe).toBe(true)
  })
})
