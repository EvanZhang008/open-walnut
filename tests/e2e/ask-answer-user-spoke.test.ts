/**
 * A task that settles another task's ask in the user's place (task_send answers_ask, task_report_set)
 * is shown what the user wrote in that task, and is refused (409 user_spoke_since, his words quoted)
 * when he wrote there after the ask appeared, until it passes his words back in user_words
 * (2026-11-07, Main's reflection: Main answered "local only" to a task where the user had just
 * written "submit the cr"). A real server, real task, session and user-ask stores, the real send path
 * for the user's own message.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-answer-user-spoke'))

/** Every message put into a session, by session id and text: the real queue, recorded on the way in. */
const sentTo = vi.hoisted(() => [] as Array<{ sid: string; text: string }>)
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return {
    ...real,
    sendMessageToSession: ((sid: string, text: string, ...rest: unknown[]) => {
      sentTo.push({ sid, text })
      return (real.sendMessageToSession as (...a: unknown[]) => unknown)(sid, text, ...rest)
    }) as typeof real.sendMessageToSession,
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { readUserAsks } from '../../src/core/sessions/user-asks.js'
import { applyStatusAnswer } from '../../src/core/sessions/status-question.js'
import type { StatusReport } from '../../src/core/user-status.js'
import { markNextProcessing, removeProcessed } from '../../src/core/session-message-queue.js'

const LEAD_SID = 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd'
const PROJECT = 'Pear'
let base = ''
let lead = ''
let n = 0

/** A task whose idle session asks the user `ask` in its own turn-end report (the real writer). */
async function asking(title: string, ask: string): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project: PROJECT } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-2222-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, PROJECT, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  await updateTask(id, { phase: 'NEED_ACTION' })
  await reports(id, sid, ask)
  return { id, sid }
}

/** The task's own turn-end report asking `ask`, stored by the real writer (status-question.ts). */
async function reports(id: string, sid: string, ask: string): Promise<void> {
  await tick()
  // The turn took what was queued for it (the user's message), as a running CLI does.
  await markNextProcessing(sid)
  await removeProcessed(sid)
  // ...and its turn ended: the CLI is idle again.
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  const report: StatusReport = { state: 'needs', ask, ask_own: { kind: 'user_own', why: 'It is his own decision' }, at: new Date().toISOString() }
  expect(await applyStatusAnswer(id, sid, report, Date.now())).toBe(true)
  // A turn that answered his message is handed back as its report says (report-phase.ts runs at the turn's end).
  if ((await getTask(id)).phase !== 'NEED_ACTION') await updateTask(id, { phase: 'NEED_ACTION' })
  await settle()
  expect((await getTask(id)).user_status, `${id} asks the user`).toMatchObject({ state: 'needs', ask })
}

const tick = () => new Promise((r) => setTimeout(r, 8))

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

/** The user types into the task's chat: the chat's own send route, no caller session (a person). */
async function userWrites(taskId: string, text: string): Promise<void> {
  await tick()
  const sid = (await getTask(taskId)).session_id
  const res = await fetch(`${base}/api/v1/sessions/${sid}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  expect(res.status, await res.clone().text()).toBe(202)
  // Filed by the send's own commit, not awaited by the route (hint-send.ts).
  await vi.waitFor(async () => expect((await readUserAsks(taskId)).asks.map((a) => a.text)).toContain(text), { timeout: 5000 })
  await tick()
}

async function post(path: string, method: string, body: Record<string, unknown>, sid: string | null = LEAD_SID): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const answer = (body: Record<string, unknown>, sid: string | null = LEAD_SID) =>
  post('/messages', 'POST', { title: 'Decided', expect_reply: false, answers_ask: true, ...body }, sid)

const told = (sid: string, words: string) => sentTo.some((m) => m.sid === sid && m.text.includes(words))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lead = (await ensureProjectLead(PROJECT)).id
  await createSessionRecord(LEAD_SID, lead, PROJECT, WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'idle' } as never)
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('answers_ask after the user wrote in the task', () => {
  it('is refused with his words quoted, nothing recorded or sent; passing them back answers it, and shows them', async () => {
    const t = await asking('Pulse cost CR', 'Submit the pulse cost CR, or keep the change local only?')
    await userWrites(t.id, 'submit the cr, tag the reviewers')
    const refused = await answer({ to: t.id, text: 'Keep it local only.' })
    expect(refused.status, JSON.stringify(refused.json)).toBe(409)
    expect(refused.json.error ?? refused.json.code).toBeDefined()
    expect(JSON.stringify(refused.json)).toContain('user_spoke_since')
    expect(JSON.stringify(refused.json)).toContain('submit the cr, tag the reviewers')
    expect((await getTask(t.id)).ask_answered).toBeUndefined()
    expect(told(t.sid, 'Keep it local only')).toBe(false)

    // Words that do not pass his message back are refused the same way.
    const vague = await answer({ to: t.id, text: 'Keep it local only.', user_words: 'He is fine with whatever we decide.' })
    expect(vague.status).toBe(409)

    const ok = await answer({ to: t.id, text: 'Submit the CR as he said.', user_words: 'The user wrote: "Submit the CR, tag the reviewers".' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(202)
    expect(ok.json).toMatchObject({ delivery: 'queued', userSaid: { spokeSince: true, words: [{ text: 'submit the cr, tag the reviewers' }] } })
    expect((await getTask(t.id)).ask_answered).toMatchObject({ by: lead, userWords: expect.stringContaining('tag the reviewers') })
    expect(told(t.sid, 'Submit the CR as he said')).toBe(true)
  })

  it('counts from when the task began asking: a reworded ask after his words still needs them', async () => {
    const t = await asking('ORR review', 'Start the ORR fixes now?')
    await userWrites(t.id, 'discuss before doing anything')
    // Its next turn asks again in other words; it has asked all along.
    await reports(t.id, t.sid, 'Which ORR fix goes first: alarms or runbook?')
    const r = await answer({ to: t.id, text: 'Go ahead, stop asking him.' })
    expect(r.status, JSON.stringify(r.json)).toBe(409)
    expect(JSON.stringify(r.json)).toContain('discuss before doing anything')
    expect(told(t.sid, 'stop asking him')).toBe(false)
  })

  it('a task that is not running is refused too: the recorded answer reads his words first', async () => {
    const t = await asking('Bucket cleanup', 'Delete the old pear bucket snapshots now?')
    await userWrites(t.id, 'keep the snapshots until friday')
    await updateSessionRecord(t.sid, { process_status: 'stopped' } as never)
    const r = await answer({ to: t.id, text: 'Delete them.' })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.json)).toContain('keep the snapshots until friday')
    expect((await getTask(t.id)).ask_answered).toBeUndefined()
    const ok = await answer({ to: t.id, text: 'Keep them until Friday.', user_words: 'keep the snapshots until friday' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(202)
    expect(ok.json).toMatchObject({ delivery: 'recorded', userSaid: { spokeSince: true } })
  })

  it('words he wrote before the ask are shown, never refused', async () => {
    n += 1
    const id = (await addTask({ title: 'Label colors', project: PROJECT } as never)).task.id
    const sid = `${String(n).padStart(8, '0')}-2222-4bbb-8ccc-dddddddddddd`
    await createSessionRecord(sid, id, PROJECT, WALNUT_HOME)
    await updateSessionRecord(sid, { process_status: 'idle' } as never)
    await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
    await userWrites(id, 'make the labels green')
    await updateTask(id, { phase: 'NEED_ACTION' })
    await reports(id, sid, 'Green or teal for the pear labels?')
    const r = await answer({ to: id, text: 'Green.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json).toMatchObject({ userSaid: { spokeSince: false, words: [{ text: 'make the labels green' }] } })
  })

  it('the user answering it himself is never refused', async () => {
    const t = await asking('Release notes', 'Publish the pear release notes today?')
    await userWrites(t.id, 'wait, let me reread them')
    await reports(t.id, t.sid, 'Publish the pear release notes today?')
    const r = await answer({ to: t.id, text: 'Yes, publish them.' }, null)
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.userSaid).toBeUndefined()
  })
})

describe('task_report_set taking an ask off Needs you after the user wrote', () => {
  it('is refused with his words; passing them back sets the line; keeping the same ask is no settling', async () => {
    const ask = 'Merge the pear schema change before the freeze?'
    const t = await asking('Schema freeze', ask)
    await userWrites(t.id, 'not before the freeze, after')
    const refused = await post(`/tasks/${t.id}/report`, 'PUT', { state: 'working', next: 'It merges the schema change now.' })
    expect(refused.status, JSON.stringify(refused.json)).toBe(409)
    expect(JSON.stringify(refused.json)).toContain('not before the freeze, after')
    expect((await getTask(t.id)).status_report).toMatchObject({ state: 'needs', ask })

    // The same ask written again settles nothing, so it is not gated.
    const same = await post(`/tasks/${t.id}/report`, 'PUT', { state: 'needs', ask, user_kind: 'user_own', user_kind_why: 'It is his own decision' })
    expect(same.status, JSON.stringify(same.json)).toBe(200)

    const ok = await post(`/tasks/${t.id}/report`, 'PUT', { state: 'working', next: 'It merges after the freeze.', user_words: 'not before the freeze, after' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json).toMatchObject({ userSaid: { spokeSince: true, words: [{ text: 'not before the freeze, after' }] } })
    expect((await getTask(t.id)).status_report).toMatchObject({ state: 'working' })
  })
})

describe('other ways a task takes the ask off Needs you', () => {
  it('a phase write by the lead (task_update) is refused with his words, then goes with them passed back', async () => {
    const t = await asking('Index rebuild', 'Rebuild the pear search index tonight?')
    await userWrites(t.id, 'only on the weekend please')
    // His message started a turn, which ended asking the same (back to NEED_ACTION).
    await reports(t.id, t.sid, 'Rebuild the pear search index tonight?')
    const refused = await post(`/tasks/${t.id}`, 'PATCH', { phase: 'IN_PROGRESS' })
    expect(refused.status, JSON.stringify(refused.json)).toBe(409)
    expect(JSON.stringify(refused.json)).toContain('only on the weekend please')
    expect((await getTask(t.id)).phase).toBe('NEED_ACTION')
    const ok = await post(`/tasks/${t.id}`, 'PATCH', { phase: 'IN_PROGRESS', user_words: 'He said: only on the weekend please' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json).toMatchObject({ userSaid: { spokeSince: true } })
    expect((await getTask(t.id)).phase).toBe('IN_PROGRESS')
  })

  it('a close by the lead is held with his words named; after he writes again a force is held again', async () => {
    const t = await asking('Cache purge', 'Purge the pear CDN cache now?')
    await userWrites(t.id, 'purge only the images folder')
    await reports(t.id, t.sid, 'Purge the pear CDN cache now?')
    await updateSessionRecord(t.sid, { process_status: 'stopped' } as never)
    // He wrote in it this week, so a close by another task needs force (task_in_use); the hold comes next.
    const held = await post(`/tasks/${t.id}/complete`, 'POST', { force: true, reason: 'The purge is not needed any more.' })
    expect(held.status, JSON.stringify(held.json)).toBe(409)
    expect(JSON.stringify(held.json)).toContain('owed_to_user')
    expect(JSON.stringify(held.json)).toContain('purge only the images folder')
    await userWrites(t.id, 'actually wait for the release')
    const forced = await post(`/tasks/${t.id}/complete`, 'POST', { force: true, reason: 'The purge is no longer needed.' })
    expect(forced.status, JSON.stringify(forced.json)).toBe(409)
    expect(JSON.stringify(forced.json)).toContain('actually wait for the release')
    expect((await getTask(t.id)).phase).not.toBe('COMPLETE')
    // Told of everything he wrote, the force closes it.
    const closed = await post(`/tasks/${t.id}/complete`, 'POST', { force: true, reason: 'He asked to wait for the release; a new task will purge then.' })
    expect(closed.status, JSON.stringify(closed.json)).toBe(200)
    expect((await getTask(t.id)).phase).toBe('COMPLETE')
  })

  it('a plain message to it shows his words beside the ask', async () => {
    const t = await asking('Label font', 'Serif or sans for the pear labels?')
    await userWrites(t.id, 'sans, like the old ones')
    const r = await post('/messages', 'POST', { to: t.id, title: 'Note', text: 'Thinking about the font.', expect_reply: false })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json).toMatchObject({ openAsk: 'Serif or sans for the pear labels?', userSaid: { spokeSince: true, words: [{ text: 'sans, like the old ones' }] } })
  })
})
