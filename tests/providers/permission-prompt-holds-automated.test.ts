/**
 * A pending permission prompt (an ExitPlanMode plan card, a Write card) is the
 * user's to answer. A message nobody typed (a peer task's message, a letter, a
 * subtask notice, a trigger) used to auto-deny it on delivery, so a user had to
 * tell the other tasks to stop messaging. Now such a row waits in the queue
 * behind the prompt and goes out, in order, once the prompt is answered; only a
 * person's message (QueuedMessage.closesPrompt) still answers it with a deny.
 *
 * The real CLI (2.1.284) only queues a stdin line written behind a pending
 * can_use_tool (command_lifecycle `queued`) and keeps the prompt open, so the
 * deny was Walnut's own and the hold is Walnut's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-permission-prompt-hold'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { enqueueMessage, getQueue, markProcessing, unmarkUnwritten } from '../../src/core/session-message-queue.js'
import { heldRows } from '../../src/providers/line-consumption.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { SID, harness, named, probeSetup, probeTeardown, rows, settle, type Harness } from '../helpers/runner-probe-harness.js'

beforeEach(probeSetup)
afterEach(probeTeardown)

const PROMPT = 'perm-write-1'

/** The CLI asks to run a tool and the user has the card in front of them (its re-ask
 *  timer runs). `shown: false` = a request still in Walnut's hands (a bypass approval
 *  being read, a worker question routed to the leader): no card, no timer. */
function promptPending(h: Harness, toolName = 'Write', opts: { shown?: boolean } = {}) {
  Object.assign(h.session, { _pendingPermissionRequests: new Map([[PROMPT, {
    request_id: PROMPT, request: { subtype: 'can_use_tool', tool_name: toolName, input: { file_path: '/tmp/x.txt', content: 'hi' } },
  }]]) })
  if (opts.shown !== false) {
    const timer = setInterval(() => {}, 60_000)
    timer.unref()
    ;(h.session as unknown as { _permissionReEmitTimers: Map<string, unknown> })._permissionReEmitTimers.set(PROMPT, timer)
  }
  const raw: string[] = []
  const transport = (h.session as unknown as { _transport: { writeRaw: (s: string) => boolean } })._transport
  transport.writeRaw = (s: string) => { raw.push(s); return true }
  const answers = () => raw.map((s) => JSON.parse(s).response.response.behavior as string)
  return { answers }
}

async function started(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts)
  h.runner.init()
  await settle(200)
  return h
}

describe('a pending permission prompt and the messages queued behind it', () => {
  it('a message nobody typed waits behind the prompt mid-turn: nothing written, the prompt stays open', async () => {
    const h = await started()
    const p = promptPending(h)
    await enqueueMessage(SID, 'subtask notice')
    await h.internals.injectMidTurn(SID)
    await settle()
    expect(h.writes).toEqual([])
    expect(p.answers()).toEqual([])
    expect(h.session.hasPendingPermission).toBe(true)
    expect(await rows()).toEqual(['subtask notice:pending'])
    const id = (await getQueue(SID))[0].id
    expect(heldRows(SID)?.get(id)).toBe('Waiting for the permission prompt to be answered')
    expect(named(h, EventNames.SESSION_DELIVERY_HELD, id)).toHaveLength(1)
  })

  it('the user approves: the held message goes out after the approval, and the approval is the only answer', async () => {
    const h = await started()
    const p = promptPending(h)
    await enqueueMessage(SID, 'peer message')
    await h.internals.injectMidTurn(SID)
    await settle()
    expect(h.writes).toEqual([])
    expect(await h.session.resolvePermissionRequest(PROMPT, true)).toBe(true)
    await vi.waitFor(() => expect(h.writes.map((w) => w.message)).toEqual(['peer message']))
    expect(p.answers()).toEqual(['allow'])
    expect(h.session.hasPendingPermission).toBe(false)
  })

  it('the user denies: the held message goes out after the deny', async () => {
    const h = await started()
    const p = promptPending(h, 'ExitPlanMode')
    await enqueueMessage(SID, 'letter answer')
    await h.internals.injectMidTurn(SID)
    await settle()
    expect(await h.session.resolvePermissionRequest(PROMPT, false, 'User denied permission')).toBe(true)
    await vi.waitFor(() => expect(h.writes.map((w) => w.message)).toEqual(['letter answer']))
    expect(p.answers()).toEqual(['deny'])
  })

  it('a withdrawn prompt (a Stop, the CLI cancelling) does not send what waited behind it', async () => {
    const h = await started()
    promptPending(h)
    await enqueueMessage(SID, 'peer message')
    await h.internals.injectMidTurn(SID)
    await settle()
    ;(h.session as unknown as { _pendingPermissionRequests: Map<string, unknown> })._pendingPermissionRequests.clear()
    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, { sessionId: SID, requestId: PROMPT, allowed: false, cancelled: true } as never, ['*'], { source: 'test' })
    await settle(200)
    expect(h.writes).toEqual([])
    expect(await rows()).toEqual(['peer message:pending'])
    // No prompt is left to wait for, so the row no longer says it waits for one.
    expect(heldRows(SID)?.size ?? 0).toBe(0)
  })

  it('a person\'s message still answers the prompt with a deny, and goes out', async () => {
    const h = await started()
    const p = promptPending(h)
    await enqueueMessage(SID, 'no, do it differently', { closesPrompt: true })
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(() => expect(h.writes.map((w) => w.message)).toEqual(['no, do it differently']))
    expect(p.answers()).toEqual(['deny'])
  })

  it('a person\'s message behind a held one: one deny, then both in the order they came', async () => {
    const h = await started()
    const p = promptPending(h)
    await enqueueMessage(SID, 'subtask notice')
    await h.internals.injectMidTurn(SID)
    await settle()
    await enqueueMessage(SID, 'what the user typed', { closesPrompt: true })
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(async () => expect(await rows()).not.toContain('what the user typed:pending'))
    await settle(300)
    expect(h.writes.map((w) => w.message).join('\n\n')).toBe('subtask notice\n\nwhat the user typed')
    expect(p.answers()).toEqual(['deny'])
  })

  it('between turns (processNext) a message nobody typed waits too, and nothing is resumed', async () => {
    const h = await started({ running: false })
    const p = promptPending(h, 'ExitPlanMode')
    await enqueueMessage(SID, 'trigger fired')
    await h.internals.processNext(SID)
    await settle()
    expect(h.writes).toEqual([])
    expect(h.resumes).toEqual([])
    expect(p.answers()).toEqual([])
    expect(await rows()).toEqual(['trigger fired:pending'])
    // The row is untouched: its next delivery is a first one, not a resend.
    expect((await getQueue(SID))[0]).not.toHaveProperty('lineUuid')
  })

  it('an empty queue never denies the prompt (an extra delivery finds nothing to send)', async () => {
    const h = await started()
    const p = promptPending(h)
    await h.internals.injectMidTurn(SID)
    await h.internals.processNext(SID)
    await settle()
    expect(p.answers()).toEqual([])
    expect(h.session.hasPendingPermission).toBe(true)
    expect(h.writes).toEqual([])
  })

  it('a request the user was never shown holds nothing: the line is written and the CLI queues it', async () => {
    const h = await started()
    const p = promptPending(h, 'Bash', { shown: false })
    await enqueueMessage(SID, 'subtask notice')
    await h.internals.injectMidTurn(SID)
    await vi.waitFor(() => expect(h.writes.map((w) => w.message)).toEqual(['subtask notice']))
    expect(p.answers()).toEqual([])
    expect(h.session.hasPendingPermission).toBe(true)
  })

  it('a dead process holds nothing: the queue goes on to its usual recovery', async () => {
    const h = await started({ running: false })
    promptPending(h)
    Object.assign(h.session, { _active: false })
    await enqueueMessage(SID, 'subtask notice')
    await h.internals.processNext(SID)
    await settle(300)
    const id = (await getQueue(SID))[0]?.id
    expect(id ? heldRows(SID)?.get(id) : undefined).toBeUndefined()
  })

  it('an expired prompt (the process died) releases the note and wakes nothing', async () => {
    const h = await started()
    promptPending(h)
    await enqueueMessage(SID, 'peer message')
    await h.internals.injectMidTurn(SID)
    await settle()
    expect(heldRows(SID)?.size).toBe(1)
    ;(h.session as unknown as { _pendingPermissionRequests: Map<string, unknown> })._pendingPermissionRequests.clear()
    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, { sessionId: SID, requestId: PROMPT, allowed: false, expired: true } as never, ['*'], { source: 'test' })
    await settle(200)
    expect(heldRows(SID)?.size ?? 0).toBe(0)
    expect(h.writes).toEqual([])
    expect(h.resumes).toEqual([])
  })

  it('between turns a person\'s message still denies and is written', async () => {
    const h = await started({ running: false })
    const p = promptPending(h, 'ExitPlanMode')
    await enqueueMessage(SID, 'skip the plan', { closesPrompt: true })
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.writes.map((w) => w.message)).toEqual(['skip the plan']))
    expect(p.answers()).toEqual(['deny'])
  })
})

describe('unmarkUnwritten: a batch taken but never written goes back as it was', () => {
  it('a first delivery loses its line uuid and tries', async () => {
    await enqueueMessage(SID, 'm1')
    const batch = await markProcessing(SID, null, { tracked: true })
    expect(batch[0]).toMatchObject({ status: 'processing', lineTries: 1, lineTracked: true })
    await unmarkUnwritten(batch)
    const [row] = await getQueue(SID)
    expect(row.status).toBe('pending')
    expect(row).not.toHaveProperty('lineUuid')
    expect(row).not.toHaveProperty('lineTries')
    expect(row).not.toHaveProperty('lineTracked')
  })

  it('a resend keeps the uuid it inherited', async () => {
    const uuid = '40000000-0000-4000-8000-000000000001'
    await enqueueMessage(SID, 'm1', { lineUuid: uuid })
    const batch = await markProcessing(SID, null)
    expect(batch[0].lineTries).toBe(2)
    await unmarkUnwritten(batch)
    expect((await getQueue(SID))[0]).toMatchObject({ status: 'pending', lineUuid: uuid, lineTries: 1 })
  })
})

describe('who answers a prompt: the row says so at enqueue', () => {
  it.each([
    ['ui', true], ['mobile', true], ['cli', true], ['web-api', true], ['api-v1', true], ['chat', true],
    ['peer', false], ['human-inbox', false], ['walnut-notify', false], ['trigger', false], ['auto-continue', false], [undefined, false],
  ])('source %s → closesPrompt %s', async (source, closes) => {
    const { sendMessageToSession } = await import('../../src/core/session-message-queue.js')
    const row = await sendMessageToSession(SID, 'hello', source ? { source } : {})
    expect(row.closesPrompt === true).toBe(closes)
  })

  it('a leader answering its worker\'s question closes the prompt although it is a peer send', async () => {
    const { sendMessageToSession } = await import('../../src/core/session-message-queue.js')
    const row = await sendMessageToSession(SID, 'the user says yes', { source: 'peer', closesPrompt: true })
    expect(row.closesPrompt).toBe(true)
  })
})
