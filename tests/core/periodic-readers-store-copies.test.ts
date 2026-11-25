/**
 * The passes that run every few seconds read the stores' own rows, never a copy of every row.
 *
 * 2026-11-24 on the Mac (9.4k sessions, 6.5k tasks): in the ten minutes after a restart the
 * session projection export copied about 1M session records (listSessions, every 10 s), and the
 * work card, the threads pop-up index, the thread follow pass and the status pass copied the whole
 * board (listTasks / orgTasks) about once a second. All of it was garbage, and the server's peak
 * after a restart was what the collector had not reached yet.
 *
 * Real: the task and session stores in temp dirs, the projection, the follow pass, the work card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-periodic-store-copies'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, updateTask, _resetForTesting, _storeStatsForTesting } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../src/core/session-db.js'
import { createSessionRecord, listSessions, sessionStoreView, _resetSessionTrackerForTesting, _sessionStoreStatsForTesting } from '../../src/core/session-tracker.js'
import { buildSessionProjection } from '../../src/core/session-projection.js'
import { runThreadFollowPass } from '../../src/core/org/thread-follow.js'
import { orgTaskView } from '../../src/core/org/org-store.js'
import { workCardNow } from '../../src/core/push/work-card.js'
import { TEST_RUN_OWNER } from '../../src/core/test-run.js'

beforeEach(async () => {
  closeDb(); closeSessionDb(); _resetSessionTrackerForTesting(); _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})
afterEach(async () => {
  closeDb(); closeSessionDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function seed(): Promise<{ taskId: string; sid: string }> {
  const { task } = await addTask({ title: 'Acme rollout', project: 'Acme' })
  await addTask({ title: 'Acme follow-up', project: 'Acme' })
  const sid = 'sess-periodic-copies'
  await createSessionRecord(sid, task.id, 'Acme', '/Users/test/acme', { title: 'Acme rollout', initialProcessStatus: 'idle' })
  return { taskId: task.id, sid }
}

const copies = () => ({ tasks: _storeStatsForTesting().copiedRows, sessions: _sessionStoreStatsForTesting().clonedRows })

describe('the passes that run every few seconds', () => {
  it('the session projection reads both stores without a copy, and its rows are what they were', async () => {
    const { taskId, sid } = await seed()
    await buildSessionProjection()
    const before = copies()
    const p = await buildSessionProjection()
    expect(copies()).toEqual(before)
    const row = p.sessions.find((s) => s.id === sid)
    expect(row).toMatchObject({ task_id: taskId, task_title: 'Acme rollout', project: 'Acme' })
    // The rows handed out are new objects: the store's records are untouched.
    const view = await sessionStoreView()
    expect(view.find((s) => s.claudeSessionId === sid)).not.toBe(row)
    expect((await listSessions()).find((s) => s.claudeSessionId === sid)).toMatchObject({ taskId })
  })

  it('the thread follow pass and the work card read the board without a copy', async () => {
    await seed()
    await runThreadFollowPass()
    await workCardNow()
    const before = copies()
    await runThreadFollowPass()
    await workCardNow()
    expect(copies()).toEqual(before)
  })

  it('the org view is one list until the board changes, and never holds a test run\'s task', async () => {
    const { taskId } = await seed()
    const { task: probe } = await addTask({ title: 'Acme probe', project: 'Acme', plugin_only: TEST_RUN_OWNER })
    const a = await orgTaskView()
    expect(a.some((t) => t.id === probe.id)).toBe(false)
    expect(a.some((t) => t.id === taskId)).toBe(true)
    expect(await orgTaskView()).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
    await updateTask(taskId, { title: 'Acme rollout, stage 2' })
    const b = await orgTaskView()
    expect(b).not.toBe(a)
    expect(b.find((t) => t.id === taskId)?.title).toBe('Acme rollout, stage 2')
  })
})

/**
 * Whole-store copies left in the modules of those passes: counts only fall. A new
 * listTasks() / listSessions() / orgTasks() here is a new copy of every row per pass; read
 * taskStoreSnapshot, orgTaskView or sessionStoreView instead, or a filtered helper that copies
 * only what it returns (listSessionsForTasks).
 */
const LEFT: Record<string, number> = {
  'src/core/session-projection.ts': 0,
  'src/core/org/thread-popup.ts': 0,
  'src/core/push/work-card.ts': 0,
  'src/core/user-status-sync.ts': 0,
  'src/core/search/wiring.ts': 0,
  'src/core/org/team-asks.ts': 0,
  // A hand-off on a send and an org move: on demand, never periodic.
  'src/core/org/thread-follow.ts': 2,
  'src/core/org/thread-ack.ts': 1,
  'src/core/org/threads-store.ts': 1,
}

describe('whole-store copies in the periodic passes', () => {
  for (const [file, max] of Object.entries(LEFT)) {
    it(`${file} has at most ${max}`, async () => {
      const text = await fs.readFile(path.join(process.cwd(), file), 'utf8')
      expect((text.match(/\b(listTasks|listSessions|orgTasks)\(/g) ?? []).length).toBeLessThanOrEqual(max)
    })
  }
})
