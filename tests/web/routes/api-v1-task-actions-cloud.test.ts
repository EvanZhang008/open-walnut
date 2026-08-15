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

/** Poll the offline queue until an op matching the predicate lands (dispatch is
 *  fire-and-forget off the bus). */
async function waitForOp(
  predicate: (op: { type: string; id?: string; task?: { id: string } }) => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const names = (await fs.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json'))
      for (const name of names) {
        const op = JSON.parse(await fs.readFile(path.join(TASK_QUEUE_DIR, name), 'utf-8'))
        if (predicate(op)) return true
      }
    } catch { /* dir not created yet */ }
    if (Date.now() > deadline) return false
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
  it('PATCH /v1/tasks/:id → 200 + update op queued (bridge down)', async () => {
    const { task } = await addTask({ title: 'Cloud patch target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ title: 'Cloud patched' }),
    })
    expect(res.status).toBe(200)
    expect(await waitForOp((op) => op.type === 'update' && op.task?.id === task.id)).toBe(true)
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
    expect(await waitForOp((op) => op.type === 'delete' && op.id === task.id)).toBe(true)
  })

  // The whole point of Phase 4: a plain bridge outage must NOT put anything
  // back into the git data repo (the legacy git file is written ONLY for the
  // needs_upgrade case — see tests/core/task-queue.test.ts).
  it('never writes into the git tasks/outbox on a plain bridge outage', async () => {
    const names = await fs.readdir(OUTBOX_DIR).catch(() => [] as string[])
    expect(names.filter((n) => n.endsWith('.json'))).toEqual([])
  })
})
