/**
 * Comments on a document, Google Docs style (2026-11-01, the user: "I comment in
 * it, the AI replies in it and resolves it ... shown beside it ... resolved shows
 * as resolved"). The comments live in the doc's sidecar file (useDocComments), so
 * the AI answers and resolves them with its own edit tools; each new comment or
 * reply of the user's also waits above the composer (SessionCommentsApi with a
 * `doc`) and goes to the AI with the next message.
 *
 * The layer is a box over the file view. It paints the open comments' words
 * (walnut-doc-comment, the current one walnut-doc-comment-current), and draws
 * their cards in a column on the right, each level with its passage and pushed
 * down past the one above (the current one sits exactly at its passage). A wide
 * view reserves the column's room beside the text; a narrow one shows only the
 * current card, over the text. A "N comments" chip lists them all: resolved ones
 * (Reopen) and outdated ones, whose words are gone from the doc.
 *
 * Anchors are text quotes (prefix, exact, suffix) located again on every change
 * of the doc, so a comment follows its words through edits.
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject,
} from 'react';
import { useSessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { useDocComments } from '@/hooks/useDocComments';
import {
  addDocComment, addDocPost, deleteDocComment, newDocCommentId, setDocResolved, USER_AUTHOR, type DocComment, type DocCommentView,
} from '@/utils/doc-comments';
import { fitsAsComment, snippetOf } from '@/utils/passage-comments';
import { panelLayer } from '@/utils/pin-highlights';
import { buildTextIndex, locateQuote, quoteFromRange, rangeFromOffsets, rangeIsLive } from '@/utils/text-quote-anchor';
import type { SessionPinnedQuote } from '@/types/session';
import { pointInRangeRects } from '@/components/sessions/QuotePinPopover';
import { DocCommentCard, DocCommentDraft } from './DocCommentCard';
import { log } from '@/utils/log';
import '@/styles/doc-comments.css';

export const HL_DOC_COMMENT = 'walnut-doc-comment';
export const HL_DOC_COMMENT_CURRENT = 'walnut-doc-comment-current';
const OPEN_LAYER = panelLayer(HL_DOC_COMMENT);
const CURRENT_LAYER = panelLayer(HL_DOC_COMMENT_CURRENT);
/** From this view width the column gets room of its own beside the text. */
const WIDE_FROM = 700;
const GAP = 8;
/** A tray row's jump still lands after its doc opens, for this long. */
const JUMP_FRESH_MS = 15_000;

export interface DocCommentsHandle {
  /** Start a comment on the selection (`range`, else the live one). False = nothing to comment on. */
  commentOn: (opts: { range?: Range; text?: string }) => boolean;
}

interface Props {
  filePath: string;
  host?: string;
  sessionId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  /** Changes when the surface remounts or reloads (anchors are located again). */
  surfaceNonce: unknown;
  /** The source editor draws only the lines on screen: a passage it has not drawn is
   *  not "changed", just not shown yet. */
  virtualized: boolean;
  /** The column wants (true) or gives back (false) its room beside the text. */
  onRoom: (wanted: boolean) => void;
}

function bodyOf(root: HTMLElement | null): Element | null {
  return root?.querySelector('.ProseMirror, .fv-md-preview, .file-viewer-code, .cm-content') ?? null;
}

const DRAFT_KEY = '__draft__';

/** The element that scrolls the doc vertically, from a node inside it. */
function scrollerOf(node: Node | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  return el;
}

/** Bring a passage to the middle of its scroller, vertically only: scrollIntoView
 *  also scrolls a code editor sideways, under its sticky line numbers. */
function reveal(range: Range): void {
  const el = scrollerOf(range.startContainer);
  if (!el) return;
  const rect = range.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  el.scrollTop += rect.top - (box.top + box.height / 2);
}

export const DocCommentsLayer = forwardRef<DocCommentsHandle, Props>(function DocCommentsLayer(
  { filePath, host, sessionId, rootRef, surfaceNonce, virtualized, onRoom }, ref,
) {
  const store = useDocComments({ path: filePath, host, sessionId });
  // The words of a comment are read in the view they were picked in.
  const view: DocCommentView = virtualized ? 'source' : 'rendered';
  const chat = useSessionCommentsApi();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ quote: SessionPinnedQuote; text: string } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [anchored, setAnchored] = useState<ReadonlySet<string>>(new Set());
  const layerRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef(currentId);
  currentRef.current = currentId;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const ranges = useRef(new Map<string, Range>());
  const revealRef = useRef<string | null>(null);
  const panelKey = `doc:${sessionId}:${filePath}`;

  const open = useMemo(() => store.comments.filter((c) => c.status === 'open'), [store.comments]);
  const queuedIds = useMemo(() => new Set(chat.comments
    .filter((c) => c.doc?.path === filePath && !c.sentAt && !c.removedAt)
    .map((c) => c.doc!.commentId)), [chat.comments, filePath]);

  // ── Locate every open comment (and the draft, and a current resolved one) ──
  const locate = useCallback(() => {
    const b = bodyOf(rootRef.current);
    const next = new Map<string, Range>();
    if (b) {
      const index = buildTextIndex(b);
      const want: Array<[string, SessionPinnedQuote]> = store.comments
        .filter((c) => (c.status === 'open' || c.id === currentId) && c.quote.exact && (c.view ?? 'rendered') === view)
        .map((c) => [c.id, c.quote]);
      if (draft) want.push([DRAFT_KEY, draft.quote]);
      for (const [id, quote] of want) {
        const at = locateQuote(index.text, quote);
        const r = at ? rangeFromOffsets(index, at.start, at.end) : null;
        if (r && rangeIsLive(r)) next.set(id, r);
      }
    }
    ranges.current = next;
    // A card asked for (the list, a row above the composer) whose words were not drawn yet.
    const asked = revealRef.current;
    if (asked && next.has(asked)) {
      revealRef.current = null;
      reveal(next.get(asked)!);
    }
    OPEN_LAYER.set(panelKey, open.filter((c) => c.id !== currentId).flatMap((c) => next.get(c.id) ?? []));
    const cur = (currentId && next.get(currentId)) || next.get(DRAFT_KEY);
    CURRENT_LAYER.set(panelKey, cur ? [cur] : []);
    setAnchored((prev) => {
      const ids = new Set(next.keys());
      return prev.size === ids.size && [...ids].every((id) => prev.has(id)) ? prev : ids;
    });
  }, [rootRef, store.comments, open, currentId, draft, panelKey, view]);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  useEffect(() => () => { OPEN_LAYER.clear(panelKey); CURRENT_LAYER.clear(panelKey); }, [panelKey]);

  // ── Place the cards: level with their passage, none over another ──
  const place = useCallback(() => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (!root || !layer) return;
    const box = root.getBoundingClientRect();
    const isWide = box.width >= WIDE_FROM;
    setWide((w) => (w === isWide ? w : isWide));
    const bar = root.querySelector<HTMLElement>(':scope > .fv-html-toolbar');
    const minTop = Math.max(0, (bar ? bar.getBoundingClientRect().bottom : box.top) - box.top) + 4;
    // The column starts under the toolbar and clips there; card tops are the column's.
    layer.style.setProperty('--dc-top', `${Math.round(minTop)}px`);
    const items: Array<{ id: string; el: HTMLDivElement; want: number; h: number }> = [];
    for (const [id, el] of cardEls.current) {
      const r = ranges.current.get(id);
      const rects = r?.getClientRects();
      const rect = rects?.[0];
      if (!rect) { el.style.visibility = 'hidden'; continue; }
      // Wide: level with the passage's first line, in the column. Narrow: the card is
      // over the text, so it goes under the passage's last line, never over its words.
      const want = isWide ? rect.top - box.top - minTop - 6 : rects![rects!.length - 1]!.bottom - box.top - minTop + 4;
      items.push({ id, el, want, h: el.offsetHeight });
    }
    items.sort((a, b) => a.want - b.want);
    const focus = items.findIndex((i) => i.id === (draft ? DRAFT_KEY : currentId));
    const tops = items.map((i) => i.want);
    for (let k = (focus < 0 ? 0 : focus) + 1; k < items.length; k++) tops[k] = Math.max(tops[k]!, tops[k - 1]! + items[k - 1]!.h + GAP);
    if (focus < 0 && items.length) tops[0] = Math.max(tops[0]!, items[0]!.want);
    for (let k = focus - 1; k >= 0; k--) tops[k] = Math.min(tops[k]!, tops[k + 1]! - items[k]!.h - GAP);
    items.forEach((i, k) => {
      const top = tops[k]!;
      i.el.style.top = `${Math.round(top)}px`;
      // Wholly off the column (scrolled under the toolbar, past the bottom): not drawn.
      const off = top + i.h < 0 || top > box.height - minTop;
      i.el.style.visibility = off ? 'hidden' : 'visible';
    });
  }, [rootRef, draft, currentId]);
  const placeRef = useRef(place);
  placeRef.current = place;

  // Re-locate on any change of the doc's DOM, re-place on scroll and resize.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    let dirty = true;
    const tick = () => {
      raf = 0;
      if (dirty) { dirty = false; locateRef.current(); }
      placeRef.current();
    };
    const later = (relocate: boolean) => {
      if (relocate) dirty = true;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const mo = new MutationObserver((records) => {
      // Our own cards and chip changing must not re-index the doc.
      if (records.every((r) => layerRef.current?.contains(r.target))) return later(false);
      later(true);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => later(true));
    ro?.observe(root);
    // The text reflows inside an unchanged box when the column takes its room.
    const b = bodyOf(root);
    if (b) ro?.observe(b);
    const onScroll = () => later(false);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    later(true);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rootRef, surfaceNonce, filePath]);
  // The list or the current one changed: locate (paint) and place before the paint.
  useLayoutEffect(() => { locate(); place(); }, [locate, place, anchored]);

  // The column takes its room beside the text while there is something in it.
  const showColumn = open.length > 0 || !!draft;
  const room = showColumn && wide;
  useEffect(() => {
    onRoom(room);
    // Taking or giving back the room reflows the text: keep the current passage on screen.
    const raf = requestAnimationFrame(() => {
      const root = rootRef.current;
      const r = ranges.current.get(draftRef.current ? DRAFT_KEY : currentRef.current ?? '');
      if (!root || !r) return;
      const rect = r.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      if (rect.top < box.top + 48 || rect.bottom > box.bottom - 8) reveal(r);
      placeRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [onRoom, room, rootRef]);
  useEffect(() => () => onRoom(false), [onRoom]);

  // ── A click on commented words makes its card current; elsewhere in the doc, none ──
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || layerRef.current?.contains(e.target as Node)) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      for (const [id, r] of ranges.current) {
        if (id !== DRAFT_KEY && pointInRangeRects(r, e.clientX, e.clientY)) {
          setCurrentId(id);
          log.info('doc-comments', 'comment opened from its words', { path: filePath, id });
          return;
        }
      }
      setCurrentId(null);
      setListOpen(false);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [rootRef, filePath]);
  useEffect(() => {
    if (!currentId && !draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Not an Escape meant for something else on the page (an editor's menu, a dialog).
      const active = document.activeElement;
      if (active && active !== document.body && !layerRef.current?.contains(active) && !rootRef.current?.contains(active)) return;
      setCurrentId(null);
      setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentId, draft, rootRef]);
  useEffect(() => { setCurrentId(null); setDraft(null); setListOpen(false); revealRef.current = null; }, [filePath]);

  const show = useCallback((id: string, via: string) => {
    setCurrentId(id);
    setListOpen(false);
    // Revealed once its words are located (now, or when the doc has drawn them).
    revealRef.current = id;
    requestAnimationFrame(() => locateRef.current());
    log.info('doc-comments', 'comment shown', { path: filePath, id, via });
  }, [filePath]);

  // A row above the composer asked for one of this doc's comments.
  const jumpLanded = useRef(0);
  useEffect(() => {
    const j = chat.jump;
    if (!j || j.seq === jumpLanded.current || Date.now() - j.at > JUMP_FRESH_MS || !store.loaded) return;
    const entry = chat.comments.find((c) => c.id === j.id);
    if (entry?.doc?.path !== filePath) return;
    if (!store.comments.some((c) => c.id === entry.doc!.commentId)) return;
    jumpLanded.current = j.seq;
    show(entry.doc.commentId, 'composer-row');
  }, [chat.jump, chat.comments, store.loaded, store.comments, filePath, show]);

  // ── What the cards do ──
  const now = () => new Date().toISOString();
  const queue = useCallback((c: { id: string; quote: SessionPinnedQuote; text: string }, words: string, reply: boolean) => {
    if (!chat.canComment || !filePath.startsWith('/')) return;
    if (!fitsAsComment(c.text, words, chat.comments)) {
      log.info('doc-comments', 'comment too long to send with a message; it stays in the comments file', { path: filePath, id: c.id });
      return;
    }
    chat.add({
      msgId: `doc:${c.id}`, role: 'user', quote: c.quote, text: c.text, comment: words,
      doc: { path: filePath, ...(host ? { host } : {}), commentId: c.id, ...(reply ? { reply } : {}) },
    });
  }, [chat, filePath, host]);
  const unqueue = useCallback((commentId: string) => {
    for (const c of chat.comments) if (c.doc?.path === filePath && c.doc.commentId === commentId && !c.sentAt) chat.remove(c.id);
  }, [chat, filePath]);

  const submitDraft = useCallback((words: string) => {
    if (!draft) return;
    const id = newDocCommentId();
    const c: DocComment = {
      id, status: 'open', quote: draft.quote, text: draft.text, thread: [{ author: USER_AUTHOR, at: now(), text: words }],
      ...(view === 'source' ? { view } : {}),
    };
    store.edit(addDocComment(c), 'add');
    queue(c, words, false);
    setDraft(null);
    setCurrentId(id);
  }, [draft, store, queue, view]);

  useImperativeHandle(ref, () => ({
    commentOn: ({ range: given, text }) => {
      const b = bodyOf(rootRef.current);
      const sel = document.getSelection();
      const range = given ?? (sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null);
      if (!b || !range || range.collapsed || !b.contains(range.commonAncestorContainer)) {
        log.info('doc-comments', 'comment not started: no selection in the doc', { path: filePath, hasBody: !!b, hasRange: !!range });
        return false;
      }
      const quote = quoteFromRange(buildTextIndex(b), range);
      const words = (text ?? sel?.toString() ?? '').trim() || quote?.exact || '';
      if (!quote || !words) {
        log.info('doc-comments', 'comment not started: the selection has no text', { path: filePath });
        return false;
      }
      setDraft({ quote, text: words });
      setCurrentId(null);
      setListOpen(false);
      log.info('doc-comments', 'comment started', { path: filePath, chars: words.length });
      return true;
    },
  }), [rootRef, filePath]);

  const resolvedCount = store.comments.length - open.length;
  const otherView = (c: DocComment) => (c.view ?? 'rendered') !== view;
  const outdated = virtualized ? [] : open.filter((c) => store.loaded && !otherView(c) && !anchored.has(c.id));
  const outdatedIds = new Set(outdated.map((c) => c.id));
  const inColumn = open.filter((c) => anchored.has(c.id) && (wide || c.id === currentId));
  const currentResolved = currentId ? store.comments.find((c) => c.id === currentId && c.status === 'resolved' && anchored.has(c.id)) : undefined;
  const setCardEl = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardEls.current.set(id, el); else cardEls.current.delete(id);
  };
  const card = (c: DocComment) => (
    <div key={c.id} ref={setCardEl(c.id)} className="doc-comment-slot">
      <DocCommentCard
        docPath={filePath}
        comment={c}
        current={c.id === currentId}
        outdated={false}
        queued={queuedIds.has(c.id)}
        onFocus={() => setCurrentId(c.id)}
        onReply={(words) => {
          store.edit(addDocPost(c.id, { author: USER_AUTHOR, at: now(), text: words }), 'reply');
          queue(c, words, true);
        }}
        onResolve={(resolved) => {
          store.edit(setDocResolved(c.id, resolved, USER_AUTHOR, now()), resolved ? 'resolve' : 'reopen');
          if (resolved) { unqueue(c.id); setCurrentId(null); }
        }}
        onDelete={() => { store.edit(deleteDocComment(c.id), 'delete'); unqueue(c.id); setCurrentId(null); }}
        onLeave={() => setCurrentId(null)}
      />
    </div>
  );

  if (!store.loaded && !draft) return null;
  if (!store.comments.length && !draft) return null;
  return (
    <div ref={layerRef} className={`fv-doc-comments${wide ? ' is-wide' : ''}`} data-testid="doc-comments" data-file-path={filePath}>
      {store.comments.length > 0 && (
        <button
          type="button"
          className="doc-comments-chip"
          data-testid="doc-comments-chip"
          aria-expanded={listOpen}
          onClick={() => setListOpen((o) => !o)}
        >
          {open.length === 1 ? '1 comment' : `${open.length} comments`}
          {resolvedCount > 0 && <span className="doc-comments-chip-sub"> · {resolvedCount} resolved</span>}
          {outdated.length > 0 && <span className="doc-comments-chip-sub is-outdated"> · {outdated.length} changed</span>}
        </button>
      )}
      {(store.saveError || store.readError) && (
        <div className="doc-comments-error" role="status">
          {store.saveError ? `Not saved yet: ${store.saveError}` : `Comments not read: ${store.readError}`}
        </div>
      )}
      {listOpen && (
        <div className="doc-comments-list" data-testid="doc-comments-list" onPointerDown={(e) => e.stopPropagation()}>
          {store.comments.map((c) => {
            const gone = outdatedIds.has(c.id);
            return (
              <div key={c.id} className={`doc-comments-list-row is-${gone ? 'outdated' : c.status}`} data-testid="doc-comments-list-row" data-comment-id={c.id}>
                <button type="button" className="doc-comments-list-open" onClick={() => show(c.id, 'list')} disabled={gone || otherView(c)}>
                  <span className="doc-comments-list-where">❝ {snippetOf(c.text, 50)}</span>
                  <span className="doc-comments-list-text">{snippetOf(c.thread[0]?.text ?? '', 80)}</span>
                  <span className="doc-comments-list-state">
                    {gone ? 'Words changed' : otherView(c) ? `Left in the ${c.view === 'source' ? 'source' : 'rendered'} view` : c.status === 'resolved' ? `Resolved${c.resolvedBy ? ` by ${c.resolvedBy === USER_AUTHOR ? 'you' : c.resolvedBy}` : ''}` : `${c.thread.length} post${c.thread.length === 1 ? '' : 's'}`}
                  </span>
                </button>
                {(c.status === 'resolved' || gone) && (
                  <button
                    type="button"
                    className="doc-comment-btn"
                    onClick={() => store.edit(setDocResolved(c.id, c.status !== 'resolved', USER_AUTHOR, now()), c.status === 'resolved' ? 'reopen' : 'resolve')}
                  >
                    {c.status === 'resolved' ? 'Reopen' : 'Resolve'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div
        className="doc-comments-column"
        // The column sits over the doc's scroller: a wheel over a card scrolls the doc.
        onWheel={(e) => {
          if ((e.target as HTMLElement).closest('textarea')) return;
          const scroller = scrollerOf(bodyOf(rootRef.current));
          if (scroller) scroller.scrollTop += e.deltaY;
        }}
      >
        {inColumn.map(card)}
        {currentResolved && card(currentResolved)}
        {draft && (
          <div ref={setCardEl(DRAFT_KEY)} className="doc-comment-slot">
            <DocCommentDraft docPath={filePath} passage={draft.quote.exact} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
          </div>
        )}
      </div>
    </div>
  );
});
