/**
 * useQuotePinPaint — keeps every quote pin's yellow paint on the right words.
 *
 * A session message's DOM is not stable: streaming deltas re-set the body's
 * innerHTML, the markdown⇄rich toggle re-renders it entirely, and the windowed
 * tail mounts/unmounts older rows as the reader scrolls. So the paint cannot be
 * applied once — the Ranges have to be re-derived from the passage TEXT whenever
 * the container's DOM changes. That is what this hook does, and it is cheap by
 * construction: it never runs at all for a session with no quote pins, and when
 * it does run it indexes only the message bodies that actually hold one.
 *
 * `pinKey` (see pinKeyOf) is the map key throughout, because one message can hold
 * several passages.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { clearPanelPinRanges, setPanelPinRanges } from '@/utils/pin-highlights';
import { buildTextIndex, locateQuote, rangeFromOffsets } from '@/utils/text-quote-anchor';
import { pinKeyOf } from '@/hooks/useSessionPins';
import type { SessionPinnedMessage } from '@/types/session';
import { log } from '@/utils/log';

/** Streaming re-renders the body on every delta; re-locating per mutation would
 *  index the same paragraph dozens of times a second. */
const RELOCATE_DEBOUNCE_MS = 150;

/** Floor between two immediate (next-frame) repairs, i.e. at most ~4 per second.
 *  Above that rate the paint is chasing a body that re-renders continuously, and
 *  the debounced path is the cheaper answer. */
const REPAIR_MIN_GAP_MS = 250;

/**
 * Does this Range still address the passage?
 *
 * ⚠️ THE ONE THING TO KNOW ABOUT THIS FILE. When React re-renders a message body
 * it REPLACES the text node the pin's Range was built over. A Range is live, so it
 * does not break — the DOM spec says its boundary points move up to the removed
 * node's parent at the child index, which for a passage inside one text node means
 * start === end. The result is a COLLAPSED range whose containers are elements:
 *
 *   · `startContainer.isConnected` is still **true** (the parent is in the document)
 *   · `getClientRects()` is **empty**, so `::highlight()` paints nothing
 *   · `isPointInRange` can never match a caret
 *
 * `CSS.highlights` keeps holding it and `size` still reports 1, so every "is it
 * painted" signal says yes while the reader sees no yellow and a click on the
 * passage does nothing. Measured exactly that: a live-looking registry, `rects:
 * []`, `startConnected: true`, no hit. Judge staleness by the boundary SHAPE
 * (collapsed / no longer text nodes), never by connectivity.
 */
function isLive(range: Range): boolean {
  return !range.collapsed
    && range.startContainer.isConnected
    && range.endContainer.isConnected
    // rangeFromOffsets always anchors on text nodes; an element container means the
    // range has been re-pointed by a DOM removal.
    && range.startContainer.nodeType === Node.TEXT_NODE
    && range.endContainer.nodeType === Node.TEXT_NODE;
}

/** Is it actually drawing? Costs a layout read, so this is only used on the click
 *  path (once per click), never in the mutation loop. */
function isPainting(range: Range): boolean {
  if (!isLive(range)) return false;
  try {
    return range.getClientRects().length > 0;
  } catch {
    return false;
  }
}

export interface QuotePinPaint {
  /** Re-derive every painted Range now (after a jump expands the render window). */
  relocate: () => void;
  /** The passage's live Range, freshly located. null = not on screen. */
  locatePin: (pin: SessionPinnedMessage) => Range | null;
  /** Currently painted passages, for hit-testing a click (`::highlight` receives
   *  no events, so the popover has to ask the geometry itself). */
  paintedRanges: () => Array<{ pinKey: string; range: Range }>;
}

/** The message body a quote pin points into, or null when the row is not rendered
 *  (the render window is a tail slice). */
function bodyForMsgId(container: HTMLElement, msgId: string): Element | null {
  const row = container.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`);
  // One row wraps one SessionMessage, which owns exactly one `.session-msg-content`
  // — the first match IS the message body.
  return row?.querySelector('.session-msg-content') ?? null;
}

export function useQuotePinPaint(
  containerRef: RefObject<HTMLElement | null>,
  pins: SessionPinnedMessage[],
  panelKey: string,
  /** Bumped by the owner when the rendered message set changes (window expansion,
   *  output-mode toggle). The MutationObserver below is the backstop; this makes
   *  the common cases immediate instead of one debounce late. */
  renderNonce: number,
): QuotePinPaint {
  const quotePins = useMemo(() => pins.filter((p) => p.quote?.exact), [pins]);
  const rangesRef = useRef(new Map<string, Range>());

  const locatePin = useCallback((pin: SessionPinnedMessage): Range | null => {
    const container = containerRef.current;
    if (!container || !pin.quote?.exact) return null;
    const body = bodyForMsgId(container, pin.msgId);
    if (!body) return null;
    const index = buildTextIndex(body);
    const at = locateQuote(index.text, pin.quote);
    if (!at) return null;
    return rangeFromOffsets(index, at.start, at.end);
  }, [containerRef]);

  const relocate = useCallback(() => {
    const container = containerRef.current;
    const next = new Map<string, Range>();
    if (!container || quotePins.length === 0) {
      rangesRef.current = next;
      clearPanelPinRanges(panelKey);
      return;
    }
    // Index each rendered body ONCE even when it holds several pins.
    const indexed = new Map<Element, ReturnType<typeof buildTextIndex>>();
    let missing = 0;
    for (const pin of quotePins) {
      const body = bodyForMsgId(container, pin.msgId);
      if (!body) continue; // row outside the render window — nothing to paint yet
      let index = indexed.get(body);
      if (!index) { index = buildTextIndex(body); indexed.set(body, index); }
      const at = locateQuote(index.text, pin.quote!);
      if (!at) { missing++; continue; }
      const range = rangeFromOffsets(index, at.start, at.end);
      if (range) next.set(pinKeyOf(pin), range);
      else missing++;
    }
    rangesRef.current = next;
    setPanelPinRanges(panelKey, [...next.values()]);
    if (missing > 0) {
      // Not an error: the passage may have been edited away or /compact rewrote
      // the message. Worth a line, because a pin that never paints looks broken.
      log.info('session', 'quote pins whose passage no longer matches the rendered text', {
        panelKey, missing, total: quotePins.length,
      });
    }
  }, [containerRef, quotePins, panelKey]);

  // Latest relocate, reachable from the stable callbacks below without making
  // their identity change (the popover's listener effect depends on it).
  const relocateRef = useRef(relocate);
  useEffect(() => { relocateRef.current = relocate; }, [relocate]);

  const hasStaleRange = useCallback(() => {
    for (const range of rangesRef.current.values()) if (!isLive(range)) return true;
    return false;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    // Early return BEFORE observing: a session with no quote pins costs nothing.
    if (!container || quotePins.length === 0) {
      rangesRef.current = new Map();
      clearPanelPinRanges(panelKey);
      return;
    }
    relocate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let lastRepairAt = 0;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(relocate, RELOCATE_DEBOUNCE_MS);
    };
    const onMutations = () => {
      // A collapsed Range is a HOLE in the feature (no yellow, no hit test), not a
      // stale optimisation, so the FIRST one after a quiet moment is repaired on the
      // next frame instead of after the debounce. Mutations that leave the ranges
      // intact keep the cheap trailing debounce.
      if (hasStaleRange()) {
        const now = Date.now();
        // …but a body that re-renders every frame (heavy streaming) must not buy a
        // re-index every frame: a text index over a 139KB body measured 18.6ms, which
        // at 60fps would own the main thread. Past ~4 repairs/second, fall back to the
        // debounce and let the click path repair on demand instead.
        if (now - lastRepairAt < REPAIR_MIN_GAP_MS) { schedule(); return; }
        lastRepairAt = now;
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; relocate(); });
        return;
      }
      schedule();
    };
    // Painting never mutates the DOM, so this observer cannot feed itself.
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(onMutations) : null;
    observer?.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      observer?.disconnect();
      clearPanelPinRanges(panelKey);
    };
    // renderNonce is a deliberate trigger, not a value this effect reads.
  }, [containerRef, quotePins, panelKey, relocate, hasStaleRange, renderNonce]);

  const paintedRanges = useCallback(() => {
    // Repair before answering: the caller is hit-testing a click against what the
    // reader can SEE, and a collapsed Range is invisible to them. The rect check is
    // affordable here (one click) and catches anything the O(1) shape test misses.
    for (const range of rangesRef.current.values()) {
      if (!isPainting(range)) { relocateRef.current(); break; }
    }
    return [...rangesRef.current.entries()].map(([pinKey, range]) => ({ pinKey, range }));
  }, []);

  return useMemo(
    () => ({ relocate, locatePin, paintedRanges }),
    [relocate, locatePin, paintedRanges],
  );
}
