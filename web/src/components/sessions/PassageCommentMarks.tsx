/**
 * PassageCommentMarks — a comment stays on the words it was left on (2026-11-01,
 * the user: "the commented words get marked ... the comment still shows there").
 *
 *   paint     CSS highlights over each passage: `walnut-comment` while the comment
 *             waits for the next send, `walnut-comment-sent` after (quieter)
 *   marker    a small chip at the passage's end, a real button: hover reads the
 *             comment, a press opens the card
 *   card      the passage, the whole comment, whether it was sent, Remove
 *
 * The paint and the Range bookkeeping are useQuotePinPaint's (the same repair
 * rules as quote pins). Markers are fixed-position chips in a <body> portal,
 * placed from the live Ranges after every relocate, scroll and resize, and hidden
 * outside the timeline's visible box. A session with no comments installs nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuotePinPaint } from '@/hooks/useQuotePinPaint';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { HL_COMMENT, HL_COMMENT_SENT, panelLayer } from '@/utils/pin-highlights';
import { snippetOf } from '@/utils/passage-comments';
import type { SessionPassageComment } from '@/types/session';
import { anchorRectOf, caretAtPoint, pointInRangeRects } from './QuotePinPopover';
import '@/styles/passage-comments.css';

const PENDING_LAYER = panelLayer(HL_COMMENT);
const SENT_LAYER = panelLayer(HL_COMMENT_SENT);
const INTERACTIVE = 'a, button, input, textarea, select, [contenteditable="true"], [role="button"]';
const MARKER_SIZE = 14;

interface Props {
  containerRef: RefObject<HTMLElement | null>;
  comments: SessionPassageComment[];
  panelKey: string;
  renderNonce: number;
  onRemove: (id: string) => void;
  /** The page under the marks changed: an open card closes. */
  resetKey?: string;
}

interface Marker { id: string; x: number; y: number; sent: boolean; comment: string }

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function PassageCommentMarks({ containerRef, comments, panelKey, renderNonce, onRemove, resetKey }: Props) {
  // A plain Quote leaves no mark once sent; a comment does.
  // A doc comment's words are in its doc (DocCommentsLayer), not in this transcript.
  const pending = useMemo(() => comments.filter((c) => !c.doc && !c.sentAt && !c.removedAt), [comments]);
  const sent = useMemo(() => comments.filter((c) => !c.doc && c.sentAt && !c.removedAt && c.comment.trim()), [comments]);
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);

  const [tick, setTick] = useState(0);
  const raf = useRef(0);
  const bump = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; setTick((n) => n + 1); });
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const pendingPaint = useQuotePinPaint(containerRef, pending, `${panelKey}:c`, renderNonce, { layer: PENDING_LAYER, onPainted: bump });
  const sentPaint = useQuotePinPaint(containerRef, sent, `${panelKey}:cs`, renderNonce, { layer: SENT_LAYER, onPainted: bump });

  const painted = useCallback(
    () => [...pendingPaint.paintedRanges(), ...sentPaint.paintedRanges()].map(({ pinKey, range }) => ({ id: pinKey, range })),
    [pendingPaint, sentPaint],
  );

  const any = pending.length + sent.length > 0;
  useEffect(() => {
    if (!any) return;
    const container = containerRef.current;
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    const ro = typeof ResizeObserver !== 'undefined' && container ? new ResizeObserver(bump) : null;
    if (ro && container) ro.observe(container);
    bump();
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
      ro?.disconnect();
    };
  }, [any, containerRef, bump]);

  const markers = useMemo<Marker[]>(() => {
    void tick;
    const box = containerRef.current?.getBoundingClientRect();
    if (!any || !box) return [];
    const out: Marker[] = [];
    for (const { id, range } of painted()) {
      const c = byId.get(id);
      if (!c) continue;
      let rects: DOMRectList;
      try { rects = range.getClientRects(); } catch { continue; }
      const last = rects.length ? rects[rects.length - 1]! : null;
      if (!last || (!last.width && !last.height)) continue;
      if (last.bottom < box.top || last.top > box.bottom) continue;
      // In the margin right of the message, level with the passage's last line (a
      // doc's comment margin): a chip beside the words would cover the next ones.
      const end = range.endContainer;
      const row = (end instanceof Element ? end : end.parentElement)?.closest('[data-message-id]');
      const right = row ? row.getBoundingClientRect().right : last.right;
      let x = Math.min(right + 4, box.right - MARKER_SIZE - 2);
      const y = Math.round(last.top + (last.height - MARKER_SIZE) / 2);
      // Two passages ending on one line: side by side, never stacked on one spot.
      while (out.some((m) => Math.abs(m.y - y) < MARKER_SIZE && Math.abs(m.x - x) < MARKER_SIZE)) x -= MARKER_SIZE + 2;
      out.push({ id, x: Math.round(x), y, sent: !!c.sentAt, comment: c.comment });
    }
    return out;
    // `painted` reads live Ranges; `tick` is the re-read trigger.
  }, [tick, any, byId, painted, containerRef]);

  // ── The card ──────────────────────────────────────────────────────────────
  const [open, setOpen] = useState<{ id: string; anchor: { x: number; y: number } } | null>(null);
  useEffect(() => { setOpen(null); }, [resetKey]);
  const openItem = open ? byId.get(open.id) ?? null : null;
  useEffect(() => { if (open && !openItem) setOpen(null); }, [open, openItem]);

  const openAt = useCallback((id: string, fallback?: { x: number; y: number }) => {
    const entry = painted().find((p) => p.id === id);
    const rect = entry ? anchorRectOf(entry.range) : null;
    const anchor = rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom) } : fallback;
    if (anchor) setOpen({ id, anchor });
  }, [painted]);

  // A press on the marked words opens the card too (the paint takes no events).
  useEffect(() => {
    if (!any) return;
    const onRelease = (e: PointerEvent | MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const container = containerRef.current;
      if (!container || !target || !container.contains(target) || target.closest(INTERACTIVE)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      let caret: { node: Node; offset: number } | null | undefined;
      for (const { id, range } of painted()) {
        let inside = false;
        try {
          inside = pointInRangeRects(range, e.clientX, e.clientY);
          if (!inside) {
            if (caret === undefined) caret = caretAtPoint(e.clientX, e.clientY);
            inside = !!caret && range.isPointInRange(caret.node, caret.offset);
          }
        } catch { /* a range re-pointed by a DOM removal */ }
        if (inside) { openAt(id); return; }
      }
    };
    const release = typeof window.PointerEvent === 'function' ? 'pointerup' : 'mouseup';
    document.addEventListener(release, onRelease as EventListener);
    return () => document.removeEventListener(release, onRelease as EventListener);
  }, [any, containerRef, painted, openAt]);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  const placement = useMenuPlacement(!!open, noTrigger, cardRef, {
    anchorPoint: open?.anchor ?? null, align: 'center', gap: 6, minHeight: 60,
  });
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.passage-comment-card, .passage-comment-marker')) return;
      setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [isOpen]);
  // Follow the passage while the timeline scrolls; close when it leaves the view.
  useEffect(() => {
    if (!open) return;
    const entry = painted().find((p) => p.id === open.id);
    const rect = entry ? anchorRectOf(entry.range) : null;
    const box = containerRef.current?.getBoundingClientRect();
    if (!rect || (box && (rect.bottom < box.top || rect.top > box.bottom))) { setOpen(null); return; }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.bottom);
    if (x !== open.anchor.x || y !== open.anchor.y) setOpen({ id: open.id, anchor: { x, y } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-anchored on every marker re-read
  }, [tick]);

  if (!any) return null;
  return createPortal(
    <>
      {markers.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`passage-comment-marker${m.sent ? ' is-sent' : ''}`}
          style={{ left: m.x, top: m.y }}
          data-testid="passage-comment-marker"
          data-comment-id={m.id}
          title={m.comment || 'Quoted'}
          aria-label={m.comment ? `Comment: ${m.comment}` : 'Quoted passage'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => (open?.id === m.id ? setOpen(null) : openAt(m.id, { x: m.x, y: m.y + MARKER_SIZE }))}
        >
          {m.comment ? (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M2 2h12a1 1 0 011 1v8a1 1 0 01-1 1H6l-3.5 3V12H2a1 1 0 01-1-1V3a1 1 0 011-1z" />
            </svg>
          ) : (
            <span aria-hidden="true">❝</span>
          )}
        </button>
      ))}
      {open && openItem && (
        <div
          ref={cardRef}
          className="passage-comment-card"
          style={menuPlacementStyle(placement)}
          role="dialog"
          aria-label={openItem.comment ? 'Comment' : 'Quote'}
          data-testid="passage-comment-card"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="passage-comment-card-head">
            <span>{openItem.comment ? 'Comment' : 'Quote'}</span>
            <span className="passage-comment-card-state">
              {openItem.sentAt ? `Sent ${timeOf(openItem.sentAt)}` : 'Goes with your next message'}
            </span>
          </div>
          <div className="passage-comment-card-quote" title={openItem.text}>❝ {snippetOf(openItem.text, 120)}</div>
          {openItem.comment && <div className="passage-comment-card-text">{openItem.comment}</div>}
          <div className="passage-comment-card-actions">
            <button
              type="button"
              className="passage-comment-card-remove"
              data-testid="passage-comment-remove"
              onClick={() => { onRemove(openItem.id); setOpen(null); }}
            >
              {openItem.sentAt ? 'Remove mark' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
