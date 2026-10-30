/**
 * Watch (Task.watched_at): the user keeps a task in a Watching section on top of the
 * home task panel whatever its phase. Real startServer({ port: 0, dev: true }) with an
 * isolated temp home, so both write routes (the web's PATCH /api/tasks/:id and the
 * phone's PATCH /api/v1/tasks/:id) and every read the web and the phone use are the
 * real ones. Pins: set / clear / invalid on both routes, that a watch moves no phase,
 * pin or read marker (a completed task stays completed), that the field rides the
 * slim and list payloads and the v1 projection, and that a watched done task outlives
 * the projection's done-retention window.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-watched-at'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import * as tm from '../../../src/core/task-manager.js'
import { buildTaskProjection } from '../../../src/core/task-projection.js'

let server: HttpServer
let port: number

const WATCH_AT = '2026-10-29T08:30:00.000Z'

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

describe.each(['web', 'v1'] as const)('PATCH watched_at through the %s route', (route) => {
  it('an ISO time starts watching and "" stops it (stored as absent)', async () => {
    const { id } = await createTask(`Watch me (${route})`)
    const set = await patch(route, id, { watched_at: WATCH_AT })
    expect(set.status).toBe(200)
    const { task: setRow } = await set.json() as { task: Record<string, unknown> }
    expect(setRow.watched_at).toBe(WATCH_AT)
    expect((await tm.getTask(id)).watched_at).toBe(WATCH_AT)

    const cleared = await patch(route, id, { watched_at: '' })
    expect(cleared.status).toBe(200)
    const { task: clearedRow } = await cleared.json() as { task: Record<string, unknown> }
    expect(clearedRow).not.toHaveProperty('watched_at')
    expect('watched_at' in (await tm.getTask(id))).toBe(false)
  })

  it.each([
    ['a non-date string', 'tomorrow-ish'],
    ['a number', 1730190600000],
    ['a boolean', true],
    ['an object', { at: WATCH_AT }],
  ])('refuses %s with 400 and writes nothing', async (_label, value) => {
    const { id } = await createTask(`Bad watch (${route})`)
    const res = await patch(route, id, { watched_at: value })
    expect(res.status).toBe(400)
    const body = await res.json() as { error?: unknown }
    expect(JSON.stringify(body)).toContain('watched_at must be an ISO-8601 datetime')
    expect('watched_at' in (await tm.getTask(id))).toBe(false)
  })

  it('moves no phase, pin or read marker; a completed task stays completed', async () => {
    const { id } = await createTask(`Done but watched (${route})`)
    await tm.updateTask(id, { phase: 'COMPLETE' }, { source: 'api' })
    await tm.updateTask(id, { unread: true }, { source: 'api' })
    const before = await tm.getTask(id)
    expect(before.phase).toBe('COMPLETE')

    const res = await patch(route, id, { watched_at: WATCH_AT })
    expect(res.status).toBe(200)
    const after = await tm.getTask(id)
    expect(after.watched_at).toBe(WATCH_AT)
    expect(after.phase).toBe('COMPLETE')
    expect(after.status).toBe('done')
    expect(after.completed_at).toBe(before.completed_at)
    expect(after.unread).toBe(before.unread)
    expect(!!after.pinned).toBe(!!before.pinned)
    expect(after.focus_tier).toBe(before.focus_tier)
  })
})

describe('v1 PATCH watched_at extras', () => {
  it('null stops watching too (the v1 clear marker)', async () => {
    const { id } = await createTask('Null clear')
    expect((await patch('v1', id, { watched_at: WATCH_AT })).status).toBe(200)
    const res = await patch('v1', id, { watched_at: null })
    expect(res.status).toBe(200)
    expect('watched_at' in (await tm.getTask(id))).toBe(false)
  })

  it('watched_at alone counts as an updatable field', async () => {
    const { id } = await createTask('Alone')
    const res = await patch('v1', id, { watched_at: WATCH_AT })
    expect(res.status).toBe(200)
  })
})

describe('reads carry watched_at', () => {
  it('GET /api/tasks (full, slim and list) and the v1 list and detail', async () => {
    const { id } = await createTask('Read back')
    expect((await patch('web', id, { watched_at: WATCH_AT })).status).toBe(200)

    for (const q of ['', '?slim=1', '?fields=list']) {
      const res = await fetch(apiUrl(`/api/tasks${q}`))
      expect(res.status).toBe(200)
      const { tasks } = await res.json() as { tasks: Array<Record<string, unknown>> }
      expect(tasks.find((t) => t.id === id)?.watched_at, `GET /api/tasks${q}`).toBe(WATCH_AT)
    }

    const list = await fetch(apiUrl('/api/v1/tasks'))
    const { tasks: v1Rows } = await list.json() as { tasks: Array<Record<string, unknown>> }
    expect(v1Rows.find((t) => t.id === id)?.watched_at).toBe(WATCH_AT)

    const detail = await fetch(apiUrl(`/api/v1/tasks/${id}`))
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as Record<string, unknown>
    const detailTask = (detailBody.task ?? detailBody) as Record<string, unknown>
    expect(detailTask.watched_at).toBe(WATCH_AT)
  })

  it('an unwatched row carries no watched_at key in the v1 projection', async () => {
    const { id } = await createTask('Never watched')
    const projection = await buildTaskProjection()
    const row = projection.tasks.find((t) => t.id === id)
    expect(row).toBeDefined()
    expect(row).not.toHaveProperty('watched_at')
  })

  it('a watched done task outlives the projection done-retention window; an unwatched one does not', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const watched = await createTask('Old done, watched')
    const plain = await createTask('Old done, not watched')
    for (const t of [watched, plain]) {
      await tm.updateTask(t.id, { phase: 'COMPLETE' }, { source: 'api' })
      await tm.updateTaskRaw(t.id, { completed_at: old, updated_at: old })
    }
    await tm.updateTaskRaw(watched.id, { watched_at: WATCH_AT })
    const projection = await buildTaskProjection()
    const ids = new Set(projection.tasks.map((t) => t.id))
    expect(ids.has(watched.id)).toBe(true)
    expect(ids.has(plain.id)).toBe(false)
  })
})

describe('updateTask watched_at', () => {
  it('sets, clears to absent, and leaves the phase and the read marker alone', async () => {
    const { id } = await createTask('Core update')
    await tm.updateTask(id, { phase: 'NEED_ACTION' }, { source: 'api' })
    await tm.updateTask(id, { unread: true }, { source: 'api' })
    const before = await tm.getTask(id)

    const { task: set } = await tm.updateTask(id, { watched_at: WATCH_AT }, { source: 'api' })
    expect(set.watched_at).toBe(WATCH_AT)
    expect(set.phase).toBe(before.phase)
    expect(set.unread).toBe(true)

    const { task: cleared } = await tm.updateTask(id, { watched_at: '' }, { source: 'api' })
    expect('watched_at' in cleared).toBe(false)
    expect(cleared.phase).toBe(before.phase)
    expect(cleared.unread).toBe(true)
    // The store row agrees: '' is never persisted.
    expect('watched_at' in (await tm.getTask(id))).toBe(false)
  })

  it('a task that never had a watch is untouched by an unrelated update', async () => {
    const { id } = await createTask('Unrelated edit')
    const { task } = await tm.updateTask(id, { priority: 'important' }, { source: 'api' })
    expect('watched_at' in task).toBe(false)
  })
})
