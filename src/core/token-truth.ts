/**
 * Token-truth — the single source for "how big is this conversation REALLY?"
 * decisions (compaction gate, triage bail).
 *
 * WHY THIS EXISTS (hard-won, do not regress):
 * Our offline estimator (estimateFullPayload → @anthropic-ai/tokenizer, a Claude-2
 * BPE) systematically UNDERCOUNTS Claude 3+ payloads by ~35%. A raw estimate of
 * ~758K for a real ~1.03M-token history sailed under every 80–92% gate, so NEITHER
 * background compaction NOR the triage bail ever fired — the main conversation grew
 * unbounded until it hit the hard ~1M API limit and 400'd every turn. Any decision
 * that GATES on conversation size must reason in real-token space, not estimate space.
 *
 * Two independent signals; take the larger (more conservative):
 *   1. estimate × ESTIMATE_CORRECTION — static calibration (~1.35 observed in 400 logs).
 *   2. the conversation's last EXACT API input_tokens (incl. cache) — ground truth.
 *      History only grows between turns; a successful compaction shrinks it (we clear
 *      the cached value on prune so the gate doesn't re-fire on a stale large count),
 *      and over-estimating only makes the gate fire slightly early, which is safe.
 *
 * This map is process-global and keyed by conversationId. It MUST be the ONLY copy:
 * the chat `onUsage` callback writes here, and needsCompaction / triage bail read here.
 * Two separate maps would silently drop the ground-truth signal (the original bug).
 */

/** Static calibration for the Claude-2-BPE estimator's ~35% Claude-3+ undercount. */
export const ESTIMATE_CORRECTION = 1.35;

const lastTurnExactTokens = new Map<string, number>();

/** Record the EXACT input-token count (system + tools + messages, incl. cache) that
 *  the API reported for a conversation's last successful turn. */
export function recordLastTurnTokens(conversationId: string, exactInputTokens: number): void {
  if (exactInputTokens > 0) lastTurnExactTokens.set(conversationId, exactInputTokens);
}

/** Get the exact input-token count from the conversation's last successful turn, if known. */
export function getLastTurnTokens(conversationId: string): number | undefined {
  return lastTurnExactTokens.get(conversationId);
}

/** Forget the cached exact count — call after a compaction prunes the conversation so
 *  the next gate check doesn't re-fire on the now-stale (pre-prune) large count. */
export function clearLastTurnTokens(conversationId: string): void {
  lastTurnExactTokens.delete(conversationId);
}

/**
 * Convert a raw offline estimate into a real-token-space figure for gating decisions.
 * Returns max(estimate × ESTIMATE_CORRECTION, last exact API tokens for this conversation).
 */
export function effectiveTotalTokens(rawEstimate: number, conversationId?: string): number {
  const corrected = Math.round(rawEstimate * ESTIMATE_CORRECTION);
  const lastExact = conversationId ? (lastTurnExactTokens.get(conversationId) ?? 0) : 0;
  return Math.max(corrected, lastExact);
}
