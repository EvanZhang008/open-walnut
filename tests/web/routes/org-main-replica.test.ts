/**
 * POST /api/v1/org/main on a REPLICA (CLOUD_MODE): the phone asks it before every word to the
 * CEO (TalkMainSender, the Action Button's Send). With the Mac away the companion answers it, so
 * it answers the main agent its copy holds; only MAKING one stays the primary's (501).
 * 2026-11-25: the 501 here sent the phone's note nowhere while the Mac was asleep.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-org-main-replica', { CLOUD_MODE: true }))

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { orgV1Router } from '../../../src/web/routes/org-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { addTask, listTasks } from '../../../src/core/task-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', orgV1Router)
  app.use(errorHandler)
  return app
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /org/main on a REPLICA', () => {
  it('with no main agent in its copy, it is the primary\'s to make: 501, nothing made', async () => {
    const res = await request(createApp()).post('/api/v1/org/main').send({})
    expect(res.status).toBe(501)
    expect(res.body.code).toBe('not_supported_cloud')
    expect((await listTasks()).filter((t) => t.org_role === 'main')).toEqual([])
  })

  it('answers the main agent its copy holds, and never makes a second one', async () => {
    const { task: main } = await addTask({ title: 'CEO', project: 'Ask Walnut', source: 'local', walnut_agent: true, org_role: 'main' })
    for (let i = 0; i < 2; i++) {
      const res = await request(createApp()).post('/api/v1/org/main').send({})
      expect(res.status).toBe(200)
      expect(res.body.task).toMatchObject({ id: main.id, org_role: 'main' })
    }
    expect((await listTasks()).filter((t) => t.org_role === 'main').map((t) => t.id)).toEqual([main.id])
  })

  it('a host replica runs it on its copy while the Mac is away, never a needs_leader before the route', async () => {
    const { classify } = await import('../../../src/replica/route-table.js')
    expect(classify('POST', '/api/v1/org/main')).toMatchObject({ away: 'read' })
  })
})
