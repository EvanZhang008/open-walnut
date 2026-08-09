/**
 * /api/v1 session lifecycle endpoints (Wave 1) — session-lifecycle-v1.ts on
 * the PRIMARY box. Bare express + supertest (no live CLI, so the degraded
 * paths are the ones under test): detail read, PATCH validation + persistence,
 * terminate on a dead record, retry guards, permission 404s, and the frozen
 * error shape. The CLOUD relay ladder lives in
 * api-v1-session-lifecycle-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-lifecycle'))

import express from 'express'
import request from 'supertest'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/sessions/:id (detail)', () => {
  it('returns the record + empty pendingPermissions when no CLI is live', async () => {
    await createSessionRecord('lc-detail-1', 'task-d1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped', title: 'Detail session',
    })
    const res = await request(createApp()).get('/api/v1/sessions/lc-detail-1')
    expect(res.status).toBe(200)
    expect(res.body.session.claudeSessionId).toBe('lc-detail-1')
    expect(res.body.session.title).toBe('Detail session')
    expect(res.body.pendingPermissions).toEqual([])
  })

  it('404 not_found for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/lc-no-such')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('400 bad_request for an unsafe session id', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/..%2Fetc')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('PATCH /api/v1/sessions/:id', () => {
  it('renames + archives; task links are the core patchSession path', async () => {
    await createSessionRecord('lc-patch-1', 'task-p1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp())
      .patch('/api/v1/sessions/lc-patch-1')
      .send({ title: 'Renamed from phone', archived: true })
    expect(res.status).toBe(200)
    expect(res.body.session.title).toBe('Renamed from phone')
    expect(res.body.session.archived).toBe(true)
    const record = await getSessionByClaudeId('lc-patch-1')
    expect(record?.title).toBe('Renamed from phone')
    expect(record?.archived).toBe(true)
  })

  it('persists human_note and mode', async () => {
    await createSessionRecord('lc-patch-2', 'task-p2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp())
      .patch('/api/v1/sessions/lc-patch-2')
      .send({ human_note: 'note from phone', mode: 'plan' })
    expect(res.status).toBe(200)
    const record = await getSessionByClaudeId('lc-patch-2')
    expect(record?.human_note).toBe('note from phone')
    expect(record?.mode).toBe('plan')
  })

  it('400 on an empty patch body', async () => {
    await createSessionRecord('lc-patch-3', 'task-p3', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).patch('/api/v1/sessions/lc-patch-3').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('400 on an invalid mode value', async () => {
    await createSessionRecord('lc-patch-4', 'task-p4', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).patch('/api/v1/sessions/lc-patch-4').send({ mode: 'yolo' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('404 for an unknown session', async () => {
    const res = await request(createApp()).patch('/api/v1/sessions/lc-nope').send({ title: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/terminate', () => {
  it('terminates a stopped record (no live CLI) and reports tookMs', async () => {
    await createSessionRecord('lc-term-1', 'task-t1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).post('/api/v1/sessions/lc-term-1/terminate').send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('terminated')
    expect(res.body.sessionId).toBe('lc-term-1')
    expect(typeof res.body.tookMs).toBe('number')
    const record = await getSessionByClaudeId('lc-term-1')
    expect(record?.process_status).toBe('stopped')
    expect(record?.status_reason).toBe('user_terminated')
  })

  it('404 for an unknown session', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/lc-term-nope/terminate').send({})
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/restart', () => {
  it('400 when the session is archived', async () => {
    await createSessionRecord('lc-restart-1', 'task-r1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    await request(createApp()).patch('/api/v1/sessions/lc-restart-1').send({ archived: true })
    const res = await request(createApp()).post('/api/v1/sessions/lc-restart-1/restart')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(res.body.error.message).toMatch(/archived/i)
  })

  it('404 for an unknown session', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/lc-restart-nope/restart')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/retry', () => {
  it('400 when the session is not in a retryable state', async () => {
    await createSessionRecord('lc-retry-1', 'task-rt1', 'proj', '/tmp', {
      initialProcessStatus: 'running',
    })
    const res = await request(createApp()).post('/api/v1/sessions/lc-retry-1/retry')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(res.body.error.message).toMatch(/not retryable/)
  })

  it('404 for an unknown session', async () => {
    const res = await request(createApp()).post('/api/v1/sessions/lc-retry-nope/retry')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/permission', () => {
  it('400 when requestId/allow are missing', async () => {
    await createSessionRecord('lc-perm-1', 'task-pm1', 'proj', '/tmp', {
      initialProcessStatus: 'running',
    })
    const res = await request(createApp()).post('/api/v1/sessions/lc-perm-1/permission').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('404 when no live session holds the request', async () => {
    await createSessionRecord('lc-perm-2', 'task-pm2', 'proj', '/tmp', {
      initialProcessStatus: 'running',
    })
    const res = await request(createApp())
      .post('/api/v1/sessions/lc-perm-2/permission')
      .send({ requestId: 'req-1', allow: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/execute-continue', () => {
  it('400 when the session is not a plan/execution session', async () => {
    await createSessionRecord('lc-exec-1', 'task-e1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).post('/api/v1/sessions/lc-exec-1/execute-continue')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('GET /api/v1/sessions/:id/history', () => {
  it('reports historyUnavailable when no JSONL exists (no CLI ever spawned)', async () => {
    await createSessionRecord('lc-hist-1', 'task-h1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/lc-hist-1/history')
    expect(res.status).toBe(200)
    expect(res.body.messages).toEqual([])
    expect(res.body.total).toBe(0)
    expect(typeof res.body.historyUnavailable).toBe('string')
  })

  it('400 on a non-positive tail', async () => {
    await createSessionRecord('lc-hist-2', 'task-h2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/lc-hist-2/history?tail=0')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('404 for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/lc-hist-nope/history')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('GET /api/v1/sessions/:id/changes', () => {
  it('404 for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/lc-chg-nope/changes')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})
