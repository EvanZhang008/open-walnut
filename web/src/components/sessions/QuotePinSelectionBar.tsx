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
 * and keeps the pill on them through re-renders and scrolls, and Pin / Ask here / Quote / Comment / Copy
 * keep working from the capture. The hold ends when the user acts on the pill,
 * sends a message (the panel releases it), presses Escape, presses anywhere that is
 * not this panel's composer or mic, or makes a new selection. Nothing about a held
 * passage is INFERRED: from 2026-09-10 to 09-16 the landing turned the selection
 * into the composer's thread anchor instead, and a word dragged over while reading
 * became an "asking about" chip nobody asked for. The chip is Ask's to create.
 *
 * COMMENT. Quote and Comment both put the passage into the main conversation's
 * composer and send nothing; Comment first opens a small box in the pill for the
 * user's note, which goes under the quote. The box takes focus, so the press on
 * Comment HOLDS the passage (pointerdown, before main.tsx's mousedown guard clears
 * the selection): its paint stays while the user writes, and a reply streaming in
 * meanwhile cannot take the pill down. The composer stacks what is added in order
 * (prefill-place.ts 'stack'), so a reader collects several quotes and comments and
 * sends them as one message (2026-11-01, the user: "the comments pile up below, and
 * only when I send, they all go together").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { GAP_ABOVE, useCommentGap } from './useCommentGap';
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
import { draftHash, draftKey } from '@/utils/drafts';
import { useDraft } from '@/hooks/useDraft';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useSessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { fitsAsComment, passageGist } from '@/utils/passage-comments';
import { ICON_PIN } from './MessageActionIcons';
import { passageExtent, rangePoint, sameBoundaries, sameHeldPoint, useHeldPassage, type HeldPoint } from './useHeldPassage';
import { log } from '@/utils/log';
import { ASK_MODE_HINT, ASK_MODE_LABEL, ASK_MODES, type AskMode } from '@/utils/ask-mode';

/** A speech bubble with a question mark: Ask opens a question page. */
/** The Comment box and the Ask choice: as wide as the message column, never narrower
 *  than this (the field and Add need it; a short user bubble is about this wide). */
const COMMENT_MIN_WIDTH = 280;

const ICON_ASK = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    <path d="M6.6 5.6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9" />
    <path d="M8 9.3v.01" />
  </svg>
);

/** Three nodes, one below another: Ask in Tree opens a page one level down. */
const ICON_TREE = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M3.5 3h4M5.5 3v9.5h4M5.5 7.5h4" />
    <circle cx="11.5" cy="7.5" r="1.5" />
    <circle cx="11.5" cy="12.5" r="1.5" />
  </svg>
);

/** A speech bubble with lines: Comment writes a note under the quote. */
const ICON_COMMENT = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    <path d="M5.5 6h5M5.5 8h3" />
  </svg>
);

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
  onAsk?: (target: QuotePinTarget, opts?: { mode?: AskMode }) => void;
  /** Where a plain Ask here lands (the view the reader is in); the caret beside
   *  it offers the other way for this one question. */
  askMode?: AskMode;
  /**
   * The text fallback of "Quote" / "Comment": the passage as a Markdown quote in the
   * main conversation's composer. Used only where the passage cannot be kept as a
   * comment (no session record behind the timeline, or a row with no message id
   * yet). Omitted, with no comment store either = no buttons, which is how a
   * timeline with no composer of its own keeps the pill honest.
   */
  onQuoteInChat?: (passage: string, comment?: string) => void;
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
      if (rect && rect.height) {
        return { x: Math.round(rect.left), y: Math.round(rect.top), lineBottom: Math.round(rect.top + rect.height), ...passageExtent(range) };
      }
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

export function QuotePinSelectionBar({ containerRef, sessionId, onPin, onAsk, askMode = 'inline', onQuoteInChat }: QuotePinSelectionBarProps) {
  const [state, setState] = useState<PillState | null>(null);
  /** The Ask here choice (inline or Tree) is open in place of the buttons. */
  const [askPick, setAskPick] = useState(false);
  const askPickRef = useRef(false);
  askPickRef.current = askPick;
  /** The Comment box is open (the pill shows it instead of its buttons). */
  const [commentOpen, setCommentOpen] = useState(false);
  // Its words are a draft of this passage: a reload, or an Esc, keeps them, and the
  // same passage commented on again opens with them.
  const commentDraft = useDraft(commentOpen && state
    ? draftKey('quote-comment', sessionId, state.msgId || 'live', draftHash(state.text))
    : null);
  /** The box's words while it is open, null while the pill shows its buttons. */
  const commentRef = useRef<string | null>(null);
  commentRef.current = commentOpen ? commentDraft.text : null;
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
  /** The last Esc keydown ended an IME composition (its keyup must not dismiss). */
  const escComposing = useRef(false);
  /** The primary button is down on something other than the pill: a selection
   *  may be being dragged, so no pill until it is released. */
  const selectingRef = useRef(false);
  /** The capture behind the pill, for the listeners: the scroll handler must
   *  re-anchor an existing pill without ever conjuring one, and a held passage is
   *  re-located from this. A ref so the one listener set never has to be torn
   *  down and rebuilt per state change. */
  const stateRef = useRef<PillState | null>(null);
  stateRef.current = state;
  // The buttons hang just above the passage, at the column where the gesture ended. The Comment box and the
  // Ask choice open in a gap made for them in the text, under the block the passage
  // ends in and lined up with the message column (comment-gap.ts), and stay inside
  // the timeline: they cover no words, not the passage, not what follows it, never
  // the composer (2026-11-04, the user: "bro this is still not fixed", the choice
  // grew out of the button bar over the line above; then two reviewers of a choice
  // dropped under the selection: it hid the rest of the paragraph, and at the
  // bottom it lay on the composer). Memoized: useMenuPlacement takes the anchor as
  // a dependency and re-places on a new one.
  const anchor = state?.anchor ?? null;
  const inGap = commentOpen || askPick;
  // Both are as wide as the column, never narrower than the field and its button
  // need: a short user message's bubble or a fifth panel is narrower than that, and
  // then the box lines up with the column's right edge (where a user bubble sits)
  // and stays inside the timeline. One form for both: no frame of their own, an
  // "On ..." line, then the field or the two ways (2026-11-05, two reviewers: a
  // framed 320px card beside a frameless full-width box read as two systems).
  const gapBox = useMemo(() => {
    if (!anchor || !inGap || anchor.blockBottom === undefined || anchor.columnLeft === undefined) return null;
    const column = anchor.columnWidth ?? COMMENT_MIN_WIDTH;
    const room = containerRef.current?.getBoundingClientRect();
    const width = Math.round(Math.min(room ? room.width - 24 : Infinity, Math.max(column, COMMENT_MIN_WIDTH)));
    const x = width <= column ? anchor.columnLeft : Math.max(anchor.columnLeft + column - width, room ? room.left + 12 : 0);
    return { width, anchor: { x, y: anchor.blockBottom, bottom: anchor.blockBottom } };
  }, [anchor, inGap, containerRef]);
  // The button bar hangs off the WHOLE passage: above its first line, or under its
  // last when there is no room above, never on its words. Hung off the line the
  // gesture ended on, a passage over several lines (a table cell's wrapped words, a
  // sentence dragged downwards) had its first lines under the bar, and a flip went
  // onto the release line itself (2026-11-05, the user: "why sitll fucking broekn").
  // A passage taller than the timeline's visible part keeps the release line: there
  // is no edge of it in sight to hang from.
  const barAnchor = useMemo(() => {
    if (!anchor) return null;
    const { passageTop: top, passageBottom: bottom } = anchor;
    const room = containerRef.current?.getBoundingClientRect();
    if (top === undefined || bottom === undefined || (room && (top < room.top || bottom > room.bottom))) {
      return { x: anchor.x, y: anchor.y, bottom: anchor.lineBottom ?? anchor.y };
    }
    return { x: anchor.x, y: top, bottom };
  }, [anchor, containerRef]);
  const placement = useMenuPlacement(!!state, noTrigger, pillRef, {
    anchorPoint: gapBox?.anchor ?? barAnchor,
    align: gapBox ? 'start' : 'center',
    preferSide: 'up',
    ...(gapBox ? { side: 'down' as const, boundsRef: containerRef, bounds: 'visual' as const } : {}),
    gap: GAP_ABOVE,
    // A box in the gap is never squeezed into a scrolling sliver: when its gap is
    // scrolled out of the timeline it slides to stay whole inside it.
    minHeight: gapBox ? (commentOpen ? 160 : 96) : 28,
  });
  const boxWidth = gapBox?.width;

  const reanchor = useCallback((point: HeldPoint) => {
    setState((prev) => (prev && !sameHeldPoint(prev.anchor, point)
      ? { ...prev, anchor: point }
      : prev));
  }, []);
  // A passage lost while the Comment box is open (a streamed re-render rewrote it, it
  // scrolled away) only loses its paint: the box and the words typed in it stay, and
  // Add still has the captured text.
  const pillDown = useCallback(() => {
    if (commentRef.current !== null) return;
    setState(null);
  }, []);
  const held = useHeldPassage({ containerRef, captureRef: stateRef, reanchor, onLost: pillDown });
  useCommentGap(inGap && !!state, held, pillRef, containerRef);

  /** Pill down, and with it any held passage and its paint. The ONE exit. */
  const dismiss = useCallback(() => {
    held.clearHold();
    setState(null);
    setCommentOpen(false);
    setAskPick(false);
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
    // Writing in the Comment box: the selection sits in its textarea.
    if (commentRef.current !== null && pillRef.current?.contains(document.activeElement)) {
      held.repair();
      return;
    }
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
      setCommentOpen(false);
    }
    // A drag in progress is not a selection yet. A pill shown now sits under the
    // moving pointer, and WebKit then extends the selection ONTO the pill (a node
    // outside the transcript), so the drag ends selecting to the end of the page
    // with no pill at all. An earlier pill goes; the new one comes at the release.
    if (selectingRef.current) { setState(null); setCommentOpen(false); return; }
    const live = readLiveSelection(container, selection);
    if (!live) { setState(null); setCommentOpen(false); return; }
    setState((prev) => {
      const sameAnchor = !!prev && sameHeldPoint(prev.anchor, live.anchor);
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
      // An evaluate still queued from before the Esc (a late selectionchange or
      // scroll) would read the selection that is still there and put the pill
      // straight back: cancel it with the dismissal.
      if (e.key === 'Escape') {
        // An Esc that cancelled an IME composition is the input method's, not ours.
        if (escComposing.current) { escComposing.current = false; return; }
        // The Ask choice is a layer of its own: Esc goes back to the buttons.
        if (askPickRef.current) { setAskPick(false); return; }
        cancelAnimationFrame(raf); dismiss(); return;
      }
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
        // The Comment box keeps the pill up after a press on it, so it still follows.
        if (pressedPill.current && commentRef.current === null) return;
        // A held passage has no selection to read: its own Range says where it is.
        if (held.heldRef.current) { held.repair(); return; }
        // An open Comment box whose passage was lost stays where it is.
        if (commentRef.current !== null) return;
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
      selectingRef.current = e.button === 0 && !pressedPill.current;
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
    // The release ends the drag before `mouseup` (which follows it) evaluates, so
    // the pill appears where the mouse let go. A release the page never sees (the
    // window lost focus mid-drag) must not leave the pill off for good.
    const endSelecting = () => { selectingRef.current = false; };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', endSelecting, true);
    document.addEventListener('pointercancel', endSelecting, true);
    window.addEventListener('blur', endSelecting);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', schedule);
    document.addEventListener('keyup', onKey);
    document.addEventListener(SELECTION_HOLD_EVENT, onHold);
    document.addEventListener(SELECTION_RELEASE_EVENT, onRelease);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', endSelecting, true);
      document.removeEventListener('pointercancel', endSelecting, true);
      window.removeEventListener('blur', endSelecting);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('keyup', onKey);
      document.removeEventListener(SELECTION_HOLD_EVENT, onHold);
      document.removeEventListener(SELECTION_RELEASE_EVENT, onRelease);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [evaluate, hold, dismiss, held, reanchor, containerRef]);

  // A re-render that rewrites the text under the selection (React 19 writes
  // innerHTML whenever the prop object changes) makes Chromium and WebKit drop the
  // selection with NO selectionchange, which left the pill floating over a passage
  // nothing selected any more (2026-10-29, with the page's selection echo). That
  // rewrite is a mutation in the timeline, so while an unheld pill is up a
  // mutation re-checks the live selection; a held passage has its own repair.
  const pillUp = !!state;
  useEffect(() => {
    const container = containerRef.current;
    if (!pillUp || !container || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => {
      if (pressedPill.current || held.heldRef.current || commentRef.current !== null) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) return;
      setState(null);
    });
    mo.observe(container, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [pillUp, containerRef, held]);

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

  const ask = useCallback((mode?: AskMode) => {
    if (!state?.msgId || !onAsk) return;
    log.info('session', 'asking about a quoted passage', {
      sessionId, msgId: state.msgId, chars: state.quote.exact.length, mode: mode ?? askMode, picked: !!mode,
    });
    onAsk({
      msgId: state.msgId,
      role: state.role,
      ...(state.timestamp ? { timestamp: state.timestamp } : {}),
      quote: state.quote,
    }, mode ? { mode } : undefined);
    // Same gesture-time capture as Pin (the quote is already in `state`); the
    // selection goes: the page the Ask opens carries the passage as its quote head.
    window.getSelection()?.removeAllRanges();
    dismiss();
  }, [onAsk, askMode, sessionId, state, dismiss]);

  // Quote and Comment keep the passage as a comment on its words (listed above the
  // composer, sent with the next message); the text fallback is for a passage that
  // cannot be kept that way.
  const comments = useSessionCommentsApi();
  const canQuote = comments.canComment || !!onQuoteInChat;
  const keepPassage = useCallback((note: string): boolean => {
    if (!state?.text.trim()) return false;
    // Past the record's caps (a very long passage or comment) the text path keeps it.
    if (comments.canComment && state.msgId && state.quote.exact.trim() && fitsAsComment(state.text, note, comments.comments)) {
      comments.add({ msgId: state.msgId, role: state.role, quote: state.quote, text: state.text, comment: note });
      return true;
    }
    if (!onQuoteInChat) return false;
    log.info('session', 'quoting a passage in the chat as text', { sessionId, msgId: state.msgId, chars: state.text.length });
    onQuoteInChat(state.text, note || undefined);
    return true;
  }, [comments, onQuoteInChat, sessionId, state]);

  const quoteInChat = useCallback(() => {
    if (!keepPassage('')) return;
    window.getSelection()?.removeAllRanges();
    dismiss();
  }, [keepPassage, dismiss]);

  const addComment = useCallback(() => {
    const note = commentDraft.text.trim();
    if (!note || !keepPassage(note)) return;
    commentDraft.clear(commentDraft.key);
    window.getSelection()?.removeAllRanges();
    dismiss();
  }, [commentDraft, keepPassage, dismiss]);

  const copy = useCallback(() => {
    if (state?.text.trim()) void copyTextRobust(state.text);
    dismiss();
  }, [state, dismiss]);

  // While the pill is up, Esc belongs to it (dismissed on keyup above): claim the
  // keydown so neither the question stack's Esc (the window router) nor
  // fullscreen's (a document listener that skips a prevented Esc) also acts. The
  // CAPTURE phase, because fullscreen's bubble listener was registered first and
  // would otherwise run before this one. One Esc closes one layer.
  const shown = !!state;
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      escComposing.current = e.isComposing || e.keyCode === 229;
      if (!escComposing.current) e.preventDefault();
    };
    document.addEventListener('keydown', onDown, true);
    return () => document.removeEventListener('keydown', onDown, true);
  }, [shown]);

  // A new passage starts on the buttons, never on the last one's choice.
  const passageId = state ? `${state.msgId}|${state.quote.exact}` : '';
  useEffect(() => { setAskPick(false); }, [passageId]);
  // The choice opened (by a click or the keyboard): the keyboard is on its first way.
  useEffect(() => {
    if (askPick) pillRef.current?.querySelector<HTMLButtonElement>(`[data-testid="quote-ask-${askMode}"]`)?.focus();
  }, [askPick, askMode]);

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

  // What the box or the choice is about, in one quiet line: its start and its end, so
  // the reader can tell where it stops (the list above the composer shows it the same
  // way once it is added).
  const onLine = inGap ? (
    <div className="quote-pin-comment-on" data-testid="quote-comment-on" title={state?.text}>
      On <span>“{passageGist(state?.text ?? '')}”</span>
    </div>
  ) : null;

  return createPortal(
    <div
      ref={pillRef}
      className="quote-pin-pill"
      style={{ ...menuPlacementStyle(placement), ...(boxWidth ? { width: boxWidth } : {}) }}
      data-comment-open={commentOpen ? 'true' : undefined}
      data-testid="quote-pin-pill"
      onPointerDown={(e) => e.stopPropagation()}
      // The container's own mouseup handler recomputes the collapsing selection
      // and would unmount this pill before `click` fires.
      onMouseUp={(e) => e.stopPropagation()}
    >
      {askPick && canAsk ? (
        <div
          className="quote-ask-modes"
          role="group"
          aria-label="Ask about this passage"
          data-testid="quote-ask-modes"
          // Up and Down move between the two ways, as in any menu.
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.quote-ask-mode'));
            const at = rows.indexOf(document.activeElement as HTMLButtonElement);
            const next = rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
            if (next) { e.preventDefault(); next.focus(); }
          }}
        >
          {onLine}
          {ASK_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`quote-pin-pill-btn quote-ask-mode${m === askMode ? ' is-current' : ''}`}
              data-testid={`quote-ask-${m}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => ask(m)}
              title={ASK_MODE_HINT[m]}
            >
              {m === 'inline' ? ICON_ASK : ICON_TREE}
              <span>{ASK_MODE_LABEL[m]}</span>
              <span className="quote-ask-mode-hint">{ASK_MODE_HINT[m]}</span>
            </button>
          ))}
          {/* The way back, said where the choice is (the Comment box says its keys too). */}
          <div className="quote-ask-back" aria-hidden="true">↵ asks<span> · </span>↑↓ move<span> · </span>Esc goes back</div>
        </div>
      ) : commentOpen ? (
        <div className="quote-pin-comment" data-testid="quote-comment-box">
          {onLine}
          <AnswerBox
            value={commentDraft.text}
            onChange={commentDraft.setText}
            onSubmit={addComment}
            sendLabel="Add"
            sendTestId="quote-comment-add"
            testId="quote-comment-input"
            draftKey={commentDraft.key}
            autoFocus
            minRows={2}
            placeholder="Add a comment"
            ariaLabel="Comment on this passage"
          />
          <div className="quote-pin-comment-foot">
            {/* The same promise as a doc comment's card (DocCommentCard), and what Esc does. */}
            <div className="quote-pin-comment-hint">
              Sent with your next message<span className="quote-pin-comment-keys"><span aria-hidden="true"> · </span>Esc keeps a draft</span>
            </div>
            {/* Discard throws the words away; an Esc keeps them as the passage's draft. */}
            <button
              type="button"
              className="quote-pin-comment-cancel"
              onMouseDown={(e) => e.preventDefault()}
              title="Throw this comment away"
              onClick={() => { commentDraft.clear(commentDraft.key); dismiss(); }}
            >
              Discard
            </button>
          </div>
        </div>
      ) : (<>
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
          onClick={() => ask()}
          title={`${ASK_MODE_LABEL[askMode]}: ${ASK_MODE_HINT[askMode].toLowerCase()}`}
        >
          {ICON_ASK}
          <span>Ask here</span>
        </button>
      )}
      {canAsk && (
        <button
          type="button"
          className="quote-pin-pill-btn quote-ask-mode-btn"
          data-testid="quote-ask-mode-btn"
          aria-haspopup="true"
          aria-expanded={askPick}
          aria-label="Choose how to ask: inline or in Tree"
          // Held like Comment's: the choice row about to take focus must not lose the passage.
          onPointerDown={(e) => { if (e.button === 0) hold(); }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { hold(); setAskPick(true); }}
          title="Choose how to ask: inline or in Tree"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
      {canQuote && !!state.text.trim() && (
        <button
          type="button"
          className="quote-pin-pill-btn"
          data-testid="quote-in-chat-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={quoteInChat}
          title="Quote this passage: it is listed above the message box and sent with your next message"
        >
          <span>Quote</span>
        </button>
      )}
      {canQuote && !!state.text.trim() && (
        <button
          type="button"
          className="quote-pin-pill-btn"
          data-testid="quote-comment-btn"
          // Hold now: the box about to take focus collapses the selection, and the
          // mousedown guard clears it before any click handler could hold it.
          onPointerDown={(e) => { if (e.button === 0) hold(); }}
          onMouseDown={(e) => e.preventDefault()}
          // The keyboard path has no pointerdown, and its selection is still live here.
          onClick={() => { hold(); setCommentOpen(true); }}
          title="Comment on this passage: the words stay marked, and the comment is sent with your next message"
        >
          {ICON_COMMENT}
          <span>Comment</span>
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
      </>)}
    </div>,
    document.body,
  );
}
