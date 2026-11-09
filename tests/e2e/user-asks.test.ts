/**
 * The user's unanswered messages in a task's own chat, on a real server (src/core/sessions/user-asks.ts).
 * 2026-11-03, the user: "why do you miss things? I find that unforgivable" (his words, translated). He asked a worker in its own chat; it
 * said it would check first and get back to him, two compactions dropped the question, and its lead's
 * team note had counted it answered because the worker's turn ended after it.
 *
 *   1. a message he types into a worker's chat is kept as an ask it owes; a retry is one; a lead's
 *      chat keeps a thread instead, and a side question nothing;
 *   2. the turn-end status question lists it, and its FOR_USER_OWED verdict keeps or closes it;
 *   3. after a compaction the readback leads with his words, ahead of everything else;
 *   4. owed a while, it is named at the turn's end (the Stop hook route), at most twice, never while
 *      the task parked itself;
 *   5. its lead's team note says the task owes him an answer, with his words;
 *   6. a session that owes it an hour with no turn running is woken once;
 *   7. a letter answer is kept too; the task's completion closes them all.
 * Only the Claude CLI is mocked (no CLI runs: messages wait in the queue).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-asks'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { buildLetterDeliveryText } from '../../src/core/human-inbox/letter-ops.js'
import { teamSnapshotText } from '../../src/core/org/team-note.js'
import { applyOwedAnswer, owedQuestionFor, readUserAsks, wakeIdleOwed } from '../../src/core/sessions/user-asks.js'
import { openAsks, type UserAsksFile } from '../../src/core/sessions/user-asks-model.js'
import { bus } from '../../src/core/event-bus.js'
import { withTestRun } from '../../src/core/test-run.js'
import { STATUS_SETTLE_MS } from '../../src/core/sessions/status-question.js'

const WORKER_SID = '66666666-7777-4888-9999-000000000001'
const LEAD_SID = '66666666-7777-4888-9999-000000000002'
const QUESTION = 'Why does the QR code say "Can\'t scan it"? I only want one link, with the code in it.'
let base = ''
let workerId = ''
let leadId = ''

async function typeIntoChat(sid: string, text: string, extra: { threadKey?: string; threads?: boolean } = {}): Promise<void> {
  const record = await getSessionByClaudeId(sid)
  const prepared = await prepareHintedSend(sid, record, text, { sentBy: 'person', ...extra })
  await sendMessageToSession(sid, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
}

async function setAsks(taskId: string, fn: (f: UserAsksFile) => UserAsksFile): Promise<void> {
  const file = path.join(WALNUT_HOME, 'user-asks', `${taskId}.json`)
  await fs.writeFile(file, JSON.stringify(fn(await readUserAsks(taskId))))
}

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString()

/** The mock CLI runs each queued message, and its turn-end status question moves the phase about
 *  STATUS_SETTLE_MS later: wait until both settled, then set the phase. */
async function settledAs(phase: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await getQueue(WORKER_SID)).toHaveLength(0)
    expect((await getSessionByClaudeId(WORKER_SID))?.process_status).not.toBe('running')
  }, { timeout: 15_000, interval: 200 })
  await new Promise((r) => setTimeout(r, STATUS_SETTLE_MS + 2_000))
  await updateTaskRaw(workerId, { phase: phase as never }, { leaveHeld: true })
}

async function stopHook(sid: string): Promise<{ reason?: string; owedUser?: string[] } | null> {
  const res = await fetch(`${base}/api/v1/me/open?hook=stop`, { headers: { 'x-walnut-caller-sid': sid } })
  return ((await res.json()) as { stop: { reason?: string; owedUser?: string[] } | null }).stop
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  workerId = (await addTask({ title: 'Tunnel sign-in link', project: 'Orchard' })).task.id
  leadId = (await ensureProjectLead('Orchard')).id
  await createSessionRecord(WORKER_SID, workerId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(WORKER_SID, { process_status: 'stopped' })
  await createSessionRecord(LEAD_SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the user asks a task owes', () => {
  it('his message in a worker\'s chat is kept; a retry is one; a lead keeps a thread instead; a side question nothing', async () => {
    await typeIntoChat(WORKER_SID, QUESTION, { threadKey: 'qm-1' })
    await typeIntoChat(WORKER_SID, QUESTION, { threadKey: 'qm-1' })
    await typeIntoChat(WORKER_SID, 'a side question', { threads: false })
    // A test run's words (a phone or browser under automation, core/test-run.ts) are never his.
    await withTestRun('ios-uitest', () => typeIntoChat(WORKER_SID, 'Stop everything and just say pineapple.'))
    await vi.waitFor(async () => { expect(openAsks(await readUserAsks(workerId))).toHaveLength(1) }, { timeout: 5_000, interval: 50 })
    const open = openAsks(await readUserAsks(workerId))
    expect(open.map((a) => a.text)).toEqual([QUESTION])
    expect(open[0]).toMatchObject({ via: 'chat', sid: WORKER_SID, key: 'qm-1', state: 'open' })
    await typeIntoChat(LEAD_SID, 'how is the tunnel going?')
    await expect(fs.access(path.join(WALNUT_HOME, 'user-asks', `${leadId}.json`))).rejects.toThrow()
    expect((await fs.stat(path.join(WALNUT_HOME, 'org', 'threads', `${leadId}.json`))).isFile()).toBe(true)
    await withTestRun('ios-uitest', () => typeIntoChat(LEAD_SID, 'Pineapple status, please.'))
    expect(await fs.readFile(path.join(WALNUT_HOME, 'org', 'threads', `${leadId}.json`), 'utf8')).not.toContain('Pineapple')
  })

  it('the status question lists it; "on it" keeps it owed, an answer closes it', async () => {
    const q = await owedQuestionFor(workerId)
    expect(q.listed).toHaveLength(1)
    expect(q.block).toContain(`[${q.listed[0]}]`)
    expect(q.block).toContain('Can\'t scan it')
    expect(await applyOwedAnswer(workerId, q.listed, `FOR_USER_STATE: working\nFOR_USER_OWED: ${q.listed[0]}`)).toEqual([])
    expect(openAsks(await readUserAsks(workerId))[0].owedAt).toBeTruthy()
    // A status with no verdict line judges nothing.
    expect(await applyOwedAnswer(workerId, q.listed, 'FOR_USER_STATE: working')).toEqual([])
    expect(openAsks(await readUserAsks(workerId))).toHaveLength(1)
  })

  it('after a compaction the readback leads with his words', async () => {
    const res = await fetch(`${base}/api/v1/me/open?hook=compact`, { headers: { 'x-walnut-caller-sid': WORKER_SID } })
    const body = await res.json() as { text: string; owedUser?: Array<{ text: string }> }
    expect(body.text.startsWith('The user\'s messages in this task that you have not answered yet')).toBe(true)
    expect(body.text).toContain(QUESTION)
    expect(body.owedUser?.map((a) => a.text)).toEqual([QUESTION])
    // The tool read says it too.
    const plain = await (await fetch(`${base}/api/v1/me/open`, { headers: { 'x-walnut-caller-sid': WORKER_SID } })).json() as { text: string }
    expect(plain.text).toContain(QUESTION)
  })

  it('owed across a compaction, it is named at the turn\'s end, at most twice, never while the task parked itself', { timeout: 60_000 }, async () => {
    // Just owed: not yet.
    expect(await stopHook(WORKER_SID)).toBeNull()
    await setAsks(workerId, (f) => ({ ...f, asks: f.asks.map((a) => ({ ...a, at: ago(45) })) }))
    await settledAs('WAITING')
    expect(await stopHook(WORKER_SID)).toBeNull()
    await updateTaskRaw(workerId, { phase: 'IN_PROGRESS' as never }, { leaveHeld: true })
    // Owed 45 minutes with no compaction since: a turn that is giving the answer now is not held.
    expect(await stopHook(WORKER_SID)).toBeNull()
    await updateSessionRecord(WORKER_SID, { lastCompactAt: ago(10) })
    const first = await stopHook(WORKER_SID)
    expect(first?.reason).toContain('the user still waits for your answer')
    expect(first?.reason).toContain('Can\'t scan it')
    expect(first?.owedUser).toHaveLength(1)
    expect((await stopHook(WORKER_SID))?.owedUser).toHaveLength(1)
    expect(await stopHook(WORKER_SID)).toBeNull()
  })

  it('its lead\'s team note says the task owes him an answer, in his words', async () => {
    const lead = (await import('../../src/core/task-manager.js')).getTask
    const text = await teamSnapshotText((await lead(leadId))!)
    expect(text).toContain('Owes the user an answer')
    expect(text).toContain('"Tunnel sign-in link"')
    expect(text).toContain('Can\'t scan it')
  })

  it('a session that owes it an hour with no turn running is woken once', { timeout: 60_000 }, async () => {
    await setAsks(workerId, (f) => ({ ...f, asks: f.asks.map((a) => ({ ...a, owedAt: ago(61) })) }))
    await settledAs('IN_PROGRESS')
    // A stopped session is woken too: the user waits, and a reaped session is how the question was lost.
    const sent: string[] = []
    const seen = (e: { data?: unknown }) => { const d = e.data as { sessionId?: string; message?: string; text?: string }; if (d?.sessionId === WORKER_SID) sent.push(JSON.stringify(d)) }
    bus.subscribe('test-user-asks-wake', seen as never, { global: true })
    expect(await wakeIdleOwed()).toEqual([workerId])
    expect(openAsks(await readUserAsks(workerId))[0].wokenAt).toBeTruthy()
    await vi.waitFor(() => { expect(sent.some((t) => t.includes('The user is still waiting for your answer'))).toBe(true) }, { timeout: 5_000, interval: 100 })
    bus.unsubscribe('test-user-asks-wake')
    expect(await wakeIdleOwed()).toEqual([])
  })

  it('after a compaction his answered words are read back too, after the ones still owed', async () => {
    await typeIntoChat(WORKER_SID, 'Then which version of the agent should the report name?', { threadKey: 'qm-2' })
    await vi.waitFor(async () => { expect(openAsks(await readUserAsks(workerId))).toHaveLength(2) }, { timeout: 5_000, interval: 50 })
    const q = await owedQuestionFor(workerId)
    const kept = openAsks(await readUserAsks(workerId))[0].id
    expect(await applyOwedAnswer(workerId, q.listed, `FOR_USER_OWED: ${kept}`)).toHaveLength(1)
    const res = await fetch(`${base}/api/v1/me/open?hook=compact`, { headers: { 'x-walnut-caller-sid': WORKER_SID } })
    const text = (await res.json() as { text: string }).text
    expect(text.startsWith('The user\'s messages in this task that you have not answered yet')).toBe(true)
    const recent = text.indexOf('What the user said in this task over the last two days')
    expect(recent).toBeGreaterThan(text.indexOf('Can\'t scan it'))
    expect(text.indexOf('which version of the agent should the report name?')).toBeGreaterThan(recent)
    expect(text).toContain(`"id":"${workerId}","before"`)
  })

  it('a letter answer is kept too; the task\'s completion closes them all', { timeout: 60_000 }, async () => {
    await sendMessageToSession(WORKER_SID, buildLetterDeliveryText({ id: 'lt-9', subject: 'Which link?' }, { text: 'the second one' }), { source: 'human-inbox', taskId: workerId })
    await vi.waitFor(async () => { expect(openAsks(await readUserAsks(workerId))).toHaveLength(2) }, { timeout: 5_000, interval: 50 })
    const open = openAsks(await readUserAsks(workerId))
    expect(open.map((a) => a.via)).toEqual(['chat', 'letter'])
    expect(open[1]).toMatchObject({ text: 'the second one', about: 'Which link?' })
    await settledAs('IN_PROGRESS')
    expect(openAsks(await readUserAsks(workerId))).toHaveLength(2)
    await updateTaskRaw(workerId, { phase: 'COMPLETE' as never }, { emitEvent: true, source: 'test' })
    await vi.waitFor(async () => { expect(openAsks(await readUserAsks(workerId))).toHaveLength(0) }, { timeout: 5_000, interval: 100 })
    // The one answered earlier stays closed as answered; the rest close with the task.
    expect((await readUserAsks(workerId)).asks.map((a) => a.closedBy).sort()).toEqual(['complete', 'complete', 'report'])
  })
})
