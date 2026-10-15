/**
 * The session overlay as a phone layer (spec 4.3, 4.7 "Session overlay").
 *
 * The phone shows ONE bar: the session's own header is hidden and its title,
 * its status line and its kebab move into the top bar. The kebab is not built
 * twice: the bar's action is a stable empty slot (`PhoneBarSlot`), and the
 * panel portals its real kebab into that slot, so the menu keeps the panel's
 * React tree (contexts, state) and the bar's identity never changes while the
 * panel re-renders on every streamed token.
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePhoneOverlay, type PhoneOverlayKind } from '@/hooks/usePhoneOverlayHistory';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';

const slots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

function setSlot(id: string, el: HTMLElement | null): void {
  if ((slots.get(id) ?? null) === el) return;
  if (el) slots.set(id, el); else slots.delete(id);
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The top bar's right-slot element for a layer, once the bar has drawn it. */
export function usePhoneBarSlot(slotId: string): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slots.get(slotId) ?? null, () => null);
}

/** Rendered BY the top bar (as the layer's action): an empty target to portal into. */
export function PhoneBarSlot({ slotId }: { slotId: string }) {
  const ref = useCallback((el: HTMLDivElement | null) => setSlot(slotId, el), [slotId]);
  return <div ref={ref} className="phone-bar-slot" data-phone-bar-slot={slotId} />;
}

export interface PhoneLayerInput {
  id: string;
  kind: PhoneOverlayKind;
  active: boolean;
  title: string;
  subtitle?: string;
  onClose: (info: { fromHistory: boolean }) => void;
  /** Scroll target of a tap on the bar title (never "to the top" for a timeline). */
  onTitleTap?: () => void;
  /** First push of the load opened from a deep link: back lands on this URL. */
  deepLinkBaseUrl?: string;
  /** false: the layer has no action of its own (the right slot stays empty). */
  withAction?: boolean;
}

/**
 * Register a phone layer that has a bar, with a stable action slot. Returns
 * the UI close (through history on a phone) and the slot to portal into.
 */
export function usePhoneLayerWithBar(o: PhoneLayerInput): { close: () => void; slot: HTMLElement | null; phone: boolean } {
  const phone = usePhoneLayout();
  const tapRef = useRef(o.onTitleTap);
  tapRef.current = o.onTitleTap;
  const onTitleTap = useCallback(() => { tapRef.current?.(); }, []);
  const slotId = o.id;
  const withAction = o.withAction !== false;
  const action = useMemo(() => (withAction ? <PhoneBarSlot slotId={slotId} /> : undefined), [slotId, withAction]);
  const bar = useMemo(
    () => ({ title: o.title, subtitle: o.subtitle, action, onTitleTap }),
    [o.title, o.subtitle, action, onTitleTap],
  );
  const { close } = usePhoneOverlay({
    id: o.id,
    kind: o.kind,
    open: o.active,
    onClose: o.onClose,
    bar,
    deepLinkBaseUrl: o.deepLinkBaseUrl,
  });
  const slot = usePhoneBarSlot(slotId);
  return { close, slot: phone && o.active ? slot : null, phone };
}

/**
 * The bar title's tap in a timeline (C53): the start of the latest turn, never
 * the top (that pages in older history and loses the reading place).
 */
export function scrollToLatestTurnStart(root: HTMLElement | null): void {
  if (!root) return;
  const scroller = root.querySelector<HTMLElement>('.session-history') ?? findScroller(root);
  if (!scroller) return;
  const top = latestTurnStartTop(scroller);
  if (top === null) return;
  // The timeline treats a scroll with no input on it as its own echo and pins
  // back to the bottom; this one is the reader's, so say so first.
  scroller.dispatchEvent(new Event(READER_SCROLL_EVENT));
  scroller.scrollTo({ top: Math.max(1, top - 8) });
}

/** Dispatched on a timeline before a scroll the reader asked for from outside it. */
export const READER_SCROLL_EVENT = 'walnut:reader-scroll';

/** Where the latest user message starts, in the timeline's content (null: none). */
export function latestTurnStartTop(scroller: HTMLElement): number | null {
  const users = scroller.querySelectorAll<HTMLElement>('[data-msg-role="user"]');
  const last = users[users.length - 1];
  if (!last) return null;
  return last.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** The tallest scrollable box under root (the timeline). */
export function findScroller(root: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestH = 0;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    if (el.clientHeight > bestH) { best = el; bestH = el.clientHeight; }
  }
  return best;
}
