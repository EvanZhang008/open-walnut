/**
 * The server-side brake on a session multiplying itself through Walnut tasks
 * (core/sessions/subtask-limits.ts): a subtask chain at most MAX_SUBTASK_DEPTH
 * deep. How many run at once is each host's (core/sessions/host-admission.ts,
 * tests/web/routes/start-queue.test.ts), never a lead's: 2026-11-05, the user:
 * "remove this we don't want this limitation".
 *
 * Why in the server: a prompt line saying "don't fan out" is one routine edit
 * from deletion, and a session whose subtasks file subtasks has no natural stop.
 * Only work a SESSION creates or starts is limited; the human never is.
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home and real session
 * records. No test here spawns a CLI: every start either is refused before the
 * spawn or goes through the exported check alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-subtask-limits'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, listTasks, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import * as limits from '../../../src/core/sessions/subtask-limits.js'
import { MAX_SUBTASK_DEPTH, SubtaskLimitError, assertSubtaskDepth, taskDepth } from '../../../src/core/sessions/subtask-limits.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

let seq = 0
async function sessionFor(taskId: string, project: string): Promise<string> {
  seq += 1
  const sid = `22222222-3333-4444-5555-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, taskId, project, `/repo/${project}`, { title: `Session ${seq}` })
  return sid
}

/** top → d1 → … → d<levels>, all in `project`; returns the ids, top first. */
async function chain(project: string, levels: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i <= levels; i++) {
    const { task } = await addTask({
      title: i === 0 ? `Top ${project}` : `Level ${i} ${project}`, project,
      ...(i > 0 ? { parent_task_id: ids[i - 1] } : {}),
    })
    ids.push(task.id)
  }
  return ids
}

async function children(parentId: string, phases: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const [i, phase] of phases.entries()) {
    const { task } = await addTask({ title: `Child ${i} of ${parentId}`, project: 'fanout', parent_task_id: parentId })
    if (phase !== 'TODO') await updateTaskRaw(task.id, { phase: phase as never })
    ids.push(task.id)
  }
  return ids
}

async function createAs(sid: string | undefined, body: Record<string, unknown>) {
  const res = await fetch(api('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

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

describe('subtask depth', () => {
  it('counts levels below the top-level task', async () => {
    const ids = await chain('depth-count', 3)
    expect(await Promise.all(ids.map(taskDepth))).toEqual([0, 1, 2, 3])
    expect(MAX_SUBTASK_DEPTH).toBe(3)
  })

  it('stops a walk through a parent loop instead of spinning', async () => {
    const [a, b] = await chain('depth-loop', 1)
    // A corrupted store: a's parent is its own child.
    await updateTaskRaw(a, { parent_task_id: b })
    const depth = await taskDepth(a)
    expect(depth).toBeGreaterThan(0)
    expect(depth).toBeLessThanOrEqual(MAX_SUBTASK_DEPTH + 2)
  })

  it('a session at the last allowed level can still file one level down', async () => {
    const ids = await chain('depth-ok', 2)
    const sid = await sessionFor(ids[2], 'depth-ok')

    const { status, json } = await createAs(sid, { title: 'Level 3 work' })

    expect(status).toBe(201)
    expect(json.placement.parent_task_id).toBe(ids[2])
    expect(await taskDepth(json.task.id)).toBe(3)
  })

  it('a session already at the cap is refused with 409 subtask_too_deep, and nothing is filed', async () => {
    const ids = await chain('depth-cap', 3)
    const sid = await sessionFor(ids[3], 'depth-cap')
    const before = (await listTasks({})).length

    const { status, json } = await createAs(sid, { title: 'One level too deep' })

    expect(status).toBe(409)
    expect(json.error.code).toBe('subtask_too_deep')
    expect(json.error.message).toContain(`"Level 3 depth-cap" (${ids[3]}) is already a subtask 3 levels deep`)
    expect(json.error.message).toContain('Do this part here with your own tools')
    expect((await listTasks({})).length).toBe(before)
    // Naming another project does not escape it: the new task is still its subtask.
    const elsewhere = await createAs(sid, { title: 'Elsewhere', project: 'other-place', user_words: 'file it under other-place' })
    expect(elsewhere.status).toBe(409)
    expect(elsewhere.json.error.code).toBe('subtask_too_deep')
  })

  it('never limits the human: a create with no caller files a fifth level', async () => {
    const ids = await chain('depth-human', 3)
    const res = await fetch(api('/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Human-made level 4', project: 'depth-human', parent_task_id: ids[3] }),
    })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: { id: string } }
    expect((await getTask(task.id)).parent_task_id).toBe(ids[3])
  })

  it('the check itself is a typed 409', async () => {
    const ids = await chain('depth-typed', 3)
    const err = await assertSubtaskDepth(ids[3]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubtaskLimitError)
    expect((err as SubtaskLimitError).statusCode).toBe(409)
    await expect(assertSubtaskDepth(ids[2])).resolves.toBeUndefined()
  })
})

describe('no lead cap', () => {
  // 2026-11-05: a VP's starts sat 81 minutes in the queue at positions 7 to 10, behind 16
  // running subtasks, while olddev, home-pc and two Macs were idle.
  it('the per-lead running cap is gone: nothing in subtask-limits counts running subtasks', () => {
    expect(Object.keys(limits).sort()).toEqual([
      'MAX_SUBTASK_DEPTH', 'MIN_USER_REQUEST_CHARS', 'SubtaskLimitError', 'assertAdoptionDepth', 'assertSubtaskDepth',
      'hasAncestor', 'subtreeHeight', 'taskDepth',
    ])
  })

  it('a worker session with 20 subtasks running files and starts a 21st at once (record_only aside, nothing waits on its lead)', async () => {
    const { task: parent } = await addTask({ title: 'Lead with many running', project: 'fanout' })
    await children(parent.id, Array(20).fill('IN_PROGRESS'))
    const sid = await sessionFor(parent.id, 'fanout')
    const made = await createAs(sid, { title: 'The 21st', project: 'fanout', record_only: true })
    expect(made.status).toBe(201)
    const id = made.json.task?.id ?? made.json.id
    const res = await fetch(api(`/api/v1/tasks/${id}/start`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': sid },
      body: JSON.stringify({ cwd: '/nonexistent-walnut-test-folder', expect_reply: false }),
    })
    const body = await res.json() as Record<string, any>
    // Not queued and not refused for running subtasks: it went on to the launch (whose folder is missing).
    expect(body.queued).toBeUndefined()
    expect(JSON.stringify(body)).not.toMatch(/too_many_running_subtasks|subtasks of .* are already running/)
  })
})
