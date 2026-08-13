/**
 * Session Reaper — periodic cleanup of environment session records.
 *
 * Runs every hour. For environment sessions (triage, hook, cron, embedded subagent)
 * that are in a terminal state and older than RETENTION_MS:
 *   1. Archive record → append to sessions-archive-{YYYY-MM}.jsonl
 *   2. Archive conversation → mv stream file to archive/streams/
 *   3. Remove from sessions.json
 *   4. Rotate old archives (>180 days) → delete
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import { SESSION_STREAMS_DIR } from '../constants.js'
import type { SessionRecord } from './types.js'
import { isEnvironmentSession } from './session-tracker.js'

const REAP_INTERVAL_MS = 60 * 60 * 1000          // every hour
const INITIAL_DELAY_MS = 60 * 1000               // 60s after server start
const DEFAULT_RETENTION_MS = 30 * 24 * 3600_000  // 30 days in sessions.json
const ARCHIVE_TTL_MS = 180 * 24 * 3600_000       // archive kept 180 days

// Archive lives alongside streams: ~/.open-walnut/sessions/archive/
const ARCHIVE_DIR = path.join(path.dirname(SESSION_STREAMS_DIR), 'archive')
const ARCHIVE_STREAMS_DIR = path.join(ARCHIVE_DIR, 'streams')

// Reapable sessions are determined by isEnvironmentSession() — all system-created
// background sessions (triage, hook, cron, embedded subagent) are eligible.

/** Get the relevant timestamp for a session (for age comparison and month grouping). */
function sessionTimestamp(s: SessionRecord): string | undefined {
  return s.last_status_change ?? s.lastActiveAt ?? s.startedAt
}

export class SessionReaper {
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null

  start(): void {
    if (this.timer) return
    this.initialTimer = setTimeout(() => {
      this.reap().catch((err) => {
        log.session.warn('session reaper: unexpected error', { error: String(err) })
      })
      this.initialTimer = null
    }, INITIAL_DELAY_MS)
    this.timer = setInterval(() => this.reap().catch((err) => {
      log.session.warn('session reaper: unexpected error', { error: String(err) })
    }), REAP_INTERVAL_MS)
    log.session.info('session reaper started', { intervalMs: REAP_INTERVAL_MS })
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.session.info('session reaper stopped')
    }
  }

  async reap(): Promise<{ reaped: number; rotated: number }> {
    const { listSessions, deleteSessionRecords } = await import('./session-tracker.js')

    let sessions: SessionRecord[]
    try {
      sessions = await listSessions()
    } catch (err) {
      log.session.warn('session reaper: failed to read sessions', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { reaped: 0, rotated: 0 }
    }

    const now = Date.now()
    const cutoff = now - DEFAULT_RETENTION_MS

    // Find reapable sessions
    const toReap = sessions.filter(s => {
      if (!isEnvironmentSession(s)) return false
      if (s.process_status !== 'stopped' && s.process_status !== 'error') return false
      const ts = sessionTimestamp(s)
      return ts ? new Date(ts).getTime() < cutoff : false
    })

    if (toReap.length === 0) {
      const rotated = await this.rotateArchives()
      return { reaped: 0, rotated }
    }

    // Ensure archive directories exist
    await fs.mkdir(ARCHIVE_DIR, { recursive: true })
    await fs.mkdir(ARCHIVE_STREAMS_DIR, { recursive: true })

    // Group by archive month for batch append
    const byMonth = new Map<string, SessionRecord[]>()
    for (const s of toReap) {
      const ts = sessionTimestamp(s)!
      const d = new Date(ts)
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const list = byMonth.get(month) ?? []
      list.push(s)
      byMonth.set(month, list)
    }

    // Archive records
    const reapedAt = new Date().toISOString()
    for (const [month, records] of byMonth) {
      const archiveFile = path.join(ARCHIVE_DIR, `sessions-archive-${month}.jsonl`)
      const lines = records.map(r => JSON.stringify({ ...r, reaped_at: reapedAt })).join('\n') + '\n'
      await fs.appendFile(archiveFile, lines, 'utf-8')
    }

    // Move conversation stream files (best-effort)
    for (const s of toReap) {
      const src = path.join(SESSION_STREAMS_DIR, `embedded-${s.claudeSessionId}.jsonl`)
      const dst = path.join(ARCHIVE_STREAMS_DIR, `embedded-${s.claudeSessionId}.jsonl`)
      try {
        await fs.rename(src, dst)
      } catch {
        // ENOENT = already cleaned up by cleanupStreamFiles, ignore
      }
    }

    // Remove from sessions.json
    const ids = new Set(toReap.map(s => s.claudeSessionId))
    const removed = await deleteSessionRecords(ids, 'reaper-environment-retention')

    log.session.info('session reaper: reaped', {
      reaped: removed,
      candidates: toReap.length,
      months: [...byMonth.keys()],
    })

    const rotated = await this.rotateArchives()
    return { reaped: removed, rotated }
  }

  private async rotateArchives(): Promise<number> {
    let deleted = 0
    const cutoff = Date.now() - ARCHIVE_TTL_MS

    // Rotate archive JSONL files by month
    try {
      const files = await fs.readdir(ARCHIVE_DIR)
      for (const f of files) {
        if (!f.startsWith('sessions-archive-') || !f.endsWith('.jsonl')) continue
        const match = f.match(/sessions-archive-(\d{4})-(\d{2})\.jsonl/)
        if (!match) continue
        // JS month is 0-indexed; match[2] is 1-indexed from filename.
        // new Date(year, 1-based-month, 0) gives last day of that month via day=0 rollback.
        const monthEnd = new Date(parseInt(match[1]), parseInt(match[2]), 0)
        if (monthEnd.getTime() < cutoff) {
          await fs.unlink(path.join(ARCHIVE_DIR, f))
          deleted++
        }
      }
    } catch {
      // ARCHIVE_DIR may not exist yet
    }

    // Rotate archived stream files by mtime
    try {
      const files = await fs.readdir(ARCHIVE_STREAMS_DIR)
      for (const f of files) {
        const filePath = path.join(ARCHIVE_STREAMS_DIR, f)
        try {
          const stat = await fs.stat(filePath)
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(filePath)
            deleted++
          }
        } catch {
          // stat/unlink failed — skip
        }
      }
    } catch {
      // ARCHIVE_STREAMS_DIR may not exist yet
    }

    if (deleted > 0) {
      log.session.info('session reaper: rotated old archives', { deleted })
    }
    return deleted
  }
}
