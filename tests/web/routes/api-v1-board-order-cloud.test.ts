/**
 * The two board-order reads on a REPLICA answer from the primary's pushed task
 * projection. `ordering.projects` lives in the primary's machine-local
 * config.yaml and replica rows carry no group_id, so the replica's own answers
 * are empty; the phone paired to it would otherwise order the board without the
 * Mac's project order and without its folders (see
 * web/src/utils/pinned-tier-order.ts). An envelope from an older primary lacks
 * both fields, and then the replica keeps its old local answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-board-order-cloud', { CLOUD_MODE: true }))

import express from 'express'
import request from 'supertest'
import { taskExtrasV1Router } from '../../../src/web/routes/task-extras-v1.js'
import { projectsV1Router } from '../../../src/web/routes/projects-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetForTesting } from '../../../src/core/task-manager.js'
import { writeProjectionCache } from '../../../src/core/projection-cache.js'
import { updateConfig } from '../../../src/core/config-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', taskExtrasV1Router)
  app.use('/api/v1', projectsV1Router)
  app.use(errorHandler)
  return app
}

const folder = {
  group_id: 'g_seeds', label: 'Seeds', hidden: false,
  member_ids: ['t1', 't2'], project: 'Orchard',
}

async function pushEnvelope(extra: Record<string, unknown>): Promise<void> {
  await writeProjectionCache('tasks', {
    version: 2,
    exportedAt: new Date().toISOString(),
    tasks: [],
    ...extra,
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetForTesting()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('board order reads on a REPLICA', () => {
  it('serve the project order and the folders the primary pushed', async () => {
    // The replica's own config disagrees: the pushed copy must win.
    await updateConfig({ ordering: { projects: ['Replica Local'] } })
    await pushEnvelope({ project_order: ['Lighthouse', '', 'Orchard'], groups: [folder] })
    const app = createApp()
    const ordering = await request(app).get('/api/v1/ordering')
    expect(ordering.status).toBe(200)
    expect(ordering.body).toEqual({ projects: ['Lighthouse', '', 'Orchard'] })
    const groups = await request(app).get('/api/v1/tasks/groups')
    expect(groups.status).toBe(200)
    expect(groups.body).toEqual({ groups: [folder] })
  })

  it('an empty pushed order is an answer, not a gap', async () => {
    await updateConfig({ ordering: { projects: ['Replica Local'] } })
    await pushEnvelope({ project_order: [], groups: [] })
    const app = createApp()
    expect((await request(app).get('/api/v1/ordering')).body).toEqual({ projects: [] })
    expect((await request(app).get('/api/v1/tasks/groups')).body).toEqual({ groups: [] })
  })

  it('an older primary (neither field) falls back to the replica\'s own answer', async () => {
    await updateConfig({ ordering: { projects: ['Replica Local'] } })
    await pushEnvelope({})
    const app = createApp()
    expect((await request(app).get('/api/v1/ordering')).body).toEqual({ projects: ['Replica Local'] })
    expect((await request(app).get('/api/v1/tasks/groups')).body).toEqual({ groups: [] })
  })

  it('no projection at all falls back the same way', async () => {
    const app = createApp()
    expect((await request(app).get('/api/v1/ordering')).body).toEqual({ projects: [] })
    expect((await request(app).get('/api/v1/tasks/groups')).body).toEqual({ groups: [] })
  })
})
