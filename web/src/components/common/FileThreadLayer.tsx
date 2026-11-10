/**
 * Questions about a passage of the file on show (the Files tab).
 *
 * The layer is a box over the file view that: paints a grey mark on every
 * passage of this file a question is about (a click opens the question's
 * card), lends the timeline the host box its comment card is drawn into beside
 * the passage (FileCardHost; the card itself, its turns and its composer are
 * the timeline's), offers an inline `Ask` on the block under the pointer, and
 * turns a selection into a draft question (`askSelection`, the pill's `Ask
 * here`). The HTML preview's page runs in an origin of its own: its marks are
 * painted and hit-tested there by the page's bridge, from offsets the layer
 * locates in the page's text (preview-marks.ts), and its scanning lines are drawn
 * here, from the rects the page reports.
 *
 * The Changed tab mounts the same layer over a file's diff (surface `diff`): its
 * index holds only the current file's text (diff-passage.ts: no gutters, no
 * removed lines, one copy of a split line), so a question asked there is the
 * same record as one asked in the Files tab, and each view finds the other's.
 *
 * The box does not scroll: the file's own surface does (editor scroller, the
 * frame's document), so placement is re-measured on scroll, resize and DOM
 * change, and a passage scrolled past an edge keeps its card docked there.
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { useSessionThreadsApi } from '@/contexts/SessionThreadsContext';
import {
  byUrgency, liveBarsFor, markFlagsOf, markHighlightName, markPriority, useAnsweringKeys, useThreadMarks,
} from '@/hooks/useThreadMarks';
import {
  liveLineBars, paintLiveBars, type BoxLike, type PaintedBar,
} from '@/utils/thread-live-lines';
import { ThreadMarkTipLayer } from '@/components/sessions/ThreadStackFrame';
import { fileOfParent, fileParentOf, findSamePassageThread } from '@/utils/thread-tree';
import { pendingPageKey } from '@/utils/thread-stack-state';
import type { SessionPinnedQuote } from '@/types/session';
import { buildTextIndex, locateQuote, quoteFromRange, quoteFromText, rangeForQuote, rangePieces, type QuoteLines, type QuoteSkip } from '@/utils/text-quote-anchor';
import { DIFF_FILE_TEXT_SKIP } from '@/utils/diff-passage';
import {
  ASK_CHIP_HEIGHT, ASK_CHIP_WIDTH, askableBlockOf, blockQuoteOf, cardNaturalHeight, fileQuestionMarks, fileQuestionRows, lastLineRect, neighbourLines, placeAskChip, placeFileCard,
  rectInHost, toHostRect, type HostRect,
} from '@/utils/file-thread';
import { FileQuestionRail } from '@/components/common/FileQuestionRail';
import { rafThrottle } from '@/utils/thread-mark-hit';
import { log } from '@/utils/log';
import { ContextMenu } from '@/components/common/ContextMenu';
import type { PreviewChannel } from './preview-frame';
import { FrameMarkGroup, toTop, unionOf, type FrameMarkSpec } from './preview-marks';
import '@/styles/file-thread.css';

export type FileThreadSurface = 'html' | 'wysiwyg' | 'source' | 'preview' | 'pre' | 'diff' | 'none';

/** What an Ask did: the card opened, or why it could not (logged, and the
 *  caller shows it: a pressed Ask here never does nothing). */
export type FileAskResult = { ok: true } | { ok: false; reason: FileAskFailure };
export type FileAskFailure = 'no-selection' | 'not-in-file' | 'no-text' | 'cannot-ask' | 'no-layer';

/** Why an Ask here opened no card, in the words the file view shows. */
export const FILE_ASK_FAILURE_TEXT: Record<FileAskFailure, string> = {
  'no-selection': 'Ask here found no selected words: select the passage again',
  'not-in-file': 'The view changed under the selection: select the passage again',
  'no-text': 'Only the file\'s text can be asked about: select some words of it',
  'cannot-ask': 'Questions cannot be asked in this session right now',
  'no-layer': 'The file is still loading: select the passage again in a moment',
};

export interface FileThreadLayerHandle {
  /** The selection as a quote of this file, read now (the pill takes it at
   *  mouseup: by its click the DOM the selection was in may have been replaced,
   *  and a quote is text, found again in whatever DOM shows the file). The live
   *  selection (in the frame's document for the HTML preview) or `range`. */
  quoteOf: (opts: { inFrame: boolean; range?: Range }) => SessionPinnedQuote | null;
  /** The pill's `Ask here`: the selection (the live one; the page's last reported
   *  one for the HTML preview; or `range`, the editor's own, from the WYSIWYG bubble
   *  menu) becomes a draft question with its card beside it. */
  askSelection: (opts: { inFrame: boolean; line?: number; range?: Range }) => FileAskResult;
  /** A quote taken already (the Changed tab reads it at mouseup: diffPassageOf;
   *  the Files tab's pill, quoteOf) becomes a draft question with its card beside it. */
  askPassage: (opts: { quote: SessionPinnedQuote; line?: number; inFrame?: boolean }) => FileAskResult;
}

interface FileThreadLayerProps {
  filePath: string;
  sessionId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  /** The HTML preview's page (its bridge), when that is the surface. */
  channel: PreviewChannel | null;
  surface: FileThreadSurface;
  /** Changes when the surface remounts or reloads (the ranges must be re-derived). */
  surfaceNonce: unknown;
}

/** The text body of the surface on show (none for the HTML preview, out of reach in its frame). */
function bodyOf(root: HTMLElement | null, surface: FileThreadSurface): Element | null {
  if (surface === 'html') return null;
  if (surface === 'diff') return root?.querySelector('.session-diff-filepane') ?? null;
  return root?.querySelector('.ProseMirror, .fv-md-preview, .file-viewer-code, .cm-content') ?? null;
}

/** The read-only code view's rows: `data-line` numbers. */
const PRE_LINES: QuoteLines = {
  rowOf: (t) => t.parentElement?.closest('.fv-line[data-line]') ?? null,
  breaks: (prev, next) => Math.max(0, Number(next.getAttribute('data-line')) - Number(prev.getAttribute('data-line')) || 0),
};

/** The source editor's rows: CodeMirror's `.cm-line` elements, one per line in
 *  its drawn window (a blank line is a row with no text). */
const CM_LINES: QuoteLines = {
  rowOf: (t) => t.parentElement?.closest('.cm-line') ?? null,
  breaks: (prev, next) => {
    let n = 0;
    for (let el = prev.nextElementSibling; el && n < 100_000; el = el.nextElementSibling) {
      if (el.classList.contains('cm-line')) n++;
      if (el === next) return n;
    }
    return 0;
  },
};

/** How a surface's body is indexed: chrome that is not the file's text (the
 *  read-only code view's line numbers, a diff's gutters and removed lines;
 *  without it a passage over two lines quoted the number between them), and the
 *  line rows of the views that draw a file line by line, so a passage over
 *  several lines is quoted with the file's line breaks. */
const TEXT_SKIP: Partial<Record<FileThreadSurface, QuoteSkip>> = {
  pre: { selector: '.fv-line-num', lines: PRE_LINES },
  source: { lines: CM_LINES },
  diff: DIFF_FILE_TEXT_SKIP,
};

/** A file question is found in every view of the file, whatever its views make
 *  of line and block breaks (locateQuote's `ignoreWhitespace`). */
const LOCATE_FILE = { ignoreWhitespace: true } as const;
/** On the layer while the open card's height is not known yet: the card is
 *  drawn unseen until its side is decided (file-thread.css). */
const CARD_MEASURE_ATTR = 'data-card-measure';

/** Where a code surface's text column starts (its line-number gutter ends
 *  there): the card never covers the gutter (2026-11-06: in the read-only code
 *  view it sat over the numbers with a highlighted glyph peeking past its edge). */
const CODE_COLUMN: Partial<Record<FileThreadSurface, string>> = {
  pre: '.fv-line-text',
  source: '.cm-content',
  diff: 'td.diff-code, .session-diff-rendered-main',
};

/** The sticky bar at the top of the surface (the rail sits under it). */
function stickyBarOf(root: HTMLElement, surface: FileThreadSurface): HTMLElement | null {
  return root.querySelector<HTMLElement>(surface === 'diff' ? '.session-diff-filepane-sticky' : ':scope > .fv-html-toolbar');
}

/** The page's copy of the mark paint (thread-stack-page.css, light theme: the
 *  page in the frame brings its own colors). */
const FRAME_STYLE = `
::highlight(thread-mark-waiting-neutral) { background-color: hsl(45 95% 55% / 0.32); text-decoration: underline dashed 2px hsl(36 90% 42% / 0.95); text-underline-offset: 3px; }
::highlight(thread-mark-live-neutral) { background-color: hsl(140 60% 48% / 0.22); }
::highlight(thread-mark-unread-neutral) { background-color: hsl(0 90% 60% / 0.22); text-decoration: underline 3px hsl(0 78% 46%); text-underline-offset: 3px; }
::highlight(thread-mark-failed-neutral) { background-color: hsl(345 70% 60% / 0.12); text-decoration: underline dotted 2px hsl(345 70% 44%); text-underline-offset: 3px; }
::highlight(thread-mark-neutral) { background-color: hsl(140 50% 48% / 0.15); text-decoration: underline 1px hsl(145 55% 34% / 0.85); text-underline-offset: 3px; }
::highlight(thread-mark-done-neutral) { background-color: hsl(0 0% 50% / 0.12); text-decoration: underline 1.5px hsl(0 0% 52% / 0.6); text-underline-offset: 3px; }
html[data-walnut-mark-hover], html[data-walnut-mark-hover] * { cursor: pointer; }
`;
/** The anchor the open card is placed by (painted by nothing: its mark is the question's).
 *  One per passage, so a report about the last card's passage is never read as this one's. */
const CARD_KEY = '__card__';
const cardKeyOf = (quote: SessionPinnedQuote | undefined): string | null => (quote ? `${CARD_KEY}${quote.exact}` : null);
/** How long a card in the HTML preview waits, unseen, for its page to report where its passage is. */
const FRAME_RECTS_WAIT_MS = 1500;

const within = (a: BoxLike | null, b: BoxLike | null): BoxLike | null => {
  if (!a) return b;
  if (!b) return a;
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
};

export const FileThreadLayer = forwardRef<FileThreadLayerHandle, FileThreadLayerProps>(function FileThreadLayer(
  { filePath, sessionId, rootRef, channel, surface, surfaceNonce }, ref,
) {
  const threads = useSessionThreadsApi();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const argsRef = useRef({ threads, filePath, surface });
  argsRef.current = { threads, filePath, surface };
  const parent = fileParentOf(filePath);

  const body = useCallback(() => bodyOf(rootRef.current, argsRef.current.surface), [rootRef]);
  const skip = TEXT_SKIP[surface];

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
  // Each painted by its question's state; an Ask not sent yet in the waiting
  // color, without the pulse.
  const markStates = threads.markStates;
  const specs = useMemo(() => fileQuestionMarks(threads.tree, threads.hiddenKeys, threads.metaIndex, filePath, unsent)
    .map((m) => {
      const state = m.draft ? 'waiting' : markStates.get(m.key);
      return state ? { ...m, state } : m;
    }),
  [threads.tree, threads.hiddenKeys, threads.metaIndex, filePath, unsent, markStates]);
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
      const bar = stickyBarOf(root, argsRef.current.surface);
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
    return b && p.quote ? rangeForQuote(b, p.quote, skip, LOCATE_FILE) : null;
  }, [body, skip]);
  // Where the surface has chrome between its lines, a mark paints only the text.
  const piecesOf = useCallback((range: Range) => {
    const b = body();
    return b && skip ? rangePieces(buildTextIndex(b, skip), range) : null;
  }, [body, skip]);
  // A question being answered: its passage's line scans (the overlay is re-placed
  // on scroll; in the HTML frame the lines live in the frame's own document).
  const liveKeys = useAnsweringKeys(threads.derived.live);
  const liveRef = useRef<HTMLDivElement | null>(null);
  /** The file's visible box: under the sticky toolbar, inside the window. */
  const visibleBox = useCallback((): BoxLike | null => {
    const root = rootRef.current;
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const bar = stickyBarOf(root, argsRef.current.surface);
    const top = Math.max(r.top, bar ? bar.getBoundingClientRect().bottom : r.top, 0);
    return { left: r.left, top, right: r.right, bottom: Math.min(r.bottom, window.innerHeight) };
  }, [rootRef]);
  const tips = useThreadMarks({
    sessionId, panelKey: `file:${sessionId}:${filePath}`, enabled: surface !== 'html' && surface !== 'none',
    containerRef: rootRef, specs, renderNonce: surfaceNonce, locatePassage, ...(skip ? { piecesOf } : {}), onOpen: (key) => openCard(key, 'file-mark'),
    // The mark's own menu quotes into the chat, which only Conversation Mode does.
    ...(threads.viewMode === 'linear' ? { onMenu: (key: string, at: { x: number; y: number }) => setMarkMenu({ key, point: at }) } : {}),
    live: { keys: liveKeys, layerRef: liveRef, overlay: true, clip: visibleBox },
  });
  // A right-click on a mark: open its question, or quote it into the chat.
  const [markMenu, setMarkMenu] = useState<{ key: string; point: { x: number; y: number } } | null>(null);

  // ── Marks inside the HTML preview (painted by its page, from offsets into its text) ──
  const group = useMemo(() => (channel ? new FrameMarkGroup(channel, 'threads') : null), [channel]);
  const openKey = threads.openCardKey;
  // The open card's passage, when it is about this file (null otherwise).
  const cardPlaceOf = useCallback((key: string): { quote?: SessionPinnedQuote } | null => {
    const t = argsRef.current.threads;
    const pend = t.stack.pending?.pageKey === key ? t.stack.pending : undefined;
    if (pend) return fileOfParent(pend.parentMsgId) === argsRef.current.filePath ? { ...(pend.quote ? { quote: pend.quote } : {}) } : null;
    const node = t.tree.byKey.get(key);
    if (!node || node.file?.path !== argsRef.current.filePath) return null;
    return { ...(node.quote ? { quote: node.quote } : {}) };
  }, []);
  const mine = openKey ? cardPlaceOf(openKey) : null;
  const cardQuote = mine?.quote;
  /** Which of the page's marks wear the scanning line (scan) or the waiting pulse. */
  const frameLines = useRef(new Map<string, { live: boolean; wait: boolean }>());
  /** The open card's passage in the page: its anchor key once sent, `missing` when the
   *  page's text does not hold it, null while the page's text has not come yet. */
  const cardInPage = useRef<string | null>(null);
  /** The scanning lines under the page's passages, drawn in this layer's overlay. */
  const paintFrameLines = useCallback(() => {
    const layer = liveRef.current;
    if (!layer) return;
    const fb = argsRef.current.surface === 'html' ? channel?.frameBox() : null;
    const bars: PaintedBar[] = [];
    if (fb && group) {
      const origin = layer.getBoundingClientRect();
      const clip = within(visibleBox(), { left: fb.left, top: fb.top, right: fb.right, bottom: fb.bottom });
      for (const [key, e] of group.entries()) {
        const flags = frameLines.current.get(key);
        if (!flags || !e.t) continue;
        const own = e.c ? { left: e.c[0] + fb.left, top: e.c[1] + fb.top, right: e.c[2] + fb.left, bottom: e.c[3] + fb.top } : null;
        for (const b of liveLineBars(toTop(e.t, fb), origin, within(own, clip))) bars.push(flags.wait && !flags.live ? { ...b, kind: 'wait' } : b);
      }
    }
    paintLiveBars(layer, bars);
  }, [channel, group, visibleBox]);
  useEffect(() => {
    if (surface !== 'html' || !channel || !group) return;
    channel.style('walnut-threads', FRAME_STYLE);
    const send = () => {
      const t = channel.text();
      if (!t) return;
      const out: FrameMarkSpec[] = [];
      frameLines.current = new Map();
      for (const s of byUrgency(specs)) {
        const at = locateQuote(t.text, s.quote, LOCATE_FILE);
        if (!at) continue;
        const { live, wait } = markFlagsOf(s, liveKeys);
        if (live || wait) frameLines.current.set(s.key, { live, wait });
        out.push({
          key: s.key, name: markHighlightName(s.hue, s.resolved, true, live, s.state), priority: markPriority(s.state),
          start: at.start, end: at.end, click: true, stop: true, lines: live || wait,
        });
      }
      const card = cardQuote ? locateQuote(t.text, cardQuote, LOCATE_FILE) : null;
      const cardKey = cardKeyOf(cardQuote);
      if (card && cardKey) out.push({ key: cardKey, name: '', start: card.start, end: card.end, rects: true });
      cardInPage.current = card ? cardKey : 'missing';
      group.set(t.v, out);
    };
    cardInPage.current = null;
    send();
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintFrameLines(); }); };
    const off = channel.on((m) => {
      if (m.type === 'text') send();
      else if (m.type === 'rects') { group.take(m); paintFrameLines(); }
      else if (m.type === 'click') {
        const key = group.hit(m.hits);
        const t = argsRef.current.threads;
        if (key) {
          log.info('threads', 'file mark click (html preview)', { sessionId, path: filePath });
          openCard(key, 'file-mark');
        } else if (t.openCardKey) t.requestCard(null, 'frame-outside');
      }
    });
    // The frame itself moves with the panel around it.
    document.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    return () => {
      off();
      document.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [surface, surfaceNonce, specs, liveKeys, channel, group, cardQuote, filePath, sessionId, openCard, paintFrameLines]);
  // Off the HTML preview (another view, another file, unmounted): its marks and lines go.
  useEffect(() => {
    if (surface !== 'html' || !group) return;
    return () => {
      group.clear();
      frameLines.current = new Map();
      if (liveRef.current) paintLiveBars(liveRef.current, []);
    };
  }, [surface, group, surfaceNonce, filePath]);

  // ── The card's host: registered while this file is on show; its place is
  //    measured while the open card is about a passage of this file. ──
  const scrolledForRef = useRef<string | null>(null);
  /** The open card's height as it first showed (`placeFileCard`'s `need`), for
   *  the passage it is about. Kept while a card stays open on that passage, so
   *  an answer streaming in (or a send promoting the draft) never moves it to
   *  the other side: it scrolls inside its max height instead. A close forgets
   *  it, and the next open measures again. */
  const needRef = useRef<{ exact: string | undefined; need: number } | null>(null);
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
      // Its height too, on a close only: a draft's first send moves the open
      // key to a question the tree has not read back yet (no `mine` for a
      // moment), and it must come back on the side it opened on.
      if (!openKey) { scrolledForRef.current = null; needRef.current = null; }
      layer.removeAttribute(CARD_MEASURE_ATTR);
      set({ path: filePath, el: layer, place: null });
      return;
    }
    // Another passage: a new card there. (A question read back without its
    // quote yet is the same card.)
    if (needRef.current && mine.quote && needRef.current.exact !== mine.quote.exact) needRef.current = null;
    const inFrame = argsRef.current.surface === 'html';
    /** The passage's box (and its last line's bottom) in the frame's or the top viewport. */
    const passage = (): { whole: DOMRect; bottom: number; frame: DOMRect | null; bringOn: () => void } | null => {
      if (inFrame) {
        const key = cardKeyOf(mine.quote);
        const r = (key && group?.rects(key)?.r) || [];
        const whole = unionOf(r);
        const fb = channel?.frameBox() ?? null;
        return whole && fb && key ? { whole, bottom: r[r.length - 1]!.bottom, frame: fb, bringOn: () => group?.reveal(key) } : null;
      }
      const b = body();
      const range = b && mine.quote ? rangeForQuote(b, mine.quote, skip, LOCATE_FILE) : null;
      if (!range) return null;
      const rects = range.getClientRects();
      const whole = range.getBoundingClientRect();
      const last = rects.length ? rects[rects.length - 1] : whole;
      return { whole, bottom: last.bottom, frame: null, bringOn: () => range.startContainer.parentElement?.scrollIntoView({ block: 'center' }) };
    };
    /** `canRender`: false inside the effect itself, where no render may run. */
    const measure = (canRender: boolean) => {
      const hostBox = root.getBoundingClientRect();
      const host = { width: hostBox.width, height: hostBox.height };
      const p = passage();
      // The HTML preview's page reports its passage's place a moment after the
      // card asks (a message from its own origin): until then the card waits
      // unseen, not drawn at the top and then moved under its passage
      // (2026-11-09: it showed at the top, 300px off, until the report came).
      /** Drawn unseen until `until`, then measured again. */
      const waitUnseen = (until: number) => {
        layer.setAttribute(CARD_MEASURE_ATTR, '');
        set({ path: filePath, el: layer, place: placeFileCard({ top: 8, bottom: 8, left: 0, right: host.width }, host) });
        if (!waitTimer) waitTimer = window.setTimeout(() => { waitTimer = 0; if (live) measure(true); }, Math.max(0, until - performance.now()));
      };
      if (!p && inFrame && mine.quote && cardInPage.current !== 'missing' && performance.now() < waitUntil) {
        waitUnseen(waitUntil);
        return;
      }
      let anchor: HostRect;
      if (p) {
        const { whole } = p;
        anchor = toHostRect(new DOMRect(whole.left, whole.top, whole.width, p.bottom - whole.top), hostBox, p.frame);
        // First time this card opens here: bring its passage on screen.
        if (scrolledForRef.current !== openKey) {
          scrolledForRef.current = openKey;
          if (!rectInHost(anchor, host, 24)) {
            p.bringOn();
            // The page scrolls itself and reports later: wait for that report.
            if (inFrame) revealUntil = performance.now() + FRAME_RECTS_WAIT_MS;
            return later();
          }
        }
        // Still the place from before the page's scroll (2026-11-09: shown
        // there, then moved 80px up as the report came).
        if (revealUntil) {
          if (!rectInHost(anchor, host, 24) && performance.now() < revealUntil) { waitUnseen(revealUntil); return; }
          revealUntil = 0;
        }
      } else {
        anchor = { top: 8, bottom: 8, left: 0, right: host.width };
      }
      const col = CODE_COLUMN[argsRef.current.surface];
      const colEl = col ? root.querySelector(col) : null;
      const minLeft = colEl ? colEl.getBoundingClientRect().left - hostBox.left : undefined;
      const placeFor = (need?: number) => ({ path: filePath, el: layer, place: placeFileCard(anchor, host, undefined, minLeft, need) });
      const kept = needRef.current?.need;
      if (kept !== undefined) { set(placeFor(kept)); layer.removeAttribute(CARD_MEASURE_ATTR); return; }
      // Not measured yet: the side waits for the card's height. A place without
      // `need` lets the card mount, unseen (the layer's measure flag); the
      // mutation that mounts it measures it before the frame paints and commits
      // its real place in that same task (flushSync), so the card's first
      // painted frame is already on its side: no jump, no blank frame.
      const card = layer.querySelector<HTMLElement>(':scope > .thread-card');
      const need = card && canRender ? cardNaturalHeight(card) : null;
      if (need === null) {
        layer.setAttribute(CARD_MEASURE_ATTR, '');
        set(placeFor());
        // Already drawn when this effect starts: measured right after it (no
        // render inside an effect). Not laid out yet: the observers call again.
        if (card && !canRender) queueMicrotask(() => { if (live && !needRef.current) measure(true); });
        return;
      }
      needRef.current = { exact: mine.quote?.exact, need };
      flushSync(() => set(placeFor(need)));
      layer.removeAttribute(CARD_MEASURE_ATTR);
    };
    let live = true;
    let raf = 0;
    let waitTimer = 0;
    const waitUntil = performance.now() + FRAME_RECTS_WAIT_MS;
    let revealUntil = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(true); }); };
    measure(false);
    // While waiting for the card, each mutation is looked at at once (a
    // microtask, before paint), so the card is placed in the frame it first shows in.
    const mo = new MutationObserver(() => {
      if (live && !needRef.current && layer.querySelector(':scope > .thread-card')) measure(true);
      else later();
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    // The card is portaled into the layer: its arrival is what the first place waits for.
    if (!root.contains(layer)) mo.observe(layer, { childList: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(root);
    // The text reflowing under a card that stays put (a font arriving late, a
    // block growing) moves its passage with no mutation and no scroll: follow it
    // (2026-11-09: a line's worth, 26px, between the card and its passage).
    const textBody = body();
    if (textBody) ro?.observe(textBody);
    document.fonts?.addEventListener?.('loadingdone', later);
    root.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    // The page reports its passage's rects (on paint, its scroll and its resize),
    // and its text (a passage it does not hold ends the card's wait at once).
    // Measured right after the report, not on this window's next frame: WebKit
    // held that frame back by up to 600ms after the page scrolled to the
    // passage, and the card waited unseen at the top all that time (2026-11-10).
    let soon = false;
    const now = () => {
      if (soon) return;
      soon = true;
      queueMicrotask(() => { soon = false; if (live) measure(true); });
    };
    const off = inFrame ? channel?.on((m) => { if (m.type === 'rects' || m.type === 'text') now(); }) : undefined;
    return () => {
      mo.disconnect();
      ro?.disconnect();
      root.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      document.fonts?.removeEventListener?.('loadingdone', later);
      off?.();
      live = false;
      if (raf) cancelAnimationFrame(raf);
      if (waitTimer) clearTimeout(waitTimer);
      layer.removeAttribute(CARD_MEASURE_ATTR);
    };
  }, [openKey, mine?.quote?.exact, filePath, surfaceNonce, body, skip, rootRef, channel, group]);
  useEffect(() => () => { argsRef.current.threads.setFileCardHost(null); }, []);
  useEffect(() => { scrolledForRef.current = null; }, [filePath]);

  // ── Ask: a quote of this file becomes a draft question with its card ──
  const askQuote = useCallback((quote: SessionPinnedQuote, line: number | undefined, via: string): FileAskResult => {
    const t = argsRef.current.threads;
    if (!t.canAsk) {
      log.warn('threads', 'ask about a file passage refused: the session cannot ask', { sessionId, path: filePath, via });
      return { ok: false, reason: 'cannot-ask' };
    }
    const same = findSamePassageThread(t.tree, t.anchors, t.hiddenKeys, { parent, quote });
    t.stack.ask({ msgId: parent, quote, ...(line ? { line } : {}) }, { focusComposer: false });
    t.requestCard(same ?? pendingPageKey(parent, quote.exact), via);
    log.info('threads', 'ask about a file passage', { sessionId, path: filePath, line: line ?? null, via, same: !!same });
    return { ok: true };
  }, [parent, filePath, sessionId]);

  /** The selection (or `given`) as a quote of this file, or why it is not one. In the HTML
   *  preview, the page's selection as it last reported it: offsets into its text of that
   *  version (its document is out of reach, in an origin of its own). */
  const readQuote = useCallback((inFrame: boolean, given?: Range): SessionPinnedQuote | Exclude<FileAskFailure, 'cannot-ask' | 'no-layer'> => {
    if (inFrame) {
      const sel = channel?.selection();
      if (!sel) return 'no-selection';
      const t = channel?.text();
      if (!t) return 'no-text';
      if (sel.v !== t.v) return 'not-in-file';
      return quoteFromText(t.text, sel.start, sel.end) ?? 'no-text';
    }
    const sel = document.getSelection();
    const b = body();
    const range = given && !given.collapsed ? given : (sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null);
    if (!range || range.collapsed) return 'no-selection';
    // A kept range whose words were re-rendered away points at nothing now.
    if (!b || !b.contains(range.commonAncestorContainer)) return 'not-in-file';
    return quoteFromRange(buildTextIndex(b, skip), range) ?? 'no-text';
  }, [body, skip, channel]);
  /** The selection is taken: the page clears its own (the bridge), the top document here. */
  const clearSelection = useCallback((inFrame: boolean) => {
    if (inFrame) channel?.send({ type: 'clear-selection' });
    else document.getSelection()?.removeAllRanges();
  }, [channel]);

  useImperativeHandle(ref, () => ({
    quoteOf: ({ inFrame, range }) => {
      const q = readQuote(inFrame, range);
      return typeof q === 'string' ? null : q;
    },
    askSelection: ({ inFrame, line, range: given }) => {
      const quote = readQuote(inFrame, given);
      if (typeof quote === 'string') {
        log.warn('threads', 'ask here on a file selection opened no card', {
          sessionId, path: filePath, surface: argsRef.current.surface, reason: quote, given: !!given, inFrame,
        });
        return { ok: false, reason: quote };
      }
      clearSelection(inFrame);
      return askQuote(quote, line, 'file-selection');
    },
    askPassage: ({ quote, line, inFrame }) => {
      document.getSelection()?.removeAllRanges();
      if (inFrame) clearSelection(true);
      return askQuote(quote, line, argsRef.current.surface === 'diff' ? 'diff-selection' : 'file-selection');
    },
  }), [askQuote, readQuote, clearSelection, sessionId, filePath]);

  // ── The inline Ask on the block under the pointer ──
  const [hover, setHover] = useState<{ el: Element; rect: HostRect; spot: { top: number; left: number } } | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  useEffect(() => {
    const root = rootRef.current;
    // Not over a diff: its table cells are removed lines as often as file text,
    // and the selection's Ask here already says which passage it means.
    if (!root || !threads.canAsk || surface === 'none' || surface === 'diff') return;
    const pick = rafThrottle<{ x: number; y: number }>(({ x, y }) => {
      const b = body();
      if (!b) { if (hoverRef.current) setHover(null); return; }
      const target = document.elementFromPoint(x, y);
      const block = askableBlockOf(target, b);
      const hostBox = root.getBoundingClientRect();
      if (!block) {
        const h = hoverRef.current;
        if (!h) return;
        // Leaving the block for its own Ask button keeps the button, across the
        // gap between them too (the button sits off the block's words).
        if (target?.closest?.('.fv-ask-block')) return;
        const px = x - hostBox.left;
        const py = y - hostBox.top;
        const inBridge = px >= Math.min(h.rect.left, h.spot.left) && px <= Math.max(h.rect.right, h.spot.left + ASK_CHIP_WIDTH)
          && py >= Math.min(h.rect.top, h.spot.top) && py <= Math.max(h.rect.bottom, h.spot.top + ASK_CHIP_HEIGHT);
        if (!inBridge) setHover(null);
        return;
      }
      const rect = toHostRect(block.getBoundingClientRect(), hostBox, null);
      const prev = hoverRef.current;
      if (prev && prev.el === block && Math.abs(prev.rect.top - rect.top) < 1 && Math.abs(prev.rect.right - rect.right) < 1) return;
      const line = lastLineRect(block);
      const near = neighbourLines(block, b).map((r) => toHostRect(r, hostBox, null));
      const spot = placeAskChip(rect, line ? toHostRect(line, hostBox, null) : null, { width: root.clientWidth, height: hostBox.height },
        { near });
      setHover({ el: block, rect, spot });
    });
    const onMove = (e: PointerEvent) => pick.call({ x: e.clientX, y: e.clientY });
    const onLeave = (e: PointerEvent) => {
      const to = e.relatedTarget as Element | null;
      if (to?.closest?.('.fv-ask-block')) return;
      pick.cancel();
      setHover(null);
    };
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerleave', onLeave);
    const onScroll = () => { pick.cancel(); setHover(null); };
    root.addEventListener('scroll', onScroll, true);
    return () => {
      pick.cancel();
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('scroll', onScroll, true);
    };
  }, [rootRef, surface, surfaceNonce, threads.canAsk, body]);
  useEffect(() => { setHover(null); }, [filePath, surfaceNonce]);
  const cardHere = !!mine;
  useEffect(() => { if (cardHere) setHover(null); }, [cardHere]);

  const askBlock = useCallback(() => {
    const h = hoverRef.current;
    const b = body();
    if (!h || !b || !b.contains(h.el)) return;
    const quote = blockQuoteOf(buildTextIndex(b, skip), h.el);
    if (!quote) return;
    const ln = h.el.closest('[data-line]')?.getAttribute('data-line');
    const line = ln ? Number(ln) : undefined;
    setHover(null);
    void askQuote(quote, Number.isFinite(line) ? line : undefined, 'file-block');
  }, [askQuote, body, skip]);

  if (!threads.canAsk) return null;
  const hostW = rootRef.current?.clientWidth ?? 0;
  return (
    <div ref={layerRef} className="fv-thread-layer" data-file-path={filePath} data-surface={surface}>
      {/* Scanning lines under passages being answered (useThreadMarks draws them). */}
      <div ref={liveRef} className="fv-live-lines" aria-hidden="true" />
      <FileQuestionRail rows={railRows} top={railBox.top} room={railBox.room} boxWidth={hostW} onOpen={openFromRail} />
      <ThreadMarkTipLayer store={tips} />
      {markMenu && (
        <ContextMenu
          point={markMenu.point}
          ariaLabel="Question actions"
          testId="thread-mark-menu"
          onClose={() => setMarkMenu(null)}
          items={[
            { key: 'open', label: 'Open question', onSelect: () => openCard(markMenu.key, 'file-mark-menu') },
            { key: 'quote', label: 'Quote in chat', onSelect: () => threads.quoteInChat(markMenu.key, 'file-mark-menu') },
          ]}
        />
      )}
      {/* Hidden while this file's card is open: it sat over a word of the
          passage the card is about (2026-11-06). Placed off the block's words
          (placeAskChip). */}
      {hover && !mine && (
        <button
          type="button"
          className="fv-ask-block"
          style={{ top: hover.spot.top, left: hover.spot.left }}
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
