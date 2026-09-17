/**
 * The ONE answer to "what passage is selected in a timeline?" — the quote pill's
 * helpers (`web/src/utils/selection-quote.ts`), including the predicates the pill
 * uses while HOLDING a passage after voice input took the composer's focus.
 *
 * Reported 2026-09-10: "I select text, use voice to text, and the selection gets
 * deselected." The press was fixed where it happened (main.tsx opts the mic out of
 * its instant clear), but no fix can hold a selection through a focus move — so the
 * pill keeps the passage it captured and paints it from the side. (Between 09-10 and
 * 09-16 the passage was carried into the composer's thread anchor instead; a word
 * dragged over while reading became an "asking about" chip nobody asked for, so
 * nothing is inferred from a selection any more.)
 *
 * SCOPE, so nobody reads more into a green run than it means: this file pins the
 * HELPERS, not the fix. Which passages can be asked about (`canAnchorQuote`), when a
 * selection or a held Range has scrolled out of reach (`selectionVisibleIn`,
 * `rangeVisibleIn`), and what counts as the user WRITING rather than moving on
 * (`targetInEditable`, `selectionInEditable`). Revert the press opt-out or the hold
 * request and this file still passes; what fails then is
 * tests/e2e/browser/session-voice-selection.spec.ts, which drives a real browser and
 * is where the fix itself is red-checked.
 *
 * DOM note: the node tiers have no jsdom, so the tree comes from linkedom (already
 * in the repo, same choice as tests/web/notes-roundtrip/dom-setup.ts). Two gaps in
 * it, and what they mean here:
 *  · its `Range` has no `setStart`/`setEnd`. Harmless — `quoteFromRange` reads only
 *    the four boundary properties for a text-node selection, so the ranges below are
 *    plain boundary objects over REAL linkedom text nodes;
 *  · its `createTreeWalker` IGNORES the filter's `acceptNode` (verified: a `<style>`
 *    text node walks straight through). So nothing in this file may depend on the
 *    index SKIPPING chrome — every fixture below is plain prose, where the walked
 *    text is identical either way. The skip rules belong to the Playwright layer,
 *    which runs a real browser.
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  canAnchorQuote, captureSelectionQuote, rangeVisibleIn, selectionBody, selectionInEditable,
  selectionVisibleIn, targetInEditable,
} from '../../web/src/utils/selection-quote';

const { window, document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
// The production code reads these off globals. linkedom exposes no `NodeFilter`, so
// the walker constants come from the DOM spec.
Object.assign(globalThis, {
  window,
  document,
  Node: window.Node,
  NodeFilter: { SHOW_TEXT: 0x4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
});

/** One timeline containing the rows a test needs. Returns the scroll container. */
function timeline(html: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'session-history';
  container.innerHTML = html;
  document.body.replaceChildren(container);
  return container as unknown as HTMLElement;
}

/** A selection over one text node, the shape a drag inside a paragraph produces. */
function selectionOver(node: unknown, start: number, end: number): Selection {
  const text = node as Text;
  const range = { startContainer: text, startOffset: start, endContainer: text, endOffset: end };
  return {
    isCollapsed: start === end,
    rangeCount: 1,
    anchorNode: text,
    focusNode: text,
    getRangeAt: () => range as unknown as Range,
    toString: () => text.data.slice(start, end),
  } as unknown as Selection;
}

/** Two ends in two different nodes — a drag across rows, or across two paragraphs. */
function selectionAcross(a: unknown, aStart: number, b: unknown, bEnd: number): Selection {
  const first = a as Text;
  const second = b as Text;
  const range = { startContainer: first, startOffset: aStart, endContainer: second, endOffset: bEnd };
  return {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: first,
    focusNode: second,
    getRangeAt: () => range as unknown as Range,
    toString: () => `${first.data.slice(aStart)}${second.data.slice(0, bEnd)}`,
  } as unknown as Selection;
}

function textIn(container: HTMLElement, selector: string): unknown {
  return (container as unknown as Element).querySelector(selector)!.firstChild;
}

const REPLY = `
  <div class="session-msg session-msg-assistant" data-message-id="msg_01" data-msg-role="assistant" data-msg-ts="2026-09-10T10:00:00Z">
    <div class="session-msg-content"><p>The writer never blocks on a slow reader.</p></div>
  </div>`;

describe('captureSelectionQuote', () => {
  it('captures the passage, its row identity and the clipboard text', () => {
    const container = timeline(REPLY);
    const node = textIn(container, '.session-msg-content p');
    // "never blocks" inside "The writer never blocks on a slow reader."
    const captured = captureSelectionQuote(container, selectionOver(node, 11, 23));
    expect(captured).not.toBeNull();
    expect(captured!.quote.exact).toBe('never blocks');
    expect(captured!.msgId).toBe('msg_01');
    expect(captured!.role).toBe('assistant');
    expect(captured!.timestamp).toBe('2026-09-10T10:00:00Z');
    // `text` is what the BROWSER says was selected (what Copy puts on the clipboard),
    // a separate field from the index-derived quote. The over-selected case below is
    // where the two genuinely differ.
    expect(captured!.text).toBe('never blocks');
    // Context either side, so the passage can be located again after a re-render.
    expect(captured!.quote.prefix).toBe('The writer ');
    expect(captured!.quote.suffix).toBe(' on a slow reader.');
  });

  it('trims the whitespace a drag over-selects', () => {
    const container = timeline(REPLY);
    const node = textIn(container, '.session-msg-content p');
    const captured = captureSelectionQuote(container, selectionOver(node, 10, 24));
    expect(captured!.quote.exact).toBe('never blocks');
    // The two fields part ways here: the quote is trimmed (so it can be located
    // again), the clipboard text is verbatim what the browser reported.
    expect(captured!.text).toBe(' never blocks ');
  });

  it('returns null for a collapsed selection (a plain click)', () => {
    const container = timeline(REPLY);
    const node = textIn(container, '.session-msg-content p');
    expect(captureSelectionQuote(container, selectionOver(node, 11, 11))).toBeNull();
  });

  it('returns null for whitespace-only selections', () => {
    const container = timeline(REPLY);
    const node = textIn(container, '.session-msg-content p');
    expect(captureSelectionQuote(container, selectionOver(node, 10, 11))).toBeNull();
  });

  it('refuses a selection spanning two message bodies', () => {
    const container = timeline(`${REPLY}
      <div class="session-msg" data-message-id="msg_02" data-msg-role="assistant">
        <div class="session-msg-content"><p>A second answer entirely.</p></div>
      </div>`);
    const bodies = (container as unknown as Element).querySelectorAll('.session-msg-content p');
    const selection = selectionAcross(bodies[0]!.firstChild, 4, bodies[1]!.firstChild, 8);
    expect(captureSelectionQuote(container, selection)).toBeNull();
  });

  it('refuses a selection inside an editable control (the composer)', () => {
    const container = timeline(`
      <div class="session-msg-content"><div contenteditable="true"><p>typed text here</p></div></div>`);
    const node = textIn(container, '[contenteditable="true"] p');
    expect(captureSelectionQuote(container, selectionOver(node, 0, 5))).toBeNull();
  });

  it('refuses a selection outside the timeline container', () => {
    const container = timeline(REPLY);
    const outside = document.createElement('div');
    outside.innerHTML = '<div class="session-msg-content"><p>a note somewhere else</p></div>';
    document.body.appendChild(outside);
    const node = outside.querySelector('p')!.firstChild;
    expect(captureSelectionQuote(container, selectionOver(node, 2, 6))).toBeNull();
  });

  it('captures a live streaming block that has no message id yet', () => {
    // Copy needs no identity, so the passage IS captured — only Pin/Ask stand down.
    const container = timeline('<div class="session-msg-content"><p>arriving right now</p></div>');
    const node = textIn(container, '.session-msg-content p');
    const captured = captureSelectionQuote(container, selectionOver(node, 0, 8));
    expect(captured!.quote.exact).toBe('arriving');
    expect(captured!.msgId).toBeUndefined();
    // No row attributes to read: an unlabelled body is prose from the assistant.
    expect(captured!.role).toBe('assistant');
    expect(captured!.timestamp).toBeUndefined();
  });

  it('reads the role off the row, so a user line is not mistaken for a reply', () => {
    const container = timeline(`
      <div class="session-msg" data-message-id="queue-7" data-msg-role="user">
        <div class="session-msg-content"><p>my own question about plums</p></div>
      </div>`);
    const node = textIn(container, '.session-msg-content p');
    const captured = captureSelectionQuote(container, selectionOver(node, 3, 14));
    expect(captured!.role).toBe('user');
    expect(captured!.msgId).toBe('queue-7');
  });
});

describe('selectionBody', () => {
  it('names the body a selection lives in', () => {
    const container = timeline(REPLY);
    const node = textIn(container, '.session-msg-content p');
    const body = selectionBody(container, selectionOver(node, 11, 23));
    expect(body?.className).toBe('session-msg-content');
  });
});

/**
 * Pure geometry, so it is tested as geometry: linkedom lays nothing out and every
 * rect it returns is zeros, so both boxes are supplied directly. This is the freshness
 * test the dictation path has instead of a timestamp — a passage the reader scrolled
 * away from must not become the anchor for whatever they say next — and the same test
 * the pill dismisses itself with.
 */
describe('selectionVisibleIn', () => {
  const BOX = { top: 100, bottom: 500, left: 0, right: 800 };
  function boxes(rect: { top: number; bottom: number; left: number; right: number } | null) {
    const container = { getBoundingClientRect: () => BOX } as unknown as HTMLElement;
    const selection = {
      rangeCount: rect ? 1 : 0,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          ...rect!,
          width: rect!.right - rect!.left,
          height: rect!.bottom - rect!.top,
        }),
      }),
    } as unknown as Selection;
    return [container, selection] as const;
  }

  it('sees a passage sitting inside the scroller', () => {
    expect(selectionVisibleIn(...boxes({ top: 200, bottom: 220, left: 40, right: 300 }))).toBe(true);
  });

  it('keeps a sliver: one visible line of a passage is still something to point at', () => {
    expect(selectionVisibleIn(...boxes({ top: 60, bottom: 108, left: 40, right: 300 }))).toBe(true);
  });

  it('drops a passage scrolled clear above the scroller', () => {
    expect(selectionVisibleIn(...boxes({ top: 20, bottom: 60, left: 40, right: 300 }))).toBe(false);
  });

  it('drops a passage scrolled clear below it', () => {
    expect(selectionVisibleIn(...boxes({ top: 600, bottom: 640, left: 40, right: 300 }))).toBe(false);
  });

  it('drops one scrolled sideways out of view — a wide code block inside a message', () => {
    expect(selectionVisibleIn(...boxes({ top: 200, bottom: 220, left: 900, right: 1200 }))).toBe(false);
  });

  it('drops a selection with no box at all — a range whose nodes are gone', () => {
    expect(selectionVisibleIn(...boxes({ top: 200, bottom: 200, left: 40, right: 40 }))).toBe(false);
  });

  it('drops an empty selection without asking for a range', () => {
    expect(selectionVisibleIn(...boxes(null))).toBe(false);
  });

  it('is the same rule for a held Range (the pill after the selection collapsed)', () => {
    const [container, selection] = boxes({ top: 200, bottom: 220, left: 40, right: 300 });
    expect(rangeVisibleIn(container, selection.getRangeAt(0))).toBe(true);
    const [, gone] = boxes({ top: 20, bottom: 60, left: 40, right: 300 });
    expect(rangeVisibleIn(container, gone.getRangeAt(0))).toBe(false);
    const [, noBox] = boxes({ top: 200, bottom: 200, left: 40, right: 40 });
    expect(rangeVisibleIn(container, noBox.getRangeAt(0))).toBe(false);
  });
});

/**
 * While the pill HOLDS a passage, the document selection is expected to be collapsed
 * and the caret lives in the composer. These two predicates are how the pill tells
 * "the user is writing their question" (keep holding) from "the user moved on" (let
 * go): a press or a selection inside a text control is writing.
 */
describe('targetInEditable', () => {
  it('sees the composer textarea, and a node inside a contenteditable', () => {
    const container = timeline(`
      <textarea class="chat-input-textarea"></textarea>
      <div contenteditable="true"><p>draft <b>words</b></p></div>
      <div class="session-msg-content"><p>prose</p></div>`);
    const root = container as unknown as Element;
    expect(targetInEditable(root.querySelector('textarea'))).toBe(true);
    expect(targetInEditable(root.querySelector('b')!.firstChild)).toBe(true);
    expect(targetInEditable(root.querySelector('.session-msg-content p')!.firstChild)).toBe(false);
  });

  it('fails closed on nothing, and on a target that is not a node', () => {
    expect(targetInEditable(null)).toBe(false);
    expect(targetInEditable({} as EventTarget)).toBe(false);
  });
});

describe('selectionInEditable', () => {
  it('a run selected inside the composer counts, whichever end sits in it', () => {
    const container = timeline(`<textarea class="chat-input-textarea">typed words</textarea>${REPLY}`);
    const box = textIn(container, 'textarea');
    const prose = textIn(container, '.session-msg-content p');
    expect(selectionInEditable(selectionOver(box, 0, 5))).toBe(true);
    expect(selectionInEditable(selectionAcross(box, 0, prose, 3))).toBe(true);
    expect(selectionInEditable(selectionOver(prose, 0, 10))).toBe(false);
  });

  it('a selection with no nodes is not in a text control', () => {
    expect(selectionInEditable({ anchorNode: null, focusNode: null } as unknown as Selection)).toBe(false);
  });
});

describe('canAnchorQuote', () => {
  const quote = { exact: 'never blocks' };
  const base = { role: 'assistant' as const, quote, text: 'never blocks' };

  it('accepts a real reply row', () => {
    expect(canAnchorQuote({ ...base, msgId: 'msg_01' })).toBe(true);
  });

  it('refuses a block with no id yet — an anchor names its parent by that id', () => {
    expect(canAnchorQuote(base)).toBe(false);
  });

  it('refuses a synthetic queue echo of a user line', () => {
    expect(canAnchorQuote({ ...base, msgId: 'queue-7' })).toBe(false);
  });

  it('refuses user and system rows: "ask about this" means asking about a reply', () => {
    expect(canAnchorQuote({ ...base, role: 'user', msgId: 'msg_01' })).toBe(false);
    expect(canAnchorQuote({ ...base, role: 'system', msgId: 'msg_01' })).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(canAnchorQuote(null)).toBe(false);
    expect(canAnchorQuote(undefined)).toBe(false);
  });
});
