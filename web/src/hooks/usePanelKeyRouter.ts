/**
 * ONE window-level keydown dispatcher for every session panel (spec 5.5).
 *
 * Esc (pop a question page) and Cmd+Shift+E (toggle the question drawer) must
 * reach exactly ONE panel, with three or more side by side. Per-panel document
 * listeners would each fire; so every panel registers here and a single listener
 * picks the target:
 *   1. the registered panel containing document.activeElement;
 *   2. only when focus is on <body> or outside every panel: the panel he last
 *      pressed the pointer in (transcript text is not focusable, so a click
 *      there leaves focus on <body>; S9, N32);
 *   3. else the panel under the last pointer position.
 *
 * The listener sits on WINDOW in the bubble phase, so it runs after every
 * element and document handler (palettes, pickers, search, fullscreen). Esc is
 * handled only when nobody before it called preventDefault, outside an IME
 * composition, and with no modal overlay open.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { hasActiveModalOverlay } from './useModalOverlay';
import { escapeWasConsumedByOthers } from '@/utils/escape-beep-guard';
import { log } from '@/utils/log';

export interface PanelKeyHandlers {
  sessionId: string;
  /** Return true when the key was used (the router then prevents and stops it). */
  onEscape: (e: KeyboardEvent) => boolean;
  onToggleDrawer: (e: KeyboardEvent) => boolean;
  /** Something in the panel would close on Esc (drawer, menu) even at the
   *  root page: fullscreen then leaves Esc to the panel. */
  hasEscapeLayer?: () => boolean;
}

interface Registration {
  /** Read at key time: a fullscreen portal can remount the panel's element. */
  ref: { current: HTMLElement | null };
  handlers: { current: PanelKeyHandlers };
}

export interface ContainsLike {
  contains: (other: Node | null) => boolean;
}

/**
 * The pure target picker. `regs` in any order; nested panels resolve to the
 * innermost match. `hitAt` maps the pointer to the element under it.
 */
export function pickKeyTarget<T extends { el: ContainsLike }>(
  regs: readonly T[],
  active: Node | null,
  body: Node | null,
  pointer: { x: number; y: number } | null,
  hitAt: (x: number, y: number) => Node | null,
  pressed: Node | null = null,
): T | null {
  const innermost = (node: Node | null): T | null => {
    if (!node) return null;
    const hits = regs.filter((r) => r.el.contains(node));
    if (hits.length <= 1) return hits[0] ?? null;
    return hits.find((h) => !hits.some((o) => o !== h && h.el.contains(o.el as unknown as Node))) ?? hits[0];
  };
  if (active && active !== body) {
    const byFocus = innermost(active);
    if (byFocus) return byFocus;
  }
  if (pressed && (!active || active === body)) {
    const byPress = innermost(pressed);
    if (byPress) return byPress;
  }
  if (!pointer) return null;
  return innermost(hitAt(pointer.x, pointer.y));
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(uaData?.platform ?? navigator.platform ?? navigator.userAgent ?? '');
}

/** Cmd+Shift+E on Mac, Ctrl+Shift+E elsewhere; no Alt, no mixed modifiers. */
export function isDrawerChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  if (!e.shiftKey || e.altKey) return false;
  if (e.code !== 'KeyE' && e.key.toLowerCase() !== 'e') return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Is this key part of an IME composition? WebKit reports the key that ENDS a
 *  composition (Esc cancelling a pinyin candidate) with isComposing false and
 *  keyCode 229, the same rule ChatInput applies. */
export function isImeKey(e: Pick<KeyboardEvent, 'isComposing'> & { keyCode?: number }): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** Should Esc go to the panels at all? */
export function escapeIsFree(
  e: Pick<KeyboardEvent, 'defaultPrevented' | 'isComposing'> & { keyCode?: number },
  modalOpen: boolean,
): boolean {
  return !e.defaultPrevented && !isImeKey(e) && !modalOpen;
}

// ── Module singleton: one listener pair for the whole page ──

const registrations = new Set<Registration>();
let pointer: { x: number; y: number } | null = null;
/** Where the last pointer press landed (weak: a removed node just stops matching). */
let pressed: WeakRef<Node> | null = null;
let installed = false;

function currentTarget(): { el: HTMLElement; reg: Registration } | null {
  if (typeof document === 'undefined') return null;
  const live: Array<{ el: HTMLElement; reg: Registration }> = [];
  for (const reg of registrations) if (reg.ref.current) live.push({ el: reg.ref.current, reg });
  const at = pressed?.deref() ?? null;
  return pickKeyTarget(live, document.activeElement, document.body, pointer, (x, y) => document.elementFromPoint(x, y),
    at && document.contains(at) ? at : null);
}

/** Stack depth of the panel keys would go to (0 when none or at the root).
 *  useFullscreen reads it so one Esc never pops a page AND exits fullscreen. */
export function keyTargetThreadDepth(): number {
  const panel: Element | undefined = currentTarget()?.el;
  let holder: Element | null | undefined;
  if (panel) {
    holder = panel.matches?.('[data-thread-depth]') ? panel : panel.querySelector?.('[data-thread-depth]');
  } else if (typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body) {
    // No registered panel: only the focused element's OWN ancestors count (a
    // query from <body> would find another column's stack).
    holder = document.activeElement.closest?.('[data-thread-depth]');
  }
  const n = Number(holder?.getAttribute('data-thread-depth') ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Would the panel keys go to use an Esc before fullscreen may exit? True on a
 *  question page (depth > 0) or with a drawer/menu open in that panel. */
export function keyTargetClaimsEscape(): boolean {
  if (keyTargetThreadDepth() > 0) return true;
  return currentTarget()?.reg.handlers.current.hasEscapeLayer?.() === true;
}

function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
}

function onPointerDown(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
  pressed = e.target instanceof Node && typeof WeakRef !== 'undefined' ? new WeakRef(e.target) : null;
}

/** A press that gave focus to something is answered by rule 1 (and a later
 *  blur means "no focus": the pointer rule again, C62). Only a press on
 *  unfocusable text keeps standing in for focus. */
function onFocusIn() {
  pressed = null;
}

function onKeyDown(e: KeyboardEvent) {
  const isEsc = e.key === 'Escape';
  const isChord = !isEsc && isDrawerChord(e, isMacPlatform());
  if (!isEsc && !isChord) return;
  // The beep guard's own preventDefault (Mac app) is not a consumer: ask it.
  if (isEsc && !escapeIsFree({ defaultPrevented: escapeWasConsumedByOthers(e), isComposing: e.isComposing, keyCode: e.keyCode }, hasActiveModalOverlay())) return;
  if (isChord && (isImeKey(e) || e.defaultPrevented)) return;
  const target = currentTarget();
  if (!target) return;
  const h = target.reg.handlers.current;
  const used = isEsc ? h.onEscape(e) : h.onToggleDrawer(e);
  if (!used) return;
  e.preventDefault();
  e.stopPropagation();
  log.info('threads', 'key routed', { sessionId: h.sessionId, key: isEsc ? 'Escape' : 'drawer-chord' });
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  window.addEventListener('focusin', onFocusIn, true);
}

function uninstall() {
  if (!installed || registrations.size > 0) return;
  installed = false;
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('pointermove', onPointerMove, { capture: true });
  window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  window.removeEventListener('focusin', onFocusIn, true);
}

/** Register one panel element (the hook's body; exported as the test seam).
 *  Returns the unregister function. */
export function registerPanel(
  target: HTMLElement | { current: HTMLElement | null },
  handlers: { current: PanelKeyHandlers },
): () => void {
  const ref = 'current' in target ? target : { current: target };
  const reg: Registration = { ref, handlers };
  registrations.add(reg);
  install();
  return () => {
    registrations.delete(reg);
    uninstall();
  };
}

/** Test hook: how many panels are registered right now. */
export function registeredPanelCount(): number {
  return registrations.size;
}

/**
 * Register a session panel with the router. Handlers may change every render;
 * the registration reads the newest ones.
 */
export function usePanelKeyRouter(panelRef: RefObject<HTMLElement | null>, handlers: PanelKeyHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    return registerPanel(panelRef, latest);
  }, [panelRef]);
}
