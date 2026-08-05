/**
 * POST /api/v1/tasks — quick task creation from mobile (additive endpoint).
 * Real startServer({ port: 0, dev: true }) with an isolated temp home (same
 * harness as api-v1.test.ts). Verifies the endpoint reuses the exact web
 * quick-add creation semantics: default project, auto-created registry rows,
 * slim ProjectedTask response, and that the created task is immediately
 * visible in GET /api/v1/tasks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

async function postTask(body: unknown): Promise<Response> {
  return fetch(apiUrl('/api/v1/tasks'), {
    method: 'POST',
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

describe('POST /api/v1/tasks', () => {
  it('creates a task with title only — defaults applied, slim shape returned', async () => {
    const res = await postTask({ title: 'Buy oat milk' })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-walnut-api')).toBe('1')
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(typeof task.id).toBe('string')
    expect(task.title).toBe('Buy oat milk')
    expect(task.status).toBe('todo')
    expect(task.phase).toBe('TODO')
    // No project → the server's inbox default. The exact spelling ('' vs
    // 'Inbox') is task-manager's call and mid-migration; assert only that
    // the field exists and the task didn't land in a real project.
    expect(typeof task.project).toBe('string')
    expect(['', 'Inbox']).toContain(task.project)
    expect(typeof task.priority).toBe('string')
    expect(typeof task.created_at).toBe('string')
    // Slim contract: heavy fields never leak through.
    expect(task).not.toHaveProperty('note')
    expect(task).not.toHaveProperty('description')
    expect(task).not.toHaveProperty('session_ids')
  })

  it('created task is visible in GET /api/v1/tasks', async () => {
    const res = await postTask({ title: 'Visible in projection' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: { id: string } }

    const list = await fetch(apiUrl('/api/v1/tasks'))
    expect(list.status).toBe(200)
    const body = await list.json() as { tasks: Array<{ id: string; title: string }> }
    const found = body.tasks.find((t) => t.id === task.id)
    expect(found).toBeDefined()
    expect(found!.title).toBe('Visible in projection')
  })

  it('accepts optional fields and auto-creates a new project', async () => {
    const due = '2030-01-15T09:00:00.000Z'
    const res = await postTask({
      title: 'Plan the launch',
      project: 'Marina Launch',
      priority: 'important',
      due_date: due,
      description: 'coordinate everything',
    })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.project).toBe('Marina Launch')
    expect(task.priority).toBe('important')
    expect(task.due_date).toBe(due)

    // The full task (via the web API) carries the description; the slim
    // projection deliberately does not.
    const full = await fetch(apiUrl(`/api/tasks/${task.id}`))
    expect(full.status).toBe(200)
    const fullBody = await full.json() as { task: { description: string; project: string } }
    expect(fullBody.task.description).toBe('coordinate everything')

    // A second task can land in the now-existing project (registry row created).
    const res2 = await postTask({ title: 'Follow-up', project: 'marina launch' })
    expect(res2.status).toBe(201)
    const { task: task2 } = await res2.json() as { task: { project: string } }
    // Registry match semantics are mid-migration: canonical-spelling-wins
    // ('Marina Launch') on the new path, verbatim on the old. Pin only the
    // case-insensitive identity so both are accepted.
    expect(task2.project.toLowerCase()).toBe('marina launch')
  })

  it('trims the title', async () => {
    const res = await postTask({ title: '  padded title  ' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: { title: string } }
    expect(task.title).toBe('padded title')
  })

  it('400 bad_request when title is missing, empty, or not a string', async () => {
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: 42 }, { title: null }]) {
      const res = await postTask(body)
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('bad_request')
    }
  })

  it('400 bad_request for an overlong title (>500 chars)', async () => {
    const res = await postTask({ title: 'x'.repeat(501) })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('bad_request')
  })

  it('400 bad_request for an invalid priority', async () => {
    for (const priority of ['high', 'URGENT', 5, {}]) {
      const res = await postTask({ title: 'prio check', priority })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string; message: string } }
      expect(json.error.code).toBe('bad_request')
      expect(json.error.message).toContain('priority')
    }
  })

  it('400 bad_request for an unparseable due_date', async () => {
    // '12345' documents the strict-ISO fix: bare Date.parse accepted it as a year.
    // '2030-02-30' documents the rollover fix: regex + Date.parse both pass it
    // (JS rolls it to Mar 2); the round-trip check rejects it.
    for (const due of ['not-a-date', 12345, {}, '12345', '2030-13-99', '2030/01/15', '2030-02-30', '2030-02-30T10:00:00Z']) {
      const res = await postTask({ title: 'due check', due_date: due })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string; message: string } }
      expect(json.error.code).toBe('bad_request')
      expect(json.error.message).toContain('due_date')
    }
  })

  it('400 bad_request for non-string project / description', async () => {
    const p = await postTask({ title: 'proj check', project: 7 })
    expect(p.status).toBe(400)
    const d = await postTask({ title: 'desc check', description: ['x'] })
    expect(d.status).toBe(400)
  })
})
