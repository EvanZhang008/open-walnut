/**
 * Catch-up context for a send into an EXISTING Personal AI lane (split out of
 * lane-turn.ts, unchanged). See the doc comment below.
 */

import { log } from '../../logging/index.js';

/**
 * Prepend the turns this lane has not seen to the message about to be delivered.
 *
 * WHY THIS EXISTS, and why the mint seed is not enough: a lane can be minted for
 * an EMPTY conversation (the read-driven `ensure: true` mint fires on mount) and
 * only THEN miss content (the Mac sleeps, the cloud replica answers a turn with
 * its own in-process fallback and persists it, the Mac wakes and continues on the
 * SAME lane). Nothing is re-minted, so nothing re-seeds, and the lane answers "we
 * never discussed that" about a turn on the user's screen.
 *
 * A CONTEXT BLOCK on the user's message, not a separate turn: a turn of its own
 * burns a turn and usually gets answered, and the lane is shared with cron /
 * heartbeat / triage, so an extra turn would also perturb their result
 * correlation. The block is wrapped in the established `[Banner]…[/Banner]`
 * convention so the two readers that strip a leading banner keep working (the
 * mobile transcript projection, and the conversation auto-titler).
 *
 * Detection + idempotency live in chat-history.buildLaneCatchUp; the high-water
 * mark is recorded by the CALLER only after the send succeeded, so a delivery
 * that failed is retried with the block still attached.
 *
 * Never throws: a lane that answers without the recap is strictly better than a
 * send that failed because the recap could not be built.
 */
export async function withCatchUpContext(
  agentId: string,
  conversationId: string,
  sessionId: string,
  message: string,
): Promise<{ message: string; commit?: () => Promise<void> }> {
  try {
    const { buildLaneCatchUp, recordLaneSeen, laneEngineLabel } = await import('../chat-history.js');
    const laneLabel = laneEngineLabel(sessionId);
    // ONE record read shared by both answers below, and only on the rare path
    // that needs it (no high-water mark at all).
    let recordOnce: Promise<{ profile?: { systemPrompt?: string }; startedAt?: string } | null> | undefined;
    const laneRecord = (): Promise<{ profile?: { systemPrompt?: string }; startedAt?: string } | null> => {
      recordOnce ??= (async () => {
        const { getSessionByClaudeId } = await import('../session-tracker.js');
        return await getSessionByClaudeId(sessionId).catch(() => null);
      })();
      return recordOnce;
    };
    const catchUp = await buildLaneCatchUp({
      agentId, conversationId, laneLabel,
      seededAtMint: async () => {
        const { CONVERSATION_SEED_HEADER } = await import('../chat-history.js');
        const record = await laneRecord();
        return !!record?.profile?.systemPrompt?.includes(CONVERSATION_SEED_HEADER);
      },
      // The mint time floors trigger A when the mark was lost in a sync merge:
      // without it a seeded lane gets its whole history re-injected.
      laneSeededAt: async () => (await laneRecord())?.startedAt ?? '',
    });
    if (!catchUp) return { message };
    const commit = (): Promise<void> => recordLaneSeen(agentId, conversationId, laneLabel, catchUp.watermark);
    // Resolved turns that render to nothing (tool traffic only): send the message
    // untouched, but still advance the mark, or the same turns are re-selected on
    // every send for the life of the lane.
    if (!catchUp.text) return { message, commit };
    const { CATCH_UP_BANNER_OPEN, CATCH_UP_BANNER_CLOSE } = await import('../chat-history.js');
    log.session.warn('lane turn: injecting conversation context this lane never saw', {
      sessionId, agentId, conversationId,
      turns: catchUp.stats.turnsKept, tokens: catchUp.stats.tokens, omitted: catchUp.stats.omitted,
    });
    return {
      message: `${CATCH_UP_BANNER_OPEN}\n${catchUp.text}\n${CATCH_UP_BANNER_CLOSE}\n\n${message}`,
      commit,
    };
  } catch (err) {
    log.session.warn('lane turn: building the catch-up context failed', {
      sessionId, agentId, conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { message };
  }
}
