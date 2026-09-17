/**
 * The composer's two requests to the quote pill (`web/src/utils/selection-hold.ts`):
 * "hold your passage, I am about to take focus" and "the user sent, let go".
 *
 * Reported 2026-09-16: a word the reader had dragged over while reading became an
 * "asking about" chip when they dictated a question about something else. The chip
 * was the composer INFERRING a thread anchor from the selection at the moment the
 * dictated text landed. It no longer infers anything: it asks the pill to hold the
 * passage, and the chip is the pill's Ask button's to create.
 *
 * SCOPE: this file pins the request/answer contract, not the pill's behaviour. The
 * pill itself is exercised by tests/e2e/browser/session-voice-selection.spec.ts (a
 * real browser, real dictation) and session-voice-selection.webkit.spec.ts.
 *
 * DOM note: linkedom, as in selection-quote.test.ts. Its CustomEvent bubbles and
 * carries `detail` (verified), which is all this module relies on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  SELECTION_HOLD_EVENT, SELECTION_RELEASE_EVENT, releaseSelectionHold, requestSelectionHold,
  type SelectionHoldDetail,
} from '../../web/src/utils/selection-hold';

const { window, document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
Object.assign(globalThis, { window, document, CustomEvent: window.CustomEvent });

/** A panel root, the element the composer sends from. */
function panel(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'session-panel';
  document.body.appendChild(el);
  return el as unknown as HTMLElement;
}

const listeners: Array<{ type: string; fn: EventListener }> = [];
function listen(type: string, fn: EventListener): void {
  document.addEventListener(type, fn);
  listeners.push({ type, fn });
}

afterEach(() => {
  for (const { type, fn } of listeners.splice(0)) document.removeEventListener(type, fn);
  document.body.replaceChildren();
});

describe('requestSelectionHold', () => {
  it('answers false when no pill is listening — the composer just takes focus', () => {
    expect(requestSelectionHold(panel())).toBe(false);
  });

  it('answers false for no panel at all (not mounted yet)', () => {
    expect(requestSelectionHold(null)).toBe(false);
    expect(requestSelectionHold(undefined)).toBe(false);
  });

  it('returns what the pill wrote into the detail, synchronously', () => {
    listen(SELECTION_HOLD_EVENT, (e) => { (e as CustomEvent<SelectionHoldDetail>).detail.held = true; });
    expect(requestSelectionHold(panel())).toBe(true);
  });

  it('a pill with nothing to hold leaves the detail false', () => {
    listen(SELECTION_HOLD_EVENT, () => { /* saw it, had no passage */ });
    expect(requestSelectionHold(panel())).toBe(false);
  });

  it('bubbles from the panel with that element as the target — so a pill inside a different panel can tell it is not being asked', () => {
    const mine = panel();
    const theirs = panel();
    const asked: HTMLElement[] = [];
    listen(SELECTION_HOLD_EVENT, (e) => {
      asked.push(e.target as HTMLElement);
      if (e.target === mine) (e as CustomEvent<SelectionHoldDetail>).detail.held = true;
    });
    expect(requestSelectionHold(theirs)).toBe(false);
    expect(requestSelectionHold(mine)).toBe(true);
    expect(asked).toEqual([theirs, mine]);
  });
});

describe('releaseSelectionHold', () => {
  it('tells the pill inside THIS panel that the user sent', () => {
    const mine = panel();
    const released: EventTarget[] = [];
    listen(SELECTION_RELEASE_EVENT, (e) => { released.push(e.target!); });
    releaseSelectionHold(mine);
    expect(released).toEqual([mine]);
  });

  it('is a no-op without a panel', () => {
    let fired = 0;
    listen(SELECTION_RELEASE_EVENT, () => { fired++; });
    releaseSelectionHold(null);
    releaseSelectionHold(undefined);
    expect(fired).toBe(0);
  });
});
