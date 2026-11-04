/**
 * The phone's Stop and Interrupt & send, on the PRIMARY box:
 *   POST /api/v1/sessions/:id/interrupt            stops the running turn and nothing else
 *   POST /api/v1/sessions/:id/messages {interrupt} stops it, then delivers the message
 *   POST /api/v1/messages/:id/send-now {interrupt} the same for a row already queued
 * Bare express + supertest; the runner is not started, so the bus event and the
 * arguments of the queue call are what is asserted. The cloud relay ladder lives in
 * api-v1-session-interrupt-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-interrupt'))

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (_sessionId: string, _text: string, _opts?: Record<string, unknown>) => ({ id: 'qm-queued-1' })),
}))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessageToSession: sendMock,
}))

import express from 'express'
import request from 'supertest'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { messagesV1Router } from '../../../src/web/routes/messages-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { enqueueMessage } from '../../../src/core/session-message-queue.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use('/api/v1', sessionStreamV1Router)
  app.use('/api/v1', messagesV1Router)
  app.use(errorHandler)
  return app
}

let interrupts: string[] = []
let sends: Array<{ sessionId: string; message: string; interrupt?: boolean }> = []

beforeEach(async () => {
  sendMock.mockClear()
  interrupts = []
  sends = []
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bus.subscribe('test-interrupt-listener', (e) => {
    if (e.name === EventNames.SESSION_INTERRUPT) interrupts.push((e.data as { sessionId: string }).sessionId)
    if (e.name === EventNames.SESSION_SEND) {
      const d = e.data as { sessionId: string; message: string; interrupt?: boolean }
      sends.push({ sessionId: d.sessionId, message: d.message, interrupt: d.interrupt })
    }
  }, { global: true, interest: [EventNames.SESSION_INTERRUPT, EventNames.SESSION_SEND] })
})

afterEach(async () => {
  bus.unsubscribe('test-interrupt-listener')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/v1/sessions/:id/interrupt', () => {
  it('stops the running turn: one SESSION_INTERRUPT, the session record untouched', async () => {
    await createSessionRecord('int-run-1', 'task-i1', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const res = await request(createApp()).post('/api/v1/sessions/int-run-1/interrupt').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'interrupted', sessionId: 'int-run-1', wasRunning: true })
    expect(interrupts).toEqual(['int-run-1'])
    // A stop is not a terminate: the record still says the process is there.
    expect((await getSessionByClaudeId('int-run-1'))?.process_status).toBe('running')
  })

  it('an idle session answers wasRunning false and still sends the stop (the runner decides)', async () => {
    await createSessionRecord('int-idle-1', 'task-i2', 'proj', '/tmp', { initialProcessStatus: 'idle' })
    const res = await request(createApp()).post('/api/v1/sessions/int-idle-1/interrupt').send({})
    expect(res.status).toBe(200)
    expect(res.body.wasRunning).toBe(false)
    expect(interrupts).toEqual(['int-idle-1'])
  })

  it('an unknown session is 404 in the frozen error shape and sends nothing', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/no-such-session/interrupt').send({})
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(interrupts).toEqual([])
  })

  it('an id outside the safe alphabet is 400', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/bad%20id/interrupt').send({})
    expect(res.status).toBe(400)
    expect(interrupts).toEqual([])
  })

  it('a session cannot stop itself: 409 own_session, no event', async () => {
    await createSessionRecord('int-self-1', 'task-i3', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const res = await request(createApp()).post('/api/v1/sessions/int-self-1/interrupt')
      .set('x-walnut-caller-sid', 'int-self-1').send({})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('own_session')
    expect(interrupts).toEqual([])
  })

  it('the control relay answers the same action for a companion that asks this box', async () => {
    await createSessionRecord('int-relay-1', 'task-i4', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const out = await handleSessionControlRelay('interrupt', 'int-relay-1', {})
    expect(out).toEqual({ ok: true, result: { status: 'interrupted', sessionId: 'int-relay-1', wasRunning: true } })
    expect(interrupts).toEqual(['int-relay-1'])
    const gone = await handleSessionControlRelay('interrupt', 'int-relay-missing', {})
    expect(gone.ok).toBe(false)
  })
})

describe('POST /api/v1/sessions/:id/messages with interrupt', () => {
  async function session(id: string) {
    await createSessionRecord(id, `task-${id}`, 'proj', '/tmp', { initialProcessStatus: 'running' })
  }

  it('hands interrupt: true to the queue with the message', async () => {
    await session('msg-int-1')
    const res = await request(createApp()).post('/api/v1/sessions/msg-int-1/messages')
      .send({ text: 'stop and do this instead', messageId: 'qm-mobile-int000001', interrupt: true })
    expect(res.status).toBe(202)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const [sid, text, opts] = sendMock.mock.calls[0]
    expect(sid).toBe('msg-int-1')
    expect(text).toBe('stop and do this instead')
    expect(opts).toMatchObject({ interrupt: true, messageId: 'qm-mobile-int000001' })
  })

  it('without interrupt the queue call carries none (a plain send is unchanged)', async () => {
    await session('msg-int-2')
    const res = await request(createApp()).post('/api/v1/sessions/msg-int-2/messages').send({ text: 'plain' })
    expect(res.status).toBe(202)
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty('interrupt')
  })

  it('interrupt: false is a plain send', async () => {
    await session('msg-int-3')
    const res = await request(createApp()).post('/api/v1/sessions/msg-int-3/messages').send({ text: 'plain', interrupt: false })
    expect(res.status).toBe(202)
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty('interrupt')
  })

  it('a non-boolean interrupt is 400 and sends nothing', async () => {
    await session('msg-int-4')
    const res = await request(createApp()).post('/api/v1/sessions/msg-int-4/messages').send({ text: 'x', interrupt: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/messages/:id/send-now with interrupt', () => {
  it('re-drains the queued row with interrupt: true, the same row and never a copy', async () => {
    await createSessionRecord('now-int-1', 'task-now1', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const row = await enqueueMessage('now-int-1', 'queued behind the turn')
    const res = await request(createApp()).post(`/api/v1/messages/${row.id}/send-now`).send({ interrupt: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sent: true, messageId: row.id, sessionId: 'now-int-1' })
    expect(sends).toEqual([{ sessionId: 'now-int-1', message: 'queued behind the turn', interrupt: true }])
  })

  it('without the flag the re-drain carries none', async () => {
    await createSessionRecord('now-int-2', 'task-now2', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const row = await enqueueMessage('now-int-2', 'queued')
    const res = await request(createApp()).post(`/api/v1/messages/${row.id}/send-now`).send({})
    expect(res.status).toBe(200)
    expect(sends).toEqual([{ sessionId: 'now-int-2', message: 'queued', interrupt: undefined }])
  })

  it('a session caller cannot interrupt with it: 400', async () => {
    await createSessionRecord('now-int-3', 'task-now3', 'proj', '/tmp', { initialProcessStatus: 'running' })
    const row = await enqueueMessage('now-int-3', 'queued')
    const res = await request(createApp()).post(`/api/v1/messages/${row.id}/send-now`)
      .set('x-walnut-caller-sid', 'some-other-session').send({ interrupt: true })
    expect(res.status).toBe(400)
    expect(sends).toEqual([])
  })

  it('a non-boolean interrupt is 400', async () => {
    const res = await request(createApp()).post('/api/v1/messages/qm-whatever-1/send-now').send({ interrupt: 1 })
    expect(res.status).toBe(400)
  })
})
