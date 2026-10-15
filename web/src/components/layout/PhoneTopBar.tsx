/**
 * The phone's one bar (spec 4.7 "Top bar"). On a page: Menu, the page name,
 * the page's right slot (the bell portals into it). With a layer open that has
 * a bar (session, chat, a note, a Settings pane...): Back, that layer's title
 * (and a 12 px status line), that layer's action. The bar never changes
 * height: 44 px plus the safe area. Connection state never takes the right
 * slot; it lives in the rows under the bar (PhoneStatusRow).
 */
import { useCallback, useSyncExternalStore, type Ref } from 'react';
import { usePhoneOverlayTop } from '@/hooks/usePhoneOverlayHistory';
import { useResyncState } from '@/hooks/usePhoneResync';
import { ChevronLeftIcon, MenuLinesIcon } from '../common/PhoneIcons';
import { PhoneStatusRow } from './PhoneStatusRow';

// The page's right slot, for portals from other components.
let slotEl: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
function setSlot(el: HTMLElement | null): void {
  if (slotEl === el) return;
  slotEl = el;
  for (const l of [...slotListeners]) l();
}
function subscribeSlot(cb: () => void): () => void {
  slotListeners.add(cb);
  return () => { slotListeners.delete(cb); };
}
const getSlot = () => slotEl;
const getServerSlot = () => null;

/**
 * The page's right-slot element to portal into, or null while a layer with a
 * bar is on top (its own action owns the slot then) and on desktop.
 */
export function usePhoneTopBarActionSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribeSlot, getSlot, getServerSlot);
}

/** The page's main scroll container: the largest scrollable box in <main>. */
export function findPageScroller(): HTMLElement | null {
  const main = document.querySelector('main.main-content');
  if (!main) return null;
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of main.querySelectorAll<HTMLElement>('*')) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { best = el; bestArea = area; }
  }
  return best;
}

export interface PhoneTopBarProps {
  pageTitle: string;
  menuRef: Ref<HTMLButtonElement>;
  menuExpanded: boolean;
  onMenu: () => void;
}

export function PhoneTopBar({ pageTitle, menuRef, menuExpanded, onMenu }: PhoneTopBarProps) {
  const top = usePhoneOverlayTop();
  const { syncing } = useResyncState();
  const pageSlotRef = useCallback((el: HTMLElement | null) => { setSlot(el); }, []);

  const bar = top?.bar ?? null;
  const onTitleTap = () => {
    if (bar) { bar.onTitleTap?.(); return; }
    findPageScroller()?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className={`phone-topbar${bar ? ' has-layer' : ''}`} data-layer={top?.kind}>
      {bar && top ? (
        <button
          type="button"
          className="phone-topbar-btn phone-topbar-back"
          onClick={top.close}
          aria-label="Back"
        >
          <ChevronLeftIcon size={24} />
        </button>
      ) : (
        <button
          ref={menuRef}
          type="button"
          className="sidebar-toggle phone-topbar-btn"
          onClick={onMenu}
          aria-label="Menu"
          aria-controls="primary-sidebar"
          aria-expanded={menuExpanded}
        >
          <MenuLinesIcon size={22} />
        </button>
      )}
      <button
        type="button"
        className={`phone-topbar-title${bar?.subtitle ? ' has-subtitle' : ''}`}
        onClick={onTitleTap}
      >
        <span className="phone-topbar-title-text">{bar ? bar.title : pageTitle}</span>
        {bar?.subtitle ? <span className="phone-topbar-subtitle">{bar.subtitle}</span> : null}
      </button>
      <div className="phone-topbar-right">
        {bar ? (bar.action ?? null) : <div ref={pageSlotRef} className="phone-topbar-slot" />}
      </div>
      <div
        className={`phone-topbar-sync${syncing ? ' is-active' : ''}`}
        role="progressbar"
        aria-label="Updating"
        aria-hidden={syncing ? undefined : true}
      />
      <PhoneStatusRow />
    </div>
  );
}
