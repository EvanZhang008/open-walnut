/**
 * A Stop that cancels a line Claude Code had queued gives back only the person's
 * own words to the composer. Any other row on that line (a peer's note, a trigger,
 * a Walnut notice) stays in the queue, parked with its Retry (a cancel that was no
 * Stop: sent again by itself, core/sessions/delivery-retry.ts): handed to the composer it was lost with no panel open, and became the
 * person's draft with one (2026-11-23: no message is ever lost).
 *
 * Real ClaudeCodeSession cancellation path and the real disk queue over a tmp
 * WALNUT_HOME; only the transport is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-stop-cancel-agent-rows'))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { enqueueMessage, getQueue, markProcessing, resetCache, type QueuedMessage } from '../../src/core/session-message-queue.js'
import { CANCELLED_UNRUN_REASON, STOP_PARKED_REASON } from '../../src/core/relay-fates.js'
import { ClaudeCodeSession, sessionRunner } from '../../src/providers/claude-code-session.js'
import { awaitLine, resetLineConsumption } from '../../src/providers/line-consumption.js'

const SID = 'stop-cancel-agent-rows'

type Inner = {
  _queuedLines: Map<string, Array<{ message: string; messageId: string }>>
  _cancelReturnsInFlight: Map<string, Promise<boolean>>
  handleStreamLine(line: string): void
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  resetCache()
  resetLineConsumption()
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

/** One line (written into a running CLI's input, or not yet) carrying an agent's row, a person's row, and a row with no sender. */
async function queuedLine(written = true) {
  await createSessionRecord(SID, 'stop-cancel-task', 'proj', os.tmpdir(), { initialProcessStatus: 'running' })
  const agent = await enqueueMessage(SID, 'note from another task', { sentBy: 'agent' })
  const person = await enqueueMessage(SID, 'use plan B', { sentBy: 'person' })
  const unknown = await enqueueMessage(SID, 'row from an older version')
  const batch = await markProcessing(SID)
  expect(batch.map((r) => r.id)).toEqual([agent.id, person.id, unknown.id])
  const uuid = batch[0].lineUuid!
  const session = new ClaudeCodeSession('stop-cancel-task', 'proj', '/bin/true')
  const transport = { interrupt: vi.fn(async () => {}), writeMessage: vi.fn(async () => true), stopTail: vi.fn(), fileSize: 0, hasPipe: true }
  Object.assign(session, { claudeSessionId: SID, _transport: transport, _processStatus: 'running', _sawCommandLifecycle: true })
  const inner = session as unknown as Inner
  if (written) {
    awaitLine(SID, uuid, batch)
    inner._queuedLines.set(uuid, batch.map((r) => ({ message: r.message, messageId: r.id })))
  }
  vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockImplementation((sid) => sid === SID ? session : undefined)
  const returned: Array<{ messageIds: string[]; messages: string[] }> = []
  bus.subscribe('web-ui', (e) => {
    if (e.name === EventNames.SESSION_QUEUED_CANCELLED) returned.push(e.data as { messageIds: string[]; messages: string[] })
  })
  return { session, inner, batch, uuid, agent, person, unknown, returned }
}

/** Rows set aside: under a Stop's reason, or (a cancel that was no Stop) one Walnut sends again by itself. */
function parkedIds(queue: QueuedMessage[], reason?: string): string[] {
  return queue.filter((r) => r.status === 'parked' && (reason ? r.parkedReason === reason : r.parkedReason === STOP_PARKED_REASON || r.parkedReason === CANCELLED_UNRUN_REASON)).map((r) => r.id)
}

describe('a Stop that cancels a queued line', () => {
  it('cancelled by the CLI: the agent rows stay parked with Retry, only the person\'s row goes back to the composer', async () => {
    const h = await queuedLine()
    h.inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'cancelled' }))
    await vi.waitFor(() => expect(h.returned).toHaveLength(1))
    await vi.waitFor(() => expect(h.inner._cancelReturnsInFlight.size).toBe(0))
    expect(h.returned).toEqual([{ sessionId: SID, messageIds: [h.person.id], messages: ['use plan B'] }])
    const queue = await getQueue(SID)
    expect(queue.map((r) => r.id)).toEqual([h.agent.id, h.unknown.id])
    // The CLI's cancel frame does not say a person's Stop made it: Walnut sends these again by
    // itself, and a person's Stop (which moves the stop fence) still leaves them for a Retry.
    expect(parkedIds(queue, CANCELLED_UNRUN_REASON)).toEqual([h.agent.id, h.unknown.id])
    expect(queue.find((r) => r.id === h.agent.id)?.message).toBe('note from another task')
    // The CLI dropped this uuid: a Retry must go out as a new line.
    for (const row of queue) expect(row.lineUuid).not.toBe(h.uuid)
    // A second cancellation frame of the same line returns nothing and keeps the rows.
    // A return the frame starts claims its rows synchronously (returnCancelledRows), so once
    // nothing is in flight every return it started has ended.
    h.inner.handleStreamLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: h.uuid, state: 'cancelled' }))
    await vi.waitFor(() => expect(h.inner._cancelReturnsInFlight.size).toBe(0))
    expect(h.returned).toHaveLength(1)
    expect(parkedIds(await getQueue(SID))).toEqual([h.agent.id, h.unknown.id])
  })

  it('a Stop before the batch was written: the agent rows stay parked, only the person\'s row goes back', async () => {
    const h = await queuedLine(false)
    expect(await h.session.cancelUnwrittenBatch(h.batch)).toBe(true)
    await vi.waitFor(() => expect(h.returned).toHaveLength(1))
    expect(h.returned).toEqual([{ sessionId: SID, messageIds: [h.person.id], messages: ['use plan B'] }])
    const queue = await getQueue(SID)
    expect(parkedIds(queue)).toEqual([h.agent.id, h.unknown.id])
    expect(queue).toHaveLength(2)
  })
})
