/**
 * The page's single-key shortcuts ("F" opens Filter, "/" a search box) are for the page the
 * reader is on, never for a sheet or an editor that has their attention (2026-11-10 review: a
 * click under the last line of Source focused nothing, and "F" then opened the task filter
 * over the Files sheet).
 *
 * Every document- or window-level handler of a bare key asks `pageShortcutBlocked` first
 * (tests/web/page-shortcut-guard.test.ts lists them). A key is not the page's when:
 *  - a modifier is held, it is composing text, or another handler took it;
 *  - focus, or the key's target, is in something the reader types into (an input, a
 *    contenteditable, a code editor);
 *  - the reader last pressed inside a file view or editor (its preview takes no focus, so focus
 *    is on the page while the reader is reading the file);
 *  - a sheet (a panel or a file full screen) is open and the shortcut's own control is not in it;
 *  - a menu, popover or dialog is open.
 */
import { hasOpenOverlayLayer } from '@/hooks/useOverlayLayer';

/** Regions that keep the keyboard while the reader works in them. */
export const KEY_OWNERS = '.file-content-view, .cm-editor, .fv-wysiwyg-editor, .session-file-explorer, .session-diff-view';

/** A shown full-screen sheet: a panel's or a file's. */
const SHEETS = '.open-walnut-fullscreen:not(.open-walnut-fullscreen-away), .file-content-view.fv-fullscreen';

/** Focus is in something the reader types into. */
export function isTypingElement(el: EventTarget | null): boolean {
  const e = el as (Element & { isContentEditable?: boolean }) | null;
  if (!e || typeof e.closest !== 'function') return false;
  const tag = e.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable) return true;
  return !!e.closest('[contenteditable]:not([contenteditable="false"]), .cm-editor');
}

let lastPress: Element | null = null;
let listening = false;
function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', (e) => { lastPress = e.target instanceof Element ? e.target : null; }, true);
  // Focus moved by the keyboard to something outside: the press no longer says where the reader is.
  document.addEventListener('focusin', (e) => { if (e.target instanceof Element && !ownerOf(e.target)) lastPress = null; }, true);
}
listen();

/** Test hook: forget the last press. */
export function resetLastPress(): void { lastPress = null; }

function ownerOf(el: Element | null): Element | null {
  return el && typeof el.closest === 'function' ? el.closest(KEY_OWNERS) : null;
}

/** Is `key` NOT for this page shortcut? `own` is the control the shortcut opens or focuses. */
export function pageShortcutBlocked(e: KeyboardEvent, own?: Element | null): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.isComposing) return true;
  const active = document.activeElement;
  if (isTypingElement(active) || isTypingElement(e.target)) return true;
  const inOwn = (region: Element | null) => !!region && !!own && region.contains(own);
  for (const at of [active, e.target instanceof Element ? e.target : null, lastPress?.isConnected ? lastPress : null]) {
    const owner = ownerOf(at);
    if (owner && !inOwn(owner)) return true;
  }
  for (const sheet of document.querySelectorAll(SHEETS)) {
    if (sheet.getClientRects().length && !inOwn(sheet)) return true;
  }
  if (hasOpenOverlayLayer()) return true;
  for (const el of document.querySelectorAll('[role="dialog"]:not([hidden]), [role="menu"]:not([hidden]), [role="alertdialog"]')) {
    if (el.getClientRects().length && !inOwn(el)) return true;
  }
  return false;
}
