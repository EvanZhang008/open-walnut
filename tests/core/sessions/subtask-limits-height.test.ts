/**
 * subtreeHeight / hasAncestor / assertAdoptionDepth (core/sessions/subtask-limits.ts):
 * how many levels of subtasks hang below a task, and whether adopting it under a
 * leader keeps the deepest one within MAX_SUBTASK_DEPTH.
 *
 * Real task store in an isolated home. A corrupted (cyclic) parent chain is staged
 * with updateTaskRaw, which writes the column without updateTask's cycle check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-subtask-limits-height'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import {
  MAX_SUBTASK_DEPTH, SubtaskLimitError, assertAdoptionDepth, hasAncestor, subtreeHeight,
} from '../../../src/core/sessions/subtask-limits.js'

async function task(title: string, parent?: string): Promise<string> {
  const { task: t } = await addTask({ title, project: 'height', ...(parent ? { parent_task_id: parent } : {}) })
  return t.id
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('subtreeHeight', () => {
  it('is 0 for a task with no subtasks', async () => {
    expect(await subtreeHeight(await task('Leaf'))).toBe(0)
  })

  it('counts every level of a chain', async () => {
    const top = await task('Chain top')
    const one = await task('Chain 1', top)
    const two = await task('Chain 2', one)
    await task('Chain 3', two)
    expect(await subtreeHeight(top)).toBe(3)
    expect(await subtreeHeight(one)).toBe(2)
    expect(await subtreeHeight(two)).toBe(1)
  })

  it('takes the deepest branch of a tree', async () => {
    const root = await task('Tree root')
    const shallow = await task('Shallow branch', root)
    await task('Shallow leaf', root)
    const deep = await task('Deep branch', root)
    const deeper = await task('Deeper', deep)
    await task('Deepest', deeper)
    expect(await subtreeHeight(root)).toBe(3)
    expect(await subtreeHeight(shallow)).toBe(0)
  })

  it('terminates on a cyclic chain', async () => {
    const a = await task('Loop A')
    const b = await task('Loop B', a)
    const c = await task('Loop C', b)
    // a -> b -> c -> a: the column written directly, as a corrupted store would hold it.
    await updateTaskRaw(a, { parent_task_id: c })
    // b and c below a; c's child is a again, already seen.
    expect(await subtreeHeight(a)).toBe(2)
    expect(await subtreeHeight(c)).toBe(2)
  })

  it('stops counting past the cap', async () => {
    let parent = await task('Tall top')
    const top = parent
    for (let i = 1; i <= MAX_SUBTASK_DEPTH + 3; i++) parent = await task(`Tall ${i}`, parent)
    expect(await subtreeHeight(top)).toBe(MAX_SUBTASK_DEPTH + 1)
  })
})

describe('hasAncestor', () => {
  it('finds an ancestor at any depth and never the task itself', async () => {
    const top = await task('Line top')
    const mid = await task('Line mid', top)
    const low = await task('Line low', mid)
    expect(await hasAncestor(low, top)).toBe(true)
    expect(await hasAncestor(low, mid)).toBe(true)
    expect(await hasAncestor(top, low)).toBe(false)
    expect(await hasAncestor(low, low)).toBe(false)
  })

  it('terminates on a loop that does not contain the ancestor asked about', async () => {
    const x = await task('Ring X')
    const y = await task('Ring Y', x)
    await updateTaskRaw(x, { parent_task_id: y })
    const outsider = await task('Outsider')
    expect(await hasAncestor(y, outsider)).toBe(false)
  })
})

describe('assertAdoptionDepth', () => {
  it('lets a subtree in when its deepest subtask stays within the cap', async () => {
    const top = await task('Adopt top')
    const leader = await task('Adopt leader', top)
    const leaf = await task('Adopt leaf')
    await expect(assertAdoptionDepth(leader, leaf)).resolves.toBeUndefined()
  })

  it('refuses when the adopted task brings levels that would pass the cap', async () => {
    const top = await task('Deep top')
    const one = await task('Deep 1', top)
    const leader = await task('Deep 2', one)
    const adopted = await task('Brings a child')
    await task('Its child', adopted)
    const err = await assertAdoptionDepth(leader, adopted, { parentTitle: 'Deep 2', taskTitle: 'Brings a child' })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(SubtaskLimitError)
    expect((err as SubtaskLimitError).code).toBe('subtask_too_deep')
    expect((err as SubtaskLimitError).message).toContain('"Deep 2"')
    expect((err as SubtaskLimitError).message).toContain('would reach 4 levels down')
  })
})
