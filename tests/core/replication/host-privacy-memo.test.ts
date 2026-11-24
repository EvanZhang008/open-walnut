/**
 * The leader's privacy (host-private.ts hostPrivacyNow) is worked out once per change of the task
 * and session stores: every host slice and copy round asks, and each read walked every task and
 * session (2026-11-24: a tenth of the CPU in a 5.7 GB burst after a restart). A change of either
 * store, a kept flag set or cleared, a new session of a kept task, is read at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-privacy-memo', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, setTaskSyncHold } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { hostPrivacyNow, _resetHostPrivacyMemoForTesting } from '../../../src/core/replication/host-private.js'

const HOLD = { target: 'acme', state: 'chosen' as const, at: '2026-11-21T00:00:00.000Z' }

beforeEach(() => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  _resetHostPrivacyMemoForTesting()
})

describe('hostPrivacyNow follows the stores', () => {
  it('reads the same answer until a store changes, and each caller gets its own derived', async () => {
    const kept = (await addTask({ title: 'Appraisal notes', project: 'Work' })).task
    const open = (await addTask({ title: 'Open worker', project: 'Work' })).task
    expect((await hostPrivacyNow()).tasks.size).toBe(0)

    await setTaskSyncHold(kept.id, HOLD)
    const a = await hostPrivacyNow()
    expect([...a.tasks]).toEqual([kept.id])
    const b = await hostPrivacyNow()
    expect(b.tasks).toBe(a.tasks)
    expect(b.derived).not.toBe(a.derived)

    const sid = randomUUID()
    await createSessionRecord(sid, kept.id, 'Work', WALNUT_HOME)
    expect((await hostPrivacyNow()).sessions.has(sid)).toBe(true)

    const child = (await addTask({ title: 'Appraisal follow-up', project: 'Work', parent_task_id: kept.id })).task
    expect((await hostPrivacyNow()).tasks.has(child.id)).toBe(true)
    expect((await hostPrivacyNow()).tasks.has(open.id)).toBe(false)

    // Released, the task leaves the kept set at once (its subtask, made under a kept task, keeps
    // its own hold), the same as a fresh read says.
    await setTaskSyncHold(kept.id, null)
    const memoed = [...(await hostPrivacyNow()).tasks]
    _resetHostPrivacyMemoForTesting()
    expect(memoed).not.toContain(kept.id)
    expect(memoed).toEqual([...(await hostPrivacyNow()).tasks])
  })
})
