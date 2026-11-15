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
async function asking(title: string, ask: string | null, parent?: string, project = 'Garden'): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project, ...(parent ? { parent_task_id: parent } : {}) } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, project, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  if (ask) await report(id, ask)
  return { id, sid }
}

/** Its turn ended asking the user `ask` (what the status question stores, report-phase moves). */
async function report(id: string, ask: string, kind = 'spending'): Promise<void> {
  await updateTask(id, { phase: 'NEED_ACTION' })
  await new Promise((r) => setTimeout(r, 5))
  await updateTaskRaw(id, { status_report: { state: 'needs', ask, ask_own: { kind, why: 'It is his own decision' }, at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
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

describe('teammates beside each other, and an ask answered above (2026-11-04, after 874bac109)', () => {
  const ASK_R = 'Should the deploy handler wait for the plugin rollout?'
  let orchardLead = ''
  const LEAD_SID = 'eeeeeeee-aaaa-4bbb-8ccc-dddddddddddd'
  let first: { id: string; sid: string }
  let second: { id: string; sid: string }

  beforeAll(async () => {
    orchardLead = (await ensureProjectLead('Orchard')).id
    await createSessionRecord(LEAD_SID, orchardLead, 'Orchard', WALNUT_HOME)
    await updateSessionRecord(LEAD_SID, { process_status: 'idle' } as never)
    first = await asking('Orchard platform lead', null, undefined, 'Orchard')
    second = await asking('Orchard CR reviews', null, undefined, 'Orchard')
    await report(first.id, ASK_R, 'user_own')
    await settle()
  })

  it('two top-level tasks of one project asking the same show it once: the one that asked first', async () => {
    await report(second.id, 'Wait for the plugin rollout in the deploy handler?', 'user_own')
    // Different words: only the sessions' own word folds it.
    await settle()
    expect((await getTask(second.id)).user_status?.state).toBe('needs')
    await updateTaskRaw(second.id, { status_report: { ...(await getTask(second.id)).status_report!, same_as: first.id } } as never, { source: 'test' })
    await settle()
    expect((await getTask(first.id)).user_status).toMatchObject({ state: 'needs', ask: ASK_R })
    expect((await getTask(second.id)).user_status).toMatchObject({ state: 'waiting', kind: 'task', sameAsk: { id: first.id, team: true } })
    const all = await listTasks()
    expect(needsIds(all.filter((t) => [first.id, second.id].includes(t.id)) as never)).toEqual([first.id])
    expect((await checkStatuses()).filter((m) => [first.id, second.id].includes(m.taskId))).toEqual([])
    // The status question names the teammate's open ask.
    expect(await sameAskQuestionFor(second.id)).toContain(`[${first.id}] Orchard platform lead (your team)`)
  })

  it('a teammate putting the same ask on the user from outside is refused, naming the one that asks', async () => {
    const res = await call('PUT', `/api/v1/tasks/${second.id}/report`, { state: 'needs', ask: ASK_R, user_kind: 'user_own', user_kind_why: 'He decides the design' }, second.sid)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toMatch(new RegExp(`same_ask[\\s\\S]*${first.id}`))
  })

  it('answers_ask from a teammate or for a task asking nothing is refused', async () => {
    const peer = await call('POST', '/api/v1/messages', { to: first.id, title: 'Decided', text: 'Wait up to ten minutes.', answers_ask: true, expect_reply: false }, second.sid)
    expect(peer.status).toBe(409)
    expect(JSON.stringify(await peer.json())).toContain('not_above')
    const idle = await asking('Orchard docs', null, undefined, 'Orchard')
    await updateTask(idle.id, { phase: 'IN_PROGRESS' })
    const none = await call('POST', '/api/v1/messages', { to: idle.id, title: 'Decided', text: 'Wait.', answers_ask: true, expect_reply: false }, LEAD_SID)
    expect(none.status).toBe(409)
    expect(JSON.stringify(await none.json())).toContain('no_open_ask')
  })

  it('the lead answering it for the user takes it off Needs you everywhere in the team, and tells the asker once', async () => {
    const res = await call('POST', '/api/v1/messages', { to: first.id, title: 'Decided: wait', text: 'Wait up to ten minutes, roll back on timeout.', answers_ask: true, expect_reply: false }, LEAD_SID)
    expect(res.status, await res.clone().text()).toBe(202)
    expect((await getTask(first.id)).ask_answered).toMatchObject({ by: orchardLead, ask: ASK_R })
    const { getQueue } = await import('../../src/core/session-message-queue.js')
    const queued = JSON.stringify(await getQueue(first.sid))
    expect(queued).toContain('took it off the user')
    // settle() runs the sync a minute ahead (past the hand-back hold), so the folds are stamped then:
    // the answer is moved after them, as it is in real time.
    const recorded = (await getTask(first.id)).ask_answered!
    await updateTaskRaw(first.id, { ask_answered: { ...recorded, at: new Date(Date.now() + 120_000).toISOString() } } as never, { source: 'test' })
    await settle()
    // The answer went in: it works on it, and its teammate folded under it reads it answered.
    expect((await getTask(first.id)).user_status?.state).not.toBe('needs')
    expect((await getTask(second.id)).user_status).toMatchObject({ state: 'waiting', sameAsk: { id: first.id, answered: true } })
    // Its next turn (the answer went in) ends repeating the ask: it stays off the user's list.
    await updateSessionRecord(first.sid, { process_status: 'idle' } as never)
    await report(first.id, ASK_R, 'user_own')
    await settle()
    expect((await getTask(first.id)).user_status).toMatchObject({ state: 'waiting', answeredFor: { by: orchardLead } })
    expect(needsIds((await listTasks()).filter((t) => [first.id, second.id].includes(t.id)) as never)).toEqual([])
    expect(await sameAskQuestionFor(first.id)).toContain('answered your ask for the user')
    // A different ask of its own is its own again.
    await report(first.id, 'Pick the alpha launch date for the plugin?', 'user_own')
    await settle()
    expect((await getTask(first.id)).user_status).toMatchObject({ state: 'needs', ask: 'Pick the alpha launch date for the plugin?' })
  })
})

describe('answers_ask guards (2026-11-04 review)', () => {
  const LEAD2_SID = 'dddddddd-aaaa-4bbb-8ccc-dddddddddddd'
  let lead2 = ''
  beforeAll(async () => {
    lead2 = (await ensureProjectLead('Meadow')).id
    await createSessionRecord(LEAD2_SID, lead2, 'Meadow', WALNUT_HOME)
    await updateSessionRecord(LEAD2_SID, { process_status: 'idle' } as never)
  })

  it('an ask only the user approves is answered in his place only with his words', async () => {
    const t = await asking('Meadow spend', null, undefined, 'Meadow')
    await report(t.id, 'Approve buying the paid plan for the Meadow tests?')
    await settle()
    const bare = await call('POST', '/api/v1/messages', { to: t.id, title: 'Yes', text: 'Buy it.', answers_ask: true, expect_reply: false }, LEAD2_SID)
    expect(bare.status).toBe(409)
    expect(JSON.stringify(await bare.json())).toContain('user_words')
    const quoted = await call('POST', '/api/v1/messages', { to: t.id, title: 'Yes', text: 'Buy it.', answers_ask: true, expect_reply: false, user_words: 'yes buy the paid plan for meadow' }, LEAD2_SID)
    expect(quoted.status, await quoted.clone().text()).toBe(202)
    expect((await getTask(t.id)).ask_answered).toMatchObject({ by: lead2, userWords: 'yes buy the paid plan for meadow' })
  })

  it('a task whose ask shows on another is answered there: Walnut names that task', async () => {
    const a = await asking('Meadow holder', null, undefined, 'Meadow')
    const b = await asking('Meadow follower', null, undefined, 'Meadow')
    for (const t of [a, b]) await report(t.id, 'Rename the Meadow staging stage to beta?', 'user_own')
    await settle()
    const holder = (await getTask(b.id)).user_status?.sameAsk ? a : b
    const follower = holder === a ? b : a
    expect((await getTask(follower.id)).user_status).toMatchObject({ sameAsk: { id: holder.id, team: true } })
    const res = await call('POST', '/api/v1/messages', { to: follower.id, title: 'Yes', text: 'Rename it.', answers_ask: true, expect_reply: false }, LEAD2_SID)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain(holder.id)
    // Answered where it shows, the follower is told once that it was answered there.
    const ok = await call('POST', '/api/v1/messages', { to: holder.id, title: 'Yes', text: 'Rename it.', answers_ask: true, expect_reply: false }, LEAD2_SID)
    expect(ok.status).toBe(202)
    const rec = (await getTask(holder.id)).ask_answered!
    await updateTaskRaw(holder.id, { ask_answered: { ...rec, at: new Date(Date.now() + 120_000).toISOString() } } as never, { source: 'test' })
    await settle()
    expect((await getTask(follower.id)).user_status).toMatchObject({ state: 'waiting', sameAsk: { id: holder.id, answered: true } })
    const { getQueue } = await import('../../src/core/session-message-queue.js')
    await expect.poll(async () => JSON.stringify(await getQueue(follower.sid)), { timeout: 5_000 }).toContain('it was answered there')
  })
})
