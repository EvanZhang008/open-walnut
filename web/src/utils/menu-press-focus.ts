/**
 * A press on a menu item never scrolls its menu: one rule for every menu in the app.
 *
 * Why: a menu taller than the room beside its trigger is capped (`useMenuPlacement`) and scrolls
 * inside. When the ENGINE focuses the item a press lands on, macOS WebKit (the Mac app) scrolls the
 * focused item into view inside that box. An item cut by the box's edge then moves up under the
 * pointer between mousedown and mouseup: the release lands on another item or on the box, the click
 * goes to their common ancestor, and nothing runs, or the wrong item sits under the pointer
 * (2026-11-09, the project menu: down on "View project details", up on "Delete project"). Safari
 * focuses any element with a `tabindex` on a press, which every ContextMenu row has, and other
 * engines focus every button.
 *
 * So the engine's own focus-on-press never runs for an item of a `[role="menu"]`: the mousedown's
 * default is prevented, and once the press has been dispatched the item is focused by script with
 * `preventScroll`, which is the same focus without the scroll. Focus still lands where it always
 * did, so a menu that stays open keeps answering Space and Enter on the item just pressed
 * (CalendarsPopover relies on that). The page keeps its say: a handler that prevents the press
 * itself (a composer's menu keeping the caret in the composer) gets no focus moved, and neither does
 * a press after which something else took focus, or whose menu closed.
 *
 * CAPTURE phase on `window`, so a menu whose own handler stops the press (ThreadPathBar and friends
 * stop mousedown to keep it from the row behind) is covered too. Exempt: a field inside the item (it
 * takes its own focus and caret) and a drag source (a prevented mousedown never starts a native
 * drag). The click still fires: preventing mousedown cancels focus, never the click.
 */

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), label';
const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
// What an engine focuses on a press: a button, a link, anything with a tabindex.
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]';

/** The menu item whose press this rule takes over, or null. On its own so a test can grade it. */
export function menuPressItem(target: EventTarget | null): HTMLElement | null {
  // Duck-typed, so a text node's press (its parent decides) and another realm's element both read.
  const el = (target && typeof (target as Element).closest === 'function'
    ? target
    : (target as Node | null)?.parentElement ?? null) as Element | null;
  if (!el) return null;
  const item = el.closest<HTMLElement>(ITEM);
  if (!item) return null;
  const menu = item.closest('[role="menu"]');
  if (!menu) return null;
  const field = el.closest(FIELD);
  if (field && item.contains(field)) return null;
  for (let n: Element | null = el; n && n !== menu.parentElement; n = n.parentElement) {
    if (n.getAttribute('draggable') === 'true') return null;
  }
  return item;
}

const installedOn = new WeakSet<Window>();

export function installMenuPressFocus(win: Window = window): void {
  if (installedOn.has(win)) return;
  installedOn.add(win);
  win.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const item = menuPressItem(e.target);
    if (!item) return;
    const doc = item.ownerDocument;
    const before = doc.activeElement;
    // Did the page prevent the press itself? Then it owns focus, as it did before this rule.
    let pagePrevented = e.defaultPrevented;
    const prevent = e.preventDefault;
    Object.defineProperty(e, 'preventDefault', {
      configurable: true,
      value: () => { pagePrevented = true; prevent.call(e); },
    });
    prevent.call(e);
    win.setTimeout(() => {
      if (pagePrevented || !item.isConnected || doc.activeElement !== before) return;
      if (doc.activeElement === item || !item.matches(FOCUSABLE)) return;
      item.focus({ preventScroll: true });
    }, 0);
  }, true);
}
