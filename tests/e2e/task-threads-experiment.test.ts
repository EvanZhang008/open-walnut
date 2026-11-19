/**
 * The experiment task_threads on a real server (2026-11-19, the user: "let's make all a thread,
 * thread auto open for all task"): switched on in the config, a task no one turned Threads on for
 * keeps them; its lines (user_status.lines) read as threads of its own for a client that asks
 * (`lines=1`), a line answers 409 to a stored thread's writes, and the switch off again is today's
 * behavior: no Threads, no lines kept for a one-line task.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-threads-experiment'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { threadsForEveryTask } from '../../src/core/org/keeps-threads.js'

let base = ''
let taskId = ''

/** Switched the way Settings does (PUT /api/config: written, then announced). */
async function flag(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { task_threads: on } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => expect(threadsForEveryTask()).toBe(on), { timeout: 5000 })
  await settleUserStatusSync()
  await syncUserStatuses(new Set([taskId]))
}
const get = (p: string) => fetch(`${base}/api/v1${p}`)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  taskId = (await addTask({ title: 'Order the seed trays', project: 'Orchard' })).task.id
  await updateTaskRaw(taskId, {
    phase: 'IN_PROGRESS',
    status_report: { state: 'needs', ask: 'Buy the 72-cell trays or the 128-cell ones?', at: new Date().toISOString() },
  } as never, { emitEvent: true })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the experiment task_threads', () => {
  it('off: a task no one turned Threads on for keeps none, and a one-line task keeps no lines', async () => {
    await flag(false)
    expect((await get(`/tasks/${taskId}/threads`)).status).toBe(409)
    expect((await getTask(taskId)).user_status?.lines).toBeUndefined()
  })

  it('on: the task keeps Threads, and its ask is a thread of its own for a client that asks', async () => {
    await flag(true)
    const status = (await getTask(taskId)).user_status
    expect(status?.state).toBe('needs')
    expect(status?.lines?.map((l) => [l.kind, l.state])).toEqual([['ask', 'needs']])
    const plain = await (await get(`/tasks/${taskId}/threads`)).json() as { threads: unknown[]; shown_count: number }
    expect(plain.threads).toEqual([])
    const withLines = await (await get(`/tasks/${taskId}/threads?lines=1`)).json() as { threads: Array<{ id: string; state: string; title: string; line?: { item?: string } }>; shown_count: number }
    expect(withLines.threads.map((t) => [t.state, t.title])).toEqual([['needs', 'Buy the 72-cell trays or the 128-cell ones?']])
    expect(withLines.shown_count).toBe(0)
    const id = withLines.threads[0].id
    expect(id.startsWith('line:')).toBe(true)
    expect(withLines.threads[0].line?.item).toBe(status?.actions?.[0]?.id)
    // One whole, and a stored thread's write refused with the way to answer it.
    expect((await get(`/tasks/${taskId}/threads/${encodeURIComponent(id)}`)).status).toBe(200)
    const patch = await fetch(`${base}/api/v1/tasks/${taskId}/threads/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'answered' }) })
    expect(patch.status).toBe(409)
    expect(((await patch.json()) as { error?: { code?: string } | string }).error).toMatchObject({ code: 'line_thread' })
  })

  it('on, turned off for the one task: it keeps none', async () => {
    const off = await fetch(`${base}/api/tasks/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threads_on: false }) })
    expect(off.status).toBe(200)
    expect((await getTask(taskId)).threads_on).toBe(false)
    expect((await get(`/tasks/${taskId}/threads`)).status).toBe(409)
  })
})
