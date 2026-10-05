/**
 * Repro for connection-matrix C1, written against APIs that predate the fix.
 *
 * A message sent while a turn runs is written into the CLI's stdin and waits in
 * the CLI's own queue, which lives only in that process. The runner used to
 * delete the queue row right after that write ("no re-delivery on crash"), so
 * a CLI that crashed before taking the line lost the message for good: the
 * resumed CLI never heard of it. The row must stay until the CLI takes the
 * line, and a crash before that must put it back for the next delivery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-midturn-row-held'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { bus } from '../../src/core/event-bus.js'

let seq = 0

function runningSession(sid: string) {
  const writes: Array<{ message: string; uuid?: string }> = []
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; onDispatch?: () => void }) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid })
      return true
    },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 4321,
  }
  const session = new ClaudeCodeSession(`held-task-${sid}`, 'test', '/bin/true')
  // A CLI that reports its command queue (it already printed a command_lifecycle
  // frame): only its word can say a queued line was taken. A CLI that never
  // reports lifecycle keeps the base rule, see line-delivery-once.test.ts (G8).
  Object.assign(session, { claudeSessionId: sid, _transport: transport, _processStatus: 'running', _active: true, pid: 4321, _sawCommandLifecycle: true })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as { sessions: Map<string, ClaudeCodeSession>; injectMidTurn(sid: string): Promise<void> }
  internals.sessions.set(`held-task-${sid}`, session)
  return {
    internals, session, writes,
    lifecycle: (uuid: string, state: string) => (session as unknown as { handleStreamLine(l: string): void })
      .handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state })),
    crash: () => (session as unknown as { handleRemoteProcessExit(code: number, stderr?: string): void })
      .handleRemoteProcessExit(1, 'mock CLI crashed on purpose'),
  }
}

const statuses = async (sid: string) => (await getQueue(sid)).map((m) => m.status)
const settle = () => new Promise((r) => setTimeout(r, 100))

let SID = ''
beforeEach(async () => {
  SID = `20000000-0000-4000-8000-0000000c1${String(++seq).padStart(3, '0')}`
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, `held-task-${SID}`, 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
})

afterEach(async () => {
  bus.clear()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('C1: a message queued behind a running turn', () => {
  it('stays in the queue after the write, until the CLI starts it', async () => {
    const s = runningSession(SID)
    await enqueueMessage(SID, 'second message')
    await s.internals.injectMidTurn(SID)
    expect(s.writes.map((w) => w.message)).toEqual(['second message'])
    expect(s.writes[0].uuid).toBeTruthy()
    s.lifecycle(s.writes[0].uuid!, 'queued')
    await settle()
    expect(await statuses(SID)).toEqual(['processing'])
    s.lifecycle(s.writes[0].uuid!, 'started')
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual([]))
  })

  it('is back in the queue, not lost, when the CLI crashes before taking it', async () => {
    const s = runningSession(SID)
    await enqueueMessage(SID, 'second message')
    await s.internals.injectMidTurn(SID)
    s.lifecycle(s.writes[0].uuid!, 'queued')
    await settle()
    s.crash()
    await vi.waitFor(async () => expect(await statuses(SID)).toEqual(['pending']))
  })
})
