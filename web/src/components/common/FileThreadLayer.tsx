/**
 * Questions about a passage of the file on show (the Files tab).
 *
 * The layer is a box over the file view that: paints a grey mark on every
 * passage of this file a question is about (a click opens the question's
 * card), lends the timeline the host box its comment card is drawn into beside
 * the passage (FileCardHost; the card itself, its turns and its composer are
 * the timeline's), offers an inline `Ask` on the block under the pointer, and
 * turns a selection into a draft question (`askSelection`, the pill's `Ask
 * here`). The HTML preview lives in an iframe, so marks and hits there run in
 * the frame's own document.
 *
 * The box does not scroll: the file's own surface does (editor scroller, the
 * frame's document), so placement is re-measured on scroll, resize and DOM
 * change, and a passage scrolled past an edge keeps its card docked there.
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject,
} from 'react';
import { useSessionThreadsApi } from '@/contexts/SessionThreadsContext';
import { liveBarsFor, markHighlightName, useAnsweringKeys, useThreadMarks } from '@/hooks/useThreadMarks';
import { LIVE_BAR_HEIGHT, LIVE_LINE_CLASS, LIVE_SCAN_MS, paintLiveBars, type BoxLike } from '@/utils/thread-live-lines';
import { ThreadMarkTipLayer } from '@/components/sessions/ThreadStackFrame';
import { fileOfParent, fileParentOf, findSamePassageThread } from '@/utils/thread-tree';
import { pendingPageKey } from '@/utils/thread-stack-state';
import type { SessionPinnedQuote } from '@/types/session';
import { buildTextIndex, quoteFromRange, rangeForQuote } from '@/utils/text-quote-anchor';
import {
  askableBlockOf, blockQuoteOf, fileQuestionMarks, fileQuestionRows, placeFileCard, rectInHost, toHostRect, type HostRect,
} from '@/utils/file-thread';
import { FileQuestionRail } from '@/components/common/FileQuestionRail';
import { caretFromPoint, hitMark, rafThrottle, selectionIsEmpty, type ThreadMark } from '@/utils/thread-mark-hit';
import { log } from '@/utils/log';
import '@/styles/file-thread.css';

export type FileThreadSurface = 'html' | 'wysiwyg' | 'source' | 'preview' | 'pre' | 'none';

export interface FileThreadLayerHandle {
  /** The pill's `Ask here`: the selection (the live one, in the frame's document
   *  for the HTML preview; or `range`, the editor's own, from the WYSIWYG bubble
   *  menu) becomes a draft question with its card beside it. */
  askSelection: (opts: { inFrame: boolean; line?: number; range?: Range }) => void;
}

interface FileThreadLayerProps {
  filePath: string;
  sessionId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLIFrameElement | null>;
  surface: FileThreadSurface;
  /** Changes when the surface remounts or reloads (the ranges must be re-derived). */
  surfaceNonce: unknown;
}

/** The text body of the surface on show, in whichever document holds it. */
function bodyOf(root: HTMLElement | null, frame: HTMLIFrameElement | null, surface: FileThreadSurface): Element | null {
  if (surface === 'html') {
    try { return frame?.contentDocument?.body ?? null; } catch { return null; }
  }
  return root?.querySelector('.ProseMirror, .fv-md-preview, .file-viewer-code, .cm-content') ?? null;
}

const FRAME_STYLE_ID = 'walnut-file-marks';
const FRAME_LIVE_ID = 'walnut-live-lines';
/** The frame's copy of the mark paint (thread-stack-page.css), live line included. */
const FRAME_STYLE = `
::highlight(thread-mark-neutral) { background-color: hsl(42 95% 55% / 0.28); text-decoration: underline 2px hsl(34 85% 45% / 0.9); text-underline-offset: 3px; }
::highlight(thread-mark-done-neutral) { background-color: hsl(0 0% 50% / 0.12); text-decoration: underline 1.5px hsl(0 0% 52% / 0.6); text-underline-offset: 3px; }
::highlight(thread-mark-live-neutral) { background-color: hsl(42 95% 55% / 0.28); }
body[data-thread-mark-hover] { cursor: pointer; }
#${FRAME_LIVE_ID} { position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible; pointer-events: none; z-index: 2147483000; }
.${LIVE_LINE_CLASS} { position: absolute; height: ${LIVE_BAR_HEIGHT}px; border-radius: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, #9a6235, transparent) no-repeat, hsl(28 40% 70% / 0.55);
  background-size: 40% 100%, 100% 100%; animation: walnut-live-scan ${LIVE_SCAN_MS}ms ease-in-out infinite; }
@keyframes walnut-live-scan { 0% { background-position: -40% 0, 0 0; } 100% { background-position: 140% 0, 0 0; } }
@media (prefers-reduced-motion: reduce) { .${LIVE_LINE_CLASS} { animation: none; background: #9a6235; opacity: 0.7; } }
`;

export const FileThreadLayer = forwardRef<FileThreadLayerHandle, FileThreadLayerProps>(function FileThreadLayer(
  { filePath, sessionId, rootRef, frameRef, surface, surfaceNonce }, ref,
) {
  const threads = useSessionThreadsApi();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const argsRef = useRef({ threads, filePath, surface });
  argsRef.current = { threads, filePath, surface };
  const parent = fileParentOf(filePath);

  const body = useCallback(() => bodyOf(rootRef.current, frameRef.current, argsRef.current.surface), [rootRef, frameRef]);

  // Another file (or none) takes the view while an Ask about this one is open
  // and unwritten: the card closes, which leaves nothing of it behind.
  useEffect(() => () => {
    const t = argsRef.current.threads;
    const p = t.stack.pending;
    if (p && fileOfParent(p.parentMsgId) === filePath && t.openCardKey === p.pageKey) t.requestCard(null, 'file-left');
  }, [filePath]);

  // ── Marks on this file's asked passages (top document) ──
  const pending = threads.stack.pending;
  const draftPages = threads.stack.draftPages;
  // The Ask being written, then the drafts left with words (each a dashed mark).
  const unsent = useMemo(() => (pending ? [pending, ...draftPages] : draftPages), [pending, draftPages]);
  const specs = useMemo(() => fileQuestionMarks(threads.tree, threads.hiddenKeys, threads.metaIndex, filePath, unsent),
    [threads.tree, threads.hiddenKeys, threads.metaIndex, filePath, unsent]);
  // The rail's rows: the same questions, the open card (else the target) current.
  const railCurrent = threads.openCardKey ?? threads.currentThreadKey;
  const railRows = useMemo(
    () => fileQuestionRows(threads.tree, threads.hiddenKeys, threads.metaIndex, filePath, unsent, railCurrent, threads.unreadKeys),
    [threads.tree, threads.hiddenKeys, threads.metaIndex, filePath, unsent, railCurrent, threads.unreadKeys],
  );
  // Where the rail sits: under the view's toolbar, at the left edge. The toolbar
  // is sticky, so when the view's PARENT scrolls (the HTML preview is a plain
  // block taller than its pane) its bottom moves relative to the view while this
  // box, which is the view's size, does not: re-measure on every scroll in the
  // document, not only on resize, or the rail slides up under the toolbar.
  const [railBox, setRailBox] = useState({ top: 4, room: 0 });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const bar = root.querySelector<HTMLElement>(':scope > .fv-html-toolbar');
      const rootBox = root.getBoundingClientRect();
      // A toolbar scrolled away (static in fullscreen) leaves the rail at the view's top.
      const barBottom = Math.max(bar ? bar.getBoundingClientRect().bottom : 0, rootBox.top);
      const top = Math.round(barBottom - rootBox.top + 4);
      const visibleBottom = Math.min(rootBox.bottom, window.innerHeight);
      const room = Math.max(0, Math.round(visibleBottom - rootBox.top - top - 8));
      setRailBox((prev) => (prev.top === top && prev.room === room ? prev : { top, room }));
    };
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(root);
    document.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    return () => {
      ro?.disconnect();
      document.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rootRef, surfaceNonce]);
  const openFromRail = useCallback((key: string) => {
    log.info('threads', 'file rail row opened', { sessionId, path: filePath, key });
    argsRef.current.threads.requestCard(key, 'file-rail');
  }, [sessionId, filePath]);
  const openCard = useCallback((key: string, via: string) => argsRef.current.threads.requestCard(key, via), []);
  const locatePassage = useCallback((p: { msgId: string; quote?: SessionPinnedQuote }) => {
    const b = body();
    return b && p.quote ? rangeForQuote(b, p.quote) : null;
  }, [body]);
  // A question being answered: its passage's line scans (the overlay is re-placed
  // on scroll; in the HTML frame the lines live in the frame's own document).
  const liveKeys = useAnsweringKeys(threads.derived.live);
  const liveRef = useRef<HTMLDivElement | null>(null);
  /** The file's visible box: under the sticky toolbar, inside the window. */
  const visibleBox = useCallback((): BoxLike | null => {
    const root = rootRef.current;
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const bar = root.querySelector<HTMLElement>(':scope > .fv-html-toolbar');
    const top = Math.max(r.top, bar ? bar.getBoundingClientRect().bottom : r.top, 0);
    return { left: r.left, top, right: r.right, bottom: Math.min(r.bottom, window.innerHeight) };
  }, [rootRef]);
  const tips = useThreadMarks({
    sessionId, panelKey: `file:${sessionId}:${filePath}`, enabled: surface !== 'html' && surface !== 'none',
    containerRef: rootRef, specs, renderNonce: surfaceNonce, locatePassage, onOpen: (key) => openCard(key, 'file-mark'),
    live: { keys: liveKeys, layerRef: liveRef, overlay: true, clip: visibleBox },
  });

  // ── Marks inside the HTML preview's frame (its own document and highlight registry) ──
  const frameMarks = useRef<ThreadMark[]>([]);
  useEffect(() => {
    const frame = frameRef.current;
    if (surface !== 'html' || !frame) return;
    let doc: Document | null = null;
    let raf = 0;
    let mo: MutationObserver | null = null;
    const names = new Set<string>();
    const clear = () => {
      const w = doc?.defaultView as (Window & { CSS?: { highlights?: Map<string, unknown> } }) | null | undefined;
      for (const n of names) w?.CSS?.highlights?.delete(n);
      names.clear();
      frameMarks.current = [];
      doc?.body?.removeAttribute('data-thread-mark-hover');
      doc?.getElementById(FRAME_LIVE_ID)?.remove();
    };
    // The scanning lines: in a layer on the frame's root element (outside the
    // body the observer watches), so they scroll with the page by themselves.
    const paintLive = () => {
      if (!doc?.documentElement) return;
      let layer = doc.getElementById(FRAME_LIVE_ID);
      if (!frameMarks.current.some((m) => m.live)) { layer?.remove(); return; }
      if (!layer) {
        layer = doc.createElement('div');
        layer.id = FRAME_LIVE_ID;
        layer.setAttribute('aria-hidden', 'true');
        doc.documentElement.appendChild(layer);
      }
      paintLiveBars(layer, liveBarsFor(frameMarks.current, layer, doc.documentElement, null));
    };
    const paint = () => {
      if (!doc?.body) return;
      const w = doc.defaultView as (Window & { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...r: Range[]) => { priority: number } }) | null;
      const reg = w?.CSS?.highlights;
      const Ctor = w?.Highlight;
      const out: ThreadMark[] = [];
      const byName = new Map<string, Range[]>();
      for (const s of specs) {
        const range = rangeForQuote(doc.body, s.quote);
        if (!range) continue;
        const live = liveKeys.has(s.key);
        out.push({ key: s.key, headId: s.headId, range, hue: s.hue, resolved: s.resolved, title: s.title, neutral: true, ...(live ? { live } : {}) });
        const name = markHighlightName(s.hue, s.resolved, true, live);
        byName.set(name, [...(byName.get(name) ?? []), range]);
      }
      frameMarks.current = out;
      paintLive();
      if (!reg || !Ctor) return;
      for (const n of names) if (!byName.has(n)) reg.delete(n);
      names.clear();
      for (const [name, ranges] of byName) { const h = new Ctor(...ranges); h.priority = 2; reg.set(name, h); names.add(name); }
    };
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
    // An inner scroller of the page (not the page itself) moves the passage too.
    const onFrameScroll = () => { if (frameMarks.current.some((m) => m.live)) paintLive(); };
    const at = (x: number, y: number) => (doc ? hitMark(frameMarks.current, caretFromPoint(doc, x, y), x, y) : null);
    const move = rafThrottle<{ x: number; y: number }>(({ x, y }) => {
      if (!doc?.body) return;
      if (at(x, y)) doc.body.setAttribute('data-thread-mark-hover', ''); else doc.body.removeAttribute('data-thread-mark-hover');
    });
    const onMove = (e: PointerEvent) => move.call({ x: e.clientX, y: e.clientY });
    // The timeline's outside-click closer listens on the top document, which a
    // press inside the frame never reaches: close the card from here.
    const onDown = (e: PointerEvent) => {
      const t = argsRef.current.threads;
      if (t.openCardKey && !at(e.clientX, e.clientY)) t.requestCard(null, 'frame-outside');
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || !doc || !selectionIsEmpty(doc.getSelection())) return;
      const hit = at(e.clientX, e.clientY);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      log.info('threads', 'file mark click (html preview)', { sessionId, headId: hit.headId ?? '', path: filePath });
      openCard(hit.key, 'file-mark');
    };
    const detach = () => {
      if (!doc) return;
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('scroll', onFrameScroll, true);
      doc.defaultView?.removeEventListener('resize', later);
      mo?.disconnect();
      mo = null;
      clear();
      doc = null;
    };
    const attach = () => {
      detach();
      try { doc = frame.contentDocument; } catch { doc = null; }
      if (!doc?.body) return;
      if (!doc.getElementById(FRAME_STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = FRAME_STYLE_ID;
        style.textContent = FRAME_STYLE;
        doc.head?.appendChild(style);
      }
      doc.addEventListener('pointermove', onMove, { passive: true });
      doc.addEventListener('pointerdown', onDown, true);
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('scroll', onFrameScroll, { capture: true, passive: true });
      doc.defaultView?.addEventListener('resize', later);
      mo = new MutationObserver(later);
      mo.observe(doc.body, { childList: true, subtree: true, characterData: true });
      paint();
    };
    frame.addEventListener('load', attach);
    if (frame.contentDocument?.readyState === 'complete') attach();
    return () => {
      frame.removeEventListener('load', attach);
      if (raf) cancelAnimationFrame(raf);
      move.cancel();
      detach();
    };
  }, [surface, surfaceNonce, specs, liveKeys, frameRef, filePath, sessionId, openCard]);

  // ── The card's host: registered while this file is on show; its place is
  //    measured while the open card is about a passage of this file. ──
  const openKey = threads.openCardKey;
  const cardPlaceOf = useCallback((key: string): { quote?: SessionPinnedQuote } | null => {
    const t = argsRef.current.threads;
    const pend = t.stack.pending?.pageKey === key ? t.stack.pending : undefined;
    if (pend) return fileOfParent(pend.parentMsgId) === argsRef.current.filePath ? { ...(pend.quote ? { quote: pend.quote } : {}) } : null;
    const node = t.tree.byKey.get(key);
    if (!node || node.file?.path !== argsRef.current.filePath) return null;
    return { ...(node.quote ? { quote: node.quote } : {}) };
  }, []);
  const mine = openKey ? cardPlaceOf(openKey) : null;
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    const layer = layerRef.current;
    const root = rootRef.current;
    const set = argsRef.current.threads.setFileCardHost;
    if (!layer || !root) return;
    if (!openKey || !mine) {
      // Closed: the next open of any card, the same one included (the rail, a
      // mark, the sidebar), brings its passage on screen again. Kept per key,
      // a reopen after the reader scrolled away docked the card at the edge
      // over whatever was showing (2026-10-03).
      if (!openKey) scrolledForRef.current = null;
      set({ path: filePath, el: layer, place: null });
      return;
    }
    const frame = () => (argsRef.current.surface === 'html' ? frameRef.current : null);
    const measure = () => {
      const hostBox = root.getBoundingClientRect();
      const host = { width: hostBox.width, height: hostBox.height };
      const b = body();
      const range = b && mine.quote ? rangeForQuote(b, mine.quote) : null;
      let anchor: HostRect;
      if (range) {
        const rects = range.getClientRects();
        const whole = range.getBoundingClientRect();
        const last = rects.length ? rects[rects.length - 1] : whole;
        const f = frame()?.getBoundingClientRect() ?? null;
        anchor = toHostRect(new DOMRect(whole.left, whole.top, whole.width, last.bottom - whole.top), hostBox, f);
        // First time this card opens here: bring its passage on screen.
        if (scrolledForRef.current !== openKey) {
          scrolledForRef.current = openKey;
          if (!rectInHost(anchor, host, 24)) {
            const el = range.startContainer.parentElement;
            el?.scrollIntoView({ block: 'center' });
            return later();
          }
        }
      } else {
        anchor = { top: 8, bottom: 8, left: 0, right: host.width };
      }
      set({ path: filePath, el: layer, place: placeFileCard(anchor, host) });
    };
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    measure();
    const mo = new MutationObserver(later);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(root);
    root.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    let fdoc: Document | null = null;
    try { fdoc = frame()?.contentDocument ?? null; } catch { fdoc = null; }
    fdoc?.addEventListener('scroll', later, true);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      root.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      fdoc?.removeEventListener('scroll', later, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [openKey, mine?.quote?.exact, filePath, surfaceNonce, body, rootRef, frameRef]);
  useEffect(() => () => { argsRef.current.threads.setFileCardHost(null); }, []);
  useEffect(() => { scrolledForRef.current = null; }, [filePath]);

  // ── Ask: a quote of this file becomes a draft question with its card ──
  const askQuote = useCallback((quote: SessionPinnedQuote, line: number | undefined, via: string) => {
    const t = argsRef.current.threads;
    if (!t.canAsk) return;
    const same = findSamePassageThread(t.tree, t.anchors, t.hiddenKeys, { parent, quote });
    t.stack.ask({ msgId: parent, quote, ...(line ? { line } : {}) }, { focusComposer: false });
    t.requestCard(same ?? pendingPageKey(parent, quote.exact), via);
    log.info('threads', 'ask about a file passage', { sessionId, path: filePath, line: line ?? null, via, same: !!same });
  }, [parent, filePath, sessionId]);

  useImperativeHandle(ref, () => ({
    askSelection: ({ inFrame, line, range: given }) => {
      let doc: Document | null = document;
      if (inFrame) { try { doc = frameRef.current?.contentDocument ?? null; } catch { doc = null; } }
      const sel = doc?.getSelection();
      const b = body();
      const range = given ?? (sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null);
      if (!range || range.collapsed || !b || !b.contains(range.commonAncestorContainer)) return;
      const quote = quoteFromRange(buildTextIndex(b), range);
      if (!quote) return;
      sel?.removeAllRanges();
      askQuote(quote, line, 'file-selection');
    },
  }), [askQuote, body, frameRef]);

  // ── The inline Ask on the block under the pointer ──
  const [hover, setHover] = useState<{ el: Element; rect: HostRect } | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !threads.canAsk || surface === 'none') return;
    const frameDoc = (): Document | null => {
      if (argsRef.current.surface !== 'html') return null;
      try { return frameRef.current?.contentDocument ?? null; } catch { return null; }
    };
    const pick = rafThrottle<{ x: number; y: number; inFrame: boolean }>(({ x, y, inFrame }) => {
      const b = body();
      if (!b) { if (hoverRef.current) setHover(null); return; }
      const doc = inFrame ? frameDoc() : document;
      const target = doc?.elementFromPoint(x, y) ?? null;
      const block = askableBlockOf(target, b);
      if (!block) {
        // Leaving the block for its own Ask button keeps the button.
        if (hoverRef.current && target?.closest?.('.fv-ask-block')) return;
        if (hoverRef.current) setHover(null);
        return;
      }
      const hostBox = root.getBoundingClientRect();
      const f = inFrame ? frameRef.current?.getBoundingClientRect() ?? null : null;
      const rect = toHostRect(block.getBoundingClientRect(), hostBox, f);
      const prev = hoverRef.current;
      if (prev && prev.el === block && Math.abs(prev.rect.top - rect.top) < 1 && Math.abs(prev.rect.right - rect.right) < 1) return;
      setHover({ el: block, rect });
    });
    const onMove = (e: PointerEvent) => pick.call({ x: e.clientX, y: e.clientY, inFrame: false });
    const onLeave = (e: PointerEvent) => {
      const to = e.relatedTarget as Element | null;
      if (to?.closest?.('.fv-ask-block')) return;
      pick.cancel();
      setHover(null);
    };
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerleave', onLeave);
    const fd = frameDoc();
    const onFrameMove = (e: PointerEvent) => pick.call({ x: e.clientX, y: e.clientY, inFrame: true });
    fd?.addEventListener('pointermove', onFrameMove, { passive: true });
    const onScroll = () => { pick.cancel(); setHover(null); };
    root.addEventListener('scroll', onScroll, true);
    fd?.addEventListener('scroll', onScroll, true);
    return () => {
      pick.cancel();
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', onLeave);
      fd?.removeEventListener('pointermove', onFrameMove);
      root.removeEventListener('scroll', onScroll, true);
      fd?.removeEventListener('scroll', onScroll, true);
    };
  }, [rootRef, frameRef, surface, surfaceNonce, threads.canAsk, body]);
  useEffect(() => { setHover(null); }, [filePath, surfaceNonce]);

  const askBlock = useCallback(() => {
    const h = hoverRef.current;
    const b = body();
    if (!h || !b || !b.contains(h.el)) return;
    const quote = blockQuoteOf(buildTextIndex(b), h.el);
    if (!quote) return;
    const ln = h.el.closest('[data-line]')?.getAttribute('data-line');
    const line = ln ? Number(ln) : undefined;
    setHover(null);
    askQuote(quote, Number.isFinite(line) ? line : undefined, 'file-block');
  }, [askQuote, body]);

  if (!threads.canAsk) return null;
  const hostW = rootRef.current?.clientWidth ?? 0;
  return (
    <div ref={layerRef} className="fv-thread-layer" data-file-path={filePath} data-surface={surface}>
      {/* Scanning lines under passages being answered (useThreadMarks draws them). */}
      <div ref={liveRef} className="fv-live-lines" aria-hidden="true" />
      <FileQuestionRail rows={railRows} top={railBox.top} room={railBox.room} boxWidth={hostW} onOpen={openFromRail} />
      <ThreadMarkTipLayer store={tips} />
      {hover && (
        <button
          type="button"
          className="fv-ask-block"
          style={{ top: Math.max(0, Math.round(hover.rect.top)), left: Math.max(0, Math.min(Math.round(hover.rect.right) - 44, hostW - 48)) }}
          title="Ask about this passage"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={askBlock}
        >
          Ask
        </button>
      )}
    </div>
  );
});
