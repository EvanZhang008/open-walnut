/**
 * useOverlayLayer: one stack of open popovers (Filter, Display, their flyouts
 * and chip menus) with a single Escape and outside-press policy (spec G36).
 *
 *  - Escape closes ONLY the topmost layer. The listener sits on `window` in the
 *    capture phase and is installed when this module is evaluated, i.e. before
 *    any component mounts, so the home page's own Escape handlers (task
 *    deselect in MainPage, multi-select, draft, detail; all bubble-phase or
 *    registered later) never see a key a layer took. preventDefault runs
 *    before stopImmediatePropagation: the beep guard folds its bookkeeping
 *    into the stop methods (see useModalOverlay).
 *  - A pointerdown outside a layer (and outside its exempt child portals)
 *    closes it, walking from the top down until a layer contains the target.
 *    The click that follows such a closing press is swallowed once (capture
 *    phase), so closing a popover by pressing a task row does not also open
 *    that task. A short timeout clears the flag when no click follows.
 *  - Tab and Shift-Tab cycle inside the topmost layer (its first ref): focus
 *    never escapes to the page behind an open popover (F09). Focus moves are
 *    programmatic, so WebKit, which skips plain buttons on Tab, reaches every
 *    value too.
 */
import { useEffect, useRef, type RefObject } from 'react';

export type OverlayCloseReason = 'escape' | 'outside';

export interface OverlayLayerOptions {
  open: boolean;
  onClose(reason: OverlayCloseReason): void;
  /** Elements that count as "inside" (the popover, its trigger button). */
  refs: readonly RefObject<HTMLElement | null>[];
  /** Selectors of child portals that count as inside (e.g. `.fb-values-flyout`). */
  exemptSelectors?: readonly string[];
  /** Default true. */
  closeOnEscape?: boolean;
  /** Runs before closing on Escape; return true to consume the key without closing (e.g. clear a search box). */
  onEscape?(e: KeyboardEvent): boolean;
  /** Default true: Tab cycles inside the layer's first ref. */
  trapFocus?: boolean;
}

interface Layer {
  id: number;
  opts: { current: OverlayLayerOptions };
}

const stack: Layer[] = [];
let nextId = 1;
let swallowClick = false;
let swallowTimer: ReturnType<typeof setTimeout> | null = null;
const SWALLOW_MS = 1000;

/** True while any overlay layer is open (other Escape handlers may check it). */
export function hasOpenOverlayLayer(): boolean {
  return stack.length > 0;
}

/** Test hook: the number of open layers. */
export function overlayLayerDepth(): number {
  return stack.length;
}

function contains(layer: Layer, target: EventTarget | null): boolean {
  // Duck-typed (not instanceof Node) so the stack logic is unit-testable without a DOM.
  const node = target as (Node & { closest?: Element['closest'] }) | null;
  if (!node || typeof node.nodeType !== 'number') return false;
  const { refs, exemptSelectors } = layer.opts.current;
  for (const ref of refs) if (ref.current && ref.current.contains(node)) return true;
  const el: Pick<Element, 'closest'> | null = typeof node.closest === 'function'
    ? (node as unknown as Element)
    : node.parentElement;
  if (el && exemptSelectors) {
    for (const sel of exemptSelectors) if (el.closest(sel)) return true;
  }
  return false;
}

function armSwallow(): void {
  swallowClick = true;
  if (swallowTimer) clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => { swallowClick = false; swallowTimer = null; }, SWALLOW_MS);
}

const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]';

/** Tab stops inside a popover, in DOM order (visible, enabled, tabIndex >= 0). */
export function overlayTabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled) return false;
    if (el.closest('[hidden], [inert]')) return false;
    return el.getClientRects().length > 0;
  });
}

function cycleTab(e: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (top.opts.current.trapFocus === false) return;
  const root = top.opts.current.refs[0]?.current;
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const stops = overlayTabStops(root);
  if (stops.length === 0) return;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const i = stops.indexOf(active as HTMLElement);
  const last = stops.length - 1;
  const next = e.shiftKey ? (i <= 0 ? last : i - 1) : (i < 0 || i === last ? 0 : i + 1);
  e.preventDefault();
  stops[next].focus({ preventScroll: true });
  stops[next].scrollIntoView?.({ block: 'nearest' });
}

function onKeyDownCapture(e: KeyboardEvent): void {
  if (e.key === 'Tab' && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && stack.length > 0) {
    cycleTab(e);
    return;
  }
  if (e.key !== 'Escape' || e.isComposing || stack.length === 0) return;
  const top = stack[stack.length - 1];
  const opts = top.opts.current;
  if (opts.closeOnEscape === false) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (opts.onEscape?.(e)) return;
  opts.onClose('escape');
}

function onPointerDownCapture(e: PointerEvent): void {
  if (stack.length === 0) return;
  let closed = false;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const layer = stack[i];
    if (contains(layer, e.target)) break;
    layer.opts.current.onClose('outside');
    closed = true;
  }
  if (closed) armSwallow();
}

function onClickCapture(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  if (swallowTimer) { clearTimeout(swallowTimer); swallowTimer = null; }
  e.preventDefault();
  e.stopImmediatePropagation();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('keydown', onKeyDownCapture, true);
  window.addEventListener('pointerdown', onPointerDownCapture, true);
  window.addEventListener('click', onClickCapture, true);
}

/** Push a layer on the stack; returns its removal. The hook below is the usual entry. */
export function registerOverlayLayer(opts: { current: OverlayLayerOptions }): () => void {
  const layer: Layer = { id: nextId++, opts };
  stack.push(layer);
  return () => {
    const i = stack.findIndex((l) => l.id === layer.id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** The window listeners, exported for unit tests (they are installed at module load in a browser). */
export const overlayLayerHandlers = {
  keydown: onKeyDownCapture,
  pointerdown: onPointerDownCapture,
  click: onClickCapture,
};

/** Register a popover as an overlay layer while `open` is true. */
export function useOverlayLayer(options: OverlayLayerOptions): void {
  const opts = useRef(options);
  opts.current = options;
  const { open } = options;
  useEffect(() => {
    if (!open) return;
    return registerOverlayLayer(opts);
  }, [open]);
}
