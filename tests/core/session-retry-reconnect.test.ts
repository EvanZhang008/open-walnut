/**
 * Retry = RECONNECT, never a synthesized message (user report 2026-09-03:
 * "I only click retry and it sends a `continue` to the session. I don't want it.
 * I just wanted to connect.").
 *
 * The dead-process + resumable-conversation + EMPTY-queue path used to enqueue
 * the literal word 'continue', i.e. Retry started a turn with a prompt the human
 * never wrote. It must now relabel the record to a resumable state, clear the
 * stale error, and send NOTHING.
 *
 * Real session-tracker + real message queue over an isolated tmp WALNUT_HOME —
 * the "no message was sent" assertion is only worth anything against the real
 * queue. Only liveness, the JSONL probe and the send call are instrumented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-retry-reconnect'))

// Hoisted so the mock factories below (which vitest lifts above every import)
// can read it AND the tests can steer it per case.
const stub = vi.hoisted(() => ({
  /** Liveness — the branch selector at the top of retrySession. */
  alive: false,
  /** Conversation pre-flight: present by default (the --resume-eligible shape). */
  jsonlPath: '/fake/projects/x/conv.jsonl' as string | null,
  /** Every sendMessageToSession call, recorded at the call site. */
  sendCalls: [] as unknown[][],
}))

vi.mock('../../src/core/session-file-reader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/session-file-reader.js')>()),
  findLocalJsonlPath: async () => stub.jsonlPath,
}))
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => stub.alive,
}))

// Partial mock: everything real EXCEPT that every sendMessageToSession call is
// recorded. This is the assertion the user's complaint is about, so it is pinned
// at the call site, not inferred from the queue's end state alone.
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return {
    ...actual,
    sendMessageToSession: (...args: Parameters<typeof actual.sendMessageToSession>) => {
      stub.sendCalls.push(args)
      return actual.sendMessageToSession(...args)
    },
  }
})

import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js'

// A folder that exists on every host: Retry offers a new folder for a gone one (folder-gone.ts).
const CWD = os.tmpdir()
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import {
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { sendMessageToSession, getQueue, enqueueMessage, markProcessing, resetCache, settledLineUuid, removeTaken, loadQueue, revertToPending, editMessage, parkMessages, type QueuedMessage } from '../../src/core/session-message-queue.js'
import { STOP_PARKED_REASON } from '../../src/core/relay-fates.js'
import { retrySession, restartSession } from '../../src/core/sessions/session-lifecycle.js'
import { ClaudeCodeSession, sessionRunner } from '../../src/providers/claude-code-session.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { awaitLine, lineRows, hasAnsweringLines, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { fateOf } from '../../src/core/relay-fates.js'
import { mutateStore, readQueueFileFresh } from '../../src/core/session-queue-store.js'
import { repairCancelledTaken } from '../../src/core/session-queue-lines.js'
import { sessionStops } from '../../src/core/sessions/session-stop.js'

/** Every SESSION_SEND / SESSION_START the retry emits (a turn can only start
 *  through one of these two). */
function captureLaunchEvents(): { events: BusEvent[]; stop: () => void } {
  const events: BusEvent[] = []
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_SEND || event.name === EventNames.SESSION_START) {
      events.push(event)
    }
  })
  return { events, stop: () => bus.unsubscribe('session-runner') }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  resetCache()
  resetLineConsumption()
  stub.sendCalls.length = 0
  stub.alive = false
  stub.jsonlPath = '/fake/projects/x/conv.jsonl'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetCache()
  resetLineConsumption()
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('retrySession — dead process, resumable conversation, EMPTY queue', () => {
  it('sends NO message and leaves the record resumable, stamped as user intent', async () => {
    const sid = 'retry-rc-empty'
    await createSessionRecord(sid, 'task-rc1', 'proj', CWD, { initialProcessStatus: 'error' })
    await updateSessionRecord(sid, {
      errorMessage: 'Connection lost — unable to reach remote host',
      status_reason: 'remote_unreachable',
      status_changed_by: 'health-monitor',
    } as never)

    const cap = captureLaunchEvents()
    try {
      const res = await retrySession(sid)
      expect(res.status).toBe('resumable')
      expect(res).toMatchObject({ sessionId: sid })

      // The complaint, pinned three ways: no send call, nothing in the queue,
      // and no turn-starting bus event.
      expect(stub.sendCalls).toEqual([])
      expect(await getQueue(sid)).toHaveLength(0)
      expect(cap.events).toHaveLength(0)
    } finally {
      cap.stop()
    }

    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('stopped')   // resumable: --resume on next send
    expect(rec?.errorMessage ?? null).toBeNull()  // the stale banner text is gone
    expect(rec?.archived).not.toBe(true)          // conversation preserved
    // The stamp is the contract: ('user','retry_reconnect') is category-② in
    // session-snapshot-gate (never gated) and makes the row intentional-terminal
    // in session-snapshot-apply, so a death snapshot can't re-redden it.
    expect(rec?.status_changed_by).toBe('user')
    expect(rec?.status_reason).toBe('retry_reconnect')
  })

  it('never injects the word "continue" (the exact regression)', async () => {
    const sid = 'retry-rc-nocontinue'
    await createSessionRecord(sid, 'task-rc2', 'proj', CWD, { initialProcessStatus: 'error' })

    await retrySession(sid)

    const queue = await getQueue(sid)
    expect(queue.some((m) => m.message === 'continue')).toBe(false)
    expect(stub.sendCalls).toEqual([])
  })
})

describe('retrySession — dead process with a NON-empty pending queue', () => {
  it("re-sends the user's ORIGINAL message and injects nothing", async () => {
    const sid = 'retry-rc-queued'
    await createSessionRecord(sid, 'task-rc3', 'proj', CWD, { initialProcessStatus: 'error' })
    await sendMessageToSession(sid, 'original user prompt', { taskId: 'task-rc3', source: 'ui' })
    stub.sendCalls.length = 0 // the seed above is the user's own send, not the retry's

    const cap = captureLaunchEvents()
    try {
      const res = await retrySession(sid)
      expect(res).toMatchObject({ status: 'resuming', sessionId: sid, restoredMessages: 1 })

      // processNext is re-triggered (that is what delivers the ORIGINAL text) …
      expect(cap.events).toHaveLength(1)
      expect(cap.events[0]?.name).toBe(EventNames.SESSION_SEND)
      // … and nothing new was enqueued on top of it.
      expect(stub.sendCalls).toEqual([])
    } finally {
      cap.stop()
    }

    const queue = await getQueue(sid)
    expect(queue.map((m) => m.message)).toEqual(['original user prompt'])
  })

  it('revives a PARKED row instead of reporting a retry that did nothing', async () => {
    const sid = 'retry-rc-parked'
    await createSessionRecord(sid, 'task-rc4', 'proj', CWD, { initialProcessStatus: 'error' })
    await sendMessageToSession(sid, 'parked prompt', { taskId: 'task-rc4' })
    const seeded = await getQueue(sid)
    const { parkMessages } = await import('../../src/core/session-message-queue.js')
    await parkMessages(seeded, 'test-park')
    stub.sendCalls.length = 0

    const res = await retrySession(sid)
    expect(res).toMatchObject({ status: 'resuming', restoredMessages: 1 })
    const queue = await getQueue(sid)
    expect(queue[0]?.status).toBe('pending')
    expect(stub.sendCalls).toEqual([])
  })
})

describe('Retry finishes a failed hard Stop cancellation without sending it again', () => {
  const SID = 'retry-stop-cancel'
  type Inner = {
    _queuedLines: Map<string, Array<{ message: string; messageId: string }>>
    _cancelReturnsInFlight: Map<string, Promise<boolean>>
    handleStreamLine(line: string): void
    returnCancelledLines(uuids: unknown[]): Promise<boolean>
  }

  async function stoppedWithFailedDelete(withMarkers: boolean, phoneIds = false) {
    await createSessionRecord(SID, 'retry-stop-task', 'proj', CWD, { initialProcessStatus: 'running' })
    await enqueueMessage(SID, 'cancelled first', phoneIds ? { id: 'qm-mobile-cancel-first' } : {})
    await enqueueMessage(SID, 'cancelled second', phoneIds ? { id: 'qm-mobile-cancel-second' } : {})
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('retry-stop-task', 'proj', '/bin/true')
    const transport = { interrupt: vi.fn(async () => {}), writeMessage: vi.fn(async () => true), stopTail: vi.fn(), detach: vi.fn(), deletePipe: vi.fn(), flushTail: vi.fn(), fileSize: 0, hasPipe: true }
    Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true, _transport: transport, _active: true, _processStatus: 'running' })
    const inner = session as unknown as Inner
    awaitLine(SID, uuid, batch)
    if (withMarkers) inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    const cancelled: string[][] = []
    const delivered: string[][] = []
    bus.subscribe('retry-stop-observer', (event) => {
      const ids = [...((event.data as { messageIds?: string[] }).messageIds ?? [])]
      if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push(ids)
      if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) delivered.push(ids)
    }, { global: true })
    const rename = fsp.rename.bind(fsp)
    let failures = 0
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fsp.readFile(from, 'utf8')).queues[SID]?.length) {
        failures++
        throw new Error('injected cancelled queue deletion failure')
      }
      return rename(from, to)
    })
    await session.stopProcess()
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.process_status).toBe('stopped'))
    expect(failures).toBe(1)
    expect(await getQueue(SID)).toEqual(batch)
    expect((await readQueueFileFresh()).queues[SID]).toEqual(batch)
    expect(lineRows(SID, uuid)).toEqual(batch)
    expect(cancelled).toEqual([])
    expect(delivered).toEqual([])
    return { session, inner, batch, uuid, fault, failures: () => failures, transport, cancelled, delivered }
  }

  it.each([true, false])('real Retry completes the retained cancellation (markers=%s), once and without FIFO resend', async (markers) => {
    const h = await stoppedWithFailedDelete(markers)
    const cap = captureLaunchEvents()
    try {
      h.fault.mockRestore()
      const result = await retrySession(SID)
      expect(result).toEqual({ status: 'resumable', sessionId: SID })
      expect(await getQueue(SID)).toEqual([])
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
      expect(cap.events).toEqual([])
      expect(h.transport.writeMessage).not.toHaveBeenCalled()
      expect(h.delivered).toEqual([])
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(h.cancelled).toHaveLength(1)
      expect(cap.events).toEqual([])
    } finally {
      h.fault.mockRestore()
      cap.stop()
    }
  })

  it('two real Retry requests join the same retained cancellation deletion and never resend it', async () => {
    const h = await stoppedWithFailedDelete(true)
    h.fault.mockRestore()
    const cap = captureLaunchEvents()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { entered = r })
    const rename = fsp.rename.bind(fsp)
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fsp.readFile(from, 'utf8')).queues[SID]?.length) {
        entered()
        await held
      }
      return rename(from, to)
    })
    try {
      let resolved = 0
      const first = retrySession(SID).then((r) => { resolved++; return r })
      const second = retrySession(SID).then((r) => { resolved++; return r })
      await started
      await new Promise((r) => setTimeout(r, 50))
      expect(resolved).toBe(0)
      expect(h.cancelled).toEqual([])
      expect(cap.events).toEqual([])
      release()
      expect(await Promise.all([first, second])).toEqual([
        { status: 'resumable', sessionId: SID }, { status: 'resumable', sessionId: SID },
      ])
      expect(await getQueue(SID)).toEqual([])
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
      expect(h.transport.writeMessage).not.toHaveBeenCalled()
      expect(cap.events).toEqual([])
    } finally {
      release()
      gate.mockRestore()
      cap.stop()
    }
  })

  it.each(['started', 'completed'])('real Retry never cancels or re-sends a line the CLI reported %s', async (state) => {
    const h = await stoppedWithFailedDelete(true)
    h.fault.mockRestore()
    h.inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state }))
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    const cap = captureLaunchEvents()
    try {
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(h.cancelled).toEqual([])
      expect(cap.events).toEqual([])
      expect(h.transport.writeMessage).not.toHaveBeenCalled()
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
    } finally { cap.stop() }
  })

  it('answer-held started overtakes a failed cancellation before real Retry without losing its rows or phone fate', async () => {
    const h = await stoppedWithFailedDelete(true, true)
    h.fault.mockRestore()
    Object.assign(h.transport, { judgesAnswers: true })
    h.inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'started' }))
    expect(hasAnsweringLines(SID)).toBe(true)
    expect(await getQueue(SID)).toEqual(h.batch)
    const cap = captureLaunchEvents()
    try {
      await retrySession(SID)
      expect(await getQueue(SID)).toEqual(h.batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(h.batch)
      expect(hasAnsweringLines(SID)).toBe(true)
      expect(fateOf(await readQueueFileFresh(), h.batch[0].id)).not.toBe('removed')
      expect(await settledLineUuid(h.batch[0].id)).toBeUndefined()
      expect(h.cancelled).toEqual([])
      h.inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'completed' }))
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid)
      expect(fateOf(await readQueueFileFresh(), h.batch[0].id)).toBe('taken')
      expect(h.cancelled).toEqual([])
      expect(h.transport.writeMessage).not.toHaveBeenCalled()
    } finally { cap.stop() }
  })

  it('answer-held started overtakes a held durable cancellation write without losing its rows or phone fate', async () => {
    await createSessionRecord(SID, 'held-started-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, 'phone line held for answer', { id: 'qm-mobile-held-started' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('held-started-task', 'proj', '/bin/true')
    Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true, _transport: { judgesAnswers: true, hasPipe: true, stopTail: vi.fn(), fileSize: 0 }, _processStatus: 'stopped' })
    const inner = session as unknown as Inner
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { entered = r })
    const rename = fsp.rename.bind(fsp)
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fsp.readFile(from, 'utf8')).queues[SID]?.length) { entered(); await held }
      return rename(from, to)
    })
    try {
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' }))
      await started
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }))
      expect(hasAnsweringLines(SID)).toBe(true)
      release()
      await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
      expect(await getQueue(SID)).toEqual(batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(batch)
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).not.toBe('removed')
      await retrySession(SID)
      expect(await getQueue(SID)).toEqual(batch)
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(batch[0].id)).toBe(uuid)
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).toBe('taken')
    } finally { release(); gate.mockRestore() }
  })

  it.each(['while its queue write is held', 'after it cleared'] as const)('a hard Stop of a line its persisted Stop parked keeps the old uuid, and a late completed frame settles it (%s)', async (timing) => {
    await createSessionRecord(SID, 'parked-late-task', 'proj', CWD, { initialProcessStatus: 'running' })
    await enqueueMessage(SID, 'parked line the CLI still ran', { id: 'qm-mobile-parked-late' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    await parkMessages(batch, STOP_PARKED_REASON, true)
    const session = new ClaudeCodeSession('parked-late-task', 'proj', '/bin/true')
    const transport = { interrupt: vi.fn(async () => {}), writeMessage: vi.fn(async () => true), stopTail: vi.fn(), detach: vi.fn(), deletePipe: vi.fn(), flushTail: vi.fn(), fileSize: 0, hasPipe: true }
    Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true, _transport: transport, _active: true, _processStatus: 'running' })
    const inner = session as unknown as Inner
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    const cancelled: string[][] = []
    bus.subscribe('parked-late-observer', (event) => {
      if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
    }, { global: true })
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const started = new Promise<void>((r) => { entered = r })
    let gated = timing !== 'while its queue write is held'
    const rename = fsp.rename.bind(fsp)
    // Held at the Stop's first step on the queue file: its lock (a rename into
    // `<queue>.lock`). The store writes nothing for a mutation that changes nothing
    // (session-queue-store.ts persist), and this Stop leaves the parked row as it is,
    // so the file itself may never be renamed; the lock always is.
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (!gated && String(to).startsWith(SESSION_QUEUE_FILE)) { gated = true; entered(); await held }
      return rename(from, to)
    })
    try {
      const stopping = session.stopProcess()
      if (timing === 'while its queue write is held') {
        await started
        inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
        release()
        await stopping
      } else {
        await stopping
        await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
        // A guessed cancellation (hard Stop) leaves the parked row under its own uuid.
        expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status, r.lineUuid])).toEqual([[batch[0].id, 'parked', uuid]])
        inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
      }
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(batch[0].id)).toBe(uuid)
      expect(cancelled).toEqual([])
      expect(transport.writeMessage).not.toHaveBeenCalled()
    } finally { release(); gate.mockRestore() }
  })

  it.each(['no reader', 'no answer'] as const)('Retry of a retained parked row with %s is not stuck on 503, and a late completion still settles its old uuid', async (reader) => {
    await createSessionRecord(SID, 'parked-retry-task', 'proj', CWD, { initialProcessStatus: 'running' })
    const row = await enqueueMessage(SID, 'retained until explicit Retry', { id: 'qm-mobile-parked-retry' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    await parkMessages(batch, STOP_PARKED_REASON, true)
    const session = new ClaudeCodeSession('parked-retry-task', 'proj', '/bin/true')
    const transport = { interrupt: vi.fn(async () => {}), writeMessage: vi.fn(async () => true), stopTail: vi.fn(), detach: vi.fn(), deletePipe: vi.fn(), flushTail: vi.fn(), fileSize: 0, hasPipe: true,
      ...(reader === 'no answer' ? { readLineFate: vi.fn(async () => null) } : {}) }
    Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true, _transport: transport, _active: true, _processStatus: 'running' })
    const inner = session as unknown as Inner
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    const cap = captureLaunchEvents()
    try {
      await session.stopProcess()
      expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status, r.lineUuid])).toEqual([[row.id, 'parked', uuid]])
      expect(await retrySession(SID)).toMatchObject({ status: 'resuming', sessionId: SID, restoredMessages: 1 })
      expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineUuid])).toEqual([[row.id, 'pending', uuid]])
      expect(cap.events.filter((e) => e.name === EventNames.SESSION_SEND)).toHaveLength(1)
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(row.id)).toBe(uuid)
      expect(transport.writeMessage).not.toHaveBeenCalled()
    } finally { cap.stop() }
  })

  it('an exit draining a registry-only line during Stop acknowledgement never leaves it to be resent by real Retry', async () => {
    await createSessionRecord(SID, 'stop-exit-task', 'proj', CWD, { initialProcessStatus: 'running' })
    await enqueueMessage(SID, 'cut first line stopped before it ran')
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('stop-exit-task', 'proj', '/bin/true')
    const inner = session as unknown as Inner & { handleQuietProcessExit(): void }
    let confirm!: () => void
    let requested!: () => void
    const acknowledgement = new Promise<void>((r) => { confirm = r })
    const stopRequested = new Promise<void>((r) => { requested = r })
    const transport = { hasPipe: true, fileSize: 0, stopTail: vi.fn(), interrupt: vi.fn(async () => { requested(); await acknowledgement }), writeMessage: vi.fn(async () => true) }
    Object.assign(session, { claudeSessionId: SID, _transport: transport, _sawCommandLifecycle: true, _processStatus: 'running', _active: true })
    awaitLine(SID, uuid, batch)
    expect(inner._queuedLines.size).toBe(0)
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    const cancelled: string[][] = []
    bus.subscribe('web-ui', (e) => { if (e.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((e.data as { messageIds: string[] }).messageIds)]) })
    const cap = captureLaunchEvents()
    try {
      const stopping = session.stopProcess()
      await stopRequested
      inner.handleQuietProcessExit()
      await session.lineReclaimSettled()
      // During an in-flight Stop the registration remains held, never requeued.
      expect((await getQueue(SID)).map((r) => r.status)).toEqual(['processing'])
      confirm()
      await stopping
      await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.process_status).toBe('stopped'))
      expect(await getQueue(SID)).toEqual([])
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      await vi.waitFor(() => expect(cancelled).toEqual([batch.map((r) => r.id)]))
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(cap.events.filter((e) => e.name === EventNames.SESSION_SEND)).toEqual([])
      expect(transport.writeMessage).not.toHaveBeenCalled()
    } finally { confirm(); cap.stop() }
  })

  it('a refused Stop releases its tentative scope and preserves a recorded natural exit for normal reclaim', async () => {
    await createSessionRecord(SID, 'refused-stop-task', 'proj', CWD, { initialProcessStatus: 'running' })
    await enqueueMessage(SID, 'natural exit must not become cancellation')
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('refused-stop-task', 'proj', '/bin/true')
    const inner = session as unknown as Inner & { handleQuietProcessExit(): void }
    let refuse!: () => void
    let entered!: () => void
    const requested = new Promise<void>((r) => { entered = r })
    const acknowledgement = new Promise<void>((r) => { refuse = r })
    Object.assign(session, { claudeSessionId: SID, _processStatus: 'running', _active: true, _sawCommandLifecycle: true,
      _transport: { stopTail: vi.fn(), fileSize: 0, interrupt: async () => { entered(); await acknowledgement; throw new Error('stop refused') } } })
    awaitLine(SID, uuid, batch)
    const cancelled: unknown[] = []
    bus.subscribe('web-ui', (e) => { if (e.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push(e.data) })
    const stopping = session.stopProcess()
    const outcome = expect(stopping).rejects.toThrow('stop refused')
    await requested
    inner.handleQuietProcessExit()
    expect((await getQueue(SID)).map((r) => r.status)).toEqual(['processing'])
    refuse()
    await outcome
    await session.lineReclaimSettled()
    expect((await getQueue(SID)).map((r) => r.status)).toEqual(['pending'])
    expect(lineRows(SID, uuid)).toEqual([])
    expect(cancelled).toEqual([])
    expect(await session.retryCancelledLines()).toBe(true)
    expect((await getQueue(SID)).map((r) => r.status)).toEqual(['pending'])
  })

  it('a reused row id with a new line uuid is not removed by an old cancellation Retry', async () => {
    const h = await stoppedWithFailedDelete(true)
    h.fault.mockRestore()
    const newUuid = '33333333-3333-4333-8333-333333333333'
    await mutateStore((s) => { for (const row of s.queues[SID]) { row.lineUuid = newUuid; row.message = 'new delivery with reused id' } }, true, true)
    const replacement = await getQueue(SID)
    await retrySession(SID)
    expect(await getQueue(SID)).toEqual(replacement)
    expect((await readQueueFileFresh()).queues[SID]).toEqual(replacement)
    expect(h.cancelled).toEqual([])
  })

  it('a duplicate cancellation joining a held delete shares the taken takeover and preserves the answer hold', async () => {
    await createSessionRecord(SID, 'duplicate-started-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, 'duplicate cancellation phone line', { id: 'qm-mobile-duplicate-held' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('duplicate-started-task', 'proj', '/bin/true')
    Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true, _processStatus: 'stopped', _transport: { judgesAnswers: true, hasPipe: true, stopTail: vi.fn(), fileSize: 0 } })
    const inner = session as unknown as Inner
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const enteredDelete = new Promise<void>((r) => { entered = r })
    const rename = fsp.rename.bind(fsp)
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fsp.readFile(from, 'utf8')).queues[SID]?.length) { entered(); await held }
      return rename(from, to)
    })
    try {
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' }))
      await enteredDelete
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' }))
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }))
      release()
      await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
      expect(await getQueue(SID)).toEqual(batch)
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).not.toBe('removed')
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(batch[0].id)).toBe(uuid)
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).toBe('taken')
    } finally { release(); gate.mockRestore() }
  })

  it('a refused Stop settles a completed takeover instead of stranding its deferred durable release', async () => {
    await createSessionRecord(SID, 'refused-completed-task', 'proj', CWD, { initialProcessStatus: 'running' })
    await enqueueMessage(SID, 'completed while Stop was refused', { id: 'qm-mobile-refused-completed' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('refused-completed-task', 'proj', '/bin/true')
    const inner = session as unknown as Inner
    let refuse!: () => void
    let entered!: () => void
    const requested = new Promise<void>((r) => { entered = r })
    const ack = new Promise<void>((r) => { refuse = r })
    Object.assign(session, { claudeSessionId: SID, _processStatus: 'running', _active: true, _sawCommandLifecycle: true,
      _transport: { judgesAnswers: true, fileSize: 0, stopTail: vi.fn(), interrupt: async () => { entered(); await ack; throw new Error('stop refused') } } })
    awaitLine(SID, uuid, batch)
    const stopping = session.stopProcess()
    const outcome = expect(stopping).rejects.toThrow('stop refused')
    await requested
    inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }))
    inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
    refuse()
    await outcome
    expect(await getQueue(SID)).toEqual([])
    expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
    expect(await settledLineUuid(batch[0].id)).toBe(uuid)
    expect(fateOf(await readQueueFileFresh(), batch[0].id)).toBe('taken')
  })

  it('an empty duplicate receipt after started shares failed repair ownership through real Retry', async () => {
    await createSessionRecord(SID, 'empty-receipt-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, 'answer-held phone line after empty receipt', { id: 'qm-mobile-empty-receipt' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('empty-receipt-task', 'proj', '/bin/true')
    const transport = { judgesAnswers: true, hasPipe: true, fileSize: 0, stopTail: vi.fn(), writeMessage: vi.fn(async () => true) }
    Object.assign(session, { claudeSessionId: SID, _transport: transport, _processStatus: 'stopped', _sawCommandLifecycle: true })
    const inner = session as unknown as Inner
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const deletionEntered = new Promise<void>((r) => { entered = r })
    let failRepair = true
    let failures = 0
    const rename = fsp.rename.bind(fsp)
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) {
        const state = JSON.parse(await fsp.readFile(from, 'utf8'))
        if (!state.queues[SID]?.length) { entered(); await held }
        else if (failRepair) { failures++; throw new Error('injected taken repair replacement failure') }
      }
      return rename(from, to)
    })
    const cancelled: unknown[] = []
    bus.subscribe('web-ui', (e) => { if (e.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push(e.data) })
    const cap = captureLaunchEvents()
    try {
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' }))
      await deletionEntered
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }))
      expect(lineRows(SID, uuid)).toEqual([])
      expect(inner._queuedLines.size).toBe(0)
      const duplicate = inner.returnCancelledLines([uuid]) // the real interrupt receipt's cancelled list
      release()
      await vi.waitFor(() => expect(failures).toBe(1))
      await duplicate
      await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(cancelled).toEqual([])
      expect(cap.events).toEqual([])
      failRepair = false
      await retrySession(SID)
      expect(await getQueue(SID)).toEqual(batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(batch)
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).toBe('taken')
      expect(transport.writeMessage).not.toHaveBeenCalled()
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(batch[0].id)).toBe(uuid)
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).toBe('taken')
      expect(cancelled).toEqual([])
      expect(transport.writeMessage).not.toHaveBeenCalled()
    } finally { release(); gate.mockRestore(); cap.stop() }
  })

  it('real Retry leaves an unrelated processing row untouched and only sends new pending work', async () => {
    const h = await stoppedWithFailedDelete(true)
    h.fault.mockRestore()
    const other = await enqueueMessage(SID, 'unrelated processing')
    await markProcessing(SID)
    const pending = await enqueueMessage(SID, 'new pending work')
    const cap = captureLaunchEvents()
    try {
      await retrySession(SID)
      const queue = await getQueue(SID)
      expect(queue.map((r) => [r.id, r.status])).toEqual([[other.id, 'processing'], [pending.id, 'pending']])
      expect((await markProcessing(SID)).map((r) => r.id)).toEqual([pending.id])
      await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
      expect(h.transport.writeMessage).not.toHaveBeenCalled()
    } finally { cap.stop() }
  })

  it('a failed soft Stop receipt falls back to the confirmed process stop, then real Retry finishes cancellation', async () => {
    await createSessionRecord(SID, 'retry-soft-task', 'proj', CWD, { initialProcessStatus: 'running' })
    await enqueueMessage(SID, 'soft Stop cancelled line')
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('retry-soft-task', 'proj', '/bin/true')
    const inner = session as unknown as Inner
    const transport = { hasPipe: true, fileSize: 0, stopTail: vi.fn(), interrupt: vi.fn(async () => {}), writeMessage: vi.fn(async () => true), writeRaw: vi.fn(async () => true) }
    Object.assign(session, { claudeSessionId: SID, _sawCommandLifecycle: true, _transport: transport, _active: true, _processStatus: 'running' })
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    transport.writeRaw.mockImplementation(async (raw: string) => {
      const request = JSON.parse(raw)
      inner.handleStreamLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled: [uuid] } } }))
      return true
    })
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    const rename = fsp.rename.bind(fsp)
    let faults = 0
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fsp.readFile(from, 'utf8')).queues[SID]?.length) { faults++; throw new Error('injected soft Stop cancellation failure') }
      return rename(from, to)
    })
    const cancelled: unknown[] = []
    bus.subscribe('web-ui', (e) => { if (e.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push(e.data) })
    try {
      await session.interrupt()
      expect(transport.interrupt).toHaveBeenCalledTimes(1)
      expect(faults).toBe(2) // receipt deletion, then the confirmed hard Stop's attempt
      expect(session.processStatus).toBe('stopped')
      await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.process_status).toBe('stopped'))
      expect(await getQueue(SID)).toEqual(batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(batch)
      expect(cancelled).toEqual([])
      fault.mockRestore()
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(await getQueue(SID)).toEqual([])
      await vi.waitFor(() => expect(cancelled).toHaveLength(1))
      expect(transport.writeMessage).not.toHaveBeenCalled()
    } finally { fault.mockRestore() }
  })

  it('a lifecycle-only confirmed cancellation persists through write failure and real Retry, without a receipt or hard Stop', async () => {
    await createSessionRecord(SID, 'retry-lifecycle-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, 'lifecycle cancelled line')
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('retry-lifecycle-task', 'proj', '/bin/true')
    const inner = session as unknown as Inner
    const transport = { interrupt: vi.fn(async () => {}), writeMessage: vi.fn(async () => true), stopTail: vi.fn(), fileSize: 0, hasPipe: true }
    Object.assign(session, { claudeSessionId: SID, _transport: transport, _processStatus: 'stopped', _sawCommandLifecycle: true })
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    const rename = fsp.rename.bind(fsp)
    let failures = 0
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !JSON.parse(await fsp.readFile(from, 'utf8')).queues[SID]?.length) { failures++; throw new Error('injected lifecycle-only cancellation failure') }
      return rename(from, to)
    })
    const cancelled: unknown[] = []
    bus.subscribe('web-ui', (e) => { if (e.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push(e.data) })
    const cap = captureLaunchEvents()
    try {
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' }))
      await vi.waitFor(() => expect(failures).toBe(1))
      await vi.waitFor(() => expect(inner._cancelReturnsInFlight.size).toBe(0))
      expect(await getQueue(SID)).toEqual(batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(batch)
      expect(cancelled).toEqual([])
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(failures).toBe(2)
      expect(cap.events).toEqual([])
      fault.mockRestore()
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(await getQueue(SID)).toEqual([])
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      await vi.waitFor(() => expect(cancelled).toHaveLength(1))
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(cancelled).toHaveLength(1)
      expect(transport.interrupt).not.toHaveBeenCalled()
      expect(transport.writeMessage).not.toHaveBeenCalled()
      expect(cap.events).toEqual([])
    } finally { fault.mockRestore(); cap.stop() }
  })

  it('an old soft Stop epoch followed by natural death never cancels a newer registered line on Retry', async () => {
    await createSessionRecord(SID, 'retry-natural-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, 'new turn message that never ran')
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    const session = new ClaudeCodeSession('retry-natural-task', 'proj', '/bin/true')
    Object.assign(session, { claudeSessionId: SID, _processStatus: 'stopped', _stopEpoch: 1, _sawCommandLifecycle: true })
    awaitLine(SID, uuid, batch)
    const inner = session as unknown as Inner
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    expect(await retrySession(SID)).toMatchObject({ status: 'resuming' })
    expect(await getQueue(SID)).toEqual(batch)
    expect((await readQueueFileFresh()).queues[SID]).toEqual(batch)
    expect(lineRows(SID, uuid)).toEqual(batch)
  })

  it('a failed hard Stop scope excludes newer awaited lines even after the same instance is reused', async () => {
    const h = await stoppedWithFailedDelete(true)
    h.fault.mockRestore()
    const other = await enqueueMessage(SID, 'new registered turn')
    const newer = await markProcessing(SID)
    const uuid = newer[0].lineUuid!
    awaitLine(SID, uuid, newer)
    h.inner._queuedLines.set(uuid, newer.map((r) => ({ message: r.message, messageId: r.id })))
    await retrySession(SID)
    expect((await getQueue(SID)).map((r) => r.id)).toEqual([other.id])
    expect((await readQueueFileFresh()).queues[SID].map((r) => r.id)).toEqual([other.id])
    expect(lineRows(SID, uuid)).toEqual(newer)
    await vi.waitFor(() => expect(h.cancelled).toEqual([h.batch.map((r) => r.id)]))
  })

  it('new send is refused before resetting a failed cancellation, preserves new pending text, and works after real Retry', async () => {
    const h = await stoppedWithFailedDelete(true)
    h.fault.mockRestore()
    const pending = await enqueueMessage(SID, 'new pending user message')
    const generation = h.session.turnGen
    expect(() => h.session.send('new pending user message', CWD, SID)).toThrow('Retry before starting another turn')
    expect(h.session.turnGen).toBe(generation)
    expect(await getQueue(SID)).toHaveLength(3)
    expect((await getQueue(SID)).find((r) => r.id === pending.id)?.status).toBe('pending')
    // The only fake after recovery is the transport's spawn: no CLI or real process.
    const { createSessionManager } = await import('../../src/providers/session-manager.js')
    const managerModule = await import('../../src/providers/session-manager.js')
    const manager = { ...h.transport, detach: vi.fn(), deletePipe: vi.fn(), flushTail: vi.fn(), pid: null, start: vi.fn(async () => { throw new Error('test spawn reached after recovered cancellation') }) }
    const factory = vi.spyOn(managerModule, 'createSessionManager').mockReturnValue(manager as unknown as ReturnType<typeof createSessionManager>)
    try {
      await retrySession(SID)
      expect((await getQueue(SID)).map((r) => r.id)).toEqual([pending.id])
      expect(() => h.session.send('new pending user message', CWD, SID)).not.toThrow()
      expect(factory).toHaveBeenCalled()
      await vi.waitFor(() => expect(manager.start).toHaveBeenCalled())
    } finally { factory.mockRestore() }
  })

  it('every Retry route uses the core cancellation barrier before queue reads or a reconnect kick', () => {
    const lifecycle = readFileSync(path.resolve(__dirname, '../../src/core/sessions/session-lifecycle.ts'), 'utf8')
    const retry = lifecycle.slice(lifecycle.indexOf('export async function retrySession('))
    expect(retry.indexOf('await stopped.retryCancelledLines()')).toBeGreaterThan(0)
    expect(retry.indexOf('await stopped.retryCancelledLines()')).toBeLessThan(retry.indexOf('await getQueue(sessionId)'))
    expect(retry.indexOf('await stopped.retryCancelledLines()')).toBeLessThan(retry.indexOf('EventNames.SESSION_SEND'))
    expect(retry).toMatch(/throw new SessionControlError\('Could not finish cancelling queued messages[^\n]+503\)/)
    const web = readFileSync(path.resolve(__dirname, '../../src/web/routes/sessions.ts'), 'utf8')
    const mobile = readFileSync(path.resolve(__dirname, '../../src/web/routes/session-lifecycle-v1.ts'), 'utf8')
    expect(web).toMatch(/sessionsRouter\.post\('\/:sessionId\/retry'[\s\S]*?await retrySession\(sessionId\)/)
    expect(mobile).toMatch(/retrySession\(sessionId\)/)
  })

  it('real Retry reports a persistent cancellation deletion failure instead of resuming', async () => {
    const h = await stoppedWithFailedDelete(true)
    const cap = captureLaunchEvents()
    try {
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(h.failures()).toBe(2)
      expect(await getQueue(SID)).toEqual(h.batch)
      expect((await readQueueFileFresh()).queues[SID]).toEqual(h.batch)
      expect(h.cancelled).toEqual([])
      expect(h.transport.writeMessage).not.toHaveBeenCalled()
      expect(cap.events).toEqual([])
      expect((await getSessionByClaudeId(SID))?.status_reason).toBe('user_stopped')
    } finally {
      h.fault.mockRestore()
      cap.stop()
    }
  })
})

describe('Retry after a restart trusts the durable cancellation backup a Stop wrote', () => {
  const SID = 'retry-durable-cancel'
  const TEXT = 'cancelled before the restart'
  type Fate = { fate: string; state?: string; answer?: 'yes' | 'pending' } | null
  type Inner = {
    settleLineFate(uuid: string, rows: QueuedMessage[], markers: unknown[], known: { fate: string; state?: string }): void
    handleStreamLine(line: string): void
  }

  /** A Stop's cancellation was written to disk; then the server restarted (no RAM confirmation left). */
  async function cancelledBeforeRestart() {
    await createSessionRecord(SID, 'durable-cancel-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, TEXT, { id: 'qm-mobile-durable-cancel' })
    const batch = await markProcessing(SID)
    const uuid = batch[0].lineUuid!
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch })
    resetCache()
    resetLineConsumption()
    await loadQueue()
    const cancelled: string[][] = []
    bus.subscribe('durable-cancel-observer', (event) => {
      if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
    }, { global: true })
    return { batch, uuid, cancelled }
  }
  const backup = async (uuid: string) => (await readQueueFileFresh()).cancelled?.[SID]?.[uuid]?.rows

  /** A new wrapper for the session, as attachToExisting builds one: it loads the backup, nothing else. */
  async function freshSession(readLineFate?: (uuid: string, ids: string[]) => Promise<Fate>) {
    const session = new ClaudeCodeSession('durable-cancel-task', 'proj', '/bin/true')
    const transport = {
      ...(readLineFate ? { readLineFate: vi.fn(readLineFate) } : {}),
      judgesAnswers: true, hasPipe: true, fileSize: 0, stopTail: vi.fn(),
      writeMessage: vi.fn(async () => true),
      start: vi.fn(async () => { throw new Error('cancellation recovery must not spawn') }),
    }
    Object.assign(session, { claudeSessionId: SID, _processStatus: 'stopped', _transport: transport })
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
    await session.recoverCancelledRows(false)
    return { session, transport, inner: session as unknown as Inner }
  }

  /** No real daemon: only its read-only line fate export answers, and nothing is connected. */
  async function daemonFate(fate: Fate) {
    const connection = await import('../../src/providers/daemon-connection.js')
    vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(null)
    const probe = vi.spyOn(connection, 'probeDaemonSession').mockResolvedValue(null)
    return { read: vi.spyOn(connection, 'readDaemonLineFate').mockResolvedValue(fate as never), probe }
  }

  /** The doubtful row goes through the delivery's own settleLineFate: one resend under a new uuid, then parked. */
  async function resendOnceThenExhaust(session: ClaudeCodeSession, uuid: string) {
    const inner = session as unknown as Inner
    inner.settleLineFate(uuid, await getQueue(SID), [], { fate: 'unanswered', state: 'started' })
    await session.lineReclaimSettled()
    const [resent] = await getQueue(SID)
    expect(resent).toMatchObject({ message: TEXT, status: 'pending', unansweredResent: true })
    expect(resent.lineUuid).not.toBe(uuid)
    expect(resent.lineInDoubt).toBeUndefined()
    const second = await markProcessing(SID)
    expect(second.map((r) => r.lineUuid)).toEqual([resent.lineUuid])
    inner.settleLineFate(resent.lineUuid!, second, [], { fate: 'unanswered', state: 'started' })
    await session.lineReclaimSettled()
    await vi.waitFor(async () => expect((await getQueue(SID)).map((r) => [r.message, r.status])).toEqual([[TEXT, 'parked']]))
  }

  async function expectDoubtfulOriginal(uuid: string) {
    const expected = [{ id: 'qm-mobile-durable-cancel', message: TEXT, status: 'pending', lineUuid: uuid, lineInDoubt: true }]
    expect(await getQueue(SID)).toMatchObject(expected)
    expect((await readQueueFileFresh()).queues[SID]).toMatchObject(expected)
    expect(await backup(uuid)).toBeUndefined()
  }

  async function retryKicksOriginal() {
    const cap = captureLaunchEvents()
    try {
      expect(await retrySession(SID)).toEqual({ status: 'resuming', sessionId: SID, restoredMessages: 1 })
      expect(cap.events.map((e) => [e.name, (e.data as { message?: string }).message])).toEqual([[EventNames.SESSION_SEND, '']])
      expect(stub.sendCalls).toEqual([])
      expect((await getQueue(SID)).some((m) => m.message === 'continue')).toBe(false)
    } finally { cap.stop() }
  }

  it.each([
    ['no line fate reader', undefined],
    ['no answer', async () => null],
    ['cancelled', async () => ({ fate: 'cancelled', state: 'cancelled' })],
    ['dropped', async () => ({ fate: 'dropped', state: 'dropped' })],
  ] as Array<[string, ((uuid: string, ids: string[]) => Promise<Fate>) | undefined]>)('a fresh wrapper with %s finishes Retry without returning the text and keeps the backup', async (_name, read) => {
    const h = await cancelledBeforeRestart()
    const { transport } = await freshSession(read)
    const cap = captureLaunchEvents()
    try {
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      if (read) expect((transport as { readLineFate?: ReturnType<typeof vi.fn> }).readLineFate).toHaveBeenCalledWith(h.uuid, h.batch.map((r) => r.id))
      expect(await getQueue(SID)).toEqual([])
      expect(await backup(h.uuid)).toEqual(h.batch)
      await new Promise((r) => setTimeout(r, 10))
      expect(h.cancelled).toEqual([])
      expect(cap.events).toEqual([])
      expect(transport.writeMessage).not.toHaveBeenCalled()
      expect(transport.start).not.toHaveBeenCalled()
    } finally { cap.stop() }
  })

  it('a fresh wrapper reading completed clears the backup as answered before Retry finishes', async () => {
    const h = await cancelledBeforeRestart()
    const { transport } = await freshSession(async () => ({ fate: 'ran', state: 'completed', answer: 'yes' }))
    expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
    expect(await getQueue(SID)).toEqual([])
    expect(await backup(h.uuid)).toBeUndefined()
    expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid)
    expect(fateOf(await readQueueFileFresh(), h.batch[0].id)).toBe('taken')
    expect(h.cancelled).toEqual([])
    expect(transport.writeMessage).not.toHaveBeenCalled()
  })

  it('a fresh wrapper reading started keeps the original uuid under an answer hold through completion', async () => {
    const h = await cancelledBeforeRestart()
    const { transport, inner } = await freshSession(async () => ({ fate: 'ran', state: 'started', answer: 'pending' }))
    await retrySession(SID)
    expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineUuid])).toEqual(h.batch.map((r) => [r.id, 'processing', h.uuid]))
    expect(await backup(h.uuid)).toBeUndefined()
    expect(hasAnsweringLines(SID)).toBe(true)
    expect(await settledLineUuid(h.batch[0].id)).toBeUndefined()
    inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'completed' }))
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid)
    expect(h.cancelled).toEqual([])
    expect(transport.writeMessage).not.toHaveBeenCalled()
  })

  it('a fresh wrapper reading unanswered puts the original back under its uuid, Retry kicks it, and it resends once', async () => {
    const h = await cancelledBeforeRestart()
    const { session, transport } = await freshSession(async () => ({ fate: 'unanswered', state: 'started' }))
    await retryKicksOriginal()
    await expectDoubtfulOriginal(h.uuid)
    expect(h.cancelled).toEqual([])
    expect(transport.writeMessage).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
    await resendOnceThenExhaust(session, h.uuid)
  })

  it('a completed word while the unanswered query waits wins over the restore', async () => {
    const h = await cancelledBeforeRestart()
    let answer!: (fate: Fate) => void
    const { session, inner } = await freshSession(() => new Promise<Fate>((r) => { answer = r }))
    const recovering = session.recoverCancelledRows(true, true)
    await vi.waitFor(() => expect(answer).toBeDefined())
    inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'completed' }))
    await vi.waitFor(async () => expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid))
    answer({ fate: 'unanswered', state: 'started' })
    await recovering
    await session.lineReclaimSettled()
    expect(await getQueue(SID)).toEqual([])
    expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
    expect(await backup(h.uuid)).toBeUndefined()
  })

  it.each(['before the query', 'queued ahead of the restore write'])('an unanswered restore never touches a reused id sent under a new uuid %s', async (when) => {
    const h = await cancelledBeforeRestart()
    const newUuid = '66666666-6666-4666-8666-666666666666'
    const replacement = h.batch.map((r) => ({ ...r, status: 'processing' as const, lineUuid: newUuid, message: 'new delivery with reused id' }))
    const replace = () => mutateStore((s) => { s.queues[SID] = replacement.map((r) => ({ ...r })) }, true, true)
    if (when === 'before the query') await replace()
    await freshSession(async () => {
      // Not awaited: the queue's write chain runs this before the restore's own transaction.
      if (when !== 'before the query') void replace()
      return { fate: 'unanswered', state: 'started' }
    })
    await retrySession(SID)
    expect(await getQueue(SID)).toEqual(replacement)
    expect((await readQueueFileFresh()).queues[SID]).toEqual(replacement)
    expect(await backup(h.uuid)).toEqual(h.batch)
  })

  it('an unanswered restore whose write fails keeps the backup and Retry answers 503 until storage works', async () => {
    const h = await cancelledBeforeRestart()
    await freshSession(async () => ({ fate: 'unanswered', state: 'started' }))
    const rename = fsp.rename.bind(fsp)
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected unanswered restore failure')
      return rename(from, to)
    })
    const cap = captureLaunchEvents()
    try {
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(await backup(h.uuid)).toEqual(h.batch)
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      expect(cap.events).toEqual([])
      fault.mockRestore()
      cap.stop()
      await retryKicksOriginal()
      await expectDoubtfulOriginal(h.uuid)
    } finally { fault.mockRestore(); cap.stop() }
  })

  it.each(['completed', 'started'])('a %s word while the restore write is held outranks the pending restore', async (state) => {
    const h = await cancelledBeforeRestart()
    const { session, inner, transport } = await freshSession(async () => ({ fate: 'unanswered', state: 'started' }))
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const writing = new Promise<void>((r) => { entered = r })
    let gated = false
    const rename = fsp.rename.bind(fsp)
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !gated) { gated = true; entered(); await held }
      return rename(from, to)
    })
    try {
      const recovering = session.recoverCancelledRows(true, true)
      await writing
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state }))
      release()
      expect(await recovering).toBe(true)
      expect(await backup(h.uuid)).toBeUndefined()
      if (state === 'started') {
        expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineUuid])).toEqual(h.batch.map((r) => [r.id, 'processing', h.uuid]))
        expect(hasAnsweringLines(SID)).toBe(true)
        expect(await settledLineUuid(h.batch[0].id)).toBeUndefined()
        inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'completed' }))
      }
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid)
      expect(fateOf(await readQueueFileFresh(), h.batch[0].id)).toBe('taken')
      expect(h.cancelled).toEqual([])
      expect(transport.writeMessage).not.toHaveBeenCalled()
    } finally { release(); gate.mockRestore() }
  })

  it.each([['started', 'completed'], ['completed', 'started']])('a restore held with %s on its line is never entered by the retry another line\'s %s starts', async (aWord, bWord) => {
    await createSessionRecord(SID, 'durable-cancel-task', 'proj', CWD, { initialProcessStatus: 'stopped' })
    await enqueueMessage(SID, 'line A', { id: 'qm-mobile-line-a' })
    const a = await markProcessing(SID)
    await enqueueMessage(SID, 'line B', { id: 'qm-mobile-line-b' })
    const b = await markProcessing(SID)
    const [uA, uB] = [a[0].lineUuid!, b[0].lineUuid!]
    await removeTaken(SID, a.map((r) => r.id), { ran: false, rows: a })
    await removeTaken(SID, b.map((r) => r.id), { ran: false, rows: b })
    resetCache()
    resetLineConsumption()
    await loadQueue()
    const { session, inner } = await freshSession(async (uuid) => uuid === uA ? { fate: 'unanswered', state: 'started' } : null)
    const internals = session as unknown as { _activeCancellations: Set<unknown>; _pendingCancellations: Map<string, unknown>; _loadedCancellations: Map<string, unknown>; _cancelReturnsInFlight: Map<string, unknown> }
    const scopeA = internals._loadedCancellations.get(uA)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((r) => { release = r })
    const writing = new Promise<void>((r) => { entered = r })
    let gated = false
    const rename = fsp.rename.bind(fsp)
    const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE && !gated) { gated = true; entered(); await held }
      return rename(from, to)
    })
    try {
      const recovering = session.recoverCancelledRows(true, true)
      await writing
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uA, state: aWord }))
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uB, state: bWord }))
      await new Promise((r) => setTimeout(r, 20))
      // B's retry ran finishPendingCancellations: A is still the restore's alone.
      expect(internals._activeCancellations.has(scopeA)).toBe(true)
      expect(internals._pendingCancellations.get(uA)).toBe(scopeA)
      expect(a.some((r) => internals._cancelReturnsInFlight.has(r.id))).toBe(false)
      release()
      await recovering
      await vi.waitFor(async () => expect((await readQueueFileFresh()).cancelled?.[SID]).toBeUndefined())
      for (const [uuid, word, rows] of [[uA, aWord, a], [uB, bWord, b]] as const) {
        if (word !== 'started') continue
        await vi.waitFor(async () => expect((await getQueue(SID)).filter((r) => r.lineUuid === uuid).map((r) => [r.id, r.status])).toEqual(rows.map((r) => [r.id, 'processing'])))
        expect(hasAnsweringLines(SID)).toBe(true)
        inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }))
      }
      await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
      expect(await settledLineUuid(a[0].id)).toBe(uA)
      expect(await settledLineUuid(b[0].id)).toBe(uB)
    } finally { release(); gate.mockRestore() }
  })

  describe('with no live wrapper (the runner reads the daemon fate itself)', () => {
    const runnerSessions = () => (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
    afterEach(() => { runnerSessions().delete('durable-cancel-task') })

    /** The real attach entry with only the constructor stubbed: no daemon, no process. */
    function stubAttach(transport: Record<string, unknown>, before: () => Promise<void> = async () => {}) {
      vi.spyOn(sessionRunner as unknown as { isSessionStillAlive(record: unknown): Promise<boolean> }, 'isSessionStillAlive').mockResolvedValue(true)
      const candidate = new ClaudeCodeSession('durable-cancel-task', 'proj', '/bin/true')
      Object.assign(candidate, { claudeSessionId: SID, _processStatus: 'stopped', _transport: { hasPipe: true, fileSize: 0, stopTail: vi.fn(), detach: vi.fn(), ...transport } })
      const construct = vi.spyOn(ClaudeCodeSession, 'attachToExisting').mockImplementation(async () => {
        await before()
        await candidate.recoverCancelledRows(false)
        return candidate
      })
      return { candidate, construct }
    }

    it('a real attach during a held wrapper-less restore write builds its wrapper only after the write', async () => {
      const h = await cancelledBeforeRestart()
      await daemonFate({ fate: 'unanswered', state: 'started' })
      const seen: Array<{ saved: unknown; queue: QueuedMessage[] }> = []
      const { candidate, construct } = stubAttach({}, async () => { seen.push({ saved: await backup(h.uuid), queue: await getQueue(SID) }) })
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((r) => { release = r })
      const writing = new Promise<void>((r) => { entered = r })
      let gated = false
      const rename = fsp.rename.bind(fsp)
      const gate = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === SESSION_QUEUE_FILE && !gated) { gated = true; entered(); await held }
        return rename(from, to)
      })
      try {
        const recovering = sessionRunner.recoverCancelledForSession(SID, true)
        await writing
        const attaching = sessionRunner.getOrAttachLiveSession(SID)
        await new Promise((r) => setTimeout(r, 20))
        expect(construct).not.toHaveBeenCalled()
        release()
        expect(await recovering).toBe(true)
        expect(await attaching).toBe(candidate)
        expect(seen).toEqual([{ saved: undefined, queue: [expect.objectContaining({ status: 'pending', lineUuid: h.uuid, lineInDoubt: true })] }])
        expect((candidate as unknown as { _loadedCancellations: Map<string, unknown> })._loadedCancellations.size).toBe(0)
      } finally { release(); gate.mockRestore() }
    })

    it('an attach in flight when the daemon answers unanswered gets the backup, which its wrapper keeps', async () => {
      const h = await cancelledBeforeRestart()
      const { read } = await daemonFate({ fate: 'unanswered', state: 'started' })
      let finish!: () => void
      const attachHeld = new Promise<void>((r) => { finish = r })
      const wrapperRead = vi.fn(async () => ({ fate: 'cancelled', state: 'cancelled' }))
      const { candidate, construct } = stubAttach({ readLineFate: wrapperRead, judgesAnswers: true }, () => attachHeld)
      try {
        const attaching = sessionRunner.getOrAttachLiveSession(SID)
        await vi.waitFor(() => expect(construct).toHaveBeenCalledOnce())
        const recovering = sessionRunner.recoverCancelledForSession(SID, true)
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
        await new Promise((r) => setTimeout(r, 20))
        expect(await backup(h.uuid)).toEqual(h.batch)
        expect(await getQueue(SID)).toEqual([])
        finish()
        expect(await attaching).toBe(candidate)
        expect(await recovering).toBe(true)
        expect(wrapperRead).toHaveBeenCalledWith(h.uuid, h.batch.map((r) => r.id))
        expect(await backup(h.uuid)).toEqual(h.batch)
        expect(await getQueue(SID)).toEqual([])
      } finally { finish() }
    })

    it.each(['cold resume', 'reinitialize'])('a %s wrapper is built only after a wrapper-less backup write, and is the sid\'s owner before it reads', async (entry) => {
      const h = await cancelledBeforeRestart()
      await daemonFate(null)
      if (entry === 'cold resume') await enqueueMessage(SID, 'new message after the restart')
      vi.spyOn(sessionRunner as unknown as { isSessionStillAlive(record: unknown): Promise<boolean> }, 'isSessionStillAlive').mockResolvedValue(false)
      const managers = await import('../../src/providers/session-manager.js')
      vi.spyOn(managers, 'ensureLocalDaemon').mockResolvedValue(undefined as never)
      const factory = vi.spyOn(managers, 'createSessionManager').mockImplementation(() => { throw new Error('no transport in this test') })
      const built = vi.spyOn(ClaudeCodeSession, 'forResume')
      const runner = sessionRunner as unknown as {
        cancelRepairWrites: Map<string, Promise<void>>
        nativeResumeWrapper(record: unknown, key: string): Promise<unknown>
        processNextNow(sid: string): Promise<void>
        performNativeReinitialize(sid: string): Promise<void>
        clearActiveProcessing(sid: string): void
      }
      const helper = vi.spyOn(runner, 'nativeResumeWrapper')
      // The send stub reads what the new wrapper would read first: the backup, and who owns the sid.
      const sent: Array<{ saved: unknown; owner: boolean }> = []
      const send = vi.spyOn(ClaudeCodeSession.prototype, 'send').mockImplementation(function (this: ClaudeCodeSession) {
        const owner = sessionRunner.findSessionByClaudeId(SID) === this
        void backup(h.uuid).then((saved) => sent.push({ saved, owner }))
      } as never)
      // A wrapper-less restore write in flight, in the runner's own barrier map.
      let finishWrite!: () => void
      const write = new Promise<void>((r) => { finishWrite = r })
      runner.cancelRepairWrites.set(SID, write)
      try {
        const running = entry === 'cold resume' ? runner.processNextNow(SID) : runner.performNativeReinitialize(SID)
        void running.catch(() => {})
        await vi.waitFor(() => expect(helper).toHaveBeenCalledOnce())
        await new Promise((r) => setTimeout(r, 20))
        expect(built).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(sessionRunner.findSessionByClaudeId(SID)).toBeUndefined()
        await repairCancelledTaken(SID, h.batch, false, true, { pending: true })
        runner.cancelRepairWrites.delete(SID)
        finishWrite()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(built).toHaveBeenCalledOnce()
        expect(sent).toEqual([{ saved: undefined, owner: true }])
        expect(factory).not.toHaveBeenCalled()
        if (entry === 'cold resume') await running
      } finally {
        finishWrite()
        runner.cancelRepairWrites.delete(SID)
        runner.clearActiveProcessing(SID)
      }
    })

    it('every wrapper the runner builds for an old sid comes from the one resume helper', () => {
      const source = readFileSync(path.resolve(__dirname, '../../src/providers/claude-code-session.ts'), 'utf8')
      const owners = [...source.matchAll(/new ClaudeCodeSession\(/g)].map((m) => {
        const signatures = [...source.slice(0, m.index).matchAll(/\n {2}(?:static |private |async )*(\w+)\s*\(/g)]
        return signatures[signatures.length - 1]?.[1]
      })
      // forResume (old sid, no read), attachToExisting (old sid, through attachNativeRecord), handleStart (a new id or a fork only).
      expect(owners.sort()).toEqual(['attachToExisting', 'forResume', 'handleStart'])
      const runner = source.slice(source.indexOf('export class SessionRunner'))
      expect(runner.match(/ClaudeCodeSession\.forResume\(/g)).toHaveLength(1)
      expect(runner.match(/this\.nativeResumeWrapper\(/g)).toHaveLength(2)
      const helper = runner.slice(runner.indexOf('private async nativeResumeWrapper('))
      expect(helper.slice(0, helper.indexOf('\n  }\n'))).toMatch(/this\.claimFreeSid\(record\.claudeSessionId, \(\) => \{\s*const session = ClaudeCodeSession\.forResume\(/)
      // A fork's spawn never reads the source sid's backup.
      expect(source).toMatch(/if \(isResume && resumeSessionId\) \{\s*this\.claudeSessionId = resumeSessionId\s*if \(!\(await this\.recoverCancelledRows\(\)\)\)/)
    })

    it('a wrapper attached while the query waited owns the backup: the old fate never touches it', async () => {
      const h = await cancelledBeforeRestart()
      const connection = await import('../../src/providers/daemon-connection.js')
      vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(null)
      const live = new ClaudeCodeSession('durable-cancel-task', 'proj', '/bin/true')
      const liveRead = vi.fn(async () => ({ fate: 'cancelled', state: 'cancelled' }))
      Object.assign(live, { claudeSessionId: SID, _processStatus: 'stopped', _transport: { readLineFate: liveRead, judgesAnswers: true, hasPipe: true, fileSize: 0, stopTail: vi.fn() } })
      await live.recoverCancelledRows(false)
      vi.spyOn(connection, 'readDaemonLineFate').mockImplementation(async () => {
        vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? live : undefined)
        return { fate: 'unanswered', state: 'started' }
      })
      expect(await sessionRunner.recoverCancelledForSession(SID, true)).toBe(true)
      expect(liveRead).toHaveBeenCalledWith(h.uuid, h.batch.map((r) => r.id))
      expect(await getQueue(SID)).toEqual([])
      expect(await backup(h.uuid)).toEqual(h.batch)
    })

    it('an unanswered restore whose write fails keeps the backup and Retry answers 503 until storage works', async () => {
      const h = await cancelledBeforeRestart()
      await daemonFate({ fate: 'unanswered', state: 'started' })
      const rename = fsp.rename.bind(fsp)
      const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected no-wrapper restore failure')
        return rename(from, to)
      })
      try {
        await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
        expect(await backup(h.uuid)).toEqual(h.batch)
        expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
        fault.mockRestore()
        await retryKicksOriginal()
        await expectDoubtfulOriginal(h.uuid)
      } finally { fault.mockRestore() }
    })

    it.each([
      ['no answer', null],
      ['cancelled', { fate: 'cancelled', state: 'cancelled' }],
      ['dropped', { fate: 'dropped', state: 'dropped' }],
    ] as Array<[string, Fate]>)('%s keeps the backup and Retry finishes without returning the text', async (_name, fate) => {
      const h = await cancelledBeforeRestart()
      const { read } = await daemonFate(fate)
      const cap = captureLaunchEvents()
      try {
        expect(sessionRunner.findSessionByClaudeId(SID)).toBeUndefined()
        expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
        expect(read).toHaveBeenCalledWith(null, SID, h.uuid, h.batch.map((r) => r.id))
        expect(await getQueue(SID)).toEqual([])
        expect(await backup(h.uuid)).toEqual(h.batch)
        expect(h.cancelled).toEqual([])
        expect(cap.events).toEqual([])
        expect(sessionRunner.findSessionByClaudeId(SID)).toBeUndefined()
      } finally { cap.stop() }
    })

    it('completed clears the backup as answered', async () => {
      const h = await cancelledBeforeRestart()
      await daemonFate({ fate: 'ran', state: 'completed', answer: 'yes' })
      expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      expect(await getQueue(SID)).toEqual([])
      expect(await backup(h.uuid)).toBeUndefined()
      expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid)
    })

    it('started with no live proof keeps the backup and Retry answers 503', async () => {
      const h = await cancelledBeforeRestart()
      const { probe } = await daemonFate({ fate: 'ran', state: 'started', answer: 'pending' })
      await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(probe).toHaveBeenCalledWith('__local__', SID)
      expect(await getQueue(SID)).toEqual([])
      expect(await backup(h.uuid)).toEqual(h.batch)
    })

    it('unanswered puts the original back under its uuid, Retry kicks it, and the delivery resends it once', async () => {
      const h = await cancelledBeforeRestart()
      await daemonFate({ fate: 'unanswered', state: 'started' })
      await retryKicksOriginal()
      await expectDoubtfulOriginal(h.uuid)
      expect(h.cancelled).toEqual([])
      // The next process's delivery settles the old uuid's fate, as processNext's write would.
      const session = new ClaudeCodeSession('durable-cancel-task', 'proj', '/bin/true')
      Object.assign(session, { claudeSessionId: SID, _processStatus: 'stopped', _transport: { stopTail: vi.fn(), hasPipe: false, fileSize: 0 } })
      await resendOnceThenExhaust(session, h.uuid)
    })
  })

  describe('an unbound transport, and a Stop before the resume is sent', () => {
    const KEY = 'durable-cancel-task'
    const runnerSessions = () => (sessionRunner as unknown as { sessions: Map<string, ClaudeCodeSession> }).sessions
    afterEach(() => { runnerSessions().delete(KEY) })
    const ANSWERS = ['line-fate-read-v1', 'line-answer-v1']

    /** The connected pool's daemon, scripted: only line.fate answers, nothing dials or starts. */
    async function poolDaemon(reply: Record<string, unknown>, caps = ANSWERS, stopReply?: Record<string, unknown>) {
      const conn = {
        connected: true,
        hasCapability: (c: string) => caps.includes(c),
        send: vi.fn(async (cmd: string) => {
          // A scripted stop answer: no process exists and no signal is sent.
          if (cmd === 'stop' && stopReply) return stopReply
          if (cmd !== 'line.fate') throw new Error(`no ${cmd} in this test`)
          return reply
        }),
      }
      const connection = await import('../../src/providers/daemon-connection.js')
      vi.spyOn(connection, 'getConnectedDaemonConnection').mockReturnValue(conn as never)
      vi.spyOn(connection, 'probeDaemonSession').mockResolvedValue(null)
      return conn
    }

    /** A wrapper whose transport is a real RemoteSessionManager not started yet, so unbound. */
    async function unboundSession() {
      const session = new ClaudeCodeSession(KEY, 'proj', '/bin/true')
      Object.assign(session, { claudeSessionId: SID, _processStatus: 'stopped', _transport: new RemoteSessionManager(SID, '__local__', null) })
      await session.recoverCancelledRows(false)
      return session
    }

    /** The real cold-resume entry with every spawn path stubbed; the spawn prompt is held until released. */
    async function coldResumeHeldAtPrompt(fail = false) {
      vi.spyOn(sessionRunner as unknown as { isSessionStillAlive(record: unknown): Promise<boolean> }, 'isSessionStillAlive').mockResolvedValue(false)
      const managers = await import('../../src/providers/session-manager.js')
      vi.spyOn(managers, 'ensureLocalDaemon').mockResolvedValue(undefined as never)
      const factory = vi.spyOn(managers, 'createSessionManager').mockImplementation(() => { throw new Error('no transport in this test') })
      const send = vi.spyOn(ClaudeCodeSession.prototype, 'send').mockImplementation((() => {}) as never)
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      const runner = sessionRunner as unknown as { resumeSpawnPrompt(...args: unknown[]): Promise<string | undefined>; processNextNow(sid: string): Promise<void>; clearActiveProcessing(sid: string): void }
      const prompt = vi.spyOn(runner, 'resumeSpawnPrompt').mockImplementation(async () => {
        await held
        if (fail) throw new Error('injected prompt failure')
        return undefined
      })
      return { factory, send, release: () => release(), prompt, run: () => runner.processNextNow(SID), clear: () => runner.clearActiveProcessing(SID) }
    }

    it('an unbound wrapper asks the connected pool, and an unanswered old line goes back ahead of a newer one', async () => {
      const h = await cancelledBeforeRestart()
      const newer = await enqueueMessage(SID, 'newer message after the restart')
      const session = await unboundSession()
      const conn = await poolDaemon({ ok: true, fate: 'unanswered', state: 'started' })
      expect(await session.recoverCancelledRows(true, true)).toBe(true)
      expect(conn.send).toHaveBeenCalledWith('line.fate', { sid: SID, uuid: h.uuid, messageIds: h.batch.map((r) => r.id) }, 10_000)
      expect((await getQueue(SID)).map((r) => r.id)).toEqual([h.batch[0].id, newer.id])
      expect((await markProcessing(SID)).map((r) => [r.id, r.lineUuid])).toEqual([[h.batch[0].id, h.uuid]])
    })

    it.each([
      ['completed', { ok: true, fate: 'ran', state: 'completed', answer: 'yes' }, ANSWERS, true],
      ['started from a daemon without line-answer-v1 (taken is delivered)', { ok: true, fate: 'ran', state: 'started' }, ['line-fate-read-v1'], true],
      ['started with no answer from a daemon with line-answer-v1 (malformed)', { ok: true, fate: 'ran', state: 'started' }, ANSWERS, false],
      ['started pending with no bound transport to hold its answer', { ok: true, fate: 'ran', state: 'started', answer: 'pending' }, ANSWERS, false],
    ] as Array<[string, Record<string, unknown>, string[], boolean]>)('an unbound wrapper reading %s', async (_name, reply, caps, cleared) => {
      const h = await cancelledBeforeRestart()
      const session = await unboundSession()
      await poolDaemon(reply, caps)
      expect(await session.recoverCancelledRows(true, true)).toBe(cleared)
      expect(await getQueue(SID)).toEqual([])
      expect(hasAnsweringLines(SID)).toBe(false)
      if (cleared) {
        expect(await backup(h.uuid)).toBeUndefined()
        expect(await settledLineUuid(h.batch[0].id)).toBe(h.uuid)
      } else expect(await backup(h.uuid)).toEqual(h.batch)
    })

    it.each([
      ['legacy started (taken is delivered)', { ok: true, fate: 'ran', state: 'started' }, ['line-fate-read-v1'], true],
      ['malformed started', { ok: true, fate: 'ran', state: 'started' }, ANSWERS, false],
    ] as Array<[string, Record<string, unknown>, string[], boolean]>)('with no wrapper, Retry reading %s', async (_name, reply, caps, cleared) => {
      const h = await cancelledBeforeRestart()
      await poolDaemon(reply, caps)
      if (cleared) expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      else await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(await backup(h.uuid)).toEqual(cleared ? undefined : h.batch)
      expect(await getQueue(SID)).toEqual([])
    })

    it.each([
      ['a pending answer', { ok: true, fate: 'ran', state: 'started', answer: 'pending' }, false],
      ['no answer', { ok: false }, true],
    ] as Array<[string, Record<string, unknown>, boolean]>)('real Retry on a named wrapper before its send reads the pool: %s', async (_name, reply, ok) => {
      const h = await cancelledBeforeRestart()
      await poolDaemon(reply)
      const record = (await getSessionByClaudeId(SID))!
      runnerSessions().set(KEY, ClaudeCodeSession.forResume(record, '/bin/true'))
      if (ok) expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
      else await expect(retrySession(SID)).rejects.toMatchObject({ statusCode: 503 })
      expect(await backup(h.uuid)).toEqual(h.batch)
      expect(await getQueue(SID)).toEqual([])
    })

    it('a cold resume whose preparation fails leaves no named wrapper behind, and Retry then reads the backup itself', async () => {
      const h = await cancelledBeforeRestart()
      await poolDaemon({ ok: false })
      const newer = await enqueueMessage(SID, 'message whose resume fails to prepare')
      const cold = await coldResumeHeldAtPrompt(true)
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        expect(sessionRunner.findSessionByClaudeId(SID)).toBeDefined()
        cold.release()
        await running
        expect(sessionRunner.findSessionByClaudeId(SID)).toBeUndefined()
        expect(cold.send).not.toHaveBeenCalled()
        await vi.waitFor(async () => expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[newer.id, 'pending']]))
        expect(await retrySession(SID)).toMatchObject({ status: 'resuming', sessionId: SID })
        expect(await backup(h.uuid)).toEqual(h.batch)
      } finally { cold.release(); cold.clear() }
    })

    it('a reinitialize whose preparation fails removes only the wrapper it built', async () => {
      await cancelledBeforeRestart()
      await poolDaemon({ ok: false })
      const cold = await coldResumeHeldAtPrompt(true)
      const runner = sessionRunner as unknown as { performNativeReinitialize(sid: string): Promise<void> }
      const restarting = runner.performNativeReinitialize(SID)
      await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
      expect(sessionRunner.findSessionByClaudeId(SID)).toBeDefined()
      cold.release()
      await expect(restarting).rejects.toThrow('injected prompt failure')
      expect(sessionRunner.findSessionByClaudeId(SID)).toBeUndefined()
      expect(cold.send).not.toHaveBeenCalled()
      expect(cold.factory).not.toHaveBeenCalled()
    })

    it.each([false, true])('a Stop while the cold resume prepares sends nothing and returns that exact batch once (delete fails first=%s)', async (failFirst) => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const row = await enqueueMessage(SID, 'stopped before its resume was sent', { id: 'qm-mobile-stop-window' })
      const cancelled: string[][] = []
      bus.subscribe('stop-window-observer', (event) => {
        if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
      }, { global: true })
      const cold = await coldResumeHeldAtPrompt()
      const rename = fsp.rename.bind(fsp)
      let failing = false
      const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (failing && String(to) === SESSION_QUEUE_FILE) throw new Error('injected unwritten cancellation failure')
        return rename(from, to)
      })
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        const wrapper = sessionRunner.findSessionByClaudeId(SID)!
        await wrapper.interrupt()
        failing = failFirst
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        expect(cold.factory).not.toHaveBeenCalled()
        if (failFirst) {
          await new Promise((r) => setTimeout(r, 10))
          expect(cancelled).toEqual([])
          expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status])).toEqual([[row.id, 'processing']])
          failing = false
          expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
        }
        await vi.waitFor(() => expect(cancelled).toEqual([[row.id]]))
        expect(await getQueue(SID)).toEqual([])
        expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
        expect(await retrySession(SID)).toEqual({ status: 'resumable', sessionId: SID })
        expect(cancelled).toEqual([[row.id]])
      } finally { cold.release(); fault.mockRestore(); cold.clear() }
    })

    /** Queue-cancellation, batch-completed and batch-failed events, by message ids. */
    function observeBatch() {
      const cancelled: string[][] = []
      const completed: string[][] = []
      const failed: string[][] = []
      bus.subscribe('cold-stop-observer', (event) => {
        const ids = [...((event.data as { messageIds?: string[] }).messageIds ?? [])]
        if (event.name === EventNames.SESSION_QUEUED_CANCELLED) cancelled.push(ids)
        if (event.name === EventNames.SESSION_BATCH_COMPLETED) completed.push(ids)
        if (event.name === EventNames.SESSION_BATCH_FAILED) failed.push(ids)
      }, { global: true })
      return { cancelled, completed, failed }
    }

    /** Queue file writes that fail while `state.failing` is set. */
    function queueWrites() {
      const rename = fsp.rename.bind(fsp)
      const state = { failing: false }
      const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (state.failing && String(to) === SESSION_QUEUE_FILE) throw new Error('injected queue write failure')
        return rename(from, to)
      })
      return { state, fault }
    }

    /** A Stop's backup on disk for a session whose record is gone. */
    async function backupWithoutRecord() {
      await enqueueMessage(SID, TEXT, { id: 'qm-mobile-durable-cancel' })
      const batch = await markProcessing(SID)
      await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch })
      return batch
    }

    const interruptNative = (sid: string) => (sessionRunner as unknown as { interruptNativeSession(sid: string): Promise<void> }).interruptNativeSession(sid)
    const fileRows = async () => (await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status])

    /** An existing wrapper whose transport outlived its process: unbound, or a pipe gone from an old spawn. Its write, Stop and process stop are stubbed. */
    async function staleWrapper(shape: 'unbound' | 'no pipe') {
      const wrapper = ClaudeCodeSession.forResume((await getSessionByClaudeId(SID))!, '/bin/true')
      const transport = { fileSize: 0, stopTail: vi.fn(), detach: vi.fn(), stop: vi.fn(async () => {}), ...(shape === 'unbound' ? { bound: false, hasPipe: true } : { hasPipe: false }) }
      Object.assign(wrapper, { _transport: transport, ...(shape === 'no pipe' ? { _spawnTs: Date.now() - 3_600_000 } : {}) })
      const internals = wrapper as unknown as { _stopEpoch: number }
      // The daemon refuses the write: nothing reads the pipe any more.
      const write = vi.spyOn(wrapper, 'writeMessage').mockResolvedValue(false)
      const interrupt = vi.spyOn(wrapper, 'interrupt').mockImplementation(async () => { internals._stopEpoch++ })
      runnerSessions().set(KEY, wrapper)
      return { wrapper, transport, write, interrupt }
    }

    /** Holds the delivery after markProcessing, before it looks at any wrapper or writes. */
    function holdBeforeWrite() {
      const runner = sessionRunner as unknown as { resolveResumeArgs(sid: string): Promise<unknown> }
      const real = runner.resolveResumeArgs.bind(runner)
      let open!: () => void
      const gate = new Promise<void>((r) => { open = r })
      let entered = false
      vi.spyOn(runner, 'resolveResumeArgs').mockImplementation(async (sid: string) => { entered = true; await gate; return real(sid) })
      return { open: () => open(), entered: () => entered }
    }

    it('a lost record is rebuilt from the JSONL before the backup check, once, and the delivery goes on', async () => {
      await backupWithoutRecord()
      await enqueueMessage(SID, 'sent after the record was lost')
      const { read } = await daemonFate(null)
      const recovery = await import('../../src/core/sessions/session-record-recovery.js')
      const rebuild = vi.spyOn(recovery, 'recoverSessionRecordFromJsonl').mockImplementation(async () => {
        await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
        return getSessionByClaudeId(SID)
      })
      const cold = await coldResumeHeldAtPrompt()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        expect(read).toHaveBeenCalled()
        cold.release()
        await running
        expect(rebuild).toHaveBeenCalledOnce()
        expect(cold.send).toHaveBeenCalledOnce()
      } finally { cold.release(); cold.clear() }
    })

    it('a record nothing can rebuild is not held behind the backup check: the existing no-record path parks the batch', async () => {
      await backupWithoutRecord()
      const newer = await enqueueMessage(SID, 'sent to a session with no record')
      const { read } = await daemonFate(null)
      const recovery = await import('../../src/core/sessions/session-record-recovery.js')
      const rebuild = vi.spyOn(recovery, 'recoverSessionRecordFromJsonl').mockResolvedValue(null)
      const cold = await coldResumeHeldAtPrompt()
      try {
        await cold.run()
        expect(rebuild).toHaveBeenCalledOnce()
        expect(read).not.toHaveBeenCalled()
        expect(cold.prompt).not.toHaveBeenCalled()
        expect(cold.send).not.toHaveBeenCalled()
        expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[newer.id, 'parked']])
      } finally { cold.release(); cold.clear() }
    })

    it('a Stop while a resume prepares on an existing wrapper sends nothing and returns that exact batch once', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const wrapper = ClaudeCodeSession.forResume((await getSessionByClaudeId(SID))!, '/bin/true')
      runnerSessions().set(KEY, wrapper)
      const row = await enqueueMessage(SID, 'stopped before the existing wrapper resumed', { id: 'qm-mobile-existing-stop' })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        expect(sessionRunner.findSessionByClaudeId(SID)).toBe(wrapper)
        await interruptNative(SID)
        expect(seen.completed).toEqual([])
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        expect(cold.factory).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(seen.cancelled).toEqual([[row.id]]))
        expect(seen.completed).toEqual([[row.id]])
        expect(await fileRows()).toBeUndefined()
      } finally { cold.release(); cold.clear() }
    })

    it.each([false, true])('the runner Stop while a new wrapper prepares settles the batch only once its cancellation is durable (delete fails=%s)', async (fails) => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const row = await enqueueMessage(SID, 'stopped through the runner', { id: 'qm-mobile-runner-stop' })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      const writes = queueWrites()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        await interruptNative(SID)
        // No batch-completed before the cancellation is on disk: it would drop the optimistic rows.
        expect(seen.completed).toEqual([])
        writes.state.failing = fails
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        await new Promise((r) => setTimeout(r, 10))
        if (fails) {
          expect(seen.cancelled).toEqual([])
          expect(seen.completed).toEqual([])
          expect(await fileRows()).toEqual([[row.id, 'processing']])
        } else {
          expect(seen.cancelled).toEqual([[row.id]])
          expect(seen.completed).toEqual([[row.id]])
          expect(await fileRows()).toBeUndefined()
        }
      } finally { cold.release(); writes.fault.mockRestore(); cold.clear() }
    })

    it('a Restart while a cold resume prepares is refused with 409, and the batch goes out once', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      await enqueueMessage(SID, 'delivered while Restart was pressed')
      const cold = await coldResumeHeldAtPrompt()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        await expect(sessionRunner.reinitialize(SID)).rejects.toMatchObject({ statusCode: 409, extra: { code: 'preparing' } })
        expect(cold.prompt).toHaveBeenCalledOnce()
        cold.release()
        await running
        expect(cold.send).toHaveBeenCalledOnce()
        expect(cold.send.mock.calls[0]![0]).not.toBe('')
      } finally { cold.release(); cold.clear() }
    })

    it('a reinitialize of an existing wrapper stopped while it prepares never starts the process', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const wrapper = ClaudeCodeSession.forResume((await getSessionByClaudeId(SID))!, '/bin/true')
      runnerSessions().set(KEY, wrapper)
      const cold = await coldResumeHeldAtPrompt()
      try {
        const restarting = sessionRunner.reinitialize(SID)
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        await wrapper.interrupt()
        cold.release()
        await expect(restarting).rejects.toThrow('stopped before the new process was started')
        expect(cold.send).not.toHaveBeenCalled()
        expect(sessionRunner.findSessionByClaudeId(SID)).toBe(wrapper)
      } finally { cold.release(); cold.clear() }
    })

    it('a persisted Stop during the prepare whose delete fails: the row stays parked across a restart and is not sent again', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false }, [...ANSWERS, 'owner-home-v1'], { ok: true, stopped: true })
      const row = await enqueueMessage(SID, 'stopped by a persisted Stop', { id: 'qm-mobile-persisted-stop' })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      const writes = queueWrites()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        const stop = await sessionStops.request(SID)
        expect(stop.state).toBe('confirmed')
        writes.state.failing = true
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        await new Promise((r) => setTimeout(r, 10))
        expect(seen.cancelled).toEqual([])
        expect(await fileRows()).toEqual([[row.id, 'parked']])
        // A restart: the cancellation held in memory is gone and the queue is read from disk.
        writes.state.failing = false
        runnerSessions().delete(KEY)
        resetCache()
        resetLineConsumption()
        await loadQueue()
        expect(await markProcessing(SID, stop.id)).toEqual([])
        expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[row.id, 'parked']])
        expect(cold.send).not.toHaveBeenCalled()
      } finally { cold.release(); writes.fault.mockRestore(); cold.clear() }
    })

    it('a persisted Stop whose park and delete both fail: the delivery fails, the row is kept, and after a restart it waits on the unconfirmed Stop', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false }, [...ANSWERS, 'owner-home-v1'], { ok: true, stopped: true })
      const row = await enqueueMessage(SID, 'stopped while storage fails', { id: 'qm-mobile-storage-stop' })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      const writes = queueWrites()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        writes.state.failing = true
        await expect(sessionStops.request(SID)).rejects.toThrow('injected queue write failure')
        expect((await getSessionByClaudeId(SID))!.stopRequest?.state).toBe('pending')
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        await new Promise((r) => setTimeout(r, 10))
        expect(seen.cancelled).toEqual([])
        expect(seen.completed).toEqual([])
        // Its bubble keeps the text and offers Retry; the pending Stop holds every later send.
        expect(seen.failed).toEqual([[row.id]])
        expect(await fileRows()).toEqual([[row.id, 'processing']])
        writes.state.failing = false
        runnerSessions().delete(KEY)
        resetCache()
        resetLineConsumption()
        await loadQueue()
        expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineInDoubt])).toEqual([[row.id, 'pending', true]])
        await expect(sessionStops.fence(SID)).rejects.toThrow()
        await cold.run()
        expect(cold.send).not.toHaveBeenCalled()
        expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[row.id, 'pending']])
      } finally { cold.release(); writes.fault.mockRestore(); cold.clear() }
    })

    it('a persisted Stop during the prepare that saves: its coordinator parks the row, nothing returns it or drops its bubble, and Retry takes it back', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false }, [...ANSWERS, 'owner-home-v1'], { ok: true, stopped: true })
      const row = await enqueueMessage(SID, 'stopped by a persisted Stop that saved', { id: 'qm-mobile-persisted-stop-ok' })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        expect((await sessionStops.request(SID)).state).toBe('confirmed')
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        await new Promise((r) => setTimeout(r, 10))
        expect(seen.cancelled).toEqual([])
        expect(seen.completed).toEqual([])
        expect(seen.failed).toEqual([[row.id]])
        expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status, r.parkedReason])).toEqual([[row.id, 'parked', STOP_PARKED_REASON]])
        expect(await retrySession(SID)).toMatchObject({ status: 'resuming', sessionId: SID, restoredMessages: 1 })
        expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[row.id, 'pending']])
      } finally { cold.release(); cold.clear() }
    })

    it.each(['unbound', 'no pipe'] as const)('a Stop before the write on a stale existing wrapper (%s) leaves the batch to the delivery, which cancels it durably and sends nothing', async (shape) => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const stale = await staleWrapper(shape)
      const row = await enqueueMessage(SID, `stopped before the write (${shape})`, { id: `qm-mobile-stale-stop-${shape.replace(' ', '-')}` })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      const hold = holdBeforeWrite()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(hold.entered()).toBe(true))
        await interruptNative(SID)
        expect(stale.interrupt).toHaveBeenCalledOnce()
        // A check that read "sent" off the stale transport settled the batch here, before the delivery saw the Stop.
        expect(seen.completed).toEqual([])
        expect(await fileRows()).toEqual([[row.id, 'processing']])
        hold.open()
        cold.release()
        await running
        // Seen before the write: no write to the stale pipe, no stop of its process, no resume.
        expect(stale.write).not.toHaveBeenCalled()
        expect(stale.transport.stop).not.toHaveBeenCalled()
        expect(cold.send).not.toHaveBeenCalled()
        expect(cold.factory).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(seen.cancelled).toEqual([[row.id]]))
        expect(seen.completed).toEqual([[row.id]])
        expect(await fileRows()).toBeUndefined()
      } finally { hold.open(); cold.release(); cold.clear() }
    })

    it.each([
      ['unbound', 'before the write'], ['unbound', 'at the spawn prompt'],
      ['no pipe', 'before the write'], ['no pipe', 'at the spawn prompt'],
    ] as const)('a Restart while a delivery prepares on a stale existing wrapper (%s, %s) is refused before it touches the process, and the batch goes out once', async (shape, point) => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const stale = await staleWrapper(shape)
      await enqueueMessage(SID, `delivered while Restart was pressed (${shape}, ${point})`)
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      const hold = point === 'before the write' ? holdBeforeWrite() : undefined
      const restarts = (sessionRunner as unknown as { nativeSessionReinitializations: Map<string, unknown> }).nativeSessionReinitializations
      try {
        const running = cold.run()
        if (hold) await vi.waitFor(() => expect(hold.entered()).toBe(true))
        else await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        const stops = stale.transport.stop.mock.calls.length
        await expect(sessionRunner.reinitialize(SID)).rejects.toMatchObject({ statusCode: 409, extra: { code: 'preparing' } })
        expect(restarts.has(SID)).toBe(false)
        expect(stale.transport.stop).toHaveBeenCalledTimes(stops)
        expect(seen.completed).toEqual([])
        hold?.open()
        cold.release()
        await running
        expect(stale.write).toHaveBeenCalledOnce()
        expect(cold.send).toHaveBeenCalledOnce()
        expect(cold.send.mock.calls[0]![0]).not.toBe('')
        // Only the delivery's own stop of the dead process, never a second one from the Restart.
        expect(stale.transport.stop).toHaveBeenCalledOnce()
      } finally { hold?.open(); cold.release(); cold.clear() }
    })

    it('a real Restart while a delivery prepares answers 409 before it changes the queue or kicks a send', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      await staleWrapper('unbound')
      const row = await enqueueMessage(SID, 'delivered while the real Restart was pressed', { id: 'qm-mobile-restart-entry' })
      const cold = await coldResumeHeldAtPrompt()
      const cap = captureLaunchEvents()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        const before = (await readQueueFileFresh()).queues[SID]
        expect(before?.map((r) => [r.id, r.status])).toEqual([[row.id, 'processing']])
        await expect(restartSession(SID)).rejects.toMatchObject({ statusCode: 409, extra: { code: 'preparing' } })
        // Reverting 'processing' before the refusal left a row a second delivery could take beside this one.
        expect((await readQueueFileFresh()).queues[SID]).toEqual(before)
        expect((await getQueue(SID)).map((r) => [r.id, r.status, r.lineTries])).toEqual(before!.map((r) => [r.id, r.status, r.lineTries]))
        expect(cap.events).toEqual([])
        cold.release()
        await running
        expect(cold.send).toHaveBeenCalledOnce()
        expect(cold.send.mock.calls[0]![0]).not.toBe('')
      } finally { cap.stop(); cold.release(); cold.clear() }
    })

    it('a real Restart with no delivery preparing puts the old process\'s rows back only after the new process starts, and kicks them once', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      runnerSessions().set(KEY, ClaudeCodeSession.forResume((await getSessionByClaudeId(SID))!, '/bin/true'))
      const inFlight = await enqueueMessage(SID, 'held by the old process', { id: 'qm-mobile-restart-inflight' })
      expect((await markProcessing(SID)).map((r) => r.id)).toEqual([inFlight.id])
      const waiting = await enqueueMessage(SID, 'queued behind it', { id: 'qm-mobile-restart-waiting' })
      vi.spyOn(sessionRunner as unknown as { resumeSpawnPrompt(...args: unknown[]): Promise<string | undefined> }, 'resumeSpawnPrompt').mockResolvedValue(undefined)
      let atSpawn: unknown
      // The idle respawn: no process starts; the spawn callback answers started.
      const send = vi.spyOn(ClaudeCodeSession.prototype, 'send').mockImplementation(((...args: unknown[]) => {
        void getQueue(SID).then((q) => {
          atSpawn = q.map((r) => [r.id, r.status])
          ;(args[13] as (ok: boolean) => void)(true)
        })
      }) as never)
      const cap = captureLaunchEvents()
      try {
        expect(await restartSession(SID)).toEqual({ status: 'restarted', sessionId: SID, pendingMessages: 2 })
        expect(send).toHaveBeenCalledOnce()
        expect(send.mock.calls[0]![0]).toBe('')
        expect(atSpawn).toEqual([[inFlight.id, 'processing'], [waiting.id, 'pending']])
        expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[inFlight.id, 'pending'], [waiting.id, 'pending']])
        expect(cap.events.filter((e) => e.name === EventNames.SESSION_SEND)).toHaveLength(1)
      } finally { cap.stop() }
    })

    it('a live cancelled frame for a line its Stop parked keeps the row and returns nothing; Retry writes it once under a new uuid', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      const row = await enqueueMessage(SID, 'parked by the Stop before the CLI cancelled it', { id: 'qm-mobile-live-parked' })
      const batch = await markProcessing(SID)
      const oldUuid = batch[0]!.lineUuid!
      expect(oldUuid).toBeTruthy()
      // What the persisted Stop's coordinator does (sessionStops park).
      await parkMessages(batch, STOP_PARKED_REASON, true)
      const transport = { writeMessage: vi.fn(async () => true), interrupt: vi.fn(async () => {}), hasPipe: true, fileSize: 0, stopTail: vi.fn(), detach: vi.fn(), stop: vi.fn(async () => {}) }
      const live = new ClaudeCodeSession(KEY, 'proj', '/bin/true')
      Object.assign(live, { claudeSessionId: SID, _sawCommandLifecycle: true, _transport: transport, _active: true, _processStatus: 'idle' })
      const inner = live as unknown as { _queuedLines: Map<string, unknown>; handleStreamLine(line: string): void }
      awaitLine(SID, oldUuid, batch)
      inner._queuedLines.set(oldUuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
      runnerSessions().set(KEY, live)
      const seen = observeBatch()
      inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: oldUuid, state: 'cancelled' }))
      await new Promise((r) => setTimeout(r, 20))
      expect(seen.cancelled).toEqual([])
      expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status, r.parkedReason])).toEqual([[row.id, 'parked', STOP_PARKED_REASON]])
      stub.alive = true
      expect(await retrySession(SID)).toMatchObject({ status: 'resuming', sessionId: SID, restoredMessages: 1 })
      const runner = sessionRunner as unknown as { processNextNow(sid: string): Promise<void>; clearActiveProcessing(sid: string): void }
      try {
        // The real wrapper write: under the old uuid the cancelled record would skip it.
        await runner.processNextNow(SID)
        await vi.waitFor(() => expect(transport.writeMessage).toHaveBeenCalledOnce())
        const uuid = (transport.writeMessage.mock.calls[0] as unknown as [string, { uuid?: string }])[1].uuid
        expect(uuid).toBeTruthy()
        expect(uuid).not.toBe(oldUuid)
      } finally { runner.clearActiveProcessing(SID) }
    })

    it('a Stop record that cannot be read is a delivery failure, not a Stop', async () => {
      await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
      await poolDaemon({ ok: false })
      const row = await enqueueMessage(SID, 'sent while the stop record cannot be read', { id: 'qm-mobile-fence-io' })
      const seen = observeBatch()
      const cold = await coldResumeHeldAtPrompt()
      try {
        const running = cold.run()
        await vi.waitFor(() => expect(cold.prompt).toHaveBeenCalledOnce())
        vi.spyOn(sessionStops, 'fence').mockRejectedValue(new Error('injected stop record read failure'))
        cold.release()
        await running
        expect(cold.send).not.toHaveBeenCalled()
        await new Promise((r) => setTimeout(r, 10))
        expect(seen.cancelled).toEqual([])
        expect((await getQueue(SID)).map((r) => [r.id, r.status])).toEqual([[row.id, 'pending']])
        expect(sessionRunner.findSessionByClaudeId(SID)).toBeUndefined()
      } finally { cold.release(); cold.clear() }
    })

    describe('a same-id row that went out under a new uuid is never the cancelled batch', () => {
      async function replacedSetup() {
        await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'stopped' })
        const wrapper = ClaudeCodeSession.forResume((await getSessionByClaudeId(SID))!, '/bin/true')
        const row = await enqueueMessage(SID, 'original text', { id: 'qm-mobile-replaced' })
        const batch = await markProcessing(SID)
        const replace = () => mutateStore((s) => {
          Object.assign(s.queues[SID]!.find((q) => q.id === row.id)!, { lineUuid: 'replacement-line', message: 'replacement text', status: 'pending' })
        })
        return { wrapper, row, batch, replace }
      }
      const expectReplacementKept = async (id: string) => {
        expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.lineUuid, r.message])).toEqual([[id, 'replacement-line', 'replacement text']])
      }

      it('replaced before the cancellation', async () => {
        const { wrapper, row, batch, replace } = await replacedSetup()
        await replace()
        const seen = observeBatch()
        await wrapper.cancelUnwrittenBatch(batch)
        await new Promise((r) => setTimeout(r, 10))
        expect(seen.cancelled).toEqual([])
        await expectReplacementKept(row.id)
      })

      it('replaced by a queue write still in flight when the cancellation starts', async () => {
        const { wrapper, row, batch, replace } = await replacedSetup()
        const rename = fsp.rename.bind(fsp)
        let open!: () => void
        const gate = new Promise<void>((r) => { open = r })
        let held = false
        vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
          if (!held && String(to) === SESSION_QUEUE_FILE) { held = true; await gate }
          return rename(from, to)
        })
        const replacing = replace()
        let cancelling: Promise<unknown> | undefined
        try {
          await vi.waitFor(() => expect(held).toBe(true))
          const seen = observeBatch()
          cancelling = wrapper.cancelUnwrittenBatch(batch)
          await new Promise((r) => setTimeout(r, 10))
          open()
          await replacing
          await cancelling
          await new Promise((r) => setTimeout(r, 10))
          expect(seen.cancelled).toEqual([])
          await expectReplacementKept(row.id)
        } finally {
          // A failed wait or assertion never leaves the queue write held for the next test.
          open()
          await replacing.catch(() => {})
          await cancelling?.catch(() => {})
        }
      })

      it('a batch put back and edited before the cancellation returns the edited words', async () => {
        const { wrapper, row, batch } = await replacedSetup()
        await revertToPending(batch)
        expect(await editMessage(SID, row.id, 'edited before the cancel')).toBe(true)
        const texts: string[][] = []
        bus.subscribe('edit-cancel-observer', (event) => {
          if (event.name === EventNames.SESSION_QUEUED_CANCELLED) texts.push([...((event.data as { messages?: string[] }).messages ?? [])])
        }, { global: true })
        await wrapper.cancelUnwrittenBatch(batch)
        await vi.waitFor(() => expect(texts).toEqual([['edited before the cancel']]))
        expect((await readQueueFileFresh()).queues[SID]).toBeUndefined()
      })
    })

    it('guard: every cold send of a queued line checks the Stop fence and the Stop count right before it', () => {
      const src = readFileSync(path.resolve(__dirname, '../../src/providers/claude-code-session.ts'), 'utf8')
      const sends = [...src.matchAll(/(\w+)\.send\((combined|''|message), /g)].map((m) => `${m[1]}(${m[2]})`)
      // handleStart's send is a person's own start, not a queued line.
      expect(sends).toEqual(['session(message)', "target('')", 'session(combined)', 'targetSession(combined)'])
      for (const m of src.matchAll(/(\w+)\.send\((combined|''), /g)) {
        const prep = src.slice(src.lastIndexOf('resumeSpawnPrompt(', m.index!), m.index!)
        const check = Math.max(prep.lastIndexOf('= await this.stopFenceMoved(sessionId, stopFence)'), prep.lastIndexOf('beforeSend()'))
        expect(check).toBeGreaterThan(-1)
        // The reinitialize send runs inside a Promise executor, in the same tick as its check.
        expect(prep.slice(check).replace('= await this.stopFenceMoved', '').replace('await new Promise<void>((resolve, reject) => {', '')).not.toMatch(/\bawait\b/)
        if (m[2] === 'combined') {
          // A queued line's cold send: a persisted Stop parks (fenceMoved), the user's Stop seen by the
          // preparation cancels, and the preparation ends in the send's own tick.
          expect(prep.slice(check)).toMatch(/if \((claimedFenceMoved|fenceMoved) \|\| this\.deliveryPrepStopped\(sessionId, prep\) \|\|/)
          expect(prep.slice(check)).toMatch(/cancelBeforeColdSend\(sessionId, \w+, msgs, (claimedFenceMoved|fenceMoved)\)/)
          expect(prep.trimEnd().endsWith('this.endDeliveryPrep(sessionId, prep)')).toBe(true)
        }
      }
      // Stop and Restart read the preparation's own mark, never whether a transport exists.
      expect(src).not.toMatch(/\.unsent\b/)
      const interrupt = src.slice(src.indexOf('private interruptNativeSession('), src.indexOf('private async handleSend('))
      expect(interrupt).toContain('if (preparing || this.nativeDeliveryPreps.has(sessionId)) return')
      const reinit = src.slice(src.indexOf('  reinitialize(sessionId: string'), src.indexOf('private async performNativeReinitialize('))
      // Refused before the restart is registered, with no wait on the delivery.
      expect(reinit.indexOf('this.nativeDeliveryPreps.has(sessionId)')).toBeLessThan(reinit.indexOf('this.nativeSessionReinitializations.set('))
      // Reinitialize checks the Stop count of whichever wrapper it restarts, not only one it built.
      expect(src).toContain('if (restarted.stopEpoch !== epoch) throw')
      expect(src).not.toContain('claimed && claimed.stopEpoch')
      // A lost record is rebuilt before the backup check can hold the delivery.
      const next = src.indexOf('private async processNextNow(')
      expect(src.indexOf('recoverSessionRecordFromJsonl(sessionId)', next)).toBeLessThan(src.indexOf('recoverCancelledForSession(sessionId, true))) {', next))
    })
  })
})

describe('a mid-turn send never goes out after a Stop that came before its write', () => {
  const SID = 'inject-stop-first'
  const KEY = 'inject-stop-task'
  type Runner = {
    sessions: Map<string, ClaudeCodeSession>
    midTurnWrites: Map<string, Promise<void>>
    injectMidTurn(sid: string): Promise<void>
    processNextNow(sid: string): Promise<void>
    interruptNativeSession(sid: string): Promise<void>
    clearActiveProcessing(sid: string): void
  }
  const runner = sessionRunner as unknown as Runner
  afterEach(() => { runner.sessions.delete(KEY); runner.midTurnWrites.delete(SID); runner.clearActiveProcessing(SID) })

  /** A live running wrapper over a stubbed transport; its real writeMessage stays, Stop only bumps its count. */
  async function liveTurn() {
    await createSessionRecord(SID, KEY, 'proj', CWD, { initialProcessStatus: 'running' })
    const row = await enqueueMessage(SID, 'sent while the turn ran', { id: 'qm-mobile-inject-stop' })
    const transport = { writeMessage: vi.fn(async () => true), interrupt: vi.fn(async () => {}), hasPipe: true, fileSize: 0, stopTail: vi.fn(), detach: vi.fn() }
    const live = new ClaudeCodeSession(KEY, 'proj', '/bin/true')
    Object.assign(live, { claudeSessionId: SID, _transport: transport, _active: true, _processStatus: 'running' })
    vi.spyOn(live as unknown as { interruptTurnInPlace(): Promise<boolean> }, 'interruptTurnInPlace').mockResolvedValue(true)
    runner.sessions.set(KEY, live)
    const next = vi.spyOn(runner, 'processNextNow').mockResolvedValue(undefined)
    const failed: string[][] = []
    bus.subscribe('inject-stop-observer', (event) => {
      if (event.name === EventNames.SESSION_BATCH_FAILED) failed.push([...((event.data as { messageIds?: string[] }).messageIds ?? [])])
    }, { global: true })
    return { row, live, transport, next, failed }
  }

  const gate = () => {
    let open!: () => void
    const held = new Promise<void>((r) => { open = r })
    return { held, open: () => open() }
  }

  it.each(['the spawn wait', 'an earlier mid-turn write', 'the Stop record read'] as const)('a Stop during %s parks the row unwritten and delegates nothing', async (point) => {
    const t = await liveTurn()
    const g = gate()
    let entered = false
    const spawn = vi.spyOn(t.live, 'awaitSpawn')
    if (point === 'the spawn wait') Object.assign(t.live, { _spawnSettled: g.held })
    if (point === 'an earlier mid-turn write') runner.midTurnWrites.set(SID, g.held)
    if (point === 'the Stop record read') {
      const real = sessionStops.fence.bind(sessionStops)
      let calls = 0
      vi.spyOn(sessionStops, 'fence').mockImplementation(async (sid: string) => {
        // The first read is the send's fence; the second is the check right before the write.
        if (++calls === 2) { entered = true; await g.held }
        return real(sid)
      })
    }
    try {
      const sending = runner.injectMidTurn(SID)
      if (point === 'the Stop record read') await vi.waitFor(() => expect(entered).toBe(true))
      else await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
      const epoch = t.live.stopEpoch
      const stopping = runner.interruptNativeSession(SID)
      expect(t.live.stopEpoch).toBe(epoch + 1)
      expect(t.transport.writeMessage).not.toHaveBeenCalled()
      g.open()
      await Promise.all([sending, stopping])
      expect(t.transport.writeMessage).not.toHaveBeenCalled()
      expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status, r.parkedReason])).toEqual([[t.row.id, 'parked', STOP_PARKED_REASON]])
      expect(t.failed).toEqual([[t.row.id]])
      expect(t.next).not.toHaveBeenCalled()
    } finally { g.open() }
  })

  it('a persisted Stop that moved the fence before the write parks the row unwritten', async () => {
    const t = await liveTurn()
    const real = sessionStops.fence.bind(sessionStops)
    let calls = 0
    vi.spyOn(sessionStops, 'fence').mockImplementation(async (sid: string) => (++calls === 2 ? 'stop-after-the-send' : real(sid)))
    await runner.injectMidTurn(SID)
    expect(t.transport.writeMessage).not.toHaveBeenCalled()
    expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status])).toEqual([[t.row.id, 'parked']])
    expect(t.next).not.toHaveBeenCalled()
  })

  it('a Stop record that cannot be read before the write is a failed send, not a Stop', async () => {
    const t = await liveTurn()
    const real = sessionStops.fence.bind(sessionStops)
    let calls = 0
    vi.spyOn(sessionStops, 'fence').mockImplementation(async (sid: string) => {
      if (++calls === 2) throw new Error('injected stop record read failure')
      return real(sid)
    })
    await runner.injectMidTurn(SID)
    expect(t.transport.writeMessage).not.toHaveBeenCalled()
    expect((await readQueueFileFresh()).queues[SID]?.map((r) => [r.id, r.status])).toEqual([[t.row.id, 'pending']])
    expect(t.failed).toEqual([[t.row.id]])
    expect(t.next).not.toHaveBeenCalled()
  })
})

describe('retrySession — process still alive', () => {
  it('returns reconnected and clears the stale error without sending anything', async () => {
    const sid = 'retry-rc-alive'
    stub.alive = true
    await createSessionRecord(sid, 'task-rc5', 'proj', CWD, { initialProcessStatus: 'error' })
    await updateSessionRecord(sid, {
      errorMessage: 'Connection lost — unable to reach remote host',
    } as never)

    const cap = captureLaunchEvents()
    try {
      const res = await retrySession(sid)
      expect(res).toEqual({ status: 'reconnected', sessionId: sid })
      expect(cap.events).toHaveLength(0)
    } finally {
      cap.stop()
    }

    expect(stub.sendCalls).toEqual([])
    const rec = await getSessionByClaudeId(sid)
    // A live process with no turn is idle: Running would promise a turn that is
    // not there (2026-10-30: Retry showed "Codex is working" for minutes).
    expect(rec?.process_status).toBe('idle')
    expect(rec?.errorMessage ?? null).toBeNull()
    expect(rec?.status_reason).toBe('retry_reconnect')
    expect(rec?.status_changed_by).toBe('user')
  })
})
