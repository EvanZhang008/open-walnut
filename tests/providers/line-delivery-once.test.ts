/**
 * Each queued message reaches the CLI once, and stays queued until the CLI
 * has it (connection-matrix C1 and S8).
 *
 * C1: a line written while a turn runs waits in the CLI's own queue, which dies
 * with the process. The row used to leave Walnut's queue on the write, so a
 * crash before the CLI took the line lost the message. Now, for a CLI that
 * reports its queue (command_lifecycle), the row leaves only on the CLI's word,
 * and a crash first hands it back under the same uuid. A CLI that has never
 * reported lifecycle (2.1.88 prints none) keeps the base rule: the row leaves
 * on the write, and nothing is ever re-sent for it.
 *
 * S8: a send whose answer never came used to read as "not delivered": the
 * runner stopped the healthy CLI and resent the line on a fresh process, so it
 * ran twice. Now the outcome is "unknown" (SendOutcomeUnknownError): no stop,
 * the row keeps its line uuid, and the next attempt carries it and asks the
 * daemon first (dedupe).
 *
 * What's real: SessionRunner (processNext, injectMidTurn), ClaudeCodeSession
 * (writeMessage, the lifecycle handler, the exit path), the disk queue.
 * What's mocked: the transport (no process, no daemon).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-delivery-once'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { resetLineConsumption } from '../../src/providers/line-consumption.js'
import { SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000a01'

interface Write { message: string; uuid?: string; dedupe?: boolean }

function harness(opts: { reportsLifecycle?: boolean } = {}) {
  const writes: Write[] = []
  let fail: Error | null = null
  let fate: { fate: string; state?: string } | null = null
  const stop = vi.fn(async () => {})
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; dedupe?: boolean; onDispatch?: () => void; onFate?: (f: { fate: string; state?: string }) => void }) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid, dedupe: o?.dedupe })
      if (fail) throw fail
      // A daemon that knows the line's fate writes nothing and says what it knows.
      if (fate && o?.dedupe) o.onFate?.(fate)
      return true
    },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop,
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
  }
  const session = new ClaudeCodeSession('once-task', 'test', '/bin/true')
  Object.assign(session, {
    claudeSessionId: SID, _transport: transport, _processStatus: 'running', _active: true, pid: 12345,
    _sawCommandLifecycle: opts.reportsLifecycle !== false,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    injectMidTurn(sid: string): Promise<void>
    processNext(sid: string): Promise<void>
  }
  internals.sessions.set('once-task', session)
  const events: Array<{ name: string; data: Record<string, unknown> }> = []
  bus.subscribe('line-delivery-once-test', (e) => { events.push({ name: e.name, data: e.data as Record<string, unknown> }) }, { global: true })
  const lifecycle = (uuid: string, state: string) => (session as unknown as { handleStreamLine(l: string): void })
    .handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state }))
  return {
    internals, session, writes, stop, lifecycle, events,
    failWith: (err: Error | null) => { fail = err },
    daemonKnows: (f: { fate: string; state?: string } | null) => { fate = f },
  }
}

const rows = async () => (await getQueue(SID)).map((m) => ({ id: m.id, status: m.status }))
const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'once-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
})

afterEach(async () => {
  bus.unsubscribe('line-delivery-once-test')
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('C1: a line queued behind a running turn', () => {
  it('stays queued until the CLI says it started it, then leaves', async () => {
    const h = harness()
    await enqueueMessage(SID, 'second')
    await h.internals.injectMidTurn(SID)
    expect(h.writes.map((w) => w.message)).toEqual(['second'])
    await settle()
    expect((await rows()).map((r) => r.status)).toEqual(['processing'])
    h.lifecycle(h.writes[0].uuid!, 'queued')
    await settle()
    expect(await rows()).toHaveLength(1)
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('goes back to the queue under the same uuid when the CLI dies first', async () => {
    const h = harness()
    await enqueueMessage(SID, 'second')
    await h.internals.injectMidTurn(SID)
    const uuid = h.writes[0].uuid!
    ;(h.session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
      .handleRemoteProcessExit(1, 'mock CLI crashed on purpose')
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    expect((await getQueue(SID))[0].lineUuid).toBe(uuid)

    // The resumed process gets it once, under the same uuid, asking the daemon first.
    Object.assign(h.session, { _processStatus: 'running', _active: true, pid: 12346, resultEmitted: false, _turnResultEmitted: false })
    await h.internals.injectMidTurn(SID)
    expect(h.writes.map((w) => [w.uuid, w.dedupe])).toEqual([[uuid, false], [uuid, true]])
    h.lifecycle(uuid, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('a later line never overtakes the one handed back', async () => {
    const h = harness()
    await enqueueMessage(SID, 'second')
    await h.internals.injectMidTurn(SID)
    ;(h.session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
      .handleRemoteProcessExit(1, 'mock CLI crashed on purpose')
    await vi.waitFor(async () => expect((await rows()).map((r) => r.status)).toEqual(['pending']))
    await enqueueMessage(SID, 'third')
    Object.assign(h.session, { _processStatus: 'running', _active: true, pid: 12346, resultEmitted: false, _turnResultEmitted: false })
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(() => expect(h.writes.map((w) => w.message)).toEqual(['second', 'second', 'third']))
  })

  it('B3: a teardown Walnut asked for never drops the untaken line silently', async () => {
    const h = harness()
    await enqueueMessage(SID, 'second')
    const id = (await getQueue(SID))[0].id
    await h.internals.injectMidTurn(SID)
    h.session.markExpectedTeardown('test')
    ;(h.session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void }).handleRemoteProcessExit(143)
    // The text stays (parked, never redelivered on its own) and the user is told it never ran.
    await vi.waitFor(async () => expect(await rows()).toEqual([{ id, status: 'parked' }]))
    const failed = h.events.find((e) => e.name === EventNames.SESSION_BATCH_FAILED)
    expect(failed?.data).toMatchObject({ sessionId: SID, messageIds: [id] })
    expect(String(failed?.data.error)).toMatch(/ended before Claude Code ran this message/)
    expect((await getQueue(SID))[0].message).toBe('second')
    expect(h.writes).toHaveLength(1)
  })

  it('G8: a CLI that has not reported lifecycle keeps the base rule (the row leaves on the write)', async () => {
    // CLI 2.1.88 prints no command_lifecycle at all. Holding its rows would
    // wait forever and re-send them on every exit (each turn of the repo mock
    // ends its process): base behavior, exactly, with no new re-sends.
    const h = harness({ reportsLifecycle: false })
    await enqueueMessage(SID, 'second')
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    ;(h.session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
      .handleRemoteProcessExit(0)
    await settle()
    expect(await rows()).toEqual([])
    expect(h.writes).toHaveLength(1)
  })

  it('discarded or refused: the user is told it never ran, never "delivered"', async () => {
    for (const state of ['discarded', 'refused']) {
      const h = harness()
      await enqueueMessage(SID, `dropped ${state}`)
      const id = (await getQueue(SID)).find((m) => m.message === `dropped ${state}`)!.id
      await h.internals.injectMidTurn(SID)
      h.lifecycle(h.writes[0].uuid!, state)
      await vi.waitFor(async () => expect((await rows()).find((r) => r.id === id)?.status).toBe('parked'))
      const row = (await getQueue(SID)).find((m) => m.id === id)!
      // A Retry goes out as a new line: the CLI would skip the old uuid as already seen.
      expect(row.lineUuid).toBeUndefined()
      await vi.waitFor(() => expect(h.events.some((e) => e.name === EventNames.SESSION_BATCH_FAILED
        && (e.data.messageIds as string[]).includes(id))).toBe(true))
      bus.unsubscribe('line-delivery-once-test')
    }
  })
})

describe('S8: a send whose answer never came', () => {
  it('never stops the CLI; the next attempt carries the same uuid and asks the daemon first', async () => {
    const h = harness()
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    await enqueueMessage(SID, 'only once')
    h.failWith(new SendOutcomeUnknownError('daemon command timeout: send (30000ms)'))
    await h.internals.processNext(SID)
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(1)
    const uuid = h.writes[0].uuid!
    expect(await rows()).toMatchObject([{ status: 'pending' }])
    expect((await getQueue(SID))[0].lineUuid).toBe(uuid)

    h.failWith(null)
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    await h.internals.processNext(SID)
    expect(h.writes.slice(1)).toEqual([{ message: 'only once', uuid, dedupe: true }])
    expect(h.stop).not.toHaveBeenCalled()
    // Delivered, and still queued until the CLI names the line.
    expect(await rows()).toMatchObject([{ status: 'processing' }])
    h.lifecycle(uuid, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
  })

  it('the CLI naming the line while the outcome was unknown settles the row for good', async () => {
    const h = harness()
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    await enqueueMessage(SID, 'landed after all')
    h.failWith(new SendOutcomeUnknownError('daemon command timeout: send (30000ms)'))
    await h.internals.processNext(SID)
    h.lifecycle(h.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    h.failWith(null)
    await h.internals.processNext(SID)
    expect(h.writes).toHaveLength(1)
  })

  it('G8: on a CLI without lifecycle the resend asks the daemon, which says the line is in', async () => {
    const h = harness({ reportsLifecycle: false })
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    await enqueueMessage(SID, 'once')
    h.failWith(new SendOutcomeUnknownError('daemon command timeout: send (30000ms)'))
    await h.internals.processNext(SID)
    h.failWith(null)
    h.daemonKnows({ fate: 'waiting' })
    Object.assign(h.session, { _processStatus: 'idle', resultEmitted: true, _turnResultEmitted: true })
    await h.internals.processNext(SID)
    // Asked once with dedupe, nothing re-sent, and the row follows the base rule.
    expect(h.writes.map((w) => w.dedupe)).toEqual([false, true])
    await vi.waitFor(async () => expect(await rows()).toEqual([]))
    expect(h.stop).not.toHaveBeenCalled()
  })
})
