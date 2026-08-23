/**
 * A card's receipt has to survive the reload, and belong to ONE message.
 *
 * The receipt is keyed entirely by the card id the parser derives, so these two
 * properties are decided together and can break in opposite directions:
 *
 *  - too WIDE a key and two different messages share a receipt: clicking the
 *    first renders the second already-settled over an op the user never ran.
 *    That is the residual the per-message `scope` closes.
 *  - too NARROW a key and the receipt is lost on reload: the button re-arms over
 *    an op that already ran. A scope that differs between the live render and the
 *    stored message would do exactly that, which is why the scope has to be a
 *    server-side id (the chat lane's turn uuid, the session lane's message uuid)
 *    and never anything the browser stamps.
 *
 * This file drives the real localStorage store (a fake Storage, same style as
 * crash-report.test.ts) so the round trip is the actual one, not a re-derivation
 * of the key.
 */
import { describe, it, expect, beforeEach } from 'vitest';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

const storage = new FakeStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true });
Object.defineProperty(globalThis, 'window', {
  value: { location: { search: '' }, localStorage: storage },
  writable: true,
  configurable: true,
});

const { splitSuggestSegments } = await import('@/utils/suggest-parse');
const { readCardRecord, recordCardAction, _clearSuggestCardStateForTest } = await import('@/utils/suggest-card-state');

const CARD = '<suggest title="Pin this task">'
  + '<action tool="task_pin_set" args=\'{"id":"t_1","pinned":true}\' label="Pin it" style="primary"/>'
  + '<action dismiss label="Ignore"/>'
  + '</suggest>';

/** The card id the renderer would use for this text under this scope. */
function cardId(text: string, scope?: string): string {
  const cards = splitSuggestSegments(text, scope).filter((s) => s.kind === 'card');
  expect(cards).toHaveLength(1);
  return (cards[0] as { card: { id: string } }).card.id;
}

beforeEach(() => {
  _clearSuggestCardStateForTest();
});

describe('suggest card receipts — scoped by a real per-message id', () => {
  // The message as the browser saw it stream, and as the server stored it. Same
  // bytes, which is the point: only the scope carries identity.
  const MESSAGE = `That task is not pinned yet.\n\n${CARD}`;

  it('survives a reload: the stored message re-derives the same key', () => {
    const live = cardId(MESSAGE, 'turn-a');
    recordCardAction(live, 'a0', 'ok', 'Pin it');

    // Reload: nothing in memory, the text comes back from chat history, the scope
    // comes back from the persisted entry.
    const reloaded = cardId(MESSAGE, 'turn-a');
    expect(reloaded).toBe(live);
    expect(readCardRecord(reloaded)?.actions).toEqual({ a0: 'ok' });
    expect(readCardRecord(reloaded)?.note).toBe('Pin it');
  });

  it('does NOT leak the receipt onto an identical card in another message', () => {
    recordCardAction(cardId(MESSAGE, 'turn-a'), 'a0', 'ok', 'Pin it');
    // Same suggestion, same preceding sentence, different turn: this is the case
    // that used to render pre-settled.
    expect(readCardRecord(cardId(MESSAGE, 'turn-b'))).toBeUndefined();
  });

  it('keeps a mid-turn click after the rest of the answer arrives', () => {
    // The card is clickable the moment its closer lands, so the key must already
    // be the finished message's key — a tail-dependent one would orphan it.
    const midTurn = cardId(MESSAGE, 'turn-a');
    recordCardAction(midTurn, 'a0', 'ok', 'Pin it');
    const settled = cardId(`${MESSAGE}\n\nTell me if you want it unpinned.`, 'turn-a');
    expect(readCardRecord(settled)?.actions).toEqual({ a0: 'ok' });
  });

  it('remembers a dismiss the same way', () => {
    const id = cardId(MESSAGE, 'turn-a');
    recordCardAction(id, 'a1', 'dismissed', 'Ignore');
    expect(readCardRecord(cardId(MESSAGE, 'turn-a'))?.actions).toEqual({ a1: 'dismissed' });
  });

  it('scopes the session lane by the message uuid the same way', () => {
    // Session cards use the JSONL/API message id, which rides both the live
    // stream deltas and the persisted history row — same contract, different id
    // space, so two sessions' identical answers stay independent.
    const a = cardId(MESSAGE, 'msg_01ABC');
    recordCardAction(a, 'a0', 'ok', 'Pin it');
    expect(readCardRecord(cardId(MESSAGE, 'msg_01ABC'))?.actions).toEqual({ a0: 'ok' });
    expect(readCardRecord(cardId(MESSAGE, 'msg_01XYZ'))).toBeUndefined();
  });

  it('still persists for a turn with no id at all (unscoped fallback)', () => {
    // Cron/heartbeat turns and mobile-initiated turns carry no id. Both sides of
    // the reload see `undefined`, so the older text-derived key must keep working
    // rather than degrade to "never remembered".
    const id = cardId(MESSAGE);
    recordCardAction(id, 'a0', 'ok', 'Pin it');
    expect(readCardRecord(cardId(MESSAGE))?.actions).toEqual({ a0: 'ok' });
  });
});
