/**
 * "Already clicked" state for `<suggest>` action cards.
 *
 * Why localStorage and not a new server store: the card's identity is derived
 * from the message text (see suggest-parse.ts), which is already durable in chat
 * history, so all that has to survive a reload is a tiny verdict per button. One
 * `open-walnut-*` key gets that for free — ui-prefs-sync mirrors the whole
 * prefix to WALNUT_HOME/config/share/ui-prefs.json, so the receipts also follow
 * the user to another browser or device with zero new server code.
 *
 * Two hard limits come from that mirror: values are capped at 8KB and merged
 * last-writer-wins per key, so the map is bounded to the newest MAX_CARDS
 * entries and every note is truncated. Losing an old receipt is harmless (the
 * card just re-arms); exceeding the cap would silently stop syncing everything.
 */

import { log } from '@/utils/log';
import type { InvokeErrorCode } from '@/api/actions';

const STORE_KEY = 'open-walnut-suggest-cards';
const MAX_CARDS = 120;
const MAX_NOTE_CHARS = 120;
/** Stay clear of the 8KB ui-prefs value cap even with long-ish notes. */
const MAX_SERIALIZED_BYTES = 7000;

export type ActionVerdict = 'ok' | 'error' | 'dismissed' | 'unknown_tool';

/**
 * What a FAILED invoke should persist, or `null` for "record nothing, stay armed".
 *
 * Only a code that is true of the CARD itself may settle a button for good: an
 * unknown or non-invocable tool name, or args the op could never accept. Those
 * can only fail again, so re-arming them is how zombie cards happen.
 *
 * Everything else is about the attempt, not the card — network, timeout, the op's
 * own refusal, and notably `not_supported_cloud`, which only means "you clicked
 * this on the cloud replica". Persisting that one was worse than losing it: the
 * receipt map is mirrored to WALNUT_HOME/config/share/ui-prefs.json, so a 501
 * from the replica would sync a permanently dead receipt onto the Mac, where the
 * very same button works.
 */
export function terminalVerdict(code: InvokeErrorCode): ActionVerdict | null {
  if (code === 'unknown_tool' || code === 'not_invocable') return 'unknown_tool';
  if (code === 'invalid_arguments') return 'error';
  return null;
}

export interface CardRecord {
  /** Last write, ms epoch — the eviction order. */
  at: number;
  /** actionId → what happened. */
  actions: Record<string, ActionVerdict>;
  /** Short result/error text, shown as the card's inline receipt. */
  note?: string;
}

interface StoreShape {
  v: 1;
  cards: Record<string, CardRecord>;
}

const EMPTY: StoreShape = { v: 1, cards: {} };

function load(): StoreShape {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { v: 1, cards: {} };
    const parsed: unknown = JSON.parse(raw);
    const cards = (parsed as StoreShape | null)?.cards;
    if (!cards || typeof cards !== 'object' || Array.isArray(cards)) return { v: 1, cards: {} };
    return { v: 1, cards: cards as Record<string, CardRecord> };
  } catch {
    // Corrupt or blocked storage: start fresh rather than throwing into a render.
    return { v: 1, cards: {} };
  }
}

/** Drop the oldest entries until the payload fits both budgets. */
function prune(store: StoreShape): string {
  const ids = Object.keys(store.cards).sort((a, b) => (store.cards[b]?.at ?? 0) - (store.cards[a]?.at ?? 0));
  for (const id of ids.slice(MAX_CARDS)) delete store.cards[id];

  let serialized = JSON.stringify(store);
  let kept = Math.min(ids.length, MAX_CARDS);
  while (serialized.length > MAX_SERIALIZED_BYTES && kept > 1) {
    kept -= 1;
    delete store.cards[ids[kept]];
    serialized = JSON.stringify(store);
  }
  return serialized;
}

/** Everything recorded for one card, or undefined when it has never been used. */
export function readCardRecord(cardId: string): CardRecord | undefined {
  return load().cards[cardId];
}

/**
 * Record one button's outcome. Idempotent per (card, action): a second write
 * simply overwrites, which is what a `sticky` card wants.
 */
export function recordCardAction(
  cardId: string,
  actionId: string,
  verdict: ActionVerdict,
  note?: string,
): CardRecord {
  const store = load();
  const existing = store.cards[cardId];
  const record: CardRecord = {
    at: Date.now(),
    actions: { ...(existing?.actions ?? {}), [actionId]: verdict },
    ...(note ? { note: note.slice(0, MAX_NOTE_CHARS) } : existing?.note ? { note: existing.note } : {}),
  };
  store.cards[cardId] = record;
  try {
    localStorage.setItem(STORE_KEY, prune(store));
  } catch (err) {
    // Quota / private mode: the click still executed, only the receipt is lost.
    log.warn('chat', 'suggest card state not persisted', {
      cardId,
      actionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return record;
}

/** Test hook: forget every receipt. */
export function _clearSuggestCardStateForTest(): void {
  try { localStorage.removeItem(STORE_KEY); } catch { /* nothing to clear */ }
}
