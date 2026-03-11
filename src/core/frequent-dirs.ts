/**
 * Persistent frequent-directories store.
 *
 * Replaces the on-the-fly scan of all sessions in the working-dirs API.
 * Data lives at ~/.walnut/frequent-directories.json.
 *
 * - First access auto-compiles from sessions.json if the file doesn't exist.
 * - Session start calls recordDirectory() for incremental updates.
 * - Manual recompile available via compileFromSessions().
 */

import fs from 'node:fs'
import { FREQUENT_DIRS_FILE } from '../constants.js'
import { log } from '../logging/index.js'

// ── Types ──

export interface FrequentDirEntry {
  cwd: string
  host: string | null
  count: number
  lastUsed: string // ISO timestamp
  categoryVotes: Record<string, number>
}

interface FrequentDirsStore {
  version: 1
  compiledAt: string
  directories: FrequentDirEntry[]
}

// ── In-process write lock (same pattern as session-tracker) ──

let writeLock: Promise<void> = Promise.resolve()

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock
  let resolve: () => void
  writeLock = new Promise<void>(r => { resolve = r })
  return prev.then(fn).finally(() => resolve!())
}

// ── Read / Write ──

function readStore(): FrequentDirsStore | null {
  try {
    if (!fs.existsSync(FREQUENT_DIRS_FILE)) return null
    const raw = fs.readFileSync(FREQUENT_DIRS_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    // Schema validation: reject corrupted or incompatible data
    if (parsed?.version !== 1 || !Array.isArray(parsed?.directories)) return null
    return parsed as FrequentDirsStore
  } catch {
    return null
  }
}

function writeStore(store: FrequentDirsStore): void {
  fs.writeFileSync(FREQUENT_DIRS_FILE, JSON.stringify(store, null, 2))
}

// ── Public API ──

/**
 * Get all frequent directories. Auto-compiles from sessions on first access.
 */
export async function getFrequentDirs(): Promise<FrequentDirEntry[]> {
  let store = readStore()
  if (!store) {
    await compileFromSessions()
    store = readStore()
  }
  return store?.directories ?? []
}

/**
 * Record a directory usage (called on session start).
 * Increments count, updates lastUsed, adds category vote.
 */
export async function recordDirectory(cwd: string, host: string | null, category?: string): Promise<void> {
  return withWriteLock(async () => {
    let store = readStore()
    if (!store) {
      // First time — compile from history, then apply this entry on top
      await compileFromSessionsInternal()
      store = readStore()
      if (!store) {
        store = { version: 1, compiledAt: new Date().toISOString(), directories: [] }
      }
    }

    const key = `${cwd}::${host ?? '__local__'}`
    let entry = store.directories.find(d => `${d.cwd}::${d.host ?? '__local__'}` === key)

    if (entry) {
      entry.count++
      entry.lastUsed = new Date().toISOString()
      if (category) {
        entry.categoryVotes[category] = (entry.categoryVotes[category] ?? 0) + 1
      }
    } else {
      const votes: Record<string, number> = {}
      if (category) votes[category] = 1
      store.directories.push({
        cwd,
        host,
        count: 1,
        lastUsed: new Date().toISOString(),
        categoryVotes: votes,
      })
    }

    writeStore(store)
  })
}

/**
 * One-time compile from sessions.json. Rebuilds the entire store.
 */
export async function compileFromSessions(): Promise<void> {
  return withWriteLock(compileFromSessionsInternal)
}

/**
 * Internal compile (must be called within writeLock or from recordDirectory's lock).
 */
async function compileFromSessionsInternal(): Promise<void> {
  try {
    const { listSessions, isTriageSession } = await import('./session-tracker.js')
    const { listTasks } = await import('./task-manager.js')

    const sessions = await listSessions()
    const tasks = await listTasks()

    // Build taskId → category map
    const taskCategoryMap = new Map<string, string>()
    for (const t of tasks) {
      taskCategoryMap.set(t.id, t.category)
    }

    // Aggregate by cwd::host
    const dirMap = new Map<string, FrequentDirEntry>()

    for (const s of sessions) {
      if (!s.cwd) continue
      if (isTriageSession(s)) continue
      if (s.archived) continue

      const key = `${s.cwd}::${s.host ?? '__local__'}`
      const category = s.taskId ? taskCategoryMap.get(s.taskId) : undefined
      const existing = dirMap.get(key)

      if (existing) {
        existing.count++
        if (s.startedAt > existing.lastUsed) existing.lastUsed = s.startedAt
        if (category) {
          existing.categoryVotes[category] = (existing.categoryVotes[category] ?? 0) + 1
        }
      } else {
        const votes: Record<string, number> = {}
        if (category) votes[category] = 1
        dirMap.set(key, {
          cwd: s.cwd,
          host: s.host ?? null,
          count: 1,
          lastUsed: s.startedAt,
          categoryVotes: votes,
        })
      }
    }

    const store: FrequentDirsStore = {
      version: 1,
      compiledAt: new Date().toISOString(),
      directories: Array.from(dirMap.values()),
    }

    writeStore(store)
    log.info('frequent-dirs: compiled from sessions', { count: store.directories.length })
  } catch (err) {
    log.warn('frequent-dirs: compile failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
