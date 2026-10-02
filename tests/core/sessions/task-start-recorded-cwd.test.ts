/**
 * The cwd a start with no `cwd` of its own takes from the task record
 * (src/core/sessions/task-start.ts recordedCwd): the task's own, else the
 * nearest ancestor's, but only while the parent chain stays inside the task's
 * project. A task stores a cwd without a host, so a recorded cwd lives on its
 * project's default host; a parent in ANOTHER project recorded a path on that
 * project's host, and handing it down pairs a remote path with the local box
 * (2026-10-02: a leader on a remote host filed a task into a local project and
 * its first start died with "Working directory no longer exists").
 *
 * Real task store in an isolated home: the chain is read through getTask.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-start-recorded-cwd'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { recordedCwd } from '../../../src/core/sessions/task-start.js'
import { _resetForTesting, addTask, getTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'

beforeEach(async () => {
  closeDb()
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

async function make(title: string, project: string, extra: { cwd?: string; parent_task_id?: string } = {}) {
  const { task } = await addTask({ title, project, ...extra })
  return getTask(task.id)
}

describe('recordedCwd', () => {
  it('a task with its own cwd uses it, whatever its parent has', async () => {
    const leader = await make('Leader', 'marina', { cwd: '/remote/marina' })
    const child = await make('Child', 'marina', { parent_task_id: leader.id, cwd: '/repo/child' })
    expect(await recordedCwd(child)).toBe('/repo/child')
  })

  it('a subtask in the same project inherits the nearest ancestor cwd', async () => {
    const leader = await make('Leader', 'marina', { cwd: '/remote/marina' })
    const mid = await make('Mid', 'marina', { parent_task_id: leader.id })
    const leaf = await make('Leaf', 'marina', { parent_task_id: mid.id })
    expect(await recordedCwd(leaf)).toBe('/remote/marina')
  })

  it('a parent in another project hands nothing down: its cwd belongs to that project host', async () => {
    const leader = await make('Leader on a remote host', 'marina', { cwd: '/workplace/remote/marina' })
    const child = await make('Fix the CLI', 'acme', { parent_task_id: leader.id })
    expect(child.project).toBe('acme')
    expect(await recordedCwd(child)).toBeUndefined()
  })

  it('the walk stops at the first project boundary, even when a same-project ancestor sits above it', async () => {
    const root = await make('Root', 'acme', { cwd: '/repo/acme' })
    const foreign = await make('Foreign', 'marina', { parent_task_id: root.id, cwd: '/remote/marina' })
    const leaf = await make('Leaf', 'acme', { parent_task_id: foreign.id })
    expect(await recordedCwd(leaf)).toBeUndefined()
  })

  it('project names compare case-insensitively, like the registry', async () => {
    const leader = await make('Leader', 'Marina', { cwd: '/repo/marina' })
    const child = await make('Child', 'marina', { parent_task_id: leader.id })
    expect(await recordedCwd(child)).toBe('/repo/marina')
  })

  it('a vanished parent ends the walk without a cwd instead of failing the start', async () => {
    // The store refuses a cycle at write time, so a missing parent is the one
    // broken link a start can meet.
    expect(await recordedCwd({ id: 'x', project: 'marina', parent_task_id: 'no-such-task' })).toBeUndefined()
  })
})
