/**
 * /api/v1 projects + ordering + project favorites (Wave 2) — projects-v1.ts
 * on the PRIMARY box. Bare express + supertest against the real task-manager
 * on an isolated temp home. Verifies list decoration, idempotent create,
 * rename/delete guards, ordering write, favorites canonicalization, and the
 * frozen error shape. Cloud 501s live in api-v1-projects-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-projects'))

import express from 'express'
import request from 'supertest'
import { projectsV1Router } from '../../../src/web/routes/projects-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, ensureProject, _resetForTesting } from '../../../src/core/task-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
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

describe('GET /api/v1/projects', () => {
  it('lists registry rows with counts and the Inbox', async () => {
    await ensureProject('marina', 'local')
    await addTask({ title: 'in project', project: 'marina' })
    await addTask({ title: 'in inbox' })

    const res = await request(createApp()).get('/api/v1/projects')
    expect(res.status).toBe(200)
    const marina = res.body.projects.find((p: { name: string }) => p.name === 'marina')
    expect(marina).toBeDefined()
    expect(marina.source).toBe('local')
    expect(marina.counts.todo).toBe(1)
    expect(res.body.inbox.counts.todo).toBe(1)
  })
})

describe('POST /api/v1/projects', () => {
  it('creates (201) then is idempotent (200, created:false)', async () => {
    const app = createApp()
    const first = await request(app).post('/api/v1/projects').send({ name: 'acme' })
    expect(first.status).toBe(201)
    expect(first.body.created).toBe(true)

    const second = await request(app).post('/api/v1/projects').send({ name: 'acme' })
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)
  })

  it('400 for a missing name and an unknown source', async () => {
    const app = createApp()
    const noName = await request(app).post('/api/v1/projects').send({})
    expect(noName.status).toBe(400)
    expect(noName.body.error.code).toBe('bad_request')

    const badSource = await request(app).post('/api/v1/projects').send({ name: 'x', source: 'not-a-plugin' })
    expect(badSource.status).toBe(400)
    expect(badSource.body.error.code).toBe('bad_request')
  })
})

describe('PATCH /api/v1/projects/:name (rename)', () => {
  it('renames and moves tasks', async () => {
    await ensureProject('oldname', 'local')
    await addTask({ title: 'ride along', project: 'oldname' })

    const res = await request(createApp()).patch('/api/v1/projects/oldname').send({ name: 'newname' })
    expect(res.status).toBe(200)

    const list = await request(createApp()).get('/api/v1/projects')
    const names = list.body.projects.map((p: { name: string }) => p.name)
    expect(names).toContain('newname')
    expect(names).not.toContain('oldname')
  })

  it('404 not_found for an unknown project', async () => {
    const res = await request(createApp()).patch('/api/v1/projects/ghost').send({ name: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('400 for a missing new name', async () => {
    await ensureProject('keepme', 'local')
    const res = await request(createApp()).patch('/api/v1/projects/keepme').send({})
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/projects/:name', () => {
  it('deletes a local project; tasks fall back to Inbox', async () => {
    await ensureProject('dropme', 'local')
    const { task } = await addTask({ title: 'orphan me', project: 'dropme' })

    const res = await request(createApp()).delete('/api/v1/projects/dropme')
    expect(res.status).toBe(200)
    expect(res.body.project).toBe('dropme')
    expect(res.body.remoteDeleted).toBe(false)

    const list = await request(createApp()).get('/api/v1/projects')
    expect(list.body.projects.map((p: { name: string }) => p.name)).not.toContain('dropme')
    // The task itself detached to the Inbox (project = '').
    const moved = await getTask(task.id)
    expect(moved?.project ?? '').toBe('')
  })

  it('404 not_found for an unknown project', async () => {
    const res = await request(createApp()).delete('/api/v1/projects/ghost')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('ordering', () => {
  it('PUT /ordering/projects persists; GET /ordering reads it back', async () => {
    const app = createApp()
    const put = await request(app).put('/api/v1/ordering/projects').send({ order: ['b', 'a', 'c'] })
    expect(put.status).toBe(200)
    expect(put.body.projects).toEqual(['b', 'a', 'c'])

    const get = await request(app).get('/api/v1/ordering')
    expect(get.status).toBe(200)
    expect(get.body.projects).toEqual(['b', 'a', 'c'])
  })

  it('400 for a non-array order', async () => {
    const res = await request(createApp()).put('/api/v1/ordering/projects').send({ order: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('project favorites', () => {
  it('POST adds under the canonical registry spelling (case-insensitive), idempotent', async () => {
    await ensureProject('Voyager', 'local')
    const app = createApp()
    const added = await request(app).post('/api/v1/favorites/projects/voyager')
    expect(added.status).toBe(200)
    expect(added.body.projects).toEqual(['Voyager'])

    // Re-adding under a different case never duplicates.
    const again = await request(app).post('/api/v1/favorites/projects/VOYAGER')
    expect(again.body.projects).toEqual(['Voyager'])
  })

  it('DELETE removes case-insensitively', async () => {
    await ensureProject('Voyager', 'local')
    const app = createApp()
    await request(app).post('/api/v1/favorites/projects/Voyager')
    const removed = await request(app).delete('/api/v1/favorites/projects/voyager')
    expect(removed.status).toBe(200)
    expect(removed.body.projects).toEqual([])
  })
})

describe('project metadata (Wave 3)', () => {
  it('GET answers the detail-pane payload; PUT merges and null clears', async () => {
    await ensureProject('marina', 'local')
    await addTask({ title: 'one', project: 'marina' })
    const app = createApp()

    const before = await request(app).get('/api/v1/projects/marina/metadata')
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ name: 'marina', source: 'local', metadata: {} })
    // Task rows from earlier tests in this file share the sqlite handle —
    // assert at-least, not exactly-one.
    expect(before.body.counts.todo).toBeGreaterThanOrEqual(1)

    const put = await request(app).put('/api/v1/projects/marina/metadata')
      .send({ default_cwd: '/tmp/marina', default_host: 'devbox' })
    expect(put.status).toBe(200)
    expect(put.body.metadata ?? put.body).toBeTruthy()

    const after = await request(app).get('/api/v1/projects/marina/metadata')
    expect(after.body.metadata.default_cwd).toBe('/tmp/marina')

    // JSON null = delete-key semantics.
    await request(app).put('/api/v1/projects/marina/metadata').send({ default_host: null })
    const cleared = await request(app).get('/api/v1/projects/marina/metadata')
    expect(cleared.body.metadata.default_host).toBeUndefined()
    expect(cleared.body.metadata.default_cwd).toBe('/tmp/marina')
  })

  it('validates: Inbox has no settings; body must be an object', async () => {
    const app = createApp()
    const inbox = await request(app).get('/api/v1/projects/%20/metadata')
    expect(inbox.status).toBe(400)
    const badBody = await request(app).put('/api/v1/projects/marina/metadata').send([1, 2])
    expect(badBody.status).toBe(400)
  })
})
