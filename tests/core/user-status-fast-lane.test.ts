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
import { startUserStatusSync, stopUserStatusSync, settleUserStatusSync, syncUserStatuses } from '../../src/core/user-status-sync.js'

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
})
