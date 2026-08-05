/**
 * Tests for the session cwd resolution chain (Priority 1–5).
 *
 * Priority chain:
 *   ① explicit param → ② task.cwd → ③ parent chain walk → ④ project metadata
 *   (registry default_cwd) → ⑤ project memory dir (single level: memory/projects/<proj>,
 *   'inbox' for a task with no project)
 *
 * The chain itself lives in three lock-stepped copies (src/agent/tools.ts
 * resolveSessionContext + two in claude-code-session.ts) and is not exported, so
 * these tests replicate it against the real task-manager / registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME, PROJECTS_MEMORY_DIR } from '../../src/constants.js'
import { addTask, getTask, updateTask, setProjectMetadata, getProjectMetadata } from '../../src/core/task-manager.js'
import type { Task } from '../../src/core/types.js'

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

/** Priority 5: the project memory dir, created on demand. One level now. */
function projectMemoryDir(project: string | undefined): string {
  const dir = path.join(PROJECTS_MEMORY_DIR, (project || 'inbox').toLowerCase())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function resolveCwd(task: Task): Promise<string> {
  const fromChain = await cwdFromTaskChain(task)
  if (fromChain) return fromChain
  const metadata = await getProjectMetadata(task.project || '')
  if (metadata?.default_cwd) return metadata.default_cwd as string
  return projectMemoryDir(task.project)
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

  it('Priority 5: falls back to the single-level project memory dir', async () => {
    const { task } = await addTask({ title: 'test cwd resolution', project: 'TestProj' })
    expect(task.cwd).toBeUndefined()

    const projectMemDir = path.join(PROJECTS_MEMORY_DIR, 'testproj')
    ensureDir(projectMemDir)
    fs.writeFileSync(path.join(projectMemDir, 'MEMORY.md'), '---\nname: TestProj\ndescription: test\n---\n')

    expect(await resolveCwd(task)).toBe(projectMemDir)
  })

  it('Priority 5: always resolves — creates the memory dir if it does not exist', async () => {
    const { task } = await addTask({ title: 'test no memory dir', project: 'NoProj' })

    const expectedDir = path.join(PROJECTS_MEMORY_DIR, 'noproj')
    expect(fs.existsSync(expectedDir)).toBe(false)

    expect(await resolveCwd(task)).toBe(expectedDir)
    expect(fs.existsSync(expectedDir)).toBe(true)
  })

  it("Priority 5: an Inbox task (no project) resolves to the 'inbox' memory dir", async () => {
    const { task } = await addTask({ title: 'loose thought' })
    expect(task.project).toBe('')

    const expectedDir = path.join(PROJECTS_MEMORY_DIR, 'inbox')
    expect(await resolveCwd(task)).toBe(expectedDir)
    expect(fs.existsSync(expectedDir)).toBe(true)
  })

  it('Priority 4: the registry default_cwd wins over the memory dir', async () => {
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
