/**
 * Session projection — a slim JSON snapshot of the session list exported to
 * `sessions/projection.json` inside the data repo, so it rides the periodic
 * git-sync to the cloud companion (the session registry itself is
 * machine-local and never syncs; stream files are gitignored).
 *
 * Mirror of task-projection.ts:
 * Primary box: exportSessionProjection() rewrites the file when sessions
 * change (debounced off session:* bus events) and once at startup.
 * Cloud box: readSessionProjection() serves GET /api/v1/sessions from the
 * synced file — the projection IS the replica.
 *
 * Read-only by design (Phase 1). Opening/steering a session from the
 * companion requires the reverse-WS bridge to the primary (Phase 2) — every
 * live session path routes through the primary box because corp remote hosts
 * are only reachable from there (SSH), and one relay = one audited path.
 *
 * Scope: all live sessions (running/idle/error) + sessions stopped within
 * STOPPED_RETENTION_DAYS. Environment sessions (triage/cron/hook/embedded
 * subagents) and archived sessions are excluded — same visibility rule as
 * the web session tree.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { writeJsonFile } from '../utils/fs.js'
import { bus } from './event-bus.js'
import { log } from '../logging/index.js'
import type { SessionRecord, Task } from './types.js'

export const SESSION_PROJECTION_FILE = path.join(WALNUT_HOME, 'sessions', 'projection.json')

const STOPPED_RETENTION_DAYS = 14
const DEBOUNCE_MS = 3_000
const DESCRIPTION_MAX = 300
const MAX_SESSIONS = 500

/** Slim session shape shipped to the companion — frozen v1 contract (additive-only). */
export interface ProjectedSession {
  id: string
  title?: string
  /** Owning task (sessions are normally spawned from a task). */
  task_id?: string
  task_title?: string
  category?: string
  project?: string
  /** '' = the primary box itself; otherwise the remote host alias. */
  host: string
  process_status: string
  model?: string
  mode?: string
  started_at: string
  last_active_at: string
  message_count: number
  cwd?: string
  /** Derived from the owning task's pin state at export time. */
  pinned?: boolean
  focus_tier?: string
  /** First 300 chars — enough for a list preview. */
  description?: string
}

export interface SessionProjection {
  version: 1
  exportedAt: string
  sessions: ProjectedSession[]
}

function projectSession(s: SessionRecord, task: Task | undefined): ProjectedSession {
  const description = (s.description || '').trim()
  return {
    id: s.claudeSessionId,
    ...(s.title ? { title: s.title } : {}),
    ...(s.taskId ? { task_id: s.taskId } : {}),
    ...(task?.title ? { task_title: task.title } : {}),
    ...(task?.category ? { category: task.category } : {}),
    ...(s.project || task?.project ? { project: s.project || task?.project } : {}),
    host: s.host ?? '',
    process_status: s.process_status,
    ...(s.model ? { model: s.model } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    started_at: s.startedAt,
    last_active_at: s.lastActiveAt,
    message_count: s.messageCount ?? 0,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(task?.pinned ? { pinned: true } : {}),
    ...(task?.pinned && task?.focus_tier ? { focus_tier: task.focus_tier } : {}),
    ...(description
      ? { description: description.length > DESCRIPTION_MAX ? description.slice(0, DESCRIPTION_MAX) + '…' : description }
      : {}),
  }
}

/** Export the current session list to the projection file (atomic write). */
export async function exportSessionProjection(): Promise<number> {
  // Lazy imports keep cloud boxes (which never export) from touching the
  // session registry / task store at module load.
  const { listSessions, isEnvironmentSession } = await import('./session-tracker.js')
  const { listTasks } = await import('./task-manager.js')

  const [allSessions, allTasks] = await Promise.all([listSessions(), listTasks()])
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const cutoff = Date.now() - STOPPED_RETENTION_DAYS * 24 * 60 * 60 * 1000

  const sessions = allSessions
    .filter((s) => {
      if (isEnvironmentSession(s) || s.archived) return false
      if (s.process_status === 'stopped') {
        const at = Date.parse(s.lastActiveAt ?? s.startedAt)
        return Number.isFinite(at) && at >= cutoff
      }
      return true
    })
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
    .slice(0, MAX_SESSIONS)
    .map((s) => projectSession(s, s.taskId ? taskById.get(s.taskId) : undefined))

  const projection: SessionProjection = { version: 1, exportedAt: new Date().toISOString(), sessions }
  await writeJsonFile(SESSION_PROJECTION_FILE, projection)
  return sessions.length
}

/** Read the synced projection file (cloud box). Null when absent/corrupt. */
export async function readSessionProjection(): Promise<SessionProjection | null> {
  try {
    const raw = await fsp.readFile(SESSION_PROJECTION_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as SessionProjection
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return null
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
    exportSessionProjection()
      .then((count) => log.session.debug('session projection exported', { count }))
      .catch((err) => log.session.warn('session projection export failed', { error: String(err) }))
      .finally(() => {
        exporting = false
        if (dirtyWhileExporting) { dirtyWhileExporting = false; scheduleExport() }
      })
  }, DEBOUNCE_MS)
}

/**
 * Primary-box wiring: export at startup, then re-export (debounced) whenever
 * any session event fires. Returns a stop function for clean shutdown.
 */
export function startSessionProjectionExport(): { stop: () => void } {
  scheduleExport() // initial export shortly after boot (debounce absorbs the startup storm)
  bus.subscribe('session-projection', () => scheduleExport(), {
    global: true,
    // Lifecycle + status only — NOT the high-frequency stream deltas
    // (text-delta/thinking-delta fire per token and would thrash the timer).
    interest: ['session:started', 'session:ended', 'session:status-changed', 'session:result', 'session:error'],
  })
  return {
    stop: () => {
      bus.unsubscribe('session-projection')
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    },
  }
}
