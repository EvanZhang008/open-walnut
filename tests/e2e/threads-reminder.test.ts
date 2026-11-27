/**
 * A reminder of the open threads now and then, on a real server with only the CLI faked
 * (experiment threads_reminder; src/core/sessions/status-thread-remind.ts; 2026-11-25, the user,
 * translated: "like that To Do": remind the agent of its open threads every so often, not every
 * turn).
 *
 * A lead holds one quiet thread; he writes two requests in its chat. Turn by turn:
 *   1. the first status question is the reminder: his two new threads in full (each needs a
 *      title and a line), the quiet one as a short item, with the rule "a line only when it moved";
 *   2. a turn that answered only a peer note still asks about the thread the lead is working on
 *      (that turn may have finished it), and only that one;
 *   3. a quiet turn after it, nothing in hand, asks about no thread at all;
 *   4. his follow-up on one thread: the next question lists that thread only;
 *   5. the fifth question after the reminder is the reminder again: what the lead wrote since the
 *      last one is left out and counted;
 *   6. with threads_reply_tag on, a thread the reply's card line spoke for is left out of the
 *      question between reminders and of the reminder a compaction brings (which leaves out
 *      nothing else);
 *   7. the switch off: every question lists every open thread, as before.
 * No CLI runs: each message leaves the queue as a CLI takes it, the chat is written as a CLI writes
 * its transcript, and the status question is answered by a fake session.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-threads-reminder'))
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
import { askStatus, settleStatusQuestion } from '../../src/core/sessions/status-question.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { threadsKeptNow } from '../../src/core/org/threads-kept.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { REMIND_EVERY } from '../../src/core/sessions/status-thread-remind.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const SID = '55555555-6666-4777-8888-999999999990'
const COMPOST = 'th-c0ffee01'
let base = ''
let leadId = ''
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const sessions = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions

async function setFlags(f: { reminder: boolean; tag?: boolean }): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_kept_by_walnut: true, threads_reminder: f.reminder, threads_reply_tag: !!f.tag } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(threadsKeptNow()).toBe(true); expect(replyTagNow()).toBe(!!f.tag) }, { timeout: 5000 })
}

/** The web send's own steps (routes/session-chat.ts), then the line leaves the queue as a CLI takes it. */
async function typeIntoChat(text: string, threadId?: string): Promise<string> {
  const record = await getSessionByClaudeId(SID)
  const prepared = await prepareHintedSend(SID, record, text, { sentBy: 'person', ...(threadId ? { threadId } : {}) })
  await sendMessageToSession(SID, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  const rows = await markNextProcessing(SID)
  expect(rows).toHaveLength(1)
  await removeProcessed(SID, rows.map((r) => r.id))
  expect(await getQueue(SID)).toEqual([])
  return rows[0].message
}

let seq = 0
/** One turn: his message as the model read it, the reply, and the turn's end as the runner says it. */
async function turn(asRead: string, reply: string): Promise<void> {
  const lines = [{ type: 'user', text: asRead }, { type: 'assistant', text: reply }].map((r) => {
    seq += 1
    return {
      type: r.type, uuid: `${SID.slice(0, 8)}-0000-4000-8000-${String(seq).padStart(12, '0')}`, timestamp: new Date(Date.now() + seq).toISOString(),
      message: r.type === 'user' ? { role: 'user', content: [{ type: 'text', text: r.text }] } : { id: `msg-${seq}`, role: 'assistant', content: [{ type: 'text', text: r.text }] },
    }
  })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(path.join(dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: leadId, result: reply, isError: false }, ['*'], { source: 'session-runner' })
}

const filedUnder = (asRead: string): string => {
  const m = /th-[0-9a-f]{6,32}/.exec(asRead)
  if (!m) throw new Error(`no thread named in:\n${asRead}`)
  return m[0]
}
const threadOf = async (id: string): Promise<OrgThread> => (await readThreads(leadId)).threads.find((t) => t.id === id)!

/** The status question at a turn's end, answered by a fake session; returns what it asked. */
async function ask(answer: (q: string) => string[]): Promise<string> {
  await settleStatusQuestion(SID, 10_000)
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async (q: string) => ['FOR_USER_STATE: working', 'FOR_USER_NOW: Planning the orchard.', ...answer(q)].join('\n')), detach: () => {}, kill: () => {}, get active() { return false } }
  sessions.set(SID, fake)
  try {
    expect(await askStatus(leadId, SID, Date.now())).toBe(true)
  } finally {
    sessions.delete(SID)
  }
  return fake.askSideQuestion.mock.calls[0][0] as string
}

const refOf = (q: string, title: string): string => {
  const m = new RegExp(`(t\\d+) "${title.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(q)
  if (!m) throw new Error(`"${title}" is not in the question:\n${q}`)
  return m[1]
}
const quietAnswer = () => [] as string[]

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  process.env.WALNUT_THREAD_REOPEN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leadId = (await ensureProjectLead('Orchard')).id
  await createSessionRecord(SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(SID, { process_status: 'stopped' })
  // One quiet thread the lead keeps pending: a team has it.
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  const compost: OrgThread = { id: COMPOST, title: 'Compost delivery', titled: true, state: 'pending', reply: 'The garden team orders it on Monday.', replyAt: ago(90), createdAt: ago(120), updatedAt: ago(90), by: `task:${leadId}`,
    opener: { text: 'Compost for the beds', at: ago(120), by: `task:${leadId}` }, messages: [] } as OrgThread
  await fs.writeFile(path.join(dir, `${leadId}.json`), JSON.stringify({ version: 1, taskId: leadId, threads: [compost] }))
}, 30_000)

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  delete process.env.WALNUT_THREAD_REOPEN_SECS
  await settleStatusQuestion(SID, 10_000)
  sessions.delete(SID)
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a reminder of the open threads now and then', () => {
  let fence = ''
  let seeds = ''

  it('the first question is the reminder: his new threads in full, the quiet one short', async () => {
    await setFlags({ reminder: true })
    const fenceRead = await typeIntoChat('How tall should the orchard fence be?')
    fence = filedUnder(fenceRead)
    await turn(fenceRead, 'Two metres keeps the deer out.')
    const seedsRead = await typeIntoChat('Order the seeds for spring.')
    seeds = filedUnder(seedsRead)
    expect(seeds).not.toBe(fence)
    await turn(seedsRead, 'Two suppliers carry them; I compare them.')
    await vi.waitFor(async () => { expect((await threadOf(seeds)).messages[0].answer).toBeTruthy() }, { timeout: 20_000, interval: 300 })

    const q = await ask((q) => [
      `FOR_USER_THREAD: ${refOf(q, 'How tall should the orchard fence be?')} | answered | Two metres keeps the deer out.`,
      `FOR_USER_THREAD_TITLE: ${refOf(q, 'How tall should the orchard fence be?')} | Orchard fence`,
      `FOR_USER_THREAD: ${refOf(q, 'Order the seeds for spring.')} | working | Comparing two seed suppliers.`,
      `FOR_USER_THREAD_TITLE: ${refOf(q, 'Order the seeds for spring.')} | Spring seed order`,
    ])
    expect(q).toMatch(/t\d+ "How tall should the orchard fence be\?" \(new, [^)]*untitled/)
    expect(q).toMatch(/Reminder of your other open threads[^\n]*: pending: t\d+ "Compost delivery" 2h\./)
    expect(await threadOf(fence)).toMatchObject({ title: 'Orchard fence', state: 'answered', reply: 'Two metres keeps the deer out.' })
    expect(await threadOf(seeds)).toMatchObject({ title: 'Spring seed order', state: 'working' })
    expect(await threadOf(COMPOST)).toMatchObject({ state: 'pending', reply: 'The garden team orders it on Monday.' })
  }, 60_000)

  it('a turn that answered only a peer note still asks about the thread in hand, and only that one', async () => {
    // The turn ended on a peer's note (a subtask's report): nothing of his was filed, the seeds
    // order may be done now. Its line is asked as it is every turn without the switch.
    const q = await ask((q) => [`FOR_USER_THREAD: ${refOf(q, 'Spring seed order')} | waiting | The purchasing team orders from Larch Seeds on Monday.`])
    expect(q).toContain('t1 "Spring seed order" (working')
    expect(q).not.toContain('Orchard fence')
    expect(q).not.toContain('Compost delivery')
    expect(await threadOf(seeds)).toMatchObject({ state: 'pending', reply: 'The purchasing team orders from Larch Seeds on Monday.' })
  }, 30_000)

  it('a quiet turn with nothing in hand asks about no thread at all', async () => {
    const q = await ask(quietAnswer)
    expect(q).not.toContain('FOR_USER_THREAD')
    expect(q).not.toContain('open threads')
  }, 30_000)

  it('his follow-up on one thread: the next question lists that thread only', async () => {
    const read = await typeIntoChat('And the gate, which way should it swing?', fence)
    expect(filedUnder(read)).toBe(fence)
    await turn(read, 'Inward: the path outside is narrow.')
    const q = await ask((q) => [`FOR_USER_THREAD: ${refOf(q, 'Orchard fence')} | answered | Two metres; the gate swings inward.`])
    expect(q).toContain('t1 "Orchard fence"')
    expect(q).not.toContain('Spring seed order')
    expect(q).not.toContain('Compost delivery')
    expect(q).not.toContain('Reminder of')
    expect((await threadOf(fence)).reply).toBe('Two metres; the gate swings inward.')
  }, 60_000)

  it(`question ${REMIND_EVERY + 1}, the fifth after the reminder, is the reminder again`, async () => {
    // Questions 2, 3 and 4 were above; 5 is quiet.
    expect(await ask(quietAnswer)).not.toContain('FOR_USER_THREAD')
    const q = await ask(quietAnswer)
    expect(q).toMatch(/Reminder of your other open threads[^\n]*: pending: t1 "Compost delivery" 2h\. Not shown: 2 you wrote since the last reminder\./)
    expect(q).not.toContain('Orchard fence')
    expect(await threadOf(seeds)).toMatchObject({ state: 'pending' })
  }, 60_000)

  it('with threads_reply_tag on, what a reply\'s card line spoke for is left out of the question and the reminder', async () => {
    await setFlags({ reminder: true, tag: true })
    const read = await typeIntoChat('Did the seed order go out?', seeds)
    expect(filedUnder(read)).toBe(seeds)
    await turn(read, `Yes, Larch Seeds has it.\n\n<walnut-card thread="${seeds}" state="waiting" summary="Larch Seeds ships the order on Friday."/>`)
    await vi.waitFor(async () => { expect(await threadOf(seeds)).toMatchObject({ state: 'pending', reply: 'Larch Seeds ships the order on Friday.' }) }, { timeout: 20_000, interval: 300 })
    // Between reminders: the thread his word moved is spoken for. (The fence's answer may be asked
    // for his reaction, when his new message came after he could read it: thread-view.ts readAfter.)
    const between = await ask(quietAnswer)
    // Not asked about as a thread (`tN "title"`); on a slow machine his words since may still quote its title there.
    expect(between).not.toMatch(/t\d+ "Spring seed order"/)
    expect(between).not.toContain('Compost delivery')
    // A compaction brings the reminder: every open thread but the one the line spoke for, none left out.
    await updateSessionRecord(SID, { lastCompactAt: new Date().toISOString() })
    const q = await ask(quietAnswer)
    expect(q).toContain('"Orchard fence"')
    expect(q).toMatch(/pending: t\d+ "Compost delivery" 2h\./)
    expect(q).not.toMatch(/t\d+ "Spring seed order"/)
    expect(q).not.toContain('Not shown')
  }, 60_000)

  it('off: every question lists every open thread, as before', async () => {
    await setFlags({ reminder: false })
    for (let i = 0; i < 2; i++) {
      const q = await ask(quietAnswer)
      for (const title of ['Orchard fence', 'Spring seed order', 'Compost delivery']) expect(q).toContain(`"${title}"`)
      expect(q).not.toContain('Reminder of')
    }
  }, 60_000)
})
