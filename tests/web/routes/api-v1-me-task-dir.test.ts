/**
 * GET /api/v1/me/task-dir and the task_dir op: a session that started before
 * its daemon handed out task directories (no $WALNUT_TASK_DIR) gets its own
 * here, made on the spot (src/core/sessions/task-dir-place.ts).
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home; the caller is
 * a real session record on the local host. The task directory root is the test
 * runner's temp root (tests/setup/runtime-dir-isolation.ts), never the real one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-me-task-dir'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import '../../../src/ops/index.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`
const root = () => path.resolve(process.env.WALNUT_TASK_DIR_ROOT!)

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

describe('GET /api/v1/me/task-dir', () => {
  it('makes and names the calling task\'s directory, idempotently', async () => {
    const { task } = await addTask({ title: 'Ship the fix', project: 'Acme' })
    const sid = '33333333-4444-5555-6666-000000000001'
    await createSessionRecord(sid, task.id, 'Acme', '/repo/acme', { title: 'Ship the fix' })
    const first = await fetch(api('/api/v1/me/task-dir'), { headers: { 'x-walnut-caller-sid': sid } })
    expect(first.status).toBe(200)
    const body = await first.json() as { path: string; host: string; taskId: string }
    expect(body).toEqual({ path: path.join(root(), task.id), host: '__local__', taskId: task.id })
    expect(statSync(body.path).isDirectory()).toBe(true)
    expect(JSON.parse(readFileSync(path.join(body.path, '.walnut-task.json'), 'utf8'))).toMatchObject({ taskId: task.id, home: WALNUT_HOME })
    await fs.writeFile(path.join(body.path, 'kept.txt'), 'x')
    const again = await fetch(api('/api/v1/me/task-dir'), { headers: { 'x-walnut-caller-sid': sid } })
    expect((await again.json() as { path: string }).path).toBe(body.path)
    expect(existsSync(path.join(body.path, 'kept.txt'))).toBe(true)

    const r = await executeOp('task_dir', {}, { apiBase: `http://localhost:${port}`, callerSid: sid, origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const out = (r as { result: Record<string, unknown> }).result
    expect(out.path).toBe(body.path)
    expect(String(out.outcome)).toContain(`Your task directory is ${body.path}.`)
  })

  it('a caller with no task gets 404, never a directory', async () => {
    for (const headers of [{}, { 'x-walnut-caller-sid': 'not-a-session' }]) {
      const res = await fetch(api('/api/v1/me/task-dir'), { headers })
      expect(res.status).toBe(404)
    }
  })
})
