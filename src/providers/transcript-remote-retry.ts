/**
 * When a session's history could not be fetched from remote storage, the reads that follow
 * do not ask again at once (2026-11-19: one session whose fetch kept failing, because the
 * storage's credentials were refused, was fetched about a hundred times an hour, once for every
 * read of its transcript by the history view, the change watch and the copy rounds). A read
 * soon after a failure is answered with that failure, as a missing file: for a minute after
 * the first, then twice as long after each next one, up to REMOTE_RETRY_MS, so a storage that
 * is fixed (its setting restored) is read again within a minute. An open of the session (a
 * resume, a start) always asks again, and a success forgets the failure.
 * Per process: the server and each daemon keep their own.
 */

/** How long reads take a failed fetch as their answer: after the first failure, and at most. */
export const REMOTE_RETRY_FIRST_MS = 60_000
export const REMOTE_RETRY_MS = 10 * 60_000
const MAX_KEPT = 2000

const failed = new Map<string, { at: number; message: string; waitMs: number }>()

/** The failure a read of `key` (a project dir and session id) takes as its answer now, if any. */
export function recentRemoteFailure(key: string, now = Date.now()): { at: number; message: string } | null {
  const f = failed.get(key)
  if (!f) return null
  return now - f.at < f.waitMs ? f : null
}

export function noteRemoteFailure(key: string, message: string, now = Date.now()): void {
  const before = failed.get(key)
  // A failure kept past twice its wait is an old one: start again from the first wait.
  const waitMs = before && now - before.at < 2 * before.waitMs ? Math.min(REMOTE_RETRY_MS, before.waitMs * 2) : REMOTE_RETRY_FIRST_MS
  failed.delete(key)
  failed.set(key, { at: now, message, waitMs })
  if (failed.size > MAX_KEPT) failed.delete(failed.keys().next().value!)
}

export function clearRemoteFailure(key: string): void { failed.delete(key) }

/** Test seam: forget every failure. */
export function resetRemoteFailures(): void { failed.clear() }
