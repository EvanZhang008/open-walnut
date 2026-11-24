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
import { escapeWasConsumedByOthers } from '@/utils/escape-beep-guard';
import { isImeKey } from '@/utils/ime-key';

export type OverlayCloseReason = 'escape' | 'outside';

export interface OverlayLayerOptions {
  open: boolean;
  onClose(reason: OverlayCloseReason): void;
  /** Elements that count as "inside" (the popover, its trigger button). */
  refs: readonly RefObject<HTMLElement | null>[];
  /** Selectors of child portals that count as inside (e.g. `.fb-values-flyout`). */
  exemptSelectors?: readonly string[];
  /** Default true. A function is asked when the key is pressed (a field that owns its own Escape).
   *  `'if-unclaimed'` lets the page go first: the layer takes the Escape only once it has travelled
   *  the whole page with no handler claiming it (a text field that uses Escape only while its own
   *  list is open: the composer's @, / and recall lists). */
  closeOnEscape?: boolean | (() => boolean | 'if-unclaimed');
  /** Default true. False blocks outside dismissal of this layer and every layer below it. */
  closeOnOutside?: boolean;
  /** Runs before closing on Escape; return true to consume the key without closing (e.g. clear a search box). */
  onEscape?(e: KeyboardEvent): boolean;
  /** Default true: Tab cycles inside the layer's first ref. */
  trapFocus?: boolean;
  /** The click after a press that closed this layer goes through (a light confirm, where the
   *  press outside means "do that instead"). Default false: it is swallowed. */
  passOutsideClick?: boolean;
  /** A surface that shows beside the user's work rather than over it (the selection's quote bar):
   *  Escape and the stack are still the layer's, but the page's own shortcuts (Cmd+digit, undo,
   *  single keys) keep working while it is up, so hasOpenOverlayLayer() leaves it out. Default false. */
  passive?: boolean;
}

interface Layer {
  id: number;
  opts: { current: OverlayLayerOptions };
}

const stack: Layer[] = [];
/** One counter for layers AND dialogs (useModalOverlay), so "which opened last" has one answer. */
let nextId = 1;
/** Open dialogs, by the order they opened in (useModalOverlay registers each). */
const modals = new Set<number>();

/**
 * A dialog (useModalOverlay) took its place in the same order as the layers: while a dialog that
 * opened AFTER the topmost layer is up, Escape and Tab are the dialog's, so one Escape closes the
 * dialog on top and never the popover left open under it. Returns its removal.
 */
export function registerModalOrder(): () => void {
  const id = nextId++;
  modals.add(id);
  return () => { modals.delete(id); };
}

/** True when a dialog opened after the topmost layer: the keyboard belongs to that dialog. */
function dialogAboveTop(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  for (const id of modals) if (id > top.id) return true;
  return false;
}
let swallowClick = false;
let swallowTimer: ReturnType<typeof setTimeout> | null = null;
const SWALLOW_MS = 1000;

/** True while an overlay layer that holds the keyboard is open (a passive one does not): the page's
 *  shortcuts and other Escape handlers check it. */
export function hasOpenOverlayLayer(): boolean {
  return stack.some((layer) => layer.opts.current.passive !== true);
}

/** Test hook: the number of open layers. */
export function overlayLayerDepth(): number {
  return stack.length;
}

function contains(layer: Layer, target: EventTarget | null, path: readonly EventTarget[] = []): boolean {
  const { refs, exemptSelectors } = layer.opts.current;
  // The event's composed path first: it holds the layer even when the press landed in a shadow
  // root, or on a node a render detached before this check ran (contains() says no to both).
  for (const ref of refs) if (ref.current && path.includes(ref.current)) return true;
  // Duck-typed (not instanceof Node) so the stack logic is unit-testable without a DOM.
  const node = target as (Node & { closest?: Element['closest'] }) | null;
  if (!node || typeof node.nodeType !== 'number') return false;
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
  // The topmost layer that traps: a hover card on top (trapFocus false) leaves the flyout under it trapping.
  let top: Layer | undefined;
  for (let i = stack.length - 1; i >= 0 && !top; i -= 1) if (stack[i].opts.current.trapFocus !== false) top = stack[i];
  if (!top) return;
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
  if (dialogAboveTop()) return;
  if (e.key === 'Tab' && !isImeKey(e) && !e.altKey && !e.ctrlKey && !e.metaKey && stack.length > 0) {
    cycleTab(e);
    return;
  }
  // isImeKey: WebKit's Escape that cancels an IME candidate has isComposing false, keyCode 229.
  if (e.key !== 'Escape' || isImeKey(e) || stack.length === 0) return;
  const top = stack[stack.length - 1];
  const opts = top.opts.current;
  const closeOnEscape = typeof opts.closeOnEscape === 'function' ? opts.closeOnEscape() : opts.closeOnEscape;
  if (closeOnEscape === false) return;
  if (closeOnEscape === 'if-unclaimed') { deferredEscape = { event: e, layerId: top.id }; return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  if (opts.onEscape?.(e)) return;
  opts.onClose('escape');
}

/** An Escape the topmost layer let the page have first (`closeOnEscape: 'if-unclaimed'`). */
let deferredEscape: { event: KeyboardEvent; layerId: number } | null = null;

/** Window bubble: the deferred Escape came through the whole page. Unclaimed, it is the layer's. */
function onKeyDownBubble(e: KeyboardEvent): void {
  const deferred = deferredEscape;
  if (!deferred || deferred.event !== e) return;
  deferredEscape = null;
  // Stopping propagation claims a key too, and such an event never reaches this listener.
  if (escapeWasConsumedByOthers(e)) return;
  const top = stack[stack.length - 1];
  if (!top || top.id !== deferred.layerId) return;
  e.preventDefault();
  if (top.opts.current.onEscape?.(e)) return;
  top.opts.current.onClose('escape');
}

/** A press on another popover's trigger opens it: the click goes through, so switching menus takes one click. */
function isPopoverTrigger(target: EventTarget | null): boolean {
  const node = target as (Node & { closest?: Element['closest'] }) | null;
  const el = node && typeof node.closest === 'function' ? (node as unknown as Element) : (node?.parentElement ?? null);
  return !!el?.closest?.('[aria-haspopup]:not([aria-haspopup=false])');
}

function onPointerDownCapture(e: PointerEvent): void {
  // A dialog opened over the popover owns the pointer too: pressing in it never closes the popover under it.
  if (stack.length === 0 || dialogAboveTop()) return;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  let swallow = false;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const layer = stack[i];
    if (contains(layer, e.target, path) || layer.opts.current.closeOnOutside === false) break;
    // Only a primary press is followed by a click to swallow: a right press (it opens another menu)
    // makes no click, and arming would eat the first click in the menu it opened.
    if (layer.opts.current.passOutsideClick !== true && (e.button ?? 0) === 0) swallow = true;
    layer.opts.current.onClose('outside');
  }
  if (swallow && !isPopoverTrigger(e.target)) armSwallow();
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
  window.addEventListener('keydown', onKeyDownBubble);
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
  keydownBubble: onKeyDownBubble,
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
