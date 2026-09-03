/**
 * QuotePinPopover — click a painted passage to see what was pinned and unpin it.
 *
 * `::highlight()` paint receives no events at all (it is not an element), so the
 * press cannot be delivered by the passage itself. The hit test is geometric
 * instead: is the pointer inside one of the painted Range's line boxes, and
 * failing that, does the caret under the pointer fall inside the Range. Rects
 * first because they are literally the yellow the user aimed at, while a caret
 * lookup depends on which of the two caret APIs the engine ships and on where in
 * a glyph the pointer landed. A miss does nothing, so ordinary clicking, link
 * following and text selection inside a pinned passage keep working as before.
 *
 * Overlay rules (web/src/AGENTS.md): portalled to <body>, placed by
 * `useMenuPlacement` so it cannot overflow the viewport, `onPointerDown`
 * stopPropagation so a press can't reach a drag sensor, Escape and outside-click
 * dismissal — with its own portal exempted from "outside", or the mousedown that
 * precedes a click on Unpin would close the popover before the click lands.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { pinKeyOf, pinLabelFor } from '@/hooks/useSessionPins';
import type { SessionPinnedMessage } from '@/types/session';

interface QuotePinPopoverProps {
  containerRef: React.RefObject<HTMLElement | null>;
  pins: SessionPinnedMessage[];
  /** Painted passages to hit-test (from useQuotePinPaint). */
  paintedRanges: () => Array<{ pinKey: string; range: Range }>;
  onUnpin: (pinKey: string) => void;
}

interface OpenState {
  pinKey: string;
  anchor: { x: number; y: number };
}

/** Clicks that belong to the content, not to the pin. */
const INTERACTIVE = 'a, button, input, textarea, select, [contenteditable="true"], [role="button"]';

/** Is the point inside one of the range's painted line boxes? This is the primary
 *  hit test: those rects ARE the yellow the user aimed at, and unlike a caret
 *  lookup they don't depend on which of the two caret APIs the engine implements
 *  or on where in a glyph the pointer landed. */
function pointInRangeRects(range: Range, x: number, y: number): boolean {
  const rects = range.getClientRects();
  for (const r of rects) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

/** The line box the popover hangs under: the passage's FIRST line, so a passage
 *  that wraps is labelled at its beginning. `null` = the range no longer has a
 *  box (its text was re-rendered away), which is the signal to close. */
function anchorRectOf(range: Range): DOMRect | null {
  let rect: DOMRect | null = null;
  try {
    const rects = range.getClientRects();
    rect = rects.length ? rects[0]! : range.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!rect || (!rect.width && !rect.height)) return null;
  return rect;
}

/** Caret position under a viewport point. WebKit only has caretRangeFromPoint;
 *  Chrome has both (and is deprecating the old one). */
function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

export function QuotePinPopover({ containerRef, pins, paintedRanges, onUnpin }: QuotePinPopoverProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  const placement = useMenuPlacement(!!open, noTrigger, menuRef, {
    anchorPoint: open?.anchor ?? null,
    align: 'center',
    gap: 6,
    minHeight: 40,
  });

  const pin = useMemo(
    () => (open ? pins.find((p) => pinKeyOf(p) === open.pinKey) ?? null : null),
    [open, pins],
  );

  // The pin can vanish under the popover (unpinned in another tab, session
  // switch) — close rather than render an empty card.
  useEffect(() => {
    if (open && !pin) setOpen(null);
  }, [open, pin]);

  useEffect(() => {
    /**
     * `pointerup`, NOT `click` — and this is a WebKit correctness fix, not a style
     * preference. A message body re-renders for all sorts of reasons (the pin PATCH
     * echo, a status push, any streaming delta), and when the text node under the
     * pointer is replaced between mousedown and mouseup, WebKit finds no common
     * ancestor to target and DROPS the `click` event entirely, while Chromium
     * retargets it to the parent. So on the Mac app (a WKWebView) clicking a painted
     * passage did nothing, reproducibly, in a couple of runs out of eight. `pointerup`
     * always fires at the position the finger/mouse actually lifted.
     *
     * Everything else about the old contract is kept: it is passive (no
     * preventDefault, so a link inside a pinned passage still navigates on the click
     * that follows), a non-collapsed selection means this was a drag and is ignored,
     * and interactive targets are left alone. There must be exactly ONE such
     * listener: keeping `click` as well would fire the hit test twice per press.
     *
     * Listener on `document`, not on the container: this effect runs once (its deps
     * are stable), so binding to `containerRef.current` would silently bind to
     * nothing on any render where the container is not mounted yet. Containment is
     * checked per event instead.
     */
    const onRelease = (e: MouseEvent | PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const container = containerRef.current;
      if (!container || !target || !container.contains(target)) return;
      if (target.closest(INTERACTIVE)) return;
      // A drag that ends here leaves its selection standing: that press was the
      // user selecting text (the pill's job), not aiming at a pin.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (e.type === 'pointerup' && (e as PointerEvent).isPrimary === false) return;
      // Caret resolution is the tie-breaker, not the gate: it is only consulted
      // when the pointer is not inside any painted box.
      let caret: { node: Node; offset: number } | null | undefined;
      for (const { pinKey, range } of paintedRanges()) {
        let inside = false;
        try {
          inside = pointInRangeRects(range, e.clientX, e.clientY);
          if (!inside) {
            if (caret === undefined) caret = caretAtPoint(e.clientX, e.clientY);
            inside = !!caret && range.isPointInRange(caret.node, caret.offset);
          }
        } catch { /* range re-pointed by a DOM removal, or another root */ }
        if (!inside) continue;
        const rect = anchorRectOf(range);
        if (!rect) continue;
        setOpen({
          pinKey,
          anchor: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom) },
        });
        return;
      }
      setOpen(null);
    };
    // One listener only. `mouseup` is the fallback for an engine without
    // PointerEvent; every engine that has it also fires mouseup, so registering
    // both would run the hit test twice for one press.
    const release = typeof window.PointerEvent === 'function' ? 'pointerup' : 'mouseup';
    document.addEventListener(release, onRelease as EventListener);
    return () => document.removeEventListener(release, onRelease as EventListener);
  }, [containerRef, paintedRanges]);

  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    const onDown = (e: MouseEvent) => {
      // Exempt our OWN portal: it is not inside the container, so a naive
      // "outside" test would close it on the mousedown of its own Unpin click.
      if ((e.target as HTMLElement | null)?.closest('.quote-pin-popover')) return;
      setOpen(null);
    };
    /**
     * A scroll RE-ANCHORS the popover to the passage instead of closing it.
     *
     * Closing on any scroll read as tidy and was wrong twice over. It is a
     * document-wide capture listener, so a scroll in ANY other pane (the task
     * list, another session column) shut a popover the user was reading; and the
     * timeline scrolls itself while following the bottom, which closed the popover
     * within a frame of opening it (measured as an intermittent "the popover never
     * appeared"). The passage's Range is live, so its real position is always one
     * `getClientRects()` away — track it, and only close when it goes.
     */
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setOpen((prev) => {
          if (!prev) return prev;
          const entry = paintedRanges().find((r) => r.pinKey === prev.pinKey);
          const rect = entry ? anchorRectOf(entry.range) : null;
          if (!rect) return null; // passage unmounted (scrolled out of the window)
          const box = containerRef.current?.getBoundingClientRect();
          // Out of the timeline's visible box: placement would clamp the popover
          // back into the viewport, leaving it pointing at nothing.
          if (box && (rect.bottom < box.top || rect.top > box.bottom)) return null;
          const x = Math.round(rect.left + rect.width / 2);
          const y = Math.round(rect.bottom);
          if (prev.anchor.x === x && prev.anchor.y === y) return prev;
          return { ...prev, anchor: { x, y } };
        });
      });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [isOpen, containerRef, paintedRanges]);

  const unpin = useCallback(() => {
    if (open) onUnpin(open.pinKey);
    setOpen(null);
  }, [onUnpin, open]);

  if (!open || !pin) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="quote-pin-popover"
      style={menuPlacementStyle(placement)}
      role="dialog"
      aria-label="Pinned passage"
      data-testid="quote-pin-popover"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="quote-pin-popover-snippet" title={pin.quote?.exact}>
        {'❝ '}{pinLabelFor(pin.quote?.exact, 'Quoted passage')}
      </span>
      <button type="button" className="quote-pin-popover-unpin" onClick={unpin}>
        Unpin
      </button>
    </div>,
    document.body,
  );
}
