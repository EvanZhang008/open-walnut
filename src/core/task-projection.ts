/**
 * Task projection — a slim JSON snapshot of the task list exported to
 * `tasks/projection.json` inside the data repo, so it rides the 30s git-sync
 * to the cloud companion (tasks.sqlite itself is gitignored/binary).
 *
 * Primary box: exportTaskProjection() rewrites the file when tasks change
 * (debounced off task:* bus events) and once at startup.
 * Cloud box: readTaskProjection() serves GET /api/v1/tasks from the synced
 * file — the projection IS the replica, no SQLite involved.
 *
 * Scope: everything except done tasks older than DONE_RETENTION_DAYS — recent
 * completions matter for a Reminders-style "Completed" section, ancient ones
 * only bloat the diff.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { TASKS_DIR } from '../constants.js'
import { writeJsonFile } from '../utils/fs.js'
import { bus } from './event-bus.js'
import { log } from '../logging/index.js'
import type { Task } from './types.js'

export const PROJECTION_FILE = path.join(TASKS_DIR, 'projection.json')

const DONE_RETENTION_DAYS = 14
const DEBOUNCE_MS = 3_000

/** Slim task shape shipped to the companion — the frozen v1 contract. */
export interface ProjectedTask {
  id: string
  title: string
  status: string
  phase: string
  priority: string
  category: string
  project: string
  due_date?: string
  created_at: string
  updated_at: string
  completed_at?: string
  starred?: boolean
  pinned?: boolean
  tags?: string[]
  /** First 500 chars — enough for a detail preview without the full blob. */
  summary?: string
}

export interface TaskProjection {
  version: 1
  exportedAt: string
  tasks: ProjectedTask[]
}

const SUMMARY_MAX = 500

function projectTask(t: Task): ProjectedTask {
  const summary = (t.summary || '').trim()
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    phase: t.phase,
    priority: t.priority,
    category: t.category,
    project: t.project,
    ...(t.due_date ? { due_date: t.due_date } : {}),
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...(t.completed_at ? { completed_at: t.completed_at } : {}),
    ...(t.starred ? { starred: true } : {}),
    ...(t.pinned ? { pinned: true } : {}),
    ...(t.tags && t.tags.length > 0 ? { tags: t.tags } : {}),
    ...(summary ? { summary: summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX) + '…' : summary } : {}),
  }
}

/** Export the current task list to the projection file (atomic write). */
export async function exportTaskProjection(): Promise<number> {
  // Lazy import breaks the task-manager ↔ projection cycle risk and keeps
  // cloud boxes (which never export) from touching SQLite.
  const { listTasks } = await import('./task-manager.js')
  const all = await listTasks()
  const cutoff = Date.now() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const tasks = all
    .filter((t) => {
      if (t.status !== 'done') return true
      const doneAt = Date.parse(t.completed_at ?? t.updated_at)
      return Number.isFinite(doneAt) && doneAt >= cutoff
    })
    .map(projectTask)
  const projection: TaskProjection = { version: 1, exportedAt: new Date().toISOString(), tasks }
  await writeJsonFile(PROJECTION_FILE, projection)
  return tasks.length
}

/** Read the synced projection file (cloud box). Null when absent/corrupt. */
export async function readTaskProjection(): Promise<TaskProjection | null> {
  try {
    const raw = await fsp.readFile(PROJECTION_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as TaskProjection
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return null
    return parsed
  } catch {
    return null
  }
}

let debounceTimer: NodeJS.Timeout | null = null
let exporting = false
let dirtyWhileExporting = false

function scheduleExport(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (exporting) { dirtyWhileExporting = true; return }
    exporting = true
    exportTaskProjection()
      .then((count) => log.task.debug('task projection exported', { count }))
      .catch((err) => log.task.warn('task projection export failed', { error: String(err) }))
      .finally(() => {
        exporting = false
        if (dirtyWhileExporting) { dirtyWhileExporting = false; scheduleExport() }
      })
  }, DEBOUNCE_MS)
}

/**
 * Primary-box wiring: export at startup, then re-export (debounced) whenever
 * any task event fires. Returns a stop function for clean shutdown.
 */
export function startTaskProjectionExport(): { stop: () => void } {
  scheduleExport() // initial export shortly after boot (debounce absorbs the startup storm)
  bus.subscribe('task-projection', () => scheduleExport(), { global: true, interest: ['task:'] })
  return {
    stop: () => {
      bus.unsubscribe('task-projection')
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    },
  }
}
