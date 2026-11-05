/**
 * A task id given in full names that task even when it is the start of
 * another task's id (src/lib/id-ref.ts). Ids vary in length, so `fixa83e-d669`
 * and `fixa83e-d6690` can both exist: a plain prefix match read the shorter
 * one as "Ambiguous ID prefix" (a 500 in the API), and a parent reference to
 * it counted the longer one as that parent too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-id-ref'))

import { addTask, completeTask, deleteTask, getTask, updateTask, _resetForTesting } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../src/core/session-db.js'
import * as sessionTracker from '../../src/core/session-tracker.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { openSubtaskCount } from '../../src/web/routes/board-v1.js'
import express from 'express'
import request from 'supertest'
import { tasksRouter } from '../../src/web/routes/tasks.js'
import { taskV1Router } from '../../src/web/routes/task-v1.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'
import { prepareAskAnswer } from '../../src/core/sessions/ask-answer.js'

const SHORT = 'fixa83e-d669'
const LONG = 'fixa83e-d6690'

async function reset(): Promise<void> {
  closeDb()
  closeSessionDb()
  sessionTracker._resetSessionTrackerForTesting()
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
}

beforeEach(async () => {
  await reset()
  await addTask({ title: 'Long id', explicitId: LONG })
  await addTask({ title: 'Short id', explicitId: SHORT })
})

afterEach(reset)

describe('a full id that is the start of another id', () => {
  it('getTask answers that task, not "ambiguous"', async () => {
    expect((await getTask(SHORT)).title).toBe('Short id')
    expect((await getTask(LONG)).title).toBe('Long id')
  })

  it('a shared prefix no id equals is still ambiguous', async () => {
    await expect(getTask('fixa83e')).rejects.toThrow(/Ambiguous ID prefix/)
    await expect(updateTask('fixa83e', { title: 'x' })).rejects.toThrow(/Ambiguous ID prefix/)
  })

  it('updateTask and completeTask write that task only', async () => {
    await updateTask(SHORT, { title: 'Short id, renamed' })
    expect((await getTask(SHORT)).title).toBe('Short id, renamed')
    expect((await getTask(LONG)).title).toBe('Long id')

    const { task } = await completeTask(SHORT)
    expect(task.id).toBe(SHORT)
    expect((await getTask(SHORT)).phase).toBe('COMPLETE')
    expect((await getTask(LONG)).phase).not.toBe('COMPLETE')
  })

  it('deleteTask removes that task only', async () => {
    const { task } = await deleteTask(SHORT)
    expect(task.id).toBe(SHORT)
    expect((await getTask(LONG)).id).toBe(LONG)
  })

  it('answers_ask aims at that task; a shared prefix is refused as ambiguous', async () => {
    // Neither task asks anything, so the refusal names the task the answer was aimed at.
    await expect(prepareAskAnswer(null, SHORT, 'Go ahead.')).rejects.toMatchObject({ code: 'no_open_ask', message: expect.stringContaining(`"Short id" (${SHORT})`) })
    await expect(prepareAskAnswer(null, 'fixa83e', 'Go ahead.')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^Ambiguous ID prefix "fixa83e"/) })
    await expect(prepareAskAnswer(null, 'nosuchid', 'Go ahead.')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/^No task found matching ID "nosuchid"/) })
  })

  it('a subtask filed under the full id belongs to that task', async () => {
    const { task: child } = await addTask({ title: 'Child', parent_task_id: SHORT })
    expect(child.parent_task_id).toBe(SHORT)
    const { task: moved } = await updateTask(child.id, { parent_task_id: LONG })
    expect(moved.parent_task_id).toBe(LONG)
  })
})

describe('the reverse form: whose parent is this task (board route helper)', () => {
  it('a parent reference that is a whole id counts for that task alone', async () => {
    await addTask({ title: 'Child of short', parent_task_id: SHORT })
    expect(await openSubtaskCount(SHORT)).toBe(1)
    expect(await openSubtaskCount(LONG)).toBe(0)
  })

  it('a legacy prefix no id equals still counts for every task it starts', async () => {
    await addTask({ title: 'Other', explicitId: 'fixb12c-0001' })
    const { task: child } = await addTask({ title: 'Child of other', parent_task_id: 'fixb12c-0001' })
    // A legacy row wrote only the head of its parent's id.
    const { updateTaskRaw } = await import('../../src/core/task-manager.js')
    await updateTaskRaw(child.id, { parent_task_id: 'fixb12c' })
    expect(await openSubtaskCount('fixb12c-0001')).toBe(1)
  })
})

describe('the API answers an id lookup by what the caller sent', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/tasks', tasksRouter)
  app.use('/api/v1', taskV1Router)
  app.use(errorHandler)

  it('/api/v1 answers a dependency the caller got wrong with a 400 too', async () => {
    const missing = await request(app).put(`/api/v1/tasks/${SHORT}/depends-on`).send({ depends_on: ['fixzzzz-0000'] })
    expect(missing.status).toBe(400)
    expect(JSON.stringify(missing.body)).toMatch(/Dependency target not found/)
    const self = await request(app).put(`/api/v1/tasks/${SHORT}/depends-on`).send({ depends_on: [SHORT] })
    expect(self.status).toBe(400)
  })

  it('a full id that prefixes another is that task (200), for a read and a write', async () => {
    const got = await request(app).get(`/api/tasks/${SHORT}`)
    expect(got.status).toBe(200)
    expect(got.body.task.title).toBe('Short id')
    const patched = await request(app).patch(`/api/tasks/${SHORT}`).send({ title: 'Short id, via the API' })
    expect(patched.status).toBe(200)
    expect((await getTask(LONG)).title).toBe('Long id')
  })

  it('a prefix two ids share is the caller\'s to lengthen (400), an id that names nothing is 404, never a 500', async () => {
    const ambiguous = await request(app).get('/api/tasks/fixa83e')
    expect(ambiguous.status).toBe(400)
    expect(ambiguous.body.error).toMatch(/Ambiguous ID prefix/)
    const missing = await request(app).get('/api/tasks/fixzzzz-0000')
    expect(missing.status).toBe(404)
    const badParent = await request(app).patch(`/api/tasks/${SHORT}`).send({ parent_task_id: 'nope-0000' })
    expect(badParent.status).toBe(400)
  })

  it('a parent or a dependency the caller got wrong is a 400 with words that say why, never a 500', async () => {
    const self = await request(app).patch(`/api/tasks/${SHORT}`).send({ parent_task_id: SHORT })
    expect(self.status).toBe(400)
    expect(self.body.error).toMatch(/own parent/)
    await request(app).patch(`/api/tasks/${LONG}`).send({ parent_task_id: SHORT }).expect(200)
    const loop = await request(app).patch(`/api/tasks/${SHORT}`).send({ parent_task_id: LONG })
    expect(loop.status).toBe(409)
    expect(loop.body.error).toMatch(/^Circular reference: "Long id" is a subtask of "Short id[^"]*"/)
    const missingDep = await request(app).put(`/api/tasks/${SHORT}/depends-on`).send({ depends_on: ['fixzzzz-0000'] })
    expect(missingDep.status).toBe(400)
    expect(missingDep.body.error).toMatch(/not found/)
    // A prefix is no dependency id: the words name the tasks it starts, not "not found".
    const prefixDep = await request(app).put(`/api/tasks/${SHORT}/depends-on`).send({ depends_on: ['fixa83e'] })
    expect(prefixDep.status).toBe(400)
    expect(prefixDep.body.error).toMatch(/not a whole task id \(2 tasks start with it: /)
    for (const r of [self, loop, missingDep, prefixDep]) expect(r.body.details).toBeUndefined()
  })

  it('the words name what to do: the candidates of an ambiguous parent, the whole id that names nothing, a loop by title', async () => {
    const ambiguousParent = await request(app).patch(`/api/tasks/${SHORT}`).send({ parent_task_id: 'fixa83e' })
    expect(ambiguousParent.status).toBe(400)
    expect(ambiguousParent.body.error).toMatch(/^Ambiguous parent_task_id prefix "fixa83e" matches 2 tasks \(fixa83e-d6690?, fixa83e-d6690?\): give the whole id\.$/)
    const badParent = await request(app).patch(`/api/tasks/${SHORT}`).send({ parent_task_id: 'nope-0000' })
    expect(badParent.body.error).toBe('Parent task not found: "nope-0000": no task has that id or an id starting with it.')
    const missing = await request(app).get('/api/tasks/fixzzzz-0000')
    expect(missing.body.error).toBe('No task found matching ID "fixzzzz-0000": no task has that id or an id starting with it.')
    await request(app).put(`/api/tasks/${SHORT}/depends-on`).send({ depends_on: [LONG] }).expect(200)
    const loop = await request(app).put(`/api/tasks/${LONG}/depends-on`).send({ depends_on: [SHORT] })
    expect(loop.status).toBe(409)
    expect(loop.body.error).toMatch(/"Short id[^"]*" already depends on "Long id", directly or through other tasks.*Remove that dependency first\./)
  })
})
