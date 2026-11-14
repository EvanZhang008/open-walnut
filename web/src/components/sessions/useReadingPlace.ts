/**
 * The one owner of a timeline's reading place (reading-place.ts has the rule).
 * Runs in SessionChatHistory for every box that shows a page: the panel's own
 * timeline and each Tree Mode page beside it.
 *
 * Records only a box the reader moved (a scroll within a second of his wheel or
 * touch on it, or a press or key anywhere, at the width the box had then; a
 * scroll the layout made never writes):
 * 150ms after that scroll stops, at once on a
 * pointer or key press in the box (the click that opens another page comes
 * next), and when the box unmounts (its rows are still in the document then).
 * A box that only landed (a restore, a page shown beside another box showing
 * the same page, the sibling page) never writes, so two boxes of one page never
 * overwrite the reader's place with a landing. Never while a restore waits for
 * its rows or holds them. A send or the arrow (`release`) keeps the end. And
 * when the box itself leaves a page for another (`keep`, the stack's capture,
 * right before the rows swap): his scroll still to be written is written, and a
 * page with no place yet keeps what the box shows of it, as he last saw it.
 *
 * Restores: before paint whenever the box shows a page (mount, another page, the
 * other view). A page with a kept place goes back there: the first kept row it
 * draws at the same height, or its end when the reader left it at the end. A kept
 * row older than the box's render window widens the window first. Then it holds
 * that place against late layout (row heights, pictures, the map gutter) until
 * the reader moves, at most HOLD_MS, and owns the landing meanwhile: the
 * initial-load bottom pin and the forced load scrolls stand down (`held`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { applyPlace, flushPlaces, getPlace, placeDrift, readPlace, setPlace, type ReadingPlace } from './reading-place';
import { READER_SCROLL_EVENT } from './phone-session-layer';

const RECORD_QUIET_MS = 150;
const HOLD_MS = 1500;
/** The hold lasts this long after the box last moved on screen, up to HOLD_MAX_MS. */
const HOLD_SETTLE_MS = 300;
const HOLD_MAX_MS = 4000;
/** The longest a kept place waits for its rows (a slow load, an older page of history);
 *  rows that arrive in time are always tried first. */
const PENDING_MS = 30_000;
const HOLD_STOPPERS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
/** A scroll this soon after the reader's input in the box is his. */
const INPUT_SCROLL_MS = 1000;
const BOX_INPUTS = ['wheel', 'touchstart', 'touchmove'] as const;
const PAGE_INPUTS = ['pointerdown', 'keydown'] as const;

export interface UseReadingPlaceArgs {
  sessionId: string;
  /** The page the box shows (placeKeyOf). */
  pageKey: string;
  /** The view: a switch between Conversation Mode and Tree Mode redraws the same page. */
  view: string;
  containerRef: RefObject<HTMLDivElement | null>;
  isAtBottom: MutableRefObject<boolean>;
  /** The rows the timeline holds (its render window may draw fewer). */
  messages: ReadonlyArray<{ msgId?: string; walnutMessageId?: string }>;
  /** Changes whenever the drawn rows may have (a wider window, more rows). */
  renderNonce: string;
  /** Draw at least the last `count` rows. */
  widenWindow: (count: number) => void;
  /** The load has settled: a kept row it does not hold is in no page of it yet... */
  loaded: boolean;
  /** ...unless the history has older rows than it holds (the lazy tail): then those are fetched. */
  older: boolean;
  loadOlder: () => void;
}

export interface ReadingPlaceApi {
  /** A kept place owns this page's landing now: no forced scroll to the bottom. */
  held: MutableRefObject<boolean>;
  /** When `pageKey`'s place was kept, if it has one (the stack landing defers to it). */
  placeAt: (pageKey: string) => number | undefined;
  /** The stack landing puts this page back itself (a pop in this box, to the
   *  place this box left it): the kept place lets go of the landing. */
  adopt: () => void;
  /** The reader asked for the end (a send, the arrow): the kept place lets go now. */
  release: () => void;
  /** The view is about to switch for a gesture on this row (an Ask inline from
   *  Tree Mode): that row keeps its height on screen in the new view. */
  carryRow: (msgId: string) => void;
  /** This box is about to swap `pageKey`'s rows for another page's (the stack's
   *  capture): what it shows of that page now is where the reader left it. */
  keep: (pageKey: string) => void;
}

export function useReadingPlace(a: UseReadingPlaceArgs): ReadingPlaceApi {
  const { sessionId, pageKey, view, containerRef, isAtBottom } = a;
  const argsRef = useRef(a);
  argsRef.current = a;
  /** The page the DOM shows (set in the same commit that swaps the rows). */
  const keyRef = useRef<string | null>(null);
  const held = useRef(false);
  const pending = useRef<{ key: string; place: ReadingPlace; until: number; olderAsked?: boolean } | null>(null);
  const hold = useRef<{ stop: () => void } | null>(null);
  const recordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The reader moved this page in this box since it showed it (`shownAt`). */
  const dirty = useRef(false);
  const shownAt = useRef(0);
  /** Something other than the reader scrolled the box after his last place. */
  const moved = useRef(false);
  /** This box, as places it reads name it (a remount is another box). */
  const boxId = useRef(`b${Math.random().toString(36).slice(2, 10)}`).current;

  const record = useCallback(() => {
    clearTimeout(recordTimer.current);
    recordTimer.current = undefined;
    const el = containerRef.current;
    const key = keyRef.current;
    if (!el || key === null || pending.current || hold.current) return;
    const place = readPlace(el, boxId);
    if (!place || (!place.atBottom && place.rows.length === 0)) return;
    setPlace(argsRef.current.sessionId, key, place);
  }, [containerRef, boxId]);

  const stopHold = useCallback(() => {
    hold.current?.stop();
    hold.current = null;
  }, []);

  /** Keep `el` at `place` every frame until the reader moves or HOLD_MS pass. */
  const startHold = useCallback((el: HTMLElement, place: ReadingPlace) => {
    stopHold();
    let raf = 0;
    let first = true;
    const startedAt = performance.now();
    let until = startedAt + HOLD_MS;
    let lastTop = Math.round(el.getBoundingClientRect().top);
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const t of HOLD_STOPPERS) el.removeEventListener(t, onInput);
      if (hold.current?.stop === stop) hold.current = null;
    };
    // The key or press that brought this page back is still being dispatched
    // (a listener added now hears it): only input after the hold began is his.
    function onInput(e: Event) { if (e.timeStamp > startedAt) stop(); }
    for (const t of HOLD_STOPPERS) el.addEventListener(t, onInput, { passive: true });
    const tick = () => {
      if (first) {
        first = false;
        // Mount effects have run by now (the scroll handler, the bottom pin, the
        // session reset that turns following on): the place is the reader's.
        el.dispatchEvent(new Event(READER_SCROLL_EVENT));
      }
      isAtBottom.current = false;
      // The bar above the box still settling (a path bar leaving): hold on.
      const top = Math.round(el.getBoundingClientRect().top);
      if (top !== lastTop) { lastTop = top; until = Math.min(startedAt + HOLD_MAX_MS, Math.max(until, performance.now() + HOLD_SETTLE_MS)); }
      const drift = placeDrift(el, place, boxId);
      if (drift !== null && Math.abs(drift) > 1) el.scrollTop += drift;
      if (performance.now() > until) { stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    hold.current = { stop };
  }, [isAtBottom, stopHold, boxId]);

  /** Apply the pending place if its rows are drawn; widen the window when not. */
  const tryRestore = useCallback((): void => {
    const p = pending.current;
    const el = containerRef.current;
    if (!p || !el) return;
    if (p.key !== keyRef.current) { pending.current = null; held.current = false; return; }
    const result = applyPlace(el, p.place, boxId);
    if (result === 'bottom') {
      pending.current = null;
      held.current = false;
      isAtBottom.current = true;
      return;
    }
    if (result === 'restored') {
      pending.current = null;
      held.current = true;
      isAtBottom.current = false;
      startHold(el, p.place);
      return;
    }
    const giveUp = () => { pending.current = null; held.current = false; };
    if (performance.now() > p.until) { giveUp(); return; }
    // Not drawn: a kept row the timeline holds but its window leaves out.
    const { messages, widenWindow, loaded, older, loadOlder } = argsRef.current;
    for (const kept of p.place.rows) {
      const at = messages.findIndex((m) => (m.msgId ?? m.walnutMessageId) === kept.id);
      // Off the live end first: a window following the bottom would cut the widening back.
      if (at >= 0) { isAtBottom.current = false; widenWindow(messages.length - at); return; }
    }
    if (!loaded) return; // a reload still loading: wait for its rows
    // Older than the rows held (a long session after a reload, whose cache keeps
    // the last 400): fetch the rest once, as a pin jump does, and wait for it.
    if (older && !p.olderAsked) {
      p.olderAsked = true;
      p.until = Math.max(p.until, performance.now() + PENDING_MS);
      loadOlder();
      return;
    }
    if (older) return; // still coming
    // Gone from a history that is all in (a rewind, a /compact): the box lands
    // as it would with no place.
    giveUp();
  }, [containerRef, isAtBottom, startHold, boxId]);

  // A view switch redraws the rows of the page on screen in the other view
  // (Tree Mode's question page is part of Conversation Mode's one timeline): the
  // rows the reader sees are read here, while the DOM still shows them, and stay
  // on screen in the new view. Read during render, before the commit swaps them.
  const viewRef = useRef(view);
  const carried = useRef<{ place: ReadingPlace; from: string | null } | null>(null);
  if (viewRef.current !== view) {
    viewRef.current = view;
    const el = containerRef.current;
    if (recordTimer.current !== undefined && dirty.current) record();
    // A row the switch was asked to keep (`carryRow`) goes first.
    const named = carried.current;
    const seen = el && !pending.current ? readPlace(el, boxId) : null;
    if (named) named.place.rows.push(...(seen?.rows ?? []).filter((r) => r.id !== named.place.rows[0]?.id));
    else carried.current = seen && (seen.atBottom || seen.rows.length) ? { place: seen, from: keyRef.current } : null;
  }

  // Showing a page: its place, before paint.
  useLayoutEffect(() => {
    clearTimeout(recordTimer.current);
    recordTimer.current = undefined;
    stopHold();
    keyRef.current = pageKey;
    dirty.current = false;
    moved.current = false;
    shownAt.current = performance.now();
    const switched = carried.current;
    carried.current = null;
    const el = containerRef.current;
    // The rows carried over a view switch, when the new view draws them (its end
    // only when it is the same page's end); else the page's own kept place.
    const drawn = (p: ReadingPlace) => !!el && p.rows.some((r) => el.querySelector(`[data-message-id="${CSS.escape(r.id)}"]`));
    const place = switched && drawn(switched.place)
      ? { ...switched.place, atBottom: switched.place.atBottom && switched.from === pageKey }
      : getPlace(sessionId, pageKey);
    if (!place) { pending.current = null; held.current = false; return; }
    pending.current = { key: pageKey, place, until: performance.now() + PENDING_MS };
    held.current = !place.atBottom;
    tryRestore();
  }, [sessionId, pageKey, view, stopHold, tryRestore, containerRef]);

  // The rows it waits for may be drawn now.
  const { renderNonce, loaded, older } = a;
  useLayoutEffect(() => {
    if (pending.current) tryRestore();
  }, [renderNonce, loaded, older, tryRestore]);

  // Recording.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let inputAt = -Infinity;
    let inputWidth = -1;
    // His input: a wheel or a finger on the box, a press or a key anywhere (a
    // jump he clicks moves the box too: the outline, a pin, the find bar), except
    // typing into the composer. A click that shows another page in this box
    // starts a new showing (`shownAt`), so the landing it causes is not his.
    const onInput = (e: Event) => {
      if (e.type === 'keydown') {
        const t = e.target as HTMLElement | null;
        if (t && t.closest('textarea, [contenteditable="true"], [contenteditable=""]')) return;
      }
      inputAt = performance.now();
      inputWidth = el.clientWidth;
    };
    const onScroll = () => {
      // Only his scroll writes. A scroll the layout made (a list opening narrows
      // the box and the text rewraps) is no place of his, even right after a click.
      if (!(performance.now() - inputAt < INPUT_SCROLL_MS && inputAt > shownAt.current) || el.clientWidth !== inputWidth) {
        // Moved since by something else: what the box shows is no longer his.
        if (dirty.current && recordTimer.current === undefined) moved.current = true;
        return;
      }
      dirty.current = true;
      moved.current = false;
      clearTimeout(recordTimer.current);
      recordTimer.current = setTimeout(record, RECORD_QUIET_MS);
    };
    // Capture phase: before the click's own handler opens another page.
    const now = () => { if (dirty.current && !moved.current && !hold.current) record(); };
    // A page leaving runs no timer: his last scroll is written before it goes (flushPlaces).
    const leave = () => { if (recordTimer.current !== undefined && !moved.current) record(); flushPlaces(); };
    window.addEventListener('pagehide', leave);
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointerdown', now, { capture: true, passive: true });
    el.addEventListener('keydown', now, { capture: true, passive: true });
    for (const t of BOX_INPUTS) el.addEventListener(t, onInput, { passive: true });
    for (const t of PAGE_INPUTS) document.addEventListener(t, onInput, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pagehide', leave);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointerdown', now, { capture: true });
      el.removeEventListener('keydown', now, { capture: true });
      for (const t of BOX_INPUTS) el.removeEventListener(t, onInput);
      for (const t of PAGE_INPUTS) document.removeEventListener(t, onInput, { capture: true });
    };
  }, [containerRef, record, sessionId]);

  // Unmounting (Main leaving the left page, a remount): its rows are still drawn.
  useLayoutEffect(() => () => {
    stopHold();
    if (dirty.current && !moved.current) record();
  }, [record, stopHold]);

  const placeAt = useCallback((key: string) => getPlace(argsRef.current.sessionId, key)?.at, []);
  const adopt = useCallback(() => {
    stopHold();
    pending.current = null;
    held.current = false;
  }, [stopHold]);
  const release = useCallback(() => {
    stopHold();
    pending.current = null;
    held.current = false;
    // The end is the reader's place now, whatever the box held before.
    const key = keyRef.current;
    if (key !== null) setPlace(argsRef.current.sessionId, key, { rows: [], width: 0, atBottom: true, at: Date.now() });
  }, [stopHold]);
  const keep = useCallback((key: string) => {
    if (keyRef.current !== key) return;
    // A place the reader made here stands (the click that leaves can change the
    // layout first: a list opening narrows the box); one still to be written is
    // written now. A page with no place yet keeps the box's view, a landing he
    // saw. A kept place a box only showed is never replaced by that box (the same
    // page can be in two boxes, and the other may be where he moved it).
    if (dirty.current ? recordTimer.current !== undefined : !getPlace(argsRef.current.sessionId, key)) record();
  }, [record]);
  const carryRow = useCallback((msgId: string) => {
    const el = containerRef.current;
    const row = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(msgId)}"]`);
    if (!el || !row) return;
    const box = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    carried.current = {
      place: { rows: [{ id: msgId, top: Math.round(r.top - box.top), height: Math.round(r.height) }], width: Math.round(el.clientWidth), atBottom: false, at: Date.now(), box: boxId, boxTop: Math.round(box.top) },
      from: keyRef.current,
    };
  }, [containerRef, boxId]);
  return { held, placeAt, adopt, release, keep, carryRow };
}
