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
 * composer and send nothing; Comment first opens a small box under its button
 * for the user's note, which goes under the quote. The box takes focus, so the press on
 * Comment HOLDS the passage (pointerdown, before main.tsx's mousedown guard clears
 * the selection): its paint stays while the user writes, and a reply streaming in
 * meanwhile cannot take the pill down. The composer stacks what is added in order
 * (prefill-place.ts 'stack'), so a reader collects several quotes and comments and
 * sends them as one message (2026-11-01, the user: "the comments pile up below, and
 * only when I send, they all go together").
 *
 * MENUS. Ask here's choice (inline or Tree) and the Comment box are ordinary menus:
 * each its own portalled popover dropping down from the button that opened it (up
 * only when there is no room below), with a border, a solid background and a shadow,
 * laid over the conversation. Opening one never moves
 * or reflows the conversation (2026-11-05, the user, of a choice that opened in a gap
 * pushed into the text: "Just a normal menu", "it is an overlay. Nobody would design
 * it this way").
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { draftHash, draftKey } from '@/utils/drafts';
import { useDraft } from '@/hooks/useDraft';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useSessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { useSessionThreadsApi } from '@/contexts/SessionThreadsContext';
import { fitsAsComment, passageGist } from '@/utils/passage-comments';
import { ICON_PIN } from './MessageActionIcons';
import { passageExtent, rangePoint, sameBoundaries, sameHeldPoint, useHeldPassage, type HeldPoint } from './useHeldPassage';
import { log } from '@/utils/log';
import { ASK_MODE_HINT, ASK_MODE_LABEL, ASK_MODES, type AskMode } from '@/utils/ask-mode';

/** Room between the passage and the bar, and between a button and its menu. */
const BAR_GAP = 8;
const MENU_GAP = 4;
/** The room a menu needs under the bar to open downward: the Comment box's height. */
const MENU_ROOM = 110;

/** A speech bubble with a question mark: Ask opens a question page. */
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
/** Quote and Copy carry words only; these icons stand in for them in the compact bar. */
const ICON_QUOTE = (
  <svg className="quote-pin-compact-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M3 9.5h3v3H3zM3 9.5c0-2.5 1-4.5 3-5.5M9.5 9.5h3v3h-3zM9.5 9.5c0-2.5 1-4.5 3-5.5" />
  </svg>
);
const ICON_COPY = (
  <svg className="quote-pin-compact-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);

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
  /** The open menu (Ask's choice or the Comment box), its own portal. */
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** What each menu hangs under: Ask here with its caret, and Comment. */
  const askGroupRef = useRef<HTMLSpanElement | null>(null);
  const commentBtnRef = useRef<HTMLButtonElement | null>(null);
  const askCaretRef = useRef<HTMLButtonElement | null>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  /** The press or the focus is on the bar or on its open menu. */
  const inPill = useCallback((n: Node | null) => !!n && (!!pillRef.current?.contains(n) || !!menuRef.current?.contains(n)), []);
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
  // The bar hangs off the WHOLE passage, under its last line, and goes above its first
  // only when there is no room below (2026-11-05, the user's screenshot of the bar on a
  // code block's last line over a selected heading). Hung off the line the gesture ended
  // on, a passage over several lines had its first lines under the bar. A passage taller
  // than the timeline's visible part keeps the release line: no edge of it is in sight.
  // Memoized: useMenuPlacement takes the anchor as a dependency and re-places on a new one.
  const anchor = state?.anchor ?? null;
  const barAnchor = useMemo(() => {
    if (!anchor) return null;
    const { passageTop: top, passageBottom: bottom } = anchor;
    const room = containerRef.current?.getBoundingClientRect();
    if (top === undefined || bottom === undefined || (room && (top < room.top || bottom > room.bottom))) {
      return { x: anchor.x, y: anchor.y, bottom: anchor.lineBottom ?? anchor.y };
    }
    return { x: anchor.x, y: top, bottom };
  }, [anchor, containerRef]);
  // Under the passage when the bar AND a menu opened from it fit there, else above
  // it: a menu that had to flip up from a bar under the passage landed on the very
  // words (a passage on the last lines above the composer). The menus open on the
  // same side, away from the words. Decided once per passage: a scroll never flips it.
  const passageKey = state ? `${state.msgId}|${state.quote.exact}|${state.quote.prefix}` : '';
  const sideRef = useRef<{ key: string; side: 'up' | 'down' }>({ key: '', side: 'down' });
  if (barAnchor && sideRef.current.key !== passageKey) {
    const box = containerRef.current?.getBoundingClientRect();
    const lo = Math.min(box ? box.bottom : window.innerHeight, window.innerHeight);
    const hi = Math.max(box ? box.top : 0, 0);
    const need = BAR_GAP + (pillRef.current?.offsetHeight || 32) + MENU_GAP + MENU_ROOM;
    const below = lo - barAnchor.bottom;
    const above = barAnchor.y - hi;
    sideRef.current = { key: passageKey, side: below >= need || below >= above ? 'down' : 'up' };
  }
  const side = sideRef.current.side;
  const placement = useMenuPlacement(!!state, noTrigger, pillRef, {
    anchorPoint: barAnchor,
    align: 'center',
    preferSide: side,
    gap: BAR_GAP,
    margin: 4,
    // Never capped below its own height (one row of buttons): a short timeline, or a
    // passage scrolled past its edge, keeps the whole bar, never a clipped one.
    minHeight: 48,
    // Over the timeline's text column: never on Tree Mode's Questions list, the
    // pane beside a split, the scrollbar or the composer.
    boundsRef: containerRef,
  });
  // A timeline narrower than the bar (a narrow column; macOS's wider face) gets
  // the compact bar: Pin, Ask here and Comment show their icons only (their names
  // stay as labels and titles). Decided before paint, so the wide bar never shows.
  const [compact, setCompact] = useState(false);
  const fullWidthRef = useRef(0);
  useLayoutEffect(() => {
    const bar = pillRef.current;
    // The text column, the box the bar is placed in first.
    const el = containerRef.current;
    const cs = el ? getComputedStyle(el) : null;
    const room = el && cs ? el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) : 0;
    if (!state || !bar || !room) return;
    if (!compact) fullWidthRef.current = bar.offsetWidth;
    const fits = fullWidthRef.current + 8 <= room;
    if (compact === fits) setCompact(!fits);
  });
  const menuOpen = !!state && (askPick || commentOpen);
  // The menu hangs off its button, read from where the bar is PLACED rather than
  // from the button's box: a bar that moves (a scroll, a held passage re-found after
  // the text above it changed) moves its button with no event a menu placed from
  // the button would hear, and the menu was left behind on the bar or the words.
  const menuAnchor = useMemo(() => {
    const bar = pillRef.current;
    const btn = askPick ? askGroupRef.current : commentBtnRef.current;
    if (!menuOpen || !placement || !bar || !btn) return null;
    // Each drops from its own button, as any dropdown does: Ask here's choice from
    // its caret's group, the Comment box from Comment. Left edges meet; where the
    // column leaves no room to the right, right edges meet instead.
    const barLeft = window.innerWidth - placement.right - bar.offsetWidth;
    const left = barLeft + bar.clientLeft + btn.offsetLeft;
    const top = placement.top + bar.clientTop + btn.offsetTop;
    return { x: left, right: left + btn.offsetWidth, y: top, bottom: top + btn.offsetHeight };
  }, [menuOpen, placement, askPick]);
  const menuPlacement = useMenuPlacement(menuOpen && !!menuAnchor, noTrigger, menuRef, {
    anchorPoint: menuAnchor,
    align: 'start',
    preferSide: side,
    gap: MENU_GAP,
    margin: 4,
    minHeight: askPick ? 96 : 150,
    boundsRef: containerRef,
  });
  // A menu as wide as the timeline's text column allows (the box it is placed in):
  // a narrow column gets a narrower menu, never one that spills over the next pane.
  const menuRoom = (() => {
    const el = menuOpen ? containerRef.current : null;
    if (!el) return undefined;
    const cs = getComputedStyle(el);
    const column = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return Math.max(column, Math.min(el.clientWidth, 220));
  })();

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

  /** See holdLastLive. */
  const lastLiveRef = useRef<{ range: Range; backward: boolean } | null>(null);
  /** Pill down, and with it any held passage and its paint. The ONE exit. */
  const dismiss = useCallback(() => {
    lastLiveRef.current = null;
    held.clearHold();
    setState(null);
    setCommentOpen(false);
    setAskPick(false);
  }, [held]);

  /**
   * The last passage the pill was shown for, kept for a keyboard user: macOS WebKit
   * clears the document's selection when focus moves onto one of the bar's buttons
   * (a Tab, or the bar's own focus), so with nothing selected the pill used to go
   * and Comment or Ask here, pressed with Enter, did nothing (2026-11-06, Mac app).
   * With focus on the bar, that passage is held instead.
   */
  const holdLastLive = useCallback((): boolean => {
    const last = lastLiveRef.current;
    // A range a DOM removal re-pointed collapses onto an element; a live one keeps
    // its words (a browser selection may end on an element, so no text-node test).
    const r = last?.range;
    if (!r || !inPill(document.activeElement) || r.collapsed || !r.startContainer.isConnected || !r.endContainer.isConnected) return false;
    held.hold(r, last!.backward);
    return true;
  }, [held, inPill]);

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
    if (!live) return holdLastLive();
    held.hold(live.range, live.backward);
    setState((prev) => (prev && prev.msgId === live.captured.msgId && sameQuote(prev.quote, live.captured.quote)
      ? prev
      : { ...live.captured, anchor: live.anchor }));
    return true;
  }, [containerRef, held, holdLastLive]);

  const evaluate = useCallback(() => {
    if (pressedPill.current) return; // pressing the pill is not a selection change
    // Writing in the Comment box: the selection sits in its textarea.
    if (commentRef.current !== null && inPill(document.activeElement)) {
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
    if (!live) {
      if (holdLastLive()) return;
      lastLiveRef.current = null;
      setState(null); setCommentOpen(false); return;
    }
    lastLiveRef.current = { range: live.range.cloneRange(), backward: live.backward };
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
  }, [containerRef, dismiss, held, inPill, holdLastLive]);

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
        // Focus goes back to the caret that opened it, as any dropdown's does.
        if (askPickRef.current) { setAskPick(false); askCaretRef.current?.focus(); return; }
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
        // A held passage has no selection to read: its own Range says where it is.
        // First: a press that held it (Comment, Ask here's caret) keeps the bar and
        // its menu on the words through a scroll, never frozen over other text.
        if (held.heldRef.current) { held.repair(); return; }
        if (pressedPill.current && commentRef.current === null) return;
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
      pressedPill.current = inPill(e.target as Node);
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
    // A resize reflows the column under the passage: re-anchor as a scroll does.
    const onResize = () => onScroll({ target: document } as unknown as Event);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
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
  }, [evaluate, hold, dismiss, held, reanchor, containerRef, inPill]);

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
  // Tree Mode: a comment belongs to the page it was made on (each half names its
  // own), waits in that page's composer and goes with that page's next message.
  const threadsView = useSessionThreadsApi();
  const commentPage = threadsView.viewMode === 'stack' ? threadsView.currentThreadKey : undefined;
  const canQuote = comments.canComment || !!onQuoteInChat;
  const keepPassage = useCallback((note: string): boolean => {
    if (!state?.text.trim()) return false;
    // Past the record's caps (a very long passage or comment) the text path keeps it.
    if (comments.canComment && state.msgId && state.quote.exact.trim() && fitsAsComment(state.text, note, comments.comments)) {
      comments.add({
        msgId: state.msgId, role: state.role, quote: state.quote, text: state.text, comment: note,
        ...(commentPage !== undefined ? { pageKey: commentPage } : {}),
      });
      return true;
    }
    if (!onQuoteInChat) return false;
    log.info('session', 'quoting a passage in the chat as text', { sessionId, msgId: state.msgId, chars: state.text.length });
    onQuoteInChat(state.text, note || undefined);
    return true;
  }, [comments, onQuoteInChat, sessionId, state, commentPage]);

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
    if (askPick) menuRef.current?.querySelector<HTMLButtonElement>(`[data-testid="quote-ask-${askMode}"]`)?.focus();
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

  // The bar and the open menu are two portals; a press on either is a press on the pill.
  const stopPress = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    // The container's own mouseup handler recomputes the collapsing selection and
    // would unmount the pill before `click` fires.
    onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
  };

  const menu = menuOpen ? (
    <div
      ref={menuRef}
      className="quote-pin-menu"
      style={{
        ...menuPlacementStyle(menuPlacement),
        ...(menuRoom ? { '--quote-menu-room': `${menuRoom - 12}px` } : {}),
      } as React.CSSProperties}
      data-testid="quote-pin-menu"
      {...stopPress}
    >
      {askPick && canAsk ? (
        <div
          className="quote-ask-modes"
          role="menu"
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
          {ASK_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
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
        </div>
      ) : commentOpen ? (
        <div className="quote-pin-comment" role="dialog" aria-label="Comment on this passage" data-testid="quote-comment-box">
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
            <div className="quote-pin-comment-hint" title="Sent with your next message. Esc keeps a draft.">
              Sent with your next message<span className="quote-pin-comment-keys"><span aria-hidden="true">{'\u00a0·\u00a0'}</span>Esc keeps a draft</span>
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
      ) : null}
    </div>
  ) : null;

  return createPortal(
    <>
    <div
      ref={pillRef}
      className={`quote-pin-pill${compact ? ' is-compact' : ''}`}
      style={menuPlacementStyle(placement)}
      data-testid="quote-pin-pill"
      {...stopPress}
    >
      {canPin && (
        <button
          type="button"
          className="quote-pin-pill-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={pin}
          title="Pin this passage (adds it to the outline)"
          aria-label="Pin"
        >
          {ICON_PIN}
          <span>Pin</span>
        </button>
      )}
      {canAsk && (
        <span className="quote-pin-ask-group" ref={askGroupRef}>
          <button
            type="button"
            className="quote-pin-pill-btn"
            data-testid="quote-ask-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => ask()}
            title={`${ASK_MODE_LABEL[askMode]}: ${ASK_MODE_HINT[askMode].toLowerCase()}`}
            aria-label="Ask here"
          >
            {ICON_ASK}
            <span>Ask here</span>
          </button>
          <button
            ref={askCaretRef}
            type="button"
            className="quote-pin-pill-btn quote-ask-mode-btn"
            data-testid="quote-ask-mode-btn"
            aria-haspopup="menu"
            aria-expanded={askPick}
            aria-label="Choose how to ask: inline or in Tree"
            // Held like Comment's: the choice row about to take focus must not lose the passage.
            onPointerDown={(e) => { if (e.button === 0) hold(); }}
            onMouseDown={(e) => e.preventDefault()}
            // A second press on the caret closes its menu, as any dropdown's does.
            onClick={() => { if (askPick) { setAskPick(false); return; } hold(); setCommentOpen(false); setAskPick(true); }}
            title="Choose how to ask: inline or in Tree"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </span>
      )}
      {canQuote && !!state.text.trim() && (
        <button
          type="button"
          className="quote-pin-pill-btn"
          data-testid="quote-in-chat-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={quoteInChat}
          title="Quote this passage: it is listed above the message box and sent with your next message"
          aria-label="Quote"
        >
          {ICON_QUOTE}
          <span>Quote</span>
        </button>
      )}
      {canQuote && !!state.text.trim() && (
        <button
          ref={commentBtnRef}
          type="button"
          className="quote-pin-pill-btn"
          data-testid="quote-comment-btn"
          aria-haspopup="dialog"
          aria-expanded={commentOpen}
          // Hold now: the box about to take focus collapses the selection, and the
          // mousedown guard clears it before any click handler could hold it.
          onPointerDown={(e) => { if (e.button === 0) hold(); }}
          onMouseDown={(e) => e.preventDefault()}
          // The keyboard path has no pointerdown, and its selection is still live here.
          onClick={() => { hold(); setAskPick(false); setCommentOpen(true); }}
          title="Comment on this passage: the words stay marked, and the comment is sent with your next message"
          aria-label="Comment"
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
        aria-label="Copy"
      >
        {ICON_COPY}
        <span>Copy</span>
      </button>
    </div>
    {menu}
    </>,
    document.body,
  );
}
