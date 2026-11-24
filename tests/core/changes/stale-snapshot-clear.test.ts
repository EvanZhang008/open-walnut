/**
 * A watcher that drops the snapshots of links a task no longer holds really drops them in the
 * store, so the next pass has nothing to write.
 *
 * Both watchers (changes/watch.ts for change_status, pull-requests/pr-watch.ts for pr_status) cleared
 * with `{ field: undefined }`. updateTaskRaw reads an undefined field as "not in the patch" (null is
 * its explicit clear), so the write was a no-op and the snapshot stayed: every 30 s pass found the
 * same stale snapshot and wrote again. On the production board on 2026-11-24, 18 tasks with a
 * change_status and no change link tag took one locked no-op write each, every pass (13,117 writes
 * reported in 8 h against 16,616 reads). These run each watcher on the real task store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-stale-snapshot-clear'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, updateTaskRaw, _resetForTesting } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import type { Task } from '../../../src/core/types.js'
import { _resetChangeProvidersForTesting, registerChangeProvider } from '../../../src/core/changes/registry.js'
import { _resetChangeWatchForTesting, changeWatchTick, defaultChangeWatchDeps, type ChangeWatchDeps } from '../../../src/core/changes/watch.js'

const CR = 'https://review.acme.dev/r/1001'

beforeEach(async () => {
  closeDb()
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  _resetChangeWatchForTesting()
  _resetChangeProvidersForTesting()
  registerChangeProvider('acme', { id: 'acme:review', handles: (l) => l.url.startsWith('https://review.acme.dev/'), read: async () => new Map() })
})

afterEach(async () => {
  _resetChangeProvidersForTesting()
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the change watcher clears a dropped link\'s snapshot in the store', () => {
  it('one pass removes it; the next pass writes nothing', async () => {
    const { task } = await addTask({ title: 'Ship the fix', project: 'Marina' })
    // A snapshot of a link the task once held: its tag is gone (removed by a person or an agent).
    await updateTaskRaw(task.id, { change_status: { [CR]: { provider: 'acme:review', url: CR, label: 'CR-1001', checkedAt: '2026-11-24T10:00:00.000Z' } } })
    expect((await getTask(task.id)).change_status?.[CR]).toBeDefined()

    const real = defaultChangeWatchDeps()
    let writes = 0
    const deps: ChangeWatchDeps = {
      ...real,
      enabled: async () => true,
      config: async () => ({}),
      writeTask: async (id, patch) => { writes++; await real.writeTask(id, patch) },
    }
    const first = await changeWatchTick(deps)
    expect(first.written).toBe(1)
    expect((await getTask(task.id)).change_status).toBeUndefined()

    writes = 0
    const second = await changeWatchTick(deps)
    expect(second.written).toBe(0)
    expect(writes).toBe(0)
  })
})

describe('the pull request watch clears a dropped pull request\'s snapshot in the store', () => {
  it('one pass removes it', async () => {
    const PR = 'https://github.com/acme/app/pull/7'
    const { task } = await addTask({ title: 'Review the change', project: 'Marina' })
    await updateTaskRaw(task.id, { pr_status: { [PR]: { url: PR, state: 'open', checkedAt: '2026-11-24T10:00:00.000Z' } as unknown as NonNullable<Task['pr_status']>[string] } })
    expect((await getTask(task.id)).pr_status?.[PR]).toBeDefined()

    const { prWatchTick, defaultPrWatchDeps, _resetPrWatchForTesting } = await import('../../../src/core/pull-requests/pr-watch.js')
    _resetPrWatchForTesting()
    const deps = { ...defaultPrWatchDeps(), config: async () => ({}) }
    expect((await prWatchTick(deps)).written).toBe(1)
    expect((await getTask(task.id)).pr_status).toBeUndefined()
    expect((await prWatchTick(deps)).written).toBe(0)
  })
})
