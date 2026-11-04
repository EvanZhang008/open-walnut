/**
 * A parent and its subtask asking the user the same decision show it once, against a real server
 * (src/core/same-ask.ts; 2026-11-04: a lead and its subtask both sat in Needs you asking whether to
 * create three alpha test accounts, and Main had them merged by hand).
 *
 *  - the stored status: the subtask's ask shows, the lead reads Waiting on it, and every surface
 *    reading user_status (the web list, the v1 list the phone reads, the Org counts, a VP's Brief,
 *    the leader's rolled asks) has one Needs you;
 *  - answering the subtask settles both: the lead stays off the user's list;
 *  - the writes: a report line, a decision letter and a Thread put on the user while a task in the
 *    tree already asks the same are refused (409 same_ask, that task named), and go with a reason;
 *  - the turn-end status question lists the tree's open asks.
 * Only the Claude CLI is mocked (nothing here runs one).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-same-ask'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, listTasks, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { briefSectionLines } from '../../src/core/sessions/brief.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { sameAskQuestionFor } from '../../src/core/same-ask-tree.js'
import { checkStatuses } from '../../src/core/status-consistency.js'

const ASK_LEAD = 'Should we create three alpha test accounts?'
const ASK_CHILD = 'Create the three alpha test accounts?'
let base = ''
let n = 0

/** A task whose session ran a turn and sits idle, `ask`ing the user in its own turn-end report. */
async function asking(title: string, ask: string | null, parent?: string): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project: 'Garden', ...(parent ? { parent_task_id: parent } : {}) } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, 'Garden', WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  if (ask) await report(id, ask)
  return { id, sid }
}

/** Its turn ended asking the user `ask` (what the status question stores, report-phase moves). */
async function report(id: string, ask: string): Promise<void> {
  await updateTask(id, { phase: 'NEED_ACTION' })
  await new Promise((r) => setTimeout(r, 5))
  await updateTaskRaw(id, { status_report: { state: 'needs', ask, ask_own: { kind: 'spending', why: 'It creates paid accounts' }, at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
}

/** The sync runs one level per pass (a leader re-derives from its subtasks' stored statuses). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

async function call(method: string, url: string, body: unknown, callerSid?: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, body: JSON.stringify(body),
  })
}

let lead: { id: string; sid: string }
let child: { id: string; sid: string }
let vpId = ''

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vpId = (await ensureProjectLead('Garden')).id
  lead = await asking('Platform lead', ASK_LEAD)
  child = await asking('Alpha stages', ASK_CHILD, lead.id)
  await settle()
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const needsIds = (rows: Array<{ id: string; user_status?: { state?: string } }>) => rows.filter((t) => t.user_status?.state === 'needs').map((t) => t.id)

describe('a parent and its subtask ask the same decision', () => {
  it('the subtask\'s ask shows; the lead reads Waiting on it', async () => {
    expect((await getTask(child.id)).user_status).toMatchObject({ state: 'needs', ask: ASK_CHILD })
    const us = (await getTask(lead.id)).user_status
    expect(us).toMatchObject({ state: 'waiting', kind: 'task', sameAsk: { id: child.id, title: 'Alpha stages', ask: ASK_CHILD } })
    expect(us?.waitingOn).toContain('Alpha stages')
    // The leader still carries the subtask's ask up, once.
    expect(us?.asks?.map((a) => a.id)).toEqual([child.id])
  })

  it('every surface reading the status lists one Needs you', async () => {
    const web = await (await fetch(`${base}/api/tasks`)).json() as { tasks?: never[] } | never[]
    const webRows = (Array.isArray(web) ? web : web.tasks ?? []) as Array<{ id: string; user_status?: { state?: string } }>
    expect(needsIds(webRows.filter((t) => [lead.id, child.id].includes(t.id)))).toEqual([child.id])
    const v1 = await (await fetch(`${base}/api/v1/tasks?limit=200`)).json() as { tasks?: never[] }
    const v1Rows = (v1.tasks ?? []) as Array<{ id: string; user_status?: { state?: string } }>
    expect(needsIds(v1Rows.filter((t) => [lead.id, child.id].includes(t.id)))).toEqual([child.id])
    const all = await listTasks()
    expect(buildOrgTree(all as never).counts.needsYou).toBe(1)
    const lines = briefSectionLines(await getTask(vpId), all)
    expect(lines.needs).toHaveLength(1)
    expect(lines.needs[0]).toContain(child.id)
    // The hourly consistency check derives the same status: no drift to report.
    expect((await checkStatuses()).filter((m) => m.taskId === lead.id)).toEqual([])
  })

  it('the lead\'s next status question names the subtask\'s open ask', async () => {
    const block = await sameAskQuestionFor(lead.id)
    expect(block).toContain(`[${child.id}] Alpha stages (your subtask)`)
    expect(block).toContain(ASK_CHILD)
    expect(block).toContain('FOR_USER_ASK_SAME')
    expect(await sameAskQuestionFor(vpId)).toContain(child.id)
  })

  it('the subtask asking what its lead asks is the deeper one: its line goes through', async () => {
    const res = await call('PUT', `/api/v1/tasks/${child.id}/report`, { state: 'needs', ask: ASK_LEAD, user_kind: 'spending', user_kind_why: 'It creates paid accounts' }, child.sid)
    expect(res.status, await res.clone().text()).toBe(200)
    await report(child.id, ASK_CHILD)
    await settle()
  })

  it('a report line, a letter and a Thread asking it again are refused, naming the subtask', async () => {
    const line = await call('PUT', `/api/v1/tasks/${lead.id}/report`, { state: 'needs', ask: ASK_LEAD, user_kind: 'spending', user_kind_why: 'It creates paid accounts' }, lead.sid)
    expect(line.status).toBe(409)
    const lineBody = await line.json() as { error?: { code?: string; message?: string }; code?: string; message?: string }
    expect(JSON.stringify(lineBody)).toContain('same_ask')
    expect(JSON.stringify(lineBody)).toContain(child.id)

    const letter = { type: 'action_required', subject: ASK_LEAD, markdown: 'Three accounts for the alpha stages.', actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], user_kind: 'spending', user_kind_why: 'It creates paid accounts' }
    const sent = await call('POST', '/api/v1/human-inbox', letter, lead.sid)
    expect(sent.status).toBe(409)
    expect(JSON.stringify(await sent.json())).toMatch(/same_ask[\s\S]*Alpha stages/)
    // With a reason it is a different decision and goes.
    const again = await call('POST', '/api/v1/human-inbox', { ...letter, subject: `${ASK_LEAD} (billing owner)`, same_ask_reason: 'It asks who owns the bill, not whether to create them' }, lead.sid)
    expect(again.status).toBe(201)

    const VP_SID = 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd'
    await createSessionRecord(VP_SID, vpId, 'Garden', WALNUT_HOME)
    await updateSessionRecord(VP_SID, { process_status: 'stopped' } as never)
    const thread = await call('POST', `/api/v1/tasks/${vpId}/threads/open`, { title: ASK_LEAD, text: 'The alpha stages need accounts', from: 'task', user_kind: 'spending', user_kind_why: 'It creates paid accounts' }, VP_SID)
    expect(thread.status).toBe(409)
    expect(JSON.stringify(await thread.json())).toContain('same_ask')
    // Opened answered (nothing handed to him), then moved to needs: refused the same way.
    const opened = await call('POST', `/api/v1/tasks/${vpId}/threads/open`, { title: ASK_LEAD, text: 'The alpha stages need accounts', from: 'task', state: 'answered' }, VP_SID)
    expect(opened.status).toBe(201)
    const tid = ((await opened.json()) as { thread: { id: string } }).thread.id
    const moved = await call('PATCH', `/api/v1/tasks/${vpId}/threads/${tid}`, { state: 'needs', user_kind: 'spending', user_kind_why: 'It creates paid accounts' }, VP_SID)
    expect(moved.status).toBe(409)
    // The user's own move is never asked.
    expect((await call('PATCH', `/api/v1/tasks/${vpId}/threads/${tid}`, { state: 'needs' })).status).toBe(200)
  })

  it('answering the subtask settles both: the lead stays off the user\'s list', async () => {
    // With no word from the user to the subtask, its ask leaving brings the lead's own back.
    await updateTask(child.id, { phase: 'IN_PROGRESS' })
    await updateTaskRaw(child.id, { status_report: { state: 'working', now: 'Moved on', at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
    await settle()
    expect((await getTask(lead.id)).user_status).toMatchObject({ state: 'needs', ask: ASK_LEAD })
    await report(child.id, ASK_CHILD)
    await settle()
    expect((await getTask(lead.id)).user_status).toMatchObject({ state: 'waiting', sameAsk: { id: child.id } })
    // The user answers the subtask in its session; its next turn works on it.
    // settle() runs the sync a minute ahead (past the hand-back hold), so the fold is stamped then.
    await updateSessionRecord(child.sid, { humanInputAt: new Date(Date.now() + 120_000).toISOString() } as never)
    await updateTask(child.id, { phase: 'IN_PROGRESS' })
    await updateTaskRaw(child.id, { status_report: { state: 'working', now: 'Creating the accounts', at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
    await updateSessionRecord(child.sid, { process_status: 'running' } as never)
    await settle()
    expect((await getTask(child.id)).user_status?.state).toBe('working')
    const us = (await getTask(lead.id)).user_status
    expect(us).toMatchObject({ state: 'waiting', kind: 'task', sameAsk: { id: child.id, answered: true } })
    expect(needsIds(await listTasks() as never)).toEqual([])
    // A new ask of the lead's own, after that, is its own again.
    await report(lead.id, 'Pick the launch date for the alpha?')
    await settle()
    expect((await getTask(lead.id)).user_status).toMatchObject({ state: 'needs', ask: 'Pick the launch date for the alpha?' })
  })

  it('a different decision under the same lead is never folded', async () => {
    const other = await asking('Design docs', 'Publish the design doc to the wiki?', lead.id)
    await settle()
    expect((await getTask(other.id)).user_status).toMatchObject({ state: 'needs' })
    expect((await getTask(lead.id)).user_status).toMatchObject({ state: 'needs', ask: 'Pick the launch date for the alpha?' })
  })
})
