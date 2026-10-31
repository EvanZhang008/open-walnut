/**
 * A VP follows its project's top-level tasks the way a leader follows its workers, on a real
 * server (src/core/sessions/org-follow.ts, status-riding.ts, task-watch.ts):
 *   - a top-level task handed back: the subtask-notice envelope, worded for a follower, rides the
 *     VP's next message (never a queue row of its own), one item per task with its status line inside;
 *   - its completion does too, and a later message carries nothing again;
 *   - a worker under a leader is its leader's, never the VP's;
 *   - a VP that asked the task something hears the edge from its request's own notice, not twice;
 *   - a watch set over the API, refused on a completed task, and a watch that runs out on a task with
 *     no live session restarts quietly; a completion ends it.
 * Only the Claude CLI is mocked (no CLI runs: messages wait in the queue).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-follow'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { ridingKeys } from '../../src/core/sessions/status-riding.js'
import { runWatchPass, watchDueAt } from '../../src/core/sessions/task-watch.js'
import { createSessionRequest } from '../../src/core/session-requests.js'

const VP_SID = '55555555-6666-4777-8888-999999999999'
const TOP_SID = '66666666-7777-4888-9999-aaaaaaaaaaaa'
let base = ''
let vpId = ''
let topId = ''

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function put(id: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${id}/watch`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vpId = (await ensureProjectLead('Garden')).id
  await createSessionRecord(VP_SID, vpId, 'Garden', WALNUT_HOME)
  await updateSessionRecord(VP_SID, { process_status: 'idle' })
  topId = (await addTask({ title: 'Tune the cache', project: 'Garden' })).task.id
  await updateTaskRaw(topId, { phase: 'IN_PROGRESS' }, { emitEvent: true, source: 'test' })
  await createSessionRecord(TOP_SID, topId, 'Garden', WALNUT_HOME)
  await updateSessionRecord(TOP_SID, { process_status: 'idle' })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a VP follows its top-level tasks', () => {
  it('a hand-back rides the VP next message as one notice, never a row of its own', async () => {
    await updateTask(topId, { phase: 'NEED_ACTION' })
    await until('the notice rides the VP session', async () => ridingKeys(VP_SID).includes(topId))
    // Nothing went into the VP queue by itself.
    expect((await getQueue(VP_SID)).length).toBe(0)
    await sendMessageToSession(VP_SID, 'What moved?', { source: 'ui' } as never)
    const row = (await getQueue(VP_SID)).at(-1)!
    expect(row.message).toContain('A task you follow, "Tune the cache"')
    expect(row.message).not.toContain('Your subtask')
    expect(row.message.match(/about-task="[^"]+"/g)?.filter((m) => m.includes(topId))).toHaveLength(1)
    expect(row.message.endsWith('What moved?')).toBe(true)
    expect(ridingKeys(VP_SID)).not.toContain(topId)
  }, 30_000)

  it('a watch is set over the API; one on a task with no live session restarts quietly', async () => {
    const bad = await put(topId, { every: '2m' })
    expect(bad.status).toBe(400)
    const res = await put(topId, { every: '30m', for: vpId })
    expect(res.status).toBe(200)
    const body = await res.json() as { watch: { by: string; every_ms: number }; due_at: string }
    expect(body.watch).toMatchObject({ by: vpId, every_ms: 30 * 60_000 })
    const got = await (await fetch(`${base}/api/v1/tasks/${topId}/watch`)).json() as { due_at: string }
    expect(got.due_at).toBe(body.due_at)
    // A person with no `for`: the VP that follows the task hears it.
    expect(((await (await put(topId, { every: '1h' })).json()) as { watch: { by: string } }).watch.by).toBe(vpId)
    // Its session stopped: nothing to ask, the clock restarts.
    await updateSessionRecord(TOP_SID, { process_status: 'stopped' })
    const later = Date.now() + 2 * 60 * 60_000
    expect(await runWatchPass(later)).toEqual([])
    const after = await getTask(topId)
    expect(after.watch?.polled_at).toBe(new Date(later).toISOString())
    expect(watchDueAt(after)).toBe(later + 60 * 60_000)
  }, 30_000)

  it('its completion rides too, and the watch ends with it; a completed task takes no new watch', async () => {
    await updateSessionRecord(TOP_SID, { process_status: 'idle' })
    await updateTask(topId, { phase: 'COMPLETE' })
    await until('the completion rides the VP session', async () => ridingKeys(VP_SID).includes(topId))
    await sendMessageToSession(VP_SID, 'And now?', { source: 'ui' } as never)
    expect((await getQueue(VP_SID)).at(-1)!.message).toContain('completed its task')
    expect(watchDueAt(await getTask(topId))).toBeNull()
    expect((await put(topId, { every: '30m', for: vpId })).status).toBe(409)
  }, 30_000)

  it('a VP that asked the task hears its edge once, from the request\'s own notice', async () => {
    const asked = (await addTask({ title: 'Answer the VP', project: 'Garden' })).task.id
    const sid = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
    await updateTaskRaw(asked, { phase: 'IN_PROGRESS' }, { emitEvent: true, source: 'test' })
    await createSessionRecord(sid, asked, 'Garden', WALNUT_HOME)
    await updateSessionRecord(sid, { process_status: 'idle' })
    await createSessionRequest({ fromSessionId: VP_SID, toSessionId: sid, toTaskId: asked, text: 'Is it done?' })
    await updateTask(asked, { phase: 'NEED_ACTION' })
    await new Promise((r) => setTimeout(r, 1_500))
    expect(ridingKeys(VP_SID)).not.toContain(asked)
  }, 30_000)

  it('a worker under a leader is its leader\'s, never the VP\'s', async () => {
    const leader = (await addTask({ title: 'Ship the parser', project: 'Garden' })).task.id
    // Its leader has a session, so even its status lines stop there.
    await createSessionRecord('88888888-9999-4aaa-bbbb-cccccccccccc', leader, 'Garden', WALNUT_HOME)
    await updateSessionRecord('88888888-9999-4aaa-bbbb-cccccccccccc', { process_status: 'idle' })
    const worker = (await addTask({ title: 'Write the lexer', project: 'Garden', parent_task_id: leader } as never)).task.id
    await updateTaskRaw(worker, { phase: 'IN_PROGRESS', parent_task_id: leader }, { emitEvent: true, source: 'test' })
    await createSessionRecord('77777777-8888-4999-aaaa-bbbbbbbbbbbb', worker, 'Garden', WALNUT_HOME)
    await updateSessionRecord('77777777-8888-4999-aaaa-bbbbbbbbbbbb', { process_status: 'idle' })
    await updateTask(worker, { phase: 'NEED_ACTION' })
    await new Promise((r) => setTimeout(r, 1_500))
    expect(ridingKeys(VP_SID)).not.toContain(worker)
  }, 30_000)
})
