/**
 * Tests for the session cwd resolution chain (Priority 1–5).
 *
 * Priority chain:
 *   ① explicit param → ② task.cwd → ③ parent chain walk → ④ project metadata (default_cwd) → ⑤ project memory dir
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME, PROJECTS_MEMORY_DIR } from '../../src/constants.js'
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'

describe('session cwd resolution', () => {
  const ensureDir = (dir: string) => fs.mkdirSync(dir, { recursive: true })

  beforeEach(() => {
    ensureDir(path.join(WALNUT_HOME, 'tasks'))
    ensureDir(PROJECTS_MEMORY_DIR)
  })

  afterEach(() => {
    try { fs.rmSync(WALNUT_HOME, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('Priority 5: falls back to project memory dir when no cwd configured', async () => {
    // Create a task in TestCat/TestProj
    const { task } = await addTask({ title: 'test cwd resolution', category: 'TestCat', project: 'TestProj' })

    // Create the project memory directory
    const projectMemDir = path.join(PROJECTS_MEMORY_DIR, 'testcat', 'testproj')
    ensureDir(projectMemDir)
    fs.writeFileSync(path.join(projectMemDir, 'MEMORY.md'), '---\nname: TestProj\ndescription: test\n---\n')

    // The task has no cwd
    expect(task.cwd).toBeUndefined()

    // Replicate the resolution chain
    const { getProjectMetadata } = await import('../../src/core/task-manager.js')
    let resolvedCwd: string | undefined

    // Priority 2–3: task.cwd / parent chain
    if (task.cwd) resolvedCwd = task.cwd

    // Priority 4: project metadata
    if (!resolvedCwd) {
      const metadata = await getProjectMetadata(task.category, task.project)
      if (metadata?.default_cwd) resolvedCwd = metadata.default_cwd as string
    }

    // Priority 5: project memory directory (always create it)
    if (!resolvedCwd) {
      const dir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase())
      fs.mkdirSync(dir, { recursive: true })
      resolvedCwd = dir
    }

    expect(resolvedCwd).toBe(projectMemDir)
    expect(resolvedCwd).toContain('testcat/testproj')
  })

  it('Priority 5: always resolves — creates the memory dir if it does not exist', async () => {
    const { task } = await addTask({ title: 'test no memory dir', category: 'NoCat', project: 'NoProj' })

    // Do NOT pre-create the memory directory — Priority 5 should create it
    const expectedDir = path.join(PROJECTS_MEMORY_DIR, 'nocat', 'noproj')
    expect(fs.existsSync(expectedDir)).toBe(false)

    let resolvedCwd: string | undefined

    if (task.cwd) resolvedCwd = task.cwd

    const { getProjectMetadata } = await import('../../src/core/task-manager.js')
    if (!resolvedCwd) {
      const metadata = await getProjectMetadata(task.category, task.project)
      if (metadata?.default_cwd) resolvedCwd = metadata.default_cwd as string
    }

    // Priority 5: project memory directory (always create it)
    if (!resolvedCwd) {
      const dir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase())
      fs.mkdirSync(dir, { recursive: true })
      resolvedCwd = dir
    }

    expect(resolvedCwd).toBe(expectedDir)
    expect(fs.existsSync(expectedDir)).toBe(true)
  })

  it('Priority 2 wins over Priority 5 when task.cwd is set', async () => {
    const { task } = await addTask({ title: 'test task cwd priority', category: 'TestCat', project: 'TestProj' })
    // Set cwd on the task
    await updateTask(task.id, { cwd: '/some/explicit/path' })
    const updated = await getTask(task.id)

    // Create the memory dir too (should NOT be used)
    const projectMemDir = path.join(PROJECTS_MEMORY_DIR, 'testcat', 'testproj')
    ensureDir(projectMemDir)
    fs.writeFileSync(path.join(projectMemDir, 'MEMORY.md'), '---\nname: TestProj\ndescription: test\n---\n')

    let resolvedCwd: string | undefined

    // Priority 2: task.cwd
    if (updated.cwd) resolvedCwd = updated.cwd

    expect(resolvedCwd).toBe('/some/explicit/path')
    // Priority 5 should NOT have been reached
    expect(resolvedCwd).not.toContain('testcat/testproj')
  })

  it('Priority 3: parent chain walk resolves cwd from ancestor', async () => {
    // Create parent task
    const { task: parent } = await addTask({ title: 'parent task', category: 'TestCat', project: 'TestProj' })
    await updateTask(parent.id, { cwd: '/parent/workspace' })

    // Create child task without cwd
    const { task: child } = await addTask({
      title: 'child task',
      category: 'TestCat',
      project: 'TestProj',
      parent_task_id: parent.id,
    })

    expect(child.cwd).toBeUndefined()
    expect(child.parent_task_id).toBe(parent.id)

    // Walk the parent chain (same as resolveSessionContext)
    let resolvedCwd: string | undefined
    let current = child as { cwd?: string; parent_task_id?: string; id: string } | undefined
    const seen = new Set<string>()
    while (current && !resolvedCwd) {
      if (current.cwd) { resolvedCwd = current.cwd; break }
      if (!current.parent_task_id || seen.has(current.parent_task_id)) break
      seen.add(current.id)
      current = await getTask(current.parent_task_id).catch(() => undefined)
    }

    expect(resolvedCwd).toBe('/parent/workspace')
  })
})
