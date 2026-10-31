/**
 * Tests for the session cwd resolution chain (Priority 1–5).
 *
 * Priority chain:
 *   ① explicit param → ② task.cwd → ③ parent chain walk → ④ project metadata
 *   (registry default_cwd) → ⑤ the task's own directory (task-dir-place.ts
 *   localFallbackFolder; until 2026-10-31 a memory/projects/<proj> folder, which
 *   left an empty folder in the memory tree for every project)
 *
 * The chain itself lives in two lock-stepped copies (resolveSessionContext in
 * claude-code-session.ts) and is not exported, so
 * these tests replicate it against the real task-manager / registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME, PROJECTS_MEMORY_DIR } from '../../src/constants.js'
import { addTask, getTask, updateTask, setProjectMetadata, getProjectMetadata } from '../../src/core/task-manager.js'
import type { Task } from '../../src/core/types.js'
import { localFallbackFolder, taskDirForHost } from '../../src/core/sessions/task-dir-place.js'

/** Priority 2–3: task.cwd, then walk the parent chain (cycle-guarded). */
async function cwdFromTaskChain(task: Task): Promise<string | undefined> {
  let current: Task | undefined = task
  const seen = new Set<string>()
  while (current) {
    if (current.cwd) return current.cwd
    if (!current.parent_task_id || seen.has(current.parent_task_id)) return undefined
    seen.add(current.id)
    current = await getTask(current.parent_task_id).catch(() => undefined)
  }
  return undefined
}


async function resolveCwd(task: Task): Promise<string> {
  const fromChain = await cwdFromTaskChain(task)
  if (fromChain) return fromChain
  const metadata = await getProjectMetadata(task.project || '')
  if (metadata?.default_cwd) return metadata.default_cwd as string
  return localFallbackFolder(task.id)
}

describe('session cwd resolution', () => {
  const ensureDir = (dir: string) => fs.mkdirSync(dir, { recursive: true })

  beforeEach(() => {
    ensureDir(path.join(WALNUT_HOME, 'tasks'))
    ensureDir(PROJECTS_MEMORY_DIR)
  })

  afterEach(() => {
    try { fs.rmSync(WALNUT_HOME, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it("Priority 5: falls back to the task's own directory, even when a legacy project memory folder exists", async () => {
    const { task } = await addTask({ title: 'test cwd resolution', project: 'TestProj' })
    expect(task.cwd).toBeUndefined()
    const legacy = path.join(PROJECTS_MEMORY_DIR, 'testproj')
    ensureDir(legacy)

    const dir = await resolveCwd(task)
    expect(dir).toBe(await taskDirForHost(task.id, '__local__'))
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('Priority 5: makes no folder in the memory tree, for a project or the Inbox', async () => {
    fs.rmSync(PROJECTS_MEMORY_DIR, { recursive: true, force: true })
    for (const project of ['NoProj', '']) {
      const { task } = await addTask({ title: 'loose thought', project })
      const dir = await resolveCwd(task)
      expect(dir.startsWith(PROJECTS_MEMORY_DIR)).toBe(false)
      expect(fs.existsSync(dir)).toBe(true)
    }
    expect(fs.existsSync(PROJECTS_MEMORY_DIR)).toBe(false)
  })

  it('Priority 4: the registry default_cwd wins over the fallback folder', async () => {
    const { task } = await addTask({ title: 'metadata cwd', project: 'MetaProj' })
    await setProjectMetadata('MetaProj', { default_cwd: '/workspace/meta' })

    expect(await resolveCwd(task)).toBe('/workspace/meta')
    // Case-insensitive project identity: a differently-cased task still hits the row.
    const { task: other } = await addTask({ title: 'same project', project: 'metaproj' })
    expect(await resolveCwd(other)).toBe('/workspace/meta')
  })

  it('Priority 2 wins over Priority 4 and 5 when task.cwd is set', async () => {
    const { task } = await addTask({ title: 'test task cwd priority', project: 'TestProj' })
    await setProjectMetadata('TestProj', { default_cwd: '/workspace/should-not-win' })
    await updateTask(task.id, { cwd: '/some/explicit/path' })
    const updated = await getTask(task.id)

    expect(await resolveCwd(updated)).toBe('/some/explicit/path')
  })

  it('Priority 3: parent chain walk resolves cwd from an ancestor', async () => {
    const { task: parent } = await addTask({ title: 'parent task', project: 'TestProj' })
    await updateTask(parent.id, { cwd: '/parent/workspace' })

    const { task: child } = await addTask({
      title: 'child task',
      project: 'TestProj',
      parent_task_id: parent.id,
    })

    expect(child.cwd).toBeUndefined()
    expect(child.parent_task_id).toBe(parent.id)
    expect(await resolveCwd(child)).toBe('/parent/workspace')
  })
})
