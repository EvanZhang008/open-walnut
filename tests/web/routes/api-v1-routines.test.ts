/**
 * /api/v1 routines endpoints (Wave 2) — routines-v1.ts on the PRIMARY box.
 * Bare express + supertest against a REAL CronService (scheduler disabled) on
 * an isolated temp home, registered through createCronRouter so the shared
 * accessor the v1 router reads is populated — proving both routers drive the
 * SAME core (routines-core.ts). Covers list/detail/CRUD/toggle/run-now, the
 * actions/status/executors reads, validation, 404s, and the frozen shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-routines'))

import express from 'express'
import request from 'supertest'
import { routinesV1Router } from '../../../src/web/routes/routines-v1.js'
import { createCronRouter, setCronService } from '../../../src/web/routes/cron.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { CronService } from '../../../src/core/cron/service.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import type { CronServiceDeps } from '../../../src/core/cron/types.js'

function createMockLog() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  } as any
}

const runMainAgentWithPrompt = vi.fn().mockResolvedValue(undefined)

function createTestDeps(): CronServiceDeps {
  return {
    log: createMockLog(),
    storePath: path.join(WALNUT_HOME, 'cron-jobs.json'),
    cronEnabled: false,
    broadcastCronNotification: vi.fn(),
    runMainAgentWithPrompt,
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
    onEvent: vi.fn(),
  }
}

function createApp(service: CronService) {
  const app = express()
  app.use(express.json())
  // Registering the WEB router populates the shared accessor the v1 router uses.
  app.use('/api/cron', createCronRouter(service))
  app.use('/api/v1', routinesV1Router)
  app.use(errorHandler)
  return app
}

const validJob = {
  name: 'Wave2 routine',
  schedule: { kind: 'every', everyMs: 60_000 },
  sessionTarget: 'main',
  wakeMode: 'now',
  payload: { kind: 'systemEvent', text: 'wave2 event' },
}

let service: CronService

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'cron-jobs.json'), JSON.stringify({ version: 1, jobs: [] }))
  runMainAgentWithPrompt.mockClear()
  service = new CronService(createTestDeps())
})

afterEach(async () => {
  setCronService(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('routines CRUD through /api/v1', () => {
  it('POST creates (201) and GET lists + fetches the routine', async () => {
    const app = createApp(service)
    const created = await request(app).post('/api/v1/routines').send(validJob)
    expect(created.status).toBe(201)
    expect(created.body.job.name).toBe('Wave2 routine')
    const id = created.body.job.id as string

    const list = await request(app).get('/api/v1/routines')
    expect(list.status).toBe(200)
    expect(list.body.jobs.some((j: { id: string }) => j.id === id)).toBe(true)

    const detail = await request(app).get(`/api/v1/routines/${id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.job.id).toBe(id)
  })

  it('POST 400 bad_request for an invalid body', async () => {
    const res = await request(createApp(service)).post('/api/v1/routines').send({ name: 'no schedule' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('PATCH edits; unknown id → 404 not_found', async () => {
    const app = createApp(service)
    const created = await request(app).post('/api/v1/routines').send(validJob)
    const id = created.body.job.id as string

    const patched = await request(app).patch(`/api/v1/routines/${id}`).send({ name: 'Renamed routine' })
    expect(patched.status).toBe(200)
    expect(patched.body.job.name).toBe('Renamed routine')

    const missing = await request(app).patch('/api/v1/routines/does-not-exist').send({ name: 'x' })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
  })

  it('DELETE → 204; deleting again → 404 (v1 fails loudly, unlike legacy web)', async () => {
    const app = createApp(service)
    const created = await request(app).post('/api/v1/routines').send(validJob)
    const id = created.body.job.id as string

    expect((await request(app).delete(`/api/v1/routines/${id}`)).status).toBe(204)
    const again = await request(app).delete(`/api/v1/routines/${id}`)
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe('not_found')
  })

  it('toggle flips enabled; run fires the executor now', async () => {
    const app = createApp(service)
    const created = await request(app).post('/api/v1/routines').send(validJob)
    const id = created.body.job.id as string

    const toggled = await request(app).post(`/api/v1/routines/${id}/toggle`)
    expect(toggled.status).toBe(200)
    expect(toggled.body.job.enabled).toBe(false)

    const run = await request(app).post(`/api/v1/routines/${id}/run`)
    expect(run.status).toBe(200)
    expect(runMainAgentWithPrompt).toHaveBeenCalledTimes(1)
  })

  it('400 bad_request for an unsafe routine id', async () => {
    const res = await request(createApp(service)).get('/api/v1/routines/..%2Fetc')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('routines reads', () => {
  it('GET /routines/actions returns the action catalog', async () => {
    const res = await request(createApp(service)).get('/api/v1/routines/actions')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.actions)).toBe(true)
  })

  it('GET /routines/status returns engine status', async () => {
    const res = await request(createApp(service)).get('/api/v1/routines/status')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('enabled')
  })

  it('GET /routines/executors returns executors + form options', async () => {
    const res = await request(createApp(service)).get('/api/v1/routines/executors')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.executors)).toBe(true)
    expect(res.body.options).toHaveProperty('hosts')
    expect(res.body.options).toHaveProperty('models')
  })
})

describe('engine not running', () => {
  it('503 in the frozen shape when no cron service is registered', async () => {
    setCronService(null)
    const app = express()
    app.use(express.json())
    app.use('/api/v1', routinesV1Router)
    app.use(errorHandler)
    const res = await request(app).get('/api/v1/routines')
    expect(res.status).toBe(503)
    expect(res.body.error.message).toContain('not running')
  })
})
