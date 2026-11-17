/**
 * A finished task the router finds as an item's owner takes the item up again
 * (src/core/router/service.ts reopenFinishedOwner).
 *
 * Why (2026-11-17, the user: "every router can route to any task, just need to search it up"): a
 * search finds open and finished tasks alike. A live session's send reopens a finished task itself,
 * but a task with no session starts one with the item, and a start is no deliberate reopen: without
 * this, the task took the item and stayed finished, and nobody saw it. Real task store; names invented.
 */
import fs from 'node:fs/promises'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-finished-owner'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetForTesting, addTask, completeTask, getTask } from '../../src/core/task-manager.js'
import { reopenFinishedOwner } from '../../src/core/router/service.js'

beforeEach(async () => {
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a finished owner of a routed item', () => {
  it('is reopened, and counts the reopen', async () => {
    const { task } = await addTask({ title: 'Maple Delivery recruiter screen' })
    await completeTask(task.id)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
    expect(await reopenFinishedOwner(task.id)).toBe(true)
    const after = await getTask(task.id)
    expect(after.phase).not.toBe('COMPLETE')
    expect(after.reopens).toBe(1)
  })

  it('an open owner is left as it is', async () => {
    const { task } = await addTask({ title: 'Interview loop: Maple Delivery onsite' })
    const before = (await getTask(task.id)).phase
    expect(await reopenFinishedOwner(task.id)).toBe(false)
    expect((await getTask(task.id)).phase).toBe(before)
  })

  it('a task that is gone is no error', async () => {
    expect(await reopenFinishedOwner('gone-task-1')).toBe(false)
  })
})
