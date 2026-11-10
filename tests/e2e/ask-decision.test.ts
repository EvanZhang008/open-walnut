/**
 * A reworded ask is the same decision, against a real server (src/core/ask-decision.ts; 2026-11-09,
 * the CEO: all five "changes" of one Brief refresh were the same asks in new words, and the node
 * was woken to rewrite its Brief for them).
 *
 *  - the turn-end status answer, stored the way the status question stores it, mints a decision id
 *    and keeps it when the next turn rewords the ask without a word about it;
 *  - the VP's Brief, written while the task asked, reads current after the rewording (no line
 *    moved), and a look at it asks no refresh turn (`fresh`);
 *  - a line set from outside (PUT /report, task_report_set) rewording it keeps the id too;
 *  - a new decision the session says is new moves the Brief's line.
 * Only the Claude CLI is mocked (nothing here runs one).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-decision'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { applyStatusAnswer } from '../../src/core/sessions/status-question.js'
import { readStatusReport } from '../../src/core/session-hooks/builtins.js'

// The CEO's examples (2026-11-08), neutralized: a time estimate added, then clauses moved.
const ASK_1 = 'Create the acme-alpha-1 dev account with the settings I gave?'
const ASK_2 = 'Create the acme-alpha-1 dev account with my settings? You own it; the full dev setup follows (about 50 minutes).'
const ASK_3 = 'With my settings, go ahead and create the dev account acme-alpha-1? About 50 minutes for the full setup after.'
const ASK_NEW = 'Delete the old staging database now that the move is done?'

let base = ''
let vpId = ''
let taskId = ''
const SID = '00000001-aaaa-4bbb-8ccc-dddddddddddd'

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

/** One turn end asking `ask`, stored as the status question stores its answer. */
async function turnEnd(ask: string, extra: string[] = []): Promise<void> {
  const report = readStatusReport(['FOR_USER_STATE: needs-you', `FOR_USER_ASK: ${ask}`, 'FOR_USER_ASK_OWN: spending: it opens a paid account', ...extra, 'FOR_USER_NOW: ready'].join('\n'))
  expect(report).not.toBeNull()
  await new Promise((r) => setTimeout(r, 5))
  await applyStatusAnswer(taskId, SID, report!, Date.now())
  for (let i = 0; i < 3; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

async function decisionId(): Promise<string | undefined> {
  const { json } = await call('GET', `/api/v1/tasks/${taskId}`)
  const task = (json.task ?? json) as { user_status?: { state?: string; decision?: { id: string } } }
  expect(task.user_status?.state, JSON.stringify({ phase: (task as any).phase, us: task.user_status })).toBe("needs")
  return task.user_status?.decision?.id
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vpId = (await ensureProjectLead('Garden')).id
  taskId = (await addTask({ title: 'Alpha dev account', project: 'Garden' } as never)).task.id
  await createSessionRecord(SID, taskId, 'Garden', WALNUT_HOME)
  await updateSessionRecord(SID, { process_status: 'idle' } as never)
  await updateTaskRaw(taskId, { session_id: SID } as never, { source: 'test' })
  // Its first turn ended asking the user (report-phase.ts moves a running task; this one sits idle).
  await updateTask(taskId, { phase: 'NEED_ACTION' })
})

afterAll(async () => {
  await stopServer()
})

describe('one decision across rewordings', () => {
  let first = ''

  it('the first ask mints a decision, and the VP writes its Brief naming it', async () => {
    await turnEnd(ASK_1)
    first = (await decisionId())!
    expect(first).toMatch(/^ask-/)
    const letter = `### Needs you\n- <task-ref id="${taskId}" label="Alpha dev account"/>: create the alpha dev account?\n### Working\n- nothing\n### Waiting / snoozed\n- nothing`
    const put = await call('PUT', `/api/v1/tasks/${vpId}/brief`, { content: letter })
    expect(put.status).toBe(200)
    expect((await call('GET', `/api/v1/tasks/${vpId}/brief`)).json.fresh?.stale).toBe(false)
  })

  it('a turn that rewords it keeps the decision: the Brief stays current and no refresh is asked', async () => {
    for (const ask of [ASK_2, ASK_3]) {
      await turnEnd(ask)
      expect(await decisionId()).toBe(first)
      expect((await getTask(taskId)).user_status?.ask).toBe(ask)
      const fresh = (await call('GET', `/api/v1/tasks/${vpId}/brief`)).json.fresh
      expect(fresh?.moved ?? []).toEqual([])
      expect(fresh?.stale).toBe(false)
      expect((await call('POST', `/api/v1/org/nodes/${vpId}/brief-refresh`, {})).json).toMatchObject({ sent: false, why: 'fresh' })
    }
  })

  it('the status question shows the session its decision id', async () => {
    const { sameAskQuestionFor } = await import('../../src/core/same-ask-tree.js')
    const q = await sameAskQuestionFor(taskId)
    expect(q).toContain(`decision ${first}`)
    expect(q).toContain('FOR_USER_ASK_ID:')
  })

  it('a line set from outside that rewords it keeps the decision', async () => {
    const put = await call('PUT', `/api/v1/tasks/${taskId}/report`, { state: 'needs', ask: 'Go ahead with the acme-alpha-1 dev account, set up as I gave it?' })
    expect(put.status).toBe(200)
    expect((await getTask(taskId)).status_report?.ask_id).toBe(first)
    for (let i = 0; i < 3; i++) await syncUserStatuses(null, Date.now() + 60_000)
    expect((await call('GET', `/api/v1/tasks/${vpId}/brief`)).json.fresh?.stale).toBe(false)
  })

  it('withdrawing an ask for good needs the user\'s words, and is recorded on the answer', async () => {
    const { prepareAskAnswer, AskAnswerError } = await import('../../src/core/sessions/ask-answer.js')
    await expect(prepareAskAnswer(vpId, taskId, 'Drop it.', undefined, undefined, { withdraw: true }))
      .rejects.toMatchObject({ code: 'user_words' })
    expect(AskAnswerError).toBeDefined()
    const prepared = await prepareAskAnswer(vpId, taskId, 'Drop it.', 'stop asking me about the alpha account', undefined, { withdraw: true })
    expect(prepared.line).toContain('withdrew this ask for good')
    await prepared.commit()
    const answers = (await getTask(taskId)).asks_answered ?? []
    expect(answers.at(-1)).toMatchObject({ withdrawn: true, by: vpId, askId: first, decisionKey: expect.stringMatching(new RegExp(`^${first}\\|`)) })
  })

  it('a new decision the session says is new moves the line', async () => {
    await turnEnd(ASK_NEW, ['FOR_USER_ASK_ID: new'])
    const now = await decisionId()
    expect(now).toMatch(/^ask-/)
    expect(now).not.toBe(first)
    const fresh = (await call('GET', `/api/v1/tasks/${vpId}/brief`)).json.fresh
    expect(fresh?.stale).toBe(true)
    expect(fresh?.moved?.map((m: { id: string }) => m.id)).toEqual([taskId])
  })
})

describe('a report set through the writer, answered or withdrawn before (2026-11-10 review)', () => {
  it('the same decision with a new fact goes through the same-ask gate; nothing new is refused', async () => {
    const { setTaskReport } = await import('../../src/core/sessions/report-set.js')
    const { stampAskDecision, reportDecision } = await import('../../src/core/ask-decision.js')
    const { askKey } = await import('../../src/core/same-ask.js')
    const ask = 'Approve testing on the shared garden tablet?'
    const now = Date.now()
    const prev = stampAskDecision({ state: 'needs', ask, at: new Date(now - 30 * 86_400_000).toISOString(), ask_own: { kind: 'user_own', why: 'Only the user lends the tablet' } } as never, null)
    const d = reportDecision(prev)!
    const t = (await addTask({ title: 'Tablet tests', project: 'Garden' } as never)).task
    const answer = { ask, key: askKey(ask), askId: d.id, decisionKey: d.key, text: 'Not now', by: vpId, byTitle: 'Garden lead', at: prev.at, withdrawn: true }
    await updateTaskRaw(t.id, { phase: 'NEED_ACTION', status_report: prev, asks_answered: [answer] } as never, { source: 'test' })
    const base = { state: 'needs', ask, user_kind: 'user_own', user_kind_why: 'Only the user lends the tablet' }
    // Nothing new: the withdrawn ask is refused, past the seven-day hold.
    await expect(setTaskReport(t.id, { ...base, ask_id: d.id }, { taskId: t.id } as never, now)).rejects.toMatchObject({ code: 'same_ask' })
    // A new fact named: another revision of the decision, asked again.
    await setTaskReport(t.id, { ...base, ask_id: d.id, ask_new: 'The tests now wipe the tablet' }, { taskId: t.id } as never, now)
    expect((await getTask(t.id)).status_report).toMatchObject({ ask_id: d.id, ask_rev: 1 })
  })

  it('the user writing in the task after a withdrawal lifts it, on the status and at the report gate', async () => {
    const { setTaskReport } = await import('../../src/core/sessions/report-set.js')
    const { stampAskDecision, reportDecision } = await import('../../src/core/ask-decision.js')
    const { askKey } = await import('../../src/core/same-ask.js')
    const ask = 'Approve watering the shared garden beds twice a day?'
    const now = Date.now()
    const prev = stampAskDecision({ state: 'needs', ask, at: new Date(now - 30 * 86_400_000).toISOString(), ask_own: { kind: 'user_own', why: 'Only the user pays for the water' } } as never, null)
    const d = reportDecision(prev)!
    const t = (await addTask({ title: 'Garden watering', project: 'Garden' } as never)).task
    const sid = '00000009-aaaa-4bbb-8ccc-dddddddddddd'
    await createSessionRecord(sid, t.id, 'Garden', WALNUT_HOME)
    await updateSessionRecord(sid, { process_status: 'idle' } as never)
    const answer = { ask, key: askKey(ask), askId: d.id, decisionKey: d.key, text: 'Never ask again unless I bring it up', by: vpId, byTitle: 'Garden lead', at: prev.at, withdrawn: true }
    await updateTaskRaw(t.id, { phase: 'NEED_ACTION', session_id: sid } as never, { source: 'test' })
    // Its last turn asked it again, after that phase move.
    await updateTaskRaw(t.id, { status_report: { ...prev, at: new Date(Date.now() + 1_000).toISOString() }, asks_answered: [answer] } as never, { source: 'test' })
    for (let i = 0; i < 3; i++) await syncUserStatuses(null, Date.now() + 60_000)
    expect((await getTask(t.id)).user_status?.state).toBe('waiting')
    const base = { state: 'needs', ask, ask_id: d.id, user_kind: 'user_own', user_kind_why: 'Only the user pays for the water' }
    await expect(setTaskReport(t.id, base, { taskId: t.id } as never, now)).rejects.toMatchObject({ code: 'same_ask' })
    // He writes in the task: he brought it up again.
    await updateSessionRecord(sid, { humanInputAt: new Date().toISOString() } as never)
    for (let i = 0; i < 3; i++) await syncUserStatuses(null, Date.now() + 60_000)
    expect((await getTask(t.id)).user_status?.state).toBe('needs')
    await setTaskReport(t.id, base, { taskId: t.id } as never, Date.now())
    expect((await getTask(t.id)).status_report?.ask).toBe(ask)
  })
})

