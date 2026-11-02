/**
 * A queued move into a project name the Mac does not know creates a LOCAL project, never one
 * claimed by the moved task's service (2026-11-01: a brand-new project that inherited a tracker
 * task's service later received personal tasks; the online twin of this rule is in updateTask,
 * tests/core/move-never-changes-service.test.ts). A synced task's queued move into such a name is
 * dropped before any row is made, since online that move takes the task off its service.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-new-project-local'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, ensureProject, getProjectRecord } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { registry } from '../../../src/core/integration-registry.js'
import { createMockPlugin, createSpySync } from '../plugin-test-utils.js'

const spy = createSpySync()
spy.createTask.mockImplementation(async () => ({ 'svc-a': { id: 'svc-a-r1' } }))

beforeEach(() => {
  _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1])
  registry.replace('svc-a', createMockPlugin({ id: 'svc-a', syncAudience: 'shared', sync: spy }))
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

async function drain(record: Record<string, unknown>): Promise<void> {
  const pending = [record]
  await runOfflineHandover({
    hostKey: 'marina', journalV2: true,
    send: async (cmd: string) => {
      if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
      if (cmd === 'offline.ack') pending.length = 0
      return { ok: true }
    },
  } as never)
}

describe('a queued move into a new project name', () => {
  it('drops a synced task\'s move and leaves no project behind', async () => {
    await ensureProject('A-land', 'svc-a')
    const id = (await addTask({ title: 'Work item', project: 'A-land' } as never)).task.id
    expect((await getTask(id)).source).toBe('svc-a')

    await drain({
      v: 2, seq: 1, at: Date.now() + 60_000, kind: 'task-fields', opId: 'op-newproj-000001', rev: 1,
      actor: { kind: 'trigger', id: 'trg-newproj' }, op: 'task_update', taskId: id,
      fields: { project: { base: 'A-land', value: 'Ideas from away' } },
    })

    // No empty project is left behind for a move that was dropped.
    expect(await getProjectRecord('Ideas from away')).toBeNull()
    const t = await getTask(id)
    expect([t.project, t.source]).toEqual(['A-land', 'svc-a'])
  })

  it('moves a local task into it', async () => {
    const id = (await addTask({ title: 'Local note' } as never)).task.id
    await drain({
      v: 2, seq: 2, at: Date.now() + 60_000, kind: 'task-fields', opId: 'op-newproj-000002', rev: 1,
      actor: { kind: 'trigger', id: 'trg-newproj' }, op: 'task_update', taskId: id,
      fields: { project: { base: '', value: 'Notes from away' } },
    })
    expect((await getProjectRecord('Notes from away'))?.source).toBe('local')
    const t = await getTask(id)
    expect([t.project, t.source]).toEqual(['Notes from away', 'local'])
  })
})
