/**
 * Walnut keeps a lead's Threads from its status answer, on a real server with only the CLI faked
 * (experiment threads_kept_by_walnut, src/core/org/threads-kept.ts; 2026-11-22, the user, on a VP
 * that wrote a thread before each reply: "every thread is being updated, every question has to do
 * this ... that's unbelievable, and very wasteful").
 *
 * A lead holds two of his threads: one it answered that he wrote after, one new and untitled whose
 * summary his message outdated. With the switch off, its turn end is held until it rewrites the
 * summary (the Stop hook) and its status question asks nothing about threads. On: the turn ends
 * with no hold, the status question lists both threads with what each lacks, and the answer's lines
 * write the title, the state, the summary, the known mark and the close, by the lead itself. A
 * reaction the answer claims where he never wrote is not asked and not written.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-threads-kept-by-walnut'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { askStatus, settleStatusQuestion, statusKeepsThreads } from '../../src/core/sessions/status-question.js'
import { threadsKeptNow } from '../../src/core/org/threads-kept.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { resetSummaryNudges } from '../../src/core/org/thread-summary-stop.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import '../../src/ops/index.js'

const SID = '44444444-5555-6666-7777-000000000001'
let base = ''
let taskId = ''
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const FENCE = 'th-feec0de1'
const SEEDS = 'th-feec0de2'
const OTHER = 'th-feec0de3'

function fixture(): OrgThread[] {
  return [
    // Answered 30 minutes ago; he wrote again 10 minutes ago (in the seeds thread).
    { id: FENCE, title: 'Orchard fence', titled: true, state: 'answered', reply: 'Two metres keeps the deer out.', replyAt: ago(30), createdAt: ago(40), updatedAt: ago(30), by: 'task:x',
      messages: [{ id: 'tm-feec0de1', at: ago(40), text: 'How tall should the orchard fence be?', via: 'chat', answer: { text: 'Two metres keeps the deer out.', at: ago(30) } }] },
    // Walnut's stand-in title, no summary yet: his message is newer than any summary.
    { id: SEEDS, title: 'ok, now order the seeds for spring', state: 'new', createdAt: ago(10), updatedAt: ago(10),
      messages: [{ id: 'tm-feec0de2', at: ago(10), text: 'ok, now order the seeds for spring', via: 'chat', answer: { text: 'On it: I compare two suppliers.', at: ago(9) } }] },
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

async function setKept(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_kept_by_walnut: on } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => expect(threadsKeptNow()).toBe(on), { timeout: 5000 })
}

async function stopHold(): Promise<string> {
  const r = await executeOp('open_items', { hook: 'stop' }, { apiBase: `${base}/api/v1`, callerSid: SID, origin: LOCAL_ORIGIN })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return JSON.stringify((r as { result: unknown }).result)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  taskId = (await addTask({ title: 'Garden VP', project: 'Garden' })).task.id
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', session_id: SID, org_role: 'lead' }, { source: 'test' })
  await createSessionRecord(SID, taskId, 'Garden', '/repo/garden', { title: 'Garden VP' })
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, threads: fixture() }))
}, 30_000)

afterAll(async () => {
  await settleStatusQuestion(SID, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Walnut keeps a lead\'s Threads', () => {
  it('off: the turn end is held for the summary, and the status question asks nothing about threads', async () => {
    await setKept(false)
    resetSummaryNudges()
    expect(await stopHold()).toContain(SEEDS)
    const fake = fakeSession(() => 'FOR_USER_STATE: working\nFOR_USER_NOW: Comparing seed suppliers.')
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion.mock.calls[0][0] as string).not.toContain('FOR_USER_THREAD')
  })

  it('on: no hold, and the answer\'s lines keep both threads by the lead itself', async () => {
    await setKept(true)
    resetSummaryNudges()
    expect(await stopHold()).not.toContain(SEEDS)
    await settleStatusQuestion(SID, 10_000)
    const fake = fakeSession((q) => [
      'FOR_USER_STATE: working',
      'FOR_USER_NOW: Comparing seed suppliers.',
      `FOR_USER_THREAD: ${refOf(q, 'Orchard fence')} | done | Two metres; the posts are set.`,
      `FOR_USER_THREAD: ${refOf(q, 'ok, now order the seeds for spring')} | working | Comparing two seed suppliers on price and delivery.`,
      `FOR_USER_THREAD_TITLE: ${refOf(q, 'ok, now order the seeds for spring')} | Spring seed order`,
      `FOR_USER_THREAD_SEEN: ${refOf(q, 'Orchard fence')}, ${refOf(q, 'ok, now order the seeds for spring')}`,
    ].join('\n'))
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    const q = fake.askSideQuestion.mock.calls[0][0] as string
    // An answered card is quoted beside its state, so the node can tell whether it still holds (status-thread-card.ts cardPart).
    expect(q).toContain('"Orchard fence" (answered, he wrote elsewhere since your answer here; card: "Two metres keeps the deer out.")')
    expect(q).toContain('His messages since, newest first:')
    // The thread he wrote in just before it is named beside it, to merge back if it was that subject (status-thread-title.ts nearThreads).
    expect(q).toContain(`"ok, now order the seeds for spring" (new, he wrote in ${refOf(q, 'Orchard fence')} just before it: merge it into one only if it is that subject, untitled)`)
    expect(q).not.toContain('FOR_USER_THREAD_NEW')
    const byId = new Map((await readThreads(taskId)).threads.map((t) => [t.id, t]))
    const fence = byId.get(FENCE)!
    expect(fence.closed).toMatchObject({ how: 'acked', by: `task:${taskId}` })
    expect(fence.known).toBeTruthy()
    const seeds = byId.get(SEEDS)!
    expect(seeds).toMatchObject({ title: 'Spring seed order', titled: true, state: 'working', reply: 'Comparing two seed suppliers on price and delivery.', by: `task:${taskId}` })
    // He wrote nothing after the seeds answer: its claimed reaction was not asked, nothing is known.
    expect(seeds.known).toBeUndefined()
  })

  it('on: an answer he has not written after is never marked, whatever the answer says', async () => {
    const file = path.join(WALNUT_HOME, 'org', 'threads', `${taskId}.json`)
    const cur = (await readThreads(taskId)).threads
    const other: OrgThread = { id: OTHER, title: 'Greenhouse vents', titled: true, state: 'answered', reply: 'The vents open at 26 degrees.', replyAt: ago(1), createdAt: ago(2), updatedAt: ago(1), by: `task:${taskId}`,
      messages: [{ id: 'tm-feec0de3', at: ago(2), text: 'When do the greenhouse vents open?', via: 'chat', answer: { text: 'The vents open at 26 degrees.', at: ago(1) } }] }
    await fs.writeFile(file, JSON.stringify({ version: 1, taskId, threads: [...cur, other] }))
    await settleStatusQuestion(SID, 10_000)
    const fake = fakeSession((q) => [
      'FOR_USER_STATE: working',
      `FOR_USER_THREAD: ${refOf(q, 'Greenhouse vents')} | done | The vents open at 26 degrees.`,
      `FOR_USER_THREAD_SEEN: ${refOf(q, 'Greenhouse vents')}`,
    ].join('\n'))
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion.mock.calls[0][0] as string).toContain('"Greenhouse vents" (answered; card: "The vents open at 26 degrees.")')
    const vents = (await readThreads(taskId)).threads.find((t) => t.id === OTHER)!
    expect(vents.closed).toBeUndefined()
    expect(vents.known).toBeUndefined()
    expect(vents.state).toBe('answered')
  })

  it('on: a lead keeps its own state and opens no subject from a line', async () => {
    await settleStatusQuestion(SID, 10_000)
    const before = (await readThreads(taskId)).threads.length
    fakeSession((q) => [
      'FOR_USER_STATE: done',
      'FOR_USER_NOW: The seed order went to the purchasing team.',
      `FOR_USER_THREAD: ${refOf(q, 'Spring seed order')} | waiting | The purchasing team orders on Monday.`,
      'FOR_USER_THREAD_NEW: waiting | Compost delivery | The truck comes Tuesday.',
    ].join('\n'))
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    const report = (await getTask(taskId)).status_report!
    expect(report.state).toBe('done')
    expect(report.from_threads).toBeUndefined()
    const threads = (await readThreads(taskId)).threads
    expect(threads.length).toBe(before)
    expect(threads.find((t) => t.id === SEEDS)).toMatchObject({ state: 'pending', reply: 'The purchasing team orders on Monday.' })
  })

  it('on: a session whose engine takes no status question keeps the old asks', async () => {
    expect(await statusKeepsThreads(SID)).toBe(true)
    const other = '44444444-5555-6666-7777-000000000002'
    // One active session per task: the other engine's session belongs to another lead.
    const otherLead = (await addTask({ title: 'Orchard VP', project: 'Garden' })).task.id
    await updateTaskRaw(otherLead, { org_role: 'lead' }, { source: 'test' })
    await createSessionRecord(other, otherLead, 'Garden', '/repo/garden', { title: 'Orchard VP on another engine' })
    await updateSessionRecord(other, { engine: 'codex' })
    expect(await statusKeepsThreads(other)).toBe(false)
  })
})
