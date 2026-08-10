/**
 * /api/v1 session control endpoints — PRIMARY box behavior. Router mounted on
 * a bare express app (no live CLI in the test env, so the "session not live"
 * degraded paths are the ones under test): model-options catalog fallback,
 * model/effort persistence with appliedLive:false, fork validation +
 * pre-seeded record, and the frozen error shape for 400/404/409.
 *
 * The CLOUD_MODE relay ladder lives in api-v1-session-control-cloud.test.ts;
 * the real daemon relay protocol is covered by the daemon e2e tier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-sessionctl'))

import express from 'express'
import request from 'supertest'
import { sessionControlV1Router } from '../../../src/web/routes/session-control-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  createSessionRecord,
  getSessionByClaudeId,
  listSessions,
} from '../../../src/core/session-tracker.js'
import { addTask, listTasks, getTask } from '../../../src/core/task-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionControlV1Router)
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

describe('GET /api/v1/sessions/:id/model-options', () => {
  it('returns the static catalog fallback + current from the record (session not live)', async () => {
    await createSessionRecord('ctl-options-1', 'task-o1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/ctl-options-1/model-options')
    expect(res.status).toBe(200)
    const body = res.body as {
      models: Array<{ id: string; label: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>
      current: string | null
      currentEffort: string | null
    }
    expect(body.models.length).toBeGreaterThan(0)
    for (const m of body.models) {
      expect(typeof m.id).toBe('string')
      expect(typeof m.label).toBe('string')
    }
    // Static registry rows carry both effort capability fields.
    const opus = body.models.find((m) => m.id === 'opus')
    expect(opus).toBeDefined()
    expect(opus!.supportsEffort).toBe(true)
    expect(opus!.supportedEffortLevels).toContain('high')
    const haiku = body.models.find((m) => m.id === 'haiku')
    if (haiku) expect(haiku.supportsEffort).toBe(false)
    // Record has no model → current null; no effort set → null.
    expect(body.current).toBeNull()
    expect(body.currentEffort).toBeNull()
  })

  it('current reflects the record cliModel; currentEffort the record effort', async () => {
    await createSessionRecord('ctl-options-2', 'task-o2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const app = createApp()
    // Set model + effort through the endpoints themselves (persist-only path).
    expect((await request(app).post('/api/v1/sessions/ctl-options-2/model').send({ model: 'opus' })).status).toBe(200)
    expect((await request(app).post('/api/v1/sessions/ctl-options-2/effort').send({ effort: 'high' })).status).toBe(200)

    const res = await request(app).get('/api/v1/sessions/ctl-options-2/model-options')
    expect(res.status).toBe(200)
    expect(res.body.current).toBe('opus')
    expect(res.body.currentEffort).toBe('high')
  })

  // Regression (same root cause as the web pill / picker mismatch): the level
  // frequently lives in the CLI's OWN settings.json, so nothing ever REQUESTED
  // it and `record.effort` stays undefined. Reading only that field made the
  // sheet highlight a different level than the session actually runs — the
  // read-back value (record.effectiveEffort, CLI truth) must win.
  it('currentEffort prefers the CLI read-back over the requested value', async () => {
    await createSessionRecord('ctl-options-eff', 'task-oe', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    // Nothing requested; the CLI reported xhigh at session start.
    await updateSessionRecord('ctl-options-eff', { effectiveEffort: 'xhigh' })

    const res = await request(createApp()).get('/api/v1/sessions/ctl-options-eff/model-options')
    expect(res.status).toBe(200)
    expect(res.body.currentEffort).toBe('xhigh')
  })

  it('currentEffort still falls back to the requested value when no read-back exists', async () => {
    await createSessionRecord('ctl-options-eff2', 'task-oe2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
      effort: 'low',
    })
    const res = await request(createApp()).get('/api/v1/sessions/ctl-options-eff2/model-options')
    expect(res.status).toBe(200)
    expect(res.body.currentEffort).toBe('low')
  })

  it('404 not_found for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/no-such-session/model-options')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(typeof res.body.error.message).toBe('string')
  })

  it('400 bad_request for an unsafe session id', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/..%2Fetc/model-options')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('POST /api/v1/sessions/:id/model', () => {
  it('persists the model (appliedLive false without a live CLI)', async () => {
    await createSessionRecord('ctl-model-1', 'task-m1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp())
      .post('/api/v1/sessions/ctl-model-1/model')
      .send({ model: 'opus-1m' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ model: 'opus-1m', cliModel: 'opus[1m]', appliedLive: false })
    const record = await getSessionByClaudeId('ctl-model-1')
    expect(record?.cliModel).toBe('opus[1m]')
  })

  it('400 bad_request for an invalid model value', async () => {
    await createSessionRecord('ctl-model-2', 'task-m2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    for (const model of ['', '   ', 'bad value with spaces', 42, null]) {
      const res = await request(createApp())
        .post('/api/v1/sessions/ctl-model-2/model')
        .send({ model })
      expect(res.status, JSON.stringify(model)).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
    }
  })

  it('404 not_found for an unknown session', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions/nope-model/model')
      .send({ model: 'opus' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/effort', () => {
  it('persists the effort (appliedLive false without a live CLI)', async () => {
    await createSessionRecord('ctl-effort-1', 'task-e1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp())
      .post('/api/v1/sessions/ctl-effort-1/effort')
      .send({ effort: 'high' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ effort: 'high', appliedLive: false, overridden: false })
    const record = await getSessionByClaudeId('ctl-effort-1')
    expect(record?.effort).toBe('high')
  })

  it('409 conflict when the model does not support the requested effort', async () => {
    await createSessionRecord('ctl-effort-2', 'task-e2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const app = createApp()
    // Haiku: no effort support at all (static family table).
    expect((await request(app).post('/api/v1/sessions/ctl-effort-2/model').send({ model: 'haiku' })).status).toBe(200)
    const res = await request(app).post('/api/v1/sessions/ctl-effort-2/effort').send({ effort: 'high' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
  })

  it('400 bad_request for an invalid effort value', async () => {
    await createSessionRecord('ctl-effort-3', 'task-e3', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    for (const effort of ['ultra', '', 7, null]) {
      const res = await request(createApp())
        .post('/api/v1/sessions/ctl-effort-3/effort')
        .send({ effort })
      expect(res.status, JSON.stringify(effort)).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
    }
  })

  it('404 not_found for an unknown session', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions/nope-effort/effort')
      .send({ effort: 'high' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/sessions/:id/fork', () => {
  async function seedSource(sid: string): Promise<string> {
    const { task } = await addTask({ title: `Source task for ${sid}`, project: '', source: 'local' })
    await createSessionRecord(sid, task.id, '', '/tmp', {
      title: `source ${sid}`,
      initialProcessStatus: 'stopped',
    })
    return task.id
  }

  it('forks onto a fresh sibling task: 201, pending status, pre-seeded record', async () => {
    await seedSource('ctl-fork-1')
    const res = await request(createApp())
      .post('/api/v1/sessions/ctl-fork-1/fork')
      .send({ create_child_task: true, message: 'Try approach B' })
    expect(res.status).toBe(201)
    const body = res.body as {
      status: string; sourceSessionId: string; sessionId: string
      taskId: string; title: string; childTaskCreated?: boolean
    }
    expect(body.status).toBe('pending')
    expect(body.sourceSessionId).toBe('ctl-fork-1')
    expect(body.childTaskCreated).toBe(true)
    expect(body.sessionId).toBeTruthy()
    // Sibling task exists and is NOT a parent/child of the source.
    const forkTask = await getTask(body.taskId)
    expect(forkTask.parent_task_id).toBeUndefined()
    expect(forkTask.title).toMatch(/^Fork of /)
    // Record pre-seeded (the phone opens the panel on this response).
    const record = await getSessionByClaudeId(body.sessionId)
    expect(record).toBeTruthy()
    expect(record?.forkedFromSessionId).toBe('ctl-fork-1')
    expect(record?.process_status).toBe('idle')
  })

  it('forks onto an explicit target task', async () => {
    await seedSource('ctl-fork-2')
    const { task: target } = await addTask({ title: 'Fork target', project: '', source: 'local' })
    const res = await request(createApp())
      .post('/api/v1/sessions/ctl-fork-2/fork')
      .send({ task_id: target.id, message: 'work here' })
    expect(res.status).toBe(201)
    expect(res.body.taskId).toBe(target.id)
    expect(res.body.childTaskCreated).toBeUndefined()
  })

  it('409 conflict + existing_session_id when the target task already has a session', async () => {
    await seedSource('ctl-fork-3')
    const { task: target } = await addTask({ title: 'Occupied target', project: '', source: 'local' })
    await createSessionRecord('ctl-occupant', target.id, '', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp())
      .post('/api/v1/sessions/ctl-fork-3/fork')
      .send({ task_id: target.id })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(res.body.existing_session_id).toBe('ctl-occupant')
  })

  it('409 for Codex sessions before any task mutation (ACP fork unsupported)', async () => {
    const { task } = await addTask({ title: 'Codex source', project: '', source: 'local' })
    await createSessionRecord('ctl-codex-1', task.id, '', '/tmp', {
      initialProcessStatus: 'stopped',
      engine: 'codex',
      acpRuntimeId: 'acp-ctl-1',
    })
    const beforeTasks = (await listTasks()).map((t) => t.id).sort()
    const beforeSessions = (await listSessions()).map((s) => s.claudeSessionId).sort()
    const res = await request(createApp())
      .post('/api/v1/sessions/ctl-codex-1/fork')
      .send({ create_child_task: true })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(res.body.code).toBe('ACP_FORK_UNSUPPORTED')
    expect((await listTasks()).map((t) => t.id).sort()).toEqual(beforeTasks)
    expect((await listSessions()).map((s) => s.claudeSessionId).sort()).toEqual(beforeSessions)
  })

  it('400 for missing / mutually-exclusive target flags', async () => {
    await seedSource('ctl-fork-4')
    for (const body of [
      {},                                            // neither target
      { task_id: 'x', create_child_task: true },     // both targets
    ]) {
      const res = await request(createApp())
        .post('/api/v1/sessions/ctl-fork-4/fork')
        .send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
    }
  })

  it('404 not_found for an unknown source session', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions/nope-fork/fork')
      .send({ create_child_task: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})
