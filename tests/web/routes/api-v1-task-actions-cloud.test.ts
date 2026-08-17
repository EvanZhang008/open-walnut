/**
 * Wave-1 task mutations — CLOUD_MODE (REPLICA) behavior, Class A. The
 * replica has a real local task store; every v1 task mutation emits a TASK_*
 * bus event that the cloud dispatch subscriber (server.ts cloud branch) sends
 * to the primary over the `server.tasks.apply` bridge RPC. Verifies the two op
 * kinds the endpoints produce: PATCH → update op, delete → delete op.
 *
 * No bridge is registered in this harness, so every dispatch takes the
 * OFFLINE FALLBACK: the op lands in cache/task-queue/ (NON-git) instead of the
 * retired tasks/outbox/ git directory, and the phone still gets its optimistic
 * 200/204 because dispatch runs off the bus, after the response. That is the
 * exact behavior Phase 4 promises when the Mac is unreachable.
 *
 * Real startServer (the subscriber only registers there), device Bearer auth
 * (no LAN bypass in cloud mode) — same harness as api-v1-task-create-cloud.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskactions-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASKS_DIR, TASK_QUEUE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { addTask } from '../../../src/core/task-manager.js'

let server: HttpServer
let port: number
let deviceToken: string

const OUTBOX_DIR = path.join(TASKS_DIR, 'outbox')

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

interface QueuedOp {
  type: string
  id?: string
  task?: { id: string; [k: string]: unknown }
  touched?: string[]
  append?: { note?: string }
  project?: string
  taskIds?: string[]
}

/** Poll the offline queue until an op matching the predicate lands (dispatch is
 *  fire-and-forget off the bus). Returns the matched op (null on timeout). */
async function waitForOp(
  predicate: (op: QueuedOp) => boolean,
  timeoutMs = 3_000,
): Promise<QueuedOp | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const names = (await fs.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json'))
      for (const name of names) {
        const op = JSON.parse(await fs.readFile(path.join(TASK_QUEUE_DIR, name), 'utf-8')) as QueuedOp
        if (predicate(op)) return op
      }
    } catch { /* dir not created yet */ }
    if (Date.now() > deadline) return null
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
  const device = await createDevice('cloud-taskactions-test-phone')
  deviceToken = device.token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Wave-1 task mutations dispatch to the primary on a REPLICA', () => {
  it('PATCH /v1/tasks/:id → 200 + update op queued (bridge down) with touched scoping', async () => {
    const { task } = await addTask({ title: 'Cloud patch target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ title: 'Cloud patched' }),
    })
    expect(res.status).toBe(200)
    const op = await waitForOp((o) => o.type === 'update' && o.task?.id === task.id)
    expect(op).not.toBeNull()
    // The op names the fields this PATCH set, so the primary applies ONLY
    // those (a projection-blind '' description must never wipe the Mac's).
    expect(op!.touched).toContain('title')
    expect(op!.touched).not.toContain('description')
  })

  // The retired star endpoint stays mounted for the frozen contract: it answers
  // the documented shape with `starred: false` and writes NOTHING, so an older
  // iOS build's decoder keeps working instead of failing the request.
  it('POST /v1/tasks/:id/star → 200 { starred: false } and mutates nothing', async () => {
    const { task } = await addTask({ title: 'Cloud star no-op target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}/star`), {
      method: 'POST', headers: authHeaders(),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { starred: boolean; task: { id: string } }
    expect(body.starred).toBe(false)
    expect(body.task.id).toBe(task.id)
  })

  it('DELETE /v1/tasks/:id → 204 + delete op queued (bridge down)', async () => {
    const { task } = await addTask({ title: 'Cloud delete target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'DELETE', headers: authHeaders(),
    })
    expect(res.status).toBe(204)
    expect(await waitForOp((op) => op.type === 'delete' && op.id === task.id)).not.toBeNull()
    // The deleted row must not reappear in the list from a stale projection echo.
    const list = await fetch(apiUrl('/api/v1/tasks'), { headers: authHeaders() })
    const body = await list.json() as { tasks: Array<{ id: string }> }
    expect(body.tasks.some((t) => t.id === task.id)).toBe(false)
  })

  it('GET /v1/tasks reflects a local write IMMEDIATELY (no waiting for the echo)', async () => {
    const { task } = await addTask({ title: 'Immediate visibility' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ title: 'Visible right away' }),
    })
    expect(res.status).toBe(200)
    const list = await fetch(apiUrl('/api/v1/tasks'), { headers: authHeaders() })
    expect(list.status).toBe(200)
    const body = await list.json() as { tasks: Array<{ id: string; title: string }> }
    expect(body.tasks.find((t) => t.id === task.id)?.title).toBe('Visible right away')
  })

  it('POST /v1/tasks/:id/notes → 200 + APPEND-style op (primary concatenates)', async () => {
    const { task } = await addTask({ title: 'Cloud note target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}/notes`), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ content: 'note from phone' }),
    })
    expect(res.status).toBe(200)
    const op = await waitForOp((o) => o.type === 'update' && o.task?.id === task.id && !!o.append)
    expect(op).not.toBeNull()
    expect(op!.append).toEqual({ note: 'note from phone' })
    expect(op!.touched).toContain('note')
  })

  it('PUT /v1/tasks/:id/description → 200 + description-scoped op', async () => {
    const { task } = await addTask({ title: 'Cloud description target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}/description`), {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content: 'full description' }),
    })
    expect(res.status).toBe(200)
    const op = await waitForOp((o) =>
      o.type === 'update' && o.task?.id === task.id && (o.touched ?? []).includes('description'))
    expect(op).not.toBeNull()
    expect(op!.task?.description).toBe('full description')
  })

  it('PUT /v1/tasks/:id/depends-on → 200 + depends_on-scoped op', async () => {
    const { task: dep } = await addTask({ title: 'Dependency' })
    const { task } = await addTask({ title: 'Dependent' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}/depends-on`), {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ depends_on: [dep.id] }),
    })
    expect(res.status).toBe(200)
    const op = await waitForOp((o) =>
      o.type === 'update' && o.task?.id === task.id && (o.touched ?? []).includes('depends_on'))
    expect(op).not.toBeNull()
    expect(op!.task?.depends_on).toEqual([dep.id])
  })

  it('POST /v1/tasks/:id/complete → 200 + phase-scoped op incl. the auto-unpin clears', async () => {
    const { task } = await addTask({ title: 'Cloud complete target' })
    const { togglePin } = await import('../../../src/core/task-manager.js')
    await togglePin(task.id)
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}/complete`), {
      method: 'POST', headers: authHeaders(),
    })
    expect(res.status).toBe(200)
    // The earlier togglePin also queued an op for this id — match the COMPLETE one.
    const op = await waitForOp((o) => o.type === 'update' && o.task?.id === task.id && o.task?.phase === 'COMPLETE')
    expect(op).not.toBeNull()
    expect(op!.touched).toEqual(expect.arrayContaining(['status', 'phase', 'pinned', 'pin_order', 'focus_tier']))
    expect(op!.task?.pinned).toBe(false)
  })

  it('POST /v1/tasks/batch/phase → 200 + one scoped op per changed task', async () => {
    const { task: t1 } = await addTask({ title: 'Batch A' })
    const { task: t2 } = await addTask({ title: 'Batch B' })
    const res = await fetch(apiUrl('/api/v1/tasks/batch/phase'), {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ task_ids: [t1.id, t2.id], phase: 'IN_PROGRESS' }),
    })
    expect(res.status).toBe(200)
    expect(await waitForOp((o) => o.type === 'update' && o.task?.id === t1.id)).not.toBeNull()
    expect(await waitForOp((o) => o.type === 'update' && o.task?.id === t2.id)).not.toBeNull()
  })

  it('POST /v1/tasks/batch/delete → 200 + one delete op per task', async () => {
    const { task: t1 } = await addTask({ title: 'Batch del A' })
    const { task: t2 } = await addTask({ title: 'Batch del B' })
    const res = await fetch(apiUrl('/api/v1/tasks/batch/delete'), {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ task_ids: [t1.id, t2.id] }),
    })
    expect(res.status).toBe(200)
    expect(await waitForOp((o) => o.type === 'delete' && o.id === t1.id)).not.toBeNull()
    expect(await waitForOp((o) => o.type === 'delete' && o.id === t2.id)).not.toBeNull()
  })

  it('PATCH /v1/tasks/reorder → 200 + a whole-project reorder op', async () => {
    const { task: r1 } = await addTask({ title: 'Order 1', project: 'CloudOrder' })
    const { task: r2 } = await addTask({ title: 'Order 2', project: 'CloudOrder' })
    const res = await fetch(apiUrl('/api/v1/tasks/reorder'), {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ project: 'CloudOrder', taskIds: [r2.id, r1.id] }),
    })
    expect(res.status).toBe(200)
    const op = await waitForOp((o) => o.type === 'reorder' && o.project === 'CloudOrder')
    expect(op).not.toBeNull()
    expect(op!.taskIds).toEqual([r2.id, r1.id])
  })

  it('focus pin → unpin → tier → pins-reorder all queue scoped/order ops', async () => {
    const { task } = await addTask({ title: 'Cloud focus target' })
    // Pin.
    let res = await fetch(apiUrl(`/api/v1/focus/tasks/${task.id}`), { method: 'POST', headers: authHeaders() })
    expect(res.status).toBe(200)
    const pinOp = await waitForOp((o) =>
      o.type === 'update' && o.task?.id === task.id && (o.touched ?? []).includes('pinned'))
    expect(pinOp).not.toBeNull()
    expect(pinOp!.task?.pinned).toBe(true)
    // Tier.
    res = await fetch(apiUrl(`/api/v1/focus/tasks/${task.id}/tier`), {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ tier: 'focus' }),
    })
    expect(res.status).toBe(200)
    expect(await waitForOp((o) =>
      o.type === 'update' && o.task?.id === task.id && (o.touched ?? []).includes('focus_tier')
      && o.task?.focus_tier === 'focus')).not.toBeNull()
    // Pins reorder.
    res = await fetch(apiUrl('/api/v1/focus/reorder'), {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ task_ids: [task.id] }),
    })
    expect(res.status).toBe(200)
    expect(await waitForOp((o) => o.type === 'reorder-pins')).not.toBeNull()
    // Unpin — the op must clear pin fields (absent from a touched snapshot).
    res = await fetch(apiUrl(`/api/v1/focus/tasks/${task.id}`), { method: 'DELETE', headers: authHeaders() })
    expect(res.status).toBe(200)
    const unpinOp = await waitForOp((o) =>
      o.type === 'update' && o.task?.id === task.id && o.task?.pinned === false)
    expect(unpinOp).not.toBeNull()
    expect(unpinOp!.touched).toEqual(expect.arrayContaining(['pinned', 'pin_order', 'focus_tier']))
  })

  // The whole point of Phase 4: a plain bridge outage must NOT put anything
  // back into the git data repo (the legacy git file is written ONLY for the
  // needs_upgrade case — see tests/core/task-queue.test.ts).
  it('never writes into the git tasks/outbox on a plain bridge outage', async () => {
    const names = await fs.readdir(OUTBOX_DIR).catch(() => [] as string[])
    expect(names.filter((n) => n.endsWith('.json'))).toEqual([])
  })
})
