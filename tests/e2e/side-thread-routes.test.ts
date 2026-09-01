/**
 * E2E tests for the side-thread web routes through a real server
 * (startServer({port:0, dev:true})) — the same shape as side-question-routes.test.ts.
 *
 * SAFETY: after the server boots, the real 'session-runner' subscriber is
 * DISPLACED by a fake registered under the same name (the documented pattern —
 * see personal-ai-lane.test.ts), so a SESSION_START never spawns a `claude` CLI.
 * The fake only writes back the record state a spawn would leave. `terminateSession`
 * and `markExpectedTeardown` are stubbed, so nothing can signal a process.
 *
 * Everything else is real Walnut: routes → manager → fork → session-tracker →
 * side-questions store → task-manager.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

const mocks = vi.hoisted(() => ({
  terminateSession: vi.fn(async (sessionId: string) => ({ status: 'terminated' as const, sessionId })),
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-side-threads'))
vi.mock('../../src/core/sessions/session-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  terminateSession: mocks.terminateSession,
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { addTask } from '../../src/core/task-manager.js'
import type { SessionStartEvent } from '../../src/core/event-types.js'

let server: HttpServer
let port: number
let started: SessionStartEvent[] = []

const PARENT = '33333333-3333-4333-8333-333333333333'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/** Displaces the real runner: records the spawn, no process. */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name !== EventNames.SESSION_START) return
    const data = event.data as SessionStartEvent
    started.push(data)
    if (!data.preassignedSessionId) return
    void updateSessionRecord(data.preassignedSessionId, {
      process_status: 'idle',
      outputFile: `/tmp/streams/${data.preassignedSessionId}.jsonl`,
    }).catch(() => {})
  })
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  started = []
  mocks.terminateSession.mockClear()
  installFakeRunner()
  await createSessionRecord(PARENT, '', 'proj', '/repo/walnut', {
    title: 'Fix the FIFO stall',
    cliModel: 'opus[1m]',
    outputFile: '/tmp/streams/parent.jsonl',
  }).catch(() => {})
})

describe('side-thread routes', () => {
  it('answers the standby prewarm immediately without blocking on the spawn', async () => {
    const res = await post(`/api/sessions/${PARENT}/side-threads/standby`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('400s an empty question', async () => {
    const res = await post(`/api/sessions/${PARENT}/side-threads`, { question: '   ' })
    expect(res.status).toBe(400)
  })

  it('404s a thread on an unknown parent session', async () => {
    const res = await post('/api/sessions/44444444-4444-4444-8444-444444444444/side-threads', {
      question: 'hi',
    })
    expect(res.status).toBe(404)
  })

  it('creates a hidden, taskless thread and lists it', async () => {
    const res = await post(`/api/sessions/${PARENT}/side-threads`, {
      question: 'why does hasPipe go stale?', title: 'hasPipe',
    })
    expect(res.status).toBe(200)
    const { thread } = await res.json() as {
      thread: { id: string; threadSessionId: string; title?: string; createdAt: string }
    }
    expect(thread.id.startsWith('sth-')).toBe(true)
    expect(thread.title).toBe('hasPipe')

    const record = await getSessionByClaudeId(thread.threadSessionId)
    expect(record?.taskId).toBe('')
    expect(record?.lane).toBe(`side:${PARENT}:${thread.id}`)

    const listRes = await fetch(apiUrl(`/api/sessions/${PARENT}/side-threads`))
    const view = await listRes.json() as {
      threads: Array<{ id: string; archived: boolean }>; legacy: unknown[]
    }
    expect(view.threads.map((t) => t.id)).toContain(thread.id)
    expect(view.threads.find((t) => t.id === thread.id)?.archived).toBe(false)
    expect(view.legacy).toEqual([])

    // A hidden thread must not show up in the ordinary session list.
    const sessionsRes = await fetch(apiUrl('/api/sessions'))
    const body = await sessionsRes.json() as { sessions: Array<{ claudeSessionId: string }> }
    expect(body.sessions.map((s) => s.claudeSessionId)).not.toContain(thread.threadSessionId)
  })

  it('409s fork_unsupported for an engine without --fork-session', async () => {
    const codexSid = '55555555-5555-4555-8555-555555555555'
    await createSessionRecord(codexSid, '', 'proj', '/repo/walnut', {
      engine: 'codex', outputFile: '/tmp/streams/codex.jsonl',
    })
    const res = await post(`/api/sessions/${codexSid}/side-threads`, { question: 'q' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'fork_unsupported' })
  })

  it('promotes a thread into a SUBTASK and un-hides the session', async () => {
    const parentTask = await addTask({ title: 'parent task', category: 'Inbox' })
    const taskedParent = '66666666-6666-4666-8666-666666666666'
    await createSessionRecord(taskedParent, parentTask.task.id, 'proj', '/repo/walnut', {
      outputFile: '/tmp/streams/tasked.jsonl',
    })

    const { thread } = await (await post(`/api/sessions/${taskedParent}/side-threads`, {
      question: 'should we split the reaper?',
    })).json() as { thread: { id: string; threadSessionId: string } }

    const promoteRes = await post(
      `/api/sessions/${taskedParent}/side-threads/${thread.id}/promote`,
      { title: 'Split the reaper' },
    )
    expect(promoteRes.status).toBe(200)
    const promoted = await promoteRes.json() as {
      taskId: string; parentTaskId?: string; sessionId: string
    }
    expect(promoted.parentTaskId).toBe(parentTask.task.id)
    expect(promoted.sessionId).toBe(thread.threadSessionId)

    // The fork is now an ordinary session: task linked, lane gone.
    const record = await getSessionByClaudeId(thread.threadSessionId)
    expect(record?.taskId).toBe(promoted.taskId)
    expect(record?.lane).toBeUndefined()

    const taskRes = await fetch(apiUrl(`/api/tasks/${promoted.taskId}`))
    const { task } = await taskRes.json() as {
      task: { title: string; parent_task_id?: string; session_ids?: string[]; exec_session_id?: string }
    }
    expect(task.title).toBe('Split the reaper')
    expect(task.parent_task_id).toBe(parentTask.task.id)
    expect(task.session_ids ?? []).toContain(thread.threadSessionId)
    expect(task.exec_session_id).toBe(thread.threadSessionId)

    // Promoted → the store entry records the task, and it leaves the thread list.
    const view = await (await fetch(apiUrl(`/api/sessions/${taskedParent}/side-threads`)))
      .json() as { threads: Array<{ id: string; promotedTaskId?: string }> }
    expect(view.threads.find((t) => t.id === thread.id)?.promotedTaskId).toBe(promoted.taskId)
  })

  it('409s a SECOND promote of the same thread (one task, ever)', async () => {
    const doubleParent = '77777777-7777-4777-8777-777777777777'
    await createSessionRecord(doubleParent, '', 'proj', '/repo/walnut', {
      outputFile: '/tmp/streams/double.jsonl',
    })
    const { thread } = await (await post(`/api/sessions/${doubleParent}/side-threads`, {
      question: 'promote me twice?',
    })).json() as { thread: { id: string } }

    const first = await post(`/api/sessions/${doubleParent}/side-threads/${thread.id}/promote`, {})
    expect(first.status).toBe(200)
    const { taskId } = await first.json() as { taskId: string }

    const second = await post(`/api/sessions/${doubleParent}/side-threads/${thread.id}/promote`, {})
    expect(second.status).toBe(409)

    // Exactly ONE task exists for the thread — the 409 is what prevents a
    // duplicate that would orphan the first task's session link.
    const tasksRes = await fetch(apiUrl('/api/tasks'))
    const { tasks } = await tasksRes.json() as { tasks: Array<{ id: string; title: string }> }
    expect(tasks.filter((t) => t.title.includes('promote me twice')).map((t) => t.id)).toEqual([taskId])
  })

  it('deletes a thread (stop + archive + forget)', async () => {
    const { thread } = await (await post(`/api/sessions/${PARENT}/side-threads`, {
      question: 'delete me',
    })).json() as { thread: { id: string; threadSessionId: string } }

    const delRes = await fetch(apiUrl(`/api/sessions/${PARENT}/side-threads/${thread.id}`), {
      method: 'DELETE',
    })
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ ok: true })
    expect(mocks.terminateSession).toHaveBeenCalledWith(thread.threadSessionId, { force: true })
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBe(true)

    const view = await (await fetch(apiUrl(`/api/sessions/${PARENT}/side-threads`)))
      .json() as { threads: Array<{ id: string }> }
    expect(view.threads.map((t) => t.id)).not.toContain(thread.id)
  })

  it('404s deleting an unknown thread', async () => {
    const res = await fetch(apiUrl(`/api/sessions/${PARENT}/side-threads/sth-nope`), {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
  })
})
