/**
 * POST /api/v1/messages + GET /api/v1/requests/:id — transport only.
 *
 * Every semantic decision (who may send, fencing, throttling, the reply ledger)
 * lives in core/sessions/session-send-core.ts, so this file pins exactly the
 * three things the ROUTE owns and nothing else:
 *
 *  1. The caller provenance headers (x-walnut-caller-sid / -host) reach the core
 *     input. They are what decides whether a message is fenced as peer text, so
 *     a header the route forgets to forward silently turns another session's
 *     words into "the human typed this".
 *  2. A SendError becomes its OWN status code plus the frozen `{error:{code,
 *     message}}` shape, with `detail` spread alongside — the iOS app and the CLI
 *     both branch on that code (e.g. task_has_no_session → offer session_start).
 *  3. The request-status read validates the id shape before touching the ledger,
 *     and answers 404 rather than 200-with-null for a row that is not there.
 *
 * The core is mocked at its module seam (importOriginal keeps the REAL SendError
 * class, so the route's `instanceof` branch is the production one).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

/** Flipped by the CLOUD_MODE case; read lazily via the getter below. */
let cloudMode = false

vi.mock('../../../src/constants.js', () => {
  const base = createMockConstants('walnut-messages-v1')
  return { ...base, get CLOUD_MODE() { return cloudMode } }
})

const performSessionSendMock = vi.fn()
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return { ...orig, performSessionSend: (...args: unknown[]) => performSessionSendMock(...args) }
})

const getSessionRequestMock = vi.fn()
vi.mock('../../../src/core/session-requests.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/session-requests.js')>()
  return { ...orig, getSessionRequest: (...args: unknown[]) => getSessionRequestMock(...args) }
})

import express from 'express'
import request from 'supertest'
import { messagesV1Router } from '../../../src/web/routes/messages-v1.js'
import { SendError } from '../../../src/core/sessions/session-send-core.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', messagesV1Router)
  app.use(errorHandler)
  return app
}

/** The one input object the route handed the core. */
function coreInput(): Record<string, unknown> {
  return performSessionSendMock.mock.calls[0][0] as Record<string, unknown>
}

const OK_RESULT = {
  delivery: 'queued' as const,
  targetSessionId: 'sess-target-1',
  targetTitle: 'Target',
  targetTaskId: 'task-77',
  requestId: 'rq-0123456789ab',
  messageId: 'qm-1',
}

beforeEach(() => {
  cloudMode = false
  performSessionSendMock.mockReset()
  getSessionRequestMock.mockReset()
  // Default: behave like the real core — it, not the route, validates text.
  performSessionSendMock.mockImplementation(async (input: { text?: string }) => {
    if (!(input.text ?? '').trim()) throw new SendError('bad_request', 'text must be a non-empty string')
    return OK_RESULT
  })
  getSessionRequestMock.mockResolvedValue(undefined)
})

afterEach(() => {
  cloudMode = false
})

describe('POST /api/v1/messages', () => {
  it('202s with the core result echoed unchanged', async () => {
    const res = await request(createApp())
      .post('/api/v1/messages')
      .send({ to: 'sess-target-1', text: 'do the thing', expect_reply: true, reply_timeout: 120 })

    expect(res.status).toBe(202)
    expect(res.body).toEqual(OK_RESULT)
    expect(coreInput()).toMatchObject({
      to: 'sess-target-1',
      text: 'do the thing',
      expectReply: true,
      replyTimeoutSecs: 120,
    })
  })

  it('forwards the caller provenance headers into the core input', async () => {
    const res = await request(createApp())
      .post('/api/v1/messages')
      .set('x-walnut-caller-sid', 'sess-caller-1')
      .set('x-walnut-caller-host', 'devbox')
      .send({ to: 'sess-target-1', text: 'peer note', in_reply_to: 'rq-0123456789ab', messageId: 'qm-9' })

    expect(res.status).toBe(202)
    expect(coreInput()).toMatchObject({
      callerSid: 'sess-caller-1',
      callerHost: 'devbox',
      inReplyTo: 'rq-0123456789ab',
      messageId: 'qm-9',
    })
  })

  it('leaves the caller undefined when the headers are absent or blank', async () => {
    await request(createApp())
      .post('/api/v1/messages')
      .set('x-walnut-caller-sid', '   ')
      .send({ to: 'sess-target-1', text: 'human words' })

    // A blank header must not become a caller id — that would classify the
    // human's own CLI as an unidentified process and fence its words.
    expect(coreInput().callerSid).toBeUndefined()
    expect(coreInput().callerHost).toBeUndefined()
  })

  it('400s a missing or empty text (the core validates, the route maps)', async () => {
    const missing = await request(createApp()).post('/api/v1/messages').send({ to: 'sess-target-1' })
    expect(missing.status).toBe(400)
    expect(missing.body).toEqual({ error: { code: 'bad_request', message: 'text must be a non-empty string' } })
    // A non-string body field reaches the core as '' rather than as itself.
    expect(coreInput().text).toBe('')

    const blank = await request(createApp()).post('/api/v1/messages').send({ to: 'sess-target-1', text: '   ' })
    expect(blank.status).toBe(400)
    expect(blank.body.error.code).toBe('bad_request')

    const notAString = await request(createApp()).post('/api/v1/messages').send({ to: 'sess-target-1', text: 42 })
    expect(notAString.status).toBe(400)
  })

  it('maps a SendError to its own status, the frozen error shape, and its detail', async () => {
    performSessionSendMock.mockRejectedValue(new SendError(
      'task_has_no_session',
      'task "Run the migration" (task-123) has no session — start one with session_start',
      409,
      { taskId: 'task-1234abcd' },
    ))

    const res = await request(createApp()).post('/api/v1/messages').send({ to: 'task-1234abcd', text: 'go' })

    expect(res.status).toBe(409)
    expect(res.body.error).toEqual({
      code: 'task_has_no_session',
      message: 'task "Run the migration" (task-123) has no session — start one with session_start',
    })
    // detail rides alongside the error object, not inside it.
    expect(res.body.taskId).toBe('task-1234abcd')
  })

  it('maps the other SendError codes to their own statuses', async () => {
    const cases: Array<[string, number]> = [
      ['unknown_target', 404],
      ['ambiguous_target', 400],
      ['target_archived', 409],
      ['throttled', 429],
      ['queue_full', 429],
      ['origin_session_gone', 410],
    ]
    for (const [code, status] of cases) {
      performSessionSendMock.mockRejectedValueOnce(
        new SendError(code as ConstructorParameters<typeof SendError>[0], `${code} happened`, status))
      const res = await request(createApp()).post('/api/v1/messages').send({ to: 'x', text: 'go' })
      expect(res.status, code).toBe(status)
      expect(res.body.error.code, code).toBe(code)
    }
  })

  it('501s on a replica instead of mutating replica-side state', async () => {
    cloudMode = true

    const res = await request(createApp()).post('/api/v1/messages').send({ to: 'sess-target-1', text: 'go' })

    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
    expect(performSessionSendMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/requests/:id', () => {
  it('400s an id that is not an rq- handle, before reading the ledger', async () => {
    for (const id of ['notarq', 'rq-XYZ', 'rq-', 'rq-abc']) {
      const res = await request(createApp()).get(`/api/v1/requests/${id}`)
      expect(res.status, id).toBe(400)
      expect(res.body.error.code, id).toBe('bad_request')
    }
    expect(getSessionRequestMock).not.toHaveBeenCalled()
  })

  it('404s a well-formed id with no row', async () => {
    const res = await request(createApp()).get('/api/v1/requests/rq-0123456789ab')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(getSessionRequestMock).toHaveBeenCalledWith('rq-0123456789ab')
  })

  it('200s with the row wrapped in { request }', async () => {
    const row = {
      id: 'rq-0123456789ab',
      fromSessionId: 'sess-asker-1',
      toSessionId: 'sess-target-1',
      preview: 'count the rows',
      status: 'replied',
      createdAt: '2026-08-29T00:00:00.000Z',
      deadlineAt: 1_800_000_000_000,
      settledAt: '2026-08-29T00:01:00.000Z',
    }
    getSessionRequestMock.mockResolvedValue(row)

    const res = await request(createApp()).get('/api/v1/requests/rq-0123456789ab')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ request: row })
  })
})
