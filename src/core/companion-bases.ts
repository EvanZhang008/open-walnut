/**
 * The companion's bases of its queued task writes, on disk (replica plan WP13,
 * section 7): for each task, the last value of every field the Mac merges, as
 * this box knows it (the Mac's row as the task copy took it, then each write made
 * here). task-queue.ts companionFieldWrites reads the base of a write from here.
 *
 * On disk, not in memory: a companion restarted while the Mac is away (a deploy,
 * a crash, a reboot) gets no copy round to refill a memory map, and every write
 * would then go with base 'unknown', which the Mac never merges as text: the
 * newer write replaces the field whole and the two drain orders give different
 * tasks. One small sqlite file under cache/ (kept out of git-sync by *.sqlite),
 * one row per task, read and written by primary key only.
 *
 * A store that cannot be opened degrades to a bounded memory map (logged once):
 * bases until the next restart, as before.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

export function companionBasesPath(): string {
  return path.join(WALNUT_HOME, 'cache', 'companion-bases.sqlite')
}

let db: DatabaseType | null = null
let failed = false
/** The fallback when the file cannot be opened: the newest rows only. */
const memory = new Map<string, Record<string, unknown>>()
const MEMORY_MAX = 5_000

function open(): DatabaseType | null {
  if (db) return db
  if (failed) return null
  try {
    fs.mkdirSync(path.dirname(companionBasesPath()), { recursive: true })
    const d = new Database(companionBasesPath())
    d.pragma('journal_mode = WAL')
    d.pragma('busy_timeout = 2000')
    d.exec('CREATE TABLE IF NOT EXISTS bases (id TEXT PRIMARY KEY, row TEXT NOT NULL, at INTEGER NOT NULL)')
    db = d
    return d
  } catch (err) {
    failed = true
    log.task.warn('companion bases: the store could not be opened, bases are kept in memory until a restart', { err: String(err) })
    return null
  }
}

function remember(id: string, row: Record<string, unknown>): void {
  memory.delete(id)
  memory.set(id, row)
  if (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined) memory.delete(oldest)
  }
}

/** Keep these rows as the bases of the next writes to them (one transaction). */
export function putCompanionBases(rows: ReadonlyArray<{ id: string; row: Record<string, unknown> }>): void {
  if (rows.length === 0) return
  const d = open()
  if (!d) { for (const r of rows) remember(r.id, r.row); return }
  try {
    const put = d.prepare('INSERT INTO bases (id, row, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET row = excluded.row, at = excluded.at')
    const now = Date.now()
    d.transaction(() => { for (const r of rows) put.run(r.id, JSON.stringify(r.row), now) })()
  } catch (err) {
    log.task.warn('companion bases: a write failed, kept in memory', { err: String(err), rows: rows.length })
    for (const r of rows) remember(r.id, r.row)
  }
}

/** The base row of a task, or undefined when this box never knew it. */
export function companionBaseOf(id: string): Record<string, unknown> | undefined {
  const inMemory = memory.get(id)
  if (inMemory) return inMemory
  const d = open()
  if (!d) return undefined
  try {
    const hit = d.prepare('SELECT row FROM bases WHERE id = ?').get(id) as { row: string } | undefined
    if (!hit) return undefined
    const row = JSON.parse(hit.row) as unknown
    return row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The tasks are gone here (deleted, or removed by the copy): no base kept for them. */
export function forgetCompanionBases(ids: readonly string[]): void {
  if (ids.length === 0) return
  for (const id of ids) memory.delete(id)
  const d = open()
  if (!d) return
  try {
    const del = d.prepare('DELETE FROM bases WHERE id = ?')
    d.transaction(() => { for (const id of ids) del.run(id) })()
  } catch { /* a base left behind is only disk; the next write replaces it */ }
}

/** Tests only: a restart (the handle closed, the memory map gone; the file stays). */
export function _closeCompanionBasesForTesting(): void {
  try { db?.close() } catch { /* closed */ }
  db = null
  failed = false
  memory.clear()
}

/** Tests only: no base for any task (the file emptied). */
export function _clearCompanionBasesForTesting(): void {
  memory.clear()
  const d = open()
  try { d?.exec('DELETE FROM bases') } catch { /* gone */ }
}
