/**
 * A background notice never starts a turn of its own (2026-10-30, the Walnut lead, the user agreeing:
 * about half of the lead's turns were an agent-ack to a notice that only said something moved).
 *
 * A notice that asks nothing of the session (a request past its deadline that stays open, its
 * reminder at twice the deadline) waits here and rides in front of the session's next message
 * (session-message-queue.ts sendMessageToSession), like the place note and the status push. Never
 * written into a running turn either: a line that reached the CLI as its turn ended started a turn
 * of its own (2026-10-30: two of Main's agent-ack turns were deadline notices 0.3 s after its last
 * words). What needs the session to act still wakes it: a reply it waits for, a request to it, an
 * error, a completed subtask to check. Two more ride here (2026-11-12): a subtask's completion
 * its reply already told (subtask-notices.ts), and a note that asks nothing (quiet-notes.ts),
 * folded per sender (holdFoldedNotice).
 * In memory: a restart drops what waits, and the request it was about is still listed as open
 * (open_items, the Brief).
 */
/** A held notice older than this is dropped unread: the live list has moved on. */
const HOLD_MAX_MS = 3 * 24 * 60 * 60_000;

interface Held {
  text: string;
  at: number;
  /** Still worth telling when the next message goes (a request still unanswered): else dropped. */
  validIf?: () => Promise<boolean>;
  /** A folded notice (holdFoldedNotice): every part held under its key, oldest first, and how it reads. */
  parts?: unknown[];
  /** Older parts FOLD_PARTS_MAX pushed out: the notice says how many. */
  dropped?: number;
  render?: (parts: unknown[], dropped: number) => string;
}

/** Most parts one folded notice keeps; older ones are dropped (the newest say where things stand). */
export const FOLD_PARTS_MAX = 12;

const held = new Map<string, Map<string, Held>>();

/** Hold `text` for the session's next message; a newer notice with the same key replaces it. */
export function holdNotice(
  sessionId: string, key: string, text: string, opts: { now?: number; validIf?: () => Promise<boolean> } = {},
): void {
  const slot = held.get(sessionId) ?? new Map<string, Held>();
  slot.set(key, { text, at: opts.now ?? Date.now(), ...(opts.validIf ? { validIf: opts.validIf } : {}) });
  held.set(sessionId, slot);
}

/**
 * Hold one more part of a folded notice: every part held under `key` reads as ONE notice,
 * `render(parts)`, oldest part first (2026-11-12, the org reflection: the load watchdog sent one
 * note per paused process, three in the same minute, each waking the session). A part that would
 * go past FOLD_PARTS_MAX pushes the oldest out.
 */
export function holdFoldedNotice<P>(
  sessionId: string, key: string, part: P, render: (parts: P[], dropped: number) => string, opts: { now?: number } = {},
): void {
  const slot = held.get(sessionId) ?? new Map<string, Held>();
  const prev = slot.get(key);
  const all = [...((prev?.parts as P[] | undefined) ?? []), part];
  const parts = all.slice(-FOLD_PARTS_MAX);
  const dropped = (prev?.dropped ?? 0) + all.length - parts.length;
  const draw = render as (parts: unknown[], dropped: number) => string;
  // Its age is its newest part's: a part added late is not dropped with the old ones.
  slot.set(key, { text: draw(parts, dropped), at: opts.now ?? Date.now(), parts, dropped, render: draw });
  held.set(sessionId, slot);
}

/** What waits for a session's next message, read without taking it (tests, the send's answer). */
export function heldNoticeKeys(sessionId: string): string[] {
  return [...(held.get(sessionId)?.keys() ?? [])];
}

/**
 * The notices waiting for a session's next message, taken out of the hold (so two sends at once
 * never both carry them), or null. `release` puts back what the message did not carry.
 */
export async function pendingHeldNotices(sessionId: string, now = Date.now()): Promise<{ text: string; release: () => void } | null> {
  const slot = held.get(sessionId);
  if (!slot) return null;
  held.delete(sessionId);
  const taken: Array<[string, Held]> = [];
  for (const [k, v] of slot) {
    if (now - v.at > HOLD_MAX_MS) continue;
    // A notice its own news overtook (the request got its reply) is dropped, never sent stale.
    if (v.validIf && !(await v.validIf().catch(() => true))) continue;
    taken.push([k, v]);
  }
  if (!taken.length) return null;
  return {
    text: taken.map(([, v]) => v.text).join('\n\n'),
    release: () => {
      const cur = held.get(sessionId) ?? new Map<string, Held>();
      // A newer notice of the same key that came meanwhile wins; a folded one keeps both parts' lists.
      for (const [k, v] of taken) {
        const now2 = cur.get(k);
        if (!now2) cur.set(k, v);
        else if (v.parts && now2.parts && now2.render) {
          const all = [...v.parts, ...now2.parts];
          const parts = all.slice(-FOLD_PARTS_MAX);
          const dropped = (v.dropped ?? 0) + (now2.dropped ?? 0) + all.length - parts.length;
          cur.set(k, { ...now2, parts, dropped, text: now2.render(parts, dropped) });
        }
      }
      held.set(sessionId, cur);
    },
  };
}

/** Test seam. */
export function _clearHeldNotices(): void {
  held.clear();
}
