/**
 * Every message set aside or voided unsent tells its sender, and the ledger says so (2026-11-26, the
 * Reflection VP's audit: a peer's ask a teammate's host refused was parked, retired an hour later,
 * and its sender never heard; a trigger's reminder parked on the same refusal was 5 h 45 min late
 * with no `parked` step in the ledger). src/core/sessions/undelivered-tell.ts, fed by the ledger's
 * step observer; the parks come from the queue file's one writer (session-queue-exits.ts).
 * Real queue file, ledger, held-notices file, session and request stores in a test home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-undelivered-tell') }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { deleteMessage, enqueueMessage, getQueue, parkMessages, resetCache, unparkMessage } from '../../../src/core/session-message-queue.js'
import { _resetQueueExitsForTesting } from '../../../src/core/session-queue-exits.js'
import { mutateStore } from '../../../src/core/session-queue-store.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { COLD_HOLD_REASON } from '../../../src/core/relay-fates.js'
import { HOST_REFUSED_REASON } from '../../../src/providers/host-judged-send.js'
import { onDeliveryEvent, readDeliveryLines, recordDelivery, startDeliveryLedger, trailsOf } from '../../../src/core/sessions/delivery-ledger.js'
import { _clearHeldNotices } from '../../../src/core/sessions/held-notices.js'
import { _resetHeldStoreForTesting, fateOf, held } from '../../../src/core/sessions/held-notices-store.js'
import { DROP_TELL_KEY, flushDropTells, startHeldNotices, stopHeldNotices } from '../../../src/core/sessions/held-notices-sweep.js'
import { WAIT_TELL_MS, _resetUndeliveredTellForTesting, _settledForTesting, sweepWaits } from '../../../src/core/sessions/undelivered-tell.js'
import { createSessionRequest, getSessionRequest } from '../../../src/core/session-requests.js'
import { RETIRE_AFTER_MS, stopDeliveryRetry, sweepDeliveryRetries } from '../../../src/core/sessions/delivery-retry.js'
import { addTask, updateTask } from '../../../src/core/task-manager.js'
import { EventNames } from '../../../src/core/event-bus.js'
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js'

const TARGET = 'aaaaaaaa-1111-4222-8333-555555555555'
const SENDER = 'bbbbbbbb-1111-4222-8333-555555555555'
const RIDER = 'cccccccc-1111-4222-8333-555555555555'
let ledger: { stop: () => void } | null = null

/** Let the ledger write, its observer tell, and the tells be held for their senders. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 40))
    await _settledForTesting()
  }
  await flushDropTells()
}
const steps = async (id: string) => (await readDeliveryLines(1)).filter((l) => l.id === id).map((l) => l.step)
const tellOf = (sid: string) => held.get(sid)?.get(DROP_TELL_KEY)?.text ?? ''

/** A peer's message to TARGET, sent by SENDER (as session-send-core.ts records it). */
async function peerRow(text: string, opts: { title?: string; requestId?: string } = {}) {
  const row = await enqueueMessage(TARGET, text, { sentBy: 'agent' })
  await recordDelivery({ step: 'sent', id: row.id, sessionId: TARGET, from: SENDER, fromTaskId: 't-sender', source: 'peer', ...(opts.title ? { title: opts.title } : {}), ...(opts.requestId ? { requestId: opts.requestId } : {}) })
  return row
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetQueueExitsForTesting()
  _resetSessionTrackerForTesting()
  _resetUndeliveredTellForTesting()
  await _resetHeldStoreForTesting()
  _clearHeldNotices()
  stopDeliveryRetry()
  await startHeldNotices()
  await createSessionRecord(TARGET, 't-target', 'Acme', '/gone', { initialProcessStatus: 'stopped' })
  await createSessionRecord(SENDER, 't-sender', 'Acme', '/tmp', { initialProcessStatus: 'idle' })
  await createSessionRecord(RIDER, 't-rider', 'Acme', '/tmp', { initialProcessStatus: 'idle' })
  ledger = startDeliveryLedger()
  await settle()
})

afterEach(async () => {
  ledger?.stop()
  stopDeliveryRetry()
  await stopHeldNotices()
  await _resetHeldStoreForTesting()
  _resetUndeliveredTellForTesting()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a message set aside tells its sender once, and the ledger has the park', () => {
  it('a host refusal: `parked` with why, its sender told it is not delivered yet, once', async () => {
    const row = await peerRow('copy the recording', { title: 'Copy the recording' })
    await parkMessages([row], `${HOST_REFUSED_REASON}: host_runs_sessions_off`)
    await settle()
    expect(await steps(row.id)).toEqual(['queued', 'sent', 'parked', 'told'])
    const line = (await readDeliveryLines(1)).find((l) => l.id === row.id && l.step === 'parked')
    expect(line?.why).toContain('host_runs_sessions_off')
    expect(tellOf(SENDER)).toContain('not delivered yet')
    expect(tellOf(SENDER)).toContain('"Copy the recording"')
    // The trail's state is the park; `told` is no state.
    expect(trailsOf(await readDeliveryLines(1)).find((t) => t.id === row.id)?.state).toBe('parked')

    // Back in line and parked again: its sender is not told twice.
    await unparkMessage(TARGET, row.id)
    await parkMessages([row], `${HOST_REFUSED_REASON}: host_runs_sessions_off`)
    await settle()
    expect((await steps(row.id)).filter((s) => s === 'told')).toHaveLength(1)
    expect((await steps(row.id)).filter((s) => s === 'queued')).toHaveLength(2)
  })

  it('a hold on its own clock tells nothing at once, and tells once it outlasts WAIT_TELL_MS', async () => {
    const row = await peerRow('for the next wake')
    await parkMessages([row], COLD_HOLD_REASON)
    await settle()
    expect(await steps(row.id)).toEqual(['queued', 'sent', 'parked'])
    expect(tellOf(SENDER)).toBe('')
    expect(await sweepWaits(Date.now() + WAIT_TELL_MS + 1000)).toBe(1)
    await settle()
    expect(await steps(row.id)).toEqual(['queued', 'sent', 'parked', 'told'])
    expect(tellOf(SENDER)).toContain('still not delivered after')
  })

  it('a tell that it is not delivered yet is taken back once the message is delivered', async () => {
    const row = await peerRow('delivered after all')
    await parkMessages([row], `${HOST_REFUSED_REASON}: host_runs_sessions_off`)
    await settle()
    // Told, but not yet read by its sender (it waits for the sender's next message).
    expect(tellOf(SENDER)).toContain('not delivered yet')
    await recordDelivery({ step: 'written', id: row.id, sessionId: TARGET })
    await settle()
    expect(tellOf(SENDER)).toBe('')
  })
})

describe('a message voided unsent tells its sender, and the notes that rode it tell theirs', () => {
  it('a parked row discarded: `removed`, its sender told it will not be delivered', async () => {
    const row = await peerRow('discarded words')
    await parkMessages([row], 'Not delivered: Claude Code exited before it read this message. Retry it.')
    await settle()
    expect(await deleteMessage(TARGET, row.id)).toBe(true)
    await settle()
    expect(await steps(row.id)).toEqual(['queued', 'sent', 'parked', 'told', 'removed', 'told'])
    expect(tellOf(SENDER)).toContain('NOT delivered, and it will not be')
  })

  it('a held note that rode a row which was then dropped: its sender is told and its fate says so', async () => {
    const row = await peerRow('the carrier')
    await recordDelivery({ step: 'held', id: 'qm-rider-1', sessionId: TARGET, from: RIDER, fromTaskId: 't-rider', title: 'Side note' })
    await recordDelivery({ step: 'carried', id: row.id, sessionId: TARGET, ids: ['qm-rider-1'] })
    await mutateStore((s) => { s.queues[TARGET] = (s.queues[TARGET] ?? []).filter((m) => m.id !== row.id) })
    await settle()
    expect(tellOf(SENDER)).toContain('NOT delivered')
    expect(tellOf(RIDER)).toContain('it rode message')
    expect(fateOf('qm-rider-1')?.state).toBe('dropped')
  })

  it('a held note whose sender the hold told it still waits, then rides a row that is set aside: its sender is told of that too', async () => {
    // The hold's own tell (`note-wait`) says nothing of the row it rides later (review, 2026-11-27).
    await recordDelivery({ step: 'held', id: 'qm-rider-2', sessionId: TARGET, from: RIDER, fromTaskId: 't-rider', title: 'Side note' })
    await recordDelivery({ step: 'told', id: 'qm-rider-2', sessionId: TARGET, told: RIDER, via: 'note-wait', why: 'not delivered yet: its target is stopped' })
    const row = await peerRow('the carrier')
    await recordDelivery({ step: 'carried', id: row.id, sessionId: TARGET, ids: ['qm-rider-2'] })
    await parkMessages([row], `${HOST_REFUSED_REASON}: host_runs_sessions_off`)
    await settle()
    expect(tellOf(RIDER)).toContain('it rode message')
    expect((await readDeliveryLines(1)).filter((l) => l.id === 'qm-rider-2' && l.step === 'told').map((l) => l.via)).toEqual(['note-wait', 'park'])
  })

  it('a host\'s queue fact that its row was dropped tells the sender here', async () => {
    const id = 'qm-host-remote-1'
    await recordDelivery({ step: 'sent', id, sessionId: TARGET, from: SENDER, fromTaskId: 't-sender', source: 'peer' })
    await onDeliveryEvent({ name: EventNames.SESSION_QUEUE_LEFT, data: { sessionId: TARGET, messageIds: [id], exits: { [id]: { step: 'parked', why: 'Working directory no longer exists (/gone)' } } }, source: 'host-channel' } as never)
    await settle()
    expect(await steps(id)).toEqual(['sent', 'parked', 'told'])
    await onDeliveryEvent({ name: EventNames.SESSION_QUEUE_LEFT, data: { sessionId: TARGET, messageIds: [id], exits: { [id]: { step: 'dropped', why: 'not delivered: its task is complete' } } }, source: 'host-channel' } as never)
    await settle()
    expect(await steps(id)).toEqual(['sent', 'parked', 'told', 'dropped', 'told'])
    expect(tellOf(SENDER)).toContain('its task is complete')
  })

  it('a peer\'s ask with an open request is answered through it: settled not delivered, no second notice', async () => {
    const id = 'qm-host-remote-2'
    const request = await createSessionRequest({ fromSessionId: SENDER, toSessionId: TARGET, toTaskId: 't-target', text: 'please copy', messageId: id })
    await recordDelivery({ step: 'sent', id, sessionId: TARGET, from: SENDER, fromTaskId: 't-sender', source: 'peer', requestId: request.id })
    await recordDelivery({ step: 'dropped', id, sessionId: TARGET, why: 'not delivered: its task is complete' })
    await settle()
    expect((await getSessionRequest(request.id))?.status).not.toBe('pending')
    const told = (await readDeliveryLines(1)).filter((l) => l.id === id && l.step === 'told')
    expect(told).toHaveLength(1)
    expect(told[0].why).toContain(request.id)
    expect(tellOf(SENDER)).toBe('')
  })

  it('a person\'s words and Walnut\'s own notices have no session to tell', async () => {
    const own = await enqueueMessage(TARGET, 'his words', { sentBy: 'person' })
    await recordDelivery({ step: 'sent', id: own.id, sessionId: TARGET, from: 'person', source: 'web' })
    const walnut = await enqueueMessage(TARGET, 'a notice', { sentBy: 'agent' })
    await deleteMessage(TARGET, own.id)
    await deleteMessage(TARGET, walnut.id)
    await settle()
    for (const id of [own.id, walnut.id]) expect(await steps(id), id).not.toContain('told')
    expect(held.get(SENDER)).toBeUndefined()
    expect((await getQueue(TARGET))).toEqual([])
  })
})

describe('the 11-26 case: a peer\'s ask its target\'s host refused, then retired with the task complete', () => {
  it('its asker hears at the park and again at the retire; the ledger has parked, told, dropped, told', async () => {
    const { task } = await addTask({ title: 'Copy the recording', project: 'Acme' })
    const sid = 'dddddddd-1111-4222-8333-555555555555'
    await createSessionRecord(sid, task.id, 'Acme', '/gone', { initialProcessStatus: 'stopped' })
    const request = await createSessionRequest({ fromSessionId: SENDER, toSessionId: sid, toTaskId: task.id, text: 'please copy the recording' })
    // As a peer's task_send queues it: the envelope names its request.
    const text = buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Walnut VP', request: request.id, 'from-task': 't-sender' }, body: 'please copy the recording' })
    const row = await enqueueMessage(sid, text, { sentBy: 'agent' })
    await recordDelivery({ step: 'sent', id: row.id, sessionId: sid, from: SENDER, fromTaskId: 't-sender', source: 'peer', requestId: request.id })
    await parkMessages([row], `${HOST_REFUSED_REASON}: host_runs_sessions_off`)
    // Parked where it is: answered through its request (the park proves it never ran).
    await vi.waitFor(async () => {
      await settle()
      const first = (await readDeliveryLines(1)).filter((l) => l.id === row.id).map((l) => [l.step, l.via])
      expect(first).toContainEqual(['parked', undefined])
      expect(first).toContainEqual(['told', 'request'])
    }, { timeout: 20_000, interval: 200 })
    await updateTask(task.id, { phase: 'COMPLETE' } as never)
    // Retired an hour after its task completed (the later of that and its park).
    await sweepDeliveryRetries(Date.now() + RETIRE_AFTER_MS + 5000)
    await settle()
    expect(await getQueue(sid)).toEqual([])
    // Answered "not delivered yet" at the park; the retire tells it that it was not delivered after all.
    await vi.waitFor(async () => {
      await settle()
      const all = await steps(row.id)
      expect(all.slice(all.indexOf('parked'))).toEqual(['parked', 'told', 'dropped', 'told'])
    }, { timeout: 20_000, interval: 200 })
    // Asked and not answered by then: settled as not delivered (by the park's notice or the retire's).
    expect((await getSessionRequest(request.id))?.status).not.toBe('pending')
  })
})

describe('what the review of this teller found (2026-11-26)', () => {
  it('a park recorded before a restart, not a hold, is not told again as if new', async () => {
    await recordDelivery({ step: 'sent', id: 'qm-old-1', sessionId: TARGET, from: SENDER, source: 'peer' })
    await recordDelivery({ step: 'parked', id: 'qm-old-1', sessionId: TARGET, why: 'Working directory no longer exists' })
    await settle()
    // As a restart finds it: the teller reads the ledger back.
    _resetUndeliveredTellForTesting()
    expect(await sweepWaits(Date.now() + 10 * WAIT_TELL_MS)).toBe(0)
  })

  it('a second park for another reason within seconds is its own step, and is told', async () => {
    const row = await peerRow('waits, then fails')
    await recordDelivery({ step: 'parked', id: row.id, sessionId: TARGET, why: 'Waiting to confirm the previous message', via: 'wait' })
    await parkMessages([row], `${HOST_REFUSED_REASON}: host_runs_sessions_off`)
    await settle()
    expect((await steps(row.id)).filter((x) => x === 'parked')).toHaveLength(2)
    expect(tellOf(SENDER)).toContain('host_runs_sessions_off')
  })

  it('a park seen before its sender\'s `sent` step tells once that step comes', async () => {
    const row = await enqueueMessage(TARGET, 'parked mid-send', { sentBy: 'agent' })
    await parkMessages([row], 'Not delivered: Claude Code exited before it read this message. Retry it.')
    await settle()
    expect(await steps(row.id)).not.toContain('told')
    await recordDelivery({ step: 'sent', id: row.id, sessionId: TARGET, from: SENDER, fromTaskId: 't-sender', source: 'peer' })
    await settle()
    expect(await steps(row.id)).toContain('told')
  })

  it('a message read by its session and removed after is not told "not delivered"', async () => {
    const row = await peerRow('read, then cleaned up')
    await recordDelivery({ step: 'read', sessionId: TARGET, ids: [row.id] })
    await deleteMessage(TARGET, row.id)
    await settle()
    expect(await steps(row.id)).not.toContain('told')
  })

  it('a Stop\'s cancel says its text went back to the person', async () => {
    const id = 'qm-cancel-1'
    await recordDelivery({ step: 'sent', id, sessionId: TARGET, from: SENDER, source: 'peer' })
    await onDeliveryEvent({ name: EventNames.SESSION_QUEUED_CANCELLED, data: { sessionId: TARGET, messageIds: [id], messages: ['x'] } } as never)
    await settle()
    expect(tellOf(SENDER)).toContain('went back to the person who stopped it')
  })
})

