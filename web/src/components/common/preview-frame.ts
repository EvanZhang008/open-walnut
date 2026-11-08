/**
 * The HTML preview's frame, seen from the console (src/web/preview-bridge-script.ts is the page's side).
 *
 * The page runs sandboxed in an origin of its own (src/web/untrusted-doc.ts: a script in it could
 * otherwise read the Passwords unlock and the device token from this origin's storage), so the
 * console cannot reach into it. What it read and drew there before now goes through the bridge
 * Walnut puts into every previewed HTML document, as the named messages of preview-messages.ts
 * (each checked for its shape, and only from this frame's window):
 *  - the reader's selection (the pill, Ask here and Comment), as text, a rect and offsets into
 *    the page's text, which the page sends whenever it changes;
 *  - question and comment marks: the console locates them in that text and the page paints them,
 *    reports clicks and hovers on them and the rects of the ones a card or a line is placed by
 *    (preview-marks.ts);
 *  - ⌘F: the page finds and paints, the console's bar drives it;
 *  - the scroll position, remembered per file and restored on each load (a chase, since a page
 *    that is still laying out clamps an early scroll);
 *  - link clicks: another file on this host opens in the panel (onOpenPath), a link a plugin
 *    handles opens there, another website opens in a new tab (the page does that itself, inside
 *    the click), anything else stays where it is; a right-click on a link a plugin handles
 *    opens the console's link menu;
 *  - Esc, handed on from the frame element so the panel's Esc works while the page has focus;
 *  - where the frame is now, so a page that navigated away shows the "Back to" strip.
 * A message may come from the page's own scripts as well as from the bridge, so none is taken as
 * proof of a click: a plugin's handler runs only right after a real press on the same link (the
 * bridge's press, taken with the user's activation on), and the frame only ever loads a file the
 * console resolved itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { rawFileContentUrl } from '@/api/files';
import { classifyPreviewLink, classifyPreviewNavigation } from '@/utils/html-preview-links';
import { findLinkHandler, openWithHandler } from '@/plugins/link-handlers';
import { showLinkMenu } from '@/plugins/LinkCaptureHost';
import { loadFileScroll, placeForView, saveFileScroll } from '@/utils/file-view-state';
import type { ReadingSeen } from './use-file-reading-place';
import { log } from '@/utils/log';
import { readFrameMsg, type FrameMsg, type PreviewRect } from './preview-messages';

/** What the console asks of the page (the bridge checks each the same way). */
export type ConsoleMsg =
  | { type: 'scroll-to'; top: number }
  | { type: 'scroll-by'; dy: number }
  | { type: 'clear-selection' }
  | { type: 'handled'; href: string; handled: boolean }
  | { type: 'style'; id: string; css: string }
  | { type: 'marks'; group: string; v: number; items: unknown[] }
  | { type: 'reveal'; group: string; id: string }
  | { type: 'find'; query: string; caseSensitive: boolean }
  | { type: 'find-nav'; dir: 1 | -1 }
  | { type: 'find-close' };

/** The console's line to the page on show, for the layers drawn over it. */
export interface PreviewChannel {
  /** The page's text as last reported (null before it did, or past the size it sends). */
  text(): { v: number; text: string } | null;
  /** The reader's selection in the page, as offsets into the text of version `v`. */
  selection(): { v: number; start: number; end: number; text: string } | null;
  frameBox(): DOMRect | null;
  send(m: ConsoleMsg): void;
  /** A style the page keeps, sent again on each load. */
  style(id: string, css: string): void;
  /** Every checked message from the page; the unsubscribe is returned. */
  on(fn: (m: FrameMsg) => void): () => void;
}

const READY_WAIT_MS = 1500;
const CHASE_MS = 5000;

export interface PreviewFrameOptions {
  frameRef: RefObject<HTMLIFrameElement | null>;
  live: boolean;
  filePath: string;
  host?: string;
  /** A line asked for: no scroll restore then. */
  line?: number;
  reloadToken?: number;
  lastSeenRef: MutableRefObject<ReadingSeen | null>;
  /** The view mode the file view holds for a path. A scroll write keeps it: the cleanup
   *  flush runs when Source turns the preview off, after that switch saved source mode. */
  sourceModeRef: MutableRefObject<{ key: string; source: boolean }>;
  /** The reader selected text in the page (null: nothing selected), in top-viewport coords. */
  onSelection?: (sel: { x: number; y: number; text: string } | null) => void;
  onOpenPath?: (path: string) => void;
  /** ⌘F pressed inside the page. */
  onFindKey?: () => void;
  /** The page's answer to a find. */
  onFindResult?: (r: { count: number; index: number }) => void;
}

/** A page's script can post what the bridge posts, so a plugin acts on a link only for a real
 *  press: the user's activation (it reaches this window from the frame) must be on, and a
 *  browser that does not report it counts as none. */
function activated(): boolean {
  const act = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return act?.isActive === true;
}
/** How long after a real press on a link its click or menu may follow. */
const PRESS_FRESH_MS = 5000;

export function usePreviewFrame(o: PreviewFrameOptions) {
  const { frameRef, live, filePath, host, line, reloadToken, lastSeenRef, sourceModeRef } = o;
  const [strayed, setStrayed] = useState<{ path?: string } | null>(null);
  const cb = useRef(o);
  cb.current = o;
  const rectRef = useRef<PreviewRect | null>(null);
  // The pill follows the page's scroll through this (SelectionAskPill listenTo).
  const scrollEvents = useMemo(() => new EventTarget(), []);
  const page = useRef({
    text: null as { v: number; text: string } | null,
    sel: null as { v: number; start: number; end: number; text: string } | null,
    /** The page on show is this file (not a page the frame went on to, whose words are not its). */
    same: false,
    styles: new Map<string, string>(),
    listeners: new Set<(m: FrameMsg) => void>(),
  });
  const channel = useMemo<PreviewChannel>(() => {
    const send = (m: ConsoleMsg) => {
      try { frameRef.current?.contentWindow?.postMessage({ ...m, walnutPreview: 1 }, '*'); } catch { /* frame gone */ }
    };
    return {
      text: () => page.current.text,
      selection: () => page.current.sel,
      frameBox: () => frameRef.current?.getBoundingClientRect() ?? null,
      send,
      style: (id, css) => { page.current.styles.set(id, css); send({ type: 'style', id, css }); },
      on: (fn) => { page.current.listeners.add(fn); return () => { page.current.listeners.delete(fn); }; },
    };
  }, [frameRef]);

  useEffect(() => {
    setStrayed(null);
    Object.assign(page.current, { text: null, sel: null, same: false });
    if (!live) return;
    const frame = frameRef.current;
    if (!frame) return;
    const key = `${host ?? 'local'} ${filePath}`;
    const current = { host, path: filePath };
    let docHref = '';
    let readyAt = 0;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let chase: { top: number; until: number; timer?: ReturnType<typeof setInterval> } | null = null;
    const send = channel.send;
    const stopChase = () => { if (chase?.timer) clearInterval(chase.timer); chase = null; };

    const startChase = (fromTop: number) => {
      stopChase();
      // Only an offset measured in the page itself: one from Source is another view's pixels.
      const place = line ? null : placeForView(loadFileScroll(host, filePath), 'html');
      if (!place || !('top' in place) || Math.abs(fromTop - place.top) <= 1) return;
      chase = { top: place.top, until: Date.now() + CHASE_MS };
      const tick = () => {
        if (!chase || Date.now() > chase.until) { stopChase(); return; }
        send({ type: 'scroll-to', top: chase.top });
      };
      tick();
      chase.timer = setInterval(tick, 120);
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const m = readFrameMsg(e.data);
      if (!m) return;
      handle(m);
      for (const fn of [...page.current.listeners]) fn(m);
    };
    /** The link the reader last really pressed in the page, and when. */
    let pressed: { href: string; at: number } | null = null;
    const pressedOn = (href: string) => {
      const ok = !!pressed && pressed.href === href && Date.now() - pressed.at <= PRESS_FRESH_MS && activated();
      if (ok) pressed = null;
      return ok;
    };
    const handle = (m: FrameMsg) => {
      const p = page.current;
      switch (m.type) {
        case 'ready': {
          // A new document: what the last one said is gone, and the styles go in again.
          p.text = null;
          p.sel = null;
          for (const [id, css] of p.styles) send({ type: 'style', id, css });
          docHref = m.href;
          readyAt = Date.now();
          const nav = classifyPreviewNavigation(docHref, current);
          p.same = nav === 'same-file';
          if (nav === 'same-file') { setStrayed(null); startChase(m.top); }
          else setStrayed({ path: nav ? nav.path : undefined });
          return;
        }
        case 'text':
          p.text = m.over || !p.same ? null : { v: m.v, text: m.text };
          return;
        case 'scroll': {
          const top = m.top;
          // Reached, or the page will not grow to it: the chase is over either way once it holds.
          if (chase && Math.abs(top - chase.top) <= 1) stopChase();
          rectRef.current = m.rect;
          scrollEvents.dispatchEvent(new Event('scroll'));
          // A restore's own steps (a page still growing clamps them) are not the reader's position.
          if (chase) return;
          lastSeenRef.current = { key, top, topIn: 'html' };
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            const seen = lastSeenRef.current;
            if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top, topIn: seen.topIn, line: seen.line, source: sourceModeRef.current.key === key ? sourceModeRef.current.source : false });
          }, 250);
          return;
        }
        case 'selection': {
          p.sel = p.same && m.text && m.v !== undefined && m.start !== undefined && m.end !== undefined
            ? { v: m.v, start: m.start, end: m.end, text: m.text } : null;
          const on = cb.current.onSelection;
          if (!on) return;
          rectRef.current = m.rect;
          if (!m.text) { on(null); return; }
          const box = frame.getBoundingClientRect();
          on({ x: box.left + m.x, y: box.top + m.y, text: m.text });
          return;
        }
        case 'probe':
          send({ type: 'handled', href: m.href, handled: !!findLinkHandler(m.href) });
          return;
        case 'press':
          // Taken only while the user's activation is on: a page's script cannot make that.
          pressed = activated() ? { href: m.href, at: Date.now() } : null;
          return;
        case 'link': {
          stopChase();
          const href = m.href;
          const handled = findLinkHandler(href);
          if (handled) {
            // A page's script can post this too: a plugin opens a link only for a real click.
            if (!pressedOn(href)) { log.warn('file-view', 'html preview link to a plugin without a click: ignored', { href: href.slice(0, 300) }); return; }
            openWithHandler(handled.handler, handled.url, 'click');
            return;
          }
          if (m.handled) return; // the plugin is gone since the page asked: the click stays dropped
          const verdict = classifyPreviewLink(href, docHref || frame.src, current);
          if (verdict.kind === 'file' && cb.current.onOpenPath) {
            log.info('file-view', 'html preview link opens file in panel', { from: filePath, path: verdict.path, host });
            cb.current.onOpenPath(verdict.path);
          } else if (verdict.kind === 'file') frame.src = rawFileContentUrl(verdict.path, host);
          // Nothing else the page names is loaded by the console: the frame only ever goes to a
          // file it resolved (a page that navigates itself is the strayed strip's business).
          return;
        }
        case 'user':
          stopChase();
          return;
        case 'escape':
          frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
          return;
        case 'link-menu': {
          // The console's menu for a link a plugin handles, as on the page around it.
          if (!findLinkHandler(m.href)) return;
          if (!pressedOn(m.href)) { log.warn('file-view', 'html preview link menu without a press: ignored', { href: m.href.slice(0, 300) }); return; }
          const box = frame.getBoundingClientRect();
          showLinkMenu(m.href, { x: box.left + m.x, y: box.top + m.y });
          return;
        }
        case 'find-key':
          cb.current.onFindKey?.();
          return;
        case 'find-result':
          cb.current.onFindResult?.({ count: m.count, index: m.index });
          return;
      }
    };

    // A load with no word from the bridge after it: the frame went to a page Walnut did not
    // serve (another site, a file that is not HTML), which is the frame having gone elsewhere.
    const onLoad = () => {
      const loadAt = Date.now();
      clearTimeout(loadTimer);
      loadTimer = setTimeout(() => {
        if (readyAt >= loadAt - READY_WAIT_MS) return;
        Object.assign(page.current, { text: null, sel: null, same: false });
        setStrayed({});
      }, READY_WAIT_MS);
    };
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', onLoad);
    return () => {
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      clearTimeout(loadTimer);
      clearTimeout(saveTimer);
      stopChase();
      // Flush the last value: the debounce would drop the final position when the panel closes.
      const seen = lastSeenRef.current;
      if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top, topIn: seen.topIn, line: seen.line, source: sourceModeRef.current.key === key ? sourceModeRef.current.source : false });
    };
  }, [live, filePath, host, line, frameRef, lastSeenRef, sourceModeRef, scrollEvents, channel]);

  /** The "Back to <file>" strip: point the frame back at the file (the same `src` again re-navigates). */
  const returnToFile = useCallback(() => {
    const frame = frameRef.current;
    if (frame) frame.src = rawFileContentUrl(filePath, host, reloadToken);
    setStrayed(null);
  }, [frameRef, filePath, host, reloadToken]);

  /** The page's selection rect as last reported, in top-viewport coords. */
  const selectionRect = useCallback((): DOMRect | null => {
    const r = rectRef.current;
    const frame = frameRef.current;
    if (!r || !frame) return null;
    const box = frame.getBoundingClientRect();
    return new DOMRect(box.left + r.left, box.top + r.top, r.width, r.height);
  }, [frameRef]);

  const clearSelection = useCallback(() => {
    rectRef.current = null;
    page.current.sel = null;
    channel.send({ type: 'clear-selection' });
  }, [channel]);

  return { strayed, setStrayed, returnToFile, selectionRect, clearSelection, scrollEvents, channel };
}
