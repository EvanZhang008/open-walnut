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
 *
 * In a session it searches the whole history, not only what is on screen: the
 * server says which rows hold the query, the ones the page does not show
 * (older, or folded) count in their place in the conversation, and stepping
 * onto one shows it (utils/session-find.ts).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { findInSessionHistory, type SessionFindResult } from '@/api/sessions';
import { createPortal } from 'react-dom';
import { FileSearchBar } from '@/components/common/FileSearchBar';
import { READER_SCROLL_EVENT } from '@/components/sessions/phone-session-layer';
import { installFindPointerTracking, isFindChord, lastPointerTarget, panelHistoryOf } from '@/utils/find-scope';
import { dropStaleEchoes, echoVisible, paintSelectionMatches, subscribeEcho } from '@/utils/selection-echo';
import {
  PageFindController, SESSION_FIND_SKIP_SELECTOR, buildFindIndex, isBoxPaintMutation, liveRange, makeRepaintScheduler, prefersBoxPaint, selectionNeedle,
  type FindIndex, type FindStatus,
} from '@/utils/page-find';
import {
  hiddenTotal, placeOfHidden, placeOfPage, sessionFindOf, stepFind, stopAt, totalOf,
  type FindLayout, type FindStop, type HiddenRow, type SessionFindBridge,
} from '@/utils/session-find';
import {
  FIND_DOC_ATTR, PAGE_FIND_REQUEST, docAround, docLabel, docShows, engineFor, engineKindFor, primaryDoc, regionAround, scrollerOf,
  type FindEngine, type PageFindRequest,
} from '@/utils/find-doc';
import { otherWords } from '@/utils/find-near-words';
import { log } from '@/utils/log';
import '@/styles/page-find.css';

const EMPTY: FindStatus = { count: 0, index: 0, capped: false };
const NO_ROWS: HiddenRow[] = [];
const REMOTE_DEBOUNCE_MS = 250;
/** A step onto a hidden row that has not shown by then gives up. */
const REVEAL_TIMEOUT_MS = 60_000;
/** A row's folded cards asked to open: how long their words get to render. */
const FOLD_WAIT_MS = 1_500;
/** A held row still not on screen after this is asked to show again. */
const REASK_MS = 800;
/** Room kept between the active match and what floats over the chat (the
 *  panel's glass header, this bar, the jump-to-bottom button). */
const CLEARANCE_PX = 12;
const BOTTOM_CLEARANCE_PX = 44;

/** The whole-history answer for one query, or where getting it stands. */
interface Remote {
  key: string;
  state: 'loading' | 'ready' | 'error';
  result?: SessionFindResult;
}

/** What the bar shows: the page's matches and the hidden ones, in one order. */
interface View extends FindStatus {
  /** Hidden occurrences counted in `count`. */
  hidden: number;
  /** Of those, the ones in turns not on screen above the first rendered turn
   *  (earlier) or below it (later: a stretch left out); the rest sit folded (a
   *  closed card or tool run) in turns on screen. */
  earlier: number;
  later: number;
}

const EMPTY_VIEW: View = { ...EMPTY, hidden: 0, earlier: 0, later: 0 };

/** A step onto a hidden occurrence: the row to show and which match to land on. */
interface Reveal {
  id: string;
  /** Among the row's hidden occurrences, from its first and from its last. */
  occurrence: number;
  fromEnd: number;
  /** The row's matches already on screen, ahead of its hidden ones. */
  skip: number;
  /** The row is on screen and only words in its folded cards are hidden. */
  folded: boolean;
  /** When its folded cards were last asked to open (0: not asked). */
  foldsAsked: number;
  /** Rounds of opening that opened something: a shut turn fold, then a card inside it. */
  rounds: number;
  dir: 1 | -1;
  at: number;
  /** Ask the chat to show the row (again). */
  again: () => void;
  /** When it was last asked. */
  asked: number;
}

function bridgeOf(s: Scope | null): SessionFindBridge | null {
  return s?.kind === 'session' ? sessionFindOf(s.root) : null;
}

function sameRows(a: readonly HiddenRow[], b: readonly HiddenRow[]): boolean {
  return a.length === b.length && a.every((r, i) => r.id === b[i]!.id && r.count === b[i]!.count && r.pos === b[i]!.pos);
}

function remoteKey(sessionId: string, query: string, caseSensitive: boolean): string {
  return `${sessionId}\u0000${caseSensitive ? 1 : 0}\u0000${query}`;
}

/**
 * Where each page match sits in the chat's rows: the index of the row holding
 * it (`data-msg-index`). A match outside any row (the live reply) takes the
 * position of the one before it; one before every row, the very start. Also
 * how many page matches each row element (`data-message-id`) holds.
 */
function pageRows(ranges: readonly StaticRange[]): { pos: number[]; byId: Map<string, number>; ids: (string | null)[] } {
  const memo = new Map<Element, { pos: number | null; id: string | null }>();
  const pos: number[] = [];
  const ids: (string | null)[] = [];
  const byId = new Map<string, number>();
  let last = -Infinity;
  for (const r of ranges) {
    const node = r.startContainer;
    const el = node instanceof Element ? node : node.parentElement;
    let hit = el ? memo.get(el) : undefined;
    if (!hit && el) {
      const row = el.closest('[data-msg-index]');
      const n = row ? Number(row.getAttribute('data-msg-index')) : NaN;
      hit = { pos: Number.isFinite(n) ? n : null, id: rowIdOf(el) };
      memo.set(el, hit);
    }
    if (hit?.pos != null && hit.pos >= last) last = hit.pos;
    if (hit?.id) byId.set(hit.id, (byId.get(hit.id) ?? 0) + 1);
    pos.push(last);
    ids.push(hit?.id ?? null);
  }
  return { pos, byId, ids };
}

/** What carries a row's id on the page: a merged tool run's member
 *  (`data-find-row`, inside the run's own element) before a row element. */
const ROW_ID_SELECTOR = '[data-find-row], [data-message-id]';

/** The row a page node counts under. */
function rowIdOf(el: Element): string | null {
  const host = el.closest(ROW_ID_SELECTOR);
  return host ? host.getAttribute('data-find-row') ?? host.getAttribute('data-message-id') : null;
}

/** Every element on the page standing for row `id` (its bubble, its tools in a run). */
function rowElements(root: Element, id: string): Element[] {
  const q = CSS.escape(id);
  return [...root.querySelectorAll(`[data-message-id="${q}"], [data-find-row="${q}"]`)];
}

/** The page matches counted under row `id`, in page order. */
function matchesOfRow(ranges: readonly StaticRange[], id: string): number[] {
  const out: number[] = [];
  pageRows(ranges).ids.forEach((x, i) => { if (x === id) out.push(i); });
  return out;
}

/** The shut disclosures of a row the find opens to land on words inside them: a tool run or
 *  fold, and a plan card (closed by default since 2026-11-12). A new shut-by-default card
 *  fails tests/e2e/browser/session-find-whole-cases.ts (every kind of card) until it is here. */
const FIND_OPENS_SELECTOR = '.tool-run-toggle[aria-expanded="false"], .session-plan-card-toggle[aria-expanded="false"]';

/**
 * Open the closed tool runs ("Ran 3 commands ›") that hold row `id`'s words: in
 * its own elements, and the run its tools merged into while that run is shut
 * (its members are not drawn then). Opened as the reader would, by the toggle,
 * so the run stays open. True when one was opened.
 */
function openRunsOf(root: Element, id: string): boolean {
  const hosts = [...rowElements(root, id), ...root.querySelectorAll(`[data-find-members~="${CSS.escape(id)}"]`)];
  let opened = false;
  for (const host of hosts) {
    for (const t of host.querySelectorAll<HTMLElement>(FIND_OPENS_SELECTOR)) {
      if (!visible(t)) continue;
      t.click();
      opened = true;
    }
  }
  return opened;
}

/** Levels of shut disclosures one step opens on the way to a match (a turn fold, a card in it, a run in that). */
const OPEN_ROUNDS = 3;

/** Open row `id`'s folded cards and shut runs in one round. True when anything opened. */
function openAround(bridge: SessionFindBridge, root: Element, id: string): boolean {
  const cards = bridge.openFolds(id);
  const runs = openRunsOf(root, id);
  return cards || runs;
}

const pagePositions = (ranges: readonly StaticRange[]): number[] => pageRows(ranges).pos;

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

/** The element whose box the bar sits over (a document's pane, a chat). */
/** The frame of a searched document while the bar is open over it. */
const STRIP_CLASS = 'page-find-strip';

function frameOf(scope: Scope): Element {
  return scope.kind === 'doc' ? scrollerOf(scope.root) : scope.root;
}

const PLACEHOLDER: Record<Scope['kind'], string> = {
  session: 'Find in session', doc: 'Find in document', region: 'Find in chat', page: 'Find in page',
};

/** The DOM engine searching a session chat, a region or the page (a raw
 *  note view is searched by CodeMirror's own instead). */
function domOf(engine: FindEngine | null): PageFindController | null {
  return engine instanceof PageFindController ? engine : null;
}

/** The engine for one scope: a session chat's knows the whole-session find's
 *  needs (its own skip list, the bands floating over it, WebKit's boxes). */
function engineOf(next: Scope): FindEngine {
  if (next.kind !== 'session') return engineFor(next.root, next.kind, beforeScroll);
  const ctrl = new PageFindController(next.root, beforeScroll, next.root, SESSION_FIND_SKIP_SELECTOR, () => clearInset(next.root));
  if (prefersBoxPaint()) ctrl.useBoxes();
  return ctrl;
}

/** Announce a find-driven move to the chat, so its follow-bottom logic reads it
 *  as the reader's own scroll and does not pull the view back down. */
function beforeScroll(el: Element): void {
  if (el.classList.contains('session-history')) el.dispatchEvent(new Event(READER_SCROLL_EVENT));
}

/** The bands of a session chat that something floats over: the panel's glass
 *  header at the top, the jump-to-bottom button at the bottom (with room). */
function clearInset(root: Element): { top: number; bottom: number } {
  const box = root.getBoundingClientRect();
  const header = root.closest('.session-panel')?.querySelector('.session-panel-header')?.getBoundingClientRect();
  let under = header && header.bottom > box.top && header.top < box.top + 160 ? header.bottom - box.top : 0;
  // The bar (and its line) may reach below the header.
  const bar = document.querySelector('.page-find')?.getBoundingClientRect();
  if (bar && bar.right > box.left && bar.left < box.right && bar.top < box.top + 160) under = Math.max(under, bar.bottom - box.top);
  return { top: Math.max(0, under) + CLEARANCE_PX, bottom: BOTTOM_CLEARANCE_PX };
}

/** The rows of a session chat in its clear view: the first and the last index. */
function rowsInView(root: Element): { top: number; bottom: number } {
  const inset = clearInset(root);
  const box = root.getBoundingClientRect();
  const lo = box.top + inset.top;
  const hi = box.top + root.clientHeight - inset.bottom;
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of root.querySelectorAll('[data-msg-index]')) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= lo || r.top >= hi) continue;
    const i = Number(el.getAttribute('data-msg-index'));
    if (!Number.isFinite(i)) continue;
    if (i < top) top = i;
    if (i > bottom) bottom = i;
  }
  return { top, bottom };
}

/**
 * The first step from nothing chosen: the nearest match from the reader's view
 * in the pressed direction, the page's own and the hidden rows' weighed in the
 * whole conversation's order (a folded turn just below the view comes before a
 * page match further down); none that way, it wraps to the far end.
 */
function stopFromView(layout: FindLayout, root: Element, ctrl: PageFindController, dir: 1 | -1): FindStop | null {
  const total = totalOf(layout);
  if (!total) return null;
  const p = ctrl.fromView(dir);
  let best: FindStop | null = p >= 0 ? { kind: 'page', index: p } : null;
  let bestPlace = p >= 0 ? placeOfPage(layout, p) : NaN;
  const { top, bottom } = rowsInView(root);
  if (dir === 1) {
    const h = layout.hidden.findIndex((x) => x.pos >= top);
    if (h >= 0) {
      const place = placeOfHidden(layout, h, 0);
      if (!best || place < bestPlace) { best = { kind: 'hidden', row: h, occurrence: 0 }; bestPlace = place; }
    }
  } else {
    let h = -1;
    layout.hidden.forEach((x, i) => { if (x.pos <= bottom) h = i; });
    if (h >= 0) {
      const occurrence = layout.hidden[h]!.count - 1;
      const place = placeOfHidden(layout, h, occurrence);
      if (!best || place > bestPlace) { best = { kind: 'hidden', row: h, occurrence }; bestPlace = place; }
    }
  }
  return best ?? stopAt(layout, dir === 1 ? 0 : total - 1);
}

function barPosition(scope: Scope): { top: number; right: number } {
  if (scope.kind === 'page') return { top: 8, right: 16 };
  const r = frameOf(scope).getBoundingClientRect();
  const header = scope.root.closest('.session-panel')?.querySelector('.session-panel-header');
  // Below the panel's header, at the chat's top right: never over the
  // session's title and tabs (keepClear keeps the active match off the bar).
  const hb = header?.getBoundingClientRect();
  const under = hb && hb.bottom > r.top && hb.top < r.top + 160 ? hb.bottom : r.top;
  // A document's bar sits in its strip (STRIP_CLASS), above the text.
  const gap = scope.kind === 'doc' ? 4 : 6;
  return { top: Math.max(8, under + gap), right: Math.max(8, window.innerWidth - r.right + 18) };
}

export function PageFind() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  /** The count and place the bar shows (the page's and the hidden matches). */
  const [view, setView] = useState<View>(EMPTY_VIEW);
  /** The query changed and its count is not in yet (tests wait on this). */
  const [pending, setPending] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
  const [pos, setPos] = useState({ top: 8, right: 16 });
  const ctrlRef = useRef<FindEngine | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  openRef.current = open;
  // The scope searched, for close(), which outlives a render.
  const scopeRef = useRef<Scope | null>(null);
  scopeRef.current = scope;
  // The query on screen, for handlers that outlive a render.
  const latest = useRef({ query, caseSensitive });
  latest.current = { query, caseSensitive };
  // The match last chosen for the query on screen: a view toggling takes its
  // text away for a moment, and the count in between says none is chosen.
  const chosenRef = useRef({ query: '', cs: false, index: 0 });
  // Only a count made for the query on screen: right after a keystroke the
  // count still belongs to the query before it.
  const shownQuery = useRef({ query, caseSensitive });
  const sameQuery = shownQuery.current.query === query && shownQuery.current.caseSensitive === caseSensitive;
  shownQuery.current = { query, caseSensitive };
  if (!sameQuery) chosenRef.current = { query, cs: caseSensitive, index: 0 };
  else if (view.index > 0 && !pending) chosenRef.current = { query, cs: caseSensitive, index: view.index };
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
  // Ends the focus hold below (a hit just opened the bar), so the focus close()
  // gives back is not pulled into a field about to go.
  const releaseHoldRef = useRef<(() => void) | null>(null);

  // A document's bar sits in a strip of its own above the text (STRIP_CLASS),
  // never over the note's first lines (2026-11-07: it covered the top right).
  const stripRef = useRef<Element | null>(null);
  const reserveStrip = useCallback((frame: Element | null) => {
    if (stripRef.current === frame) return;
    stripRef.current?.classList.remove(STRIP_CLASS);
    frame?.classList.add(STRIP_CLASS);
    stripRef.current = frame;
  }, []);
  useEffect(() => () => reserveStrip(null), [reserveStrip]);

  // ── Whole-session find (utils/session-find.ts) ──
  const [remote, setRemote] = useState<Remote | null>(null);
  const remoteRef = useRef<Remote | null>(null);
  remoteRef.current = remote;
  const [retry, setRetry] = useState(0);
  /** Rows holding the query that the page does not show, in transcript order. */
  const hiddenRef = useRef<HiddenRow[]>(NO_ROWS);
  /** On a hidden occurrence: its 0-based place in the whole order (null: the
   *  page find's own active match, or none). */
  const onHiddenRef = useRef<number | null>(null);
  /** The hidden row asked to show, and which of its matches to land on. */
  const revealRef = useRef<Reveal | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Enter pressed while the whole-session answer was still out and the page had nothing. */
  const pendingNavRef = useRef<1 | -1 | null>(null);
  /** The match the bar was on when it closed (0-based, in the whole order), so
   *  reopening it on the same chat and words comes back to it, as a browser's does. */
  const lastPlaceRef = useRef<{ root: Element; query: string; caseSensitive: boolean; place: number } | null>(null);
  /** That place, waiting for the counts it needs to be found again. */
  const restoreRef = useRef<{ query: string; caseSensitive: boolean; place: number } | null>(null);
  const viewRef = useRef<View>(EMPTY_VIEW);
  /** Steps pressed while a turn was loading (+1 each Enter, -1 each Shift+Enter):
   *  taken once it lands, so every press counts. Counted against the page then,
   *  not the half-loaded one (a turn rendered before its recount is counted twice). */
  const stepsWaitingRef = useRef(0);

  const stopReveal = useCallback(() => { revealRef.current = null; stepsWaitingRef.current = 0; setRevealing(false); }, []);

  /** Room added above a session chat's first row while the bar is open, so a
   *  match in the very first message can sit below the bar (the chat cannot
   *  scroll above its top). Given back on close. */
  const roomRef = useRef<{ root: HTMLElement; px: number; inline: string } | null>(null);

  /** Keep the active match where the reader can see it: inside the chat, off the
   *  panel's glass header and this bar at the top and the jump-to-bottom button
   *  at the bottom. When it has to move, to the middle of that view, as a
   *  browser's find does: every step that scrolls lands at the same height. */
  const keepClear = useCallback((range: AbstractRange | undefined) => {
    const s = scopeRef.current;
    const bar = barRef.current;
    if (!range || !s || s.kind !== 'session' || !bar) return;
    const live = liveRange(range as StaticRange);
    const r = live?.getBoundingClientRect();
    if (!r || !(r.width || r.height)) return;
    const root = s.root as HTMLElement;
    const box = root.getBoundingClientRect();
    const inset = clearInset(root);
    let top = box.top + inset.top;
    const b = bar.getBoundingClientRect();
    if (r.right >= b.left && r.left <= b.right) top = Math.max(top, b.bottom + CLEARANCE_PX);
    const bottom = box.top + root.clientHeight - inset.bottom;
    if (r.top >= top && r.bottom <= bottom) return;
    const dy = (r.top + r.height / 2) - (top + (bottom - top) / 2);
    beforeScroll(root);
    if (root.scrollTop + dy < 0 && r.top < top) {
      // Above the chat's top: room above the first row, just enough.
      const need = Math.ceil(top - r.top - root.scrollTop);
      const room = roomRef.current?.root === root ? roomRef.current : { root, px: 0, inline: root.style.paddingTop };
      room.px += need;
      roomRef.current = room;
      const base = parseFloat(getComputedStyle(root).paddingTop) || 0;
      root.style.paddingTop = `${base + need}px`;
      root.scrollTop = 0;
      return;
    }
    root.scrollTop += dy;
  }, []);

  const giveRoomBack = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    if (!room || !room.root.isConnected) return;
    const st = room.root.scrollTop;
    room.root.style.paddingTop = room.inline;
    beforeScroll(room.root);
    room.root.scrollTop = Math.max(0, st - room.px);
  }, []);

  /** The page find's status changed (or the server's answer did): recount the
   *  hidden rows, finish a step onto one once its row shows, and work out what
   *  the bar says. */
  const apply = useCallback((dom: FindStatus) => {
    const ctrl = domOf(ctrlRef.current);
    const s = scopeRef.current;
    const r = remoteRef.current;
    const bridge = bridgeOf(s);
    const { query: q, caseSensitive: cs } = latest.current;
    let rows = NO_ROWS;
    let pagePos: number[] = [];
    let firstRendered = Infinity;
    /** Rows the page draws, open or folded away (a closed card, a closed tool
     *  run): the rest are in turns not on screen. */
    const drawn = new Set<string>();
    const ready = !!(s && ctrl && bridge && r?.state === 'ready' && r.result && r.key === remoteKey(bridge.sessionId, q, cs));
    if (ready && s && ctrl && bridge && r?.result) {
      const want = revealRef.current;
      if (want) {
        const row = rowElements(s.root, want.id).find(visible);
        let waiting = false;
        if (row) {
          // Its words may be in a folded card or a closed tool run: open them
          // first and land once they render (the MutationObserver's recount
          // comes back, or the watch below after FOLD_WAIT_MS).
          // Opening goes in rounds: the row's words can sit a level down (a received
          // card inside the turn fold the last round opened), so while they are still
          // short, each recount opens what now shows shut.
          const need = want.dir === -1 ? want.fromEnd : want.skip + want.occurrence;
          const short = matchesOfRow(ctrl.matchRanges(), want.id).length <= need;
          const tryOpen = want.rounds < OPEN_ROUNDS && (short || (want.rounds === 0 && want.folded && !want.foldsAsked));
          if (tryOpen && openAround(bridge, s.root, want.id)) {
            want.rounds++;
            want.foldsAsked = Date.now();
            waiting = true;
          } else if (want.foldsAsked > 0 && short && Date.now() - want.foldsAsked < FOLD_WAIT_MS) {
            waiting = true;
          } else if (!want.foldsAsked) {
            want.foldsAsked = -1;
          }
        } else if (want.rounds < OPEN_ROUNDS && openRunsOf(s.root, want.id)) {
          // Its tools merged into a run that is shut: the run opens, its members draw.
          want.rounds++;
          want.foldsAsked = Date.now();
          waiting = true;
        }
        if (waiting) { /* lands on the recount after the cards render */ } else if (row) {
          const queued = stepsWaitingRef.current;
          stopReveal();
          if (queued) {
            window.setTimeout(() => {
              for (let k = Math.abs(queued); k > 0; k--) onNavRef.current(queued > 0 ? 1 : -1);
            }, 0);
          }
          onHiddenRef.current = null;
          const inRow = matchesOfRow(ctrl.matchRanges(), want.id);
          if (inRow.length) {
            // Coming up from below, the row's last matches come first.
            const i = want.dir === -1 ? Math.max(0, inRow.length - 1 - want.fromEnd) : Math.min(want.skip + want.occurrence, inRow.length - 1);
            dom = ctrl.select(inRow[i]!);
            keepClear(ctrl.matchRanges()[inRow[i]!]);
          } else {
            // The words are in the row but not in its visible text (a card's
            // folded body the server read through): land on the row itself.
            beforeScroll(s.root);
            row.scrollIntoView({ block: 'center' });
          }
        } else if (Date.now() - want.at > REVEAL_TIMEOUT_MS) {
          stopReveal();
          onHiddenRef.current = null;
          setNotice('Could not load that turn');
        } else if (Date.now() - want.asked > REASK_MS && (bridge.positionOf(want.id, '') ?? -1) >= 0) {
          // Held but still not on screen: the fold holding it was not known
          // when it was asked (its rows had not rendered yet). Ask again.
          want.asked = Date.now();
          want.again();
        }
      }
      const shown = new Set<string>();
      for (const el of s.root.querySelectorAll(ROW_ID_SELECTOR)) {
        const id = el.getAttribute('data-find-row') ?? el.getAttribute('data-message-id');
        if (id && visible(el)) shown.add(id);
        if (id) drawn.add(id);
        const i = Number(el.getAttribute('data-msg-index'));
        if (Number.isFinite(i) && i < firstRendered && el.hasAttribute('data-msg-index')) firstRendered = i;
      }
      for (const el of s.root.querySelectorAll('[data-find-members]')) {
        for (const id of el.getAttribute('data-find-members')!.split(' ')) if (id) drawn.add(id);
      }
      const page = pageRows(ctrl.matchRanges());
      pagePos = page.pos;
      const onPage = new Set(pagePos);
      const found: HiddenRow[] = [];
      r.result.matches.forEach((m, j) => {
        const at = bridge.positionOf(m.id, m.timestamp);
        if (shown.has(m.id)) {
          // On screen, but some of its words are not (a folded card's body):
          // those count in the row, after its visible ones (a card's title
          // comes before its body).
          const rest = m.count - (page.byId.get(m.id) ?? 0);
          if (rest > 0 && at !== null && at >= 0) found.push({ id: m.id, count: rest, pos: at + 0.5 });
          return;
        }
        if (at === null) return;
        // A row on screen whose element carries no id of its own (a member of
        // a merged group) still has its matches counted by the page: not twice.
        if (at >= 0 && onPage.has(at)) return;
        // Not held yet: older than every held row, in the server's order.
        found.push({ id: m.id, count: m.count, pos: at >= 0 ? at : -1e9 + j });
      });
      found.sort((x, y) => x.pos - y.pos);
      rows = found.length ? found : NO_ROWS;
    }
    // The same rows as before (a streaming reply re-renders the page all the
    // time): keep the old array.
    if (sameRows(rows, hiddenRef.current)) rows = hiddenRef.current;
    hiddenRef.current = rows;
    const hidden = hiddenTotal(rows);
    if (onHiddenRef.current !== null && !revealRef.current && onHiddenRef.current >= hidden + dom.count) onHiddenRef.current = null;
    const layout: FindLayout = { hidden: rows, pagePos };
    // Reopened on the words it closed on: back on the match it was on, without
    // moving the page (Enter goes on from there).
    const back = restoreRef.current;
    if (back && ctrl && (bridge ? ready : true) && !revealRef.current) {
      restoreRef.current = null;
      const total = hidden + dom.count;
      if (back.query === q && back.caseSensitive === cs && dom.index === 0 && onHiddenRef.current === null && back.place < total) {
        const stop = bridge ? stopAt(layout, back.place) : { kind: 'page' as const, index: back.place };
        if (stop.kind === 'page') dom = ctrl.mark(stop.index);
        else onHiddenRef.current = back.place;
      }
    }
    let index = 0;
    if (onHiddenRef.current !== null) index = onHiddenRef.current + 1;
    else if (dom.index > 0) index = (pagePos.length ? placeOfPage(layout, dom.index - 1) : hidden + dom.index - 1) + 1;
    const away = rows.filter((x) => !drawn.has(x.id));
    const earlier = hiddenTotal(away.filter((x) => x.pos < firstRendered));
    const next: View = {
      count: hidden + dom.count,
      index,
      capped: dom.capped || !!(ready && r?.result?.capped),
      hidden,
      earlier,
      later: hiddenTotal(away) - earlier,
    };
    viewRef.current = next;
    setView(next);
  }, [stopReveal, keepClear]);

  const close = useCallback((opts: { restore?: boolean } = {}) => {
    releaseHoldRef.current?.();
    reserveStrip(null);
    const was = scopeRef.current;
    const { query: q, caseSensitive: cs } = latest.current;
    lastPlaceRef.current = was && viewRef.current.index > 0
      ? { root: was.root, query: q, caseSensitive: cs, place: viewRef.current.index - 1 }
      : null;
    restoreRef.current = null;
    viewRef.current = EMPTY_VIEW;
    ctrlRef.current?.close();
    ctrlRef.current = null;
    setOpen(false);
    setScope(null);
    setView(EMPTY_VIEW);
    setRemote(null);
    hiddenRef.current = NO_ROWS;
    onHiddenRef.current = null;
    pendingNavRef.current = null;
    stopReveal();
    setNotice(null);
    giveRoomBack();
    let back = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (opts.restore === false) return;
    // The document's editor was replaced while the bar was open (the note
    // loaded again, its raw view toggled): back to the one showing now.
    if (!canTakeFocus(back) && was?.kind === 'doc') {
      const doc = was.root.isConnected ? was.root : (was.root.getAttribute(FIND_DOC_ATTR) === 'primary' ? primaryDoc() : null);
      back = doc ? editableIn(doc) : null;
    }
    const root = was?.kind === 'session' ? was.root as HTMLElement : null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    else if (root?.isConnected) {
      // Opened from the chat itself (nothing focused): back to the chat, so
      // PageUp/PageDown and the next Cmd+F act on it, not on the page body.
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      root.focus({ preventScroll: true });
    }
  }, [stopReveal, giveRoomBack, reserveStrip]);

  /** Search `next` from now on (a new engine only for a new root). */
  const applyScope = useCallback((next: Scope) => {
    // Before the engine reveals a match, so it lands below the strip.
    reserveStrip(next.kind === 'doc' ? frameOf(next) : null);
    if (ctrlRef.current?.root !== next.root) {
      giveRoomBack();
      ctrlRef.current?.close();
      ctrlRef.current = engineOf(next);
    }
    setScope(next);
    setPos(barPosition(next));
  }, [giveRoomBack, reserveStrip]);

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
    const last = lastPlaceRef.current;
    if (!openRef.current && last && last.root === next.root && !seed) {
      restoreRef.current = { query: last.query, caseSensitive: last.caseSensitive, place: last.place };
    }
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
      // The typed words were not found as typed: the copy next to the rest of them.
      const others = q === queries[0] ? [] : otherWords(queries[0] ?? '', q);
      apply(ctrl.setQueryNear(q, cs, req.near ?? null, req.context, others));
      setQuery(q);
      setOpen(true);
      // The field takes the keys (Enter = next match, never a newline in the note).
      setFocusTick((n) => n + 1);
      log.info('page-find', 'open', { scope: 'doc', from: 'request' });
    };
    window.addEventListener(PAGE_FIND_REQUEST, onRequest);
    return () => window.removeEventListener(PAGE_FIND_REQUEST, onRequest);
  }, [applyScope, close, apply]);

  // The chord. Document capture: file views and the Changed tab listen on window
  // capture, so they decide first and stop the event when it is theirs.
  useEffect(() => {
    installFindPointerTracking();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Cmd+G / Shift+Cmd+G (Ctrl+G, F3 elsewhere): next / previous while the
      // bar is open, wherever the focus is, as in a browser's find.
      if (openRef.current && !e.altKey && ((e.key.toLowerCase() === 'g' && (e.metaKey || e.ctrlKey)) || e.key === 'F3')) {
        e.preventDefault();
        onNavRef.current(e.shiftKey ? -1 : 1);
        return;
      }
      if (!isFindChord(e)) return;
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
    onHiddenRef.current = null;
    pendingNavRef.current = null;
    stopReveal();
    setNotice(null);
    const timer = window.setTimeout(() => {
      const ctrl = ctrlRef.current;
      if (ctrl) apply(ctrl.setQuery(query, caseSensitive));
      setPending(false);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [open, query, caseSensitive, scope, apply, stopReveal]);

  // The rest of the session: ask the server which rows hold the query.
  useEffect(() => {
    const bridge = open ? bridgeOf(scope) : null;
    if (!bridge || !query) { setRemote(null); return; }
    const key = remoteKey(bridge.sessionId, query, caseSensitive);
    setRemote({ key, state: 'loading' });
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      findInSessionHistory(bridge.sessionId, query, caseSensitive, ac.signal).then(
        (result) => { if (!ac.signal.aborted) setRemote({ key, state: 'ready', result }); },
        (err: unknown) => {
          if (ac.signal.aborted) return;
          // A server without the route: the page alone, as before.
          if (err instanceof ApiError && err.status === 404) { setRemote(null); return; }
          log.warn('page-find', 'whole-session find failed', { sessionId: bridge.sessionId, error: err instanceof Error ? err.message : String(err) });
          setRemote({ key, state: 'error' });
        },
      );
    }, REMOTE_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ac.abort(); };
  }, [open, scope, query, caseSensitive, retry]);

  // Content changes (streaming, a fold opening, a row arriving) recount in place.
  useEffect(() => {
    if (!open || !scope) return;
    const root = scope.root;
    const bar = barRef.current;
    let textChanged = false;
    const repaint = makeRepaintScheduler(() => {
      const ctrl = ctrlRef.current;
      if (ctrl) apply(ctrl.refresh());
    });
    const obs = new MutationObserver((records) => {
      let relevant = false;
      for (const r of records) {
        if (bar && bar.contains(r.target)) continue;
        if (isBoxPaintMutation(r)) continue;
        relevant = true;
        if (r.type !== 'attributes') textChanged = true;
      }
      if (!relevant) return;
      // Drop the walk now (cheap), so a typed query or an Enter before the
      // recount never runs on nodes that just left.
      if (textChanged) { ctrlRef.current?.markDirty(); domOf(ctrlRef.current)?.dropStale(); textChanged = false; }
      // A document's raw view replaced its rendered one (or back): the other
      // engine searches it now, with the same query.
      const ctrl = ctrlRef.current;
      if (ctrl && ctrl.kind !== engineKindFor(root, scope.kind)) {
        // The same match stays chosen (by its number: both views hold the same text).
        const { query: q, caseSensitive: cs } = latest.current;
        const chosen = chosenRef.current;
        const was = viewRef.current.index || (chosen.query === q && chosen.cs === cs ? chosen.index : 0);
        ctrl.close();
        const next = engineOf(scope);
        ctrlRef.current = next;
        const counted = next.setQuery(q, cs);
        apply(was > 0 ? next.selectIndex(was) : counted);
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
    const watch = window.setInterval(() => {
      if (gone()) { onGone(); return; }
      // A step onto a hidden row that never showed gives up (apply checks the clock).
      const ctrl = domOf(ctrlRef.current);
      if (revealRef.current && ctrl) apply(ctrl.status());
    }, wasPrimary ? 250 : 1000);
    return () => {
      obs.disconnect();
      ro.disconnect();
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(scrollTimer);
      window.clearInterval(watch);
      window.removeEventListener('resize', place);
      repaint.cancel();
    };
  }, [open, scope, close, applyScope, apply]);

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
    const engine = ctrlRef.current;
    if (!engine) return;
    const ctrl = domOf(engine);
    // A raw note view (CodeMirror's own search): it steps by itself.
    if (!ctrl) {
      engine.setQuery(latest.current.query, latest.current.caseSensitive);
      apply(engine.nav(dir));
      return;
    }
    if (revealRef.current) { stepsWaitingRef.current += dir; return; }
    const dom = ctrl.setQuery(latest.current.query, latest.current.caseSensitive);
    const r = remoteRef.current;
    // The page has nothing yet and the rest of the session is still being
    // searched: the step waits for that answer instead of doing nothing.
    if (!dom.count && r?.state === 'loading') { pendingNavRef.current = dir; return; }
    pendingNavRef.current = null;
    setNotice(null);
    const layout: FindLayout = { hidden: hiddenRef.current, pagePos: pagePositions(ctrl.matchRanges()) };
    const from = onHiddenRef.current ?? (dom.index > 0 ? placeOfPage(layout, dom.index - 1) : null);
    const s = scopeRef.current;
    // Nothing chosen yet, in a session: the next match from where the reader
    // looks, in the whole conversation's order, loaded or not.
    const to = from === null && s && bridgeOf(s) ? stopFromView(layout, s.root, ctrl, dir) : stepFind(layout, from, dir);
    if (!to) {
      // Nothing chosen yet (the page): the page find picks from where the reader looks.
      if (dom.count) {
        onHiddenRef.current = null;
        stopReveal();
        const st = ctrl.nav(dir);
        apply(st);
        keepClear(ctrl.matchRanges()[st.index - 1]);
      }
      return;
    }
    if (to.kind === 'page') {
      onHiddenRef.current = null;
      stopReveal();
      apply(ctrl.select(to.index));
      keepClear(ctrl.matchRanges()[to.index]);
      return;
    }
    const row = layout.hidden[to.row]!;
    const bridge = bridgeOf(scopeRef.current);
    if (!bridge) return;
    const place = placeOfHidden(layout, to.row, to.occurrence);
    onHiddenRef.current = place;
    const root = scopeRef.current?.root;
    const folded = !!root && rowElements(root, row.id).some(visible);
    const ask: Reveal = {
      id: row.id, occurrence: to.occurrence, fromEnd: row.count - 1 - to.occurrence,
      skip: folded ? matchesOfRow(ctrl.matchRanges(), row.id).length : 0, folded, foldsAsked: 0, rounds: 0, dir, at: Date.now(),
      asked: Date.now(),
      again: () => bridge.reveal(row.id, () => {
        if (revealRef.current !== ask) return;
        stopReveal();
        onHiddenRef.current = null;
        setNotice('That turn is no longer in the transcript');
        setRetry((n) => n + 1);
      }, () => openRef.current && revealRef.current === ask),
    };
    revealRef.current = ask;
    setRevealing(true);
    apply(ctrl.clearActive());
    ask.again();
    // A row the chat already holds shows in its next render: the
    // MutationObserver's recount lands on it.
  }, [apply, stopReveal, keepClear]);
  const onNavRef = useRef(onNav);
  onNavRef.current = onNav;

  // The server's answer arrived (or went): recount with it, then take the step
  // that waited for it.
  useEffect(() => {
    const ctrl = domOf(ctrlRef.current);
    if (!open || !ctrl) return;
    apply(ctrl.status());
    const dir = pendingNavRef.current;
    if (dir && remote?.state !== 'loading') { pendingNavRef.current = null; onNavRef.current(dir); }
  }, [open, remote, apply]);

  usePageSelectionEcho();

  if (!open) return null;
  const remoteState = remote?.state ?? 'off';
  const searching = remoteState === 'loading';
  const focusField = () => barRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  let note: ReactNode = null;
  if (notice) note = notice;
  else if (revealing) note = 'Showing that turn…';
  else if (remoteState === 'error') {
    note = (
      <>
        Couldn&apos;t search the rest of the session
        <button
          type="button"
          className="page-find-retry"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setRetry((n) => n + 1); focusField(); }}
        >Retry</button>
      </>
    );
  } else if (searching && query && view.count > 0) note = 'Searching the rest of the session…';
  else if (view.hidden > 0) {
    // Turns not on screen, above every rendered turn or in a stretch left out
    // below it: earlier and later turns (Enter loads them). In turns on screen
    // but folded away: folded parts (Enter opens them).
    const more = remote?.result?.capped ? '+' : '';
    const folded = view.hidden - view.earlier - view.later;
    const parts = [
      view.earlier > 0 ? `${view.earlier}${more} in earlier turns` : '',
      view.later > 0 ? `${view.later}${view.earlier > 0 ? '' : more} in later turns` : '',
      folded > 0 ? `${folded}${view.earlier > 0 || view.later > 0 ? '' : more} in folded parts` : '',
    ].filter(Boolean);
    note = `${parts.join(', ')}${remote?.result?.partial ? ' (the oldest part not searched)' : ''}`;
  } else if (remote?.result?.partial) note = 'The oldest part of this session was not searched';
  return createPortal(
    <div
      ref={barRef}
      className={`page-find${note ? ' page-find-has-note' : ''}`}
      data-scope={scope?.kind}
      data-pending={pending ? 'true' : 'false'}
      data-remote={remoteState}
      data-earlier={view.hidden}
      data-revealing={revealing ? 'true' : 'false'}
      style={{ top: pos.top, right: pos.right }}
      // Esc closes from anywhere in the bar, not only from its field.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); close(); }
      }}
    >
      <FileSearchBar
        query={query}
        caseSensitive={caseSensitive}
        count={view.count}
        index={view.index}
        // More may come while the rest of the session is still being searched.
        // (On a match, "3/12" stays plain: the note below says it is still searching.)
        capped={view.capped || (searching && view.count > 0 && view.index === 0)}
        searching={searching && view.count === 0}
        incomplete={remoteState === 'error'}
        placeholder={scope?.kind === 'doc' ? docLabel(scope.root) : PLACEHOLDER[scope?.kind ?? 'page']}
        // Pending from the keystroke itself, not an effect later: a count read
        // right after typing must never be the previous query's.
        onQueryChange={(q) => { if (q !== query) setPending(true); setQuery(q); }}
        onToggleCase={() => { setPending(true); setCaseSensitive((v) => !v); }}
        onNav={onNav}
        onClose={close}
      />
      {note && <div className="page-find-note" role="status">{note}</div>}
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
    /** The selection's boundaries when `needle` was read from it. Held only while there
     *  is a needle: a boundary node kept after its selection ended kept whatever it sat in
     *  alive once that left the page (a closed finder, a closed column). */
    let held: { an: Node | null; ao: number; fn: Node | null; fo: number } = { an: null, ao: 0, fn: null, fo: 0 };
    const remember = (sel: Selection | null) => {
      const keep = needle ? sel : null;
      held = { an: keep?.anchorNode ?? null, ao: keep?.anchorOffset ?? 0, fn: keep?.focusNode ?? null, fo: keep?.focusOffset ?? 0 };
    };
    const clear = () => { undo?.(); undo = null; };
    const repaint = makeRepaintScheduler(() => paint());
    const obs = new MutationObserver((records) => {
      // The find bar's own boxes (page-find.ts BoxPaint) change no text.
      if (records.every(isBoxPaintMutation)) return;
      // Before the next frame: an echo whose text changed under it comes off now.
      dropStaleEchoes();
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
      if (!live) { needle = ''; remember(null); setRoot(null); }
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
