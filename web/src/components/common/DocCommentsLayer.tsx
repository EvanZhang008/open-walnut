/**
 * Comments on a document, Google Docs style (2026-11-01, the user: "I comment in
 * it, the AI replies in it and resolves it ... shown beside it ... resolved shows
 * as resolved"). The comments live in the doc's sidecar file (useDocComments), so
 * the AI answers and resolves them with its own edit tools; each new comment or
 * reply of the user's also waits above the composer (SessionCommentsApi with a
 * `doc`) and goes to the AI with the next message.
 *
 * The layer is a box over the file view. It paints the open comments' words
 * (walnut-doc-comment, the current one walnut-doc-comment-current) and opens a
 * comment's card in place, right under its words (2026-11-02, the user: "comment,
 * need in place not in side bar, waste space"; utils/in-place-card.ts): the new
 * comment's box under the selection, a saved one's card under its words when they
 * are clicked. Nothing takes room beside the text, so the doc keeps its width. A
 * "N comments" chip lists them all: resolved ones (Reopen) and outdated ones,
 * whose words are gone from the doc.
 *
 * Anchors are text quotes (prefix, exact, suffix) located again on every change
 * of the doc, so a comment follows its words through edits, and in every view of
 * it: one picked in the rendered doc shows on the same words in the source and
 * the other way round (doc-comment-anchor.ts matches across the markup). The
 * source editor is read through its document, so a passage it has not drawn yet
 * is scrolled to, never taken for changed; the HTML preview is a same-origin
 * frame, painted and hit-tested in its own document.
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject,
} from 'react';
import { useSessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { useDocComments } from '@/hooks/useDocComments';
import {
  addDocComment, addDocPost, deleteDocComment, newDocCommentId, setDocResolved, USER_AUTHOR, type DocComment,
} from '@/utils/doc-comments';
import { hasMarkup } from '@/utils/doc-comment-anchor';
import { fitsAsComment, snippetOf } from '@/utils/passage-comments';
import { panelLayer } from '@/utils/pin-highlights';
import { buildTextIndex, quoteFromRange, quoteFromText, rangeFromOffsets, rangeIsLive } from '@/utils/text-quote-anchor';
import type { SessionPinnedQuote } from '@/types/session';
import { pointInRangeRects } from '@/components/sessions/QuotePinPopover';
import { DocCommentCard, DocCommentDraft, DocCommentsHead } from './DocCommentCard';
import type { FileSourceEditorHandle } from './FileSourceEditor';
import type { FileThreadSurface } from './FileThreadLayer';
import {
  bodyOf, frameDocFor, frameDocOf, HL_DOC_COMMENT, HL_DOC_COMMENT_CURRENT, LocateMemo, paintFrame, reveal, scrollerOf,
} from './doc-comments-dom';
import { inPlaceCardPosition } from '@/utils/in-place-card';
import { log } from '@/utils/log';
import '@/styles/doc-comments.css';

export { HL_DOC_COMMENT, HL_DOC_COMMENT_CURRENT };
const OPEN_LAYER = panelLayer(HL_DOC_COMMENT);
const CURRENT_LAYER = panelLayer(HL_DOC_COMMENT_CURRENT);
/** A tray row's jump still lands after its doc opens, for this long. */
const JUMP_FRESH_MS = 15_000;

export interface DocCommentsHandle {
  /** Start a comment on the selection (`range`, or in the source editor `offsets`,
   *  else the live one). False = nothing to comment on. */
  commentOn: (opts: { range?: Range; text?: string; offsets?: { from: number; to: number } | null }) => boolean;
}

interface Props {
  filePath: string;
  host?: string;
  sessionId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  /** Changes when the surface remounts or reloads (anchors are located again). */
  surfaceNonce: unknown;
  /** The view on show. `source` is read through `editor`; `html` lives in `frameRef`. */
  surface: FileThreadSurface;
  frameRef: RefObject<HTMLIFrameElement | null>;
  editor: RefObject<FileSourceEditorHandle | null>;
  /** The doc's text as it stands: tells words this view does not show (a link's
   *  target) from words that are gone. */
  getDocText: () => string | null;
}

const DRAFT_KEY = '__draft__';

/** Where each comment stands in the view on show. */
interface Marks {
  /** Drawn: its words are on screen (or in the drawn part of the source). */
  drawn: ReadonlySet<string>;
  /** In the doc, not drawn here: the source has not drawn those lines yet, or the
   *  words are ones only the source shows. */
  elsewhere: ReadonlySet<string>;
  /** Its words are gone from the doc. */
  gone: ReadonlySet<string>;
}
const NO_MARKS: Marks = { drawn: new Set(), elsewhere: new Set(), gone: new Set() };
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export const DocCommentsLayer = forwardRef<DocCommentsHandle, Props>(function DocCommentsLayer(
  { filePath, host, sessionId, rootRef, surfaceNonce, surface, frameRef, editor, getDocText }, ref,
) {
  const store = useDocComments({ path: filePath, host, sessionId });
  const inSource = surface === 'source';
  const inFrame = surface === 'html';
  const markup = hasMarkup(filePath);
  const chat = useSessionCommentsApi();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ quote: SessionPinnedQuote; text: string } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  /** The saved comment whose words the pointer is on: its card shows there to read. */
  const [peekId, setPeekId] = useState<string | null>(null);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const anchored = marks.drawn;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef(currentId);
  currentRef.current = currentId;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const ranges = useRef(new Map<string, Range>());
  const revealRef = useRef<string | null>(null);
  /** The comment the source editor was last scrolled to for (once per ask). */
  const scrolledFor = useRef<string | null>(null);
  /** Escape closes the current card or the draft (the frame's window hears it too, see below). */
  const escapeRef = useRef<(e: KeyboardEvent) => void>(() => {});
  escapeRef.current = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || (!currentRef.current && !draftRef.current)) return;
    // Not an Escape meant for something else on the page (an editor's menu, a dialog).
    const active = document.activeElement;
    if (active && active !== document.body && !layerRef.current?.contains(active) && !rootRef.current?.contains(active)) return;
    setCurrentId(null);
    setDraft(null);
  };
  // Matched once per text (a scroll that redraws the same text matches nothing again).
  const viewMemo = useRef(new LocateMemo());
  const docMemo = useRef(new LocateMemo());
  /** The doc's text for "only the source shows these words": read at most once a second
   *  while typing (the rendered editor serializes the whole doc for it). */
  const docText = useRef<{ text: string | null; at: number; timer?: ReturnType<typeof setTimeout> }>({ text: null, at: 0 });
  const getDocTextRef = useRef(getDocText);
  getDocTextRef.current = getDocText;
  /** The body holding the doc's text in the view on show, in whichever document. */
  const bodyNow = useCallback((): Element | null => (
    inFrame ? frameDocFor(frameRef.current)?.body ?? null : bodyOf(rootRef.current)
  ), [inFrame, frameRef, rootRef]);
  const panelKey = `doc:${sessionId}:${filePath}`;

  const open = useMemo(() => store.comments.filter((c) => c.status === 'open'), [store.comments]);
  const queuedIds = useMemo(() => new Set(chat.comments
    .filter((c) => c.doc?.path === filePath && !c.sentAt && !c.removedAt)
    .map((c) => c.doc!.commentId)), [chat.comments, filePath]);

  const readDocText = useCallback((): string | null => {
    const d = docText.current;
    const now = Date.now();
    if (now - d.at >= 1000 || d.text == null) {
      d.text = getDocTextRef.current();
      d.at = now;
    } else if (!d.timer) {
      // Read again once the second is up, so a label left from a stale read is redone.
      d.timer = setTimeout(() => { d.timer = undefined; d.at = 0; locateRef.current(); }, 1000 - (now - d.at));
    }
    return d.text;
  }, []);
  useEffect(() => () => clearTimeout(docText.current.timer), []);

  // ── Locate every open comment (and the draft, and a current resolved one) ──
  const locate = useCallback(() => {
    const next = new Map<string, Range>();
    const elsewhere = new Map<string, number>();
    const gone = new Set<string>();
    const want: Array<[string, SessionPinnedQuote]> = store.comments
      .filter((c) => (c.status === 'open' || c.id === currentId) && c.quote.exact)
      .map((c) => [c.id, c.quote]);
    if (draft) want.push([DRAFT_KEY, draft.quote]);
    const ed = inSource ? editor.current : null;
    if (ed?.rangeAt) {
      // The source editor draws only the lines near the screen: read its document.
      const text = ed.getValue();
      for (const [id, quote] of want) {
        const at = viewMemo.current.locate(text, markup, quote);
        if (!at) { gone.add(id); continue; }
        const r = ed.rangeAt(at.start, at.end);
        if (r) next.set(id, r); else elsewhere.set(id, at.start);
      }
    } else if (!inSource) {
      const b = bodyNow();
      if (b) {
        const index = buildTextIndex(b);
        let doc: string | null | undefined;
        for (const [id, quote] of want) {
          const at = viewMemo.current.locate(index.text, markup, quote);
          const r = at ? rangeFromOffsets(index, at.start, at.end) : null;
          if (r && rangeIsLive(r)) { next.set(id, r); continue; }
          if (at) continue; // found while the DOM moves: the next pass draws it
          // Not on show: words only the source shows (a link's target), or gone.
          if (doc === undefined) doc = readDocText();
          const there = markup && doc != null ? docMemo.current.locate(doc, markup, quote) : null;
          if (there) elsewhere.set(id, there.start); else if (doc != null) gone.add(id);
        }
      }
    }
    ranges.current = next;
    // A card asked for (the list, a row above the composer) whose words were not drawn yet.
    const asked = revealRef.current;
    if (asked && (gone.has(asked) || (!inSource && elsewhere.has(asked)))) {
      // Not to be shown in this view: the ask ends here, it never pulls the view later.
      revealRef.current = null;
    } else if (asked && next.has(asked)) {
      revealRef.current = null;
      scrolledFor.current = null;
      reveal(next.get(asked)!);
    } else if (asked && ed?.scrollToPos && elsewhere.has(asked) && scrolledFor.current !== asked) {
      // Drawn once the editor scrolls there; the next pass reveals it.
      scrolledFor.current = asked;
      ed.scrollToPos(elsewhere.get(asked)!);
    }
    const openRanges = open.filter((c) => c.id !== currentId).flatMap((c) => next.get(c.id) ?? []);
    const cur = (currentId && next.get(currentId)) || next.get(DRAFT_KEY);
    if (inFrame) {
      OPEN_LAYER.clear(panelKey);
      CURRENT_LAYER.clear(panelKey);
      // (A page the preview strayed to has nothing located: its paint is cleared.)
      paintFrame(frameDocOf(frameRef.current), openRanges, cur ? [cur] : []);
    } else {
      OPEN_LAYER.set(panelKey, openRanges);
      CURRENT_LAYER.set(panelKey, cur ? [cur] : []);
    }
    const drawn = new Set(next.keys());
    const away = new Set(elsewhere.keys());
    setMarks((prev) => (sameSet(prev.drawn, drawn) && sameSet(prev.elsewhere, away) && sameSet(prev.gone, gone)
      ? prev : { drawn, elsewhere: away, gone }));
  }, [store.comments, open, currentId, draft, panelKey, inSource, inFrame, editor, markup, bodyNow, frameRef, readDocText]);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  useEffect(() => () => { OPEN_LAYER.clear(panelKey); CURRENT_LAYER.clear(panelKey); }, [panelKey]);
  useEffect(() => {
    if (!inFrame) return;
    const frame = frameRef.current;
    return () => paintFrame(frameDocOf(frame), [], []);
  }, [inFrame, frameRef, surfaceNonce]);

  // ── Place the open card in place: under its words (utils/in-place-card.ts) ──
  const place = useCallback(() => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (!root || !layer) return;
    const box = root.getBoundingClientRect();
    const bar = root.querySelector<HTMLElement>(':scope > .fv-html-toolbar');
    const minTop = Math.max(0, (bar ? bar.getBoundingClientRect().bottom : box.top) - box.top) + 4;
    // The cards' area starts under the toolbar and clips there; card tops are its.
    layer.style.setProperty('--dc-top', `${Math.round(minTop)}px`);
    // The HTML preview's ranges measure in the frame's viewport.
    const fb = inFrame ? frameRef.current?.getBoundingClientRect() : null;
    const dx = fb?.left ?? 0;
    const dy = fb?.top ?? 0;
    const view = { width: box.width, height: box.height - minTop };
    for (const [id, el] of cardEls.current) {
      const rects = Array.from(ranges.current.get(id)?.getClientRects() ?? []).map((r) => ({
        left: r.left + dx - box.left, right: r.right + dx - box.left,
        top: r.top + dy - box.top - minTop, bottom: r.bottom + dy - box.top - minTop,
      }));
      // Its whole height (scrollHeight is not capped by a max-height set before).
      const at = inPlaceCardPosition(rects, view, { width: el.offsetWidth, height: el.scrollHeight });
      if (!at) { el.style.visibility = 'hidden'; continue; }
      el.style.left = `${Math.round(at.left)}px`;
      el.style.top = `${Math.round(at.top)}px`;
      el.style.maxHeight = at.maxHeight ? `${Math.floor(at.maxHeight)}px` : '';
      el.dataset.placement = at.placement;
      // Wholly off the view (scrolled under the toolbar, past the bottom): not drawn.
      const off = at.top + el.offsetHeight < 0 || at.top > view.height;
      el.style.visibility = off ? 'hidden' : 'visible';
    }
  }, [rootRef, inFrame, frameRef]);
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
    // The text reflows inside an unchanged box (a wrap, an image that loads).
    const b = bodyOf(root);
    if (b) ro?.observe(b);
    const onScroll = () => later(false);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    // The HTML preview: its page changes, scrolls and resizes in its own document,
    // which is replaced on every load.
    const frame = inFrame ? frameRef.current : null;
    let fdoc: Document | null = null;
    let fwin: Window | null = null;
    let fmo: MutationObserver | null = null;
    let fro: ResizeObserver | null = null;
    const onFrameChange = () => later(true);
    // Escape pressed while the page has focus (never one meant for the page's own field).
    const onFrameKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      escapeRef.current(e);
    };
    const detachFrame = () => {
      fmo?.disconnect();
      fro?.disconnect();
      fdoc?.removeEventListener('scroll', onScroll, true);
      fwin?.removeEventListener('resize', onFrameChange);
      fwin?.removeEventListener('keydown', onFrameKey);
      fmo = null; fro = null; fdoc = null; fwin = null;
    };
    const attachFrame = () => {
      detachFrame();
      fdoc = frameDocOf(frame);
      // Another page, or none: re-locate, which finds nothing there and clears what was drawn.
      if (!fdoc?.body) { later(true); return; }
      fwin = fdoc.defaultView;
      fwin?.addEventListener('keydown', onFrameKey);
      fmo = new MutationObserver(onFrameChange);
      fmo.observe(fdoc.body, { childList: true, subtree: true, characterData: true });
      const FrameRO = (fdoc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
      fro = FrameRO ? new FrameRO(onFrameChange) : null;
      fro?.observe(fdoc.body);
      fdoc.addEventListener('scroll', onScroll, { capture: true, passive: true });
      fwin?.addEventListener('resize', onFrameChange);
      later(true);
    };
    if (frame) {
      frame.addEventListener('load', attachFrame);
      if (frameDocOf(frame)?.readyState === 'complete') attachFrame();
    }
    later(true);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      frame?.removeEventListener('load', attachFrame);
      detachFrame();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rootRef, surfaceNonce, filePath, inFrame, frameRef]);
  // The list or the current one changed: locate (paint) and place before the paint.
  useLayoutEffect(() => { locate(); place(); }, [locate, place, anchored]);

  // A card that opens keeps its passage on screen.
  const opened = draft ? DRAFT_KEY : currentId;
  useEffect(() => {
    if (!opened) return;
    const raf = requestAnimationFrame(() => {
      const root = rootRef.current;
      const r = ranges.current.get(opened);
      if (!root || !r) return;
      const rect = r.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      if (rect.top < box.top + 48 || rect.bottom > box.bottom - 8) reveal(r);
      placeRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [opened, rootRef]);

  // ── A click on commented words makes its card current; elsewhere in the doc, none ──
  // (In the HTML preview the click lands in the frame's document, at its own coordinates,
  // which are the ones its ranges measure in.)
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // In the HTML preview the ranges measure in the frame's viewport, so only the
    // frame's own events (not the toolbar's, at the outer page's coordinates) hit them.
    const hits = (e: MouseEvent) => !inFrame || (e.target as Node | null)?.ownerDocument !== document;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || layerRef.current?.contains(e.target as Node)) return;
      const sel = ((e.target as Node | null)?.ownerDocument ?? document).getSelection();
      if (sel && !sel.isCollapsed) return;
      for (const [id, r] of hits(e) ? ranges.current : []) {
        if (id !== DRAFT_KEY && pointInRangeRects(r, e.clientX, e.clientY)) {
          setCurrentId(id);
          log.info('doc-comments', 'comment opened from its words', { path: filePath, id, surface });
          return;
        }
      }
      setCurrentId(null);
      setListOpen(false);
    };
    // The pointer on commented words shows that comment's card there, to read; it
    // goes a beat after the pointer leaves the words and the card.
    let hideTimer = 0;
    const onMove = (e: MouseEvent) => {
      if (e.buttons) return;
      if (layerRef.current?.contains(e.target as Node)) { window.clearTimeout(hideTimer); return; }
      for (const [id, r] of hits(e) ? ranges.current : []) {
        if (id !== DRAFT_KEY && pointInRangeRects(r, e.clientX, e.clientY)) {
          window.clearTimeout(hideTimer);
          setPeekId(id);
          return;
        }
      }
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setPeekId(null), 300);
    };
    // Off the doc altogether (the composer, the sidebar): it goes too.
    const onLeave = () => { window.clearTimeout(hideTimer); hideTimer = window.setTimeout(() => setPeekId(null), 300); };
    root.addEventListener('click', onClick);
    root.addEventListener('mousemove', onMove);
    root.addEventListener('mouseleave', onLeave);
    const frame = inFrame ? frameRef.current : null;
    let fdoc: Document | null = null;
    const attach = () => {
      fdoc?.removeEventListener('click', onClick, true);
      fdoc?.removeEventListener('mousemove', onMove, true);
      fdoc = frameDocOf(frame);
      fdoc?.addEventListener('click', onClick, true);
      fdoc?.addEventListener('mousemove', onMove, true);
    };
    if (frame) {
      frame.addEventListener('load', attach);
      if (frameDocOf(frame)?.readyState === 'complete') attach();
    }
    return () => {
      window.clearTimeout(hideTimer);
      root.removeEventListener('click', onClick);
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('mouseleave', onLeave);
      frame?.removeEventListener('load', attach);
      fdoc?.removeEventListener('click', onClick, true);
      fdoc?.removeEventListener('mousemove', onMove, true);
    };
  }, [rootRef, filePath, inFrame, frameRef, surface, surfaceNonce]);
  useEffect(() => {
    if (!currentId && !draft) return;
    const onKey = (e: KeyboardEvent) => escapeRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentId, draft]);
  useEffect(() => { setCurrentId(null); setDraft(null); setListOpen(false); setPeekId(null); revealRef.current = null; scrolledFor.current = null; }, [filePath]);
  // A new file or a reload: the doc's text is read afresh.
  useEffect(() => { docText.current.at = 0; docText.current.text = null; }, [filePath, surfaceNonce]);

  const show = useCallback((id: string, via: string) => {
    setCurrentId(id);
    setListOpen(false);
    // Revealed once its words are located (now, or when the doc has drawn them).
    revealRef.current = id;
    scrolledFor.current = null;
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
      // Where the words were picked (for a reader of the file; every view shows it).
      ...(inSource ? { view: 'source' as const } : {}),
    };
    store.edit(addDocComment(c), 'add');
    queue(c, words, false);
    setDraft(null);
    setCurrentId(id);
  }, [draft, store, queue, inSource]);

  useImperativeHandle(ref, () => ({
    commentOn: ({ range: given, text, offsets }) => {
      let quote: SessionPinnedQuote | null = null;
      let picked = '';
      const ed = inSource ? editor.current : null;
      if (ed) {
        // The source editor's own selection, as offsets in its document (its DOM
        // selection is gone by the time a pill is clicked).
        const at = offsets ?? ed.selectionOffsets?.() ?? null;
        const doc = ed.getValue();
        quote = at ? quoteFromText(doc, at.from, at.to) : null;
        picked = at ? doc.slice(Math.min(at.from, at.to), Math.max(at.from, at.to)) : '';
      } else {
        const b = bodyNow();
        const sel = (b?.ownerDocument ?? document).getSelection();
        const range = given ?? (sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null);
        if (!b || !range || range.collapsed || !b.contains(range.commonAncestorContainer)) {
          log.info('doc-comments', 'comment not started: no selection in the doc', { path: filePath, surface, hasBody: !!b, hasRange: !!range });
          return false;
        }
        quote = quoteFromRange(buildTextIndex(b), range);
        picked = sel?.toString() ?? '';
      }
      const words = (text ?? picked).trim() || quote?.exact || '';
      if (!quote || !words) {
        log.info('doc-comments', 'comment not started: the selection has no text', { path: filePath, surface });
        return false;
      }
      setDraft({ quote, text: words });
      setCurrentId(null);
      setListOpen(false);
      log.info('doc-comments', 'comment started', { path: filePath, surface, chars: words.length });
      return true;
    },
  }), [filePath, surface, inSource, editor, bodyNow]);

  const outdated = store.loaded ? open.filter((c) => marks.gone.has(c.id)) : [];
  const outdatedIds = new Set(outdated.map((c) => c.id));
  /** In the doc, but only the source shows these words: no card in this view. */
  const sourceOnly = (c: DocComment) => !inSource && marks.elsewhere.has(c.id);
  // In place: only the comment that is open shows its card, under its words; with
  // none open, the one the pointer is on shows to read.
  const shownId = currentId ?? (draft ? null : peekId);
  const inPlace = open.filter((c) => anchored.has(c.id) && c.id === shownId);
  const currentResolved = currentId ? store.comments.find((c) => c.id === currentId && c.status === 'resolved' && anchored.has(c.id)) : undefined;
  // A card that changes size (the draft growing as it is typed, a reply opening)
  // is placed again, so it never grows over its words or past the view.
  const cardRO = useRef<ResizeObserver | null>(null);
  if (!cardRO.current && typeof ResizeObserver !== 'undefined') {
    cardRO.current = new ResizeObserver(() => requestAnimationFrame(() => placeRef.current()));
  }
  useEffect(() => () => cardRO.current?.disconnect(), []);
  // One ref callback per card, kept, so a render does not detach and re-observe it.
  const cardRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const setCardEl = (id: string) => {
    let fn = cardRefs.current.get(id);
    if (!fn) {
      fn = (el: HTMLDivElement | null) => {
        const was = cardEls.current.get(id);
        if (was && was !== el) cardRO.current?.unobserve(was);
        if (el) { cardEls.current.set(id, el); cardRO.current?.observe(el); } else cardEls.current.delete(id);
      };
      cardRefs.current.set(id, fn);
    }
    return fn;
  };
  // The card shown changed (opened, the pointer on other words): placed before the paint.
  useLayoutEffect(() => { place(); }, [place, shownId, draft]);
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
    <div ref={layerRef} className="fv-doc-comments" data-testid="doc-comments" data-file-path={filePath}>
      <DocCommentsHead
        comments={store.comments}
        openCount={open.length}
        changed={outdatedIds}
        sourceOnly={sourceOnly}
        error={store.saveError ? `Not saved yet: ${store.saveError}` : store.readError ? `Comments not read: ${store.readError}` : null}
        listOpen={listOpen}
        onToggle={() => setListOpen((o) => !o)}
        onShow={(id) => show(id, 'list')}
        onResolve={(c) => store.edit(setDocResolved(c.id, c.status !== 'resolved', USER_AUTHOR, now()), c.status === 'resolved' ? 'reopen' : 'resolve')}
      />
      <div
        className="doc-comments-inplace"
        // The cards sit over the doc's scroller: a wheel over one scrolls the doc.
        onWheel={(e) => {
          if ((e.target as HTMLElement).closest('textarea')) return;
          const scroller = scrollerOf(bodyNow());
          if (scroller) scroller.scrollTop += e.deltaY;
        }}
      >
        {inPlace.map(card)}
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
