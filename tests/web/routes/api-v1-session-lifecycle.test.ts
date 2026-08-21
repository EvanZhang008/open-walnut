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
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  vi.restoreAllMocks()
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

  it('restores a durable pending question before the live CLI reattaches', async () => {
    await createSessionRecord('lc-detail-pending', 'task-dp', 'proj', '/tmp', {
      initialProcessStatus: 'running',
      pid: process.pid,
    })
    await updateSessionRecord('lc-detail-pending', {
      pendingPermission: {
        requestId: 'req-question',
        toolName: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Which deployment?',
            options: [{ label: 'Staging', description: 'Deploy to staging' }],
          }],
        },
        reason: 'Need a target',
        receivedAt: '2026-08-17T00:56:52.000Z',
      },
    })

    const res = await request(createApp()).get('/api/v1/sessions/lc-detail-pending')

    expect(res.status).toBe(200)
    expect(res.body.pendingPermissions).toEqual([expect.objectContaining({
      requestId: 'req-question',
      toolName: 'AskUserQuestion',
      reason: 'Need a target',
    })])
    expect(res.body.pendingPermissions[0].input.questions[0].question).toBe('Which deployment?')
  })

  it('returns Codex detail through v1 and cloud-primary relay without waiting for cold attach', async () => {
    await createSessionRecord('lc-detail-codex-cold', 'task-cold', 'proj', '/tmp', {
      initialProcessStatus: 'idle',
      engine: 'codex',
      acpRuntimeId: 'runtime-codex-cold',
      title: 'Durable Codex title',
    })
    await updateSessionRecord('lc-detail-codex-cold', {
      pendingPermission: {
        requestId: 'perm-codex-cold',
        toolName: 'Run command',
        acpOptions: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
        receivedAt: '2026-08-18T00:00:00.000Z',
      },
    })
    vi.spyOn(sessionRunner, 'findAcpSession').mockReturnValue(undefined)
    const attach = vi.spyOn(sessionRunner, 'findOrAttachAcpSession')
      .mockReturnValue(new Promise<never>(() => {}))

    const v1 = await Promise.race([
      request(createApp()).get('/api/v1/sessions/lc-detail-codex-cold'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('v1 detail blocked')), 2_000)),
    ])
    expect(v1.status).toBe(200)
    expect(v1.body.session.title).toBe('Durable Codex title')
    expect(v1.body.pendingPermissions[0]).toEqual(expect.objectContaining({
      requestId: 'perm-codex-cold',
      acpOptions: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
    }))

    const relay = await Promise.race([
      handleSessionControlRelay('detail', 'lc-detail-codex-cold', {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay detail blocked')), 2_000)),
    ])
    expect(relay).toMatchObject({
      ok: true,
      result: {
        session: { title: 'Durable Codex title' },
        pendingPermissions: [{ requestId: 'perm-codex-cold' }],
      },
    })
    expect(attach).toHaveBeenCalledTimes(2)
  })

  it('does not restore a stale durable question on a terminal record', async () => {
    await createSessionRecord('lc-detail-stale', 'task-ds', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    await updateSessionRecord('lc-detail-stale', {
      pendingPermission: {
        requestId: 'req-stale',
        toolName: 'AskUserQuestion',
        receivedAt: '2026-08-17T00:56:52.000Z',
      },
    })

    const res = await request(createApp()).get('/api/v1/sessions/lc-detail-stale')

    expect(res.status).toBe(200)
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

  // Mobile parity for the two web-route fixes: a starting session and a fresh
  // fork must not be told their history is unavailable.
  it('does NOT report historyUnavailable for a session still starting up', async () => {
    await createSessionRecord('lc-hist-starting', 'task-h3', 'proj', '/tmp', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    })
    const res = await request(createApp()).get('/api/v1/sessions/lc-hist-starting/history')
    expect(res.status).toBe(200)
    expect(res.body.messages).toEqual([])
    expect(res.body.historyUnavailable).toBeUndefined()
  })

  it('does NOT report historyUnavailable for a fresh fork with an empty own transcript', async () => {
    await createSessionRecord('lc-fork-parent', 'task-h4', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    await createSessionRecord('lc-fork-child', 'task-h5', 'proj', '/tmp', {
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
      forkedFromSessionId: 'lc-fork-parent',
    })
    const res = await request(createApp()).get('/api/v1/sessions/lc-fork-child/history')
    expect(res.status).toBe(200)
    expect(res.body.historyUnavailable).toBeUndefined()
  })

  it('still reports historyUnavailable for an OLD fork with no transcript anywhere', async () => {
    await createSessionRecord('lc-fork-old-parent', 'task-h6', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    await createSessionRecord('lc-fork-old-child', 'task-h7', 'proj', '/tmp', {
      initialProcessStatus: 'idle',
      forkedFromSessionId: 'lc-fork-old-parent',
    })
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await updateSessionRecord('lc-fork-old-child', { startedAt: old, last_status_change: old })
    const res = await request(createApp()).get('/api/v1/sessions/lc-fork-old-child/history')
    expect(res.status).toBe(200)
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
