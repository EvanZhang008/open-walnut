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
 * side-questions store → task-manager. The model layer is stubbed so promote's
 * background folder/title labeling stays offline and deterministic.
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
// Deterministic, offline model: promote groups the new task with the parent's,
// and a fresh folder asks the model for a name in the background.
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Reaper Work' }],
    stopReason: 'end_turn',
  })),
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

  it('warms the standby cache on demand: one tagged send, then already_warm', async () => {
    const { CACHE_WARMUP_MESSAGE } = await import('../../src/core/sessions/side-thread-warmup.js')
    const warmParent = '77777777-7777-4777-8777-777777777777'
    await createSessionRecord(warmParent, '', 'proj', '/repo/walnut', {
      outputFile: '/tmp/streams/warm.jsonl',
    })
    // Subscribers are keyed by name: a second 'session-runner' would REPLACE the
    // fake runner above, so observe the send as a global listener instead.
    const sends: Array<{ sessionId: string; message: string }> = []
    bus.subscribe('warm-send-observer', (event: BusEvent) => {
      if (event.name !== EventNames.SESSION_SEND) return
      const d = event.data as { sessionId: string; message: string }
      sends.push({ sessionId: d.sessionId, message: d.message })
    }, { global: true, interest: [EventNames.SESSION_SEND] })

    // Nothing to warm before the drawer has prewarmed a standby.
    let res = await post(`/api/sessions/${warmParent}/side-threads/standby/warm`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ warmed: false, reason: 'no_standby' })

    // The prewarm route answers before the fork lands (fire-and-forget spawn).
    await post(`/api/sessions/${warmParent}/side-threads/standby`)
    let standby: SessionStartEvent | undefined
    for (let i = 0; i < 100 && !standby; i++) {
      standby = started.find((s) => s.lane === `side:${warmParent}:standby`)
      if (!standby) await new Promise((r) => setTimeout(r, 20))
    }
    expect(standby?.preassignedSessionId).toBeTruthy()

    res = await post(`/api/sessions/${warmParent}/side-threads/standby/warm`)
    expect(await res.json()).toEqual({ warmed: true })
    expect(sends).toEqual([{ sessionId: standby!.preassignedSessionId, message: CACHE_WARMUP_MESSAGE }])

    res = await post(`/api/sessions/${warmParent}/side-threads/standby/warm`)
    expect(await res.json()).toEqual({ warmed: true, reason: 'already_warm' })
    expect(sends).toHaveLength(1)
    bus.unsubscribe('warm-send-observer')
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

  it('sends attached images with the first turn but stores the plain question', async () => {
    // A real 1x1 PNG — processAndSaveImages decodes every image, so bogus bytes
    // would be dropped and the assertions below would pass for the wrong reason.
    const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DAAAADAAEAAQD3AAAAAElFTkSuQmCC'
    // Its own parent: PARENT may hold a prewarmed standby from the test above, and
    // a CONSUMED standby delivers the question through the send queue instead of
    // the spawn, which would make the message assertion order-dependent.
    const imgParent = '88888888-8888-4888-8888-888888888888'
    await createSessionRecord(imgParent, '', 'proj', '/repo/walnut', {
      outputFile: '/tmp/streams/img.jsonl',
    })
    const question = 'what is wrong with this screenshot?'

    const res = await post(`/api/sessions/${imgParent}/side-threads`, {
      question,
      images: [{ data: PNG_1X1, mediaType: 'image/png' }],
    })
    expect(res.status).toBe(200)
    const { thread } = await res.json() as { thread: { id: string; threadSessionId: string } }

    // The CLI gets the paths to Read, then the user's words.
    const spawn = started.find((s) => s.preassignedSessionId === thread.threadSessionId)
    expect(spawn?.message).toContain('Read this file')
    expect(spawn?.message.endsWith(question)).toBe(true)

    // The stored row does NOT: it is what the chip label and a promoted task read.
    const view = await (await fetch(apiUrl(`/api/sessions/${imgParent}/side-threads`)))
      .json() as { threads: Array<{ id: string; question?: string }> }
    expect(view.threads.find((t) => t.id === thread.id)?.question).toBe(question)
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

  it('promotes a thread into a SIBLING task in the parent task folder, and un-hides the session', async () => {
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
      taskId: string; siblingOfTaskId?: string; groupId?: string; sessionId: string
      parentTaskId?: string
    }
    expect(promoted.siblingOfTaskId).toBe(parentTask.task.id)
    expect(promoted.groupId).toBeTruthy()
    // parent_task_id semantics are gone from this route entirely.
    expect(promoted.parentTaskId).toBeUndefined()
    expect(promoted.sessionId).toBe(thread.threadSessionId)

    // The fork is now an ordinary session: task linked, lane gone.
    const record = await getSessionByClaudeId(thread.threadSessionId)
    expect(record?.taskId).toBe(promoted.taskId)
    expect(record?.lane).toBeUndefined()

    const taskRes = await fetch(apiUrl(`/api/tasks/${promoted.taskId}`))
    const { task } = await taskRes.json() as {
      task: {
        title: string; parent_task_id?: string; group_id?: string
        session_ids?: string[]; exec_session_id?: string
      }
    }
    // Fork naming: the thread's own label, then the origin it split off from.
    expect(task.title.startsWith('Split the reaper')).toBe(true)
    expect(task.title).toContain(' - fork of ')
    // A sibling, NOT a subtask: the two tasks have independent lifecycles.
    expect(task.parent_task_id).toBeUndefined()
    const sourceRes = await fetch(apiUrl(`/api/tasks/${parentTask.task.id}`))
    const { task: sourceTask } = await sourceRes.json() as { task: { group_id?: string } }
    expect(task.group_id).toBeTruthy()
    expect(sourceTask.group_id).toBe(task.group_id)
    expect(task.group_id).toBe(promoted.groupId)
    expect(task.session_ids ?? []).toContain(thread.threadSessionId)
    expect(task.exec_session_id).toBe(thread.threadSessionId)
    // The session's own title follows the task it now belongs to.
    expect(record?.title).toBe(task.title)

    // Promoted → the store entry records the task.
    const view = await (await fetch(apiUrl(`/api/sessions/${taskedParent}/side-threads`)))
      .json() as { threads: Array<{ id: string; promotedTaskId?: string }> }
    expect(view.threads.find((t) => t.id === thread.id)?.promotedTaskId).toBe(promoted.taskId)
  })

  it('promotes a thread on a TASKLESS parent into a top-level task with no folder', async () => {
    const adHocParent = '88888888-8888-4888-8888-888888888888'
    await createSessionRecord(adHocParent, '', 'proj', '/repo/walnut', {
      outputFile: '/tmp/streams/adhoc.jsonl',
    })

    const { thread } = await (await post(`/api/sessions/${adHocParent}/side-threads`, {
      question: 'is the pipe ever reopened?',
    })).json() as { thread: { id: string; threadSessionId: string } }

    const promoteRes = await post(
      `/api/sessions/${adHocParent}/side-threads/${thread.id}/promote`,
      { title: 'Pipe reopen check' },
    )
    expect(promoteRes.status).toBe(200)
    const promoted = await promoteRes.json() as {
      taskId: string; siblingOfTaskId?: string; groupId?: string
    }
    // Nothing to be a sibling of, so no fork decoration and no folder.
    expect(promoted.siblingOfTaskId).toBeUndefined()
    expect(promoted.groupId).toBeUndefined()

    const { task } = await (await fetch(apiUrl(`/api/tasks/${promoted.taskId}`)))
      .json() as { task: { title: string; parent_task_id?: string; group_id?: string } }
    expect(task.title).toBe('Pipe reopen check')
    expect(task.parent_task_id).toBeUndefined()
    expect(task.group_id).toBeUndefined()
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
