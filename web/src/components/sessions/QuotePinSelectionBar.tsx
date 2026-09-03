/**
 * QuotePinSelectionBar — select words inside one message, get a pill offering to
 * pin exactly that passage.
 *
 * One listener set for the whole timeline (mounted by SessionChatHistory), not one
 * per message: a long transcript holds hundreds of rows, and `selectionchange`
 * fires on every drag tick.
 *
 * The pill is portalled to <body> and placed by `useMenuPlacement` from a cursor
 * anchor, so it can never hang off the viewport and no ancestor `transform`
 * (glass panels, the fullscreen session overlay) can become its containing block
 * and drop it onto the text.
 *
 * ⚠️ THE QUOTE IS CAPTURED WHEN THE SELECTION CHANGES, NOT WHEN PIN IS CLICKED.
 * `main.tsx` installs a CAPTURE-phase document mousedown handler that calls
 * `removeAllRanges()` whenever a click lands outside the current selection (it
 * kills macOS's inactive-selection flash). The pill is outside the selection by
 * definition, so by the time a click handler runs there is no selection left to
 * read — and no `preventDefault` can help, because the range is cleared
 * imperatively ahead of every app handler. Measured: the selection was intact on
 * mousemove and empty immediately after mousedown, so the pin silently did
 * nothing. Every quote-to-ask surface in this app captures at gesture time for
 * the same reason.
 *
 * The remaining event detail is `onPointerDown` → `stopPropagation()` on the
 * portal root, or the press reaches a sortable row's drag sensors through the
 * React tree (portals escape clipping, not bubbling).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { buildTextIndex, quoteFromRange, type TextQuote } from '@/utils/text-quote-anchor';
import { copyTextRobust } from '@/utils/clipboard';
import { ICON_PIN } from './MessageActionIcons';
import { log } from '@/utils/log';

export interface QuotePinTarget {
  msgId: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: string;
  quote: TextQuote;
}

interface QuotePinSelectionBarProps {
  /** The timeline scroll container. A selection outside it is somebody else's. */
  containerRef: React.RefObject<HTMLElement | null>;
  sessionId: string;
  onPin: (target: QuotePinTarget) => void;
}

interface PillState {
  /** Viewport point the pill hangs above (the selection's last rect, centred). */
  anchor: { x: number; y: number };
  msgId: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: string;
  /** Captured from the message's text index while the selection still exists. */
  quote: TextQuote;
  /** What the browser says was selected — what Copy puts on the clipboard. */
  text: string;
}

function sameQuote(a: TextQuote, b: TextQuote): boolean {
  return a.exact === b.exact && a.prefix === b.prefix && a.suffix === b.suffix;
}

const EDITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

function roleOf(value: string | null | undefined): 'user' | 'assistant' | 'system' {
  return value === 'user' || value === 'system' ? value : 'assistant';
}

/** The message body a selection lives in, or null when the selection is not one
 *  message's prose: both ends must sit in the SAME `.session-msg-content` inside
 *  this container, in the top document, outside any editable control. */
function selectionBody(container: HTMLElement, selection: Selection): Element | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  // A rich-HTML island renders in an iframe: its selection lives in another
  // document and cannot be anchored against this one's text index.
  if (anchorNode.ownerDocument !== document || focusNode.ownerDocument !== document) return null;
  const anchorEl = anchorNode.nodeType === Node.ELEMENT_NODE
    ? (anchorNode as Element)
    : anchorNode.parentElement;
  const focusEl = focusNode.nodeType === Node.ELEMENT_NODE
    ? (focusNode as Element)
    : focusNode.parentElement;
  if (!anchorEl || !focusEl) return null;
  if (anchorEl.closest(EDITABLE) || focusEl.closest(EDITABLE)) return null;
  const body = anchorEl.closest('.session-msg-content');
  if (!body || body !== focusEl.closest('.session-msg-content')) return null;
  if (!container.contains(body)) return null;
  if (!body.closest('[data-message-id]')) return null;
  return body;
}

export function QuotePinSelectionBar({ containerRef, sessionId, onPin }: QuotePinSelectionBarProps) {
  const [state, setState] = useState<PillState | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  /**
   * Did the current press land ON the pill? Then the selection clear that follows
   * it is the guard in main.tsx doing its job, NOT the user dismissing the pill —
   * so the pill must stay mounted long enough for its own click to be delivered.
   * Without this the pill unmounted between mousedown and click and the Pin button
   * did nothing at all (measured). Self-clearing: any press elsewhere sets it back.
   */
  const pressedPill = useRef(false);
  // Referentially stable anchor: useMenuPlacement takes it as a dependency.
  const placement = useMenuPlacement(!!state, noTrigger, pillRef, {
    anchorPoint: state?.anchor ?? null,
    align: 'center',
    preferSide: 'up',
    gap: 8,
    minHeight: 28,
  });

  const evaluate = useCallback(() => {
    if (pressedPill.current) return; // pressing the pill is not a selection change
    const container = containerRef.current;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!container || !selection) { setState(null); return; }
    const body = selectionBody(container, selection);
    if (!body) { setState(null); return; }
    const text = selection.toString();
    if (!text.trim()) { setState(null); return; }
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { setState(null); return; }
    const row = body.closest('[data-message-id]') as HTMLElement | null;
    const msgId = row?.getAttribute('data-message-id');
    if (!msgId) { setState(null); return; }
    // Indexing ONE message body per gesture tick — a paragraph, so microseconds.
    // The quote MUST come from the index rather than `text`: toString() serializes
    // layout (block breaks become newlines, runs collapse), so its string does not
    // exist in the index and the pin could never locate itself again.
    const quote = quoteFromRange(buildTextIndex(body), range);
    if (!quote) { setState(null); return; }
    const anchor = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top) };
    setState((prev) => {
      const sameAnchor = !!prev && prev.anchor.x === anchor.x && prev.anchor.y === anchor.y;
      if (prev && sameAnchor && prev.msgId === msgId && sameQuote(prev.quote, quote)) return prev;
      return {
        // Keep the previous anchor OBJECT when the point is unchanged: it is a
        // dependency of useMenuPlacement, which re-places on identity.
        anchor: sameAnchor ? prev!.anchor : anchor,
        msgId,
        role: roleOf(row?.getAttribute('data-msg-role')),
        ...(row?.getAttribute('data-msg-ts') ? { timestamp: row.getAttribute('data-msg-ts')! } : {}),
        quote,
        text,
      };
    });
  }, [containerRef]);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(evaluate);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setState(null); return; }
      schedule();
    };
    // A scroll moves the text out from under a viewport-anchored pill, so the
    // pill goes rather than pointing at the wrong words.
    const onScroll = () => setState(null);
    // Capture phase: this only RECORDS where the press landed, and it has to do so
    // before anything can move the DOM out from under the target.
    const onPointerDown = (e: PointerEvent) => {
      pressedPill.current = !!pillRef.current?.contains(e.target as Node);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', schedule);
    document.addEventListener('keyup', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('keyup', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [evaluate]);

  const pin = useCallback(() => {
    if (!state) return;
    log.info('session', 'pinning a quoted passage', {
      sessionId, msgId: state.msgId, chars: state.quote.exact.length,
    });
    onPin({
      msgId: state.msgId,
      role: state.role,
      ...(state.timestamp ? { timestamp: state.timestamp } : {}),
      quote: state.quote,
    });
    // Usually already collapsed by main.tsx's mousedown guard; clearing is still
    // right for the keyboard path, and it is what makes the paint the only mark
    // left on the passage.
    window.getSelection()?.removeAllRanges();
    setState(null);
  }, [onPin, sessionId, state]);

  const copy = useCallback(() => {
    if (state?.text.trim()) void copyTextRobust(state.text);
    setState(null);
  }, [state]);

  if (!state) return null;

  return createPortal(
    <div
      ref={pillRef}
      className="quote-pin-pill"
      style={menuPlacementStyle(placement)}
      data-testid="quote-pin-pill"
      onPointerDown={(e) => e.stopPropagation()}
      // The container's own mouseup handler recomputes the collapsing selection
      // and would unmount this pill before `click` fires.
      onMouseUp={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="quote-pin-pill-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={pin}
        title="Pin this passage (adds it to the outline)"
      >
        {ICON_PIN}
        <span>Pin</span>
      </button>
      <button
        type="button"
        className="quote-pin-pill-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={copy}
        title="Copy the selected text"
      >
        Copy
      </button>
    </div>,
    document.body,
  );
}
