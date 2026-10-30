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
import { writeProjectionCache } from '../../../src/core/projection-cache.js'
import { importProjectionOnCloud } from '../../../src/core/task-outbox.js'
import { getTask } from '../../../src/core/task-manager.js'

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

  it('a session the Mac\'s projections do not name is placed nothing, and there are no folders to file into', async () => {
    // A caller header the session projection does not know is not a worker.
    const res = await fetch(apiUrl('/api/v1/tasks'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json', 'x-walnut-caller-sid': '11111111-2222-3333-4444-555555555555' },
      body: JSON.stringify({ title: 'Asked from a session' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { placement: Record<string, unknown> }
    expect(body.placement.inherited_from).toBeUndefined()
    expect(body.placement.folder_created).toBe(false)
    // Folders are primary-only structure: an explicit one is a clear 501, not a
    // misleading "folder not found".
    const foldered = await postTask({ title: 'Into a folder', group_id: 'g_somewhere' })
    expect(foldered.status).toBe(501)
    expect((await foldered.json() as { error: { code: string } }).error.code).toBe('not_supported_cloud')
  })

  it('validation still runs on a replica — 400 for a missing title', async () => {
    const res = await postTask({})
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('bad_request')
  })
})

// 2026-10-15: while the Mac was away a lead's task_create reached the companion, which read
// every session caller as unknown, so its worker was born in the project the lead guessed
// from its repository, with no parent link. The companion reads the caller from the
// projections the Mac pushes and applies the same rules.
describe('a worker\'s create on the companion', () => {
  const LEAD = 'mleadcloud-0001'
  const SID = '22222222-3333-4444-5555-666666666601'
  const at = new Date().toISOString()

  async function seedLead(): Promise<void> {
    await writeProjectionCache('tasks', {
      version: 2, exportedAt: at,
      tasks: [{
        id: LEAD, title: 'Platform lead', status: 'todo', phase: 'IN_PROGRESS', priority: 'none',
        project: 'Lantern Ops', created_at: at, updated_at: at, pinned: true, focus_tier: 'focus',
      }],
    })
    await writeProjectionCache('sessions', {
      version: 1, exportedAt: at,
      sessions: [{
        id: SID, task_id: LEAD, task_title: 'Platform lead', project: 'Lantern Ops', group_id: 'g_rearch',
        group_label: 'Rearchitecture', host: 'devbox', process_status: 'running', started_at: at, last_active_at: at, message_count: 3,
      }],
    })
    await importProjectionOnCloud()
  }

  async function postAs(body: unknown): Promise<{ status: number; json: Record<string, any> }> {
    const res = await fetch(apiUrl('/api/v1/tasks'), {
      method: 'POST', headers: { ...authHeaders(), 'x-walnut-caller-sid': SID }, body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() as Record<string, any> }
  }

  it('naming a project the user did not name is refused and makes nothing', async () => {
    await seedLead()
    for (const body of [
      { title: 'Component tests first', project: 'Tide Pool' },
      { title: 'Component tests first', project: 'Tide Pool', project_reason: 'the scenarios live in the tide pool repository' },
    ]) {
      const r = await postAs(body)
      expect(r.status).toBe(409)
      expect(r.json.error.code).toBe('project_elsewhere')
      expect(r.json.error.message).toContain('"Platform lead" (mleadcloud-0001) is in project "Lantern Ops", folder "Rearchitecture"')
    }
  })

  it('omitting project files it in the lead\'s project as its subtask, and the op names the session for the Mac', async () => {
    await seedLead()
    const before = new Set(await fs.readdir(TASK_QUEUE_DIR).catch(() => [] as string[]))
    const r = await postAs({ title: 'Docs pass for the platform' })
    expect(r.status).toBe(201)
    expect(r.json.task.project).toBe('Lantern Ops')
    expect(r.json.placement.parent_task_id).toBe(LEAD)
    expect(r.json.placement.tier).toBe('focus')
    expect((await getTask(r.json.task.id)).parent_task_id).toBe(LEAD)
    // The companion holds no folders: the op carries the session so the Mac files it beside the lead.
    let op: { type: string; task: { id: string; parent_task_id?: string }; callerSid?: string } | undefined
    const deadline = Date.now() + 3_000
    while (!op && Date.now() < deadline) {
      for (const n of (await fs.readdir(TASK_QUEUE_DIR).catch(() => [] as string[])).filter((x) => x.endsWith('.json') && !before.has(x))) {
        const o = JSON.parse(await fs.readFile(path.join(TASK_QUEUE_DIR, n), 'utf-8'))
        if (o.type === 'create' && o.task?.id === r.json.task.id) op = o
      }
      if (!op) await new Promise((res) => setTimeout(res, 50))
    }
    expect(op?.callerSid).toBe(SID)
    expect(op?.task.parent_task_id).toBe(LEAD)
  })

  it('the user\'s words naming another project file it there, still as the lead\'s subtask', async () => {
    await seedLead()
    const r = await postAs({ title: 'Hub follow-up', project: 'Tide Pool', user_words: 'put this one under tide pool' })
    expect(r.status).toBe(201)
    expect(r.json.task.project).toBe('Tide Pool')
    expect(r.json.placement.parent_task_id).toBe(LEAD)
  })
})
