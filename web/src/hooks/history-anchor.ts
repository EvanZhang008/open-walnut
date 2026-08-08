/**
 * Compute the identity anchor sent with `?since=` history deltas.
 *
 * The server can no longer trust a bare count: a `/compact` rewrite, the
 * retroactive subagent regrouping, or a whale session's 4 MiB SLIDING TAIL all
 * shift the parsed-message index space, and `messages.slice(since)` then omits the
 * newest messages (inc-1785993576822 — the user's own echo went missing, so their
 * bubble had no absorption evidence and stayed pinned at the bottom forever).
 *
 * So we send an identity too: the newest message we hold whose `msgId` is UNIQUE in
 * our own array, plus how many rows follow it. The server locates that id in its
 * current parse and slices after it. See src/core/history-delta.ts for the
 * resolution rules.
 */

export interface HistoryAnchor {
  anchorMsgId?: string;
  /** Rows the client holds after the anchor (id-less, or newer-but-ambiguous). */
  anchorTail: number;
}

/**
 * Newest unique-msgId anchor in `messages`.
 *
 * Uniqueness matters on BOTH sides: the server rebuilds when an anchor id appears
 * twice in its parse, so picking a duplicate here would force a pointless full
 * payload every turn. Scanning backwards for the newest unique id keeps the delta
 * path alive; if nothing qualifies we return no anchor and the server falls back to
 * the count (and refuses it outright for a windowed read).
 */
/**
 * msgIds of rows we hold an UNSETTLED copy of — to re-ask for on the next delta.
 *
 * The server stamps `unsettled` on rows whose content can still change (an Agent row
 * awaiting its late `bgTaskFinished`, a tool row awaiting its result). The CLIENT has to
 * drive the re-ask, because by the next delta the server's own row is already settled —
 * "re-send your unsettled rows" would send nothing, which is exactly the bug
 * (inc-1785965937858). Self-terminating: once we hold a settled copy the flag is gone
 * and we stop asking.
 *
 * Bounded to the newest `max` — the server refuses larger requests, and asking about a
 * hundred long-finished agents would just bloat every delta.
 */
export function collectUnsettledIds(
  messages: readonly { msgId?: string; unsettled?: boolean }[],
  max = 20,
): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    const m = messages[i];
    if (m.unsettled && m.msgId) out.push(m.msgId);
  }
  return out;
}

/**
 * Apply the server's revised prefix rows by identity (never by position).
 *
 * The delta's `messages` are APPENDED; `revisedMessages` REPLACE rows we already
 * hold. They exist because the synced prefix is not immutable: an Agent/Task row is
 * stamped `bgTaskFinished` from a task-notification the CLI appends up to a minute
 * later, so a client that synced before the agent finished held a frozen copy and its
 * lane blocks never gained absorption proof — a phantom Agent box at the bottom of
 * the timeline (inc-1785965937858).
 *
 * Returns the SAME array when nothing applied, so callers can skip a re-render.
 * A revision whose msgId we don't hold (or hold twice) is ignored: applying it
 * anywhere would be a guess, and the server already refuses to send ambiguous ones.
 */
export function applyRevisedMessages<T extends RevisableLike>(
  base: readonly T[],
  revised: readonly T[] | undefined,
): readonly T[] {
  if (!revised || revised.length === 0) return base;
  const held = new Map<string, { row: T; count: number }>();
  for (const m of base) {
    if (!m.msgId) continue;
    const hit = held.get(m.msgId);
    if (hit) hit.count++;
    else held.set(m.msgId, { row: m, count: 1 });
  }
  const byId = new Map<string, T>();
  for (const r of revised) {
    if (!r.msgId) continue;
    const hit = held.get(r.msgId);
    if (!hit || hit.count !== 1) continue;
    // Skip a revision that says nothing new. A tool whose result never lands (session
    // killed mid-call) stays unsettled forever, so the client keeps asking and the
    // server keeps answering with the identical row — without this check we would
    // hand React a fresh array every turn and re-render the whole history for nothing.
    if (!revisionChangesRow(hit.row, r)) continue;
    byId.set(r.msgId, r);
  }
  if (byId.size === 0) return base;
  return base.map(m => (m.msgId && byId.get(m.msgId)) || m);
}

interface RevisableLike {
  msgId?: string;
  unsettled?: boolean;
  tools?: { toolUseId?: string; result?: string; bgTaskFinished?: boolean }[];
}

/**
 * Whether a served revision differs from the copy we hold, in the fields that can
 * actually change late. Deliberately narrow — the same inputs the server's `unsettled`
 * predicate reads — so this stays O(tools) instead of deep-comparing 5 KB tool results.
 */
function revisionChangesRow(held: RevisableLike, next: RevisableLike): boolean {
  if (!!held.unsettled !== !!next.unsettled) return true;
  const a = held.tools ?? [];
  const b = next.tools ?? [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].toolUseId !== b[i].toolUseId) return true;
    if (!!a[i].bgTaskFinished !== !!b[i].bgTaskFinished) return true;
    if ((a[i].result === undefined) !== (b[i].result === undefined)) return true;
  }
  return false;
}

export function computeHistoryAnchor(messages: readonly { msgId?: string }[]): HistoryAnchor {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.msgId) counts.set(m.msgId, (counts.get(m.msgId) ?? 0) + 1);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].msgId;
    if (id && counts.get(id) === 1) {
      return { anchorMsgId: id, anchorTail: messages.length - 1 - i };
    }
  }
  return { anchorTail: 0 };
}
