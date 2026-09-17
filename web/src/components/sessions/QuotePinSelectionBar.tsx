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
 *
 * HOLDING. Dictated text landing in the composer takes focus, which collapses the
 * document selection — and used to take the pill with it. The composer now asks the
 * pill to HOLD first (`requestSelectionHold`, selection-hold.ts): the captured
 * passage stays, `useHeldPassage` keeps painting the words the selection covered
 * and keeps the pill on them through re-renders and scrolls, and Pin / Ask / Copy
 * keep working from the capture. The hold ends when the user acts on the pill,
 * sends a message (the panel releases it), presses Escape, presses anywhere that is
 * not this panel's composer or mic, or makes a new selection. Nothing about a held
 * passage is INFERRED: from 2026-09-10 to 09-16 the landing turned the selection
 * into the composer's thread anchor instead, and a word dragged over while reading
 * became an "asking about" chip nobody asked for. The chip is Ask's to create.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import {
  canAnchorQuote, captureSelectionQuote, selectionBody, selectionInEditable, selectionVisibleIn,
  targetInEditable, type SelectionQuote,
} from '@/utils/selection-quote';
import { type TextQuote } from '@/utils/text-quote-anchor';
import { pressKeepsSelection } from '@/utils/selection-guard';
import {
  SELECTION_HOLD_EVENT, SELECTION_RELEASE_EVENT, type SelectionHoldDetail,
} from '@/utils/selection-hold';
import { copyTextRobust } from '@/utils/clipboard';
import { ICON_PIN } from './MessageActionIcons';
import { rangePoint, sameBoundaries, useHeldPassage, type HeldPoint } from './useHeldPassage';
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
  /**
   * Start a question about this passage (the composer's thread anchor). Omitted =
   * no Ask button, which is how a surface without a session record to write
   * anchors to keeps the pill honest.
   */
  onAsk?: (target: QuotePinTarget) => void;
}

/** The captured passage (shared with the dictation path — see selection-quote.ts)
 *  plus where to hang the pill. */
interface PillState extends SelectionQuote {
  /** Viewport point the pill hangs above: the selection's FOCUS caret, i.e. where
   *  the gesture ended, so the pill is under the hand that just let go. */
  anchor: HeldPoint;
}

function sameQuote(a: TextQuote, b: TextQuote): boolean {
  return a.exact === b.exact && a.prefix === b.prefix && a.suffix === b.suffix;
}

/** Focus before anchor in document order = the user dragged (or shift-arrowed)
 *  backwards, so the gesture ended at the selection's START. */
function selectionIsBackward(selection: Selection): boolean {
  const { anchorNode, focusNode, anchorOffset, focusOffset } = selection;
  if (!anchorNode || !focusNode) return false;
  if (anchorNode === focusNode) return focusOffset < anchorOffset;
  return !!(anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
}

/**
 * Viewport point where the selection gesture ENDED. A pill placed at the far end
 * of the selection in document order was wrong whenever the user dragged upwards:
 * they let go at the top and the pill appeared at the bottom, a screen away.
 *
 * A collapsed range at the focus caret gives the exact point in Chromium and
 * WebKit; when a browser returns no box for it (element boundaries), widen the
 * range by one character INTO the selection and read the caret-side edge. Last
 * resort: the selection's end rect on the focus side, which is still the right
 * line even if not the right column.
 */
function focusPoint(selection: Selection, range: Range): HeldPoint | null {
  const backward = selectionIsBackward(selection);
  const { focusNode, focusOffset } = selection;
  if (focusNode) {
    const caret = document.createRange();
    try {
      caret.setStart(focusNode, focusOffset);
      caret.setEnd(focusNode, focusOffset);
      let rect = caret.getClientRects()[0];
      if (!rect || !rect.height) {
        const len = focusNode.nodeType === Node.TEXT_NODE
          ? (focusNode as Text).data.length
          : focusNode.childNodes.length;
        if (backward && focusOffset < len) caret.setEnd(focusNode, focusOffset + 1);
        else if (!backward && focusOffset > 0) caret.setStart(focusNode, focusOffset - 1);
        const rects = caret.getClientRects();
        const r = rects.length ? rects[backward ? 0 : rects.length - 1] : undefined;
        if (r && r.height) rect = new DOMRect(backward ? r.left : r.right, r.top, 0, r.height);
      }
      if (rect && rect.height) return { x: Math.round(rect.left), y: Math.round(rect.top) };
    } catch { /* offsets can lag a re-render by a frame; fall through */ }
  }
  return rangePoint(range, backward);
}

/** Everything the pill reads off a live selection, in one pass — the ONE list of
 *  bails, shared by the gesture path and the hold. Cheap checks first, THEN the
 *  capture: `captureSelectionQuote` indexes the message body (~19ms on a long
 *  answer), and a selection with no focus rect has nowhere to hang a pill anyway. */
function readLiveSelection(
  container: HTMLElement,
  selection: Selection,
): { captured: SelectionQuote; anchor: HeldPoint; range: Range; backward: boolean } | null {
  if (!selectionBody(container, selection)) return null;
  // Out of sight, no pill — and it has to hold here too because a selection the
  // reader scrolled clear of is STILL a selection: the next mouseup anywhere (a
  // press on the mic, say) re-runs this, and a pill hung on an off-screen focus
  // point gets clamped into the viewport by useMenuPlacement, right over whatever
  // control sits at the timeline's bottom edge. Measured: the composer's mic, so
  // the click that was meant to stop the recording hit the pill instead, for as
  // long as the user kept trying.
  if (!selectionVisibleIn(container, selection)) return null;
  const range = selection.getRangeAt(selection.rangeCount - 1);
  const anchor = focusPoint(selection, range);
  if (!anchor) return null;
  const captured = captureSelectionQuote(container, selection);
  if (!captured) return null;
  return { captured, anchor, range, backward: selectionIsBackward(selection) };
}

export function QuotePinSelectionBar({ containerRef, sessionId, onPin, onAsk }: QuotePinSelectionBarProps) {
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
  /** The capture behind the pill, for the listeners: the scroll handler must
   *  re-anchor an existing pill without ever conjuring one, and a held passage is
   *  re-located from this. A ref so the one listener set never has to be torn
   *  down and rebuilt per state change. */
  const stateRef = useRef<PillState | null>(null);
  stateRef.current = state;
  // Referentially stable anchor: useMenuPlacement takes it as a dependency.
  const placement = useMenuPlacement(!!state, noTrigger, pillRef, {
    anchorPoint: state?.anchor ?? null,
    align: 'center',
    preferSide: 'up',
    gap: 8,
    minHeight: 28,
  });

  const reanchor = useCallback((point: HeldPoint) => {
    setState((prev) => (prev && (prev.anchor.x !== point.x || prev.anchor.y !== point.y)
      ? { ...prev, anchor: point }
      : prev));
  }, []);
  const pillDown = useCallback(() => setState(null), []);
  const held = useHeldPassage({ containerRef, captureRef: stateRef, reanchor, onLost: pillDown });

  /** Pill down, and with it any held passage and its paint. The ONE exit. */
  const dismiss = useCallback(() => {
    held.clearHold();
    setState(null);
  }, [held]);

  /**
   * Keep the pill's passage past the selection collapse that is about to happen.
   * Read once more rather than trusting the last evaluate: that ran a frame or more
   * ago, and what the pill holds must be what is selected NOW.
   */
  const hold = useCallback((): boolean => {
    if (held.heldRef.current) return true; // idempotent: a stop can deliver twice (provisional, then refined)
    const container = containerRef.current;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const live = container && selection ? readLiveSelection(container, selection) : null;
    if (!live) return false;
    held.hold(live.range, live.backward);
    setState((prev) => (prev && prev.msgId === live.captured.msgId && sameQuote(prev.quote, live.captured.quote)
      ? prev
      : { ...live.captured, anchor: live.anchor }));
    return true;
  }, [containerRef, held]);

  const evaluate = useCallback(() => {
    if (pressedPill.current) return; // pressing the pill is not a selection change
    const container = containerRef.current;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!container || !selection) { dismiss(); return; }
    const holding = held.heldRef.current;
    if (holding) {
      // Held: a collapsed document selection is the expected state (that is what the
      // hold is for); a caret or a run inside a text control is the user writing
      // their question in the composer; and the very selection the hold was taken
      // from is still alive for the frame before focus moves. Only a DIFFERENT real
      // selection ends the hold — and if it is a new passage in this timeline, the
      // pill simply follows it below.
      const stillHeld = selection.isCollapsed || selection.rangeCount === 0
        || selectionInEditable(selection)
        || sameBoundaries(selection.getRangeAt(selection.rangeCount - 1), holding.range);
      if (stillHeld) { held.repair(); return; }
      held.clearHold();
    }
    const live = readLiveSelection(container, selection);
    if (!live) { setState(null); return; }
    setState((prev) => {
      const sameAnchor = !!prev && prev.anchor.x === live.anchor.x && prev.anchor.y === live.anchor.y;
      if (prev && sameAnchor && prev.msgId === live.captured.msgId && sameQuote(prev.quote, live.captured.quote)) return prev;
      return {
        ...live.captured,
        // Keep the previous anchor OBJECT when the point is unchanged: it is a
        // dependency of useMenuPlacement, which re-places on identity.
        anchor: sameAnchor ? prev!.anchor : live.anchor,
      };
    });
  }, [containerRef, dismiss, held]);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(evaluate);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { dismiss(); return; }
      schedule();
    };
    // A scroll used to DISMISS the pill outright, which made it unusable for the
    // one reader who needs it most: while a reply streams, the timeline shrinks
    // and grows under a live selection (a Queued badge becomes Delivered, the
    // "Resuming session…" line becomes the working indicator, the turn ends and
    // the indicator goes) and the browser CLAMPS scrollTop on every shrink,
    // firing a scroll nobody asked for. "I select text while it is generating and
    // the Copy/Ask pill gets cancelled" was that clamp.
    //
    // A scroll now RE-ANCHORS instead: the passage is still selected, so the pill
    // follows it. It is still dismissed once the passage has scrolled clear of the
    // timeline (and a vanished selection has no box, so that covers it too) — the
    // original intent, narrowed to the case it was actually protecting. Only while
    // a pill is up, so a scroll can never REVIVE one that Escape dismissed.
    const onScroll = (e: Event) => {
      if (!stateRef.current) return;
      // Only scrollers the passage can move WITH: the timeline, anything inside it,
      // or an ancestor (the document). A sibling scroller — another column, the task
      // list — cannot move these words, and the layout reads below are not free.
      const container = containerRef.current;
      const t = e.target;
      if (container && t instanceof Node && t !== document && !t.contains(container) && !container.contains(t)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Same reason `evaluate` bails on a pill press: a press clears the
        // selection (the guard in main.tsx), which releases the selection freeze,
        // which resizes the timeline and clamps scrollTop — so a scroll can arrive
        // with nothing selected while the pill's own click is still in flight, and
        // unmounting in that frame would swallow it.
        //
        // Measured on this machine the clamp lands ~700ms AFTER mouseup, so no
        // press observed here actually raced it; this is a one-line floor for the
        // slower machine (or the longer press) where it would.
        if (pressedPill.current) return;
        // A held passage has no selection to read: its own Range says where it is.
        if (held.heldRef.current) { held.repair(); return; }
        const selection = typeof window !== 'undefined' ? window.getSelection() : null;
        if (container && selection && !selectionVisibleIn(container, selection)) {
          setState(null);
          return;
        }
        if (!selection || selection.rangeCount === 0) return;
        // A scroll cannot change WHAT is selected, only where it sits on screen,
        // so move the anchor instead of re-running evaluate(): re-indexing the
        // body costs ~19ms on a long answer (useQuotePinPaint rate-limits itself
        // for that reason) and this fires on every frame of a flung scroll.
        const point = focusPoint(selection, selection.getRangeAt(selection.rangeCount - 1));
        if (point) reanchor(point);
      });
    };
    // Capture phase: this only RECORDS where the press landed, and it has to do so
    // before anything can move the DOM out from under the target.
    const onPointerDown = (e: PointerEvent) => {
      pressedPill.current = !!pillRef.current?.contains(e.target as Node);
      if (!held.heldRef.current || pressedPill.current) return;
      // A held pill has no selection left for the guard in main.tsx to clear, so it
      // decides for itself, by that guard's rules: a right/middle press is the
      // context menu, not a dismissal; a press into a text control (writing the
      // question) or onto a `data-keep-selection` control (the mic: acting on the
      // passage) keeps the hold — but only inside THIS panel. Another column's
      // composer or mic is the user moving on, and a pill left behind there would be
      // pointing at a passage from a conversation they have left.
      if (e.button !== 0) return;
      const panel = containerRef.current?.closest('.session-panel');
      const inPanel = !!panel && e.target instanceof Node && panel.contains(e.target);
      if (inPanel && (targetInEditable(e.target) || pressKeepsSelection(e.target))) return;
      dismiss();
    };
    // The composer's requests, sent from its panel root and addressed to the pill
    // whose timeline that panel contains (a second panel's pill sees a target that
    // does not contain its timeline and stays out of it).
    const addressedHere = (e: Event) =>
      e.target instanceof Node && !!containerRef.current && e.target.contains(containerRef.current);
    const onHold = (e: Event) => {
      if (!addressedHere(e)) return;
      (e as CustomEvent<SelectionHoldDetail>).detail.held = hold();
    };
    const onRelease = (e: Event) => {
      if (!addressedHere(e) || !held.heldRef.current) return;
      dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', schedule);
    document.addEventListener('keyup', onKey);
    document.addEventListener(SELECTION_HOLD_EVENT, onHold);
    document.addEventListener(SELECTION_RELEASE_EVENT, onRelease);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('keyup', onKey);
      document.removeEventListener(SELECTION_HOLD_EVENT, onHold);
      document.removeEventListener(SELECTION_RELEASE_EVENT, onRelease);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [evaluate, hold, dismiss, held, reanchor, containerRef]);

  const pin = useCallback(() => {
    if (!state?.msgId) return;
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
    dismiss();
  }, [onPin, sessionId, state, dismiss]);

  const ask = useCallback(() => {
    if (!state?.msgId || !onAsk) return;
    log.info('session', 'asking about a quoted passage', {
      sessionId, msgId: state.msgId, chars: state.quote.exact.length,
    });
    onAsk({
      msgId: state.msgId,
      role: state.role,
      ...(state.timestamp ? { timestamp: state.timestamp } : {}),
      quote: state.quote,
    });
    // Same gesture-time capture as Pin (the quote is already in `state`); the
    // selection goes so the only mark left is the composer chip.
    window.getSelection()?.removeAllRanges();
    dismiss();
  }, [onAsk, sessionId, state, dismiss]);

  const copy = useCallback(() => {
    if (state?.text.trim()) void copyTextRobust(state.text);
    dismiss();
  }, [state, dismiss]);

  if (!state) return null;

  // An anchor names its parent by the reply's row id, which only has to be STABLE
  // across parses: a real reply's msgId is the API message id (`msg_…`), never a
  // v4 uuid (verified live 2026-09-04), so gating on the uuid shape would hide Ask
  // on every real transcript. `canAnchorQuote` holds that rule for both this pill
  // and the dictation path, so they can never disagree about a passage.
  // A row with no id yet (a streaming block before its message_start id lands)
  // can hold neither a pin nor an anchor — both name their target by that id —
  // so the pill degrades to Copy rather than offering a button that would drop
  // the passage on the floor.
  const canPin = !!state.msgId;
  const canAsk = !!onAsk && canAnchorQuote(state);

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
      {canPin && (
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
      )}
      {canAsk && (
        <button
          type="button"
          className="quote-pin-pill-btn"
          data-testid="quote-ask-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={ask}
          title="Ask about this passage (starts a thread)"
        >
          <span aria-hidden="true">↳</span>
          <span>Ask</span>
        </button>
      )}
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
