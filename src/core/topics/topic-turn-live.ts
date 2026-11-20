/**
 * Whether a member's topic turn (`pendingTurn`) can still bring its reply (review 2026-11-20: a
 * member waited up to PENDING_TURN_MAX_MS behind a turn that no longer ran).
 *
 * A turn is live only while it is the member's turn in the session its next wake would go to, and
 * that session runs a turn now, holds a message queued for one, or keeps work its turn left
 * running (turnHold, the reading an engine switch or a move waits on: the record's `running`, which
 * the UI shows as working, corrected by the runner). A turn claimed under TOPIC_TURN_SETTLE_MS ago
 * counts as live whatever the session says: its wake may still be between the queue and the CLI.
 */
import { PENDING_TURN_MAX_MS, type TopicPendingTurn } from './topics-model.js';

/** How long a just-claimed turn counts as live before its session shows the turn. */
export const TOPIC_TURN_SETTLE_MS = 60_000;

type TurnLive = (sessionId: string) => Promise<boolean>;
let liveOverride: TurnLive | null = null;
/** Test seam: replace the session reading. */
export function _setTopicTurnLiveForTesting(fn: TurnLive | null): void { liveOverride = fn; }

/** The session runs a turn, has one queued, or keeps its turn's work running. Unreadable: live (the age cap still holds). */
export async function sessionTurnLive(sessionId: string): Promise<boolean> {
  if (liveOverride) return liveOverride(sessionId);
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sessionId);
    if (!rec) return false;
    const { turnHold } = await import('../sessions/turn-end-wait.js');
    return (await turnHold(rec, { queue: true })) !== 'free';
  } catch {
    return true;
  }
}

/** Pure: whether `turn` still holds a new wake back, given the session the wake goes to and whether it is live. */
export function turnHoldsWake(turn: TopicPendingTurn, sessionId: string, live: boolean, nowMs: number): boolean {
  if (turn.sessionId !== sessionId) return false;
  const age = nowMs - Date.parse(turn.since);
  if (!(age <= PENDING_TURN_MAX_MS)) return false;
  return live || age <= TOPIC_TURN_SETTLE_MS;
}
