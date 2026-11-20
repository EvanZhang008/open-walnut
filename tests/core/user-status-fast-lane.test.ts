/**
 * A change made by hand is derived at once (src/core/user-status-sync.ts, the fast lane).
 * 2026-11-19: a thread acted on in the Org page kept its node's red dot for 20 to 35 s. The
 * derived status waited 1.5 s of debounce and then queued behind passes of every task, which
 * took 2 to 11 s each on the user's data. The debounce folds the events sessions emit on every
 * turn; a click has no burst to fold.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-user-status-fast-lane'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { holdStatusWritesForTest, sessionMovesNow, startUserStatusSync, stopUserStatusSync, settleUserStatusSync, syncUserStatuses } from '../../src/core/user-status-sync.js'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  stopUserStatusSync()
})

afterAll(async () => {
  stopUserStatusSync()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until the stored status reads `state`, at most `ms`; the time it took, or null. */
async function readsWithin(id: string, state: string, ms: number): Promise<number | null> {
  const began = Date.now()
  while (Date.now() - began < ms) {
    if ((await getTask(id)).user_status?.state === state) return Date.now() - began
    await sleep(15)
  }
  return null
}

describe('the fast lane', () => {
  it('a phase written through the API is derived well inside the debounce', async () => {
    const t = (await addTask({ title: 'Set by hand', project: 'Acme' })).task
    startUserStatusSync()
    await settleUserStatusSync()
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'api' })
    // The ordinary lane waits 1.5 s before it even starts; the fast one answers in a few ms.
    const took = await readsWithin(t.id, 'needs', 1_000)
    expect(took, 'the status never read Needs you inside 1 s').not.toBeNull()
  })

  it('a session\'s own write keeps the debounce: it is not a hand\'s', async () => {
    const t = (await addTask({ title: 'Written by a turn', project: 'Acme' })).task
    startUserStatusSync()
    await settleUserStatusSync()
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'session' })
    expect(await readsWithin(t.id, 'needs', 600)).toBeNull()
    await settleUserStatusSync()
    expect((await getTask(t.id)).user_status?.state).toBe('needs')
  })

  it('a thread change on a node is derived at once', async () => {
    const t = (await addTask({ title: 'Node', project: 'Acme' })).task
    startUserStatusSync()
    await settleUserStatusSync()
    // The event the threads store emits; a mark only, the status has nothing to move here.
    const before = (await getTask(t.id)).user_status
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'session' })
    bus.emit(EventNames.ORG_THREADS_CHANGED, { taskId: t.id }, ['web-ui'], { source: 'org-threads' })
    const took = await readsWithin(t.id, 'needs', 1_000)
    expect(took, `still ${JSON.stringify(before)} after 1 s`).not.toBeNull()
  })

  it('a turn that starts is derived at once: the answer a page predicts as Working lands in time', async () => {
    const t = (await addTask({ title: 'Answered', project: 'Acme' })).task
    startUserStatusSync()
    await settleUserStatusSync()
    // A session's own write waits the debounce; its turn starting puts the task on the fast lane.
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'session' })
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { taskId: t.id, sessionId: 's-1', process_status: 'running' }, ['*'])
    expect(await readsWithin(t.id, 'needs', 1_000), 'the status waited the debounce').not.toBeNull()
  })

  it('which session events take the fast lane: a turn running, a prompt, a start; a turn ending folds', () => {
    expect(sessionMovesNow(EventNames.SESSION_STATUS_CHANGED, { process_status: 'running' })).toBe(true)
    expect(sessionMovesNow(EventNames.SESSION_STATUS_CHANGED, { status: { process_status: 'running' } })).toBe(true)
    expect(sessionMovesNow(EventNames.SESSION_STATUS_CHANGED, { process_status: 'idle' })).toBe(false)
    expect(sessionMovesNow(EventNames.SESSION_PERMISSION_REQUEST, {})).toBe(true)
    expect(sessionMovesNow(EventNames.SESSION_PERMISSION_RESOLVED, {})).toBe(true)
    expect(sessionMovesNow(EventNames.SESSION_ENDED, {})).toBe(false)
    expect(sessionMovesNow(EventNames.SESSION_USAGE_LIMIT, {})).toBe(false)
  })

  it('a pass never writes a task marked again after it began', async () => {
    const t = (await addTask({ title: 'Raced', project: 'Acme' })).task
    startUserStatusSync()
    await settleUserStatusSync()
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'api' })
    await settleUserStatusSync()
    expect((await getTask(t.id)).user_status?.state).toBe('needs')
    // A pass of every task begins (its facts read the task as Needs you)...
    const stale = syncUserStatuses(null, Date.now())
    // ...and the user moves the task before that pass writes.
    await updateTask(t.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    await stale
    await settleUserStatusSync()
    // The newer answer stands: the older pass did not write over it.
    expect((await getTask(t.id)).user_status?.state).not.toBe('needs')
  })

  it('a pass that left a task to a later one returns only once that one has written it', async () => {
    // 2026-11-20: a pass of every task returned while the fast pass that had claimed one row was
    // still writing it, and its caller read the row with no status (tests/e2e/owed-close.test.ts).
    const x = (await addTask({ title: 'Before it', project: 'Acme' })).task
    const t = (await addTask({ title: 'Left to the later pass', project: 'Acme' })).task
    await updateTask(x.id, { phase: 'NEED_ACTION' }, { source: 'api' })
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'api' })
    const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r }); return { p, open } }
    const xWrite = gate(), xAt = gate(), tWrite = gate(), tReached = gate()
    // The earlier pass (every task) stalls on its write of x; the later pass (t alone) claims t
    // meanwhile and stalls on its write of t.
    let earlierPass = 0
    holdStatusWritesForTest(async (id, pass) => {
      if (id === x.id) { earlierPass = pass; xAt.open(); await xWrite.p }
      if (id === t.id && pass !== earlierPass) { tReached.open(); await tWrite.p }
    })
    try {
      const earlier = syncUserStatuses(null, Date.now())
      await xAt.p
      const later = syncUserStatuses(new Set([t.id]), Date.now())
      await tReached.p
      xWrite.open()
      // The earlier pass has left t to the later one: it does not return while that write is held.
      const settled = await Promise.race([earlier.then(() => 'returned'), sleep(200).then(() => 'pending')])
      expect(settled).toBe('pending')
      expect((await getTask(t.id)).user_status).toBeUndefined()
      tWrite.open()
      await Promise.all([earlier, later])
      // Whoever awaited the earlier pass reads t derived.
      expect((await getTask(t.id)).user_status?.state).toBe('needs')
    } finally {
      holdStatusWritesForTest(null)
    }
  })

  it('a pass whose write a later pass overtook returns only once that pass has written', async () => {
    // The same, met at the write: both passes derived the task, the later one claimed it while the
    // earlier one's write waited for the lock, so the lock refused the earlier write (shouldUpdate).
    const t = (await addTask({ title: 'Overtaken at the write', project: 'Acme' })).task
    await updateTask(t.id, { phase: 'NEED_ACTION' }, { source: 'api' })
    const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r }); return { p, open } }
    const first = gate(), second = gate(), earlierAtWrite = gate(), laterAtWrite = gate()
    let arrived = 0
    // The earlier pass claims the task and stalls at its write; only then does the later pass start,
    // so it claims the task over the earlier one and stalls at its own write.
    holdStatusWritesForTest(async (id) => {
      if (id !== t.id) return
      arrived += 1
      if (arrived === 1) { earlierAtWrite.open(); await first.p } else { laterAtWrite.open(); await second.p }
    })
    try {
      const earlier = syncUserStatuses(new Set([t.id]), Date.now())
      await earlierAtWrite.p
      const later = syncUserStatuses(new Set([t.id]), Date.now())
      await laterAtWrite.p
      first.open()
      const settled = await Promise.race([earlier.then(() => 'returned'), sleep(200).then(() => 'pending')])
      expect(settled).toBe('pending')
      expect((await getTask(t.id)).user_status).toBeUndefined()
      second.open()
      await Promise.all([earlier, later])
      expect((await getTask(t.id)).user_status?.state).toBe('needs')
    } finally {
      holdStatusWritesForTest(null)
    }
  })
})
