/**
 * /api/v1 session extras (Wave 2) — session-extras-v1.ts on the PRIMARY box.
 * Bare express + supertest with real session records but NO live CLI, so the
 * degraded/validation paths are under test: controls read for a dead session,
 * settings snapshot, side-question listing, plan 404, queue reads/edits on an
 * unmanaged session, and list-dirs. The cloud relay ladder lives in
 * api-v1-session-extras-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-sessionextras'))

import express from 'express'
import request from 'supertest'
import { sessionExtrasV1Router } from '../../../src/web/routes/session-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionExtrasV1Router)
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

describe('GET /api/v1/sessions/:id/controls', () => {
  it('returns the Claude mode control for a recorded session', async () => {
    await createSessionRecord('se-controls-1', 'task-c1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped', mode: 'plan',
    })
    const res = await request(createApp()).get('/api/v1/sessions/se-controls-1/controls')
    expect(res.status).toBe(200)
    expect(res.body.engine).toBe('claude')
    const modeControl = res.body.controls.find((c: { id: string }) => c.id === 'mode')
    expect(modeControl).toBeDefined()
    expect(modeControl.currentValue).toBe('plan')
  })

  it('404 not_found for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/se-none/controls')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('400 bad_request for an unsafe id', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/..%2Fetc/controls')
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/sessions/:id/controls', () => {
  it('applies the mode control to the record (dead CLI → persisted for restart)', async () => {
    await createSessionRecord('se-apply-1', 'task-a1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped', mode: 'default',
    })
    const res = await request(createApp())
      .post('/api/v1/sessions/se-apply-1/controls')
      .send({ id: 'mode', value: 'plan' })
    expect(res.status).toBe(200)
    const modeControl = res.body.controls.find((c: { id: string }) => c.id === 'mode')
    expect(modeControl.currentValue).toBe('plan')
  })

  it('400 for an unknown control id', async () => {
    await createSessionRecord('se-apply-2', 'task-a2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp())
      .post('/api/v1/sessions/se-apply-2/controls')
      .send({ id: 'not_a_control', value: 'x' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

describe('GET /api/v1/sessions/:id/settings', () => {
  it('returns requested/applied/effective for a dead session', async () => {
    await createSessionRecord('se-settings-1', 'task-s1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped', model: 'opus-4-8',
    })
    const res = await request(createApp()).get('/api/v1/sessions/se-settings-1/settings')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('live')
    expect(res.body).toHaveProperty('requested')
    expect(res.body).toHaveProperty('effective')
    expect(res.body.live).toBe(false)
  })

  it('404 for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/se-none/settings')
    expect(res.status).toBe(404)
  })
})

describe('side questions', () => {
  it('GET lists (empty) for a recorded session; POST 400 for a blank question', async () => {
    await createSessionRecord('se-sq-1', 'task-q1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const app = createApp()
    const list = await request(app).get('/api/v1/sessions/se-sq-1/side-questions')
    expect(list.status).toBe(200)
    expect(list.body.sideQuestions).toEqual([])

    const blank = await request(app).post('/api/v1/sessions/se-sq-1/side-question').send({ question: '  ' })
    expect(blank.status).toBe(400)
  })

  it('promote/delete 404 for an unknown question id', async () => {
    await createSessionRecord('se-sq-2', 'task-q2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const app = createApp()
    expect((await request(app).post('/api/v1/sessions/se-sq-2/side-question/sq-none/promote')).status).toBe(404)
    expect((await request(app).delete('/api/v1/sessions/se-sq-2/side-question/sq-none')).status).toBe(404)
  })
})

describe('workflow / plan / subagent history', () => {
  it('GET workflow → 204 when the session never ran a workflow', async () => {
    await createSessionRecord('se-wf-1', 'task-w1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/se-wf-1/workflow')
    expect(res.status).toBe(204)
  })

  it('GET plan → 404 for a session with no plan', async () => {
    await createSessionRecord('se-plan-1', 'task-p1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/se-plan-1/plan')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('GET subagent history → 400 for an unsafe agent id', async () => {
    await createSessionRecord('se-sub-1', 'task-sub1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/se-sub-1/subagent/bad%2F..%2Fid/history')
    expect(res.status).toBe(400)
  })
})

describe('queue management', () => {
  it('GET queue returns empty messages for an unmanaged session record', async () => {
    await createSessionRecord('se-q-1', 'task-qq1', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const res = await request(createApp()).get('/api/v1/sessions/se-q-1/queue')
    expect(res.status).toBe(200)
    expect(res.body.messages).toEqual([])
  })

  it('GET queue 404 for an unknown session', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/se-q-none/queue')
    expect(res.status).toBe(404)
  })

  it('PATCH/DELETE an unknown queued message → 4xx, never 500', async () => {
    await createSessionRecord('se-q-2', 'task-qq2', 'proj', '/tmp', {
      initialProcessStatus: 'stopped',
    })
    const app = createApp()
    const patch = await request(app).patch('/api/v1/sessions/se-q-2/queue/qm-none').send({ text: 'edited' })
    expect(patch.status).toBeGreaterThanOrEqual(400)
    expect(patch.status).toBeLessThan(500)
    const del = await request(app).delete('/api/v1/sessions/se-q-2/queue/qm-none')
    expect(del.status).toBeGreaterThanOrEqual(400)
    expect(del.status).toBeLessThan(500)
  })
})

describe('GET /api/v1/sessions/list-dirs', () => {
  it('lists subdirectories of a real local prefix', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-listdirs-'))
    await fs.mkdir(path.join(base, 'alpha'))
    await fs.mkdir(path.join(base, 'beta'))
    try {
      const res = await request(createApp()).get(`/api/v1/sessions/list-dirs?prefix=${encodeURIComponent(base + '/')}`)
      expect(res.status).toBe(200)
      expect(res.body.dirs).toEqual(expect.arrayContaining([
        expect.stringContaining('alpha'),
        expect.stringContaining('beta'),
      ]))
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
