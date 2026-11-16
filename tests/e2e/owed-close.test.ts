/**
 * A session's close of a task that still holds something for the user keeps it open as Partial and
 * Needs you, through every route a session can close by (src/core/sessions/owed-to-user.ts;
 * 2026-11-02: a task closed with its own Progress still saying the user had to resubmit a form the
 * next day, and Main told the user it was done).
 *
 * Every source of "the user still has this" (an open Progress item naming them, its status's ask,
 * an unanswered decision letter, an unanswered Board choice, a lead's thread waiting on him that names
 * it, its own conclusion saying he still decides) times every close route: never a clean Done; a
 * ratchet fails on a source with no case here. A person's close, a close with nothing owed, a lead's
 * forced close with a reason, and another session's forced close quoting his words do close.
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
import { openNodeThread, patchThread, readThreads, withTaskAsks } from '../../src/core/org/threads-store.js'
import { prepareUserAskCapture } from '../../src/core/sessions/user-asks.js'
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
  // 2026-11-16: its lead put "pay it?" on the user's Threads naming the task, which then closed.
  thread: async (t) => { await leadThread(t, 'Pay the print shop invoice of $45?') },
  // Its own last result says the decision is still the user's (a reply's not_done, as the case had).
  decision: async (t) => {
    await updateTaskRaw(t.id, { result_report: { via: 'reply', at: new Date().toISOString(), by: `task:${t.id}`, result: 'The new document is an invoice for $45.', not_done: ['Whether to pay the $45 is the user\'s decision'] } } as never, { emitEvent: true })
  },
}

/** The user's own words in the task's chat (what user_words must quote). */
async function said(task: Task, text: string): Promise<void> {
  // Strictly after the hold it answers (user_words counts only his words since then).
  await new Promise((r) => setTimeout(r, 5))
  const capture = await prepareUserAskCapture({ task: await getTask(task.id), message: text, inChat: true })
  expect(capture, 'his words are filed').not.toBeNull()
  await capture!.commit()
}
const HIS = 'I resubmitted it on the site this morning'

const KIND = { user_kind: 'spending', user_kind_why: 'Paying the invoice spends the user\'s money' }
/** A lead's thread waiting on the user that names the task, asking `ask`. */
async function leadThread(task: Task, ask: string): Promise<{ lead: Task; thread: string }> {
  const lead = (await addTask({ title: `Lead ${++n}`, project: task.project })).task
  const th = await openNodeThread(lead.id, { title: 'Print shop invoice', text: 'A new document is an invoice.', from: 'task', state: 'needs', tasks: [task.id], ref: task.id, ...KIND }, `task:${lead.id}`)
  await patchThread(lead.id, th.id, { ask, state: 'needs', ...KIND } as never, `task:${lead.id}`)
  return { lead, thread: th.id }
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
    await said(task, HIS)
    expect((await json('POST', `/api/v1/tasks/${prefix}/complete`, { force: true, user_words: HIS, reason: 'The user resubmitted it on the site this morning' }, sid)).status).toBe(200)
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.result_report?.owed?.settled?.how).toBe('dropped')
  })

  it('a forced close with a new result records the closing session itself as its writer', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.' }, sid)).status).toBe(409)
    await said(task, HIS)
    expect((await getTask(task.id)).result_report).toMatchObject({ result: 'Compared both plans.', by: `task:${task.id}`, sessionId: sid })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, user_words: HIS, reason: 'The user resubmitted it on the site this morning', result: 'Resubmitted, confirmation 42.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = (await getTask(task.id)).result_report!
    expect(done).toMatchObject({ result: 'Resubmitted, confirmation 42.', by: `task:${task.id}`, sessionId: sid, owed: { settled: { how: 'dropped', by: `task:${task.id}` } } })
    expect(done.host).toBeUndefined()
  })

  it('a forced close with no new result keeps the earlier result with the session that wrote it', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Compared both plans.', evidence: ['notes/plans.md'] }, sid)).status).toBe(409)
    await said(task, HIS)
    // A later session of the same task closes it: the result is still the first session's.
    const later = await laterSession(task, sid)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, user_words: HIS, reason: 'The user resubmitted it on the site this morning' }, later)
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
    await said(task, HIS)
    const later = await laterSession(task, sid)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, user_words: HIS, reason: 'The user resubmitted it on the site this morning', evidence: ['notes/receipt.md'] }, later)
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
    // Its own open line is only asked about once (stale-note-close.test.ts), never held for the user.
    const first = await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)
    expect(first.status).toBe(409)
    expect(JSON.stringify(await first.json())).toContain('stale_note')
    expect((await getTask(task.id)).result_report?.owed).toBeUndefined()
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
    await said(task, HIS)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'short' }, sid)).status).toBe(409)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, user_words: HIS, reason, result: 'Shipped.', evidence: ['run 42'], not_done: ['iOS not tested'] }, sid)
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
    const body = { force: true, user_words: HIS, reason: 'The user resubmitted it on the site this morning' }
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    await said(task, HIS)
    await SOURCES.letter(task, sid)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, body, sid)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('Pick a design')
    // His words came before the new item was named: they settle only what he saw.
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, sid)).status).toBe(409)
    await said(task, 'Picked design A as well')
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { ...body, user_words: 'Picked design A as well' }, sid)).status).toBe(200)
  })

  it('a lead closing its worker meets the same gate: held first, then its forced close settles the items', async () => {
    const lead = await worker('Owed')
    const { task } = await worker('Owed')
    await updateTask(task.id, { parent_task_id: lead.task.id })
    await updateTaskRaw(task.id, { note: PROGRESS('You: approve the release') }, { emitEvent: true })
    const body = { force: true, reason: 'not in use any more by anyone' }
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, lead.sid)).status).toBe(409)
    // The hold is the lead's to settle (2026-11-15): it keeps its phase, off the user's Needs you.
    expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
    expect((await getTask(task.id)).result_report?.owed?.toCloser).toBe(true)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, lead.sid)).status).toBe(200)
    expect((await getTask(task.id)).result_report?.owed?.settled?.how).toBe('dropped')
  })
})

describe('a lead\'s close is answered to the lead, never put on the user\'s Needs you', () => {
  // 2026-11-15, the Walnut VP: a VP closing a router-made task whose stale note still said
  // "[WAIT] You:" put three items on the user's Needs you for a decision the VP had already made.
  for (const kind of ['org lead', 'parent task'] as const) {
    it(`${kind}: 409 names the items to the caller, the task keeps its phase and Partial, Needs you stays clear, a force closes it`, async () => {
      const lead = await worker('Owed')
      const { task, sid } = await worker('Owed')
      if (kind === 'org lead') await updateTaskRaw(lead.task.id, { org_role: 'lead' } as never, { emitEvent: true })
      else await updateTask(task.id, { parent_task_id: lead.task.id })
      await updateTaskRaw(task.id, { note: PROGRESS('You: get the python3.9 function list') }, { emitEvent: true })
      const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, lead.sid)
      expect(res.status).toBe(409)
      const body = JSON.stringify(await res.json())
      expect(body).toContain('owed_to_user')
      expect(body).toContain('python3.9 function list')
      expect(body).toMatch(/yours to settle/)
      const held = await getTask(task.id)
      // The protection stays: nothing is dropped, the items are on the result, the phase is untouched.
      expect(held.phase).toBe('IN_PROGRESS')
      expect(isPartial(held.result_report)).toBe(true)
      expect(held.result_report?.owed).toMatchObject({ toCloser: true, told: [lead.task.id] })
      await syncUserStatuses(null)
      expect((await getTask(task.id)).user_status?.state).not.toBe('needs')
      // A later report of its own does not move it to NEED_ACTION for the lead's hold either.
      await applyReportPhase(task.id, sid, { state: 'done' } as never, Date.now())
      expect((await getTask(task.id)).phase).not.toBe('NEED_ACTION')
      const forced = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'The user\'s items were settled by the lead: not Personal work.' }, lead.sid)
      expect(forced.status).toBe(200)
      expect((await getTask(task.id)).phase).toBe('COMPLETE')
    }, 60_000)
  }

  it('a lead\'s hold turns into the user\'s once a non-lead close is held by the same items', async () => {
    const lead = await worker('Owed')
    const peer = await worker('Owed')
    const { task } = await worker('Owed')
    await updateTask(task.id, { parent_task_id: lead.task.id })
    await updateTaskRaw(task.id, { note: PROGRESS('You: approve the release') }, { emitEvent: true })
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, lead.sid)).status).toBe(409)
    expect((await getTask(task.id)).result_report?.owed?.toCloser).toBe(true)
    // A peer's close (forced past task_in_use, as the task now reads Partial) is held by the same items.
    const peerClose = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'A peer thinks this is done now.' }, peer.sid)
    expect(peerClose.status).toBe(409)
    expect(JSON.stringify(await peerClose.json())).toContain('owed_to_user')
    const after = await getTask(task.id)
    expect(after.result_report?.owed?.toCloser).toBeUndefined()
    expect(after.phase).toBe('NEED_ACTION')
    await syncUserStatuses(null)
    expect((await getTask(task.id)).user_status?.state).toBe('needs')
  }, 60_000)
})

describe('every way a task waits on the user holds a close', () => {
  it('ratchet: each OwedSource has a case in SOURCES above (a new way to wait on him that closes fails here)', async () => {
    const src = await fs.readFile(new URL('../../src/core/sessions/owed-to-user.ts', import.meta.url), 'utf8')
    const union = /export type OwedSource\s*=\s*((?:'[a-z_]+'\s*\|?\s*)+);/.exec(src)?.[1]
    expect(union, 'OwedSource not found in owed-to-user.ts').toBeTruthy()
    // `held` is a hold's own memory of the others, covered by every hold below.
    const members = [...union!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((m) => m !== 'held').sort()
    expect(Object.keys(SOURCES).sort(), 'A new OwedSource: add a SOURCES case that sets it up').toEqual(members)
  })

  it('only the user settles what waits on him: its own session\'s force needs his words, quoted', async () => {
    const { task, sid } = await worker('Owed')
    // His first words to the task, from before the hold: they never settle what it names later.
    await said(task, 'Please look at the new vendor document for me')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'The user resubmitted it on the site this morning', user_words: 'Please look at the new vendor document for me' }, sid)).status).toBe(409)
    const reason = 'The user resubmitted it on the site this morning'
    const bare = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason }, sid)
    expect(bare.status).toBe(409)
    expect(JSON.stringify(await bare.json())).toContain('force needs user_words')
    // Words he never wrote do not count.
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason, user_words: 'Sure, drop it' }, sid)).status).toBe(409)
    expect((await getTask(task.id)).phase).toBe('NEED_ACTION')
    await said(task, 'Done, I resubmitted the form myself')
    // Its own session is not shown his words again: the first force quoting them closes it.
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason, user_words: 'Done, I resubmitted the form myself' }, sid)).status).toBe(200)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  }, 60_000)
})

describe('what does not hold, and who settles', () => {
  it('a thread that only went to several tasks ("which first?") holds none whose conclusion waits on nothing', async () => {
    const { task, sid } = await worker('Wide')
    const other = await worker('Wide')
    const lead = (await addTask({ title: `Lead ${++n}`, project: 'Wide' })).task
    await updateTask(task.id, { parent_task_id: lead.id })
    await openNodeThread(lead.id, { title: 'Order', text: 'Which goes first?', from: 'task', state: 'needs', tasks: [task.id, other.task.id], ...KIND }, `task:${lead.id}`)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Shipped the importer.' }, sid)).status).toBe(200)
  })

  it('a result that only describes work about waiting holds nothing', async () => {
    const { task, sid } = await worker('Owed')
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Landed the gate: a task still waiting on the user cannot be completed.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  })

  it('an item read from its own conclusion clears when the close no longer says it', async () => {
    const { task, sid } = await worker('Owed')
    await SOURCES.decision(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Reported the invoice; the lead decided not to pay.', not_done: [] }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  })

  it('the ask keeps another item of the user beside the thread\'s question', async () => {
    const { task, sid } = await worker('Mixed')
    await leadThread(task, 'Pay the parking fine of $40?')
    await SOURCES.progress(task, sid)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, sid)).status).toBe(409)
    const ask = (await getTask(task.id)).result_report?.owed?.ask ?? ''
    expect(ask).toContain('Pay the parking fine of $40?')
    expect(ask).toContain('resubmit the form')
  })

  it('another team\'s lead settles nothing of the user with a reason alone; the task\'s own lead does', async () => {
    const own = await worker('Owed')
    // A lead of another project's team.
    const other = await worker('Elsewhere')
    await updateTaskRaw(other.task.id, { org_role: 'lead' } as never, { emitEvent: true })
    const { task, sid } = await worker('Owed')
    await updateTask(task.id, { parent_task_id: own.task.id })
    await SOURCES.progress(task, sid)
    const body = { force: true, reason: 'Settled by a lead: not the user\'s.' }
    // Each is held once (the items named to it), then forces.
    for (let i = 0; i < 3; i++) expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, other.sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, own.sid)).status).toBe(409)
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, own.sid)).status).toBe(200)
  }, 60_000)
})

describe('the case that showed it: a look that found an invoice to pay', () => {
  // 2026-11-16: a worker sent to look at a new document found an invoice for $45, replied to its lead
  // that paying was the user's decision, marked "[DONE] You: decide whether to pay (passed to the
  // lead)", and completed, while its lead's thread asked the user "pay it?" naming that worker.
  it('its close is held, it waits on the user once, his answer lets it finish, then it closes', async () => {
    // Its own project: the matrix above asks the same words, and one team asking it folds to one ask.
    const { task, sid } = await worker('Invoice')
    const ask = 'Pay the print shop invoice of $45?'
    const { lead, thread } = await leadThread(task, ask)
    await updateTask(task.id, { parent_task_id: lead.id })
    await updateTaskRaw(task.id, {
      note: '## Executive Summary\nThe new document is an invoice for $45. Whether to pay it is the user\'s decision, passed to the lead.\n\n## Progress\n- [DONE] Identify the document\n- [DONE] You: decide whether to pay the $45 (passed to the lead)\n',
    }, { emitEvent: true })
    await updateSessionRecord(sid, { process_status: 'running' })
    const close = await json('POST', `/api/v1/tasks/${task.id}/complete`, {
      result: 'The new document is an invoice for $45; whether to pay is the user\'s decision (reported to the lead).',
      not_done: ['Whether to pay the $45 is the user\'s decision'],
    }, sid)
    expect(close.status).toBe(409)
    const why = JSON.stringify(await close.json())
    expect(why).toContain('owed_to_user')
    expect(why).toContain(ask)
    expect(why).toContain('not when his decision was handed on')
    const held = await getTask(task.id)
    expect(held.phase).toBe('NEED_ACTION')
    expect(isPartial(held.result_report)).toBe(true)
    // Its turn ends: what the user reads now.
    await updateSessionRecord(sid, { process_status: 'idle' })
    await syncUserStatuses(null)
    // Asked once: on the task, in the thread's own words; the lead's thread reads as a pointer to it.
    const st = (await getTask(task.id)).user_status
    expect(st, JSON.stringify(st)).toMatchObject({ state: 'needs', ask })
    const shown = await withTaskAsks(lead.id, (await readThreads(lead.id)).threads)
    expect(shown.find((t) => t.id === thread)?.askedIn?.task).toBe(task.id)
    // Its own session cannot force past it without his words.
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'Handed the payment decision to the lead' }, sid)).status).toBe(409)
    expect((await getTask(task.id)).phase).toBe('NEED_ACTION')
    // He answers in the task; it pays and closes, quoting him.
    await said(task, 'yes pay it')
    const body = { force: true, reason: 'The user said pay; paid $45 online, receipt saved', user_words: 'yes pay it', result: 'Paid the $45 bill; receipt saved.', not_done: [] }
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, body, sid)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = await getTask(task.id)
    expect(done.phase).toBe('COMPLETE')
    expect(done.result_report?.owed?.settled).toMatchObject({ how: 'dropped' })
    // The lead's thread does not ask him again once the task is done: it went quiet for the lead.
    const after = (await withTaskAsks(lead.id, (await readThreads(lead.id)).threads)).find((t) => t.id === thread)
    expect(after?.state).toBe('pending')
  }, 60_000)
})
