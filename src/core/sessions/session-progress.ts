/**
 * Last time each live session's CLI stream produced ANY line.
 *
 * The lane-turn liveness rule (lane-turn.ts) needs "is this turn still making
 * progress", and the honest answer is the CLI's own stream: every line counts,
 * including the ones the bus never sees (tool_progress heartbeats, which the
 * CLI emits every 30 s during a long Bash / Agent / Skill / TaskOutput call,
 * api_retry notices, compaction status). Subscribing to the streaming bus
 * events instead would wake a global handler on every text delta of every
 * session, the event-loop starvation class the bus `interest` sets exist to
 * avoid, and would still miss the heartbeats.
 *
 * So the stream parser (ClaudeCodeSession.handleStreamLine) stamps this map
 * once per line: one Map write, no allocation beyond the entry. Readers poll it
 * on their own slow cadence. Bounded so a long-lived server that has streamed
 * thousands of sessions keeps only the most recently active ones.
 */

const MAX_ENTRIES = 2_000

const lastProgressAt = new Map<string, number>()

/** Record that `sessionId`'s stream just produced a line. */
export function noteSessionProgress(sessionId: string | null | undefined, at: number = Date.now()): void {
  if (!sessionId) return
  // Delete first so the entry moves to the end of the insertion order: eviction
  // below then drops the least recently active session, never a live one.
  lastProgressAt.delete(sessionId)
  lastProgressAt.set(sessionId, at)
  if (lastProgressAt.size > MAX_ENTRIES) {
    const oldest = lastProgressAt.keys().next().value
    if (oldest !== undefined) lastProgressAt.delete(oldest)
  }
}

/** Epoch ms of the session's last stream line, or undefined when never seen. */
export function lastSessionProgressAt(sessionId: string): number | undefined {
  return lastProgressAt.get(sessionId)
}

/** Tests only. */
export function _resetSessionProgressForTesting(): void {
  lastProgressAt.clear()
}
