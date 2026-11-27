/**
 * One reply, one card, on a real server with only the CLI faked (experiments threads_each_question
 * and threads_reply_tag; src/core/org/thread-one-reply.ts, thread-audit.ts). 2026-11-26, real use:
 * he asked one matter in three messages within a minute. Each question opened its own thread; the
 * node's one reply answered the last two and its card lines marked both answered with no summary.
 * His view counts a reply under two threads as news on neither, so for 84 minutes those two
 * questions had no card, until the thread check's six-hour clock came by.
 *
 *   1. two questions typed before the node speaks, one reply, two card lines with no summary: when
 *      the turn ends they are ONE thread holding both questions, in his view, titled by both; the
 *      merged thread's id still names it;
 *   2. the node's threads changed, so the thread check reads it soon (not at its six hours), once
 *      he is out of its chat: with two cards he can see, one pass tells the lead the two that are
 *      one matter;
 *   3. card lines that give each question its own summary leave two cards, each showing its own.
 * No CLI runs: the test takes each message out of the queue as a CLI does and writes the chat the
 * way a CLI writes its transcript (as tests/e2e/reply-card-line.test.ts does). The judge is a seam.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-one-reply'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
// This file plays the session's CLI itself (it takes the queued rows), so the server's runner takes
// no row here (tests/core/hand-played-cli-guard.test.ts).
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return { ...real, markProcessing: (async () => []) as typeof real.markProcessing }
})

import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue, markNextProcessing, removeProcessed, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { threadsKeptNow } from '../../src/core/org/threads-kept.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { eachQuestionNow } from '../../src/core/org/thread-question.js'
import { _resetOrgEnabledForTesting } from '../../src/core/org/org-enabled.js'
import { listedForHim } from '../../src/core/org/thread-view.js'
import {
  resetThreadAuditSoonForTests, runThreadAuditSoon, setAuditJudgeOverride, startThreadAudit, threadAuditSoonWaiting, SOON_QUIET_MS, THREAD_AUDIT_SOURCE,
} from '../../src/core/org/thread-audit.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const LEAD_SID = '77777777-6666-4777-8888-0000000a11e1'
const SUB = 'test-thread-one-reply'
let base = ''
let leadId = ''
let audit: { stop: () => void } | null = null
const changes: Array<{ kind?: string; threadId?: string }> = []
let judged: string[] = []

async function typeIntoChat(text: string): Promise<string> {
  const record = await getSessionByClaudeId(LEAD_SID)
  const prepared = await prepareHintedSend(LEAD_SID, record, text, { sentBy: 'person' })
  await sendMessageToSession(LEAD_SID, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  // The CLI takes what waits, oldest first: a note of Walnut's own may wait ahead of his words.
  for (;;) {
    const rows = await markNextProcessing(LEAD_SID)
    expect(rows).toHaveLength(1)
    await removeProcessed(LEAD_SID, rows.map((r) => r.id))
    if (rows[0].message.includes(text)) return rows[0].message
  }
}

let seq = 0
/** One turn: his messages as the model read them, the one reply, and the turn's end as the runner says it. */
async function turn(asRead: string[], reply: string): Promise<void> {
  const rows = [...asRead.map((text) => ({ type: 'user' as const, text })), { type: 'assistant' as const, text: reply }]
  const lines = rows.map((r) => {
    seq += 1
    return {
      type: r.type, uuid: `${LEAD_SID.slice(0, 8)}-0000-4000-8000-${String(seq).padStart(12, '0')}`, timestamp: new Date(Date.now() + seq).toISOString(),
      message: r.type === 'user'
        ? { role: 'user', content: [{ type: 'text', text: r.text }] }
        : { id: `msg-${seq}`, role: 'assistant', content: [{ type: 'text', text: r.text }] },
    }
  })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(path.join(dir, `${LEAD_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  bus.emit(EventNames.SESSION_RESULT, { sessionId: LEAD_SID, taskId: leadId, result: reply, isError: false }, ['main-ai', 'session-runner'], { source: 'session-runner' })
}

async function threads(): Promise<OrgThread[]> {
  return ((await (await fetch(`${base}/api/v1/tasks/${leadId}/threads`)).json()) as { threads: OrgThread[] }).threads
}
const open = async () => (await threads()).filter((t) => !t.closed)
const filedUnder = (asRead: string): string => {
  const m = /th-[0-9a-f]{6,32}/.exec(asRead)
  if (!m) throw new Error(`no thread named in:\n${asRead}`)
  return m[0]
}
const card = (id: string, attrs: string) => `<walnut-card thread="${id}" state="answered" ${attrs}/>`
const notes = async () => (await getQueue(LEAD_SID)).filter((m) => m.source === THREAD_AUDIT_SOURCE || m.message.includes('outcome="threads-audit"'))

const Q_PAINT = 'What paint does the shed door need, and how many coats?'
const R_PAINT = 'Exterior gloss over one coat of primer: two coats of gloss, sanded lightly in between.'
const T_PAINT = 'Shed door paint and coats'
const Q_HINGE = 'Does the top hinge of the shed door need oil as well?'
const Q_ORDER = 'Which goes on the shed door first, the primer or the gloss?'
const R_BOTH = 'Yes, oil the top hinge before you start. The primer goes on first, and the gloss only once the primer is dry.'
const T_HINGE = 'Shed door hinge needs oil first'
const T_ORDER = 'Shed door paint order'
const Q_GATE = 'Which way should the orchard gate swing?'
const Q_LATCH = 'Where does the latch of the orchard gate go?'
const R_GATE = 'Inward, since the path outside is narrow. The latch goes on the post side, at hip height.'

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  process.env.WALNUT_THREAD_REOPEN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  _resetOrgEnabledForTesting(true)
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leadId = (await ensureProjectLead('Orchard')).id
  await createSessionRecord(LEAD_SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
  const put = await fetch(`${base}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ experimental: { threads_kept_by_walnut: true, threads_reply_tag: true, threads_each_question: true, threads_audit: true } }),
  })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(threadsKeptNow()).toBe(true); expect(replyTagNow()).toBe(true); expect(eachQuestionNow()).toBe(true) }, { timeout: 5000 })
  bus.subscribe(SUB, (e) => {
    if (e.name === EventNames.ORG_THREADS_CHANGED && (e.data as { taskId?: string }).taskId === leadId) changes.push(e.data as { kind?: string; threadId?: string })
  }, { global: true, interest: [EventNames.ORG_THREADS_CHANGED] })
  // The clock itself never ticks in the test (its first look is minutes away); its soon read is called by hand.
  resetThreadAuditSoonForTests()
  audit = startThreadAudit()
  setAuditJudgeOverride(async (input) => { judged.push(input); return '1 SAME: one shed door, asked twice' })
}, 60_000)

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  delete process.env.WALNUT_THREAD_REOPEN_SECS
  bus.unsubscribe(SUB)
  audit?.stop()
  resetThreadAuditSoonForTests()
  setAuditJudgeOverride(null)
  _resetOrgEnabledForTesting()
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('one reply that answers two of his questions', () => {
  let paint = ''
  let kept = ''

  it('a first question, answered: one card, and the soon read finds no pair to compare', async () => {
    const asRead = await typeIntoChat(Q_PAINT)
    paint = filedUnder(asRead)
    await turn([asRead], `${R_PAINT}\n\n${card(paint, `title="${T_PAINT}"`)}`)
    await vi.waitFor(async () => {
      const t = (await threads()).find((x) => x.id === paint)!
      expect(t).toMatchObject({ state: 'answered', title: T_PAINT })
      expect(t.messages[0].answer?.text).toBe(R_PAINT)
    }, { timeout: 20_000, interval: 300 })
    // His threads changed: the node waits for its soon read.
    expect(threadAuditSoonWaiting()).toContain(leadId)
    expect(await runThreadAuditSoon(leadId)).toBeNull()
    expect(judged).toHaveLength(0)
  }, 40_000)

  it('two questions before the node speaks, one reply, two card lines with no summary: one thread, in his view', async () => {
    const hingeRead = await typeIntoChat(Q_HINGE)
    const orderRead = await typeIntoChat(Q_ORDER)
    const hinge = filedUnder(hingeRead)
    const order = filedUnder(orderRead)
    // Each question is its own thread (threads_each_question).
    expect(new Set([paint, hinge, order]).size).toBe(3)
    changes.length = 0
    await turn([hingeRead, orderRead], `${R_BOTH}\n\n${card(hinge, `title="${T_HINGE}"`)}\n${card(order, `title="${T_ORDER}"`)}`)
    await vi.waitFor(async () => {
      const now = await open()
      expect(now.map((t) => t.id).sort()).toEqual([paint, hinge].sort())
      expect(now.find((t) => t.id === hinge)!.messages.map((m) => m.answer?.text)).toEqual([R_BOTH, R_BOTH])
    }, { timeout: 20_000, interval: 300 })
    kept = hinge
    const t = (await threads()).find((x) => x.id === kept)!
    expect(t.state).toBe('answered')
    expect(t.messages.map((m) => m.text)).toEqual([Q_HINGE, Q_ORDER])
    expect(t.title).toBe(`${T_HINGE} \u00b7 ${T_ORDER}`)
    expect(t.titled).toBe(true)
    expect(t.was).toEqual([order])
    // No line of the reply reaches him, and both questions are on a card he sees.
    expect(JSON.stringify(t)).not.toContain('walnut-card')
    expect(listedForHim(await threads()).map((x) => x.id).sort()).toEqual([paint, kept].sort())
    // The merged thread's id names the one it is under (a card or a line that still holds it).
    const got = (await (await fetch(`${base}/api/v1/tasks/${leadId}/threads/${order}`)).json()) as { thread: OrgThread }
    expect(got.thread.id).toBe(kept)
    expect(changes).toContainEqual({ taskId: leadId, kind: 'merged', threadId: kept })
  }, 60_000)

  it('the node is read soon after, once he is out of its chat: one pass tells the lead the two cards on one matter', async () => {
    expect(threadAuditSoonWaiting()).toContain(leadId)
    // He typed here a moment ago: a note now would wake the lead ahead of his next words. The read waits and is armed again.
    resetThreadAuditSoonForTests()
    expect(await runThreadAuditSoon(leadId)).toBeNull()
    expect(judged).toHaveLength(0)
    expect(await notes()).toHaveLength(0)
    expect(threadAuditSoonWaiting()).toEqual([leadId])
    // Out of the chat for the quiet time: the read goes ahead.
    const later = Date.now() + SOON_QUIET_MS + 1000
    const r = await runThreadAuditSoon(leadId, later)
    expect(r).toMatchObject({ ran: true, delivery: 'woke', calls: 1 })
    // The repeat wakes the lead; its two cards with no summary ride in the same note (thin).
    expect(r!.told.map((f) => f.kind)).toContain('repeat')
    expect(judged).toHaveLength(1)
    expect(judged[0]).toContain(`Title: ${T_PAINT}`)
    const sent = await notes()
    expect(sent).toHaveLength(1)
    expect(sent[0].message).toMatch(new RegExp(`thread_update \\{"id":"(${paint}|${kept})","merge_into":"(${paint}|${kept})"\\}`))
    // The check itself merged nothing here: the two cards hold different replies.
    expect((await open()).map((t) => t.id).sort()).toEqual([paint, kept].sort())
    // A second read tells nothing new and asks the model nothing again.
    expect(await runThreadAuditSoon(leadId, later + 1000)).toMatchObject({ ran: true, delivery: 'none', calls: 0 })
    expect(await notes()).toHaveLength(1)
  }, 40_000)

  it('card lines that give each question its own summary leave two cards, each showing its own', async () => {
    const gateRead = await typeIntoChat(Q_GATE)
    const latchRead = await typeIntoChat(Q_LATCH)
    const gate = filedUnder(gateRead)
    const latch = filedUnder(latchRead)
    expect(gate).not.toBe(latch)
    await turn([gateRead, latchRead], `${R_GATE}\n\n${card(gate, 'title="Orchard gate swing" summary="Inward: the path outside is narrow."')}\n${card(latch, 'title="Orchard gate latch place" summary="On the post side, at hip height."')}`)
    await vi.waitFor(async () => {
      const now = await threads()
      expect(now.find((t) => t.id === gate)).toMatchObject({ state: 'answered', reply: 'Inward: the path outside is narrow.' })
      expect(now.find((t) => t.id === latch)).toMatchObject({ state: 'answered', reply: 'On the post side, at hip height.' })
      expect(now.find((t) => t.id === gate)!.messages[0].answer?.text).toBe(R_GATE)
      expect(now.find((t) => t.id === latch)!.messages[0].answer?.text).toBe(R_GATE)
    }, { timeout: 20_000, interval: 300 })
    await new Promise((r) => setTimeout(r, 1500))
    const now = await threads()
    expect(now.find((t) => t.id === gate)!.was).toBeUndefined()
    expect(listedForHim(now).map((x) => x.id)).toEqual(expect.arrayContaining([gate, latch]))
  }, 60_000)
})
