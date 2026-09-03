/**
 * Cache warm-up for a standby side-thread fork.
 *
 * A fork's FIRST API call re-writes the whole conversation prefix into the
 * prompt cache whenever the parent has been running for a while: Claude Code
 * memoizes per-process context (CLAUDE.md bytes, today's date, the git status
 * snapshot) into the request prefix, and a new process recomputes all of it, so
 * only the ~17K shared base survives. Measured on a 330K-token parent: the
 * user's first question paid a 331K cache write, 10-47s to first text.
 *
 * That write is unavoidable, but WHEN it happens is not. The drawer fires this
 * warm-up as soon as the user has typed a few characters of a new question; by
 * the time they press Enter the fork's own cache is populated and the question
 * lands as an incremental (cheap, fast) follow-up. Cost is the same as asking
 * without it, just paid a few seconds earlier.
 *
 * The warm-up exchange is CLI plumbing, not conversation: session-history hides
 * the tagged user line and the reply that answers it on every surface.
 */

export const CACHE_WARMUP_TAG = '<walnut-cache-warmup>';

export const CACHE_WARMUP_MESSAGE =
  `${CACHE_WARMUP_TAG}This is a cache warm-up from the tool hosting this side thread, not a user ` +
  'message. Reply with exactly one word: Ready. Use no tools and add nothing else.</walnut-cache-warmup>';

export function isCacheWarmupText(text: string): boolean {
  return text.startsWith(CACHE_WARMUP_TAG);
}

/**
 * Sessions whose NEXT turn result is a warm-up reply. The stream-convergence
 * sentinel (observability) verifies every streamed text id against persisted
 * history, and history hides the warm-up reply on purpose, so without this the
 * sentinel filed a "full turn lost" incident for every warm-up. One mark, one
 * skipped check: a mark left behind by a warm-up that never produced a result
 * costs exactly one skipped check on that session's next turn, never more.
 */
const pendingWarmupTurns = new Set<string>();

export function markWarmupTurnPending(sessionId: string): void {
  pendingWarmupTurns.add(sessionId);
}

export function consumeWarmupTurn(sessionId: string): boolean {
  return pendingWarmupTurns.delete(sessionId);
}
