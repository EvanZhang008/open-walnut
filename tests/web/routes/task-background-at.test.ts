/**
 * Background (Task.background_at, 2026-11-11): the user puts long-running work (a CR review, a
 * recurring job) in the Background group at the foot of the home task list, where an open task
 * stays whatever its status. Real startServer({ port: 0, dev: true }) with an isolated temp home,
 * so both write routes (the web's PATCH /api/tasks/:id, the phone's PATCH /api/v1/tasks/:id) and
 * the reads the web and the phone use are the real ones. Pins: set / clear / invalid on both
 * routes, that the mark moves no phase, pin or read marker, that Watching and Background hold a
 * task one at a time, and that the field rides the list payloads and the v1 projection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-background-at'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import * as tm from '../../../src/core/task-manager.js'
import { buildTaskProjection } from '../../../src/core/task-projection.js'

let server: HttpServer
let port: number

const AT = '2026-11-11T19:10:00.000Z'
const WATCH_AT = '2026-11-10T08:30:00.000Z'

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

async function createTask(title: string): Promise<{ id: string }> {
  const res = await fetch(apiUrl('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  expect(res.status).toBe(201)
  const { task } = await res.json() as { task: { id: string } }
  return task
}

async function patch(route: 'web' | 'v1', id: string, body: unknown): Promise<Response> {
  const path = route === 'web' ? `/api/tasks/${id}` : `/api/v1/tasks/${id}`
  return fetch(apiUrl(path), {
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

describe.each(['web', 'v1'] as const)('PATCH background_at through the %s route', (route) => {
  it('an ISO time puts the task in Background and "" takes it out (stored as absent)', async () => {
    const { id } = await createTask(`Background me (${route})`)
    const set = await patch(route, id, { background_at: AT })
    expect(set.status).toBe(200)
    expect((await tm.getTask(id)).background_at).toBe(AT)

    const cleared = await patch(route, id, { background_at: '' })
    expect(cleared.status).toBe(200)
    expect('background_at' in (await tm.getTask(id))).toBe(false)
  })

  it.each([
    ['a non-date string', 'later'],
    ['a number', 1731352200000],
    ['a boolean', true],
  ])('refuses %s with 400 and writes nothing', async (_label, value) => {
    const { id } = await createTask(`Bad background (${route})`)
    const res = await patch(route, id, { background_at: value })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('background_at must be an ISO-8601 datetime')
    expect('background_at' in (await tm.getTask(id))).toBe(false)
  })

  it('moves no phase, pin or read marker', async () => {
    const { id } = await createTask(`Needs me, in Background (${route})`)
    await tm.updateTask(id, { phase: 'NEED_ACTION' }, { source: 'api' })
    await tm.updateTask(id, { unread: true }, { source: 'api' })
    const before = await tm.getTask(id)
    expect((await patch(route, id, { background_at: AT })).status).toBe(200)
    const after = await tm.getTask(id)
    expect(after.background_at).toBe(AT)
    expect(after.phase).toBe('NEED_ACTION')
    expect(after.unread).toBe(before.unread)
    expect(!!after.pinned).toBe(!!before.pinned)
    expect(after.focus_tier).toBe(before.focus_tier)
  })

  it('Background ends a watch, and a watch takes the task out of Background', async () => {
    const { id } = await createTask(`Watched then background (${route})`)
    expect((await patch(route, id, { watched_at: WATCH_AT })).status).toBe(200)
    expect((await patch(route, id, { background_at: AT })).status).toBe(200)
    let row = await tm.getTask(id)
    expect(row.background_at).toBe(AT)
    expect('watched_at' in row).toBe(false)

    expect((await patch(route, id, { watched_at: WATCH_AT })).status).toBe(200)
    row = await tm.getTask(id)
    expect(row.watched_at).toBe(WATCH_AT)
    expect('background_at' in row).toBe(false)
  })
})

describe('v1 PATCH background_at extras', () => {
  it('null takes it out too, and background_at alone counts as an updatable field', async () => {
    const { id } = await createTask('Null clear')
    expect((await patch('v1', id, { background_at: AT })).status).toBe(200)
    expect((await patch('v1', id, { background_at: null })).status).toBe(200)
    expect('background_at' in (await tm.getTask(id))).toBe(false)
  })
})

describe('reads carry background_at', () => {
  it('GET /api/tasks (full, slim and list), the v1 list and detail, and the projection', async () => {
    const { id } = await createTask('Read back')
    expect((await patch('web', id, { background_at: AT })).status).toBe(200)

    for (const q of ['', '?slim=1', '?fields=list']) {
      const res = await fetch(apiUrl(`/api/tasks${q}`))
      const { tasks } = await res.json() as { tasks: Array<Record<string, unknown>> }
      expect(tasks.find((t) => t.id === id)?.background_at, `GET /api/tasks${q}`).toBe(AT)
    }
    const list = await fetch(apiUrl('/api/v1/tasks'))
    const { tasks: v1Rows } = await list.json() as { tasks: Array<Record<string, unknown>> }
    expect(v1Rows.find((t) => t.id === id)?.background_at).toBe(AT)
    const detail = await (await fetch(apiUrl(`/api/v1/tasks/${id}`))).json() as Record<string, unknown>
    expect(((detail.task ?? detail) as Record<string, unknown>).background_at).toBe(AT)

    const plain = await createTask('Never in Background')
    const projection = await buildTaskProjection()
    expect(projection.tasks.find((t) => t.id === id)?.background_at).toBe(AT)
    expect(projection.tasks.find((t) => t.id === plain.id)).not.toHaveProperty('background_at')
  })
})

describe('raw writes keep the two marks apart (the replica outbox and the offline merge write raw)', () => {
  it('a raw background_at ends a watch, and a raw watched_at takes the task out of Background', async () => {
    const { id } = await createTask('Raw path')
    await tm.updateTaskRaw(id, { watched_at: WATCH_AT })
    await tm.updateTaskRaw(id, { background_at: AT })
    let row = await tm.getTask(id)
    expect(row.background_at).toBe(AT)
    expect(row.watched_at ?? null).toBeNull()
    await tm.updateTaskRaw(id, { watched_at: WATCH_AT })
    row = await tm.getTask(id)
    expect(row.watched_at).toBe(WATCH_AT)
    expect(row.background_at ?? null).toBeNull()
  })
})
