/**
 * PageFind — Cmd/Ctrl+F for the app itself (the Mac app's WKWebView has no find
 * bar of its own), plus "select text, every exact copy tints".
 *
 * Scope: the session chat the reader was in (focus, else the last click), else
 * the document they were in or the page's own document (a note: utils/find-doc.ts),
 * else the whole page. File views and the Changed tab keep their own bars; their
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
import { installFindPointerTracking, isFindChord, lastPointerTarget, panelHistoryOf } from '@/utils/find-scope';
import { echoVisible, paintSelectionMatches, subscribeEcho } from '@/utils/selection-echo';
import {
  buildFindIndex, makeRepaintScheduler, selectionNeedle,
  type FindIndex, type FindStatus,
} from '@/utils/page-find';
import {
  FIND_DOC_ATTR, PAGE_FIND_REQUEST, docAround, docLabel, docShows, engineFor, engineKindFor, primaryDoc, regionAround, scrollerOf,
  type FindEngine, type PageFindRequest,
} from '@/utils/find-doc';
import { log } from '@/utils/log';
import '@/styles/page-find.css';

const EMPTY: FindStatus = { count: 0, index: 0, capped: false };

interface Scope { root: Element; kind: 'session' | 'doc' | 'region' | 'page' }

function visible(el: Element): boolean {
  const e = el as Element & { checkVisibility?: () => boolean };
  return typeof e.checkVisibility === 'function' ? e.checkVisibility() : el.getClientRects().length > 0;
}

function resolveScope(): Scope {
  const active = document.activeElement;
  const from = active && active !== document.body && !active.closest('.page-find') ? active : lastPointerTarget();
  // The chat the reader is in first: a panel can hold two (the side-question
  // drawer renders its own history before the main one).
  // Pressed in no chat of a panel: its own timeline, never the split's left half.
  const panel = from?.closest('.session-panel');
  const history = from?.closest('.session-history') ?? (panel ? panelHistoryOf(panel) : null);
  if (history && visible(history)) return { root: history, kind: 'session' };
  // The document the reader is in, else (pressed nowhere in a chat or a panel of
  // its own) the page's document: a note open on the Notes page is searched,
  // never its sidebar, tabs or toolbar.
  const doc = docAround(from ?? null);
  if (doc) return { root: doc, kind: 'doc' };
  const region = regionAround(from ?? null);
  if (region) return { root: region, kind: 'region' };
  const primary = panel ? null : primaryDoc();
  if (primary) return { root: primary, kind: 'doc' };
  return { root: document.body, kind: 'page' };
}

/** The element whose box the bar sits over (a document's pane, a chat). */
/** Where a document takes the caret: its rich editor or its raw view, the one showing. */
function editableIn(root: Element): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('[contenteditable="true"], .cm-content'))
    .find((el) => el.getClientRects().length > 0) ?? null;
}

/** A menu or list floating over the page (an editor's slash menu, a popover). */
function editorPopupOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-tippy-root], .tippy-box'))
    .some((el) => !el.closest('.page-find') && el.getClientRects().length > 0);
}

/** Focus can go back there: in the page and showing (a view toggled away is hidden). */
function canTakeFocus(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

function frameOf(scope: Scope): Element {
  return scope.kind === 'doc' ? scrollerOf(scope.root) : scope.root;
}

const PLACEHOLDER: Record<Scope['kind'], string> = {
  session: 'Find in session', doc: 'Find in document', region: 'Find in chat', page: 'Find in page',
};

/** Announce a find-driven move to the chat, so its follow-bottom logic reads it
 *  as the reader's own scroll and does not pull the view back down. */
function beforeScroll(el: Element): void {
  if (el.classList.contains('session-history')) el.dispatchEvent(new Event(READER_SCROLL_EVENT));
}

function barPosition(scope: Scope): { top: number; right: number } {
  if (scope.kind === 'page') return { top: 8, right: 16 };
  const r = frameOf(scope).getBoundingClientRect();
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
  const ctrlRef = useRef<FindEngine | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;

  const statusRef = useRef(status);
  statusRef.current = status;
  // The match last chosen for the query on screen: a view toggling takes its
  // text away for a moment, and the count in between says none is chosen.
  const chosenRef = useRef({ query: '', cs: false, index: 0 });
  // Only a count made for the query on screen: right after a keystroke the
  // status still belongs to the query before it.
  const shownQuery = useRef({ query, caseSensitive });
  const sameQuery = shownQuery.current.query === query && shownQuery.current.caseSensitive === caseSensitive;
  shownQuery.current = { query, caseSensitive };
  if (!sameQuery) chosenRef.current = { query, cs: caseSensitive, index: 0 };
  else if (status.index > 0 && !pending) chosenRef.current = { query, cs: caseSensitive, index: status.index };
  // The scope searched, for close(), which outlives a render.
  const scopeRef = useRef<Scope | null>(null);
  scopeRef.current = scope;
  // Whether the field had focus when the reader last pressed a key or a button:
  // a view toggled by that press gives focus back to the bar, one toggled from
  // inside the note leaves the caret in the note.
  const barHadFocusRef = useRef(false);
  useEffect(() => {
    const onIntent = () => { barHadFocusRef.current = !!document.activeElement?.closest('.page-find'); };
    document.addEventListener('pointerdown', onIntent, true);
    document.addEventListener('keydown', onIntent, true);
    return () => {
      document.removeEventListener('pointerdown', onIntent, true);
      document.removeEventListener('keydown', onIntent, true);
    };
  }, []);
  // The query on screen, for handlers that outlive a render.
  const latest = useRef({ query, caseSensitive });
  latest.current = { query, caseSensitive };

  // Ends the focus hold below (a hit just opened the bar), so the focus close()
  // gives back is not pulled into a field about to go.
  const releaseHoldRef = useRef<(() => void) | null>(null);

  const close = useCallback((opts: { restore?: boolean } = {}) => {
    releaseHoldRef.current?.();
    ctrlRef.current?.close();
    ctrlRef.current = null;
    setOpen(false);
    setScope(null);
    setStatus(EMPTY);
    let back = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (opts.restore === false) return;
    // The document's editor was replaced while the bar was open (the note
    // loaded again, its raw view toggled): back to the one showing now.
    const was = scopeRef.current;
    if (!canTakeFocus(back) && was?.kind === 'doc') {
      const root = was.root.isConnected ? was.root : (was.root.getAttribute(FIND_DOC_ATTR) === 'primary' ? primaryDoc() : null);
      back = root ? editableIn(root) : null;
    }
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  /** Search `next` from now on (a new engine only for a new root). */
  const applyScope = useCallback((next: Scope) => {
    if (ctrlRef.current?.root !== next.root) {
      ctrlRef.current?.close();
      ctrlRef.current = engineFor(next.root, next.kind, beforeScroll);
    }
    setScope(next);
    setPos(barPosition(next));
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
    const seed = selectionNeedle(window.getSelection(), { inDocs: true });
    if (seed) setQuery(seed);
    applyScope(next);
    setOpen(true);
    // Already open (a new scope): take focus back to the field.
    if (input) { input.focus({ preventScroll: true }); input.select(); }
    log.info('page-find', 'open', { scope: next.kind });
  }, [applyScope]);

  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (!focusTick) return;
    const input = () => barRef.current?.querySelector<HTMLInputElement>('input') ?? null;
    input()?.focus({ preventScroll: true });
    input()?.select();
    // A note that just opened focuses its editor a moment later (TipTap's
    // autofocus), and Enter then wrote newlines into the note instead of moving
    // to the next match. Until the reader presses or types somewhere themself,
    // focus that moves out of the bar comes back to it, for a short while.
    const inBar = (t: EventTarget | null) => t instanceof Element && !!t.closest('.page-find');
    // Only focus going into the searched document (its editor's autofocus): the
    // reader's own moves elsewhere (the Notes search box, a shortcut) stay theirs.
    const onFocusIn = (e: FocusEvent) => {
      if (inBar(e.target)) return;
      const root = ctrlRef.current?.root;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      input()?.focus({ preventScroll: true });
    };
    const onUser = (e: Event) => { if (!inBar(e.target)) release(); };
    // The same autofocus scrolls the note to its top: bring the chosen match
    // back while the reader has done nothing yet.
    const checks = [150, 400, 800, 1300].map((ms) => window.setTimeout(() => ctrlRef.current?.revealActive(), ms));
    const release = () => {
      releaseHoldRef.current = null;
      window.clearTimeout(timer);
      checks.forEach((t) => window.clearTimeout(t));
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onUser, true);
      document.removeEventListener('keydown', onUser, true);
      document.removeEventListener('wheel', onUser, true);
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onUser, true);
    document.addEventListener('keydown', onUser, true);
    document.addEventListener('wheel', onUser, true);
    const timer = window.setTimeout(release, 1500);
    releaseHoldRef.current = release;
    return release;
  }, [focusTick]);

  // Another surface opens the bar with a query and a chosen match (a Notes
  // search hit: the word it matched, the paragraph it came from).
  useEffect(() => {
    const onRequest = (e: Event) => {
      const req = (e as CustomEvent<PageFindRequest>).detail;
      const queries = req.queries.map((q) => q.trim()).filter(Boolean);
      // None: close (the reader is on their way elsewhere, so focus stays theirs).
      if (!queries.length) { if (openRef.current) close({ restore: false }); return; }
      // Only a document that shows: a hidden editor elsewhere (Home's Scratchpad
      // stays mounted behind the Notes page) would open the bar over nothing.
      const root = (docShows(req.doc) ? docAround(req.doc) : null) ?? docAround(req.near ?? null) ?? primaryDoc();
      if (!root) return;
      const next: Scope = { root, kind: 'doc' };
      // Escape later goes back to the document, where the reader came to read.
      restoreFocusRef.current = editableIn(root);
      applyScope(next);
      const ctrl = ctrlRef.current!;
      const cs = latest.current.caseSensitive;
      // The first query the document holds (the typed words, else the word
      // the search marked); none: the typed words, counting "No results".
      const q = queries.find((x) => ctrl.setQuery(x, cs).count > 0) ?? queries[0] ?? '';
      // Counted here, so the debounced count below finds it done and keeps the pick.
      setStatus(ctrl.setQueryNear(q, cs, req.near ?? null, req.context));
      setQuery(q);
      setOpen(true);
      // The field takes the keys (Enter = next match, never a newline in the note).
      setFocusTick((n) => n + 1);
      log.info('page-find', 'open', { scope: 'doc', from: 'request' });
    };
    window.addEventListener(PAGE_FIND_REQUEST, onRequest);
    return () => window.removeEventListener(PAGE_FIND_REQUEST, onRequest);
  }, [applyScope, close]);

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
      // A document's raw view replaced its rendered one (or back): the other
      // engine searches it now, with the same query.
      const ctrl = ctrlRef.current;
      if (ctrl && ctrl.kind !== engineKindFor(root, scope.kind)) {
        // The same match stays chosen (by its number: both views hold the same text).
        const { query: q, caseSensitive: cs } = latest.current;
        const chosen = chosenRef.current;
        const was = statusRef.current.index || (chosen.query === q && chosen.cs === cs ? chosen.index : 0);
        ctrl.close();
        const next = engineFor(root, scope.kind, beforeScroll);
        ctrlRef.current = next;
        const counted = next.setQuery(q, cs);
        setStatus(was > 0 ? next.selectIndex(was) : counted);
        // Escape goes back to the view showing now.
        if (restoreFocusRef.current && !canTakeFocus(restoreFocusRef.current)) restoreFocusRef.current = editableIn(root);
        // Toggled from the bar (its field had focus a moment ago): the keys stay
        // in the bar, so Enter moves on and never types into the note. Else a
        // focus the removed view held goes to the one that replaced it.
        if (document.activeElement?.closest('.page-find') || barHadFocusRef.current) {
          setFocusTick((n) => n + 1);
        } else if (!document.activeElement || document.activeElement === document.body) {
          window.setTimeout(() => {
            if (document.activeElement && document.activeElement !== document.body) return;
            editableIn(root)?.focus({ preventScroll: true });
          }, 0);
        }
        return;
      }
      repaint.kick();
    });
    obs.observe(root, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    // What changed before this observer was on (a note opened from a search
    // hit loads its text again right after the bar opened): recount now, or
    // the paint stays on nodes that are gone.
    ctrlRef.current?.markDirty();
    repaint.kick();
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
    const gone = () => scope.kind !== 'page' && (!root.isConnected || !visible(root));
    // The page's own document went (another note loading in its place): wait
    // for the one that replaces it and search that, a few seconds at most.
    const wasPrimary = scope.kind === 'doc' && root.getAttribute(FIND_DOC_ATTR) === 'primary';
    // Another page (the reader left Notes) is never that wait: close.
    const path = window.location.pathname;
    let goneAt = 0;
    const onGone = () => {
      if (!wasPrimary || window.location.pathname !== path) { close(); return; }
      const next = primaryDoc();
      if (next) { applyScope({ root: next, kind: 'doc' }); return; }
      goneAt ||= Date.now();
      if (Date.now() - goneAt > 5_000) close();
    };
    const place = () => { if (gone()) onGone(); else setPos(barPosition(scope)); };
    const ro = new ResizeObserver(place);
    if (scope.kind !== 'page') ro.observe(frameOf(scope));
    window.addEventListener('resize', place);
    const watch = window.setInterval(() => { if (gone()) onGone(); }, wasPrimary ? 250 : 1000);
    return () => {
      obs.disconnect();
      ro.disconnect();
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(scrollTimer);
      window.clearInterval(watch);
      window.removeEventListener('resize', place);
      repaint.cancel();
    };
  }, [open, scope, close, applyScope]);

  // Escape in the document being searched closes the bar too (VS Code), unless
  // a popup of the editor is open (a slash menu, an autocomplete): Escape is that
  // popup's. Read before the editor's own handlers, which mark every Escape
  // handled; the key still reaches them.
  useEffect(() => {
    if (!open || scope?.kind !== 'doc') return;
    const root = scope.root;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const t = e.target;
      if (!(t instanceof Element) || !root.contains(t) || t.closest('.page-find')) return;
      if (editorPopupOpen()) return;
      close({ restore: false });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, scope, close]);

  // Enter can land inside the query debounce: count the query on screen first
  // (a no-op when it already is), so the late count never undoes this move.
  const onNav = useCallback((dir: 1 | -1) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    ctrl.setQuery(latest.current.query, latest.current.caseSensitive);
    setStatus(ctrl.nav(dir));
  }, []);

  usePageSelectionEcho();

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
        placeholder={scope?.kind === 'doc' ? docLabel(scope.root) : PLACEHOLDER[scope?.kind ?? 'page']}
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
 *
 * The live selection is the only truth, never the last selectionchange: a
 * re-render that rewrites the text under a selection (React 19 writes innerHTML
 * whenever the prop object changes) makes Chromium and WebKit drop the selection
 * with no event at all, and an echo painted from the remembered word then stayed
 * on screen with nothing selected (reported 2026-10-29). That rewrite is itself a
 * mutation under the scope, so the observer re-reads the selection first.
 *
 * When the echo may show at all is not decided here: utils/selection-echo.ts owns
 * that rule and the paint, for this echo and the doc views' alike.
 */
function usePageSelectionEcho(): void {
  useEffect(() => {
    let index: FindIndex | null = null;
    let root: Element | null = null;
    let needle = '';
    let undo: (() => void) | null = null;
    let timer = 0;
    /** The selection's boundaries when `needle` was read from it. */
    let held: { an: Node | null; ao: number; fn: Node | null; fo: number } = { an: null, ao: 0, fn: null, fo: 0 };
    const remember = (sel: Selection | null) => {
      held = { an: sel?.anchorNode ?? null, ao: sel?.anchorOffset ?? 0, fn: sel?.focusNode ?? null, fo: sel?.focusOffset ?? 0 };
    };
    const clear = () => { undo?.(); undo = null; };
    const repaint = makeRepaintScheduler(() => paint());
    const obs = new MutationObserver((records) => {
      index = null;
      if (!needle) return;
      // Cheap, so it runs on every batch, ahead of the throttled repaint: a
      // selection the mutation dropped clears now. Text rewritten inside a
      // boundary node keeps its offsets, so that one is read in full.
      const rewrote = records.some((r) => r.type === 'characterData' && (r.target === held.an || r.target === held.fn));
      if (!resync(rewrote)) repaint.kick();
    });
    const setRoot = (next: Element | null) => {
      if (next === root) return;
      obs.disconnect();
      index = null;
      root = next;
      if (root) obs.observe(root, { subtree: true, childList: true, characterData: true });
    };
    /** Does the live selection still say `needle`? If not, take the tint off now:
     *  nothing selected stops the echo, another word waits for the pending (or a
     *  new) debounce, which a stream of mutations must not keep pushing back. */
    const resync = (full = false): boolean => {
      const sel = window.getSelection();
      // Same boundary nodes and offsets, still in the page: the same selection.
      // Checked first because Selection.toString lays the page out, and this
      // runs on every mutation batch of a streaming reply.
      if (!full && sel && !sel.isCollapsed && sel.anchorNode === held.an && sel.anchorOffset === held.ao
        && sel.focusNode === held.fn && sel.focusOffset === held.fo && held.an?.isConnected && held.fn?.isConnected) return false;
      const live = echoVisible(sel, document.activeElement) ? selectionNeedle(sel) : '';
      if (live === needle) { remember(sel); return false; }
      clear();
      if (!live) { needle = ''; setRoot(null); }
      else if (!timer) onSelectionChange();
      return true;
    };
    const paint = () => {
      clear();
      if (!needle || !root || resync()) return;
      index ??= buildFindIndex(root);
      undo = paintSelectionMatches(index, needle);
    };
    function onSelectionChange() {
      // Drop the old tint at once (a click that clears the selection clears it
      // now); recompute only once a drag settles.
      clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        const sel = window.getSelection();
        needle = echoVisible(sel, document.activeElement) ? selectionNeedle(sel) : '';
        remember(sel);
        const anchor = sel?.anchorNode;
        const at = anchor instanceof Element ? anchor : anchor?.parentElement;
        setRoot(needle ? (at?.closest('.session-history') ?? document.body) : null);
        paint();
      }, 120);
    }
    // Every change that can show or hide the echo (utils/selection-echo.ts): the
    // selection, focus moving to an editor, a press outside it.
    const unsubscribe = subscribeEcho(onSelectionChange);
    return () => {
      unsubscribe();
      obs.disconnect();
      window.clearTimeout(timer);
      repaint.cancel();
      clear();
    };
  }, []);
}
