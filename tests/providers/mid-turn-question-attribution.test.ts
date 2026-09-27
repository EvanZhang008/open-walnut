/**
 * A question's turn stops being "that question's" once a plain row joins it.
 *
 * The thread titler reads `turnUserUuid(sessionId)` at `session:result` to prove a
 * result answers one question (batch-uuid.ts). A plain send injected mid-turn
 * joins the running turn, so the result covers both: the attribution must be
 * dropped (no refine from a mixed answer), never kept. A pending question row is
 * never injected mid-turn, so the running question keeps its attribution then.
 *
 * What's real: SessionRunner.injectMidTurn, the disk queue, the batch-uuid map.
 * What's mocked: the transport (every FIFO write succeeds; no process).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-midturn-attribution'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { noteTurnUserUuid, turnUserUuid } from '../../src/providers/batch-uuid.js'
import { bus } from '../../src/core/event-bus.js'

const SID = '10000000-0000-4000-8000-000000000301'
const HEAD = '20000000-0000-4000-8000-000000000301'
const NEXT = '30000000-0000-4000-8000-000000000301'

function runningRunner() {
  const writes: string[] = []
  const transport = {
    writeMessage: (message: string, opts?: { onDispatch?: () => void }) => { writes.push(message); opts?.onDispatch?.(); return true },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    kill: () => {},
    stop: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
  }
  const session = new ClaudeCodeSession('attr-task', 'test', '/bin/true')
  Object.assign(session, { claudeSessionId: SID, _transport: transport, _processStatus: 'running', _active: true })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as {
    sessions: Map<string, ClaudeCodeSession>
    injectMidTurn(sid: string): Promise<void>
  }
  internals.sessions.set('attr-task', session)
  return { internals, writes }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'attr-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
  noteTurnUserUuid(SID, undefined)
})

afterEach(async () => {
  noteTurnUserUuid(SID, undefined)
  bus.clear()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('mid-turn injection and the question a turn answers', () => {
  it('a plain row injected into a question turn drops the attribution', async () => {
    const { internals, writes } = runningRunner()
    noteTurnUserUuid(SID, HEAD) // the running turn answers the question HEAD
    await enqueueMessage(SID, 'plain aside')
    await internals.injectMidTurn(SID)
    expect(writes).toEqual(['plain aside'])
    expect(turnUserUuid(SID)).toBeUndefined()
    // The delivered row is removed from the disk queue asynchronously: let it land.
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
  })

  it('a pending question row is never injected, so the running question keeps it', async () => {
    const { internals, writes } = runningRunner()
    noteTurnUserUuid(SID, HEAD)
    await enqueueMessage(SID, 'next question', { userUuid: NEXT })
    await internals.injectMidTurn(SID)
    expect(writes).toEqual([])
    expect(turnUserUuid(SID)).toBe(HEAD)
    expect((await getQueue(SID)).map((m) => m.status)).toEqual(['pending'])
  })
})
