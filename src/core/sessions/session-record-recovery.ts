/**
 * Session record self-heal — rebuild a lost sessions.sqlite row from the
 * canonical JSONL that still exists on disk.
 *
 * WHY THIS EXISTS (inc-2026-08-10, "Untitled session"): a session's SQLite
 * record can be lost while its canonical transcript survives — observed for
 * three 2026-07-14 sessions whose JSONLs are intact under ~/.claude/projects
 * but whose rows are absent from sessions.sqlite (same-day neighbors kept
 * theirs; the reaper archive has no trace, so this was record loss, not
 * retention). A missing record poisons every metadata consumer at once:
 *   - GET /api/sessions/:id → 404 → the panel header settles into
 *     "Untitled session" while /history (which globs the JSONL directly)
 *     still returns the full conversation — the confusing split the user saw.
 *   - processNext() → "No active session found" → any queued message for the
 *     session is stranded pending FOREVER and retried on every server boot
 *     (observed: one message stuck for 27 days, failing on every startup).
 *
 * The transcript is the durable source of truth, so when a lookup misses and
 * the JSONL exists, rebuild a minimal 'stopped' record from its evidence
 * instead of failing. Deliberately NARROW:
 *   - Only fires on a MISS from an explicit recovery call site (route /
 *     processNext), never inside getSessionByClaudeId — hot paths (status
 *     snapshots, health scans) must not pay a disk probe per miss.
 *   - Local-only probe: without a record there is no host to route a remote
 *     find to; every known loss case is local. A remote session's record loss
 *     still 404s (recovering it would require asking every configured host).
 *   - In-flight dedup + a short negative cache so a 404-polling UI (the panel
 *     retries every 500ms) can't stampede the disk or the write lock.
 */

import { log } from '../../logging/index.js'
import type { SessionRecord } from '../types.js'

/** JSONLs smaller than this are noise (an aborted spawn), not worth reviving. */
const MIN_JSONL_BYTES = 256

/** Negative-result cache TTL — the panel polls every 500ms on 404; one probe
 *  per window is plenty. */
const NEGATIVE_TTL_MS = 60_000

const negativeCache = new Map<string, number>()
const inflight = new Map<string, Promise<SessionRecord | null>>()

/** Extract recovery evidence from canonical JSONL content. */
export function extractRecoveryEvidence(content: string): {
  cwd?: string
  firstUserText?: string
  firstTimestamp?: string
  lastTimestamp?: string
  messageCount: number
} {
  let cwd: string | undefined
  let firstUserText: string | undefined
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined
  let messageCount = 0
  for (const line of content.split('\n')) {
    if (!line) continue
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(line) } catch { continue }
    const type = parsed.type as string | undefined
    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts
      lastTimestamp = ts
    }
    if ((type === 'user' || type === 'human') && !cwd && typeof parsed.cwd === 'string') {
      cwd = parsed.cwd
    }
    if (type === 'user' || type === 'assistant') {
      messageCount++
      if (type === 'user' && !firstUserText && parsed.subtype !== 'walnut-injected' && !parsed.isMeta) {
        const msg = parsed.message as Record<string, unknown> | undefined
        const content = msg?.content
        if (typeof content === 'string') {
          firstUserText = content
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (b: Record<string, unknown>) => b?.type === 'text' && typeof b.text === 'string',
          ) as { text: string } | undefined
          if (textBlock) firstUserText = textBlock.text
        }
      }
    }
  }
  return { cwd, firstUserText, firstTimestamp, lastTimestamp, messageCount }
}

/** Derive a human title from the first real user message (same spirit as the
 *  live session title: short prefix of what the user asked). */
function deriveTitle(firstUserText: string | undefined): string | undefined {
  if (!firstUserText) return undefined
  const flat = firstUserText.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > 80 ? flat.slice(0, 80) + '…' : flat
}

/**
 * Attempt to rebuild a lost session record from the local canonical JSONL.
 * Returns the recovered record, or null when there is no transcript evidence
 * (genuine 404). Never throws — recovery is best-effort by design.
 */
export async function recoverSessionRecordFromJsonl(
  sessionId: string,
): Promise<SessionRecord | null> {
  // The id lands in fs.find patterns and log lines — refuse anything odd.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return null

  const cachedAt = negativeCache.get(sessionId)
  if (cachedAt && Date.now() - cachedAt < NEGATIVE_TTL_MS) return null

  const existing = inflight.get(sessionId)
  if (existing) return existing

  const run = (async (): Promise<SessionRecord | null> => {
    try {
      // Re-check under the dedup guard: a concurrent recovery may have won.
      const { getSessionByClaudeId, importSessionRecord } = await import('../session-tracker.js')
      const already = await getSessionByClaudeId(sessionId)
      if (already) return already

      const { DaemonFileReader } = await import('../daemon-file-reader.js')
      const reader = new DaemonFileReader('__local__')
      const found = await reader.findSession(sessionId)
      if (!found || found.content.length < MIN_JSONL_BYTES) {
        negativeCache.set(sessionId, Date.now())
        return null
      }

      const evidence = extractRecoveryEvidence(found.content)
      // A transcript with zero conversational lines is not a session worth
      // reviving (e.g. a bare queue-operation stub).
      if (evidence.messageCount === 0) {
        negativeCache.set(sessionId, Date.now())
        return null
      }

      // importSessionRecord is the exact primitive for this: a 'stopped'
      // interactive record with caller-supplied timestamps (so the recovered
      // row sorts where the session actually lived, not at "now"). cwd comes
      // only from the JSONL's own field — the encoded project dir name is
      // lossy; without it readSessionHistory still globs/finds the file.
      const record = await importSessionRecord({
        claudeSessionId: sessionId,
        taskId: '', // the task link was part of the lost row
        project: '',
        cwd: evidence.cwd,
        title: deriveTitle(evidence.firstUserText),
        startedAt: evidence.firstTimestamp,
        lastActiveAt: evidence.lastTimestamp,
        messageCount: evidence.messageCount,
      })
      log.session.warn('session record self-healed from canonical JSONL', {
        sessionId,
        jsonlPath: found.path,
        messageCount: evidence.messageCount,
        cwd: evidence.cwd,
        firstSeen: evidence.firstTimestamp,
        lastSeen: evidence.lastTimestamp,
      })
      return record
    } catch (err) {
      log.session.warn('session record recovery failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      negativeCache.set(sessionId, Date.now())
      return null
    } finally {
      inflight.delete(sessionId)
    }
  })()

  inflight.set(sessionId, run)
  return run
}

export function _resetSessionRecordRecoveryForTesting(): void {
  negativeCache.clear()
  inflight.clear()
}
