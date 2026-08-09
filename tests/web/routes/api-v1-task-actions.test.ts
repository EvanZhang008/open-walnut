/**
 * /api/v1 task + focus endpoints (Wave 1) — task-v1.ts. Bare express +
 * supertest against the real task-manager on an isolated temp home (same
 * harness family as api-v1-session-control.test.ts). Verifies the endpoints
 * reuse the exact web-route semantics: detail decorations, delete guards,
 * star/note/description/summary/depends-on setters, reorder, batch partial
 * success, and the focus pin/tier set — plus the frozen error shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskactions'))

import express from 'express'
import request from 'supertest'
import { taskV1Router } from '../../../src/web/routes/task-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, listTasks, _resetForTesting } from '../../../src/core/task-manager.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', taskV1Router)
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

describe('GET /api/v1/tasks/:id', () => {
  it('returns the FULL task with description/note readback + dependency decorations', async () => {
    const depId = await makeTask('Dependency task')
    const id = await makeTask('Detail task', { description: 'full description body', depends_on: [depId] })

    const res = await request(createApp()).get(`/api/v1/tasks/${id}`)
    expect(res.status).toBe(200)
    const { task } = res.body as { task: Record<string, unknown> }
    expect(task.id).toBe(id)
    expect(task.description).toBe('full description body')
    expect(task.is_blocked).toBe(true)
    expect(task.resolved_dependencies).toEqual([
      { id: depId, title: 'Dependency task', phase: 'TODO' },
    ])

    // The dependency's detail lists the dependent.
    const depRes = await request(createApp()).get(`/api/v1/tasks/${depId}`)
    expect(depRes.status).toBe(200)
    expect((depRes.body.task.dependents as Array<{ id: string }>).map((d) => d.id)).toContain(id)
  })

  it('includes parent/children decorations', async () => {
    const parentId = await makeTask('Parent task')
    const childId = await makeTask('Child task', { parent_task_id: parentId })

    const parentRes = await request(createApp()).get(`/api/v1/tasks/${parentId}`)
    expect((parentRes.body.task.children as Array<{ id: string }>).map((c) => c.id)).toContain(childId)

    const childRes = await request(createApp()).get(`/api/v1/tasks/${childId}`)
    expect((childRes.body.task.parent as { id: string }).id).toBe(parentId)
  })

  it('404 not_found in the frozen shape for an unknown id', async () => {
    const res = await request(createApp()).get('/api/v1/tasks/nope-nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(typeof res.body.error.message).toBe('string')
  })
})

describe('DELETE /api/v1/tasks/:id', () => {
  it('deletes and returns 204', async () => {
    const id = await makeTask('To delete')
    const res = await request(createApp()).delete(`/api/v1/tasks/${id}`)
    expect(res.status).toBe(204)
    await expect(getTask(id)).rejects.toThrow(/No task found/)
  })

  it('404 for an unknown id', async () => {
    const res = await request(createApp()).delete('/api/v1/tasks/nope-nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/tasks/:id/star', () => {
  it('toggles star on and off', async () => {
    const id = await makeTask('Starrable')
    const app = createApp()
    const on = await request(app).post(`/api/v1/tasks/${id}/star`)
    expect(on.status).toBe(200)
    expect(on.body.starred).toBe(true)
    const off = await request(app).post(`/api/v1/tasks/${id}/star`)
    expect(off.body.starred).toBe(false)
  })
})

describe('note / description / summary setters', () => {
  it('POST notes appends; PUT note replaces', async () => {
    const id = await makeTask('Notes task')
    const app = createApp()
    const appended = await request(app).post(`/api/v1/tasks/${id}/notes`).send({ content: 'first note' })
    expect(appended.status).toBe(200)
    expect(String(appended.body.task.note)).toContain('first note')

    const replaced = await request(app).put(`/api/v1/tasks/${id}/note`).send({ content: 'clean slate' })
    expect(replaced.status).toBe(200)
    expect(replaced.body.task.note).toBe('clean slate')
  })

  it('PUT description and PUT summary persist', async () => {
    const id = await makeTask('Fields task')
    const app = createApp()
    expect((await request(app).put(`/api/v1/tasks/${id}/description`).send({ content: 'the description' })).status).toBe(200)
    expect((await request(app).put(`/api/v1/tasks/${id}/summary`).send({ content: 'the summary' })).status).toBe(200)
    const task = await getTask(id)
    expect(task.description).toBe('the description')
    expect(task.summary).toBe('the summary')
  })

  it('400 bad_request when content is missing', async () => {
    const id = await makeTask('Missing content')
    const res = await request(createApp()).put(`/api/v1/tasks/${id}/note`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('PUT /api/v1/tasks/:id/depends-on', () => {
  it('replaces dependencies', async () => {
    const dep = await makeTask('New dep')
    const id = await makeTask('Depends task')
    const res = await request(createApp()).put(`/api/v1/tasks/${id}/depends-on`).send({ depends_on: [dep] })
    expect(res.status).toBe(200)
    expect((await getTask(id)).depends_on).toEqual([dep])
  })

  it('409 conflict on a circular dependency', async () => {
    const a = await makeTask('Task A')
    const b = await makeTask('Task B')
    const app = createApp()
    expect((await request(app).put(`/api/v1/tasks/${a}/depends-on`).send({ depends_on: [b] })).status).toBe(200)
    const res = await request(app).put(`/api/v1/tasks/${b}/depends-on`).send({ depends_on: [a] })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
  })

  it('400 for a non-array body', async () => {
    const id = await makeTask('Bad deps')
    const res = await request(createApp()).put(`/api/v1/tasks/${id}/depends-on`).send({ depends_on: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('PATCH /api/v1/tasks/reorder', () => {
  it('reorders tasks within a project group', async () => {
    const a = await makeTask('First', { project: 'marina' })
    const b = await makeTask('Second', { project: 'marina' })
    const res = await request(createApp()).patch('/api/v1/tasks/reorder').send({ project: 'marina', taskIds: [b, a] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const ordered = (await listTasks({})).filter((t) => t.project === 'marina').map((t) => t.id)
    expect(ordered).toEqual([b, a])
  })

  it('400 when project is missing (type check, not truthiness — "" is Inbox)', async () => {
    const res = await request(createApp()).patch('/api/v1/tasks/reorder').send({ taskIds: ['x'] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('batch operations (partial success by design)', () => {
  it('POST batch/phase changes matched tasks and reports unknown ids in failed', async () => {
    const a = await makeTask('Batch A')
    const b = await makeTask('Batch B')
    const res = await request(createApp())
      .post('/api/v1/tasks/batch/phase')
      .send({ task_ids: [a, b, 'zz-unknown'], phase: 'COMPLETE' })
    expect(res.status).toBe(200)
    expect((res.body.changed as Array<{ id: string }>).map((t) => t.id).sort()).toEqual([a, b].sort())
    expect((res.body.failed as Array<{ id: string }>).map((f) => f.id)).toContain('zz-unknown')
  })

  it('POST batch/phase 400 on an invalid phase', async () => {
    const a = await makeTask('Batch phase bad')
    const res = await request(createApp()).post('/api/v1/tasks/batch/phase').send({ task_ids: [a], phase: 'NOT_A_PHASE' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('POST batch/delete deletes matched tasks and reports unknown ids in failed', async () => {
    const a = await makeTask('Del A')
    const b = await makeTask('Del B')
    const res = await request(createApp())
      .post('/api/v1/tasks/batch/delete')
      .send({ task_ids: [a, b, 'zz-unknown'] })
    expect(res.status).toBe(200)
    expect((res.body.deleted as Array<{ id: string }>).map((t) => t.id).sort()).toEqual([a, b].sort())
    expect((res.body.failed as Array<{ id: string }>).map((f) => f.id)).toContain('zz-unknown')
    await expect(getTask(a)).rejects.toThrow(/No task found/)
  })

  it('400 when task_ids is empty', async () => {
    const res = await request(createApp()).post('/api/v1/tasks/batch/delete').send({ task_ids: [] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('focus pins + tiers', () => {
  it('pin → tier split → tier move → unpin round trip', async () => {
    const id = await makeTask('Pin me')
    const app = createApp()

    const pinned = await request(app).post(`/api/v1/focus/tasks/${id}`)
    expect(pinned.status).toBe(200)
    expect(pinned.body.pinned_tasks).toContain(id)

    // Pin is idempotent.
    const again = await request(app).post(`/api/v1/focus/tasks/${id}`)
    expect(again.body.pinned_tasks).toContain(id)

    const split = await request(app).get('/api/v1/focus/tasks')
    expect(split.status).toBe(200)
    expect(split.body.pinned_tasks).toContain(id)
    expect(split.body.satellite_tasks).toContain(id) // default tier

    const moved = await request(app).put(`/api/v1/focus/tasks/${id}/tier`).send({ tier: 'focus' })
    expect(moved.status).toBe(200)
    expect(moved.body.focus_tasks).toContain(id)

    const unpinned = await request(app).delete(`/api/v1/focus/tasks/${id}`)
    expect(unpinned.status).toBe(200)
    expect(unpinned.body.pinned_tasks).not.toContain(id)
  })

  it('PUT focus/reorder returns the FULL tier snapshot', async () => {
    const a = await makeTask('Pin A')
    const b = await makeTask('Pin B')
    const app = createApp()
    await request(app).post(`/api/v1/focus/tasks/${a}`)
    await request(app).post(`/api/v1/focus/tasks/${b}`)
    const res = await request(app).put('/api/v1/focus/reorder').send({ task_ids: [a, b] })
    expect(res.status).toBe(200)
    expect(res.body.pinned_tasks).toEqual([a, b])
    // Full snapshot contract — every tier bucket present.
    for (const key of ['focus_tasks', 'satellite_tasks', 'backlog_tasks', 'wait_tasks', 'custom_tier_tasks']) {
      expect(res.body).toHaveProperty(key)
    }
  })

  it('409 conflict when pinning a completed task', async () => {
    const id = await makeTask('Done already')
    const { updateTask } = await import('../../../src/core/task-manager.js')
    await updateTask(id, { status: 'done' }, { source: 'api' })
    const res = await request(createApp()).post(`/api/v1/focus/tasks/${id}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
  })

  it('400 for an unregistered tier; GET focus/tiers lists customs', async () => {
    const id = await makeTask('Tier target')
    const app = createApp()
    await request(app).post(`/api/v1/focus/tasks/${id}`)
    const bad = await request(app).put(`/api/v1/focus/tasks/${id}/tier`).send({ tier: 'ct_unregistered' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('bad_request')

    const tiers = await request(app).get('/api/v1/focus/tiers')
    expect(tiers.status).toBe(200)
    expect(Array.isArray(tiers.body.tiers)).toBe(true)
  })
})
