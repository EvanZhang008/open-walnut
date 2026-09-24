/**
 * Stream-capture retention — delete local stream files that are pure duplicates.
 *
 * Root cause of the 2026-09 15GB pileup: LocalIO writes a full stream capture to
 * SESSION_STREAMS_DIR for every local session ({sessionId}.jsonl), and nothing
 * deletes it when the session ends. The capture only matters while the canonical
 * Claude Code transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) is missing
 * or unreadable (see session-file-reader.ts fallback order); once the canonical
 * file exists, the capture is redundant — measured 14.8GB of 15.2GB duplicated.
 *
 * A file is deleted only when ALL hold:
 *   - a canonical transcript with the same <sessionId>.jsonl name exists under
 *     the Claude projects dir (so history remains readable),
 *   - it has not been written for `retentionMs` (default 7 days — no live or
 *     recently-resumed session is streaming from it; byte offsets survive
 *     recreation, see claude-code-session.ts "stream file was recreated"),
 *   - its session id is not in `activeIds` (belt and braces for idle-but-alive
 *     sessions whose file mtime went stale).
 *
 * Everything else is kept forever: acp-*.acp.jsonl (no canonical exists),
 * embedded-* captures (owned by the SessionReaper archive path), captures whose
 * canonical was deleted (the capture IS the only copy), and non-jsonl entries.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'

export const STREAM_RETENTION_MS = 7 * 24 * 3600_000

export interface StreamRetentionOptions {
  /** SESSION_STREAMS_DIR (injectable for tests). */
  streamsDir: string
  /** ~/.claude/projects (injectable for tests). */
  claudeProjectsDir: string
  /** Claude session ids that still have a live session record. */
  activeIds: ReadonlySet<string>
  retentionMs?: number
  now?: number
}

/** Collect the basenames of every canonical transcript: projects/<slug>/<id>.jsonl. */
async function canonicalTranscriptNames(claudeProjectsDir: string): Promise<Set<string>> {
  const names = new Set<string>()
  let slugs: string[]
  try {
    slugs = await fs.readdir(claudeProjectsDir)
  } catch {
    return names // no Claude home → nothing is provably recoverable
  }
  for (const slug of slugs) {
    let entries: string[]
    try {
      entries = await fs.readdir(path.join(claudeProjectsDir, slug))
    } catch {
      continue // a plain file, or unreadable — not a project dir
    }
    for (const e of entries) {
      if (e.endsWith('.jsonl')) names.add(e)
    }
  }
  return names
}

/**
 * Delete stream captures whose canonical transcript exists and whose session is
 * cold. Returns the deleted .jsonl paths. Never throws: retention is
 * housekeeping and must not fail the reap that asked.
 */
export async function sweepRecoverableStreamFiles(opts: StreamRetentionOptions): Promise<string[]> {
  const { streamsDir, claudeProjectsDir, activeIds } = opts
  const retentionMs = opts.retentionMs ?? STREAM_RETENTION_MS
  const now = opts.now ?? Date.now()
  const deleted: string[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(streamsDir)
  } catch {
    return deleted
  }
  // Only .jsonl captures named exactly <sessionId>.jsonl are candidates. This
  // excludes acp-*.acp.jsonl (double extension → basename ends in .acp) via the
  // canonical-name check, and .err/.pipe/temp files via the extension check.
  const candidates = entries.filter(e => e.endsWith('.jsonl'))
  if (candidates.length === 0) return deleted

  const canonical = await canonicalTranscriptNames(claudeProjectsDir)
  if (canonical.size === 0) return deleted

  for (const name of candidates) {
    if (!canonical.has(name)) continue // unrecoverable: the capture is the only copy
    const sessionId = name.slice(0, -'.jsonl'.length)
    if (activeIds.has(sessionId)) continue
    const file = path.join(streamsDir, name)
    try {
      const st = await fs.stat(file)
      if (!st.isFile() || now - st.mtimeMs < retentionMs) continue
      await fs.unlink(file)
      deleted.push(file)
      await fs.unlink(file + '.err').catch(() => { /* no error sidecar */ })
    } catch {
      // raced with a concurrent delete or the file is pinned; next reap retries
    }
  }

  if (deleted.length > 0) {
    log.session.info('stream retention: deleted recoverable stream captures', {
      deleted: deleted.length,
    })
  }
  return deleted
}
