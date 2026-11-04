/**
 * POST /api/v1/sessions/:id/messages { afterTurn }: line a message up for after the running
 * turn. The route only parses and passes the flag (the hold itself is pinned in
 * tests/core/sessions/queue-after-turn.test.ts); `interrupt` wins when both are sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-after-turn'))

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (_sessionId: string, _text: string, _opts?: Record<string, unknown>): Promise<Record<string, unknown>> => ({ id: 'qm-queued-1', status: 'pending' })),
}))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessageToSession: sendMock,
}))

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { AFTER_TURN_REASON } from '../../../src/core/relay-fates.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionStreamV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  sendMock.mockClear()
  sendMock.mockImplementation(async () => ({ id: 'qm-queued-1', status: 'pending' }))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await createSessionRecord('at-1', 'task-at-1', 'proj', '/tmp', { initialProcessStatus: 'running' })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/v1/sessions/:id/messages with afterTurn', () => {
  it('hands afterTurn: true to the queue and says when the row was held', async () => {
    sendMock.mockImplementation(async () => ({ id: 'qm-held-1', status: 'parked', parkedReason: AFTER_TURN_REASON }))
    const res = await request(createApp()).post('/api/v1/sessions/at-1/messages').send({ text: 'then this', afterTurn: true })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ messageId: 'qm-held-1', afterTurn: true })
    expect(sendMock.mock.calls[0][2]).toMatchObject({ afterTurn: true })
  })

  it('a send that was not held (no turn ran) answers as before', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/at-1/messages').send({ text: 'idle', afterTurn: true })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ messageId: 'qm-queued-1' })
  })

  it('without the flag the queue call carries none', async () => {
    await request(createApp()).post('/api/v1/sessions/at-1/messages').send({ text: 'plain' })
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty('afterTurn')
  })

  it('interrupt wins when both are sent', async () => {
    await request(createApp()).post('/api/v1/sessions/at-1/messages').send({ text: 'steer', interrupt: true, afterTurn: true })
    const opts = sendMock.mock.calls[0][2]
    expect(opts).toMatchObject({ interrupt: true })
    expect(opts).not.toHaveProperty('afterTurn')
  })

  it('a flag that is not a boolean is 400 and sends nothing', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/at-1/messages').send({ text: 'x', afterTurn: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(sendMock).not.toHaveBeenCalled()
  })
})
