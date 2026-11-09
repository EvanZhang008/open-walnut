/**
 * An answer given in the user's place can be taken back (task_ask_answer_withdraw), and an answer that
 * quotes his words is refused while he wrote newer ones in the task (2026-11-08, the Personal VP's
 * reflection: it answered a task's ask on his "no inspection" of the day before, the task's
 * email was one he had since asked for, and the answer could not be undone, so the ask never came back
 * to his Needs you). A real server, real task, session, user-ask and Threads stores, the real send path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-answer-withdraw'))

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
import { getQueue, markNextProcessing, removeProcessed } from '../../src/core/session-message-queue.js'
import { fileThreadMessage } from '../../src/core/org/threads-store.js'

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


const withdraw = (id: string, body: Record<string, unknown> = {}, sid: string | null = LEAD_SID) => post(`/tasks/${id}/ask-answer/withdraw`, 'POST', body, sid)
const queued = async (sid: string) => (await getQueue(sid)).map((m) => m.message).join('\n')
const NOTE = 'took back the answer'
/** The session took what was queued, and its turn ended: idle again, as a running CLI is. */
async function drain(sid: string): Promise<void> {
  await markNextProcessing(sid)
  await removeProcessed(sid)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
}
/** A task with an idle session that asks nothing yet. */
async function idleTask(title: string): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project: PROJECT } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-2222-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, PROJECT, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  return { id, sid }
}
/** The answer's turn ends and its report still asks the same (the real case: it kept its ask). */
async function asksAgain(id: string, sid: string, ask: string): Promise<void> {
  await drain(sid)
  await tick()
  const report: StatusReport = { state: 'needs', ask, ask_own: { kind: 'user_own', why: 'It is his own decision' }, at: new Date().toISOString() }
  expect(await applyStatusAnswer(id, sid, report, Date.now())).toBe(true)
  if ((await getTask(id)).phase !== 'NEED_ACTION') await updateTask(id, { phase: 'NEED_ACTION' })
  await settle()
}

describe('taking back an answer given in the user\'s place', () => {
  it('the ask goes back on Needs you, the record stays, and an idle task hears it with its next message only', async () => {
    const ask = 'Email the pear vendor to confirm in writing whether an order ships without audits?'
    const t = await asking('Pear vendor', ask)
    const a = await answer({ to: t.id, text: 'Do not send it; he refused audits.' })
    expect(a.status, JSON.stringify(a.json)).toBe(202)
    await asksAgain(t.id, t.sid, ask)
    expect((await getTask(t.id)).user_status).toMatchObject({ state: 'waiting', answeredFor: { by: lead, ask } })

    // A session says why.
    const bare = await withdraw(t.id)
    expect(bare.status, JSON.stringify(bare.json)).toBe(409)
    expect(JSON.stringify(bare.json)).toContain('reason')

    const w = await withdraw(t.id, { reason: 'He asked for this email himself after refusing audits.' })
    expect(w.status, JSON.stringify(w.json)).toBe(200)
    expect(w.json).toMatchObject({ needsAgain: true, withdrawn: { ask, by: lead, answeredBy: lead, told: 'next_message' } })
    await settle()
    const after = await getTask(t.id)
    expect(after.user_status).toMatchObject({ state: 'needs', ask })
    expect(after.user_status?.answeredFor).toBeUndefined()
    expect(after.ask_answered).toBeUndefined()
    expect(after.asks_answered).toBeUndefined()
    expect(after.asks_withdrawn).toMatchObject([{ ask, text: 'Do not send it; he refused audits.', told: 'next_message', needsAgain: true }])
    // Not woken for it.
    expect(await queued(t.sid)).not.toContain(NOTE)

    // His next message carries it, once.
    await userWrites(t.id, 'yes, send the vendor that email')
    const rows = await queued(t.sid)
    expect(rows).toContain(NOTE)
    expect(rows).toContain('He asked for this email himself')
    await drain(t.sid)
    await userWrites(t.id, 'and copy me')
    expect(await queued(t.sid)).not.toContain(NOTE)
    expect((await getTask(t.id)).asks_withdrawn).toMatchObject([{ told: 'now' }])

    // Nothing left to take back.
    const again = await withdraw(t.id, { reason: 'Second try at the same withdrawal.' })
    expect(again.status).toBe(409)
    expect(JSON.stringify(again.json)).toContain('no_answer')
  })

  it('a running turn hears it now; a task that moved on hears it now when idle', async () => {
    const t = await asking('Pear deploy window', 'Deploy the pear service on Saturday?')
    expect((await answer({ to: t.id, text: 'Saturday is fine.' })).status).toBe(202)
    await drain(t.sid)
    await updateSessionRecord(t.sid, { process_status: 'running' } as never)
    const w = await withdraw(t.id, { reason: 'He said no weekend deploys this month.' })
    expect(w.status, JSON.stringify(w.json)).toBe(200)
    expect(w.json).toMatchObject({ withdrawn: { told: 'now' } })
    // Into its queue now (the real queue: the module mock above does not see a send made from inside it).
    expect(await queued(t.sid)).toContain(NOTE)

    const u = await asking('Pear label size', 'Print the pear labels at 40 mm?')
    expect((await answer({ to: u.id, text: 'Yes, 40 mm.' })).status).toBe(202)
    await drain(u.sid)
    // It took the answer and moved on: its report no longer asks.
    await updateTaskRaw(u.id, (cur) => ({ status_report: { ...cur.status_report!, state: 'working', ask: undefined } }) as never, { source: 'test' })
    const w2 = await withdraw(u.id, { reason: 'The printer only takes 50 mm now.' })
    expect(w2.json).toMatchObject({ needsAgain: false, withdrawn: { told: 'now' } })
    expect(await queued(u.sid)).toContain('The printer only takes 50 mm now')
  })

  it('who may: the user (no reason needed), not a task outside the team; a complete task is not told', async () => {
    const t = await asking('Pear cover photo', 'Use the orchard photo on the pear cover?')
    expect((await answer({ to: t.id, text: 'The orchard photo.' })).status).toBe(202)
    await drain(t.sid)

    const otherLead = (await ensureProjectLead('Plum')).id
    const OTHER_SID = 'eeeeeeee-aaaa-4bbb-8ccc-dddddddddddd'
    await createSessionRecord(OTHER_SID, otherLead, 'Plum', WALNUT_HOME)
    await updateSessionRecord(OTHER_SID, { process_status: 'idle' } as never)
    const outsider = await withdraw(t.id, { reason: 'Another team thinks otherwise.' }, OTHER_SID)
    expect(outsider.status, JSON.stringify(outsider.json)).toBe(409)
    expect(JSON.stringify(outsider.json)).toContain('not_above')
    expect((await getTask(t.id)).ask_answered).toBeDefined()

    const person = await withdraw(t.id, {}, null)
    expect(person.status, JSON.stringify(person.json)).toBe(200)
    expect(person.json).toMatchObject({ withdrawn: { by: 'human', byTitle: 'The user' } })

    const c = await asking('Pear archive', 'Archive the 2025 pear photos?')
    expect((await answer({ to: c.id, text: 'Archive them.' })).status).toBe(202)
    await drain(c.sid)
    await updateTask(c.id, { phase: 'COMPLETE' })
    const done = await withdraw(c.id, { reason: 'He wants to keep them out.' })
    expect(done.status, JSON.stringify(done.json)).toBe(200)
    expect(done.json).toMatchObject({ withdrawn: { told: 'not' } })
    expect((await getTask(c.id)).phase).toBe('COMPLETE')
  })
})

describe('an answer quoting his words, while he wrote newer ones in the task', () => {
  it('is refused naming the newer words, though he wrote them before the ask; quoting them too lets it through', async () => {
    // His older word, in the lead's own Threads.
    const old = new Date(Date.now() - 3_600_000).toISOString()
    await fileThreadMessage(lead, { text: 'no audits for the pear flat, final', images: [], via: 'chat', newThreadId: 'th-aaaaaa000009', messageId: 'tm-aaaaaa000009', at: old, lang: 'en' } as never)
    n += 1
    const id = (await addTask({ title: 'Pear shop vendor', project: PROJECT } as never)).task.id
    const sid = `${String(n).padStart(8, '0')}-2222-4bbb-8ccc-dddddddddddd`
    await createSessionRecord(sid, id, PROJECT, WALNUT_HOME)
    await updateSessionRecord(sid, { process_status: 'idle' } as never)
    await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
    // Later, in the task: he wants the email.
    await userWrites(id, 'ask the vendor in writing whether an order ships')
    await updateTask(id, { phase: 'NEED_ACTION' })
    await reports(id, sid, 'Email the vendor for written confirmation about orders?')

    const refused = await answer({ to: id, text: 'Do not send it.', user_words: 'no audits for the pear flat, final' })
    expect(refused.status, JSON.stringify(refused.json)).toBe(409)
    expect(JSON.stringify(refused.json)).toContain('user_spoke_since')
    expect(JSON.stringify(refused.json)).toContain('ask the vendor in writing whether an order ships')
    expect((await getTask(id)).ask_answered).toBeUndefined()

    // A quote Walnut cannot place: his recent words there are asked for too.
    const unplaced = await answer({ to: id, text: 'Do not send it.', user_words: 'He told me on a call: no more vendor questions' })
    expect(unplaced.status, JSON.stringify(unplaced.json)).toBe(409)
    expect(JSON.stringify(unplaced.json)).toContain('cannot tell when')

    const ok = await answer({ to: id, text: 'Send it, he asked for it.', user_words: '"no audits for the pear flat, final", then "ask the vendor in writing whether an order ships"' })
    expect(ok.status, JSON.stringify(ok.json)).toBe(202)
    // Placed at the older words it quotes; the newer one is passed back too.
    expect(ok.json).toMatchObject({ userSaid: { quotedAt: old, afterQuote: [{ text: 'ask the vendor in writing whether an order ships' }] } })
  })
})

describe('a teammate whose same ask read answered there', () => {
  it('reads it answered no more once the answer is taken back, and is told with its next message', async () => {
    const ask = 'Rotate the pear signing key this week, before the release?'
    const a = await asking('Pear signing key', ask)
    const b = await idleTask('Pear release checklist')
    await asksAgain(b.id, b.sid, ask)
    // One of the two shows it; the other waits on it.
    const holder = (await getTask(a.id)).user_status?.sameAsk ? b : a
    const other = holder === a ? b : a
    expect((await getTask(other.id)).user_status?.sameAsk?.id).toBe(holder.id)
    expect((await answer({ to: holder.id, text: 'Rotate it this week.' })).status).toBe(202)
    await asksAgain(holder.id, holder.sid, ask)
    // Its turn (if the fold note woke one) ends asking the same.
    await asksAgain(other.id, other.sid, ask)
    expect((await getTask(other.id)).user_status?.sameAsk, JSON.stringify((await getTask(other.id)).user_status)).toMatchObject({ id: holder.id, answered: true })

    const w = await withdraw(holder.id, { reason: 'He wants the key rotated only after the release.' })
    expect(w.status, JSON.stringify(w.json)).toBe(200)
    expect(w.json).toMatchObject({ needsAgain: true, teammates: [{ id: other.id, told: 'next_message' }] })
    await settle()
    // Still one ask for the user: the holder's, open again, and the teammate no longer reads it answered.
    expect((await getTask(holder.id)).user_status).toMatchObject({ state: 'needs', ask })
    const otherStatus = (await getTask(other.id)).user_status
    expect(otherStatus?.sameAsk?.answered).toBeUndefined()
    expect((await getTask(other.id)).asks_withdrawn).toMatchObject([{ via: { id: holder.id }, told: 'next_message' }])
    await userWrites(other.id, 'what is left on the checklist?')
    expect(await queued(other.sid)).toContain(NOTE)
  })
})

describe('his newer words in a teammate folded under the task', () => {
  it('count against an answer quoting his older words', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString()
    await fileThreadMessage(lead, { text: 'do not send the pear vendor email', images: [], via: 'chat', newThreadId: 'th-aaaaaa000010', messageId: 'tm-aaaaaa000010', at: old, lang: 'en' } as never)
    const ask = 'Send the pear vendor the order confirmation email now?'
    const a = await asking('Pear order email', ask)
    const { id, sid } = await idleTask('Pear order follow-up')
    await userWrites(id, 'please do send the vendor that email')
    await updateTask(id, { phase: 'NEED_ACTION' })
    await asksAgain(id, sid, ask)
    const folded = (await getTask(id)).user_status?.sameAsk?.id === a.id ? a : null
    // The pass may fold either way; answer the one that shows it.
    const shows = folded ? a.id : id
    const r = await answer({ to: shows, text: 'Do not send it.', user_words: 'do not send the pear vendor email' })
    expect(r.status, JSON.stringify(r.json)).toBe(409)
    expect(JSON.stringify(r.json)).toContain('please do send the vendor that email')
  })
})

