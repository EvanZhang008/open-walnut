/**
 * Who settles what a close left for the user (src/core/sessions/owed-to-user.ts), beside
 * tests/e2e/owed-close.test.ts. 2026-11-19: a VP leading an imported task's project for the user
 * (org_leads) answered the task's held ask with answers_ask and forced its close with a reason; every
 * close was refused for want of the user's own words, and the task sat on his Needs you after the work
 * was done. Now:
 *   - the lead that answers_ask counts as its lead (one rule, ask-answer.ts standsAbove) settles with a
 *     reason alone, through every close route;
 *   - an answer given in his place to the held ask ends the hold, so the task's own close goes through;
 *   - an ask of the user nobody answered still holds every close but his own.
 * Only the Claude CLI is absent; session records are written directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-owed-close-lead'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { prepareUserAskCapture } from '../../src/core/sessions/user-asks.js'
import type { Task } from '../../src/core/types.js'

let server: HttpServer
let base: string
let n = 0

const json = (method: string, url: string, body: unknown, sid?: string) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
  body: JSON.stringify(body),
})

type Route = { name: string; close: (t: Task, sid: string, extra: Record<string, unknown>) => Promise<Response> }
// The batch routes carry no force: a batch close settles nothing, so it is held like any first close.
const ROUTES: Route[] = [
  { name: 'v1 POST complete', close: (t, sid, x) => json('POST', `/api/v1/tasks/${t.id}/complete`, x, sid) },
  { name: 'v1 PATCH phase', close: (t, sid, x) => json('PATCH', `/api/v1/tasks/${t.id}`, { phase: 'COMPLETE', ...x }, sid) },
  { name: 'PATCH phase', close: (t, sid, x) => json('PATCH', `/api/tasks/${t.id}`, { phase: 'COMPLETE', ...x }, sid) },
  { name: 'POST complete', close: (t, sid, x) => json('POST', `/api/tasks/${t.id}/complete`, x, sid) },
]
const BATCHES = ['/api/v1/tasks/batch/phase', '/api/tasks/batch/phase']

const NOTE = (line: string) => `## Executive Summary\nThe record is deleted and the finding resolved.\n\n## Progress\n- [DONE] Delete the record\n- ${line}\n`

/** A task with an idle session of its own, in `project`. */
async function withSession(title: string, project: string, extra: Partial<Task> = {}): Promise<{ task: Task; sid: string }> {
  const task = (await addTask({ title: `${title} ${++n}`, project })).task
  const sid = `sess-owed-lead-${n}`
  await createSessionRecord(sid, task.id, project)
  await updateSessionRecord(sid, { process_status: 'idle' })
  await updateTaskRaw(task.id, { session_id: sid, ...extra } as never, { emitEvent: true })
  if (!extra.org_role) await updateTask(task.id, { phase: 'IN_PROGRESS' })
  return { task: await getTask(task.id), sid }
}

/** A VP whose own project is another one, leading `project` for the user (Task.org_leads). */
const vpOf = (project: string) => withSession('Garden VP', `Garden ${n}`, { org_role: 'lead', org_leads: [project] } as Partial<Task>)

/** A peer of another team closes it: the hold is the user's (NEED_ACTION, his Needs you). */
async function heldForUser(task: Task, project: string): Promise<Task> {
  const peer = await withSession('Peer', `Elsewhere ${n}`)
  expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, {}, peer.sid)).status).toBe(409)
  await syncUserStatuses(null)
  const held = await getTask(task.id)
  expect(held.phase, project).toBe('NEED_ACTION')
  expect(held.user_status?.state).toBe('needs')
  return held
}

/** The user's own words in the task's chat, after the hold (what user_words must quote). */
async function said(task: Task, text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
  const capture = await prepareUserAskCapture({ task: await getTask(task.id), message: text, inChat: true })
  expect(capture, 'his words are filed').not.toBeNull()
  await capture!.commit()
}

const answerAsk = (task: Task, sid: string, text: string, extra: Record<string, unknown> = {}) =>
  json('POST', '/api/v1/messages', { to: task.id, title: 'Answered for the user', text, answers_ask: true, expect_reply: false, ...extra }, sid)

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

describe('a VP leading the task\'s project for the user settles with a reason', () => {
  for (const route of ROUTES) {
    it(`${route.name}: held to the VP first, then its forced close with a reason closes it`, async () => {
      const project = `Imports ${route.name}`
      const vp = await vpOf(project)
      const { task } = await withSession('Imported finding', project)
      await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: say the old deletion question is no longer wanted') }, { emitEvent: true })
      const body = { force: true, reason: 'The user deleted the record himself; the finding resolved on its own.' }
      const first = await route.close(task, vp.sid, body)
      expect(first.status).toBe(409)
      // Answered to the VP, never put on the user's Needs you.
      const kept = await getTask(task.id)
      expect(kept.phase).toBe('IN_PROGRESS')
      expect(kept.result_report?.owed?.toCloser).toBe(true)
      const res = await route.close(task, vp.sid, body)
      expect(res.status, await res.clone().text()).toBe(200)
      const done = await getTask(task.id)
      expect(done.phase).toBe('COMPLETE')
      expect(done.result_report?.owed?.settled?.note ?? done.result_report?.owed?.settled?.how).toBeTruthy()
    }, 60_000)
  }

  it('the batch routes hold its items to the VP too, and a forced close then settles them', async () => {
    for (const [i, url] of BATCHES.entries()) {
      const project = `Imports batch ${i}`
      const vp = await vpOf(project)
      const { task } = await withSession('Imported finding', project)
      await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: confirm nothing else is needed') }, { emitEvent: true })
      const batch = await json('POST', url, { task_ids: [task.id], phase: 'COMPLETE' }, vp.sid)
      expect((await getTask(task.id)).phase, `${url}: ${await batch.text()}`).not.toBe('COMPLETE')
      expect((await getTask(task.id)).result_report?.owed?.toCloser).toBe(true)
      const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { force: true, reason: 'Nothing is left for the user: the record is gone.' }, vp.sid)
      expect(res.status, await res.clone().text()).toBe(200)
    }
  }, 60_000)
})

describe('an answer given in the user\'s place to the held ask ends the hold', () => {
  it('the VP answers it with answers_ask: off his Needs you, and the task\'s own close goes through', async () => {
    const project = 'Imports answered'
    const vp = await vpOf(project)
    const { task, sid } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: which of the two zone lists is final?') }, { emitEvent: true })
    const held = await heldForUser(task, project)
    const ask = held.user_status!.ask!
    const sent = await answerAsk(task, vp.sid, 'The second list is final; the first was a draft.')
    expect(sent.status, await sent.clone().text()).toBeLessThan(300)
    const answered = await getTask(task.id)
    expect(answered.result_report?.owed?.settled).toMatchObject({ how: 'taken', by: `task:${vp.task.id}` })
    await syncUserStatuses(null)
    expect((await getTask(task.id)).user_status?.state, ask).not.toBe('needs')
    // It acts on the answer: its note no longer waits on him, and it closes itself, no force.
    await updateTaskRaw(task.id, { note: NOTE('[DONE] Zone list: the second one is final') }, { emitEvent: true })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'The record is deleted; the finding resolved.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  }, 60_000)

  it('an answer taken back opens the hold again', async () => {
    const project = 'Imports withdrawn'
    const vp = await vpOf(project)
    const { task, sid } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: keep the second zone name or rename it?') }, { emitEvent: true })
    await heldForUser(task, project)
    expect((await answerAsk(task, vp.sid, 'Keep the second zone name as it is.')).status).toBeLessThan(300)
    expect((await getTask(task.id)).result_report?.owed?.settled).toBeTruthy()
    const back = await json('POST', `/api/v1/tasks/${task.id}/ask-answer/withdraw`, { reason: 'The user said he wants to decide this himself.' }, vp.sid)
    expect(back.status, await back.clone().text()).toBe(200)
    expect((await getTask(task.id)).result_report?.owed?.settled).toBeUndefined()
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Kept it.' }, sid)).status).toBe(409)
  }, 60_000)

  it('a status not yet rebuilt still showing a settled hold\'s ask holds nothing', async () => {
    const project = 'Imports stale'
    const { task, sid } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: confirm the old question is moot') }, { emitEvent: true })
    const held = await heldForUser(task, project)
    // The not-done settle ends the hold; the stored status still shows its ask until it is rebuilt.
    const vp = await vpOf(project)
    expect((await json('POST', `/api/v1/tasks/${task.id}/not-done`, { how: 'dropped', note: 'Moot: the record is already deleted.' }, vp.sid)).status).toBe(200)
    expect((await getTask(task.id)).user_status?.ask).toBe(held.user_status?.ask)
    await updateTaskRaw(task.id, { note: NOTE('[DONE] Old question: moot') }, { emitEvent: true })
    const res = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Done.' }, sid)
    expect(res.status, await res.clone().text()).toBe(200)
  }, 60_000)
})

describe('an ask of the user nobody answered still holds', () => {
  it('the same words asked again by a status built after a settle are a new ask', async () => {
    const project = 'Imports asked again'
    const { task, sid } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: confirm the zone list is final') }, { emitEvent: true })
    const held = await heldForUser(task, project)
    const vp = await vpOf(project)
    expect((await json('POST', `/api/v1/tasks/${task.id}/not-done`, { how: 'dropped', note: 'Moot: the zone list was confirmed.' }, vp.sid)).status).toBe(200)
    await updateTaskRaw(task.id, { note: NOTE('[DONE] Zone list: confirmed'), user_status: { ...held.user_status!, at: new Date(Date.now() + 60_000).toISOString() } } as never, { emitEvent: false })
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Done.' }, sid)).status).toBe(409)
  }, 60_000)

  it('its own close and another team\'s force are held; an answer to another ask changes nothing', async () => {
    const project = 'Imports open'
    const { task, sid } = await withSession('Imported finding', project)
    // A person set its line: the user's own question, open.
    expect((await json('PUT', `/api/v1/tasks/${task.id}/report`, { state: 'needs', ask: 'Delete the second zone too, or keep it?' })).status).toBe(200)
    await syncUserStatuses(null)
    expect((await getTask(task.id)).user_status).toMatchObject({ state: 'needs' })
    // An answer recorded for an older, different ask does not answer this one.
    await updateTaskRaw(task.id, { asks_answered: [{ key: 'old', ask: 'Rename the release branch?', text: 'Keep the name.', by: 'x', byTitle: 'A lead', at: new Date().toISOString() }] } as never, { emitEvent: true })
    expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Deleted the first zone.' }, sid)).status).toBe(409)
    const peer = await withSession('Peer', `Elsewhere ${n}`)
    const body = { force: true, reason: 'I think the second zone is fine to keep.' }
    for (let i = 0; i < 3; i++) expect((await json('POST', `/api/v1/tasks/${task.id}/complete`, body, peer.sid)).status).toBe(409)
    const still = await getTask(task.id)
    expect(still.phase).toBe('NEED_ACTION')
    expect(still.result_report?.owed?.settled).toBeUndefined()
  }, 60_000)
})

describe('a hold of a kind only the user decides is answered in his place only on his words', () => {
  it('every hold is written with its kind', async () => {
    const project = 'Kinds written'
    const { task } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: pay the $45 renewal invoice?') }, { emitEvent: true })
    const held = await heldForUser(task, project)
    expect(held.result_report?.owed).toMatchObject({ kind: 'spending' })
    expect(held.result_report?.owed?.kind_why).toBeTruthy()
  }, 60_000)

  it('a spending hold: answers_ask without his words is refused and the hold stays; with them it settles', async () => {
    const project = 'Kinds spending'
    const vp = await vpOf(project)
    const { task } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: pay the $45 renewal invoice?') }, { emitEvent: true })
    await heldForUser(task, project)
    const refused = await answerAsk(task, vp.sid, 'Yes, pay it.')
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('user_words')
    expect((await getTask(task.id)).result_report?.owed?.settled).toBeUndefined()
    await said(task, 'ok pay the renewal')
    const ok = await answerAsk(task, vp.sid, 'Yes, pay it.', { user_words: 'ok pay the renewal' })
    expect(ok.status, await ok.clone().text()).toBeLessThan(300)
    expect((await getTask(task.id)).result_report?.owed?.settled).toMatchObject({ how: 'taken' })
  }, 60_000)

  it('a hold written before kinds were kept whose words name none needs his words; one naming none now does not', async () => {
    const project = 'Kinds old'
    const vp = await vpOf(project)
    const { task } = await withSession('Imported finding', project)
    await updateTaskRaw(task.id, { note: NOTE('[WAIT] You: which of the two zone lists is final?') }, { emitEvent: true })
    const held = await heldForUser(task, project)
    expect(held.result_report?.owed?.kind).toBe('none')
    // The same hold as an older Walnut wrote it: no kind.
    const { kind: _k, kind_why: _w, ...old } = held.result_report!.owed!
    await updateTaskRaw(task.id, { result_report: { ...held.result_report!, owed: old } } as never, { emitEvent: true })
    expect((await answerAsk(task, vp.sid, 'The second list is final.')).status).toBe(409)
    expect((await getTask(task.id)).result_report?.owed?.settled).toBeUndefined()
  }, 60_000)
})
