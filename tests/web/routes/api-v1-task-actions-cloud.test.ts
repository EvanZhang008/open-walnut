/**
 * Wave-1 task mutations — CLOUD_MODE (REPLICA) behavior, Class A. The
 * replica has a real local task store; every v1 task mutation emits a TASK_*
 * bus event that the cloud outbox subscriber (server.ts cloud branch) turns
 * into an op file riding git-sync back to the primary. Verifies the two
 * outbox op kinds the new endpoints produce: star → update op, delete →
 * delete op. Real startServer (the outbox subscriber only registers there),
 * device Bearer auth (no LAN bypass in cloud mode) — same harness as
 * api-v1-task-create-cloud.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskactions-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASKS_DIR } from '../../../src/constants.js'
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

/** Poll the outbox until an op matching the predicate lands (fire-and-forget drop). */
async function waitForOp(
  predicate: (op: { type: string; id?: string; task?: { id: string } }) => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const names = (await fs.readdir(OUTBOX_DIR)).filter((n) => n.endsWith('.json'))
      for (const name of names) {
        const op = JSON.parse(await fs.readFile(path.join(OUTBOX_DIR, name), 'utf-8'))
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

describe('Wave-1 task mutations ride the outbox on a REPLICA', () => {
  it('POST /v1/tasks/:id/star → 200 + update op in the outbox', async () => {
    const { task } = await addTask({ title: 'Cloud star target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}/star`), {
      method: 'POST', headers: authHeaders(),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { starred: boolean }
    expect(body.starred).toBe(true)
    expect(await waitForOp((op) => op.type === 'update' && op.task?.id === task.id)).toBe(true)
  })

  it('DELETE /v1/tasks/:id → 204 + delete op in the outbox', async () => {
    const { task } = await addTask({ title: 'Cloud delete target' })
    const res = await fetch(apiUrl(`/api/v1/tasks/${task.id}`), {
      method: 'DELETE', headers: authHeaders(),
    })
    expect(res.status).toBe(204)
    expect(await waitForOp((op) => op.type === 'delete' && op.id === task.id)).toBe(true)
  })
})
