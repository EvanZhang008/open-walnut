/**
 * Task projection — a slim JSON snapshot of the task list, kept in the
 * NON-git projection cache (`cache/projections/tasks.json`) and PUSHED to the
 * cloud companion over the daemon bridge (see core/projection-cache.ts;
 * tasks.sqlite itself is machine-local and gitignored/binary).
 *
 * Primary box: exportTaskProjection() rewrites the cache + pushes a
 * `projection-upsert` bridge frame when tasks change (debounced off task:*
 * bus events) and once at startup. While the config knob
 * `sync.legacy_projection_files` is true (default), it ALSO writes the
 * legacy git-tracked `tasks/projection.json` for cloud boxes still running
 * pre-cache code.
 * Cloud box: the pushed frames land in the same cache path (events-v1 →
 * projection-cache, which also triggers task-outbox's projection import);
 * readTaskProjection() serves GET /api/v1/tasks from the cache (legacy git
 * file as transition fallback) — the pushed projection IS the replica.
 *
 * Scope: everything except done tasks older than DONE_RETENTION_DAYS — recent
 * completions matter for a Reminders-style "Completed" section, ancient ones
 * only bloat the payload.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { TASKS_DIR } from '../constants.js'
import { writeJsonFile } from '../utils/fs.js'
import { bus } from './event-bus.js'
import { log } from '../logging/index.js'
import {
  legacyProjectionFilesEnabled,
  pickFresherEnvelope,
  pushProjectionToCloud,
  readProjectionCache,
  writeProjectionCache,
} from './projection-cache.js'
import type { Task } from './types.js'

/** LEGACY git-synced path — dual-written while `sync.legacy_projection_files`
 *  is on (see projection-cache.ts); cache/projections/tasks.json is the live copy. */
export const PROJECTION_FILE = path.join(TASKS_DIR, 'projection.json')

const DONE_RETENTION_DAYS = 14
const DEBOUNCE_MS = 3_000

/** Slim task shape shipped to the companion — v2 contract (category removed). */
export interface ProjectedTask {
  id: string
  title: string
  status: string
  phase: string
  priority: string
  /** Single grouping layer. '' = Inbox. */
  project: string
  due_date?: string
  start_date?: string
  end_date?: string
  created_at: string
  updated_at: string
  completed_at?: string
  pinned?: boolean
  /** Focus-bar order/tier (additive, pinned rows only) — lets the REPLICA's
   *  focus endpoints mirror the primary's tier split instead of dumping every
   *  pin into satellite in arbitrary order. */
  pin_order?: number
  focus_tier?: string
  /** Read/unread marker — true = agent output the human hasn't opened. Additive
   *  (omitted when false), so an older iOS build that doesn't decode it is fine. */
  unread?: boolean
  tags?: string[]
  /** First 500 chars — enough for a detail preview without the full blob. */
  summary?: string
}

/**
 * Projection envelope. `version` is a HARD contract: the reader fail-closes on
 * anything other than PROJECTION_VERSION, so an old reader served a v2 file
 * returns an empty list instead of mis-parsing rows that lost `category`.
 */
export const PROJECTION_VERSION = 2 as const

export interface TaskProjection {
  version: typeof PROJECTION_VERSION
  exportedAt: string
  tasks: ProjectedTask[]
  /** Custom focus-tier registry (additive) — lets the REPLICA validate tier
   *  values and bucket its tier split like the primary. Absent on projections
   *  from an older primary. */
  custom_tiers?: Array<{ id: string; label: string }>
}

const SUMMARY_MAX = 500

/** Exported: POST /api/v1/tasks answers with the same slim shape GET /tasks serves. */
export function projectTask(t: Task): ProjectedTask {
  const summary = (t.summary || '').trim()
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    phase: t.phase,
    priority: t.priority,
    project: t.project || '',
    ...(t.due_date ? { due_date: t.due_date } : {}),
    ...(t.start_date ? { start_date: t.start_date } : {}),
    ...(t.end_date ? { end_date: t.end_date } : {}),
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...(t.completed_at ? { completed_at: t.completed_at } : {}),
    ...(t.pinned ? { pinned: true } : {}),
    // typeof check (not just != null): a null-clear can survive in the payload
    // blob; only a real number is an order.
    ...(t.pinned && typeof t.pin_order === 'number' ? { pin_order: t.pin_order } : {}),
    ...(t.pinned && t.focus_tier ? { focus_tier: t.focus_tier } : {}),
    ...(t.unread ? { unread: true } : {}),
    ...(t.tags && t.tags.length > 0 ? { tags: t.tags } : {}),
    ...(summary ? { summary: summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX) + '…' : summary } : {}),
  }
}

/**
 * Build the projection in memory. Shared by the file export below and the
 * mobile events feed's snapshot frame (events-v1), which needs the same rows
 * without a disk round trip. Works on both boxes (the replica has a real
 * local task store).
 */
export async function buildTaskProjection(): Promise<TaskProjection> {
  // Lazy import breaks the task-manager ↔ projection cycle risk.
  const { listTasks, getCustomTiers } = await import('./task-manager.js')
  const all = await listTasks()
  const customTiers = await getCustomTiers().catch(() => [])
  const cutoff = Date.now() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  // Done-retention applies to pinned rows too, DELIBERATELY: with completion
  // no longer unpinning (2026-08-26) the done-pin population only grows, and
  // an exemption here makes the projection (git-synced + pushed over the
  // bridge on every task change) converge on "every task ever". The phone's
  // working-set view shows open pins plus the last 14 days of finished ones.
  const tasks = all
    .filter((t) => {
      if (t.status !== 'done') return true
      const doneAt = Date.parse(t.completed_at ?? t.updated_at)
      return Number.isFinite(doneAt) && doneAt >= cutoff
    })
    .map(projectTask)
  return {
    version: PROJECTION_VERSION,
    exportedAt: new Date().toISOString(),
    tasks,
    ...(customTiers.length > 0 ? { custom_tiers: customTiers.map((t) => ({ id: t.id, label: t.label })) } : {}),
  }
}

/**
 * Export the current task list: write the projection cache (always), push it
 * to the cloud over the bridge (fire-and-forget), and — while the
 * `sync.legacy_projection_files` knob is on — also rewrite the legacy
 * git-synced file (atomic writes throughout).
 */
export async function exportTaskProjection(): Promise<number> {
  const projection = await buildTaskProjection()
  await writeProjectionCache('tasks', projection)
  if (await legacyProjectionFilesEnabled()) {
    await writeJsonFile(PROJECTION_FILE, projection)
  }
  pushProjectionToCloud('projection-upsert', { which: 'tasks', data: projection })
  return projection.tasks.length
}

/** Envelope gate shared by the cache and legacy sources — FAIL-CLOSED on a
 *  version mismatch: a v1 file (rows keyed by category) must never be handed
 *  to v2 readers, and vice versa. An empty list is a visibly degraded state,
 *  a mis-parsed one is silent data corruption. */
function parseTaskProjection(raw: unknown, source: string): TaskProjection | null {
  if (raw == null) return null
  const parsed = raw as TaskProjection
  if (parsed?.version !== PROJECTION_VERSION || !Array.isArray(parsed.tasks)) {
    // Loud: on a replica this payload is written by the PRIMARY, so a version
    // skew (primary still pre-v5, or rolled back) means every read fails
    // closed until the primary upgrades — without this line that presents
    // as "sync is slow" with no diagnosable cause.
    log.task.warn('task-projection: version mismatch, failing closed', {
      found: parsed?.version, expected: PROJECTION_VERSION, source,
    })
    return null
  }
  return parsed
}

/**
 * Read the task projection (both boxes): the projection cache (written
 * locally on the primary, bridge-pushed on the cloud) vs the legacy
 * git-synced file (transition fallback), fresher exportedAt wins — a long
 * bridge outage must not pin a replica to a stale cache while git-sync has
 * newer data. Null when absent/corrupt.
 */
export async function readTaskProjection(): Promise<TaskProjection | null> {
  const cached = parseTaskProjection(await readProjectionCache('tasks'), 'cache')
  let legacy: TaskProjection | null = null
  try {
    legacy = parseTaskProjection(JSON.parse(await fsp.readFile(PROJECTION_FILE, 'utf-8')), PROJECTION_FILE)
  } catch { /* absent/corrupt legacy file */ }
  return pickFresherEnvelope(cached, legacy)
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
