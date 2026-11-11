/**
 * A session never starts work looser than its own mode, on every start route
 * (src/core/sessions/delegated-mode.ts capStartMode; every call site is listed by
 * tests/core/sessions/start-mode-ceiling-guard.test.ts). Through a REAL server: a Default-mode
 * session asks for Bypass through the web quick start, the phone's POST /api/v1/sessions and
 * an engine switch, and each is refused with a 403 before anything is made.
 *
 * Mocked: constants, the daemon (MockDaemon), the CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-start-mode-ceiling'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateTask } from '../../src/core/task-manager.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const SID = '6f0d7a52-3b8e-4c1f-9a2d-5e7b1c3d9f40'
let server: HttpServer
let port: number
let daemon: MockDaemon
let taskId: string

async function post(p: string, body: unknown, sid?: string, method = 'POST') {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function taskCount(): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`)
  const json = await res.json() as { tasks?: unknown[] }
  return (json.tasks ?? []).length
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  const r = await post('/api/tasks', { title: 'Default-mode worker', priority: 'none', project: 'Marina' })
  taskId = r.json.task.id
  await createSessionRecord(SID, taskId, 'Marina', WALNUT_HOME, { mode: 'default', initialProcessStatus: 'stopped' })
  await updateTask(taskId, { session_id: SID } as never)
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('a Default-mode session cannot start Bypass work', () => {
  it('the web quick start refuses it, and makes no task', async () => {
    const before = await taskCount()
    const r = await post('/api/sessions/quick-start', { message: 'run it', cwd: WALNUT_HOME, mode: 'bypass' }, SID)
    expect(r.status).toBe(403)
    expect(r.json.error).toContain('cannot start a task in bypass')
    expect(await taskCount()).toBe(before)
  })

  it('the phone launch route refuses it, and makes no task', async () => {
    const before = await taskCount()
    const r = await post('/api/v1/sessions', { message: 'run it', cwd: WALNUT_HOME, mode: 'bypass' }, SID)
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.json)).toContain('cannot start a task in bypass')
    expect(await taskCount()).toBe(before)
  })

  it('an engine switch of its own task to Bypass is refused', async () => {
    const r = await post(`/api/v1/tasks/${taskId}/switch-engine`, { engine: 'claude', model: 'sonnet', permission_mode: 'bypass' }, SID)
    expect(r.status, JSON.stringify(r.json)).toBe(403)
    expect(JSON.stringify(r.json)).toContain('mode_above_caller')
  })

  it('it cannot set its own session, or another, to Bypass on any mode route', async () => {
    for (const [path, body, method] of [
      [`/api/sessions/${SID}`, { mode: 'bypass' }, 'PATCH'],
      [`/api/v1/sessions/${SID}`, { mode: 'bypass' }, 'PATCH'],
      [`/api/sessions/${SID}/controls`, { id: 'mode', value: 'bypass' }, 'POST'],
      [`/api/v1/sessions/${SID}/controls`, { id: 'mode', value: 'bypass' }, 'POST'],
    ] as const) {
      const r = await post(path, body, SID, method)
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBe(403)
      expect(JSON.stringify(r.json)).toContain('cannot set a session to bypass')
    }
  })

  it('a stricter mode still goes through the check', async () => {
    const r = await post('/api/sessions/quick-start', { message: '', cwd: WALNUT_HOME, mode: 'plan' }, SID)
    expect(r.status).not.toBe(403)
  })
})
