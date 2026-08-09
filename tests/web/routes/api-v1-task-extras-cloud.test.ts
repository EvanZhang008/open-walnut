/**
 * /api/v1 task extras + projects — CLOUD_MODE (REPLICA) refusals. Group and
 * tier writes have no outbox write-back channel (group_id / the tier registry
 * are not in the projection whitelist), and project rename/delete needs the
 * primary's registry + provider plugins — all answer an honest 501
 * not_supported_cloud instead of a silently-reverting local write. Reads and
 * quick-parse keep working on the replica.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskextras-cloud', { CLOUD_MODE: true }))

import express from 'express'
import request from 'supertest'
import { taskExtrasV1Router } from '../../../src/web/routes/task-extras-v1.js'
import { projectsV1Router } from '../../../src/web/routes/projects-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', taskExtrasV1Router)
  app.use('/api/v1', projectsV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetForTesting()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('501 not_supported_cloud on a REPLICA', () => {
  it('every group write refuses', async () => {
    const app = createApp()
    for (const [method, url, body] of [
      ['post', '/api/v1/tasks/groups', { task_ids: ['a', 'b'] }],
      ['post', '/api/v1/tasks/groups/g1/add', { task_ids: ['c'] }],
      ['post', '/api/v1/tasks/groups/remove', { task_ids: ['a'] }],
      ['patch', '/api/v1/tasks/groups/g1', { label: 'x' }],
      ['patch', '/api/v1/tasks/groups/g1/hidden', { hidden: true }],
    ] as const) {
      const res = await (request(app) as any)[method](url).send(body)
      expect(res.status, `${method} ${url}`).toBe(501)
      expect(res.body.error.code).toBe('not_supported_cloud')
    }
  })

  it('every tier write refuses', async () => {
    const app = createApp()
    for (const [method, url] of [
      ['post', '/api/v1/focus/tiers'],
      ['put', '/api/v1/focus/tiers/t1'],
      ['delete', '/api/v1/focus/tiers/t1'],
    ] as const) {
      const res = await (request(app) as any)[method](url).send({ label: 'x' })
      expect(res.status, `${method} ${url}`).toBe(501)
      expect(res.body.error.code).toBe('not_supported_cloud')
    }
  })

  it('project rename + delete refuse', async () => {
    const app = createApp()
    const patch = await request(app).patch('/api/v1/projects/x').send({ name: 'y' })
    expect(patch.status).toBe(501)
    expect(patch.body.error.code).toBe('not_supported_cloud')
    const del = await request(app).delete('/api/v1/projects/x')
    expect(del.status).toBe(501)
    expect(del.body.error.code).toBe('not_supported_cloud')
  })
})

describe('replica-side reads keep working', () => {
  it('tags + groups + projects list read the local replica store', async () => {
    await addTask({ title: 'replica task', tags: ['mobile'] })
    const app = createApp()

    const tags = await request(app).get('/api/v1/tasks/meta/tags')
    expect(tags.status).toBe(200)
    expect(tags.body.tags.some((t: { tag: string }) => t.tag === 'mobile')).toBe(true)

    expect((await request(app).get('/api/v1/tasks/groups')).status).toBe(200)
    expect((await request(app).get('/api/v1/projects')).status).toBe(200)
  })

  it('quick-parse validation still runs locally (400 before any model call)', async () => {
    const res = await request(createApp()).post('/api/v1/tasks/quick-parse').send({ text: '', timeZone: 'UTC' })
    expect(res.status).toBe(400)
  })
})
