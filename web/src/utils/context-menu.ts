/**
 * When the BROWSER's right-click menu must be left alone.
 *
 * Walnut replaces the native menu on rows/tabs/icons, because there it offers
 * nothing: in the Mac app (WKWebView) a right-click on an app object shows
 * "Back / Reload / Inspect Element", and in a tab strip or an icon rail that is
 * pure noise. But the native menu is genuinely the BEST menu in three cases,
 * and stealing it there is a regression, not a fix:
 *
 *   1. Editable surfaces (input / textarea / contenteditable): Paste, Undo,
 *      spelling suggestions, dictation, emoji — none of which we can offer.
 *   2. A live text selection: Copy / Look Up / Translate / Search With… act on
 *      the exact characters the user chose. Our row menu would throw that away.
 *   3. Links, images and media: Open in New Tab, Copy Link, Save Image, and the
 *      video controls all come free and all work.
 *
 * Kept as a pure function (no React, no event object) so those rules are
 * unit-testable and identical on every surface that adopts them.
 */

import type { ReactNode } from 'react';

/** Selectors whose native menu is strictly better than anything we'd show. */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const MEDIA = 'img, video, audio';
const LINK = 'a[href]';

export interface KeepNativeOptions {
  /** `window.getSelection()?.toString()` — empty/whitespace counts as no selection. */
  selectionText?: string | null;
  /** The selection's anchor node, used to check the selection is inside `scope`. */
  selectionAnchor?: Node | null;
  /**
   * The row/tab the menu belongs to (the event's currentTarget). A selection
   * OUTSIDE it is a leftover from somewhere else on the page and must not
   * suppress this row's menu.
   */
  scope?: Element | null;
  /**
   * Take over even on an `<a href>`. Set by surfaces whose ROW is an anchor only
   * because SPA routing needs one (the sidebar rail, a task row link): there the
   * native "Open Link in New Tab" is not what a right-click is for, and our menu
   * is the only one that knows what the object is. Rule 3 still applies to real
   * document links inside content (chat markdown, note bodies).
   */
  overrideLinks?: boolean;
}

export function keepNativeContextMenu(
  target: Element | null,
  { selectionText, selectionAnchor, scope, overrideLinks }: KeepNativeOptions = {},
): boolean {
  if (!target) return false;
  // `closest` covers the whole subtree case: the pointer is usually over a span
  // inside the editable/link, never on the element itself.
  if (typeof target.closest !== 'function') return false;
  if (target.closest(EDITABLE) || target.closest(MEDIA)) return true;
  if (!overrideLinks && target.closest(LINK)) return true;
  if (!selectionText || !selectionText.trim()) return false;
  // No scope given → any selection counts (callers without a row boundary).
  if (!scope || !selectionAnchor) return true;
  return scope.contains(selectionAnchor);
}

export interface ContextMenuItem {
  /** Stable per-item key. Dividers/labels may omit it. */
  key?: string;
  label?: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** A horizontal rule. Leading/trailing/duplicate dividers are dropped. */
  divider?: boolean;
  /** A group heading (not focusable). */
  section?: boolean;
  /** A read-only info line (not focusable). */
  info?: boolean;
  /** Convenience for conditional items: `when: false` drops the row. */
  when?: boolean;
}

/** Drop hidden items, then collapse dividers that ended up leading/trailing/doubled. */
export function normalizeContextMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
  const visible = items.filter((item) => item.when !== false);
  const out: ContextMenuItem[] = [];
  for (const item of visible) {
    if (item.divider) {
      if (out.length === 0) continue;
      if (out[out.length - 1]?.divider) continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1]?.divider) out.pop();
  return out;
}
