/**
 * The web `session:send` RPC keeps the recordings dictated into the message and the composer's own
 * text (`dictationIds`, `dictationText`) on the queue row, and names them on the queue's event, the
 * one Voice Accuracy pairs from (stt/learn-from-sends.ts): only valid recording ids, at most 8, none
 * at all when the client sent none (an older client). From the row, so a resend that collapses onto
 * it, after a restart hours later, names them too. Harness of session-hints-send.test.ts: the RPC
 * handler is captured by stubbing `registerMethod`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-dictation-ids-send') }
})

const { methods, registerMethod } = vi.hoisted(() => {
  const methods = new Map<string, (payload: unknown, client: unknown) => Promise<unknown>>()
  return { methods, registerMethod: vi.fn((name: string, handler: (p: unknown, c: unknown) => Promise<unknown>) => { methods.set(name, handler) }) }
})
// What Voice Accuracy is told (its own tests cover what it writes).
const pairing = vi.hoisted(() => ({ recordSentByIds: vi.fn(async () => [] as string[]), forgetSentByIds: vi.fn(async () => {}) }))
vi.mock('../../../src/core/stt/compare/sent-text.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ...pairing }))
vi.mock('../../../src/web/ws/handler.js', () => ({
  registerMethod, broadcastEvent: vi.fn(), sendToClient: vi.fn(), sendStreamEvent: vi.fn(),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js'
import { deleteMessage, editMessage, getQueue, resetCache, sendMessageToSession } from '../../../src/core/session-message-queue.js'
import { startLearningFromSends } from '../../../src/core/stt/learn-from-sends.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { dictationIdsOf } from '../../../src/core/stt/dictation-ids.js'

const SID = 'cccccccc-dddd-eeee-ffff-00000000d1c7'
const queued: Array<Record<string, unknown>> = []

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  bus.clear()
  methods.clear()
  registerSessionChatRpc()
  queued.length = 0
  bus.subscribe('test-dictation-ids', (e) => { queued.push(e.data as Record<string, unknown>) }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
  await createSessionRecord(SID, 'task-dictation-ids', '', '/tmp/dictation-ids-repo')
})
afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const send = (payload: Record<string, unknown>) => methods.get('session:send')!({ sessionId: SID, ...payload }, {} as never)

describe('session:send names the dictated recordings on the queued event', () => {
  it('forwards the valid recording ids', async () => {
    await send({ message: 'two dictations, edited', dictationIds: ['2026-11-22T10-00-00-000Z', '../etc/passwd', 7, '2026-11-22T10-01-00-000Z', '2026-11-22T10-00-00-000Z'], dictationText: 'two dictations, edited' })
    expect(queued.at(-1)).toMatchObject({ sessionId: SID, message: 'two dictations, edited', dictationIds: ['2026-11-22T10-00-00-000Z', '2026-11-22T10-01-00-000Z'], dictationText: 'two dictations, edited' })
  })

  it('an older client that sends none: the event carries no field', async () => {
    await send({ message: 'typed, no dictation' })
    expect(queued.at(-1)).toMatchObject({ message: 'typed, no dictation' })
    expect(queued.at(-1)).not.toHaveProperty('dictationIds')
  })

  it('keeps them on the row: a resend that collapses onto it after a restart names them, the memory of recent sends gone', async () => {
    const { messageId } = await send({ message: 'words a usage limit held', dictationIds: ['2026-11-22T10-00-00-000Z'], dictationText: 'words a usage limit held' }) as { messageId: string }
    const row = (await getQueue(SID)).find((m) => m.id === messageId)!
    expect(row.dictation).toEqual({ ids: ['2026-11-22T10-00-00-000Z'], text: 'words a usage limit held' })
    // Hours later, after a restart: the row is read from disk, and a resend of it names no recordings itself.
    resetCache()
    expect((await getQueue(SID)).find((m) => m.id === messageId)!.dictation).toEqual({ ids: ['2026-11-22T10-00-00-000Z'], text: 'words a usage limit held' })
    queued.length = 0
    await sendMessageToSession(SID, 'words a usage limit held', { source: 'ui', messageId })
    expect(queued.at(-1)).toMatchObject({ messageId, dictationIds: ['2026-11-22T10-00-00-000Z'], dictationText: 'words a usage limit held' })
  })

  it('an agent\'s send keeps none, whatever it passes', async () => {
    await sendMessageToSession(SID, 'a note', { source: 'walnut-notify', dictation: { ids: ['2026-11-22T10-00-00-000Z'] } })
    expect(queued.at(-1)).not.toHaveProperty('dictationIds')
  })

  it('an edit in the queue pairs the dictation with the words that go; a discard forgets the pairing', async () => {
    await startLearningFromSends()
    const REC = '2026-11-22T10-00-00-000Z'
    const { messageId } = await send({ message: 'the build is broken on mane', dictationIds: [REC], dictationText: 'the build is broken on mane' }) as { messageId: string }
    await vi.waitFor(() => expect(pairing.recordSentByIds).toHaveBeenLastCalledWith([REC], expect.objectContaining({ boxText: 'the build is broken on mane' }), expect.any(Number)))
    expect(await editMessage(SID, messageId, 'the build is broken on main')).toBe(true)
    expect((await getQueue(SID)).find((m) => m.id === messageId)!.dictation).toEqual({ ids: [REC], text: 'the build is broken on main' })
    await vi.waitFor(() => expect(pairing.recordSentByIds).toHaveBeenLastCalledWith([REC], expect.objectContaining({ boxText: 'the build is broken on main' }), expect.any(Number)))
    expect(await deleteMessage(SID, messageId, { discarded: true })).toBe(true)
    await vi.waitFor(() => expect(pairing.forgetSentByIds).toHaveBeenCalledWith([REC], 'the build is broken on main'))
  })

  it('a row removed for another reason (its words carried into a new start) keeps its pairing', async () => {
    pairing.forgetSentByIds.mockClear()
    const { messageId } = await send({ message: 'carried words', dictationIds: ['2026-11-22T10-02-00-000Z'], dictationText: 'carried words' }) as { messageId: string }
    expect(await deleteMessage(SID, messageId)).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(pairing.forgetSentByIds).not.toHaveBeenCalled()
  })

  it('an edit that holds a reference tag pairs from the message, not as the person\'s own text', async () => {
    const REC = '2026-11-22T10-03-00-000Z'
    const { messageId } = await send({ message: 'see the task', dictationIds: [REC], dictationText: 'see the task' }) as { messageId: string }
    expect(await editMessage(SID, messageId, 'see <task-ref id="t-1"/> now')).toBe(true)
    expect((await getQueue(SID)).find((m) => m.id === messageId)!.dictation).toEqual({ ids: [REC] })
  })

  it('reads only a list of recording ids, at most 8', () => {
    expect(dictationIdsOf('2026-11-22T10-00-00-000Z')).toEqual([])
    expect(dictationIdsOf(Array.from({ length: 12 }, (_, i) => `rec${i}`))).toHaveLength(8)
  })
})
