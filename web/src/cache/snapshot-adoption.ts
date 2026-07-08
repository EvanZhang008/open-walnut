/**
 * Decide whether a server stream-buffer snapshot may REPLACE the local
 * streaming blocks (useSessionStream mount-subscribe path).
 *
 * Pure function so the rules are unit-testable — this decision has caused two
 * opposite production bugs and must never regress in either direction:
 *
 *  - Adopting too eagerly wiped content: an EMPTY server buffer carries zero
 *    information (turn-end clear, idle prune, server restart — NOT "this
 *    content shouldn't render"). Adopting it erased blocks the
 *    evidence-promoter had deliberately KEPT (no twin in history yet) — the
 *    "reply visible while streaming, gone when done" incident
 *    (inc-1783357192826).
 *
 *  - Never adopting left stale duplicates: a cache seeded from a finished
 *    turn renders next to the same content in history FOREVER (no new delta
 *    ever arrives to evidence-promote it away). When NEITHER side is live,
 *    a NON-EMPTY server buffer is authoritative.
 */
export function shouldAdoptSnapshot(opts: {
  /** Local block count currently rendered. */
  prevLen: number;
  /** Block count in the just-arrived server snapshot. */
  snapshotLen: number;
  /** Server-side isStreaming flag from the snapshot. */
  snapshotIsStreaming: boolean;
  /** Local live-turn flag (isStreamingRef). */
  localIsStreaming: boolean;
  /** Monotonic server buffer mutation counter from the snapshot (Phase 1,
   *  ACP dialect). 0 = no buffer server-side; undefined = pre-seq server. */
  snapshotSeq?: number;
  /** The seq recorded when this client last ADOPTED a snapshot for this
   *  session. Undefined = never adopted (or pre-seq). */
  lastAdoptedSeq?: number;
}): boolean {
  const { prevLen, snapshotLen, snapshotIsStreaming, localIsStreaming, snapshotSeq, lastAdoptedSeq } = opts;
  if (prevLen === 0) return true; // initial load — nothing to lose
  if (snapshotLen === 0) return false; // empty buffer = zero information — never wipe
  const bothIdle = !snapshotIsStreaming && !localIsStreaming;
  if (!bothIdle) return false; // a live turn on either side keeps local blocks
  // Seq comparison (both sides know their seq): a total order on the server
  // buffer's states — no more guessing freshness from block-array lengths.
  if (snapshotSeq != null && snapshotSeq > 0 && lastAdoptedSeq != null) {
    if (snapshotSeq === lastAdoptedSeq) return false; // byte-identical to what we adopted — zero churn
    if (snapshotSeq > lastAdoptedSeq) return true;    // server mutated since — adopt EVEN at equal lengths
    // snapshotSeq < lastAdoptedSeq: buffer was recreated (prune/restart, seq
    // restarted at 1) — a different generation; fall through to length rules.
  }
  if (prevLen === snapshotLen) return false; // identical-ish — avoid churn (legacy/pre-seq)
  return true; // both idle, different non-empty content → server buffer wins
}
