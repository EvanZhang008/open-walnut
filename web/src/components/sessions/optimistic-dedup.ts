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
 *
 * Evidence passes, strongest first — a bubble is hidden only when one of them
 * PROVES history absorbed it:
 *   1. id-exact via echo-claim `walnutMessageId` (any scope, can't false-match)
 *   2. per-bubble text multiset within the watermark window
 *   3. id-anchored merged run: the id-bound line's OWN text reconstructed as the
 *      join of that bubble + the following unproven ones (the production shape —
 *      bindEchoClaims stamps qmIds[0] only, so 2..N have no id of their own)
 *   4. text-only merged run: the join of a contiguous run of unproven bubbles
 *      against the windowed multiset (works even with no id evidence at all)
 * No pass can ever remove a bubble history doesn't account for, so the failure
 * direction is a brief duplicate — never a vanished or permanently pinned one.
 */
export function dedupeOptimisticMessages<T extends OptimisticLike>(
  optimistic: readonly T[],
  messages: readonly PersistedLike[],
  prevMsgLen: number,
): T[] {
  // Id-first evidence: persisted user lines stamped with walnutMessageId are the
  // server-confirmed echoes of EXACTLY those bubbles. Exact ids can't
  // false-positive, so scan ALL messages (no window needed) — this also makes
  // the consume immune to the shrink/window edge cases below.
  // The line's TEXT is kept too, not just the id: for a merged batch that text is
  // the whole run's join, and it is the ONLY evidence bubbles 2..N will ever get.
  const persistedIdText = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'user' || !msg.walnutMessageId) continue;
    if (!persistedIdText.has(msg.walnutMessageId)) persistedIdText.set(msg.walnutMessageId, msg.text);
  }

  const scanStart = dedupScanStart(prevMsgLen, messages.length);
  const newUserTextCounts = new Map<string, number>();
  for (let i = scanStart; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      const t = messages[i].text;
      newUserTextCounts.set(t, (newUserTextCounts.get(t) ?? 0) + 1);
    }
  }

  // Pass 1 — per-bubble evidence. `state[i]` records WHICH evidence proved bubble
  // i, so the merged-run passes below know what is still open and what an
  // id-bound line can anchor. 'open' = nothing proved it yet (⇒ stays rendered).
  type Evidence = 'failed' | 'id' | 'text' | 'open';
  const state: Evidence[] = [];
  const idLine: Array<string | undefined> = [];
  for (const m of optimistic) {
    if (m.status === 'failed') { state.push('failed'); idLine.push(undefined); continue; }
    const line = m.queueId ? persistedIdText.get(m.queueId) : undefined;
    if (line !== undefined) { state.push('id'); idLine.push(line); continue; }
    idLine.push(undefined);
    const key = dedupKeyOf(m);
    const c = newUserTextCounts.get(key);
    if (c && c > 0) {
      newUserTextCounts.set(key, c - 1);
      state.push('text');
      continue;
    }
    state.push('open');
  }

  // ── Merged-batch passes (inc-1785888617044) ──
  // Several sends queued during one turn are drained by the CLI into a SINGLE
  // prompt, so history holds ONE user line = the messages joined together. No
  // individual bubble's text equals that line, and only qmIds[0] gets a
  // walnutMessageId — so pass 1 proves NOTHING for the rest and they stayed
  // pinned at the bottom forever (3 stuck bubbles, exactly reproduced).
  // Separators: '\n' is the CLI's own queue-drain form (the observed one); '\n\n'
  // is walnut's delivery form — accept both, cheapest possible over-coverage.
  // Run cap and the '\n' rule mirror the block-side join-run in promote-blocks.ts.
  const SEPARATORS = ['\n', '\n\n'];
  const MAX_RUN = 8;

  // Pass 3 — id-anchored run. The bound line IS the merged prompt, so reconstructing
  // it exactly from [anchor, …following open bubbles] is server-grade proof for the
  // whole run. This is the shape production actually produces; without it the batch's
  // 2..N bubbles are orphaned forever.
  //
  // It MUST still retire the line from the windowed multiset (`claimLine` below).
  // Skipping that looks harmless — the id already proved this batch — but it lets
  // pass 4 match the SAME persisted line again for a second, identical batch whose
  // messages are NOT in history yet, hiding live sends. Verified: with 1 merged line
  // and 2 identical 3-message batches on screen, all 6 bubbles disappeared instead
  // of 3. One persisted line accounts for exactly one batch.
  const claimLine = (line: string) => {
    // Only lines INSIDE the scan window are in the multiset. An id-bound line from
    // outside it has no entry — nothing to retire, and pass 4 can't reach it either.
    const n = newUserTextCounts.get(line);
    if (n && n > 0) newUserTextCounts.set(line, n - 1);
  };
  for (let i = 0; i < optimistic.length; i++) {
    if (state[i] !== 'id') continue;
    const raw = idLine[i];
    const line = raw?.trim();
    if (!line || !line.includes('\n')) continue; // single-message echo — nothing to extend
    const texts = [dedupKeyOf(optimistic[i])];
    for (let j = i + 1; j < optimistic.length && texts.length < MAX_RUN; j++) {
      if (state[j] !== 'open') break; // contiguity: a proven bubble ends the run
      texts.push(dedupKeyOf(optimistic[j]));
      if (SEPARATORS.some(sep => texts.join(sep).trim() === line)) {
        for (let k = i + 1; k <= j; k++) state[k] = 'id';
        claimLine(raw as string); // key the multiset by the RAW text, as built above
        break;
      }
    }
  }

  // Pass 4 — text-only run: no id survived (registry lost on restart, or the
  // claim never bound), so prove the batch from the windowed multiset alone.
  for (let i = 0; i < optimistic.length; i++) {
    if (state[i] !== 'open') continue;
    const texts = [dedupKeyOf(optimistic[i])];
    for (let j = i + 1; j < optimistic.length && texts.length < MAX_RUN; j++) {
      if (state[j] !== 'open') break;
      texts.push(dedupKeyOf(optimistic[j]));
      let hit = false;
      for (const sep of SEPARATORS) {
        const joined = texts.join(sep);
        const n = newUserTextCounts.get(joined);
        if (n && n > 0) { newUserTextCounts.set(joined, n - 1); hit = true; break; }
      }
      if (hit) {
        for (let k = i; k <= j; k++) state[k] = 'text';
        i = j; // resume scanning after this run
        break;
      }
    }
  }

  return optimistic.filter((_, i) => state[i] === 'failed' || state[i] === 'open');
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
