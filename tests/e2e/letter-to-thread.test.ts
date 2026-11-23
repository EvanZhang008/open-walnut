/**
 * Routine progress goes to a thread, never an inbox letter, on a real server (2026-11-20, the
 * user: "we prefer the thread instead of inbox. Inbox for the important message need my attention
 * right away, but thread is for all regular thing related to this thread, easier to track").
 * Letters go through human_inbox_send as a session sends them; the experiment task_threads is
 * switched the way Settings does (PUT /api/config).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-letter-to-thread', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { listLetters } from '../../src/core/human-inbox/store.js'
import { executeOp } from '../../src/ops/index.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { threadsForEveryTask } from '../../src/core/org/keeps-threads.js'
import { settleUserStatusSync } from '../../src/core/user-status-sync.js'

let base = ''
let trays = ''
let lead = ''
const TRAYS_SID = 'letter-thread-trays-session'
const OFF_SID = 'letter-thread-off-session'
const LEAD_SID = 'letter-thread-lead-session'
const letterEvents: string[] = []

async function flag(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { task_threads: on } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => expect(threadsForEveryTask()).toBe(on), { timeout: 5000 })
  await settleUserStatusSync()
}

const send = async (args: Record<string, unknown>, sid: string) => {
  const out = await executeOp('human_inbox_send', args, { apiBase: base, origin: '__local__', callerMode: 'session', callerSid: sid })
  if (!out.ok) throw new Error(out.message)
  return out.result as Record<string, any>
}
type Thread = { id: string; title: string; state: string; reply?: string; tasks?: string[]; opener?: { text: string; from: string } }
const threadsOf = async (taskId: string): Promise<Thread[]> =>
  ((await (await fetch(`${base}/api/v1/tasks/${taskId}/threads?open=1`)).json()) as { threads: Thread[] }).threads
const lettersFrom = async (taskId: string) => (await listLetters()).letters.filter((l) => l.sender?.taskId === taskId)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  bus.subscribe('letter-to-thread-test', (e) => {
    if (e.name === EventNames.HUMAN_INBOX_LETTER) letterEvents.push((e.data as { letterId: string }).letterId)
  }, { global: true, interest: ['human-inbox:'] })
  trays = (await addTask({ title: 'Order the seed trays', project: 'Orchard' })).task.id
  await createSessionRecord(TRAYS_SID, trays, 'Orchard')
  const off = (await addTask({ title: 'Mend the fence', project: 'Orchard' })).task.id
  // Turned off for this one task, the way its menu does.
  expect((await fetch(`${base}/api/tasks/${off}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threads_on: false }) })).status).toBe(200)
  await createSessionRecord(OFF_SID, off, 'Orchard')
  lead = (await addTask({ title: 'Orchard lead', project: 'Orchard', source: 'local', org_role: 'lead' } as never)).task.id
  await createSessionRecord(LEAD_SID, lead, 'Orchard')
})

afterAll(async () => {
  bus.unsubscribe('letter-to-thread-test')
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a letter that only informs, from a task that keeps Threads', () => {
  it('an info letter opens a thread in answered, writes no letter and buzzes nothing', async () => {
    await flag(true)
    const out = await send({ subject: 'Seed trays ordered', type: 'info', markdown: 'Two flats of **72 cells**, arriving Friday.', text: 'Two flats ordered' }, TRAYS_SID)
    expect(out.letterId).toBeUndefined()
    expect(out.threadId).toMatch(/^th-/)
    expect(out.instruction).toMatch(/Filed as an update of your thread th-[a-f0-9]+ "Seed trays ordered" \(opened for it\)/)
    expect(out.instruction).toMatch(/routine progress goes to threads, a letter only for what needs him right away/)
    expect(await lettersFrom(trays)).toEqual([])
    expect(letterEvents).toEqual([])
    const [thread] = await threadsOf(trays)
    expect(thread).toMatchObject({ id: out.threadId, title: 'Seed trays ordered', state: 'answered', reply: 'Two flats ordered' })
    expect(thread.opener).toMatchObject({ text: 'Two flats of **72 cells**, arriving Friday.', from: 'node' })
  })

  it('a later update with a subject like the thread\'s updates that thread; one naming it does too', async () => {
    const [first] = await threadsOf(trays)
    const like = await send({ subject: 'Seed trays ordered: shipped', type: 'completion', markdown: 'Tracking says Thursday.' }, TRAYS_SID)
    expect(like.threadId).toBe(first.id)
    expect(like.instruction).not.toMatch(/opened for it/)
    const named = await send({ subject: 'Courier booked', type: 'info', markdown: 'Morning slot.', thread: first.id, task_refs: [lead] }, TRAYS_SID)
    expect(named.threadId).toBe(first.id)
    const threads = await threadsOf(trays)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ state: 'answered', reply: '**Courier booked**\n\nMorning slot.' })
    expect(threads[0].tasks).toContain(lead)
    expect(await lettersFrom(trays)).toEqual([])
  })

  it('an update never answers a thread that waits on his decision, and a thread it names that is not open is said', async () => {
    const opened = await executeOp('thread_create', { title: 'Pick the tray supplier', text: 'Two quotes in: Greenleaf at $180 delivers Monday, Rootwell at $150 delivers in two weeks.', from: 'node', state: 'needs', user_kind: 'spending', user_kind_why: 'It spends his money on trays' }, { apiBase: base, origin: '__local__', callerMode: 'session', callerSid: TRAYS_SID })
    expect(opened.ok, opened.ok ? '' : opened.message).toBe(true)
    const needs = (await threadsOf(trays)).find((t) => t.title === 'Pick the tray supplier')!
    const out = await send({ subject: 'Third quote arrived', type: 'info', markdown: 'Cheaper by 10%.', thread: needs.id }, TRAYS_SID)
    expect(out.threadId).toBe(needs.id)
    expect((await threadsOf(trays)).find((t) => t.id === needs.id)).toMatchObject({ state: 'needs', reply: '**Third quote arrived**\n\nCheaper by 10%.' })
    const gone = await send({ subject: 'Watering schedule set', type: 'info', markdown: 'Twice a day.', thread: 'th-000000000000' }, TRAYS_SID)
    expect(gone.instruction).toMatch(/th-000000000000 is not one of your open threads/)
    // The raw route answers with the thread, never an id a letter op would read as a letter's.
    const raw = await fetch(`${base}/api/v1/human-inbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': TRAYS_SID }, body: JSON.stringify({ subject: 'Watering schedule set', type: 'info', markdown: 'Three times a day.' }) })
    expect(raw.status).toBe(201)
    const body = await raw.json() as Record<string, unknown>
    expect(body.id).toBeUndefined()
    expect(body).toMatchObject({ threadId: gone.threadId, filedToThread: { threadId: gone.threadId, created: false } })
    expect(await lettersFrom(trays)).toEqual([])
  })

  it('two updates at once on a new subject open one thread', async () => {
    const [a, b] = await Promise.all([
      send({ subject: 'Potting soil restocked', type: 'info', markdown: '40 litres.' }, TRAYS_SID),
      send({ subject: 'Potting soil restocked', type: 'info', markdown: '40 litres.' }, TRAYS_SID),
    ])
    expect(a.threadId).toBe(b.threadId)
    expect((await threadsOf(trays)).filter((t) => t.title === 'Potting soil restocked')).toHaveLength(1)
  })

  it('a decision, a review and an update the user asked for stay letters', async () => {
    const decision = await send({ subject: 'Which tray size?', type: 'action_required', markdown: '72 or 128 cells: the 72-cell trays fit the shelf, the 128-cell ones start twice the seedlings.', actions: [{ id: 'a', label: '72' }, { id: 'b', label: '128' }], user_kind: 'spending', user_kind_why: 'It buys trays with his money' }, TRAYS_SID)
    expect(decision.letterId).toMatch(/^lt-/)
    expect(decision.threadId).toBeUndefined()
    const review = await send({ subject: 'Check the planting plan', type: 'review', markdown: 'See /tmp/orchard/plan.md' }, TRAYS_SID)
    expect(review.letterId).toMatch(/^lt-/)
    const asked = await send({ subject: 'Weekly seed digest', type: 'info', markdown: 'Three orders.', user_asked: true }, TRAYS_SID)
    expect(asked.letterId).toMatch(/^lt-/)
    expect((await lettersFrom(trays)).map((l) => l.type).sort()).toEqual(['action_required', 'info', 'review'])
    expect(letterEvents).toEqual(expect.arrayContaining([decision.letterId, review.letterId, asked.letterId]))
  })

  it('a lead keeps Threads with the experiment off: its info letter goes to a thread too', async () => {
    await flag(false)
    const out = await send({ subject: 'Orchard week planned', type: 'info', markdown: 'Pruning Tuesday.' }, LEAD_SID)
    expect(out.threadId).toMatch(/^th-/)
    expect(await lettersFrom(lead)).toEqual([])
  })
})

describe('a task that keeps no Threads', () => {
  it('experiment off and no threads_on: a completion letter stays a letter; an info one nobody asked for is refused', async () => {
    await flag(false)
    const before = (await lettersFrom(trays)).length
    const out = await send({ subject: 'Seed trays arrived', type: 'completion', markdown: 'All there.' }, TRAYS_SID)
    expect(out.letterId).toMatch(/^lt-/)
    expect(out.threadId).toBeUndefined()
    expect((await lettersFrom(trays)).length).toBe(before + 1)
    // With no thread to take it, an FYI is not a letter either (human-inbox/info-letter-rule.ts).
    await expect(send({ subject: 'Seed trays unpacked', type: 'info', markdown: 'All there.' }, TRAYS_SID)).rejects.toThrow(/user_asked:true/)
    expect((await lettersFrom(trays)).length).toBe(before + 1)
  })

  it('experiment on but turned off for the task: a completion letter stays a letter', async () => {
    await flag(true)
    const out = await send({ subject: 'Fence mended', type: 'completion', markdown: 'North side.' }, OFF_SID)
    expect(out.letterId).toMatch(/^lt-/)
  })
})
