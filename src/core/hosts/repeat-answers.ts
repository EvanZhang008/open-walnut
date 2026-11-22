/**
 * How often a caller got the same final answer about the same id: a read of a job the host does not
 * hold (host-exec-jobs.ts) or a copy Walnut does not hold (host-copy.ts). No later read finds such an
 * id, so a poll loop that reads it again gets that answer again; 2026-11-22 a session's shell loop
 * read a job that never reached the Mac every 10 s for 40 minutes, a 404 warn line each, until the
 * log-spike alarm rang. The answer carries `repeats` (the reads of it before this one, absent on the
 * first), and its route marks a repeat (markRepeatAnswerIf, web/middleware/handled-failure.ts) so it
 * logs at info: one stale id is one warn line, not one per poll.
 */
const seen = new Map<string, { n: number; at: number }>()
/** A repeat counts within this long of the last answer. */
const KEEP_MS = 60 * 60_000
/** The ids remembered at most (the oldest go first). */
const MAX = 2_000

/** The answers given before this one for `key` within the last hour, and this one noted. */
export function noteFinalAnswer(key: string, now = Date.now()): number {
  const last = seen.get(key)
  const repeats = last && now - last.at < KEEP_MS ? last.n : 0
  seen.delete(key)
  seen.set(key, { n: repeats + 1, at: now })
  if (seen.size > MAX) seen.delete(seen.keys().next().value as string)
  return repeats
}

/** Tests: forget every answer. */
export function resetFinalAnswersForTest(): void {
  seen.clear()
}
