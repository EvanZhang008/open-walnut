/**
 * The panel's side of the chat's reading split (reader-split.tsx has the why):
 * whether it shows, which way, the reading pane's share and its drag, and the ways
 * in. The panel keeps the record per place (panel-view.ts `reader`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { clampReaderShare, type ReaderSplitRecord } from './panel-view';
import { keepReaderPlace, readerPlaceFrom, type SessionReaderApi } from './reader-split';
import type { ReadingPlace } from './reading-place';
import { log } from '@/utils/log';

/** Side by side needs this much width for two readable columns. */
export const READER_SIDE_MIN_PX = 760;

export interface UseReaderSplitArgs {
  sessionId: string;
  /** The split can show here (a desktop panel's own chat, not Tree Mode's split). */
  offered: boolean;
  record: ReaderSplitRecord;
  setRecord: (update: (prev: ReaderSplitRecord) => ReaderSplitRecord) => void;
  /** The panel's chat body (its scroll box is the `.session-history` inside). */
  bodyRef: RefObject<HTMLElement | null>;
  /** The chat column, measured for side by side while the split shows. */
  colRef: RefObject<HTMLElement | null>;
  /** The page the panel's timeline shows (placeKeyOf): the reading pane keeps its place under it. */
  pageKey: string;
  /** Opened on a message: the chat under it goes to its end and its composer takes the focus. */
  onOpenedOnRow: () => void;
}

export function useReaderSplit(a: UseReaderSplitArgs) {
  const { sessionId, offered, record, setRecord, bodyRef, colRef, pageKey, onOpenedOnRow } = a;
  const shown = offered && record.on;
  /** A new place to land on remounts the reading pane's timeline. */
  const [land, setLand] = useState(0);
  const [colWidth, setColWidth] = useState(0);

  // Measured before paint, so a kept side by side never draws stacked for a frame.
  useLayoutEffect(() => {
    const el = colRef.current;
    if (!shown || !el) return;
    setColWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setColWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown, colRef]);
  const canSide = colWidth >= READER_SIDE_MIN_PX;
  const orient: 'stack' | 'side' = record.orient === 'side' && canSide ? 'side' : 'stack';
  /**
   * The pane mounts only once the column's way is known: it lands on its place in its first
   * layout effect, which runs before this hook's measure, so a pane mounted stacked and then
   * turned side by side reflowed off the message it had landed on (a reload, side by side).
   */
  const paneReady = shown && (record.orient !== 'side' || colWidth > 0);

  /**
   * The place the next mount of the pane lands on. Written by `takeLanding`, from the
   * pane's own layout effect, after the pane it replaces has unmounted: an open pane
   * records its place as it goes, which would overwrite a landing written earlier.
   */
  const landing = useRef<{ pageKey: string; place: ReadingPlace } | null>(null);
  const takeLanding = useCallback(() => {
    const next = landing.current;
    landing.current = null;
    if (next) keepReaderPlace(sessionId, next.pageKey, next.place);
  }, [sessionId]);

  const open = useCallback((target?: Element | null) => {
    const box = bodyRef.current?.querySelector<HTMLElement>('.session-history');
    const place = box ? readerPlaceFrom(box, target) : null;
    landing.current = place ? { pageKey, place } : null;
    // A message's own way in (its strip, its menu) passes it, null when it was not found.
    const onMessage = target !== undefined;
    log.info('session-reader', 'open reading split', { sessionId, from: onMessage ? 'message' : 'view', rows: place?.rows.length ?? 0 });
    setLand((n) => n + 1);
    setRecord((prev) => (prev.on ? prev : { ...prev, on: true }));
    if (onMessage) onOpenedOnRow();
  }, [bodyRef, sessionId, pageKey, setRecord, onOpenedOnRow]);

  const close = useCallback(() => {
    log.info('session-reader', 'close reading split', { sessionId });
    setRecord((prev) => ({ ...prev, on: false }));
  }, [sessionId, setRecord]);

  /**
   * Turning the split changes the pane's width, so its text rewraps and the line being read
   * would slide away (2026-11-12 prod recording: side by side moved it from the top to the
   * bottom). What it shows now lands again in the new width, as a new place does.
   */
  const setOrient = useCallback((next: 'stack' | 'side') => {
    const box = colRef.current?.querySelector<HTMLElement>('.session-reader-body .session-history');
    const place = box ? readerPlaceFrom(box) : null;
    if (place) {
      landing.current = { pageKey, place };
      setLand((n) => n + 1);
    }
    setRecord((prev) => ({ ...prev, orient: next }));
  }, [colRef, pageKey, setRecord]);

  const share = clampReaderShare(record.share);
  /** The drag in progress ends here (pointer up, cancel, capture lost, or the panel going). */
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  /**
   * The divider: drag to share the column; a double click splits it in half. A move
   * sets the column's two shares on the element itself (no render per move); the
   * share is kept once, when the drag ends.
   */
  const onDividerPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const col = colRef.current;
    const pane = col?.querySelector<HTMLElement>('.session-reader-pane');
    const body = bodyRef.current;
    if (!col || !pane || !body) return;
    e.preventDefault();
    endDrag.current?.();
    const side = orient === 'side';
    const p = pane.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const start = side ? p.left : p.top;
    const span = (side ? b.right : b.bottom) - start;
    if (span <= 0) return;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    try { target.setPointerCapture?.(pointerId); } catch { /* a pointer already gone */ }
    col.classList.add('is-reader-dragging');
    let last = share;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      last = clampReaderShare(((side ? ev.clientX : ev.clientY) - start) / span);
      moved = true;
      col.style.setProperty('--reader-a', `${last}fr`);
      col.style.setProperty('--reader-b', `${1 - last}fr`);
    };
    const end = () => {
      if (endDrag.current !== end) return;
      endDrag.current = null;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      target.removeEventListener('lostpointercapture', end);
      col.classList.remove('is-reader-dragging');
      if (!moved) return;
      const kept = Math.round(last * 1000) / 1000;
      setRecord((prev) => ({ ...prev, share: kept }));
    };
    endDrag.current = end;
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
  }, [colRef, bodyRef, orient, share, setRecord]);
  const onDividerDoubleClick = useCallback(() => setRecord((prev) => ({ ...prev, share: 0.5 })), [setRecord]);

  const api = useMemo<SessionReaderApi | null>(() => (offered ? { open } : null), [offered, open]);
  const colClass = shown ? ` has-reader is-reader-${orient}` : '';
  const colVars = useMemo<CSSProperties | undefined>(() => (shown ? {
    ['--reader-a' as string]: `${share}fr`,
    ['--reader-b' as string]: `${1 - share}fr`,
  } as CSSProperties : undefined), [shown, share]);

  return {
    shown, paneReady, orient, canSide, land, takeLanding, api, colClass, colVars,
    open, close, setOrient,
    divider: { onPointerDown: onDividerPointerDown, onDoubleClick: onDividerDoubleClick },
  };
}
