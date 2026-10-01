/**
 * addTasksBulk never drops a task because two ids WE minted collided.
 *
 * generateId() is base36(now) + 2 random bytes, so rows minted in the same
 * millisecond collide with a real probability (~1.85% for a 50-row batch,
 * tests/core/generate-id-collision.test.ts). The batch used to skip the second
 * row on the primary-key violation: a plugin filing hundreds of tasks lost one
 * now and then, and tests/core/task-db.test.ts's 50-row case flaked red in CI.
 * A collision on a minted id now gets a fresh id; a caller-supplied id that is
 * taken is still skipped, and never replaces the task that owns it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-bulk-id-collision'))

const minted: string[] = []
vi.mock('../../src/utils/format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/format.js')>()
  return { ...actual, generateId: () => minted.shift() ?? actual.generateId() }
})

import { closeDb } from '../../src/core/task-db.js'
import { _resetForTesting, addTasksBulk, listTasks } from '../../src/core/task-manager.js'
import { TASKS_DIR, WALNUT_HOME } from '../../src/constants.js'

const row = (title: string, id?: string) => ({
  ...(id ? { id } : {}),
  title,
  project: 'Local',
  source: 'local' as const,
  status: 'todo' as const,
  phase: 'TODO' as const,
  priority: 'none' as const,
  session_ids: [],
  description: '',
  summary: '',
  note: '',
})

beforeEach(async () => {
  closeDb()
  _resetForTesting()
  minted.length = 0
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
})

afterEach(() => {
  closeDb()
  _resetForTesting()
})

describe('addTasksBulk id collisions', () => {
  it('re-mints a colliding minted id instead of dropping the task', async () => {
    minted.push('dup-id', 'dup-id', 'fresh-id')
    const created = await addTasksBulk([row('First'), row('Second')])
    expect(created.map((t) => [t.title, t.id])).toEqual([['First', 'dup-id'], ['Second', 'fresh-id']])
    const listed = (await listTasks()).map((t) => [t.title, t.id]).sort()
    expect(listed).toEqual([['First', 'dup-id'], ['Second', 'fresh-id']])
  })

  it('an explicit undefined id still gets a minted one', async () => {
    minted.push('minted-1')
    const created = await addTasksBulk([{ ...row('Explicit undefined'), id: undefined }])
    expect(created.map((t) => t.id)).toEqual(['minted-1'])
  })

  it('still skips a caller-supplied id that is taken, and leaves the owner alone', async () => {
    await addTasksBulk([row('Owner', 'taken-id')])
    const created = await addTasksBulk([row('Intruder', 'taken-id'), row('Other', 'other-id')])
    expect(created.map((t) => t.id)).toEqual(['other-id'])
    const owner = (await listTasks()).find((t) => t.id === 'taken-id')
    expect(owner?.title).toBe('Owner')
  })

  it('gives up after repeated collisions without throwing or replacing anything', async () => {
    minted.push('same', 'same', 'same', 'same', 'same', 'same', 'same')
    const created = await addTasksBulk([row('Keeper'), row('Unlucky')])
    expect(created.map((t) => t.title)).toEqual(['Keeper'])
    expect((await listTasks()).map((t) => t.title)).toEqual(['Keeper'])
  })
})
