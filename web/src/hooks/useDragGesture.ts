import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared primitive behind every drag-to-resize handle in the app.
 *
 * WHY THIS EXISTS (two real bugs it fixes at the root):
 *
 * 1. STUCK DRAGS. Every resize handle used to attach raw `mousemove`/`mouseup`
 *    to `document`. Mouse events are delivered to the document of whatever
 *    element is under the cursor — so the instant the cursor crossed an
 *    `<iframe>` (the Files panel's HTML preview `.fv-html-preview` sits
 *    directly beside its divider; Notes has PDF iframes) the parent page
 *    stopped seeing `mousemove` (drag appears frozen/laggy) and NEVER saw
 *    `mouseup`. The drag stayed armed forever: `body.cursor`/`user-select`
 *    remained set and the next click anywhere resumed resizing.
 *
 *    Pointer Events + `setPointerCapture` fix this at the source: once a
 *    pointer is captured, ALL of its subsequent events are retargeted to the
 *    capturing element regardless of what is visually under the cursor —
 *    iframes included. Plus every possible release path is handled
 *    (`pointerup`, `pointercancel`, `lostpointercapture`, window blur,
 *    Escape, unmount), each idempotent, so a drag can never stay armed.
 *
 * 2. LAG. Handlers ran one React commit per raw `mousemove` (120+/s on a
 *    trackpad), and five call sites additionally wrote `localStorage`
 *    synchronously on every frame via a `useEffect` keyed on the per-frame
 *    state — a blocking disk write per frame. Moves are now coalesced to one
 *    rAF (at most one commit per painted frame, latest position wins) and
 *    persistence is the caller's job on `onEnd` only.
 */

export interface DragMove {
  /** Pointer position now, in client coords. */
  x: number;
  y: number;
  /** Delta from the grab point. */
  dx: number;
  dy: number;
  /** Latest raw event of the frame (earlier ones in the same frame are dropped). */
  event: PointerEvent;
}

export interface DragGestureOptions {
  /** Body cursor held for the duration of the drag (e.g. 'col-resize'). */
  cursor?: string;
  /** Runs synchronously inside pointerdown — capture your start geometry here. */
  onStart?: (e: React.PointerEvent) => void;
  onMove: (m: DragMove) => void;
  /**
   * Always runs exactly once per drag. `canceled` is true when the gesture
   * ended by Escape / `pointercancel` / lost capture / window blur / unmount
   * rather than a real `pointerup`. Persist here — never per move.
   */
  onEnd?: (info: { canceled: boolean }) => void;
}

interface DragState {
  pointerId: number;
  /** Element holding pointer capture, or null when we fell back to document. */
  captureEl: HTMLElement | null;
  /** Node the move/up listeners are attached to. */
  listenEl: HTMLElement | Document;
  startX: number;
  startY: number;
  raf: number;
  pending: PointerEvent | null;
  /** One-shot compat-mousedown canceller; see onPointerDown. */
  killMouseDefault: ((e: Event) => void) | null;
}

export interface UseDragGestureReturn {
  /** Spread onto the handle element as `onPointerDown={...}`. */
  onPointerDown: (e: React.PointerEvent) => void;
  /** True for the duration of the gesture (for `.resizing` class toggles). */
  isDragging: boolean;
  /** Imperatively abort an in-flight drag (treated as canceled). */
  cancel: () => void;
}

export function useDragGesture(opts: DragGestureOptions): UseDragGestureReturn {
  // Latest callbacks without re-creating the pointerdown handler every frame.
  // The old hooks listed `[pct]`/`[ratio]` as deps, so the handler identity
  // churned once per drag frame on top of the re-render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [isDragging, setIsDragging] = useState(false);
  const stateRef = useRef<DragState | null>(null);
  // Handlers are stored so every release path can detach the exact same
  // function identities, whichever node they were attached to.
  const handlersRef = useRef<{ move: (e: Event) => void; up: (e: Event) => void; cancel: (e: Event) => void } | null>(null);

  const release = useCallback((canceled: boolean) => {
    const st = stateRef.current;
    // Null FIRST: releasePointerCapture below synchronously fires
    // `lostpointercapture`, which would otherwise re-enter this function.
    stateRef.current = null;
    if (!st) return;

    if (st.raf) cancelAnimationFrame(st.raf);
    // Apply the LAST coalesced position before finalizing. A fast flick-and-
    // release puts the final pointermove and the pointerup in the same painted
    // frame, so cancelling the pending rAF without flushing would drop that
    // frame — the panel settles short of the cursor AND onEnd persists the
    // second-to-last position, which then survives reload. Skipped when
    // canceled (Escape / lost capture / unmount shouldn't advance the value).
    const finalEv = st.pending;
    st.pending = null;
    if (!canceled && finalEv) {
      optsRef.current.onMove({
        x: finalEv.clientX,
        y: finalEv.clientY,
        dx: finalEv.clientX - st.startX,
        dy: finalEv.clientY - st.startY,
        event: finalEv,
      });
    }

    if (st.killMouseDefault) {
      document.removeEventListener('mousedown', st.killMouseDefault, true);
      st.killMouseDefault = null;
    }

    const h = handlersRef.current;
    handlersRef.current = null;
    if (h) {
      st.listenEl.removeEventListener('pointermove', h.move);
      st.listenEl.removeEventListener('pointerup', h.up);
      st.listenEl.removeEventListener('pointercancel', h.cancel);
      st.listenEl.removeEventListener('lostpointercapture', h.cancel);
    }
    if (st.captureEl) {
      // Throws if the element was unmounted mid-drag, or if capture already
      // ended implicitly on pointerup — both are fine, the capture is gone.
      try { st.captureEl.releasePointerCapture(st.pointerId); } catch { /* already released */ }
    }

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.classList.remove('walnut-dragging');
    setIsDragging(false);
    optsRef.current.onEnd?.({ canceled });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Primary button / single touch only — a right-click or a second finger
    // must not start a resize.
    if (e.button !== 0) return;
    // A stale gesture should be impossible now, but if one somehow survives,
    // finalize it rather than leaking its listeners.
    if (stateRef.current) release(true);

    // Do NOT preventDefault() the pointerdown. Per the Pointer Events spec a
    // canceled pointerdown suppresses its COMPATIBILITY MOUSE EVENTS entirely,
    // and ~25 menus/popovers in this app close themselves via a `document`
    // `mousedown` listener (kebab menus, DatePicker, fork dropdown, the
    // stale-selection clearer in main.tsx). Verified in Chromium: with
    // preventDefault the document mousedown never fires at all. Suppressing it
    // would leave an open menu floating while the resize ran underneath.
    //
    // Instead let mousedown through and cancel only its DEFAULT ACTION (text
    // selection / focus shift) with a one-shot capture-phase listener. It does
    // not stopPropagation, so every click-outside closer still sees the event —
    // which is exactly the old onMouseDown+preventDefault behavior.
    const killMouseDefault = (ev: Event) => {
      document.removeEventListener('mousedown', killMouseDefault, true);
      if (stateRef.current?.killMouseDefault === killMouseDefault) {
        stateRef.current.killMouseDefault = null;
      }
      ev.preventDefault();
    };
    document.addEventListener('mousedown', killMouseDefault, true);

    const el = e.currentTarget as HTMLElement;
    let captureEl: HTMLElement | null = el;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Capture unavailable (detached node, synthetic pointerId): fall back to
      // document listeners. Weaker — an iframe can still steal the pointer —
      // but the CSS `body.walnut-dragging iframe { pointer-events: none }`
      // shield covers exactly that case.
      captureEl = null;
    }

    const listenEl: HTMLElement | Document = captureEl ?? document;
    const st: DragState = {
      pointerId: e.pointerId,
      captureEl,
      listenEl,
      startX: e.clientX,
      startY: e.clientY,
      raf: 0,
      pending: null,
      killMouseDefault,
    };
    stateRef.current = st;

    const flush = () => {
      st.raf = 0;
      const ev = st.pending;
      st.pending = null;
      // A frame scheduled just before release must not fire a stale move.
      if (!ev || stateRef.current !== st) return;
      optsRef.current.onMove({
        x: ev.clientX,
        y: ev.clientY,
        dx: ev.clientX - st.startX,
        dy: ev.clientY - st.startY,
        event: ev,
      });
    };

    const move = (evt: Event) => {
      const ev = evt as PointerEvent;
      if (stateRef.current !== st || ev.pointerId !== st.pointerId) return;
      // Coalesce: keep only the newest position, run one callback per frame.
      st.pending = ev;
      if (!st.raf) st.raf = requestAnimationFrame(flush);
    };
    const up = (evt: Event) => {
      const ev = evt as PointerEvent;
      if (stateRef.current !== st || ev.pointerId !== st.pointerId) return;
      release(false);
    };
    const cancel = (evt: Event) => {
      const ev = evt as PointerEvent;
      if (stateRef.current !== st || ev.pointerId !== st.pointerId) return;
      release(true);
    };

    handlersRef.current = { move, up, cancel };
    listenEl.addEventListener('pointermove', move);
    listenEl.addEventListener('pointerup', up);
    listenEl.addEventListener('pointercancel', cancel);
    // Capture can be revoked by the browser (element removed, another capture
    // wins). Without this the drag would silently freeze while still armed.
    listenEl.addEventListener('lostpointercapture', cancel);

    if (opts.cursor) document.body.style.cursor = opts.cursor;
    document.body.style.userSelect = 'none';
    document.body.classList.add('walnut-dragging');
    setIsDragging(true);
    optsRef.current.onStart?.(e);
    // `opts.cursor` is constant per call site; everything else reads optsRef.
  }, [opts.cursor, release]);

  // Safety releases the pointer-event model can't express: the OS taking focus
  // (Cmd+Tab mid-drag), Escape, and unmount while dragging.
  useEffect(() => {
    const onBlur = () => release(true);
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') release(true); };
    // Last-resort net: the primary pointerup listener lives on the capture
    // element, so a handle that is conditionally unrendered MID-drag could take
    // it down with it and leave the gesture armed — the exact failure class this
    // hook exists to eliminate. window is the final bubble target, so in the
    // normal case the primary handler has already run and release() no-ops here
    // (it nulls its state first, making every path idempotent).
    const onWindowUp = () => release(false);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('blur', onBlur);
    // CAPTURE phase, deliberately: several panels call `stopPropagation()` on
    // their Escape keydown (close menu / clear selection), which would stop a
    // bubble-phase listener here from ever running — so aborting a drag with
    // Escape silently did nothing. Verified in Playwright: only the capture
    // listener saw the event. Aborting a drag must not be swallowable.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKeyDown, true);
      release(true);
    };
  }, [release]);

  const cancel = useCallback(() => release(true), [release]);

  return { onPointerDown, isDragging, cancel };
}
