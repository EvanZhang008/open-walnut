/**
 * PATCH /api/v1/tasks/:id — task mutation from mobile (additive endpoint).
 * Real startServer({ port: 0, dev: true }) with an isolated temp home (same
 * harness as api-v1-task-create.test.ts). Verifies the endpoint reuses the
 * exact web PATCH semantics (updateTask, source 'api', asyncPush): field
 * updates, validation 400s, unknown-id 404, the active-children guard, and
 * the human-source terminal-phase policy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskupdate'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

async function createTask(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await fetch(apiUrl('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  const { task } = await res.json() as { task: { id: string } }
  return task
}

async function patchTask(id: string, body: unknown): Promise<Response> {
  return fetch(apiUrl(`/api/v1/tasks/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('PATCH /api/v1/tasks/:id', () => {
  it('updates status/priority/due_date/title in one call — slim shape returned', async () => {
    const task = await createTask({ title: 'Original title' })
    const due = '2030-06-01T09:00:00.000Z'
    const res = await patchTask(task.id, {
      status: 'in_progress', priority: 'important', due_date: due, title: 'Renamed title',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walnut-api')).toBe('1')
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated.id).toBe(task.id)
    expect(updated.title).toBe('Renamed title')
    expect(updated.status).toBe('in_progress')
    expect(updated.phase).toBe('IN_PROGRESS') // phase derived from status
    expect(updated.priority).toBe('important')
    expect(updated.due_date).toBe(due)
    // Slim contract: heavy fields never leak through.
    expect(updated).not.toHaveProperty('note')
    expect(updated).not.toHaveProperty('description')
    expect(updated).not.toHaveProperty('session_ids')
  })

  it('status done marks the task complete; the projection reflects it', async () => {
    const task = await createTask({ title: 'To be done' })
    const res = await patchTask(task.id, { status: 'done' })
    expect(res.status).toBe(200)
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated.status).toBe('done')
    expect(updated.phase).toBe('COMPLETE')

    const list = await fetch(apiUrl('/api/v1/tasks?status=done'))
    const body = await list.json() as { tasks: Array<{ id: string }> }
    expect(body.tasks.some((t) => t.id === task.id)).toBe(true)
  })

  it('a human-initiated PATCH may reopen a completed task (terminal guard human policy)', async () => {
    // The terminal phase guard blocks NON-human sources from overwriting
    // COMPLETE — the v1 PATCH uses source 'api' (human), same as the web UI,
    // so reopening must be allowed (this documents intended behavior, not a bypass).
    const task = await createTask({ title: 'Complete then reopen' })
    expect((await patchTask(task.id, { status: 'done' })).status).toBe(200)
    const res = await patchTask(task.id, { status: 'todo' })
    expect(res.status).toBe(200)
    const { task: reopened } = await res.json() as { task: Record<string, unknown> }
    expect(reopened.status).toBe('todo')
    expect(reopened.phase).toBe('TODO')
  })

  it('409 conflict when completing a parent with active children (guard preserved)', async () => {
    const parent = await createTask({ title: 'Parent with child' })
    // Child task via the web API (parent_task_id is not a v1 create field).
    const childRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Active child', parent_task_id: parent.id }),
    })
    expect(childRes.status).toBe(201)

    const res = await patchTask(parent.id, { status: 'done' })
    expect(res.status).toBe(409)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('conflict')
  })

  it('moves a task to a new project (registry row auto-created) and back to Inbox', async () => {
    const task = await createTask({ title: 'Mover' })
    const res = await patchTask(task.id, { project: 'Marina Cleanup' })
    expect(res.status).toBe(200)
    const { task: moved } = await res.json() as { task: { project: string } }
    expect(moved.project).toBe('Marina Cleanup')

    const back = await patchTask(task.id, { project: '' })
    expect(back.status).toBe(200)
    const { task: inbox } = await back.json() as { task: { project: string } }
    expect(inbox.project).toBe('')
  })

  it('due_date "" clears the due date', async () => {
    const task = await createTask({ title: 'Dated', due_date: '2030-05-05' })
    const res = await patchTask(task.id, { due_date: '' })
    expect(res.status).toBe(200)
    const { task: cleared } = await res.json() as { task: Record<string, unknown> }
    expect(cleared.due_date).toBeUndefined()
  })

  it('updates description (write-only — stored but not in the slim shape)', async () => {
    const task = await createTask({ title: 'Describe me' })
    const res = await patchTask(task.id, { description: 'new context blob' })
    expect(res.status).toBe(200)
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated).not.toHaveProperty('description')

    const full = await fetch(apiUrl(`/api/tasks/${task.id}`))
    const fullBody = await full.json() as { task: { description: string } }
    expect(fullBody.task.description).toBe('new context blob')
  })

  it('updates description AND title in one call (description first, then the main patch)', async () => {
    const task = await createTask({ title: 'Combo before' })
    const res = await patchTask(task.id, { title: 'Combo after', description: 'combo blob' })
    expect(res.status).toBe(200)
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated.title).toBe('Combo after')

    const full = await fetch(apiUrl(`/api/tasks/${task.id}`))
    const fullBody = await full.json() as { task: { title: string; description: string } }
    expect(fullBody.task.title).toBe('Combo after')
    expect(fullBody.task.description).toBe('combo blob')
  })

  it('description failure aborts BEFORE the main patch — no misleading half-applied 500 (P1-4)', async () => {
    const task = await createTask({ title: 'Atomicity target' })
    const tm = await import('../../../src/core/task-manager.js')
    const spy = vi.spyOn(tm, 'updateDescription').mockRejectedValueOnce(new Error('plugin validation exploded'))
    try {
      const res = await patchTask(task.id, { title: 'Should not apply', description: 'boom' })
      expect(res.status).toBe(500)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('internal')
      // The error response must truthfully mean "nothing was applied":
      // description runs first, so the title patch never executed.
      const full = await fetch(apiUrl(`/api/tasks/${task.id}`))
      const fullBody = await full.json() as { task: { title: string } }
      expect(fullBody.task.title).toBe('Atomicity target')
    } finally {
      spy.mockRestore()
    }
  })

  it('404 not_found for an unknown task id', async () => {
    const res = await patchTask('task-does-not-exist', { status: 'done' })
    expect(res.status).toBe(404)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('not_found')
  })

  it('400 bad_request for invalid field values', async () => {
    const task = await createTask({ title: 'Validation target' })
    for (const body of [
      { status: 'finished' },              // not a v1 status
      { status: 'COMPLETE' },              // phases are not statuses
      { priority: 'high' },                // invalid priority
      { due_date: 'not-a-date' },
      { due_date: '2030-02-30' },          // calendar rollover
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(501) },
      { project: 7 },
      { description: ['x'] },
      {},                                   // no updatable fields
    ]) {
      const res = await patchTask(task.id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('bad_request')
    }
  })
})
