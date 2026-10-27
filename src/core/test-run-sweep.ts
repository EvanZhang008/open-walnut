/**
 * Deletes a test run's objects (src/core/test-run.ts) once nobody has used them for a while:
 * its tasks with their sessions (stopped first) and session records, then its projects once
 * empty. Primary only, every 30 minutes. A test object hides from the board the moment it is
 * made, so the sweep is housekeeping: a run that cleans up after itself loses nothing to it,
 * and a run that forgot leaves nothing behind for long.
 *
 * Idle means no write to the task and no session activity on it for WALNUT_TEST_RUN_TTL_HOURS
 * (default 6), and for a project, no task in it and its mark that old.
 */
import { log } from '../logging/index.js'
import type { ProjectRecord, Task } from './types.js'
import { TEST_RUN_PROJECT_KEY, isTestRunProject, isTestRunTask } from './test-run.js'

const FIRST_SWEEP_MS = 2 * 60_000
const SWEEP_EVERY_MS = 30 * 60_000
const DEFAULT_TTL_HOURS = 6

export function testRunIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.WALNUT_TEST_RUN_TTL_HOURS)
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3_600_000
}

function latest(...stamps: Array<string | undefined>): number {
  let best = Number.NEGATIVE_INFINITY
  for (const s of stamps) {
    const t = s ? Date.parse(s) : Number.NaN
    if (Number.isFinite(t) && t > best) best = t
  }
  return best
}

/**
 * The test tasks idle for `idleMs` at `now`. Main is never one (addTask never marks it), and a
 * test task real work still hangs on stays: a real task under it (adopted, or moved under a test
 * VP with its project), or a real project it leads (org_leads). Deleting it would leave that
 * work pointing at nothing.
 */
export function pickExpiredTestTasks(tasks: readonly Task[], now: number, idleMs: number): Task[] {
  const realParents = new Set<string>()
  const realProjects = new Set<string>()
  for (const t of tasks) {
    if (isTestRunTask(t)) continue
    if (t.parent_task_id) realParents.add(t.parent_task_id)
    if (t.project) realProjects.add(t.project.toLowerCase())
  }
  return tasks.filter((t) => isTestRunTask(t) && t.org_role !== 'main'
    && !realParents.has(t.id)
    && !(t.org_leads ?? []).some((p) => realProjects.has(p.toLowerCase()))
    && latest(t.created_at, t.updated_at, t.last_session_update) <= now - idleMs)
}

/** The test projects no task lives in whose mark is `idleMs` old at `now`. */
export function pickExpiredTestProjects(
  projects: Readonly<Record<string, ProjectRecord>>,
  tasks: readonly Pick<Task, 'project'>[],
  now: number,
  idleMs: number,
): string[] {
  const used = new Set(tasks.map((t) => (t.project || '').toLowerCase()))
  return Object.entries(projects).filter(([name, rec]) => {
    if (!isTestRunProject(rec) || used.has(name.toLowerCase())) return false
    const mark = rec.metadata?.[TEST_RUN_PROJECT_KEY] as { at?: string } | undefined
    return latest(mark?.at) <= now - idleMs
  }).map(([name]) => name)
}

export async function sweepTestRunsOnce(now = Date.now(), idleMs = testRunIdleMs()): Promise<{ tasks: string[]; projects: string[] }> {
  const tm = await import('./task-manager.js')
  const { bus, EventNames } = await import('./event-bus.js')
  const expired = pickExpiredTestTasks(await tm.listTasks(), now, idleMs)
  const deletedIds: string[] = []
  if (expired.length) {
    // force: a test task's session is stopped first; its records go with it (dropTestRunSessionRecords).
    const { deleted, failed } = await tm.deleteTasksByIds(expired.map((t) => t.id), { force: true })
    for (const task of deleted) {
      deletedIds.push(task.id)
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'test-run-sweep' })
    }
    if (failed.length) log.task.warn('test-run sweep: some tasks were not deleted', { failed })
  }
  const projects: string[] = []
  for (const name of pickExpiredTestProjects(await tm.getStoreProjects(), await tm.listTasks(), now, idleMs)) {
    if (await tm.removeTestRunProject(name)) projects.push(name)
  }
  if (deletedIds.length || projects.length) {
    log.task.info('test-run sweep removed test objects', { tasks: deletedIds, projects })
  }
  return { tasks: deletedIds, projects }
}

export function startTestRunSweep(): { stop: () => void } {
  let stopped = false
  let running = false
  const run = (): void => {
    if (stopped || running) return
    running = true
    void sweepTestRunsOnce()
      .catch((err) => log.task.warn('test-run sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { running = false })
  }
  const first = setTimeout(run, FIRST_SWEEP_MS)
  first.unref?.()
  const every = setInterval(run, SWEEP_EVERY_MS)
  every.unref?.()
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(every) } }
}
