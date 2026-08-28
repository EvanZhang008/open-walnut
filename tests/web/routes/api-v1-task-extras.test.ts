/**
 * /api/v1 task extras (Wave 2) — task-extras-v1.ts on the PRIMARY box:
 * tag catalog, virtual groups CRUD, and focus-tier CRUD against the real
 * task-manager on an isolated temp home. quick-parse is validation-only here
 * (the model call is not mocked — validation rejects before any LLM work).
 * Cloud 501s live in api-v1-task-extras-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskextras'))

import express from 'express'
import request from 'supertest'
import { taskExtrasV1Router } from '../../../src/web/routes/task-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, _resetForTesting } from '../../../src/core/task-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', taskExtrasV1Router)
  app.use(errorHandler)
  return app
}

async function makeTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { task } = await addTask({ title, ...extra })
  return task.id
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetForTesting()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/tasks/meta/tags', () => {
  it('returns unique tags with counts', async () => {
    await makeTask('a', { tags: ['deep', 'shared'] })
    await makeTask('b', { tags: ['shared'] })
    const res = await request(createApp()).get('/api/v1/tasks/meta/tags')
    expect(res.status).toBe(200)
    const byTag = Object.fromEntries(res.body.tags.map((t: { tag: string; count: number }) => [t.tag, t.count]))
    expect(byTag.shared).toBe(2)
    expect(byTag.deep).toBe(1)
  })
})

describe('task groups', () => {
  it('POST /tasks/groups creates (201); GET lists; members carry the group_id', async () => {
    const a = await makeTask('group member a')
    const b = await makeTask('group member b')
    const app = createApp()

    const created = await request(app).post('/api/v1/tasks/groups').send({ task_ids: [a, b], label: 'My batch' })
    expect(created.status).toBe(201)
    expect(created.body.label).toBe('My batch')
    const groupId = created.body.group_id as string

    const list = await request(app).get('/api/v1/tasks/groups')
    expect(list.status).toBe(200)
    expect(list.body.groups.some((g: { group_id: string }) => g.group_id === groupId)).toBe(true)
    expect((await getTask(a))?.group_id).toBe(groupId)
  })

  it('400 for fewer than 2 tasks on create', async () => {
    const a = await makeTask('solo task')
    const res = await request(createApp()).post('/api/v1/tasks/groups').send({ task_ids: [a] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('add / rename / hidden / remove round-trip', async () => {
    const a = await makeTask('rt a')
    const b = await makeTask('rt b')
    const c = await makeTask('rt c')
    const app = createApp()
    const groupId = (await request(app).post('/api/v1/tasks/groups').send({ task_ids: [a, b] })).body.group_id as string

    const added = await request(app).post(`/api/v1/tasks/groups/${groupId}/add`).send({ task_ids: [c] })
    expect(added.status).toBe(200)
    expect((await getTask(c))?.group_id).toBe(groupId)

    const renamed = await request(app).patch(`/api/v1/tasks/groups/${groupId}`).send({ label: 'Renamed batch' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.label).toBe('Renamed batch')

    const hidden = await request(app).patch(`/api/v1/tasks/groups/${groupId}/hidden`).send({ hidden: true })
    expect(hidden.status).toBe(200)
    expect(hidden.body.hidden).toBe(true)

    // Removing every member NO LONGER dissolves the folder (the folder cutover): an empty
    // folder is valid, so it keeps its registry row and still lists with no members.
    const removed = await request(app).post('/api/v1/tasks/groups/remove').send({ task_ids: [a, b, c] })
    expect(removed.status).toBe(200)
    expect(removed.body.removed_ids.sort()).toEqual([a, b, c].sort())
    expect(removed.body.dissolved_group_ids).toEqual([])
    expect((await getTask(a))?.group_id).toBeUndefined()

    const after = await request(app).get('/api/v1/tasks/groups')
    const listed = after.body.groups.find((g: { group_id: string }) => g.group_id === groupId)
    expect(listed, 'the emptied folder must still be listed').toBeDefined()
    expect(listed.member_ids).toEqual([])
    expect(listed.label).toBe('Renamed batch')
  })

  it('404 not_found for an unknown group id', async () => {
    const a = await makeTask('x')
    const res = await request(createApp()).post('/api/v1/tasks/groups/grp-none/add').send({ task_ids: [a] })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/tasks/quick-parse (validation)', () => {
  it('400 for empty text, oversized text, and a bogus timezone', async () => {
    const app = createApp()
    expect((await request(app).post('/api/v1/tasks/quick-parse').send({ text: '', timeZone: 'UTC' })).status).toBe(400)
    expect((await request(app).post('/api/v1/tasks/quick-parse').send({ text: 'x'.repeat(501), timeZone: 'UTC' })).status).toBe(400)
    const badTz = await request(app).post('/api/v1/tasks/quick-parse').send({ text: 'call mom', timeZone: 'Not/AZone' })
    expect(badTz.status).toBe(400)
    expect(badTz.body.error.code).toBe('bad_request')
  })
})

describe('focus tier CRUD', () => {
  it('create (201) → rename → delete round-trip', async () => {
    const app = createApp()
    const created = await request(app).post('/api/v1/focus/tiers').send({ label: 'Errands' })
    expect(created.status).toBe(201)
    const tierId = created.body.tier.id as string
    expect(created.body.tiers.some((t: { id: string }) => t.id === tierId)).toBe(true)

    const renamed = await request(app).put(`/api/v1/focus/tiers/${tierId}`).send({ label: 'Chores' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.tier.label).toBe('Chores')

    const deleted = await request(app).delete(`/api/v1/focus/tiers/${tierId}`)
    expect(deleted.status).toBe(200)
    expect(deleted.body.tiers.some((t: { id: string }) => t.id === tierId)).toBe(false)
  })

  it('400 for an empty label; 404 for an unknown tier; built-ins undeletable', async () => {
    const app = createApp()
    expect((await request(app).post('/api/v1/focus/tiers').send({})).status).toBe(400)
    expect((await request(app).put('/api/v1/focus/tiers/ghost-tier').send({ label: 'x' })).status).toBe(404)
    const builtin = await request(app).delete('/api/v1/focus/tiers/focus')
    expect(builtin.status).toBe(400)
    expect(builtin.body.error.message).toContain('Built-in')
  })
})
