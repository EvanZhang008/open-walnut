/**
 * The project a queued write moves its task to is always the one settleProject checked
 * (its registry row, a tombstone, the sync source), also when the Mac edits the task
 * between the drain's read and its write lock (WP9 re-review round 1). The edit is made
 * at exactly that point: inside the tier lookup the drain runs after settling, before the lock.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-project-settle'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))
const hooks = vi.hoisted(() => ({ beforeTiers: null as null | (() => Promise<void>), ensured: [] as string[] }))
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/task-manager.js')>()
  return {
    ...orig,
    getCustomTiers: async (...a: Parameters<typeof orig.getCustomTiers>) => {
      const h = hooks.beforeTiers
      hooks.beforeTiers = null
      if (h) await h()
      return orig.getCustomTiers(...a)
    },
    ensureProject: async (...a: Parameters<typeof orig.ensureProject>) => {
      hooks.ensured.push(String(a[0]))
      return orig.ensureProject(...a)
    },
  }
})

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'


beforeEach(() => { _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1]); hooks.ensured.length = 0 })
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a project move settled before the lock', () => {
  it('a Mac edit between the read and the lock that makes the write move the task settles the project again before it is written', async () => {
    const id = (await addTask({ title: 'Moved twice', project: 'Acme' } as never)).task.id
    await updateTask(id, { project: 'Marina Work' } as never)
    expect((await getTask(id)).project).toBe('Marina Work')
    // The host moved it to Marina Work too while away (equal on read: nothing to settle).
    // Before the lock, the Mac moves it back; under the lock the away move now applies.
    hooks.beforeTiers = async () => { await updateTaskRaw(id, { project: 'Acme' } as never) }
    hooks.ensured.length = 0
    const record = {
      // Not a session: a session's away write takes only task_update's own fields (no focus_tier).
      v: 2, seq: 1, at: Date.now() + 60_000, kind: 'task-fields', opId: 'op-settle-000001', rev: 1, actor: { kind: 'trigger', id: 'trg-settle' }, op: 'task_update', taskId: id,
      fields: { project: { base: 'Acme', value: 'Marina Work' }, focus_tier: { base: '', value: 'satellite' } },
    }
    const pending = [record]
    await runOfflineHandover({
      hostKey: 'marina', journalV2: true,
      send: async (cmd: string) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') pending.length = 0
        return { ok: true }
      },
    } as never)
    expect(hooks.beforeTiers).toBeNull()
    const t = await getTask(id)
    // focus_tier is the online pin write (pin-fields.ts): 'satellite' pins the task, stored as no tier.
    expect([t.project, t.pinned, t.focus_tier ?? null]).toEqual(['Marina Work', true, null])
    expect(hooks.ensured).toContain('Marina Work')
    expect(pending).toHaveLength(0)
  })
})
