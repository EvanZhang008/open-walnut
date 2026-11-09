/**
 * A session's close of a task that still holds something for the user keeps it open as Partial and
 * Needs you, through every route a session can close by (src/core/sessions/owed-to-user.ts;
 * 2026-11-02: a task closed with its own Progress still saying the user had to resubmit a form the
 * next day, and Main told the user it was done).
 *
 * Every source of "the user still has this" (an open Progress item naming them, its status's ask,
 * an unanswered decision letter, an unanswered Board choice) times every close route: never a clean
 * Done. A person's close, a close with nothing owed, and a forced close with a reason do close.
 * Only the Claude CLI is absent; session records are written directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-owed-close'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendLetter } from '../../src/core/human-inbox/store.js'
import { setBoardHtml } from '../../src/core/boards/board-store.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { isPartial } from '../../src/core/peers/structured-reply.js'
import { applyReportPhase } from '../../src/core/sessions/report-phase.js'
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

const PROGRESS = (item: string) => `## Executive Summary\nDone but one step.\n\n## Progress\n- [DONE] The comparison\n- [TODO] ${item}\n`

/** Each way a task holds something for the user, set up on a fresh task with an idle session. */
const SOURCES: Record<string, (t: Task, sid: string) => Promise<void>> = {
  progress: async (t) => { await updateTaskRaw(t.id, { note: PROGRESS('You: resubmit the form by tomorrow') }, { emitEvent: true }) },
  ask: async (t) => {
    // A person sets its line, so it is a Needs you with nothing else behind it.
    expect((await json('PUT', `/api/v1/tasks/${t.id}/report`, { state: 'needs', ask: 'Pick the release name' })).status).toBe(200)
    await syncUserStatuses(null)
    expect((await getTask(t.id)).user_status).toMatchObject({ state: 'needs', ask: 'Pick the release name' })
  },
  letter: async (t, sid) => {
    await sendLetter({
      subject: 'Pick a design', type: 'action_required', markdown: 'A or B?',
      actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], sender: { sessionId: sid, taskId: t.id },
    } as never)
  },
  choice: async (t) => {
    await setBoardHtml(t.id, `<html><body><walnut-choice id="c1" title="Which host?" options="a:Mac,b:Cloud"></walnut-choice></body></html>`, { by: `task:${t.id}` })
  },
}

async function worker(project: string): Promise<{ task: Task; sid: string }> {
  const task = (await addTask({ title: `Worker ${++n}`, project })).task
  const sid = `sess-owed-${n}`
  await createSessionRecord(sid, task.id, project)
  await updateSessionRecord(sid, { process_status: 'idle' })
  await updateTaskRaw(task.id, { session_id: sid } as never, { emitEvent: true })
  await updateTask(task.id, { phase: 'IN_PROGRESS' })
  return { task: (await getTask(task.id)), sid }
}

/** A later session of the same task: the first one is archived first (one active session per task). */
async function laterSession(task: Task, sid: string): Promise<string> {
  await updateSessionRecord(sid, { process_status: 'stopped', archived: true, archive_reason: 'engine_switched:claude' } as never)
  const later = `${sid}-later`
  await createSessionRecord(later, task.id, 'Owed')
  await updateSessionRecord(later, { process_status: 'idle' })
  return later
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

describe('a session never closes a task the user still has something of', () => {
  for (const [source, setUp] of Object.entries(SOURCES)) {
    for (const route of ROUTES) {
      it(`${source} x ${route.name}: kept open as Partial and Needs you`, async () => {
        const { task, sid } = await worker('Owed')
        await setUp(task, sid)
        const res = await route.close(await getTask(task.id), sid)
        const body = await res.json() as { code?: string; failed?: { error: string }[] }
        if (route.name.includes('batch')) expect(body.failed?.[0]?.error ?? '').toMatch(/^owed_to_user:/)
        else { expect(res.status).toBe(409); expect(JSON.stringify(body)).toContain('owed_to_user') }
        const after = await getTask(task.id)
        expect(after.phase).toBe('NEED_ACTION')
        expect(isPartial(after.result_report)).toBe(true)
        await syncUserStatuses(null)
        const s = (await getTask(task.id)).user_status
        expect(s?.state, JSON.stringify(s)).toBe('needs')
        expect(s?.ask ?? '').not.toBe('')
      }, 60_000)
    }
  }
})

describe('the case that showed it', () => {
  it('its own session closes it mid-turn with a step of the user left; the turn-end report cannot undo the hold', async () => {
    const lead = await worker('Owed')
    const { task, sid } = await worker('Owed')
    // With a lead, a done report would move it to WAITING for the lead to check, were it not held.
    await updateTask(task.id, { parent_task_id: lead.task.id })
    await updateTaskRaw(task.id, { note: PROGRESS('You, Robin: Seed shop > Spring order > "Order max" > resubmit by tomorrow') }, { emitEvent: true })
    await updateSessionRecord(sid, { process_status: 'running' })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'All questions answered.', evidence: ['notes/order.md'] }, sid)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('Order max')
    const after = await getTask(task.id)
    expect(after.phase).toBe('NEED_ACTION')
    expect(after.result_report).toMatchObject({ result: 'All questions answered.', evidence: ['notes/order.md'] })
    expect(after.result_report?.not_done?.[0]).toContain('Order max')
    expect(after.result_report?.owed?.items[0]).toContain('Order max')

    // The turn ends and its own report says done (status-question.ts stores it, report-phase.ts
    // applies it): still Needs you, still NEED_ACTION.
    await updateSessionRecord(sid, { process_status: 'idle' })
    await new Promise((r) => setTimeout(r, 20))
    const ended = Date.now()
    const report = { state: 'done', at: new Date(ended).toISOString(), turn_ended_at: new Date(ended).toISOString(), now: 'Answered every question.' } as never
    await updateTaskRaw(task.id, { status_report: report }, { emitEvent: true })
    expect(await applyReportPhase(task.id, sid, report, ended)).not.toBe('WAITING')
    await syncUserStatuses(null)
    const later = await getTask(task.id)
    expect(later.phase).toBe('NEED_ACTION')
    expect(later.user_status?.state, JSON.stringify(later.user_status)).toBe('needs')
    expect(later.user_status?.ask ?? '').toContain('Order max')
  }, 60_000)

  it('a second close names the same items: the hold is not written again and its ask is not nested', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    await syncUserStatuses(null)
    const first = (await getTask(task.id)).result_report!
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)
    expect(res.status).toBe(409)
    const body = await res.json() as { items?: { text: string }[] }
    expect(body.items?.map((i) => i.text)).toEqual(first.owed!.items)
    const second = (await getTask(task.id)).result_report!
    expect(second.owed).toEqual(first.owed)
    expect(second.owed!.ask).not.toMatch(/Left for you.*Left for you/)
  }, 60_000)
})

describe('what ends a hold, and what still closes', () => {
  it('a person closes it whatever is left, and the hold ends with it', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {})).status).toBe(200)
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(isPartial(done.result_report)).toBe(false)
  })

  for (const route of ROUTES) {
    it(`a person's close through ${route.name} ends the hold, settled as taken`, async () => {
      const { task, sid } = await worker('Owed')
      await SOURCES.progress(task, sid)
      expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
      const res = await route.close(await getTask(task.id))
      expect(res.status, await res.clone().text()).toBe(200)
      const done = await getTask(task.id)
      expect(done.phase).toBe('COMPLETE')
      expect(isPartial(done.result_report), JSON.stringify(done.result_report)).toBe(false)
      expect(done.result_report?.owed?.settled).toMatchObject({ how: 'taken', by: 'human' })
    })
  }

  it('a person\'s close that says what came of it keeps that result, and ends the hold', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Submitted it myself.' })).status).toBe(200)
    const done = await getTask(task.id)
    expect(done.result_report).toMatchObject({ result: 'Submitted it myself.', owed: { settled: { how: 'taken' } } })
    expect(isPartial(done.result_report)).toBe(false)
    // No caller header: the person on the primary wrote that result.
    expect(done.result_report).toMatchObject({ by: 'human', host: 'local', owed: { settled: { by: 'human' } } })
  })

  it('a close with a caller header Walnut cannot resolve still closes, but its result names an unknown writer and no host', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Submitted it.' }, 'sess-owed-no-such-record')
    expect(res.status, await res.clone().text()).toBe(200)
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.result_report).toMatchObject({ result: 'Submitted it.', by: 'unknown', owed: { settled: { how: 'taken', by: 'unknown' } } })
    expect(done.result_report?.host).toBeUndefined()
    expect(done.result_report?.owed?.settled?.note ?? '').not.toMatch(/user/i)
  })

  // A person's (or an unresolved caller's) close that brings only part of the result keeps the rest
  // of the held result, and a report of mixed writers names none of them.
  const PERSON_CLOSERS = [
    { name: 'a person (no header)', sid: undefined as string | undefined, writer: { by: 'human', host: 'local' } },
    { name: 'an unresolved caller', sid: 'sess-owed-no-such-record', writer: { by: 'unknown' } },
  ]
  const PARTS = [
    { name: 'evidence only', body: { evidence: ['notes/receipt.md'] }, want: { result: 'Compared both plans.', evidence: ['notes/receipt.md'] }, mixed: true },
    { name: 'result only', body: { result: 'Submitted it myself.' }, want: { result: 'Submitted it myself.', evidence: ['notes/plans.md'] }, mixed: true },
    { name: 'result and evidence', body: { result: 'Submitted it myself.', evidence: ['notes/receipt.md'] }, want: { result: 'Submitted it myself.', evidence: ['notes/receipt.md'] }, mixed: false },
  ]
  for (const closer of PERSON_CLOSERS) {
    for (const part of PARTS) {
      it(`${closer.name}'s close with ${part.name} keeps the held fields it does not bring, with the right writer`, async () => {
        const { task, sid } = await worker('Owed')
        await SOURCES.progress(task, sid)
        expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.', evidence: ['notes/plans.md'] }, sid)).status).toBe(409)
        expect((await getTask(task.id)).result_report).toMatchObject({ result: 'Compared both plans.', evidence: ['notes/plans.md'], by: `task:${task.id}`, sessionId: sid })
        const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, part.body, closer.sid)
        expect(res.status, await res.clone().text()).toBe(200)
        const done = await getTask(task.id)
        expect(done.phase).toBe('COMPLETE')
        expect(done.result_report).toMatchObject({ ...part.want, owed: { settled: { how: 'taken', by: closer.writer.by } } })
        expect(isPartial(done.result_report)).toBe(false)
        expect(done.result_report?.sessionId).toBeUndefined()
        if (part.mixed) {
          expect(done.result_report?.by).toBe('unknown')
          expect(done.result_report?.host).toBeUndefined()
        } else {
          expect(done.result_report?.by).toBe(closer.writer.by)
          expect(done.result_report?.host).toBe(closer.writer.host)
        }
      })
    }
  }

  for (const closer of PERSON_CLOSERS) {
    it(`${closer.name}'s close with not_done only keeps the held result with its writer, and marks its not-done unknown`, async () => {
      const { task, sid } = await worker('Owed')
      await SOURCES.progress(task, sid)
      expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.', evidence: ['notes/plans.md'] }, sid)).status).toBe(409)
      expect((await getTask(task.id)).result_report).toMatchObject({ result: 'Compared both plans.', evidence: ['notes/plans.md'], by: `task:${task.id}`, sessionId: sid })
      const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { not_done: ['iOS not tested'] }, closer.sid)
      expect(res.status, await res.clone().text()).toBe(200)
      const done = await getTask(task.id)
      expect(done.phase).toBe('COMPLETE')
      expect(done.result_report).toMatchObject({
        result: 'Compared both plans.', evidence: ['notes/plans.md'], by: `task:${task.id}`, sessionId: sid,
        not_done: ['iOS not tested'], not_done_by: 'unknown', owed: { settled: { how: 'taken', by: closer.writer.by } },
      })
      expect(done.result_report?.host).toBeUndefined()
      expect(done.result_report?.settled).toBeUndefined()
      expect(isPartial(done.result_report)).toBe(true)
    })
  }

  it('a close with no result keeps the earlier result\'s own writer, whoever closes', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    const held = (await getTask(task.id)).result_report!
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {})).status).toBe(200)
    const done = (await getTask(task.id)).result_report!
    expect(done.by).toBe(held.by)
    expect(done.host).toBe(held.host)
    expect(done.owed?.settled).toMatchObject({ how: 'taken', by: 'human' })
  })

  it('a forced close by an id prefix settles the items on the task itself', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    const prefix = task.id.split('-')[0]
    expect((await json('POST', `/api/v1/tasks/${prefix}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${prefix}/complete`, { force: true, reason: 'The user resubmitted it on the site this morning' }, sid)).status).toBe(200)
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.result_report?.owed?.settled?.how).toBe('dropped')
  })

  it('a forced close with a new result records the closing session itself as its writer', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.' }, sid)).status).toBe(409)
    expect((await getTask(task.id)).result_report).toMatchObject({ result: 'Compared both plans.', by: `task:${task.id}`, sessionId: sid })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'The user resubmitted it on the site this morning', result: 'Resubmitted, confirmation 42.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = (await getTask(task.id)).result_report!
    expect(done).toMatchObject({ result: 'Resubmitted, confirmation 42.', by: `task:${task.id}`, sessionId: sid, owed: { settled: { how: 'dropped', by: `task:${task.id}` } } })
    expect(done.host).toBeUndefined()
  })

  it('a forced close with no new result keeps the earlier result with the session that wrote it', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.', evidence: ['notes/plans.md'] }, sid)).status).toBe(409)
    // A later session of the same task closes it: the result is still the first session's.
    const later = await laterSession(task, sid)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'The user resubmitted it on the site this morning' }, later)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = (await getTask(task.id)).result_report!
    expect(done).toMatchObject({ result: 'Compared both plans.', evidence: ['notes/plans.md'], by: `task:${task.id}`, sessionId: sid })
    expect(done.sessionId).not.toBe(later)
    expect(done.owed?.settled).toMatchObject({ how: 'dropped', by: `task:${task.id}` })
  })

  it('a forced close adding evidence by another session keeps the earlier result too, and names no single writer', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.' }, sid)).status).toBe(409)
    const later = await laterSession(task, sid)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'The user resubmitted it on the site this morning', evidence: ['notes/receipt.md'] }, later)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = (await getTask(task.id)).result_report!
    expect(done).toMatchObject({ result: 'Compared both plans.', evidence: ['notes/receipt.md'], by: 'unknown', owed: { settled: { how: 'dropped', by: `task:${task.id}` } } })
    expect(done.sessionId).toBeUndefined()
    expect(done.host).toBeUndefined()
  })

  it('a session settles the user\'s items only with a note saying how', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/not-done`, { how: 'dropped' }, sid)).status).toBe(409)
    expect(isPartial((await getTask(task.id)).result_report)).toBe(true)
    expect((await json('POST', `/api/v1/tasks/${task.id}/not-done`, { how: 'taken', note: 'The user did it on the site today' }, sid)).status).toBe(200)
    expect(isPartial((await getTask(task.id)).result_report)).toBe(false)
  })

  it('a not-done item already settled stays settled when a later close is held', async () => {
    const { task, sid } = await worker('Owed')
    await updateTaskRaw(task.id, { result_report: { via: 'reply', at: new Date().toISOString(), not_done: ['iOS not tested'], settled: { at: new Date().toISOString(), by: 'human', how: 'dropped' } } } as never, { emitEvent: true })
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await getTask(task.id)).result_report?.not_done).toEqual(['[TODO] You: resubmit the form by tomorrow'])
  })

  it('the not-done settle ends the hold: no longer Needs you', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/not-done`, { how: 'taken', note: 'resubmitted it myself' })).status).toBe(200)
    const after = await getTask(task.id)
    expect(after.result_report?.owed?.settled?.how).toBe('taken')
    expect(isPartial(after.result_report)).toBe(false)
    await syncUserStatuses(null)
    expect((await getTask(task.id)).user_status?.ask ?? '').not.toContain('Left for you')
  })

  it('a session closes a task with nothing left for the user; its own open item does not hold it', async () => {
    const { task, sid } = await worker('Owed')
    await updateTaskRaw(task.id, { note: PROGRESS('Ship the user-status fix') }, { emitEvent: true })
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(200)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  })

  it('Main and a lead are never held', async () => {
    for (const role of ['main', 'lead'] as const) {
      const { task, sid } = await worker('Owed')
      await updateTaskRaw(task.id, { org_role: role } as never, { emitEvent: true })
      await SOURCES.progress(task, sid)
      expect((await json('PATCH', `/api/v1/tasks/${task.id}`, { phase: 'COMPLETE' }, sid)).status, role).toBe(200)
    }
  })

  it('force works only once a hold named the items; it settles them and keeps its own not-done Partial', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    const reason = 'The user resubmitted it on the site this morning'
    // A force before any hold is held first, so the items are named.
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason }, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'short' }, sid)).status).toBe(409)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason, result: 'Shipped.', evidence: ['run 42'], not_done: ['iOS not tested'] }, sid)
    expect(res.status).toBe(200)
    expect((await res.json() as { owed_settled?: string[] }).owed_settled?.[0]).toContain('You: resubmit the form')
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.result_report).toMatchObject({ result: 'Shipped.', evidence: ['run 42'], not_done: ['iOS not tested'] })
    expect(done.result_report?.settled).toBeUndefined()
    expect(done.result_report?.owed?.settled).toMatchObject({ how: 'dropped', note: reason })
    expect(isPartial(done.result_report)).toBe(true)
  })

  it('a force settles only what this closer was told: an item found after the hold is held again', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    const body = { force: true, reason: 'The user resubmitted it on the site this morning' }
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    await SOURCES.letter(task, sid)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, body, sid)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('Pick a design')
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, sid)).status).toBe(200)
  })

  it('a lead closing its worker meets the same gate: held first, then its forced close settles the items', async () => {
    const lead = await worker('Owed')
    const { task } = await worker('Owed')
    await updateTask(task.id, { parent_task_id: lead.task.id })
    await updateTaskRaw(task.id, { note: PROGRESS('You: approve the release') }, { emitEvent: true })
    const body = { force: true, reason: 'not in use any more by anyone' }
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, lead.sid)).status).toBe(409)
    expect((await getTask(task.id)).phase).toBe('NEED_ACTION')
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, lead.sid)).status).toBe(200)
    expect((await getTask(task.id)).result_report?.owed?.settled?.how).toBe('dropped')
  })
})
