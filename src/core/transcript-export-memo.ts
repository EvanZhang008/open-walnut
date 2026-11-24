/**
 * What the transcript sweep (session-projection.ts exportSessionTranscripts) remembers between
 * its once-a-minute passes, so a pass touches only what moved.
 *
 * 2026-11-24, measured on the Mac's production data (1,063 sessions: 952 stopped, 111 alive):
 * - every pass read and parsed the saved copy of EVERY stopped session (68 MB of JSON a
 *   minute) only to learn when each was exported;
 * - every pass rewrote and pushed the tail of every alive session, about 100 files and 10 MB a
 *   minute, although only `exportedAt` had changed in all 42 rewrites sampled over 30 s.
 *
 * Both are kept by the saved file's stamp (inode, size, mtime): a file anyone else rewrote or
 * removed reads as changed, so nothing here can hide a write it did not make.
 */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { transcriptCachePath } from './projection-cache.js'

/** An alive session whose tail is unchanged is still rewritten this often, so its saved copy's
 *  `exportedAt` (shown as the copy's age when a fresh read misses its deadline) stays recent. */
export const UNCHANGED_TAIL_REWRITE_MS = 10 * 60_000

/** Sessions remembered at most (a few thousand on a busy machine). */
const MEMO_MAX = 20_000

async function stampOf(sessionId: string): Promise<string | null> {
  try {
    const st = await fsp.stat(transcriptCachePath(sessionId))
    return `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

function bounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  if (map.size >= MEMO_MAX) map.delete(map.keys().next().value as K)
  map.set(key, value)
}

/** The part of a saved copy the stopped-session check reads. */
export interface ArchiveHead {
  exportedAt: string
}

const heads = new Map<string, { stamp: string; head: ArchiveHead | null }>()

/**
 * The saved copy's head, parsed only when the file changed since it was last read here. Null
 * when the copy is absent or not a transcript (`parse` decides, as the full read did).
 */
export async function archiveHeadOf(
  sessionId: string,
  read: () => Promise<{ exportedAt: string } | null>,
): Promise<ArchiveHead | null> {
  const stamp = await stampOf(sessionId)
  if (stamp === null) { heads.delete(sessionId); return null }
  const kept = heads.get(sessionId)
  if (kept && kept.stamp === stamp) return kept.head
  const full = await read()
  const head = full ? { exportedAt: full.exportedAt } : null
  // The stamp read before the parse: a write in between reads as changed next time.
  bounded(heads, sessionId, { stamp, head })
  return head
}

const written = new Map<string, { digest: string; stamp: string; at: number }>()

/** The content of a tail without its export time. */
export function tailDigest(t: { truncated: boolean; sinceReached?: boolean; messages: unknown[] }): string {
  return createHash('sha1')
    .update(JSON.stringify([t.truncated, t.sinceReached ?? null, t.messages]))
    .digest('hex')
}

/** True when the tail this pass built is the one this process last saved, the file is still
 *  that save, and the save is younger than UNCHANGED_TAIL_REWRITE_MS. */
export async function tailUnchanged(sessionId: string, digest: string, now = Date.now()): Promise<boolean> {
  const kept = written.get(sessionId)
  if (!kept || kept.digest !== digest || now - kept.at >= UNCHANGED_TAIL_REWRITE_MS) return false
  return (await stampOf(sessionId)) === kept.stamp
}

/** After a save of the tail with `digest`. */
export async function noteTailWritten(sessionId: string, digest: string, now = Date.now()): Promise<void> {
  const stamp = await stampOf(sessionId)
  if (stamp === null) { written.delete(sessionId); return }
  bounded(written, sessionId, { digest, stamp, at: now })
  // The sweep's own write: the head it would parse next is this content's.
  heads.delete(sessionId)
}

export function _resetTranscriptExportMemoForTesting(): void {
  heads.clear()
  written.clear()
}
