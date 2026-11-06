/**
 * PassageCommentMarks — a comment stays on the words it was left on (2026-11-01,
 * the user: "the commented words get marked ... the comment still shows there").
 *
 *   paint     CSS highlights over each passage: `walnut-comment` while the comment
 *             waits for the next send, `walnut-comment-sent` after (quieter)
 *   marker    a small chip at the passage's end, a real button: hover reads the
 *             comment, a press opens the card
 *   card      the passage, the whole comment, whether it was sent, Remove; while it
 *             waits for the send, Edit (or a click on its words) changes them in
 *             place (2026-11-06, the user: "comment need to be able to edit"):
 *             Save, Enter or a press outside keeps the new words (a press on the
 *             composer's Send included, so what goes is what the reader sees),
 *             Cancel or Esc the old ones
 *
 * The paint and the Range bookkeeping are useQuotePinPaint's (the same repair
 * rules as quote pins). Markers are fixed-position chips in a <body> portal,
 * placed from the live Ranges after every relocate, scroll and resize, and hidden
 * outside the timeline's visible box. A session with no comments installs nothing.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuotePinPaint } from '@/hooks/useQuotePinPaint';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { HL_COMMENT, HL_COMMENT_SENT, panelLayer } from '@/utils/pin-highlights';
import { MAX_COMMENT_CHARS, snippetOf } from '@/utils/passage-comments';
import { AnswerBox } from '@/components/common/AnswerBox';
import { isImeKey } from '@/hooks/usePanelKeyRouter';
import { log } from '@/utils/log';
import type { SessionPassageComment } from '@/types/session';
import type { SessionCommentsApi } from '@/contexts/SessionCommentsContext';
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
  /** Change a pending one's words; FALSE when it cannot be (it is being sent). */
  onUpdate?: (id: string, comment: string) => boolean;
  /** The store's newest jump: one asking `edit` opens that card in its editor. */
  jump?: SessionCommentsApi['jump'];
  /** The page under the marks changed: an open card closes. */
  resetKey?: string;
}

/** How long a tray row's Edit waits for its passage to come into view and settle. */
const EDIT_JUMP_WAIT_MS = 5_000;

interface Marker { id: string; x: number; y: number; sent: boolean; comment: string }

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function PassageCommentMarks({ containerRef, comments, panelKey, renderNonce, onRemove, onUpdate, jump, resetKey }: Props) {
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

  // ── Editing the words (only while they wait for the send) ────────────────
  /** FALSE when the editor opens late (a tray row's Edit) and the reader has gone on to type elsewhere. */
  const focusEditor = useRef(true);
  /** The id whose words are in the editor, and the words as typed so far. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const canEdit = !!onUpdate && !!openItem && !openItem.sentAt && !openItem.doc;
  const isEditing = canEdit && editing === openItem.id;
  // Another card, a closed one, or a comment sent meanwhile: the editor goes, the saved words stay.
  useEffect(() => { if (!isEditing && editing !== null) setEditing(null); }, [isEditing, editing]);
  /** The id in the editor right now (a ref, for the handlers that outlive a render). */
  const editingId = useRef<string | null>(null);
  editingId.current = isEditing ? editing : null;
  const startEdit = useCallback((id: string) => {
    const c = byId.get(id);
    if (!c || c.sentAt || c.doc || !onUpdate) {
      // Sent meanwhile: no editor, and the next Edit takes the focus as usual.
      focusEditor.current = true;
      return;
    }
    // Already in the editor (a tray row's Edit on the comment being edited): the typed
    // words stay, and the next Edit takes the focus as usual.
    if (editingId.current === id) { focusEditor.current = true; return; }
    setDraft(c.comment);
    setEditing(id);
  }, [byId, onUpdate]);
  // The tray's timer opens the editor seconds later: on the words as they are then.
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;
  /** Save was refused: a send has just taken this one. */
  const [refused, setRefused] = useState(false);
  useEffect(() => { setRefused(false); }, [isEditing]);
  const editBox = useRef<HTMLTextAreaElement | null>(null);
  const editBtn = useRef<HTMLButtonElement | null>(null);
  const refocusEdit = useRef(false);
  // The editor opens with the caret after the last word, the end of a long comment in view.
  useLayoutEffect(() => {
    if (!isEditing) return;
    const el = editBox.current;
    if (!el) return;
    const take = focusEditor.current;
    focusEditor.current = true;
    if (take) el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
    el.scrollTop = el.scrollHeight;
  }, [isEditing]);
  // Back from the editor by the keyboard: the focus waits on Edit, so a second Esc closes the card.
  useEffect(() => {
    if (isEditing || !refocusEdit.current) return;
    refocusEdit.current = false;
    editBtn.current?.focus({ preventScroll: true });
  }, [isEditing]);
  const cancelEdit = useCallback(() => { refocusEdit.current = true; setEditing(null); }, []);
  const saveEdit = useCallback((text: string) => {
    if (!openItem || !onUpdate) return;
    const words = text.trim();
    if (!words) return;
    // Refused = a send has just taken it: the words stay in the editor, and the
    // editor goes once the card shows it sent.
    if (words === openItem.comment || onUpdate(openItem.id, words)) { refocusEdit.current = true; setEditing(null); return; }
    setRefused(true);
  }, [openItem, onUpdate]);
  /**
   * A press or a focus outside the open editor keeps what was typed (synchronously,
   * before the press's own click or the key that follows the focus: a Send carries
   * these words). Empty or unchanged words keep the saved ones. `refused` = a send
   * holds it: the card stays open on the typed words with the hint.
   */
  const commitDraft = useRef<(via: 'press' | 'focus') => 'none' | 'saved' | 'refused'>(() => 'none');
  commitDraft.current = (via) => {
    if (!isEditing || !openItem || !onUpdate) return 'none';
    const words = draft.trim();
    if (!words || words === openItem.comment) return 'none';
    const ok = onUpdate(openItem.id, words);
    log.info('session', 'passage comment edit kept on leaving the editor', { id: openItem.id, via, saved: ok });
    if (!ok) { setRefused(true); return 'refused'; }
    return 'saved';
  };

  // A tray row's Edit: once its passage is in view and has stopped moving (the jump
  // scrolls to it), its card opens in the editor. Each request lands once.
  const jumpSeen = useRef(jump?.seq ?? 0);
  const paintedRef = useRef(painted);
  paintedRef.current = painted;
  useEffect(() => {
    if (!jump || jump.seq === jumpSeen.current) return;
    jumpSeen.current = jump.seq;
    if (!jump.edit) return;
    const { id, origin } = jump;
    // The editor takes the focus only if it is still where the press left it and
    // nothing was typed since (the reader went on in the composer: it stays theirs).
    const pressFocus = document.activeElement;
    let typed = false;
    const onType = () => { typed = true; };
    document.addEventListener('keydown', onType, true);
    const until = Date.now() + EDIT_JUMP_WAIT_MS;
    let last = '';
    const stop = () => { clearInterval(timer); document.removeEventListener('keydown', onType, true); };
    const openEditor = (anchor: { x: number; y: number }) => {
      stop();
      focusEditor.current = !typed && document.activeElement === pressFocus;
      setOpen({ id, anchor });
      startEditRef.current(id);
    };
    const timer = setInterval(() => {
      const entry = paintedRef.current().find((p) => p.id === id);
      const rect = entry ? anchorRectOf(entry.range) : null;
      const box = containerRef.current?.getBoundingClientRect();
      const inView = !!rect && !!box && rect.top >= box.top && rect.bottom <= box.bottom;
      const at = rect ? `${Math.round(rect.left)},${Math.round(rect.top)}` : '';
      const anchor = rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom) } : null;
      if (inView && at === last) { openEditor(anchor!); return; }
      last = at;
      if (Date.now() <= until) return;
      // Its passage never settled in view (not loaded, on another page): the card
      // opens anyway, at its passage when it is in view, else at the row it was asked from.
      log.warn('session', 'passage comment edit: its passage did not settle in view, opening the card where it can', {
        id, painted: !!rect, inView, waitedMs: EDIT_JUMP_WAIT_MS,
      });
      if (inView && anchor) openEditor(anchor);
      else if (origin) openEditor(origin);
      else if (anchor) openEditor(anchor);
      else stop();
    }, 120);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request
  }, [jump?.seq]);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  const placement = useMenuPlacement(!!open, noTrigger, cardRef, {
    anchorPoint: open?.anchor ?? null, align: 'center', gap: 6, minHeight: 60,
  });
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    // Esc inside the editor is the editor's (it stops there); here it closes the card.
    const onKey = (e: KeyboardEvent) => {
      // An Esc that ends an IME composition is the composition's, not a close.
      if (e.key !== 'Escape' || isImeKey(e)) return;
      // One Esc closes one layer: the panel's router must not also close a drawer or page.
      e.preventDefault();
      setOpen(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.passage-comment-card')) return;
      // Refused: a send holds it; closing now would drop the typed words.
      if (commitDraft.current('press') === 'refused') return;
      if (t?.closest('.passage-comment-marker')) return;
      setOpen(null);
    };
    // The keyboard way out (Tab or a shortcut to the composer, then Enter): no press,
    // so the focus leaving the card keeps the words the same way.
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest?.('.passage-comment-card')) return;
      commitDraft.current('focus');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, [isOpen]);
  // Follow the passage while the timeline scrolls; close when it leaves the view.
  // An open editor stays (a streamed turn may scroll the timeline under it): it
  // holds on at the view's edge, and with no passage to follow, where it was.
  const editingRef = useRef(false);
  editingRef.current = isEditing;
  useEffect(() => {
    if (!open) return;
    const entry = painted().find((p) => p.id === open.id);
    const rect = entry ? anchorRectOf(entry.range) : null;
    const box = containerRef.current?.getBoundingClientRect();
    const gone = !rect || (box && (rect.bottom < box.top || rect.top > box.bottom));
    if (gone && !editingRef.current) { setOpen(null); return; }
    if (!rect) return;
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(box ? Math.min(Math.max(rect.bottom, box.top), box.bottom) : rect.bottom);
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
          {isEditing ? (
            <div
              className="passage-comment-card-edit"
              onKeyDown={(e) => {
                // Esc anywhere in the editor puts the old words back and stays in the card.
                if (e.key !== 'Escape' || isImeKey(e.nativeEvent)) return;
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              }}
            >
              <AnswerBox
                value={draft}
                onChange={(t) => { setDraft(t); setRefused(false); }}
                onSubmit={saveEdit}
                sendLabel="Save"
                sendTestId="passage-comment-save"
                testId="passage-comment-input"
                boxRef={editBox}
                minRows={2}
                maxRows={12}
                maxLength={MAX_COMMENT_CHARS}
                placeholder="Add a comment"
                ariaLabel="Edit comment"
              />
              <div className="passage-comment-card-edit-foot">
                <span className="passage-comment-card-edit-hint" data-testid="passage-comment-edit-hint" role={refused ? 'status' : undefined}>
                  {refused ? 'Being sent now, so it keeps its words' : 'Enter saves · Esc keeps the old words'}
                </span>
                <button
                  type="button"
                  className="passage-comment-card-cancel"
                  data-testid="passage-comment-cancel"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : openItem.comment ? (
            <div
              className={`passage-comment-card-text${canEdit ? ' is-editable' : ''}`}
              data-testid="passage-comment-text"
              title={canEdit ? 'Click to edit' : undefined}
              onClick={() => {
                // A drag that selects words to copy is reading, not editing.
                const sel = window.getSelection();
                if (canEdit && (!sel || sel.isCollapsed)) startEdit(openItem.id);
              }}
            >
              {openItem.comment}
            </div>
          ) : null}
          {!isEditing && (
            <div className="passage-comment-card-actions">
              {canEdit && (
                <button
                  ref={editBtn}
                  type="button"
                  className="passage-comment-card-remove"
                  data-testid="passage-comment-edit"
                  onClick={() => startEdit(openItem.id)}
                >
                  {openItem.comment ? 'Edit' : 'Add comment'}
                </button>
              )}
              <button
                type="button"
                className="passage-comment-card-remove"
                data-testid="passage-comment-remove"
                onClick={() => { onRemove(openItem.id); setOpen(null); }}
              >
                {openItem.sentAt ? 'Remove mark' : 'Remove'}
              </button>
            </div>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
