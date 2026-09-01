/**
 * DaemonConnection message-request relay handler — the primary-side half of
 * the durable cloud send (2026-08-13 phone-send data-loss family).
 *
 * Covers: durable enqueue with the phone's stable qm-mobile id, taskId
 * passthrough from the session record, not_found errorKind, bad payload
 * refusal, and the post-delivery replay ledger (a phone retry arriving AFTER
 * the original was delivered+drained must be acked as success WITHOUT
 * re-enqueueing a duplicate turn).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-msg-relay'))

const getSessionMock = vi.fn()
// updateSessionRecord is here because the relay now applies the output-mode
// directive (core/sessions/output-mode-send.ts) and advances the record's edge
// marker after the enqueue — the phone's sends carry the same instruction the
// console's do.
const updateSessionMock = vi.fn(async () => undefined)
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: getSessionMock,
  updateSessionRecord: updateSessionMock,
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { getQueue, loadQueue, resetCache } from '../../src/core/session-message-queue.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = 'relay-handler-sid-1'

interface SentFrame { cmd: string; params: Record<string, unknown> }

function makeConn(): { conn: DaemonConnection; sent: SentFrame[] } {
  const conn = new DaemonConnection('__local__', null)
  const sent: SentFrame[] = []
  // Stub the wire: capture message-result frames instead of needing a socket.
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (cmd: string, params: Record<string, unknown>) => { sent.push({ cmd, params }); return { ok: true } }
  return { conn, sent }
}

async function fire(conn: DaemonConnection, event: Record<string, unknown>): Promise<void> {
  await (conn as unknown as { handleMessageRequest: (e: Record<string, unknown>) => Promise<void> })
    .handleMessageRequest(event)
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await loadQueue()
  resetCache()
  getSessionMock.mockReset()
  updateSessionMock.mockClear()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('handleMessageRequest', () => {
  it('enqueues durably with the phone id and answers message-result success', async () => {
    getSessionMock.mockResolvedValue({ taskId: 'task-9', host: null })
    const { conn, sent } = makeConn()
    const mid = `qm-mobile-relay-${Date.now()}`
    await fire(conn, { ev: 'message-request', relayId: 7, sessionId: SID, message: 'hello', messageId: mid })

    expect(sent).toHaveLength(1)
    expect(sent[0].cmd).toBe('message-result')
    expect(sent[0].params.relayId).toBe(7)
    expect((sent[0].params.result as Record<string, unknown>).messageId).toBe(mid)

    const queue = await getQueue(SID)
    expect(queue).toHaveLength(1)
    expect(queue[0].id).toBe(mid)
    // The human's words lead; the output-mode instruction is appended after them
    // (rich is the default, and this record was never told anything yet).
    const { RICH_OUTPUT_MODE_ON_INSTRUCTION } = await import('../../src/core/sessions/output-mode.js')
    expect(queue[0].message.startsWith('hello')).toBe(true)
    expect(queue[0].message).toContain(RICH_OUTPUT_MODE_ON_INSTRUCTION)
    expect(queue[0].status).toBe('pending')
    expect(updateSessionMock).toHaveBeenCalledWith(SID, { output_mode_injected: 'rich' })
  })

  it('a markdown-mode session relays the phone text byte-identical', async () => {
    getSessionMock.mockResolvedValue({
      taskId: 'task-9', host: null, output_mode: 'markdown', output_mode_injected: 'markdown',
    })
    const { conn } = makeConn()
    const mid = `qm-mobile-md-${Date.now()}`
    await fire(conn, { ev: 'message-request', relayId: 8, sessionId: SID, message: 'plain', messageId: mid })
    const queue = await getQueue(SID)
    expect(queue[0].message).toBe('plain')
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it('a replay AFTER delivery+drain is acked WITHOUT re-enqueueing (ledger)', async () => {
    getSessionMock.mockResolvedValue({ taskId: 'task-9', host: null })
    const { conn, sent } = makeConn()
    const mid = `qm-mobile-ledger-${Date.now()}`
    await fire(conn, { ev: 'message-request', relayId: 1, sessionId: SID, message: 'once', messageId: mid })
    expect((await getQueue(SID)).length).toBe(1)

    // Simulate delivery: the runner drains the row from the store.
    const { markProcessing, removeProcessed } = await import('../../src/core/session-message-queue.js')
    await markProcessing(SID)
    await removeProcessed(SID, [mid])
    expect((await getQueue(SID)).length).toBe(0)

    // The phone's late retry (its 202 was lost) replays the SAME id.
    await fire(conn, { ev: 'message-request', relayId: 2, sessionId: SID, message: 'once', messageId: mid })
    expect(sent).toHaveLength(2)
    expect((sent[1].params.result as Record<string, unknown>).messageId).toBe(mid)
    // …and the queue must stay EMPTY — no duplicate turn.
    expect((await getQueue(SID)).length).toBe(0)
  })

  it('unknown session answers errorKind not_found', async () => {
    getSessionMock.mockResolvedValue(null)
    const { conn, sent } = makeConn()
    await fire(conn, { ev: 'message-request', relayId: 3, sessionId: 'ghost-sid', message: 'x', messageId: 'qm-mobile-nf1' })
    expect(sent[0].params.errorKind).toBe('not_found')
    expect((await getQueue('ghost-sid')).length).toBe(0)
  })

  it('a malformed payload is refused as bad_request (no enqueue)', async () => {
    const { conn, sent } = makeConn()
    await fire(conn, { ev: 'message-request', relayId: 4, sessionId: SID, message: '', messageId: 'qm-mobile-bad' })
    expect(sent[0].params.errorKind).toBe('bad_request')
    await fire(conn, { ev: 'message-request', relayId: 5, sessionId: SID, message: 'x' }) // no messageId
    expect(sent[1].params.errorKind).toBe('bad_request')
    expect(getSessionMock).not.toHaveBeenCalled()
  })
})
