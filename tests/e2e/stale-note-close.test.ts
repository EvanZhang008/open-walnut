/**
 * A session completing its own task while the task's note still reads as unfinished is asked once,
 * through every route a session can close by (src/core/sessions/owed-to-user.ts admitOwnNote,
 * src/core/sessions/stale-note.ts; 2026-11-11: COMPLETE tasks still said "[WIP] review is running"
 * and "[WAIT] next rule", and one buried a real "you decide").
 *
 * Every route: refused with 409 stale_note naming the lines, nothing written, the phase kept; the
 * same close again goes through. A person's close, another task's close, an updated note and a close
 * that brings its own not_done are never asked. Only the Claude CLI is absent; session records are
 * written directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-stale-note-close'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import type { Task } from '../../src/core/types.js'

let server: HttpServer
let base: string
let n = 0

const json = (method: string, url: string, body: unknown, sid?: string) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
  body: JSON.stringify(body),
})

type Route = { name: string; close: (t: Task, sid?: string, extra?: Record<string, unknown>) => Promise<Response> }
const ROUTES: Route[] = [
  { name: 'v1 POST complete', close: (t, sid, x) => json('POST', `/api/v1/tasks/${t.id}/complete`, { ...x }, sid) },
  { name: 'v1 PATCH phase', close: (t, sid, x) => json('PATCH', `/api/v1/tasks/${t.id}`, { phase: 'COMPLETE', ...x }, sid) },
  { name: 'v1 PATCH status done', close: (t, sid, x) => json('PATCH', `/api/v1/tasks/${t.id}`, { status: 'done', ...x }, sid) },
  { name: 'v1 batch phase', close: (t, sid) => json('POST', '/api/v1/tasks/batch/phase', { task_ids: [t.id], phase: 'COMPLETE' }, sid) },
  { name: 'PATCH phase', close: (t, sid, x) => json('PATCH', `/api/tasks/${t.id}`, { phase: 'COMPLETE', ...x }, sid) },
  { name: 'POST complete', close: (t, sid, x) => json('POST', `/api/tasks/${t.id}/complete`, { ...x }, sid) },
  { name: 'toggle complete', close: (t, sid, x) => json('POST', `/api/tasks/${t.id}/toggle-complete`, { ...x }, sid) },
  { name: 'batch phase', close: (t, sid) => json('POST', '/api/tasks/batch/phase', { task_ids: [t.id], phase: 'COMPLETE' }, sid) },
]

const STALE = `## Executive Summary
The hook now refuses commit and push in the shared checkout.

## Progress
- [DONE] Refusal layer in the deny hook
- [WIP] Independent review is running.
- [TODO] Fix the review findings, commit, push, reply to the lead.

## Work Log
- did: wrote the hook; the review is pending
`
const FRESH = `## Executive Summary
The hook refuses commit and push in the shared checkout; reviewed, pushed, and the lead has the reply.

## Progress
- [DONE] Refusal layer in the deny hook
- [DONE] Independent review: two findings, both fixed
- [DONE] Commit, push, reply to the lead
`

async function worker(project: string, note = STALE): Promise<{ task: Task; sid: string }> {
  const task = (await addTask({ title: `Worker ${++n}`, project })).task
  const sid = `sess-stale-${n}`
  await createSessionRecord(sid, task.id, project)
  await updateSessionRecord(sid, { process_status: 'idle' })
  await updateTaskRaw(task.id, { session_id: sid, note } as never, { emitEvent: true })
  await updateTask(task.id, { phase: 'IN_PROGRESS' })
  return { task: (await getTask(task.id)), sid }
}

async function refusedStale(route: Route, res: Response): Promise<void> {
  const body = await res.json() as { code?: string; items?: { text: string }[]; failed?: { error: string }[] }
  if (route.name.includes('batch')) {
    expect(body.failed?.[0]?.error ?? '', JSON.stringify(body)).toMatch(/^stale_note:/)
    expect(body.failed?.[0]?.error).toContain('[WIP] Independent review is running')
  } else {
    expect(res.status, JSON.stringify(body)).toBe(409)
    expect(JSON.stringify(body)).toContain('stale_note')
    expect(body.items?.map((i) => i.text)).toEqual([
      '[WIP] Independent review is running.',
      '[TODO] Fix the review findings, commit, push, reply to the lead.',
    ])
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

describe('its own session completing a task whose note reads as unfinished', () => {
  for (const route of ROUTES) {
    it(`${route.name}: asked once with the lines named, nothing written; the same close again completes it`, async () => {
      const { task, sid } = await worker('Stale')
      await refusedStale(route, await route.close(task, sid))
      const kept = await getTask(task.id)
      expect(kept.phase).toBe('IN_PROGRESS')
      expect(kept.result_report).toBeUndefined()
      const again = await route.close(kept, sid)
      expect(again.status, await again.clone().text()).toBe(200)
      const body = await again.json() as { failed?: unknown[] }
      expect(body.failed ?? []).toEqual([])
      expect((await getTask(task.id)).phase).toBe('COMPLETE')
    }, 60_000)
  }

  it('updating the note, then completing, goes through at once', async () => {
    const { task, sid } = await worker('Stale')
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('PUT', `/api/tasks/${task.id}/note`, { content: FRESH }, sid)).status).toBeLessThan(300)
    expect((await getTask(task.id)).note).toContain('both fixed')
    const done = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Pushed and replied.' }, sid)
    expect(done.status, await done.clone().text()).toBe(200)
  }, 60_000)

  it('a finished note is never asked', async () => {
    const { task, sid } = await worker('Stale', FRESH)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Pushed and replied.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  }, 60_000)

  it('a close that brings its own not_done goes through at once, as Partial', async () => {
    const { task, sid } = await worker('Stale')
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Hook shipped.', not_done: ['The independent review did not finish'] }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.result_report?.not_done).toEqual(['The independent review did not finish'])
  }, 60_000)

  it('a buried decision is named with how to ask it', async () => {
    const { task, sid } = await worker('Stale', `## Executive Summary\nThe other runner was stopped.\n\n## Progress\n- [DONE] Stop it\n- [TODO] Decide whether this runner keeps the three groups: your call.\n`)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)
    expect(res.status).toBe(409)
    const body = await res.json() as { error?: { message?: string }; message?: string; items?: { kind: string }[] }
    expect(JSON.stringify(body)).toMatch(/make it your own ask \(FOR_USER_ASK/)
    expect(body.items?.map((i) => i.kind)).toEqual(['question'])
  }, 60_000)

  it('a person completes it at once', async () => {
    const { task } = await worker('Stale')
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, {})
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  }, 60_000)

  it('another task completing it is not asked about its note', async () => {
    const other = await worker('Stale', FRESH)
    const { task } = await worker('Stale')
    const res = await json('POST', `/api/tasks/${task.id}/complete`, {}, other.sid)
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  }, 60_000)
})
