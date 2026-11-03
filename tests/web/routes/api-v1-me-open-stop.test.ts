/**
 * The Stop hook's question (GET /api/v1/me/open?hook=stop through open_items hook:"stop"): does
 * the session ending its turn hold a request it has not answered (core/sessions/unanswered-at-stop.ts)?
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home, real session records, real rows
 * in the request store. The contract:
 *   - an unanswered request to the caller: the op prints a Stop hook `block` answer naming the
 *     request and the exact reply command;
 *   - nothing for: no caller, a replied request, one handed on (hands_on), an asker whose task is
 *     complete, a turn whose own work runs on (workOutlivesTurn);
 *   - one request is named in at most MAX_NUDGES turns, so a session that decided it owes no
 *     answer is not held forever.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-me-open-stop'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, completeTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { createSessionRequest, settleNotified, settleReplied } from '../../../src/core/session-requests.js'
import { MAX_NUDGES, resetStopNudges, unansweredStopReason } from '../../../src/core/sessions/unanswered-at-stop.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import '../../../src/ops/index.js'

let server: HttpServer
let port: number
let apiBase: string

let seq = 0
async function seedSession(title: string): Promise<{ id: string; sid: string }> {
  seq += 1
  const { task } = await addTask({ title, project: 'Acme' })
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, 'Acme', '/repo/acme', { title })
  return { id: task.id, sid }
}

async function stopAnswer(sid?: string): Promise<Record<string, unknown>> {
  const r = await executeOp('open_items', { hook: 'stop' }, { apiBase, ...(sid ? { callerSid: sid } : {}), origin: LOCAL_ORIGIN })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { result: Record<string, unknown> }).result
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  apiBase = `http://localhost:${port}/api/v1`
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { resetStopNudges(); vi.restoreAllMocks() })

describe('open_items hook:"stop"', () => {
  it('no caller, or nothing asked of it: the turn ends ({})', async () => {
    expect(await stopAnswer()).toEqual({})
    const quiet = await seedSession('Nothing asked of me')
    expect(await stopAnswer(quiet.sid)).toEqual({})
  })

  it('an unanswered request holds the turn once, naming it and the reply command', async () => {
    const lead = await seedSession('Marina lead')
    const worker = await seedSession('Marina worker')
    const rq = await createSessionRequest({ fromSessionId: lead.sid, toSessionId: worker.sid, toTaskId: worker.id, text: 'Is the dashboard live on prod?' })
    const out = await stopAnswer(worker.sid)
    expect(out.decision).toBe('block')
    const reason = String(out.reason)
    expect(reason).toContain(rq.id)
    expect(reason).toContain(`"in_reply_to":"${rq.id}"`)
    expect(reason).toContain('"Marina lead"')
    expect(reason).toContain('Is the dashboard live on prod?')
    // A reply settles it: the next turn ends freely.
    await settleReplied(rq.id)
    expect(await stopAnswer(worker.sid)).toEqual({})
  })

  it(`names one request in at most ${MAX_NUDGES} turns`, async () => {
    const lead = await seedSession('Kestrel lead')
    const worker = await seedSession('Kestrel worker')
    await createSessionRequest({ fromSessionId: lead.sid, toSessionId: worker.sid, toTaskId: worker.id, text: 'Ping me with the result' })
    for (let i = 0; i < MAX_NUDGES; i++) expect((await stopAnswer(worker.sid)).decision).toBe('block')
    expect(await stopAnswer(worker.sid)).toEqual({})
  })

  it('a request handed on is not nagged: the work moved, the reply comes from there', async () => {
    const main = await seedSession('Main of the test org')
    const lead = await seedSession('Osprey lead')
    const worker = await seedSession('Osprey worker')
    const asked = await createSessionRequest({ fromSessionId: main.sid, toSessionId: lead.sid, toTaskId: lead.id, text: 'Fix the highlight bug' })
    await createSessionRequest({ fromSessionId: lead.sid, fromTaskId: lead.id, toTaskId: worker.id, text: 'Take the highlight bug', handsOn: [asked.id] })
    expect(await stopAnswer(lead.sid)).toEqual({})
  })

  it('an asker whose task is complete waits for nothing', async () => {
    const asker = await seedSession('Finished asker')
    const worker = await seedSession('Heron worker')
    await createSessionRequest({ fromSessionId: asker.sid, toSessionId: worker.sid, toTaskId: worker.id, text: 'Old question' })
    await completeTask(asker.id)
    expect(await stopAnswer(worker.sid)).toEqual({})
  })

  it('an overdue request is still named; a parked task, or one waiting on its own ask, is not', async () => {
    const lead = await seedSession('Tern lead')
    const worker = await seedSession('Tern worker')
    const helper = await seedSession('Tern helper')
    const rq = await createSessionRequest({ fromSessionId: lead.sid, toSessionId: worker.sid, toTaskId: worker.id, text: 'Overdue question' })
    // Past its deadline: OVERDUE, still open, and the one most worth naming.
    await settleNotified(rq.id, 'timeout')
    expect((await stopAnswer(worker.sid)).decision).toBe('block')
    resetStopNudges()
    // It asked the helper something itself: its result comes after that answer.
    const own = await createSessionRequest({ fromSessionId: worker.sid, toSessionId: helper.sid, toTaskId: helper.id, text: 'Need your numbers' })
    expect(await stopAnswer(worker.sid)).toEqual({})
    await settleReplied(own.id)
    expect((await stopAnswer(worker.sid)).decision).toBe('block')
    resetStopNudges()
    // Parked as WAITING: it waits on something; the reply comes when that arrives.
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js')
    await updateTaskRaw(worker.id, { phase: 'WAITING' })
    expect(await stopAnswer(worker.sid)).toEqual({})
  })

  it('a turn whose own work runs on after it is not nagged (its answer comes later)', async () => {
    const lead = await seedSession('Plover lead')
    const worker = await seedSession('Plover worker')
    await createSessionRequest({ fromSessionId: lead.sid, toSessionId: worker.sid, toTaskId: worker.id, text: 'Run the suite and report' })
    vi.spyOn(sessionRunner, 'hasWorkOutlivingTurn').mockReturnValue(true)
    expect(await stopAnswer(worker.sid)).toEqual({})
  })
})

describe('unansweredStopReason', () => {
  it('lists every request and gives the first one\'s reply command', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    const r = (id: string, mins: number) => ({
      request: { id, fromSessionId: 's', preview: `question ${id}`, createdAt: new Date(now - mins * 60_000).toISOString(), status: 'pending' } as never,
      from: `"Asker ${id}" (t-${id})`,
    })
    const text = unansweredStopReason([r('rq-a', 5), r('rq-b', 180)], now)
    expect(text).toContain('2 requests')
    expect(text).toContain('rq-a from "Asker rq-a" (t-rq-a), asked 5 min ago: "question rq-a"')
    expect(text).toContain('asked 3 h ago')
    expect(text).toContain('"in_reply_to":"rq-a"')
    expect(text).toContain('Needs no answer: reply in one line saying why')
    expect(text).toContain('do not send a progress note')
  })
})

describe('an Ask here question answered outside its tag holds the turn (ask-unanswered.ts)', () => {
  async function stopWith(sid: string, asked: string, answered: string): Promise<Record<string, unknown>> {
    const r = await executeOp('open_items', { hook: 'stop', asked, answered }, { apiBase, callerSid: sid, origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return (r as { result: Record<string, unknown> }).result
  }

  it('the real send records the question; the hook names it until its tag is in the transcript; twice at most; with a request in one reason', async () => {
    const { resetAskNudges } = await import('../../../src/core/sessions/ask-unanswered.js')
    const { prepareHintedSend } = await import('../../../src/core/hints/hint-send.js')
    const { getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
    resetAskNudges()
    const s = await seedSession('Sandbox reviews')
    for (const [thread, words] of [['6', 'Can the controller impersonate the deployer?'], ['6.1', 'And across namespaces?']] as const) {
      const sent = await prepareHintedSend(s.sid, await getSessionByClaudeId(s.sid), words, { requested: { question: { arg: thread } }, sentBy: 'person', config: null })
      expect(sent.enqueueText).toContain(`<walnut-ask thread="${thread}"`)
      await sent.commit()
    }
    const rec = await getSessionByClaudeId(s.sid)
    expect(rec?.asksSent?.map((a) => a.thread)).toEqual(['6', '6.1'])
    // An older hook passes no lists: no question is named.
    expect(await stopAnswer(s.sid)).toEqual({})
    // 6.1 answered inside its tag, 6 not: 6 is named with its tag.
    const held = await stopWith(s.sid, '6,6.1', '6.1')
    expect(held.decision).toBe('block')
    expect(String(held.reason)).toContain('<walnut-ask-answer thread="6" name="Can the controller impersonate the deployer?">')
    expect(String(held.reason)).not.toContain('thread="6.1"')
    // Not delivered yet (not in the transcript): not named.
    resetAskNudges()
    expect(await stopWith(s.sid, '6.1', '6.1')).toEqual({})
    // At most twice per question.
    expect((await stopWith(s.sid, '6', '')).decision).toBe('block')
    expect((await stopWith(s.sid, '6', '')).decision).toBe('block')
    expect(await stopWith(s.sid, '6', '')).toEqual({})
    // A follow-up in thread 6 is a new send: it may be named again, under the name the thread was first sent with.
    await new Promise((r) => setTimeout(r, 5))
    const follow = await prepareHintedSend(s.sid, await getSessionByClaudeId(s.sid), 'One more thing', { requested: { question: { arg: '6' } }, sentBy: 'person', config: null })
    expect(follow.enqueueText).toContain('<walnut-ask thread="6" name="Can the controller impersonate the deployer?">')
    await follow.commit()
    const again = await stopWith(s.sid, '6', '')
    expect(again.decision).toBe('block')
    expect(String(again.reason)).toContain('One more thing')
    // A request and a question in one reason.
    resetAskNudges()
    resetStopNudges()
    const lead = await seedSession('Sandbox lead')
    await createSessionRequest({ fromSessionId: lead.sid, toSessionId: s.sid, toTaskId: s.id, text: 'Report back' })
    const both = await stopWith(s.sid, '6', '')
    expect(String(both.reason)).toContain('Report back')
    expect(String(both.reason)).toContain('<walnut-ask thread="6"')
  })
})
