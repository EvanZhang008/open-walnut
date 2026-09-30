/**
 * The task list is handed to the page BEFORE the per-session status hydration.
 *
 * fetchTasks used to await `hydrateSessionStatuses` for every session the list
 * mentions. On a board of 6,440 tasks that is ~50 sequential
 * `/api/sessions/status` batches of 100 ids: the list was parsed 0.5s after the
 * request and then waited ~2.5s more before one row could render (2026-09-23).
 *
 * Pinned here:
 *  1. fetchTasks resolves while the first status batch is still in flight, and
 *     the batches still run (one at a time) and land in the store;
 *  2. list fetches that land while a chain runs start no second chain beside it:
 *     exactly one follow-up chain runs afterwards, with the NEWEST list's ids;
 *  3. a failing batch neither rejects anything nor stops the chain;
 *  4. finished tasks are left out of the list's hydration and hydrated on
 *     demand when one is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTask, fetchTasks, settleTaskListHydrationForTesting } from '../../web/src/api/tasks'
import { hydrateTaskSessionStatuses } from '../../web/src/api/sessions'
import { sessionStatusStore } from '../../web/src/stores/session-status-store'

type Pending = { url: string; resolve: (r: Response) => void }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
const tick = () => new Promise((r) => setTimeout(r, 0))

const sid = (i: number) => `sess-${String(i).padStart(4, '0')}`
function listOf(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${i + offset}`, title: `t${i + offset}`, phase: 'TODO', session_id: sid(i + offset),
  }))
}
function snapshot(sessionId: string, revision: number) {
  return {
    sessionId, taskId: null, process_status: 'running', activity: null, mode: 'default',
    planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude',
    statusRevision: revision, statusUpdatedAt: '2026-09-23T00:00:00.000Z',
  }
}

let pending: Pending[]
const statusCalls = () => pending.filter((p) => p.url.startsWith('/api/sessions/status'))
const idsOf = (p: Pending) => new URL(p.url, 'http://x').searchParams.get('ids')!.split(',')

beforeEach(() => {
  // Starting state: empty status store, idle connection gate, no requests seen.
  sessionStatusStore.clearForTesting()
  pending = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
    pending.push({ url: String(input), resolve })
  })))
})

afterEach(async () => {
  // Answer every status batch still coming so no chain leaks into the next case.
  const drain = settleTaskListHydrationForTesting()
  for (let i = 0; i < 200 && pending.length > 0; i++) {
    for (const p of pending.splice(0)) p.resolve(json({ statuses: {} }))
    await tick()
  }
  await drain
  vi.unstubAllGlobals()
})

/** Answer the oldest open status batch with a snapshot per id at `revision`. */
async function answerBatch(revision = 5) {
  const call = statusCalls()[0]
  expect(call, 'a status batch should be in flight').toBeTruthy()
  pending.splice(pending.indexOf(call), 1)
  const statuses = Object.fromEntries(idsOf(call).map((id) => [id, snapshot(id, revision)]))
  call.resolve(json({ statuses }))
  await tick(); await tick()
}

async function answerList(tasks: unknown[]) {
  const call = pending.find((p) => p.url.startsWith('/api/tasks?'))!
  pending.splice(pending.indexOf(call), 1)
  call.resolve(json({ tasks }))
}

describe('task list status hydration runs behind the list', () => {
  it('fetchTasks resolves while the status batches are still running, and they still land', async () => {
    const got = fetchTasks({ minimal: true })
    await tick()
    await answerList(listOf(250))
    const tasks = await got
    expect(tasks).toHaveLength(250)
    // The list is back; the FIRST batch is only now on the wire.
    await tick()
    expect(statusCalls()).toHaveLength(1)
    expect(idsOf(statusCalls()[0])).toHaveLength(100)
    expect(sessionStatusStore.getStatus(sid(0))).toBeNull()

    // One batch at a time: 100 + 100 + 50.
    await answerBatch()
    expect(statusCalls()).toHaveLength(1)
    await answerBatch()
    expect(idsOf(statusCalls()[0])).toHaveLength(50)
    await answerBatch()
    await settleTaskListHydrationForTesting()
    expect(statusCalls()).toHaveLength(0)
    expect(sessionStatusStore.getStatus(sid(0))?.statusRevision).toBe(5)
    expect(sessionStatusStore.getStatus(sid(249))?.statusRevision).toBe(5)
  })

  it('lists that land mid-chain queue ONE follow-up chain with the newest ids', async () => {
    const first = fetchTasks({ minimal: true })
    await tick()
    await answerList(listOf(150))
    await first
    await tick()
    expect(statusCalls()).toHaveLength(1)

    // Two more list refetches while the first chain is still on batch 1.
    for (const offset of [1000, 2000]) {
      const again = fetchTasks({ minimal: true })
      await tick()
      await answerList(listOf(30, offset))
      await again
      await tick()
      // Never a second chain beside the first.
      expect(statusCalls()).toHaveLength(1)
    }

    await answerBatch() // chain 1, batch 1 (100 ids)
    expect(idsOf(statusCalls()[0])).toHaveLength(50)
    await answerBatch() // chain 1, batch 2 (50 ids)
    await tick()
    // The follow-up covers the NEWEST list only (the middle one was superseded).
    expect(statusCalls()).toHaveLength(1)
    expect(idsOf(statusCalls()[0])).toEqual(Array.from({ length: 30 }, (_, i) => sid(2000 + i)))
    await answerBatch()
    await settleTaskListHydrationForTesting()
    expect(statusCalls()).toHaveLength(0)
  })

  it('a failing batch rejects nothing and the chain moves on', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const got = fetchTasks({ minimal: true })
      await tick()
      await answerList(listOf(120))
      await got
      await tick()
      const call = statusCalls()[0]
      pending.splice(pending.indexOf(call), 1)
      call.resolve(json({ error: 'boom' }, 500))
      await tick(); await tick()
      // Batch 2 still goes out.
      expect(idsOf(statusCalls()[0])).toHaveLength(20)
      await answerBatch()
      await settleTaskListHydrationForTesting()
      expect(sessionStatusStore.getStatus(sid(119))?.statusRevision).toBe(5)
      expect(sessionStatusStore.getStatus(sid(0))).toBeNull()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('finished tasks are not hydrated by the list', () => {
  // A live board: 4,792 sessions, 164 of them on tasks that are not completed
  // (2026-09-29). Hydrating every one was 48 serial requests per load.
  function mixedList() {
    const open = listOf(3)
    const done = Array.from({ length: 250 }, (_, i) => ({
      id: `done-${i}`, title: `d${i}`, phase: 'COMPLETE', session_id: sid(5000 + i),
      session_status: { process_status: 'stopped' },
    }))
    // An older server may still say `status: 'done'` without the phase.
    const legacyDone = { id: 'legacy-done', title: 'l', phase: 'TODO', status: 'done', session_id: sid(9000) }
    return [...open, ...done, legacyDone]
  }

  it('the list hydrates the open tasks only, and the finished ones keep their seeded status', async () => {
    const got = fetchTasks({ minimal: true })
    await tick()
    await answerList(mixedList())
    expect(await got).toHaveLength(254)
    await tick()

    expect(statusCalls()).toHaveLength(1)
    expect(idsOf(statusCalls()[0])).toEqual([sid(0), sid(1), sid(2)])
    await answerBatch()
    await settleTaskListHydrationForTesting()
    expect(statusCalls()).toHaveLength(0)
    expect(sessionStatusStore.getStatus(sid(0))?.statusRevision).toBe(5)
    // Seeded from the list payload, unversioned, so any live event still wins.
    expect(sessionStatusStore.getStatus(sid(5000))).toMatchObject({ process_status: 'stopped', statusRevision: null })
  })

  it('opening a finished task hydrates its sessions on demand', async () => {
    const task = { id: 'done-x', title: 'x', phase: 'COMPLETE', session_id: sid(7000), session_ids: [sid(6999), sid(7001)] }
    const done = hydrateTaskSessionStatuses([task as never])
    await tick()
    expect(statusCalls()).toHaveLength(1)
    expect(idsOf(statusCalls()[0])).toEqual([sid(7000), sid(7001)])
    await answerBatch(8)
    await done
    expect(sessionStatusStore.getStatus(sid(7000))?.statusRevision).toBe(8)
  })

  it('fetchTask hydrates a finished task too', async () => {
    const got = fetchTask('done-y')
    await tick()
    const call = pending.find((p) => p.url.startsWith('/api/tasks/done-y'))!
    pending.splice(pending.indexOf(call), 1)
    call.resolve(json({ task: { id: 'done-y', title: 'y', phase: 'COMPLETE', session_id: sid(7100) } }))
    await tick(); await tick()
    expect(idsOf(statusCalls()[0])).toEqual([sid(7100)])
    await answerBatch(3)
    await got
    expect(sessionStatusStore.getStatus(sid(7100))?.statusRevision).toBe(3)
  })
})
