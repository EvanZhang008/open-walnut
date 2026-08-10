/**
 * POST /api/v1/tasks — CLOUD_MODE (REPLICA) behavior. The cloud companion has
 * a real local task store (seeded by the projection import) and dispatches
 * every local mutation back to the primary over the `server.tasks.apply`
 * bridge RPC — the same path the web UI's task creation uses on cloud. So
 * creation answers 201 (not the old 503 not_supported_cloud): the task lands
 * in the local store and the TASK_CREATED bus emit reaches the dispatcher.
 *
 * This harness registers no bridge, so the dispatch takes the offline fallback
 * and the op is asserted in cache/task-queue/ (NON-git) rather than the retired
 * tasks/outbox/ git directory.
 *
 * Real startServer({ port: 0, dev: true }) with the constants mock forcing
 * CLOUD_MODE: true (same harness as api-v1-session-talk-cloud.test.ts) — the
 * dispatch subscriber only registers inside startServer's cloud branch, so a
 * bare express app would miss the very wiring this test exists to verify.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASK_QUEUE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// Cloud mode has no LAN bypass — every /api call needs a device Bearer token.
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

async function postTask(body: unknown): Promise<Response> {
  return fetch(apiUrl('/api/v1/tasks'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
}

/** Dispatch is fire-and-forget off the bus — poll briefly for the queued file. */
async function waitForQueuedOps(timeoutMs = 3_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const names = (await fs.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json'))
      if (names.length > 0) return names.sort()
    } catch { /* dir not created yet */ }
    if (Date.now() > deadline) return []
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
  const device = await createDevice('cloud-taskcreate-test-phone')
  deviceToken = device.token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('task creation on a REPLICA', () => {
  it('POST /tasks → 201, task in the local store, create op dispatched (queued while the bridge is down)', async () => {
    const res = await postTask({ title: 'Born on the cloud box', priority: 'important' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(typeof task.id).toBe('string')
    expect(task.title).toBe('Born on the cloud box')
    expect(task.priority).toBe('important')
    // Slim ProjectedTask shape, same as the primary branch.
    expect(task).not.toHaveProperty('note')
    expect(task).not.toHaveProperty('description')
    expect(task).not.toHaveProperty('session_ids')

    // The local replica store has the row (web REST reads the local store —
    // GET /api/v1/tasks serves the git-synced projection and lags by design).
    const full = await fetch(apiUrl(`/api/tasks/${task.id}`), { headers: authHeaders() })
    expect(full.status).toBe(200)
    const fullBody = await full.json() as { task: { title: string } }
    expect(fullBody.task.title).toBe('Born on the cloud box')

    // The TASK_CREATED emit reached the cloud dispatch subscriber. With no
    // bridge registered the RPC fails, so one 'create' op waits in the NON-git
    // queue for the next flush.
    const ops = await waitForQueuedOps()
    expect(ops.length).toBeGreaterThan(0)
    const op = JSON.parse(await fs.readFile(path.join(TASK_QUEUE_DIR, ops[ops.length - 1]), 'utf-8')) as {
      type: string
      task: { id: string; title: string }
    }
    expect(op.type).toBe('create')
    expect(op.task.id).toBe(task.id)
    expect(op.task.title).toBe('Born on the cloud box')
  })

  it('validation still runs on a replica — 400 for a missing title', async () => {
    const res = await postTask({})
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('bad_request')
  })
})
