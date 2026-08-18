/**
 * Calendar date fields on the v1 task write surface: POST /api/v1/tasks and
 * PATCH /api/v1/tasks/:id both accept `start_date` + `end_date` (2026-08).
 *
 * Two layers in one file:
 *   1. A pure validation matrix over the shared gate helpers (no server) —
 *      exhaustive over the shapes a client can send.
 *   2. Real round trips through startServer({ port: 0, dev: true }) — creation
 *      with a window, PATCH of each half, clears, and the 400s.
 *
 * The cloud REPLICA half (op reaches the primary with both fields) lives in
 * api-v1-task-dates-cloud.test.ts, which needs the CLOUD_MODE constants mock.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskdates'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { isDateFieldValid, validateDateWindow } from '../../../src/web/routes/api-v1.js'

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

async function createTask(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await postTask(body)
  expect(res.status, await res.clone().text()).toBe(201)
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

// ── Layer 1: the shared validation gate (pure) ──

describe('date field validation matrix', () => {
  it('accepts ISO date-only, ISO datetimes, and both clear markers', () => {
    for (const v of [
      '2030-01-15',
      '2030-01-15T09:00',
      '2030-01-15T09:00:00',
      '2030-01-15T09:00:00.000Z',
      '2030-01-15T09:00:00+02:00',
      '2030-01-15T09:00:00-07:00',
      '',      // explicit clear (mirrors due_date)
      null,    // a client that models "no date" as null
    ]) {
      expect(isDateFieldValid(v), JSON.stringify(v)).toBe(true)
    }
  })

  it('rejects junk, wrong shapes, calendar rollovers, and non-strings', () => {
    for (const v of [
      'not-a-date',
      '12345',                  // bare Date.parse reads this as a year
      '2030-13-99',
      '2030/01/15',
      '2030-02-30',             // JS silently rolls this to Mar 2
      '2030-02-30T10:00:00Z',
      '15-01-2030',
      12345,
      {},
      [],
      true,
      undefined,                // callers gate `undefined` before this helper
    ]) {
      expect(isDateFieldValid(v), JSON.stringify(v) ?? 'undefined').toBe(false)
    }
  })

  it('window check: an end alone is invalid, end < start is invalid, end >= start is fine', () => {
    // No end at all → nothing to check (a lone start is a valid "starts then").
    expect(validateDateWindow('2030-01-15', undefined)).toBeNull()
    expect(validateDateWindow(undefined, undefined)).toBeNull()
    // An end with no start has no block to end.
    expect(validateDateWindow(undefined, '2030-01-15')).toMatch(/requires a start_date/)
    // Ordering.
    expect(validateDateWindow('2030-01-15', '2030-01-14')).toMatch(/greater than or equal/)
    expect(validateDateWindow('2030-01-15T15:00:00Z', '2030-01-15T14:00:00Z')).toMatch(/greater than or equal/)
    expect(validateDateWindow('2030-01-15', '2030-01-15')).toBeNull()          // zero-length is allowed
    expect(validateDateWindow('2030-01-15', '2030-01-16')).toBeNull()
    expect(validateDateWindow('2030-01-15T15:00:00Z', '2030-01-15T17:00:00Z')).toBeNull()
  })
})

// ── Layer 2: real POST/PATCH round trips ──

describe('POST /api/v1/tasks — calendar dates', () => {
  it('creates a task with a start/end window; both ride back in the slim shape', async () => {
    const start = '2030-04-01T15:00:00.000Z'
    const end = '2030-04-01T17:00:00.000Z'
    const res = await postTask({ title: 'Deep work block', start_date: start, end_date: end })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.start_date).toBe(start)
    expect(task.end_date).toBe(end)

    // And they survive to the list read (the projection carries both).
    const list = await fetch(apiUrl('/api/v1/tasks'))
    const body = await list.json() as { tasks: Array<{ id: string; start_date?: string; end_date?: string }> }
    const found = body.tasks.find((t) => t.id === (task.id as string))
    expect(found?.start_date).toBe(start)
    expect(found?.end_date).toBe(end)
  })

  it('start_date alone is fine (day precision, no end)', async () => {
    const res = await postTask({ title: 'Starts that day', start_date: '2030-04-02' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.start_date).toBe('2030-04-02')
    expect(task.end_date).toBeUndefined()
  })

  it('clear markers on create mean "no date", not an error', async () => {
    for (const body of [
      { title: 'Empty strings', start_date: '', end_date: '' },
      { title: 'Nulls', start_date: null, end_date: null },
    ]) {
      const res = await postTask(body)
      expect(res.status, JSON.stringify(body)).toBe(201)
      const { task } = await res.json() as { task: Record<string, unknown> }
      expect(task.start_date).toBeUndefined()
      expect(task.end_date).toBeUndefined()
    }
  })

  it('400 bad_request for an unparseable start_date / end_date', async () => {
    for (const field of ['start_date', 'end_date'] as const) {
      for (const value of ['not-a-date', 12345, {}, '12345', '2030-13-99', '2030/01/15', '2030-02-30']) {
        const res = await postTask({ title: 'date check', start_date: '2030-04-01', [field]: value })
        expect(res.status, `${field}=${JSON.stringify(value)}`).toBe(400)
        const json = await res.json() as { error: { code: string; message: string } }
        expect(json.error.code).toBe('bad_request')
        expect(json.error.message).toContain(field)
      }
    }
  })

  it('400 bad_request for end_date before start_date, and for end_date with no start_date', async () => {
    const backwards = await postTask({
      title: 'Backwards window', start_date: '2030-04-05T17:00:00Z', end_date: '2030-04-05T15:00:00Z',
    })
    expect(backwards.status).toBe(400)
    expect((await backwards.json() as { error: { message: string } }).error.message)
      .toMatch(/greater than or equal/)

    const orphan = await postTask({ title: 'Orphan end', end_date: '2030-04-05' })
    expect(orphan.status).toBe(400)
    expect((await orphan.json() as { error: { message: string } }).error.message)
      .toMatch(/requires a start_date/)
  })
})

describe('PATCH /api/v1/tasks/:id — calendar dates', () => {
  it('sets both halves in one call', async () => {
    const task = await createTask({ title: 'Schedule me' })
    const res = await patchTask(task.id, {
      start_date: '2030-05-10T09:00:00.000Z', end_date: '2030-05-10T11:00:00.000Z',
    })
    expect(res.status).toBe(200)
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated.start_date).toBe('2030-05-10T09:00:00.000Z')
    expect(updated.end_date).toBe('2030-05-10T11:00:00.000Z')
  })

  it('extends only the end of an existing window (the calendar resize gesture)', async () => {
    const task = await createTask({
      title: 'Resize me', start_date: '2030-05-11T09:00:00.000Z', end_date: '2030-05-11T10:00:00.000Z',
    })
    const res = await patchTask(task.id, { end_date: '2030-05-11T12:00:00.000Z' })
    expect(res.status).toBe(200)
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated.start_date).toBe('2030-05-11T09:00:00.000Z') // untouched
    expect(updated.end_date).toBe('2030-05-11T12:00:00.000Z')
  })

  it('"" and null both clear end_date', async () => {
    for (const clear of ['', null]) {
      const task = await createTask({
        title: `Clear end ${String(clear)}`,
        start_date: '2030-05-12T09:00:00.000Z', end_date: '2030-05-12T10:00:00.000Z',
      })
      const res = await patchTask(task.id, { end_date: clear })
      expect(res.status, JSON.stringify(clear)).toBe(200)
      const { task: updated } = await res.json() as { task: Record<string, unknown> }
      expect(updated.end_date).toBeUndefined()
      expect(updated.start_date).toBe('2030-05-12T09:00:00.000Z')
    }
  })

  it('clearing start_date cascades the end clear — never leaves an orphan end', async () => {
    const task = await createTask({
      title: 'Off the calendar',
      start_date: '2030-05-13T09:00:00.000Z', end_date: '2030-05-13T10:00:00.000Z',
    })
    const res = await patchTask(task.id, { start_date: '' })
    expect(res.status).toBe(200)
    const { task: updated } = await res.json() as { task: Record<string, unknown> }
    expect(updated.start_date).toBeUndefined()
    expect(updated.end_date).toBeUndefined()
  })

  it('400 when the EFFECTIVE window is backwards (request judged against the stored row)', async () => {
    // Only end_date is in the body, so the guard has to read the stored start.
    const task = await createTask({ title: 'Effective window', start_date: '2030-05-14T15:00:00.000Z' })
    const res = await patchTask(task.id, { end_date: '2030-05-14T13:00:00.000Z' })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string; message: string } }
    expect(json.error.code).toBe('bad_request')
    expect(json.error.message).toMatch(/greater than or equal/)

    // Nothing was applied.
    const list = await fetch(apiUrl('/api/v1/tasks'))
    const body = await list.json() as { tasks: Array<{ id: string; end_date?: string }> }
    expect(body.tasks.find((t) => t.id === task.id)?.end_date).toBeUndefined()
  })

  it('400 for end_date on a task with no start_date', async () => {
    const task = await createTask({ title: 'No start at all' })
    const res = await patchTask(task.id, { end_date: '2030-05-15' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { message: string } }).error.message)
      .toMatch(/requires a start_date/)
  })

  it('400 for an unparseable end_date; 404 for an unknown id', async () => {
    const task = await createTask({ title: 'Bad end value', start_date: '2030-05-16' })
    const bad = await patchTask(task.id, { end_date: '2030-02-30' })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: { message: string } }).error.message).toContain('end_date')

    const unknown = await patchTask('task-does-not-exist', { start_date: '2030-05-16' })
    expect(unknown.status).toBe(404)
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe('not_found')
  })
})
