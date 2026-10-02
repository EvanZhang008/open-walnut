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

import { typedUserText } from './injected-banner';

/** Minimal shapes — structural, so the component's richer types just fit. */
interface PersistedLike {
  role: string;
  text: string;
  /** When the CLI wrote the row (its own clock). The time coordinate survives
   *  everything the index does not: a window swap, a shrink, a front insertion. */
  timestamp?: string;
  /** Server echo-claim binding (Phase 1, ACP dialect): the walnut `qm-…` id
   *  stamped onto the canonical user-echo line by bindEchoClaims(). When it
   *  matches an optimistic bubble's queueId, that bubble is consumed by EXACT
   *  id — immune to the text-window pitfalls below. */
  walnutMessageId?: string;
  /** Skill dumps / image metadata the CLI writes next to a prompt: never a prompt. */
  injected?: boolean;
}
interface OptimisticLike {
  text: string;
  status: string;
  /** When the send was enqueued: the server's `enqueuedAt` once known, else the
   *  client clock at send time. The bubble's row can only ever be AT OR AFTER
   *  this instant (minus clock slack), whatever index it lands at. */
  timestamp?: string;
  /** The session's launch prompt (see launchRowIndex). */
  launch?: boolean;
  /** qm-… once the send RPC resolved; client tempId before that. */
  queueId?: string;
  /** Text the server actually enqueued, when it differs from `text` (image refs
   *  prepended). Persisted history echoes THIS, so it is the correct dedup key —
   *  see `dedupKeyOf`. */
  dedupText?: string;
}

/**
 * Backward clock slack between the bubble's enqueue time (walnut's clock) and the
 * row's timestamp (the CLI host's clock). Delivery puts the row AFTER the enqueue
 * (measured 0.3–0.5 s later on a remote host), so only clock drift can make it
 * look earlier, and NTP keeps that under a second. A row older than this can
 * never be the bubble's twin. Kept SMALL on purpose: every second of slack is a
 * second in which an identical earlier send ("ok", "go on") could absorb the new
 * bubble early. A host whose clock drifts past it only loses the time path and
 * falls back to the index window, never worse than before.
 */
export const BUBBLE_CLOCK_SLACK_MS = 10_000;

function tsMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * A delivered bubble whose row can only sit ABOVE the loaded window.
 *
 * The client often holds a tail window, not the whole transcript (a cold read
 * after a server restart is byte-bounded, and later deltas only append). A row
 * written before the window's first row is never loaded, so no text pass can
 * ever find it, and the bubble stayed pinned under every later turn until a
 * reload (which drops it, because the server removed the queue row at
 * delivery). The CLI writes the row within moments of delivery, so a bubble
 * enqueued well before the window head has its row above the window — the same
 * position reasoning the launch bubble uses. Only `delivered` qualifies: a
 * pending/received bubble has not reached the CLI and may still have no row at
 * all. Undefined when the history starts at the beginning or has no dated head.
 */
export function windowHeadMs(messages: readonly PersistedLike[], historyFromStart: boolean): number | undefined {
  if (historyFromStart) return undefined;
  for (const m of messages) {
    const ms = tsMs(m.timestamp);
    if (ms !== undefined) return ms;
  }
  return undefined;
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

/**
 * Where history holds a launch prompt: its first typed user row.
 *
 * A launch bubble cannot be matched by text or by window. Its text is the
 * human's words while the row may carry what Walnut wrapped around them (an
 * image preamble, a repair briefing, a spill pointer), and it can arrive after
 * the watermark has already moved past its row (a panel opened once the line had
 * landed). Position is exact instead: the CLI writes a session's launch prompt
 * before any other user line, so the first one IS it. -1 while none has landed.
 */
export function launchRowIndex(messages: readonly PersistedLike[]): number {
  return messages.findIndex((m) => m.role === 'user' && !m.injected && typedUserText(m.text).trim().length > 0);
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
 *   5. above the loaded window: a delivered bubble enqueued before the first
 *      loaded row (by more than the clock slack), whose row therefore sits in
 *      the unloaded head of a tail window
 * Passes 2–4 reach a row by INDEX (at or past the watermark) or by TIME (below
 * the watermark but not older than the bubble's enqueue): the index window
 * alone stranded a bubble whenever its row landed under a watermark that had
 * already moved, or the array was swapped for a tail window.
 * No pass can ever remove a bubble history doesn't account for, so the failure
 * direction is a brief duplicate — never a vanished or permanently pinned one.
 */
export function dedupeOptimisticMessages<T extends OptimisticLike>(
  optimistic: readonly T[],
  messages: readonly PersistedLike[],
  prevMsgLen: number,
  /** false when `messages` is a tail window with older rows unloaded: the
   *  launch row then sits before it (see launchRowIndex). */
  { historyFromStart = true }: { historyFromStart?: boolean } = {},
): T[] {
  // This runs on every render of the timeline; with nothing to absorb there is
  // nothing to index, and that is the state a whale session sits in most of the time.
  if (optimistic.length === 0) return [];

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
  // The oldest instant any bubble on screen could have a row at. Rows below the
  // watermark that are older than this can prove nothing, so they are never
  // indexed: in a whale session that is nearly all of them.
  let minFloorMs: number | undefined;
  for (const m of optimistic) {
    const ms = tsMs(m.timestamp);
    if (ms !== undefined && (minFloorMs === undefined || ms < minFloorMs)) minFloorMs = ms;
  }
  const datedCutoffMs = minFloorMs === undefined ? undefined : minFloorMs - BUBBLE_CLOCK_SLACK_MS;
  // Walnut PREPENDS machine banners to some sends ("[Conversation context]…",
  // lane-turn.ts), so the persisted echo is banner + typed text while the bubble
  // holds only what the human typed — no text pass can ever match it. The id path
  // above covers the normal delivery, but it is the ONLY thing that does, and the
  // registry is in-memory: a server restart drops the claim and this used to leave
  // the user looking at two copies of their own message.
  //
  // So each banner-carrying row is ALSO indexed by its peeled text, as an ALIAS of
  // the key it already lives under — never as a second entry. Consuming through the
  // alias decrements the row's own count, so one persisted row still accounts for
  // exactly one bubble, which is the multiset invariant every pass below rests on.
  // For a row with no banner the peel is identical to the text, `peeledToRaw` stays
  // empty, and dedup behaves byte-for-byte as it did before.
  //
  // Two multisets, one per coordinate. `windowed` holds the rows at or past the
  // index watermark (the turn's own rows). `dated` holds the rows BEFORE it, each
  // with its timestamp, for bubbles that know when they were enqueued: a row that
  // landed below the watermark is still that bubble's twin when it is not older
  // than the enqueue. The watermark moves on a turn start and is re-seeded on a
  // window swap, and both have stranded rows under it while their bubbles stayed
  // "Delivered" at the bottom of the timeline (inc-1790922678361: a server restart
  // mid-turn swapped the array for a tail window). A row can only be consumed once
  // whichever multiset it sits in.
  const newUserTextCounts = new Map<string, number>();
  const datedRows = new Map<string, number[]>();
  const peeledToRaw = new Map<string, string[]>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    const t = messages[i].text;
    if (i >= scanStart) {
      newUserTextCounts.set(t, (newUserTextCounts.get(t) ?? 0) + 1);
    } else {
      if (datedCutoffMs === undefined) continue; // no bubble carries a clock: index only
      const ms = tsMs(messages[i].timestamp);
      if (ms === undefined || ms < datedCutoffMs) continue; // undated or too old to be anyone's twin
      const list = datedRows.get(t);
      if (list) list.push(ms);
      else datedRows.set(t, [ms]);
    }
    const peeled = typedUserText(t);
    // A banner-ONLY row peels to '' — it holds nothing a human typed, so it must
    // never be able to account for a bubble.
    if (peeled && peeled !== t) {
      const raws = peeledToRaw.get(peeled);
      if (raws) { if (!raws.includes(t)) raws.push(t); }
      else peeledToRaw.set(peeled, [t]);
    }
  }

  /** Consume one row of exactly this raw text from the windowed multiset. */
  const takeWindowed = (raw: string): boolean => {
    const n = newUserTextCounts.get(raw);
    if (n && n > 0) {
      newUserTextCounts.set(raw, n - 1);
      return true;
    }
    return false;
  };
  /** Consume one row of this raw text written at or after `floorMs` (minus slack). */
  const takeDated = (raw: string, floorMs: number): boolean => {
    const list = datedRows.get(raw);
    if (!list) return false;
    const k = list.findIndex((ms) => ms >= floorMs - BUBBLE_CLOCK_SLACK_MS);
    if (k < 0) return false;
    list.splice(k, 1);
    return true;
  };

  /**
   * Consume one persisted row matching `key`, by its own text or via a banner peel.
   * Rows inside the index window qualify unconditionally; rows below it qualify
   * only when the bubble's enqueue time is known and the row is not older than it.
   * The dated rows are tried first: they are filtered by THIS bubble's clock, so
   * they are the tighter evidence, and taking one leaves the shared window for a
   * later bubble whose own row may only be there. Returns false when neither can
   * account for it — the caller must then leave the bubble on screen.
   */
  const takeText = (key: string, floorMs?: number): boolean => {
    const raws = [key, ...(peeledToRaw.get(key) ?? [])];
    if (floorMs !== undefined) {
      for (const raw of raws) if (takeDated(raw, floorMs)) return true;
    }
    for (const raw of raws) if (takeWindowed(raw)) return true;
    return false;
  };

  // Pass 1 — per-bubble evidence. `state[i]` records WHICH evidence proved bubble
  // i, so the merged-run passes below know what is still open and what an
  // id-bound line can anchor. 'open' = nothing proved it yet (⇒ stays rendered).
  type Evidence = 'failed' | 'id' | 'text' | 'window' | 'open';
  const state: Evidence[] = [];
  const idLine: Array<string | undefined> = [];
  const floorOf = (m: OptimisticLike): number | undefined => tsMs(m.timestamp);

  // Launch prompt: absorbed by position (launchRowIndex), and that row is retired
  // from the multisets FIRST, so a later send with the same words cannot be
  // hidden by the launch's row while its own is still on the way. A tail
  // window's first user row is some later message: the launch row is above the
  // window, and the panel's Initial Prompt row stands for it.
  const launchAt = optimistic.findIndex((m) => m.launch && m.status !== 'failed');
  const launchRow = launchAt >= 0 && historyFromStart ? launchRowIndex(messages) : -1;
  if (launchRow >= scanStart) takeWindowed(messages[launchRow].text);
  else if (launchRow >= 0) {
    const ms = tsMs(messages[launchRow].timestamp);
    const list = ms === undefined ? undefined : datedRows.get(messages[launchRow].text);
    const k = list?.indexOf(ms as number) ?? -1;
    if (list && k >= 0) list.splice(k, 1);
  }
  const launchAbsorbed = !historyFromStart || launchRow >= 0;

  for (const [i, m] of optimistic.entries()) {
    if (m.status === 'failed') { state.push('failed'); idLine.push(undefined); continue; }
    if (m.launch) { state.push(i === launchAt && launchAbsorbed ? 'text' : 'open'); idLine.push(undefined); continue; }
    const line = m.queueId ? persistedIdText.get(m.queueId) : undefined;
    if (line !== undefined) { state.push('id'); idLine.push(line); continue; }
    idLine.push(undefined);
    if (takeText(dedupKeyOf(m), floorOf(m))) {
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
  const claimLine = (line: string, floorMs: number | undefined) => {
    // Only lines inside the index window, or dated at/after the anchor's enqueue,
    // are in a multiset. An id-bound line from elsewhere has no entry — nothing to
    // retire, and pass 4 can't reach it either.
    takeText(line, floorMs);
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
        claimLine(raw as string, floorOf(optimistic[i])); // key the multiset by the RAW text, as built above
        break;
      }
    }
  }

  // Pass 4 — text-only run: no id survived (registry lost on restart, or the
  // claim never bound), so prove the batch from the multisets alone. The run's
  // floor is its FIRST bubble's enqueue: the merged line is written when the
  // batch is drained, after every member was enqueued.
  for (let i = 0; i < optimistic.length; i++) {
    if (state[i] !== 'open') continue;
    const texts = [dedupKeyOf(optimistic[i])];
    for (let j = i + 1; j < optimistic.length && texts.length < MAX_RUN; j++) {
      if (state[j] !== 'open') break;
      texts.push(dedupKeyOf(optimistic[j]));
      let hit = false;
      for (const sep of SEPARATORS) {
        // takeText, so a merged batch delivered behind a banner is provable too:
        // the row peels to the same join the bubbles reconstruct.
        if (takeText(texts.join(sep), floorOf(optimistic[i]))) { hit = true; break; }
      }
      if (hit) {
        for (let k = i; k <= j; k++) state[k] = 'text';
        i = j; // resume scanning after this run
        break;
      }
    }
  }

  // Pass 5 — above the loaded window. No row proved the bubble, but the client
  // holds only a tail whose first row is newer than the bubble's enqueue by more
  // than the clock slack: the row the CLI wrote at delivery sits above what is
  // loaded, where no text pass can see it. A delivered bubble in that position
  // is accounted for the way the launch bubble is, by position. Nothing else
  // qualifies: pending/received never reached the CLI, and inside the window a
  // missing row is a real mismatch that must stay visible.
  const headMs = windowHeadMs(messages, historyFromStart);
  if (headMs !== undefined) {
    for (let i = 0; i < optimistic.length; i++) {
      if (state[i] !== 'open' || optimistic[i].status !== 'delivered' || optimistic[i].launch) continue;
      const ms = floorOf(optimistic[i]);
      if (ms !== undefined && ms + BUBBLE_CLOCK_SLACK_MS < headMs) state[i] = 'window';
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
