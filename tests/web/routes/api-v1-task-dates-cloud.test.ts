/**
 * Calendar dates on a cloud REPLICA: the whole point of this file is that
 * `start_date` + `end_date` survive the trip back to the primary.
 *
 * A replica write lands in its local store and dispatches an op over the
 * `server.tasks.apply` bridge RPC; with no bridge registered here the dispatch
 * takes the durable-queue fallback, so the op file in cache/task-queue/ IS the
 * wire payload. Two things are asserted on it:
 *   - the snapshot carries both dates (an op that dropped them would silently
 *     lose the calendar block on the Mac),
 *   - `touched` names them, which is what makes the primary patch those exact
 *     columns (an unnamed field is never copied — see UPDATE_WHITELIST +
 *     `touched` scoping in task-outbox.ts).
 *
 * Harness mirrors api-v1-task-create-cloud.test.ts: real startServer with the
 * constants mock forcing CLOUD_MODE (the dispatch subscriber only registers in
 * startServer's cloud branch).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskdates-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASK_QUEUE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

type QueuedOp = {
  type: string
  touched?: string[]
  task: { id: string; start_date?: string; end_date?: string }
}

/** Dispatch is fire-and-forget off the bus — poll for an op matching a predicate. */
async function waitForOp(match: (op: QueuedOp) => boolean, timeoutMs = 3_000): Promise<QueuedOp> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let names: string[] = []
    try {
      names = (await fs.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort()
    } catch { /* dir not created yet */ }
    for (const name of names.reverse()) {
      try {
        const op = JSON.parse(await fs.readFile(path.join(TASK_QUEUE_DIR, name), 'utf-8')) as QueuedOp
        if (match(op)) return op
      } catch { /* mid-write — retry */ }
    }
    if (Date.now() > deadline) throw new Error('no matching op reached cache/task-queue/')
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('cloud-taskdates-test-phone')
  deviceToken = device.token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('calendar dates on a REPLICA', () => {
  it('POST /tasks with a window → 201, and the create op carries both dates', async () => {
    const start = '2030-06-01T09:00:00.000Z'
    const end = '2030-06-01T11:00:00.000Z'
    const res = await fetch(apiUrl('/api/v1/tasks'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Cloud calendar block', start_date: start, end_date: end }),
    })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.start_date).toBe(start)
    expect(task.end_date).toBe(end)

    const op = await waitForOp((o) => o.type === 'create' && o.task.id === task.id)
    expect(op.task.start_date).toBe(start)
    expect(op.task.end_date).toBe(end)
  })

  it('PATCH end_date → the update op names it in `touched` so the primary patches that column', async () => {
    const created = await fetch(apiUrl('/api/v1/tasks'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Cloud resize', start_date: '2030-06-02T09:00:00.000Z' }),
    })
    expect(created.status).toBe(201)
    const { task } = await created.json() as { task: { id: string } }

    const end = '2030-06-02T12:00:00.000Z'
    const patched = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ end_date: end }),
    })
    expect(patched.status).toBe(200)
    const { task: updated } = await patched.json() as { task: Record<string, unknown> }
    expect(updated.end_date).toBe(end)

    const op = await waitForOp((o) => o.type === 'update' && o.task.id === task.id
      && o.task.end_date === end)
    expect(op.touched).toContain('end_date')
    expect(op.task.start_date).toBe('2030-06-02T09:00:00.000Z')
  })

  it('a clear travels as a touched field ABSENT from the snapshot (the explicit-clear marker)', async () => {
    const created = await fetch(apiUrl('/api/v1/tasks'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        title: 'Cloud clear', start_date: '2030-06-03T09:00:00.000Z', end_date: '2030-06-03T10:00:00.000Z',
      }),
    })
    expect(created.status).toBe(201)
    const { task } = await created.json() as { task: { id: string } }

    const cleared = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ end_date: '' }),
    })
    expect(cleared.status).toBe(200)

    const op = await waitForOp((o) => o.type === 'update' && o.task.id === task.id
      && Array.isArray(o.touched) && o.touched.includes('end_date') && o.task.end_date === undefined)
    // The primary reads "touched but absent" as an explicit clear — that is how
    // the clear reaches the Mac at all (a snapshot can't carry an empty value).
    expect(op.task.end_date).toBeUndefined()
    expect(op.task.start_date).toBe('2030-06-03T09:00:00.000Z')
  })

  it('validation still runs on a replica — end_date before start_date is a 400', async () => {
    const res = await fetch(apiUrl('/api/v1/tasks'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        title: 'Cloud backwards', start_date: '2030-06-04T17:00:00Z', end_date: '2030-06-04T15:00:00Z',
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('bad_request')
  })
})
