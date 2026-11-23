/**
 * The task's own ask lives on its thread, on a real server with only the CLI faked
 * (src/core/org/thread-report-ask.ts; 2026-11-20, the user, on a task with Threads on: its thread
 * read "Done" while its ask card waited for him above the chat, "the same thing shows twice").
 *
 * Under the experiment task_threads, a task with two of his threads is asked where it stands; its
 * answer asks him a decision and names the thread it is about (FOR_USER_ASK_THREAD). The Threads
 * read shows that thread as Needs you with the ask's decision id, the same id as the task's one
 * Action needed item, its summary leading with the question; the other thread is as it was. The
 * next answer asks nothing: the thread reads what its line says. An ask stored by an older build
 * with no place (written straight to the report) is placed at its next derive, on the thread his
 * newest message was filed to, once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-status-question-ask-thread'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { askStatus, settleStatusQuestion } from '../../src/core/sessions/status-question.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { threadsForEveryTask } from '../../src/core/org/keeps-threads.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { oneCardNow } from '../../src/core/org/one-card.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const SID = 'ask-thread-session'
let base = ''
let taskId = ''
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const PRACTICE = 'th-a5c0de01'
const READING = 'th-a5c0de02'
const ASK = 'Design the donation record tables and the API for them, then send them here'

function fixture(): OrgThread[] {
  return [
    { id: PRACTICE, title: 'System design practice 2', titled: true, state: 'answered', reply: 'Walked through the donation flow.', createdAt: ago(60), updatedAt: ago(5),
      messages: [
        { id: 'tm-a5c0de01', at: ago(60), text: 'Let us do system design practice', via: 'chat', answer: { text: 'The topic is a donation site.', at: ago(59) } },
        { id: 'tm-a5c0de02', at: ago(6), text: 'Ok what next', via: 'chat' },
      ] },
    // He read its summary (he reacted 10 minutes after it): a line may move it. An answer he has
    // not read stays in his sight whatever the line says (status-threads-consistency.test.ts).
    { id: READING, title: 'Reading list for the week', titled: true, state: 'answered', reply: 'Three chapters picked.', replyAt: ago(45), reactedAt: ago(35), createdAt: ago(50), updatedAt: ago(35),
      messages: [{ id: 'tm-a5c0de03', at: ago(50), text: 'Pick my reading for the week', via: 'chat' }] },
  ]
}

function fakeSession(answer: (prompt: string) => string) {
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async (prompt: string) => answer(prompt)), detach: () => {}, kill: () => {}, get active() { return false } }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, fake)
  return fake
}

const refOf = (prompt: string, title: string): string => {
  const m = new RegExp(`(t\\d+) "${title}"`).exec(prompt)
  if (!m) throw new Error(`"${title}" is not in the question:\n${prompt}`)
  return m[1]
}

type WireThread = OrgThread & { heldAsk?: { id: string; ask: string; reply?: string } }
async function threadsRead(): Promise<WireThread[]> {
  const res = await fetch(`${base}/api/v1/tasks/${taskId}/threads`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: WireThread[] }).threads
}

async function derive(): Promise<void> {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([taskId]))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { task_threads: true, threads_one_card: true } }) })
  expect(put.status).toBe(200)
  // The held ask is the one-card experiment's (threads_one_card); its off case is the last test.
  await vi.waitFor(() => expect(threadsForEveryTask() && oneCardNow()).toBe(true), { timeout: 5000 })
  taskId = (await addTask({ title: 'Interview practice', project: 'Study' })).task.id
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', session_id: SID }, { source: 'test' })
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, threads: fixture() }))
})

afterAll(async () => {
  await settleStatusQuestion(SID, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the task\'s ask lives on its thread', () => {
  it('the answer names the thread: it reads Needs you with the ask, one decision id', async () => {
    const fake = fakeSession((q) => [
      'FOR_USER_STATE: needs-you',
      `FOR_USER_ASK: ${ASK}`,
      'FOR_USER_ASK_OWN: user_own: it is his own practice design',
      `FOR_USER_ASK_THREAD: ${refOf(q, 'Reading list for the week')}`,
      `FOR_USER_THREAD: ${refOf(q, 'System design practice 2')} | answered | Walked through the donation flow.`,
    ].join('\n'))
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion.mock.calls[0][0] as string).toContain('FOR_USER_ASK_THREAD: <ref>')

    const report = (await getTask(taskId)).status_report!
    expect(report).toMatchObject({ state: 'needs', ask: ASK })
    expect(report.ask_thread).toBeUndefined()
    const id = report.ask_id!
    expect(id).toMatch(/^ask-/)
    // Stored as the place only: no thread is stored in needs (no buzz, no overdue clock of its own).
    const stored = (await readThreads(taskId)).threads
    expect(stored.find((t) => t.id === READING)?.reportAsk?.id).toBe(id)
    expect(stored.filter((t) => t.state === 'needs')).toEqual([])

    await derive()
    const status = (await getTask(taskId)).user_status!
    expect(status).toMatchObject({ state: 'needs', source: 'session' })
    expect(status.actions?.filter((i) => i.kind === 'ask').map((i) => i.id)).toEqual([id])
    // Its threads hold no second ask: the task's own is the one counted.
    expect(status.threads?.needs ?? 0).toBe(0)

    const threads = await threadsRead()
    const held = threads.find((t) => t.id === READING)!
    expect(held).toMatchObject({ state: 'needs', askId: id, heldAsk: { id, ask: ASK, reply: 'Three chapters picked.' } })
    expect(held.reply?.startsWith(ASK)).toBe(true)
    // The other thread reads as stored: no Done, no second ask.
    expect(threads.find((t) => t.id === PRACTICE)).toMatchObject({ state: 'answered' })
    expect(threads.find((t) => t.id === PRACTICE)?.heldAsk).toBeUndefined()
    // The item says which thread holds it (org/thread-holds.ts), so its row draws one line to that
    // thread, never a second card (2026-11-23, the user: "两处都改"); the next derive reads the place.
    await vi.waitFor(async () => {
      await derive()
      expect((await getTask(taskId)).user_status!.actions?.find((i) => i.kind === 'ask')?.thread).toEqual({ id: READING, title: held.title })
    }, { timeout: 15_000, interval: 300 })
  })

  it('the next answer asks nothing: the thread reads what its line says', async () => {
    await updateTaskRaw(taskId, { phase: 'IN_PROGRESS' }, { source: 'test' })
    fakeSession((q) => [
      'FOR_USER_STATE: working',
      'FOR_USER_NOW: Reviewing the tables he sent.',
      `FOR_USER_THREAD: ${refOf(q, 'Reading list for the week')} | working | Reading the tables.`,
    ].join('\n'))
    await settleStatusQuestion(SID, 10_000)
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    await derive()
    const threads = await threadsRead()
    const was = threads.find((t) => t.id === READING)!
    expect(was.state).toBe('working')
    expect(was.heldAsk).toBeUndefined()
    expect(threads.filter((t) => t.state === 'needs')).toEqual([])
    // It asks nothing now: the place is taken off (asked again later, the rule places it again).
    expect((await readThreads(taskId)).threads.filter((t) => t.reportAsk)).toEqual([])
  })

  it('an ask an older build stored with no place is placed at its next derive, once', async () => {
    // An older build's report: the ask with its id, and nothing on the threads for it.
    const file = path.join(WALNUT_HOME, 'org', 'threads', `${taskId}.json`)
    const at = new Date().toISOString()
    await updateTaskRaw(taskId, {
      phase: 'NEED_ACTION', phase_changed_at: at,
      status_report: { state: 'needs', ask: 'Pick the next practice topic', ask_id: 'ask-older1', at, turn_ended_at: at, session_id: SID },
    }, { source: 'test' })
    await derive()
    await vi.waitFor(async () => {
      const placed = (await readThreads(taskId)).threads.filter((t) => t.reportAsk)
      // His newest message is in the practice thread: the ask goes there.
      expect(placed.map((t) => [t.id, t.reportAsk!.id])).toEqual([[PRACTICE, 'ask-older1']])
    }, { timeout: 5000 })
    const before = await fs.readFile(file, 'utf8')
    await derive()
    await derive()
    // Idempotent: the next derives write nothing.
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    const held = (await threadsRead()).find((t) => t.id === PRACTICE)!
    expect(held).toMatchObject({ state: 'needs', askId: 'ask-older1', heldAsk: { id: 'ask-older1' } })
  })

  it('with the one-card setting off: the place is kept, every thread reads as stored, and the question asks for no thread', async () => {
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { task_threads: true, threads_one_card: false } }) })
    expect(put.status).toBe(200)
    await vi.waitFor(() => expect(oneCardNow()).toBe(false), { timeout: 5000 })
    // The stored place stays (an upgrade reads it again), unread.
    expect((await readThreads(taskId)).threads.find((t) => t.id === PRACTICE)?.reportAsk?.id).toBe('ask-older1')
    const threads = await threadsRead()
    expect(threads.find((t) => t.id === PRACTICE)).toMatchObject({ state: 'answered' })
    expect(threads.every((t) => !t.heldAsk && !('one_card' in t))).toBe(true)
    // No thread holds its ask now: its item says none, so its row draws the card.
    await derive()
    expect((await getTask(taskId)).user_status!.actions?.some((i) => i.thread) ?? false).toBe(false)
    await updateTaskRaw(taskId, { phase: 'IN_PROGRESS' }, { source: 'test' })
    const fake = fakeSession(() => 'FOR_USER_STATE: working\nFOR_USER_NOW: Reading.')
    await settleStatusQuestion(SID, 10_000)
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion.mock.calls[0][0] as string).not.toContain('FOR_USER_ASK_THREAD')
  })
})
