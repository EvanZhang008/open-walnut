/**
 * A session completing its OWN task while a request to it is still unanswered is refused, naming
 * the request, through every route a session can close by (src/core/sessions/requests-held.ts
 * admitHeldRequests, called by admitSessionClose).
 *
 * 2026-11-18, the Walnut VP: its request reached a task's session at 23:46:35Z, and 2 s later that
 * session called task_complete without having read it. The request arrived before the close, so
 * nothing reopened the task; it stayed COMPLETE while it went on with the next stage.
 *
 * The repro is that: the lead's real send (POST /api/v1/messages, expect_reply) to a worker whose
 * turn is running, then the worker's own close 2 s later. Every route answers 409
 * unanswered_request (a batch names it per task), nothing is written, the phase is kept; once the
 * worker answers (in_reply_to), the same close completes it. A request handed on, one from an asker
 * whose task is closed, and a person's close are never held. Only the Claude CLI is absent; session
 * records are written directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-held-request-close'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, deleteSessionRecords, updateSessionRecord } from '../../src/core/session-tracker.js'
import { createSessionRequest, getSessionRequest, settleNotified } from '../../src/core/session-requests.js'
import type { Task } from '../../src/core/types.js'

let server: HttpServer
let base: string
let n = 0

const json = (method: string, url: string, body: unknown, sid?: string) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
  body: JSON.stringify(body),
})

type Route = { name: string; close: (t: Task, sid?: string) => Promise<Response> }
const ROUTES: Route[] = [
  { name: 'v1 POST complete', close: (t, sid) => json('POST', `/api/v1/tasks/${t.id}/complete`, { result: 'Stage one shipped.' }, sid) },
  { name: 'v1 PATCH phase', close: (t, sid) => json('PATCH', `/api/v1/tasks/${t.id}`, { phase: 'COMPLETE' }, sid) },
  { name: 'v1 PATCH status done', close: (t, sid) => json('PATCH', `/api/v1/tasks/${t.id}`, { status: 'done' }, sid) },
  { name: 'v1 batch phase', close: (t, sid) => json('POST', '/api/v1/tasks/batch/phase', { task_ids: [t.id], phase: 'COMPLETE' }, sid) },
  { name: 'PATCH phase', close: (t, sid) => json('PATCH', `/api/tasks/${t.id}`, { phase: 'COMPLETE' }, sid) },
  { name: 'POST complete', close: (t, sid) => json('POST', `/api/tasks/${t.id}/complete`, { result: 'Stage one shipped.' }, sid) },
  { name: 'toggle complete', close: (t, sid) => json('POST', `/api/tasks/${t.id}/toggle-complete`, {}, sid) },
  { name: 'batch phase', close: (t, sid) => json('POST', '/api/tasks/batch/phase', { task_ids: [t.id], phase: 'COMPLETE' }, sid) },
]

async function withSession(title: string, status: 'idle' | 'running'): Promise<{ task: Task; sid: string }> {
  const task = (await addTask({ title: `${title} ${++n}`, project: 'Held' })).task
  const sid = `sess-held-${n}`
  await createSessionRecord(sid, task.id, 'Held')
  await updateSessionRecord(sid, { process_status: status })
  await updateTaskRaw(task.id, { session_id: sid } as never, { emitEvent: true })
  await updateTask(task.id, { phase: 'IN_PROGRESS' })
  return { task: await getTask(task.id), sid }
}

/** The lead's real ask to the worker; resolves to its request id. */
async function ask(lead: { sid: string }, worker: Task, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await json('POST', '/api/v1/messages', { to: worker.id, text, expect_reply: true, ...extra }, lead.sid)
  expect(res.status, await res.clone().text()).toBe(202)
  const body = await res.json() as { requestId?: string }
  expect(body.requestId).toMatch(/^rq-/)
  return body.requestId!
}

async function refusedNaming(route: Route, res: Response, rq: string): Promise<void> {
  const body = await res.json() as { code?: string; message?: string; items?: { id: string }[]; failed?: { error: string }[] }
  if (route.name.includes('batch')) {
    expect(body.failed?.[0]?.error ?? '', JSON.stringify(body)).toMatch(/^unanswered_request:/)
    expect(body.failed?.[0]?.error).toContain(rq)
  } else {
    expect(res.status, JSON.stringify(body)).toBe(409)
    expect(JSON.stringify(body)).toContain('unanswered_request')
    expect(JSON.stringify(body)).toContain(rq)
    expect(body.items?.map((i) => i.id)).toEqual([rq])
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('its own session completing a task that holds an unanswered request', () => {
  for (const [i, route] of ROUTES.entries()) {
    it(`${route.name}: the lead's ask lands, the worker closes ${i ? 'at once' : '2 s later'} unread: refused naming it; answered, the close goes through`, async () => {
      const lead = await withSession('Lead', 'idle')
      const { task, sid } = await withSession('Worker', 'running')
      const rq = await ask(lead, task, 'Stage two: port the fix to the phone app, then reply.')
      // The incident's timing once; no turn ends here (no CLI), so the other routes need no wait.
      if (i === 0) await new Promise((r) => setTimeout(r, 2_000))
      const before = (await getTask(task.id)).phase
      await refusedNaming(route, await route.close(task, sid), rq)
      const kept = await getTask(task.id)
      expect(kept.phase).not.toBe('COMPLETE')
      expect(kept.phase).toBe(before)
      expect(kept.result_report).toBeUndefined()

      const reply = await json('POST', '/api/v1/messages', { in_reply_to: rq, title: 'Stage two queued', text: 'Starting stage two now.' }, sid)
      expect(reply.status, await reply.clone().text()).toBeLessThan(300)
      expect((await getSessionRequest(rq))?.status).toBe('replied')
      const again = await route.close(kept, sid)
      expect(again.status, await again.clone().text()).toBe(200)
      const body = await again.json() as { failed?: unknown[] }
      expect(body.failed ?? []).toEqual([])
      expect((await getTask(task.id)).phase).toBe('COMPLETE')
    }, 60_000)
  }

  it('the refusal tells the session how to answer and that the message was not read yet', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task, sid } = await withSession('Worker', 'running')
    const rq = await ask(lead, task, 'Stage two: port the fix to the phone app, then reply.')
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Stage one shipped.' }, sid)
    expect(res.status).toBe(409)
    const body = await res.json() as { message?: string; error?: string | { message?: string } }
    const message = body.message ?? (typeof body.error === 'object' ? body.error.message : body.error) ?? ''
    expect(message).toContain(`"in_reply_to":"${rq}"`)
    expect(message).toContain('Stage two: port the fix')
    expect(message).toContain('not read yet')
    expect(message).toContain(`"Lead ${n - 1}"`)
  }, 60_000)

  it('a request handed on to another task does not hold the close', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task, sid } = await withSession('Worker', 'idle')
    const helper = await withSession('Helper', 'idle')
    const rq = await ask(lead, task, 'Find out why the build broke and reply.')
    await ask({ sid }, helper.task, 'Please find out why the build broke.', { hands_on: rq })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Handed the build question on.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  }, 60_000)

  it('the ask that started its session is its brief: the close answers it; one sent on top of it still holds', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task, sid } = await withSession('Worker', 'running')
    // What task-start.ts writes for the message a session starts with.
    const brief = await createSessionRequest({ fromSessionId: lead.sid, toSessionId: sid, toTaskId: task.id, text: 'Ship stage one.', kind: 'start' })
    expect(brief.opensSession).toBe(true)
    const done = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Stage one shipped.' }, sid)
    expect(done.status, await done.clone().text()).toBe(200)

    const next = await withSession('Worker', 'running')
    await createSessionRequest({ fromSessionId: lead.sid, toSessionId: next.sid, toTaskId: next.task.id, text: 'Ship stage one.', kind: 'start' })
    const rq = await ask(lead, next.task, 'Also stage two, then reply.')
    await refusedNaming(ROUTES[0], await ROUTES[0].close(next.task, next.sid), rq)
  }, 60_000)

  it('a request whose asker is gone holds nothing: no reply could reach it', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task, sid } = await withSession('Worker', 'idle')
    await ask(lead, task, 'Tell me when the export runs.')
    await deleteSessionRecords(new Set([lead.sid]), 'test: the asker session is gone')
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Export runs.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  }, 60_000)

  it('a request handed on whose taker stopped without an answer is owed again, and holds the close', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task, sid } = await withSession('Worker', 'idle')
    const helper = await withSession('Helper', 'idle')
    const rq = await ask(lead, task, 'Find out why the build broke and reply.')
    const handed = await ask({ sid }, helper.task, 'Please find out why the build broke.', { hands_on: rq })
    await settleNotified(handed, 'completed')
    await refusedNaming(ROUTES[0], await ROUTES[0].close(task, sid), rq)
  }, 60_000)

  it('a request from an asker whose task is closed does not hold the close', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task, sid } = await withSession('Worker', 'idle')
    await ask(lead, task, 'Tell me when the export runs.')
    await updateTask(lead.task.id, { phase: 'COMPLETE' })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Export runs.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  }, 60_000)

  it('a person closing the task is never held by it', async () => {
    const lead = await withSession('Lead', 'idle')
    const { task } = await withSession('Worker', 'idle')
    await ask(lead, task, 'Tell me when the export runs.')
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Closed by hand.' })
    expect(res.status, await res.clone().text()).toBe(200)
  }, 60_000)
})
