/**
 * The live inputs of AttentionBannerMount, kept out of the component so it
 * stays a thin switch: the health the home page publishes (so the task panel's
 * banner prop never changes identity on a health frame), the card's measured
 * height, the empty box that holds the task panel still while the notification
 * panel borrows the card, "hold the layout" (the pointer is over what would
 * move), and the 400ms click guard after a height change slid something under
 * a pointer that did not move.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import type { BannerMount, HostBannerOwner } from '@/utils/host-banner-placement';
import { getLastPointer, installPointerTracker, type LastPointer } from '@/utils/pointer-tracker';
import { log } from '@/utils/log';

/** A click this soon after a height change, with the pointer where it was, is not aimed at what is there now. */
export const CLICK_GUARD_MS = 400;
/** How far the pointer may drift and still count as "did not move". */
export const CLICK_GUARD_PX = 4;

// ── Health channel (MainPage publishes, the task panel mount reads) ──

interface HealthSnapshot { health: SystemHealth | undefined; loading: boolean }
let healthSnap: HealthSnapshot = { health: undefined, loading: true };
const healthListeners = new Set<() => void>();

/** Called by the home page in a layout effect whenever its useSystemHealth() answer changes. */
export function publishBannerHealth(health: SystemHealth | undefined, loading: boolean): void {
  if (healthSnap.health === health && healthSnap.loading === loading) return;
  healthSnap = { health, loading };
  for (const l of healthListeners) l();
}

function subscribeHealth(cb: () => void): () => void {
  healthListeners.add(cb);
  return () => { healthListeners.delete(cb); };
}

const getHealthSnap = (): HealthSnapshot => healthSnap;

/** Store access for tests and non-React readers. */
export const subscribeBannerHealth = subscribeHealth;
export const getBannerHealth = getHealthSnap;

/** The last published health (the mount falls back to it when no health prop is passed). */
export function useBannerHealth(): HealthSnapshot {
  return useSyncExternalStore(subscribeHealth, getHealthSnap, getHealthSnap);
}

// ── Measured height of the card's content box ──

/**
 * The content box's natural height (it stays measurable while the grid row
 * animates from 0fr). Read synchronously after every render of the mount (so
 * an owner switch never paints one stale frame) and on every resize after.
 */
export function useMeasuredHeight(el: HTMLElement | null): number {
  const [h, setH] = useState(0);
  const read = useCallback((): void => {
    setH(el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : 0);
  }, [el]);
  useLayoutEffect(read);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    // React state only (rendered after the callback), so read inside it: a frame later
    // would miss the owner-switch and page-load windows of useInstantAppear.
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, read]);
  return h;
}

// ── Reserve: the task panel keeps the card's height while the panel shows it ──

/**
 * The reserve height, or null. Created only when the owner goes from tasks to
 * notifications on the home route (the card was on screen right there);
 * dropped when the owner changes again and at once on any pathname change, so
 * an old measurement never comes back after Open Settings.
 */
export function useReserve(where: BannerMount, owner: HostBannerOwner, pathname: string, lastHeight: number): number | null {
  const [reserve, setReserve] = useState<number | null>(null);
  const [prev, setPrev] = useState({ owner, pathname });
  if (prev.owner !== owner || prev.pathname !== pathname) {
    setPrev({ owner, pathname });
    const next = nextReserve(where, prev, { owner, pathname }, lastHeight);
    if (next !== reserve) setReserve(next);
  }
  return reserve;
}

interface OwnerAt { owner: HostBannerOwner; pathname: string }

/** Pure: the reserve after one owner/pathname change (null = none). */
export function nextReserve(where: BannerMount, prev: OwnerAt, next: OwnerAt, lastHeight: number): number | null {
  const borrowed = where === 'tasks' && prev.pathname === '/' && next.pathname === '/'
    && prev.owner === 'tasks' && next.owner === 'notifications';
  return borrowed && lastHeight > 0 ? lastHeight : null;
}

// ── Hold the layout while the pointer is over what would move ──

const inside = (p: LastPointer, r: DOMRect): boolean =>
  p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;

/**
 * Pure read of the hold rule, from the mount element and the last pointer
 * position: the rest of the task panel below its toolbar (the card's own
 * pointer-inside rule covers the card), a task drag, or the System section below the card.
 */
export function holdLayoutNow(where: BannerMount, el: HTMLElement | null, p: LastPointer | null, pointerOut: boolean): boolean {
  if (!el) return false;
  if (where === 'tasks') {
    const panel = el.closest<HTMLElement>('.todo-panel');
    if (!panel) return false;
    if (panel.classList.contains('is-task-dragging')) return true;
    if (!p || pointerOut) return false;
    // Over the card itself the card's own pointer-inside rule decides (the
    // user's own Retry or Check again answers in place, as it always has).
    if (inside(p, el.getBoundingClientRect())) return false;
    const r = panel.getBoundingClientRect();
    const toolbar = panel.querySelector<HTMLElement>('.todo-panel-toolbar');
    const below = toolbar ? toolbar.getBoundingClientRect().bottom : r.top;
    return inside(p, r) && p.y >= below;
  }
  if (where === 'notifications') {
    if (!p || pointerOut) return false;
    // The card heads the System section: what moves is the section below it
    // (the rail never does), and over the card its own rule decides.
    if (inside(p, el.getBoundingClientRect())) return false;
    const detail = el.closest<HTMLElement>('.nfc-detail');
    return !!detail && inside(p, detail.getBoundingClientRect());
  }
  return false;
}

/**
 * True while a height change of the card would move something under the
 * pointer (or under a task drag). Re-read on every pointer move (one per
 * frame), on the pointer leaving the window, and on the task panel's class
 * changing (a drag starting or ending). The card caps the hold at 10s.
 */
export function useHoldLayout(where: BannerMount, el: HTMLElement | null): boolean {
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (!el || (where !== 'tasks' && where !== 'notifications')) { setHold(false); return; }
    installPointerTracker();
    let out = false;
    let raf = 0;
    const read = (): void => { raf = 0; setHold(holdLayoutNow(where, el, getLastPointer(), out)); };
    const schedule = (): void => { if (!raf) raf = requestAnimationFrame(read); };
    const onMove = (): void => { out = false; schedule(); };
    const onLeave = (): void => { out = true; schedule(); };
    const onOut = (e: MouseEvent): void => { if (!e.relatedTarget) onLeave(); };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener('pointermove', onMove, opts);
    document.addEventListener('mouseout', onOut, opts);
    window.addEventListener('blur', onLeave);
    const panel = where === 'tasks' ? el.closest('.todo-panel') : null;
    const mo = panel && typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    if (panel && mo) mo.observe(panel, { attributes: true, attributeFilter: ['class'] });
    read();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('blur', onLeave);
      mo?.disconnect();
    };
  }, [where, el]);
  return hold;
}

// ── Click guard after a height change ──

/**
 * For CLICK_GUARD_MS after the wrapper's height changes, a capture click
 * listener on the enclosing panel (found through closest(), so the panel
 * components stay untouched) swallows a pointer click outside the card and
 * below its top edge when the pointer has not moved more than CLICK_GUARD_PX
 * since the change: whatever is under it slid there, the user aimed elsewhere.
 * Keyboard clicks (detail 0) always pass.
 */
export interface GuardInput {
  armedAt: number;
  armedPointer: LastPointer | null;
  now: number;
  click: { clientX: number; clientY: number; detail: number };
  inCard: boolean;
  cardTop: number;
}

/** Pure: swallow this click? Only a pointer click, inside the window, outside the card, below its top, not moved. */
export function shouldSwallowClick(g: GuardInput): boolean {
  if (!g.armedPointer || g.click.detail === 0 || g.inCard) return false;
  if (g.now - g.armedAt > CLICK_GUARD_MS || g.click.clientY < g.cardTop) return false;
  return Math.hypot(g.click.clientX - g.armedPointer.x, g.click.clientY - g.armedPointer.y) <= CLICK_GUARD_PX;
}

export function useClickGuard(wrapper: HTMLElement | null, containerSelector: string | null): void {
  const armed = useRef<{ at: number; p: LastPointer | null } | null>(null);
  const lastH = useRef<number | null>(null);
  const onResize = useCallback((h: number) => {
    if (lastH.current !== null && Math.abs(h - lastH.current) >= 1) {
      armed.current = { at: performance.now(), p: getLastPointer() };
    }
    lastH.current = h;
  }, []);
  useEffect(() => {
    const container = wrapper && containerSelector ? wrapper.closest<HTMLElement>(containerSelector) : null;
    if (!wrapper || !container) return;
    installPointerTracker();
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => onResize(wrapper.getBoundingClientRect().height)) : null;
    ro?.observe(wrapper);
    onResize(wrapper.getBoundingClientRect().height);
    const onClick = (e: MouseEvent): void => {
      const a = armed.current;
      const target = e.target as Node | null;
      if (!a || !shouldSwallowClick({
        armedAt: a.at, armedPointer: a.p, now: performance.now(), click: e,
        inCard: !!target && wrapper.contains(target), cardTop: wrapper.getBoundingClientRect().top,
      })) return;
      e.preventDefault();
      e.stopPropagation();
      log.info('attention-banner', 'click swallowed after a height change', { msSinceChange: Math.round(performance.now() - a.at) });
    };
    container.addEventListener('click', onClick, true);
    return () => {
      ro?.disconnect();
      container.removeEventListener('click', onClick, true);
      lastH.current = null;
      armed.current = null;
    };
  }, [wrapper, containerSelector, onResize]);
}

// ── Enter without the grow animation ──

/**
 * `skip`: the card should appear at full height at once: the notification
 * panel's System section showing (the section itself is the entrance), and the task panel
 * taking the card back from its reserve (same height, nothing to grow).
 * `minHeight`: while the card taking the reserve's place back has no measured
 * height yet, the mount keeps the reserve's outer height, so the list below
 * never grows for a frame (WebKit clamps its scroll position right there).
 * Both clear once the card has a height, or after half a second.
 */
export function useSkipEnter(where: BannerMount, reserve: number | null, h: number, mount: HTMLElement | null): { skip: boolean; minHeight: number | null } {
  const [skip, setSkip] = useState(where === 'notifications');
  const [minHeight, setMinHeight] = useState<number | null>(null);
  const [prevReserve, setPrevReserve] = useState(reserve);
  if (prevReserve !== reserve) {
    setPrevReserve(reserve);
    if (prevReserve !== null && reserve === null) {
      setSkip(true);
      setMinHeight(mount ? mount.getBoundingClientRect().height : null);
    }
  }
  useLayoutEffect(() => {
    if (!skip && minHeight === null) return;
    if (h > 0) { setSkip(false); setMinHeight(null); return; }
    const t = setTimeout(() => { setSkip(false); setMinHeight(null); }, 500);
    return () => clearTimeout(t);
  }, [skip, minHeight, h]);
  return { skip, minHeight };
}

// ── Grow phase of the wrapper ──

/** How long the grow runs (the CSS transition is 150ms; a little slack for the last frame). */
export const GROW_MS = 200;
export type GrowPhase = 'closed' | 'opening' | 'settled';

/**
 * closed (0fr) -> opening (1fr, the transition) -> settled (a plain block). The
 * wrapper leaves grid layout once the grow is done: WebKit keeps a 1fr row at a
 * stale taller height after the card shrinks (a task panel resize), and the
 * reserve would then be shorter than the space the card took.
 */
export function useGrowPhase(open: boolean, instant: boolean): GrowPhase {
  const [phase, setPhase] = useState<GrowPhase>(open ? 'settled' : 'closed');
  let next: GrowPhase = phase;
  if (!open) next = 'closed';
  else if (instant) next = 'settled';
  else if (phase === 'closed') next = 'opening';
  if (next !== phase) setPhase(next);
  useEffect(() => {
    if (phase !== 'opening') return;
    const t = setTimeout(() => setPhase((p) => (p === 'opening' ? 'settled' : p)), GROW_MS);
    return () => clearTimeout(t);
  }, [phase]);
  return next;
}

// ── Appear at full height when the card only changed place ──

/** A card this soon after its mount became the owner only changed place (it was known before). */
export const OWNER_SWITCH_MS = 300;
/** Cards that land while the page is still loading are part of the load, not news. */
export const PAGE_LOAD_MS = 2_500;

/** Pure: skip the grow for a card appearing `sinceOwnerMs` after its mount became the owner, `sinceLoadMs` into the page. */
export function appearsInstantly(sinceOwnerMs: number, sinceLoadMs: number): boolean {
  return sinceOwnerMs < OWNER_SWITCH_MS || sinceLoadMs < PAGE_LOAD_MS;
}

/**
 * True when the card should paint at its final height on its first frame:
 * the mount just became the owner (a return to Home, the notification panel
 * closing, the task panel showing again: the card was already known), or the
 * page is still loading. A problem that arrives later grows in as news.
 */
export function useInstantAppear(showCard: boolean, hasHeight: boolean): boolean {
  const since = useRef<number>(typeof performance !== 'undefined' ? performance.now() : 0);
  const wasShowing = useRef(showCard);
  if (showCard && !wasShowing.current) since.current = performance.now();
  wasShowing.current = showCard;
  if (!showCard || !hasHeight) return false;
  const now = performance.now();
  return appearsInstantly(now - since.current, now);
}

// ── The task panel opening: the card never rewraps at a growing width ──

/** The column's width once its transition ends: its inline width (px, or % of its flex parent). */
export function finalWidthOf(col: HTMLElement): number {
  const w = col.style.width.trim();
  if (w.endsWith('%')) {
    const parent = col.parentElement;
    if (!parent) return NaN;
    const cs = getComputedStyle(parent);
    const inner = parent.getBoundingClientRect().width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return (inner * parseFloat(w)) / 100;
  }
  return parseFloat(w);
}

/**
 * While the task panel's column runs its width transition (it opens from 0),
 * the card gets the column's final width, so its text never rewraps frame by
 * frame; the column clips it until the transition ends. Null otherwise.
 */
export function useFinalWidthDuringOpen(el: HTMLElement | null, showCard: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const col = el?.closest<HTMLElement>('.main-page-todo');
    if (!el || !col || !showCard) { setWidth(null); return; }
    const target = finalWidthOf(col);
    const now = col.getBoundingClientRect().width;
    if (!Number.isFinite(target) || target - now < 2) { setWidth(null); return; }
    // The mount's own width is the column's less the fixed chrome around it.
    setWidth(Math.max(0, Math.round(target - (now - el.getBoundingClientRect().width))));
    const done = (e?: TransitionEvent): void => { if (!e || (e.target === col && e.propertyName === 'width')) setWidth(null); };
    col.addEventListener('transitionend', done);
    const t = setTimeout(done, 600);
    return () => { col.removeEventListener('transitionend', done); clearTimeout(t); };
  }, [el, showCard]);
  return width;
}
