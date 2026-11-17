/**
 * An ask only the user approves (credentials, spending...) answered in his place stands on his own
 * words, checked in Walnut's record (2026-11-17, the Personal VP's reflection: the user answered
 * "cahneg", his typo for "change", in the VP's thread about whether to change a portal password;
 * answers_ask refused it as too short, and the ask stayed on his Needs you). A real server, real
 * task, session, user-ask and thread stores.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-answer-users-words'))

/** Every message put into a session: the real queue, recorded on the way in. */
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
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { applyStatusAnswer } from '../../src/core/sessions/status-question.js'
import { fileThreadMessage, patchThread } from '../../src/core/org/threads-store.js'
import { newThreadId, newThreadMessageId } from '../../src/core/org/threads-model.js'
import type { StatusReport } from '../../src/core/user-status.js'
import { userWrote } from '../helpers/user-wrote.js'

const LEAD_SID = 'abababab-aaaa-4bbb-8ccc-dddddddddddd'
const PROJECT = 'Quince'
let base = ''
let lead = ''
let n = 0

const tick = () => new Promise((r) => setTimeout(r, 8))

/** A task whose idle session asks the user to approve a step of `kind` (its own turn-end report). */
async function asking(title: string, ask: string, kind = 'credentials'): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project: PROJECT } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-3333-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, PROJECT, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  const { updateTaskRaw } = await import('../../src/core/task-manager.js')
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  await updateTask(id, { phase: 'NEED_ACTION' })
  await tick()
  const report: StatusReport = { state: 'needs', ask, ask_own: { kind, why: 'Only he can approve it' }, at: new Date().toISOString() }
  expect(await applyStatusAnswer(id, sid, report, Date.now())).toBe(true)
  for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
  expect((await getTask(id)).user_status, `${title} asks the user`).toMatchObject({ state: 'needs', ask })
  return { id, sid }
}

/** The user writes in the lead's thread about `taskId` (the thread names the task when `linked`). */
async function wroteInThread(taskId: string, text: string, linked = true): Promise<void> {
  await tick()
  const filed = await fileThreadMessage(lead, {
    text, images: [], via: 'chat', newThreadId: newThreadId(), messageId: newThreadMessageId(), at: new Date().toISOString(), lang: 'en',
  } as never)
  if (linked) await patchThread(lead, filed.thread.id, { add_tasks: [taskId] } as never, 'agent')
  await tick()
}

async function answer(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
    body: JSON.stringify({ title: 'Decided', expect_reply: false, answers_ask: true, ...body }),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const errorOf = (j: Record<string, unknown>) => JSON.stringify(j)

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

describe('an ask only the user approves, answered on his own words', () => {
  it('his typo in the lead\'s thread about the task, written after the ask, answers it: off Needs you, his words go to the task', async () => {
    const t = await asking('Quince portal password', 'Change the Quince portal password now?')
    await wroteInThread(t.id, 'cahneg')
    const r = await answer({ to: t.id, text: 'Change it, he said so.', user_words: 'cahneg' })
    expect(r.status, errorOf(r.json)).toBe(202)
    expect(r.json.delivery).toBe('queued')
    const told = sentTo.find((m) => m.sid === t.sid && m.text.includes('Change it, he said so.'))
    expect(told?.text).toContain('The user\'s own words it stands on')
    expect(told?.text).toContain('"cahneg"')
    expect((await getTask(t.id)).ask_answered).toMatchObject({ by: lead, userWords: 'cahneg' })
    for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
    expect((await getTask(t.id)).user_status?.state).not.toBe('needs')
  })

  it('his words in the task\'s own chat count the same way', async () => {
    const t = await asking('Quince card spend', 'Pay the Quince invoice of $60 with the card on file?', 'spending')
    await userWrote(t.id, 'ok pay it')
    const r = await answer({ to: t.id, text: 'Pay it.', user_words: 'ok pay it' })
    expect(r.status, errorOf(r.json)).toBe(202)
  })

  it('words that are not his are refused with the next step, and nothing is recorded', async () => {
    const t = await asking('Quince token', 'Rotate the Quince API token now?')
    const r = await answer({ to: t.id, text: 'Rotate it.', user_words: 'He told me to rotate the token' })
    expect(r.status).toBe(409)
    expect(errorOf(r.json)).toContain('user_words')
    expect(errorOf(r.json)).toContain('not one message of his')
    expect(errorOf(r.json)).toContain('pass that one message word for word')
    expect((await getTask(t.id)).ask_answered).toBeUndefined()
    // No words at all: the same next step.
    const bare = await answer({ to: t.id, text: 'Rotate it.' })
    expect(bare.status).toBe(409)
    expect(errorOf(bare.json)).toContain('pass that one message word for word')
  })

  it('his answer to an earlier decision does not answer a new one asked right after, and the refusal says so', async () => {
    const t = await asking('Quince plan', 'Pick the Quince plan: Basic or Pro?', 'user_own')
    await userWrote(t.id, 'pro')
    // Still asking, now a different decision: approving the spend.
    await tick()
    const spend: StatusReport = { state: 'needs', ask: 'Approve paying $200 a year for Quince Pro?', ask_id: 'new', ask_own: { kind: 'spending', why: 'Only he can approve it' }, at: new Date().toISOString() } as StatusReport
    const { applyStatusAnswer: apply } = await import('../../src/core/sessions/status-question.js')
    expect(await apply(t.id, t.sid, spend, Date.now())).toBe(true)
    for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
    const r = await answer({ to: t.id, text: 'Pay it.', user_words: 'pro' })
    expect(r.status).toBe(409)
    expect(errorOf(r.json)).toContain('before the spending ask')
    expect((await getTask(t.id)).ask_answered).toBeUndefined()
  })

  it('a short message of his inside a longer line is no quote of it', async () => {
    const t = await asking('Quince seats', 'Buy 5 more Quince seats for $50?', 'spending')
    await userWrote(t.id, 'no')
    const r = await answer({ to: t.id, text: 'Buy them.', user_words: 'no problem, go ahead and buy them' })
    expect(r.status).toBe(409)
    expect(errorOf(r.json)).toContain('not one message of his')
  })

  it('a message an agent filed into a thread is never his', async () => {
    const t = await asking('Quince secret', 'Print the Quince signing secret into the log?')
    await tick()
    const filed = await fileThreadMessage(lead, {
      text: 'yes print the secret', images: [], via: 'import', newThreadId: newThreadId(), messageId: newThreadMessageId(), at: new Date().toISOString(), lang: 'en',
    } as never)
    await patchThread(lead, filed.thread.id, { add_tasks: [t.id] } as never, 'agent')
    const r = await answer({ to: t.id, text: 'Print it.', user_words: 'yes print the secret' })
    expect(r.status).toBe(409)
    expect(errorOf(r.json)).toContain('not one message of his')
  })

  it('a thread not about the task is no answer to it', async () => {
    const t = await asking('Quince vault', 'Share the Quince vault login with the contractor?', 'permissions')
    await wroteInThread(t.id, 'yes share the vault login', false)
    const r = await answer({ to: t.id, text: 'Share it.', user_words: 'yes share the vault login' })
    expect(r.status).toBe(409)
    expect(errorOf(r.json)).toContain('not one message of his')
  })
})
