/**
 * One Escape closes one layer in the Files view (2026-11-09 review: in Source mode one
 * Escape closed the Ask card AND the whole full-screen sheet; in Preview only the card).
 *
 * A card over a file (an Ask here question, a comment) is a layer above the sheet. With
 * focus inside the card, the card's own key handler takes the press. With focus in the
 * file itself (the source editor keeps it after Ask here), no handler of the card heard
 * it and the sheet's full-screen exit took it. Every card layer therefore claims Escape
 * while its card is open (`claimFileCardEscape`, a window capture listener), and every
 * handler that leaves a sheet asks `fileCardOpenIn` (its own sheet) first.
 *
 * The layers, innermost first (2026-11-10 review: in Changed one Escape with the Quote in chat
 * toolbar up closed the whole sheet): a menu or modal, an editor's own panel (search,
 * completion), the selection toolbar (`claimToolbarEscape`), the card, then the sheet. Each
 * layer's claim steps aside while one inside it is open, so registration order never decides.
 */
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { escapeWasConsumedByOthers } from '@/utils/escape-beep-guard';

/** A card open over a file: the Ask card, the current comment or a comment draft. */
export const FILE_CARD_SELECTOR = '.thread-card, .doc-comment-card.is-current';

/** Menus and editor panels that close themselves on Escape before any card does. */
const OWN_ESCAPE = '.wn-context-menu, .app-modal-overlay, .cm-panels, .cm-tooltip, .fv-search-bar';

/**
 * Is a file card open inside `scope`, the sheet the Escape would leave? A sheet stays while
 * one is. Always the sheet's own element, never the whole page: a chat card open in another
 * column has nothing to do with this sheet (2026-11-10 review: any `.thread-card` anywhere
 * kept every full screen open on Escape). No scope, no card.
 */
export function fileCardOpenIn(scope: ParentNode | null | undefined): boolean {
  return !!scope?.querySelector(FILE_CARD_SELECTOR);
}

/** The sheets on show full screen now: a tab sheet (useFullscreen) and the Files view's own. */
export const FULLSCREEN_SHEET_SELECTOR = '.open-walnut-fullscreen:not(.open-walnut-fullscreen-away), .fv-fullscreen';

/** Is a file card open inside any sheet that is full screen (for a sheet that does not hold its own element)? */
export function fileCardOpenInFullscreen(doc: Document | null = typeof document === 'undefined' ? null : document): boolean {
  if (!doc) return false;
  for (const sheet of Array.from(doc.querySelectorAll(FULLSCREEN_SHEET_SELECTOR))) if (fileCardOpenIn(sheet)) return true;
  return false;
}

export interface CardEscapeFacts {
  key: string;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** The element the press went to, and the focused one. */
  target: Element | null;
  active: Element | null;
  /** The open card, and the view it sits over (the Files sheet, the panel). */
  card: Element | null;
  scope: Element | null;
  /** Where the card reads Escape itself (its own handler steps through its sizes); the card by default. */
  ownKeys?: string;
  /** A menu or a modal over the page. */
  overlayOpen: boolean;
  /** A selection toolbar is up: it is the layer above the card and takes the press. */
  toolbarOpen?: boolean;
}

/**
 * Should this press close the card from outside it? Not when another layer takes it
 * first (a menu, a modal, the editor's search panel or completion), not with focus in
 * the card (its own handler steps through its own sizes), and not with focus in a field
 * somewhere else on the page.
 */
export function cardTakesEscape(f: CardEscapeFacts): boolean {
  if (f.key !== 'Escape' || f.isComposing || f.defaultPrevented || f.overlayOpen || f.toolbarOpen || !f.card) return false;
  if (f.target?.closest?.(OWN_ESCAPE) || f.active?.closest?.(OWN_ESCAPE)) return false;
  if (f.active && f.card.contains(f.active) && (!f.ownKeys || f.active.closest(f.ownKeys))) return false;
  if (!f.active || f.active === f.active.ownerDocument?.body) return true;
  return !!f.scope?.contains(f.active);
}

/**
 * While a card is open, an Escape that no layer above it takes closes the card and
 * only the card. Window capture, so it runs before the sheets' own Escape handlers
 * (which also step aside: `fileCardOpenIn`). Returns the uninstall.
 */
export function claimFileCardEscape(
  read: () => { card: Element | null; scope: Element | null },
  close: () => void,
  ownKeys?: string,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent) => {
    const { card, scope } = read();
    const target = e.target instanceof Element ? e.target : null;
    const active = document.activeElement;
    if (!cardTakesEscape({
      key: e.key, isComposing: e.isComposing || e.keyCode === 229, defaultPrevented: e.defaultPrevented,
      target, active, card, scope, overlayOpen: hasActiveModalOverlay(), toolbarOpen: selectionToolbarOpen(),
      ...(ownKeys ? { ownKeys } : {}),
    })) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

/** A toolbar over a text selection: Ask here / Quote in chat (SelectionAskPill), the format bubble. */
export const SELECTION_TOOLBAR_SELECTOR = '.session-diff-ask-pill, .notes-bubble-menu';

/** Is a selection toolbar on show? Page-wide: there is one selection, so at most one toolbar. */
export function selectionToolbarOpen(doc: Document | null = typeof document === 'undefined' ? null : document): boolean {
  if (!doc) return false;
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(SELECTION_TOOLBAR_SELECTOR))) {
    const cs = (doc.defaultView ?? window).getComputedStyle(el);
    if (cs.display !== 'none' && cs.visibility === 'visible') return true;
  }
  return false;
}

export interface ToolbarEscapeFacts {
  key: string;
  isComposing: boolean;
  /** A real handler (not the Mac app's beep guard) took the press already. */
  consumed: boolean;
  overlayOpen: boolean;
  target: Element | null;
  active: Element | null;
  open: boolean;
}

/** Should this press close the selection toolbar? Only a menu, a modal or an editor's own panel goes first. */
export function toolbarTakesEscape(f: ToolbarEscapeFacts): boolean {
  if (f.key !== 'Escape' || f.isComposing || f.consumed || f.overlayOpen || !f.open) return false;
  return !(f.target?.closest?.(OWN_ESCAPE) || f.active?.closest?.(OWN_ESCAPE));
}

/**
 * While a selection toolbar is up, one Escape closes it and nothing else: window capture and
 * stopImmediatePropagation, so neither the card under it nor the sheet around it hears the
 * press. The iframe preview forwards its Escape to its frame element, which comes through here
 * too. Returns the uninstall.
 */
export function claimToolbarEscape(isOpen: () => boolean, close: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent) => {
    if (!toolbarTakesEscape({
      key: e.key, isComposing: e.isComposing || e.keyCode === 229, consumed: escapeWasConsumedByOthers(e),
      overlayOpen: hasActiveModalOverlay(), target: e.target instanceof Element ? e.target : null,
      active: document.activeElement, open: isOpen(),
    })) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
