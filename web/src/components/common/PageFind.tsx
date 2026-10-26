/**
 * PageFind — Cmd/Ctrl+F for the app itself (the Mac app's WKWebView has no find
 * bar of its own), plus "select text, every exact copy tints".
 *
 * Scope: the session chat the reader was in (focus, else the last click), else
 * the whole page. File views and the Changed tab keep their own bars; their
 * window-capture handlers run before this document-capture one and stop the
 * event when they take it, so a chord that reaches here is nobody else's (a
 * raw or binary file view installs no handler, and must not leave Cmd+F dead).
 *
 * The page stays where it is: typing only paints and counts (see
 * utils/page-find.ts); next/previous is the only thing that scrolls. The bar
 * floats (fixed, portalled), so opening it shifts no layout either.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSearchBar } from '@/components/common/FileSearchBar';
import { READER_SCROLL_EVENT } from '@/components/sessions/phone-session-layer';
import { installFindPointerTracking, isFindChord, lastPointerTarget } from '@/utils/find-scope';
import {
  PageFindController, buildFindIndex, makeRepaintScheduler, paintSelectionMatches, selectionNeedle,
  type FindIndex, type FindStatus,
} from '@/utils/page-find';
import { log } from '@/utils/log';
import '@/styles/page-find.css';

const EMPTY: FindStatus = { count: 0, index: 0, capped: false };

interface Scope { root: Element; kind: 'session' | 'page' }

function visible(el: Element): boolean {
  const e = el as Element & { checkVisibility?: () => boolean };
  return typeof e.checkVisibility === 'function' ? e.checkVisibility() : el.getClientRects().length > 0;
}

function resolveScope(): Scope {
  const active = document.activeElement;
  const from = active && active !== document.body && !active.closest('.page-find') ? active : lastPointerTarget();
  // The chat the reader is in first: a panel can hold two (the side-question
  // drawer renders its own history before the main one).
  const history = from?.closest('.session-history') ?? from?.closest('.session-panel')?.querySelector('.session-history');
  if (history && visible(history)) return { root: history, kind: 'session' };
  return { root: document.body, kind: 'page' };
}

/** Announce a find-driven move to the chat, so its follow-bottom logic reads it
 *  as the reader's own scroll and does not pull the view back down. */
function beforeScroll(el: Element): void {
  if (el.classList.contains('session-history')) el.dispatchEvent(new Event(READER_SCROLL_EVENT));
}

function barPosition(scope: Scope): { top: number; right: number } {
  if (scope.kind === 'page') return { top: 8, right: 16 };
  const r = scope.root.getBoundingClientRect();
  // The panel header floats over the top of the chat (glass): sit below it,
  // never over the session's own tabs and title.
  const header = scope.root.closest('.session-panel')?.querySelector('.session-panel-header');
  const hb = header?.getBoundingClientRect();
  const under = hb && hb.bottom > r.top && hb.top < r.top + 160 ? hb.bottom : r.top;
  return { top: Math.max(8, under + 6), right: Math.max(8, window.innerWidth - r.right + 18) };
}

export function PageFind() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState<FindStatus>(EMPTY);
  /** The query changed and its count is not in yet (tests wait on this). */
  const [pending, setPending] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
  const [pos, setPos] = useState({ top: 8, right: 16 });
  const ctrlRef = useRef<PageFindController | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;

  const close = useCallback(() => {
    ctrlRef.current?.close();
    ctrlRef.current = null;
    setOpen(false);
    setScope(null);
    setStatus(EMPTY);
    const back = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  const openFind = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    const input = barRef.current?.querySelector<HTMLInputElement>('input');
    // Pressed again from the bar itself: keep the scope, re-select the field.
    if (openRef.current && input && (active?.closest('.page-find') || lastPointerTarget()?.closest('.page-find'))) {
      input.focus({ preventScroll: true });
      input.select();
      return;
    }
    const next = resolveScope();
    if (active && active !== document.body && !active.closest('.page-find')) restoreFocusRef.current = active;
    // Seed from a one-line selection, the way a browser or VS Code does.
    const seed = selectionNeedle(window.getSelection());
    if (seed) setQuery(seed);
    if (ctrlRef.current?.root !== next.root) {
      ctrlRef.current?.close();
      ctrlRef.current = new PageFindController(next.root, beforeScroll);
    }
    setScope(next);
    setPos(barPosition(next));
    setOpen(true);
    // Already open (a new scope): take focus back to the field.
    if (input) { input.focus({ preventScroll: true }); input.select(); }
    log.info('page-find', 'open', { scope: next.kind });
  }, []);

  // The chord. Document capture: file views and the Changed tab listen on window
  // capture, so they decide first and stop the event when it is theirs.
  useEffect(() => {
    installFindPointerTracking();
    const onKey = (e: KeyboardEvent) => {
      if (!isFindChord(e) || e.defaultPrevented) return;
      e.preventDefault();
      openFind();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [openFind]);

  // Query or case changed: paint and count, nothing else. A short debounce lets
  // a fast typist skip the intermediate prefixes.
  useEffect(() => {
    if (!open) return;
    setPending(true);
    const timer = window.setTimeout(() => {
      const ctrl = ctrlRef.current;
      if (ctrl) setStatus(ctrl.setQuery(query, caseSensitive));
      setPending(false);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [open, query, caseSensitive, scope]);

  // Content changes (streaming, a fold opening, a row arriving) recount in place.
  useEffect(() => {
    if (!open || !scope) return;
    const root = scope.root;
    const bar = barRef.current;
    let textChanged = false;
    const repaint = makeRepaintScheduler(() => {
      const ctrl = ctrlRef.current;
      if (ctrl) setStatus(ctrl.refresh());
    });
    const obs = new MutationObserver((records) => {
      let relevant = false;
      for (const r of records) {
        if (bar && bar.contains(r.target)) continue;
        relevant = true;
        if (r.type !== 'attributes') textChanged = true;
      }
      if (!relevant) return;
      // Drop the walk now (cheap), so a typed query or an Enter before the
      // recount never runs on nodes that just left.
      if (textChanged) { ctrlRef.current?.markDirty(); textChanged = false; }
      repaint.kick();
    });
    obs.observe(root, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    // A long result list paints a window around the reader; scrolling slides it.
    let scrollTimer = 0;
    const onScroll = () => {
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => ctrlRef.current?.onScroll(), 100);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // The chat this bar searches can go away under it (session switch, rewind,
    // another route): removing it makes no mutation INSIDE it, so check it here
    // rather than leave an open bar over nothing.
    const gone = () => scope.kind === 'session' && (!root.isConnected || !visible(root));
    const place = () => { if (gone()) close(); else setPos(barPosition(scope)); };
    const ro = new ResizeObserver(place);
    if (scope.kind === 'session') ro.observe(scope.root);
    window.addEventListener('resize', place);
    const watch = window.setInterval(() => { if (gone()) close(); }, 1000);
    return () => {
      obs.disconnect();
      ro.disconnect();
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(scrollTimer);
      window.clearInterval(watch);
      window.removeEventListener('resize', place);
      repaint.cancel();
    };
  }, [open, scope, close]);

  // Enter can land inside the query debounce: count the query on screen first
  // (a no-op when it already is), so the late count never undoes this move.
  const latest = useRef({ query, caseSensitive });
  latest.current = { query, caseSensitive };
  const onNav = useCallback((dir: 1 | -1) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    ctrl.setQuery(latest.current.query, latest.current.caseSensitive);
    setStatus(ctrl.nav(dir));
  }, []);

  useSelectionMatches();

  if (!open) return null;
  return createPortal(
    <div
      ref={barRef}
      className="page-find"
      data-scope={scope?.kind}
      data-pending={pending ? 'true' : 'false'}
      style={{ top: pos.top, right: pos.right }}
    >
      <FileSearchBar
        query={query}
        caseSensitive={caseSensitive}
        count={status.count}
        index={status.index}
        capped={status.capped}
        placeholder={scope?.kind === 'session' ? 'Find in session' : 'Find in page'}
        onQueryChange={setQuery}
        onToggleCase={() => setCaseSensitive((v) => !v)}
        onNav={onNav}
        onClose={close}
      />
    </div>,
    document.body,
  );
}

/**
 * Select text, every exact visible copy tints (VS Code). In a chat it echoes in
 * that chat, elsewhere across the page. The walk is kept while nothing changes;
 * while a selection is held, mutations under its scope (a streaming reply)
 * repaint it (makeRepaintScheduler), and nothing is observed without one.
 */
function useSelectionMatches(): void {
  useEffect(() => {
    let index: FindIndex | null = null;
    let root: Element | null = null;
    let needle = '';
    let undo: (() => void) | null = null;
    let timer = 0;
    const clear = () => { undo?.(); undo = null; };
    const repaint = makeRepaintScheduler(() => paint());
    const obs = new MutationObserver(() => {
      index = null;
      if (needle) repaint.kick();
    });
    const paint = () => {
      clear();
      if (!needle || !root) return;
      index ??= buildFindIndex(root);
      undo = paintSelectionMatches(index, needle);
    };
    const onSelectionChange = () => {
      // Drop the old tint at once (a click that clears the selection clears it
      // now); recompute only once a drag settles.
      clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        const sel = window.getSelection();
        needle = selectionNeedle(sel);
        const anchor = sel?.anchorNode;
        const at = anchor instanceof Element ? anchor : anchor?.parentElement;
        const next = needle ? (at?.closest('.session-history') ?? document.body) : null;
        if (next !== root) {
          obs.disconnect();
          index = null;
          root = next;
          if (root) obs.observe(root, { subtree: true, childList: true, characterData: true });
        }
        paint();
      }, 120);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      obs.disconnect();
      window.clearTimeout(timer);
      repaint.cancel();
      clear();
    };
  }, []);
}
