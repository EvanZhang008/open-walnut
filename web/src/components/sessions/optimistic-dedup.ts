/**
 * Optimistic-message dedup against persisted history — extracted pure so the
 * window rules are unit-testable (same pattern as cache/snapshot-adoption.ts).
 *
 * Normal turn: scan only NEWLY APPEARED persisted messages
 * [prevMsgLen, messages.length) — scanning all history falsely matched a new
 * "hi" against an old "hi" (the original Pattern A bug).
 *
 * Shrink (messages.length < prevMsgLen): /compact (or file rotation) rewrote
 * history — 4792 messages became 438. The old window start points past the end
 * of the array, so the window is EMPTY FOREVER and delivered optimistic
 * bubbles can never match their persisted twins: they stay pinned at the
 * bottom, below newer content, in the wrong chronological order
 * (inc-1783472776601 "my message stuck at the bottom even after new input").
 * On shrink the whole rewritten array IS the new truth — scan all of it.
 * (Trade-off: an identical-text message from an older turn may consume the
 * optimistic entry early; benign — the message is delivered and persisted,
 * only the grey bubble disappears sooner. Stuck-forever is strictly worse.)
 */

/** Minimal shapes — structural, so the component's richer types just fit. */
interface PersistedLike {
  role: string;
  text: string;
  /** Server echo-claim binding (Phase 1, ACP dialect): the walnut `qm-…` id
   *  stamped onto the canonical user-echo line by bindEchoClaims(). When it
   *  matches an optimistic bubble's queueId, that bubble is consumed by EXACT
   *  id — immune to the text-window pitfalls below. */
  walnutMessageId?: string;
}
interface OptimisticLike {
  text: string;
  status: string;
  /** qm-… once the send RPC resolved; client tempId before that. */
  queueId?: string;
  /** Text the server actually enqueued, when it differs from `text` (image refs
   *  prepended). Persisted history echoes THIS, so it is the correct dedup key —
   *  see `dedupKeyOf`. */
  dedupText?: string;
}

/** The text to match against persisted history. Prefers the server-reported
 *  enqueued text (`dedupText`) over the user-visible `text`: with attachments the
 *  server prepends `[Images attached …]` + paths before handing the message to
 *  the CLI, so history's echo never equals what the user typed. Without this the
 *  bubble is unmatchable and stays pinned below newer content until a manual
 *  refresh (inc-1785091339102). */
function dedupKeyOf(m: OptimisticLike): string {
  return m.dedupText ?? m.text;
}
interface QueuedOptimisticLike extends OptimisticLike {
  queueId: string;
}

/** Window start for the dedup scan. Exported for direct edge-case tests. */
export function dedupScanStart(prevMsgLen: number, messagesLen: number): number {
  if (messagesLen < prevMsgLen) return 0; // shrink: rewritten history, scan all
  return Math.max(0, prevMsgLen);
}

/**
 * Filter out optimistic messages whose persisted twin appears in the scan
 * window. Multiset semantics: two optimistic "hi" consume two persisted "hi".
 * Failed messages are never consumed (the backend never got them).
 */
export function dedupeOptimisticMessages<T extends OptimisticLike>(
  optimistic: readonly T[],
  messages: readonly PersistedLike[],
  prevMsgLen: number,
): T[] {
  // Id-first pass: persisted user lines stamped with walnutMessageId are the
  // server-confirmed echoes of EXACTLY those bubbles. Exact ids can't
  // false-positive, so scan ALL messages (no window needed) — this also makes
  // the consume immune to the shrink/window edge cases below.
  const persistedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'user' && msg.walnutMessageId) persistedIds.add(msg.walnutMessageId);
  }

  const scanStart = dedupScanStart(prevMsgLen, messages.length);
  const newUserTextCounts = new Map<string, number>();
  for (let i = scanStart; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      const t = messages[i].text;
      newUserTextCounts.set(t, (newUserTextCounts.get(t) ?? 0) + 1);
    }
  }

  return optimistic.filter(m => {
    if (m.status === 'failed') return true;
    if (m.queueId && persistedIds.has(m.queueId)) return false;
    const key = dedupKeyOf(m);
    const c = newUserTextCounts.get(key);
    if (c && c > 0) {
      newUserTextCounts.set(key, c - 1);
      return false;
    }
    return true;
  });
}

// ── Phase 1 (ACP dialect): id-first batch consumption ────────────────────────
// SESSION_BATCH_COMPLETED / SESSION_MESSAGES_DELIVERED now carry the batch's
// `qm-…` messageIds. These pure helpers implement "exactly these bubbles" with
// the historical count semantics as fallback — extracted from useSessionSend so
// the window/no-loss rules stay unit-testable.

/**
 * Remove the bubbles a completed batch consumed.
 * Id path: remove exactly the id-matched bubbles, regardless of status — the id
 * is server proof of consumption even if the 'delivered' transition was missed.
 * Fallback (no ids, or none matched because bubbles still carry client tempIds):
 * remove the first `count` DELIVERED bubbles only (no-loss guard — a spurious
 * count can never delete a message the CLI never received).
 */
export function removeBatchMessages<T extends QueuedOptimisticLike>(
  optimistic: readonly T[],
  count: number,
  messageIds?: readonly string[],
): T[] {
  const idSet = new Set(messageIds ?? []);
  if (idSet.size > 0 && optimistic.some(m => idSet.has(m.queueId))) {
    return optimistic.filter(m => !idSet.has(m.queueId));
  }
  let remaining = count;
  return optimistic.filter(m => {
    if (m.status !== 'delivered') return true;
    if (remaining > 0) {
      remaining--;
      return false;
    }
    return true;
  });
}

/**
 * Mark the bubbles a delivery consumed as 'delivered'.
 * Id path marks exactly the matched pending/received bubbles; if none matched
 * (tempId race), the count fallback marks the first N pending/received.
 */
export function markDeliveredMessages<T extends QueuedOptimisticLike>(
  optimistic: readonly T[],
  count: number,
  messageIds?: readonly string[],
): T[] {
  const idSet = new Set(messageIds ?? []);
  let idMatched = 0;
  const afterIds = optimistic.map(m => {
    if (m.status !== 'pending' && m.status !== 'received') return m;
    if (idSet.has(m.queueId)) {
      idMatched++;
      return { ...m, status: 'delivered' };
    }
    return m;
  });
  if (idMatched > 0) return afterIds;
  let remaining = count;
  return optimistic.map(m => {
    if (remaining > 0 && (m.status === 'pending' || m.status === 'received')) {
      remaining--;
      return { ...m, status: 'delivered' };
    }
    return m;
  });
}
