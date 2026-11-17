/**
 * The room the notice stack covers at the window's bottom, given to every box that asks for it
 * (corner-stack.tsx publishes it, corner-stack.css says who asks and why).
 *
 * A box asks in its own CSS rule by reading `var(--corner-stack-room, 0px)` in its bottom padding or
 * its last grid row. The property is registered as not inherited (`@property` in corner-stack.css),
 * and while the stack covers something this module sets it inline on the asking boxes themselves
 * (ROOM_BOXES); with the stack empty it takes it off them again. Every page's own cascade stays as
 * it is (a rule that gives a page no room still wins), and only those boxes restyle.
 *
 * A spacer after a box's last row (`::after`, where bottom padding would lift a control stuck to
 * the box's bottom edge or change the box's size) reads `var(--corner-stack-spacer, 0px)`, an
 * ordinary inherited variable set on its box (SPACER_BOXES): WebKit 26 gives a pseudo-element
 * nothing of a property that is not inherited, `inherit` included, so it restyles what is inside
 * those few boxes too.
 *
 * Why not one stylesheet that gives the room (a copy of each asking rule, or one rule setting the
 * property on the boxes): in WebKit, the Mac app's engine, any change to a stylesheet, its text or
 * one rule's declaration alike, restyles the whole document. Measured 2026-11-17 on a
 * 55,000-element Tasks table (docs/reference/notification-lifecycle.md), per change: about 1.3s
 * in WebKit for a sheet, 0.2s set on the box; in Chromium about 20ms for a sheet, 70ms set on the
 * box, and 250ms to 300ms for an inherited variable on <html> or a scroller.
 */
import { STACK_ROOM_VAR, STACK_SPACER_VAR } from './corner-stack-width';

/**
 * Every box whose CSS rule reads the room, by that rule's selector. tests/web/corner-stack-guard.test.ts
 * holds this list to the CSS, both ways.
 */
export const ROOM_BOXES = [
  '.app-content-area',
  '.apps-page',
  '.cal-grid-scroll',
  '.cal-rail-scroll',
  '.global-notes-body .global-notes-editor-inline .tiptap',
  '.home-navigation-scroll',
  '.mail-accounts-scroll',
  '.mail-rows',
  '.memory-tree-sections',
  '.notes-split-view:not(.notes-has-active) > .notes-editor-pane',
  '.notes-tree-body',
  '.org-list-scroll',
  '.pw-app',
  '.pw-gate',
  '.pw-rows',
  '.pw-side',
  '.settings-container .settings-nav-list',
  '.settings-container .settings-pane.settings-content',
  '.tp-rail-scroll',
  '.tp-table-scroll',
] as const;

/** Every box whose `::after` spacer reads the room, by the spacer rule's selector without `::after`. */
export const SPACER_BOXES = [
  '.first-use-in-tasks .first-use-setup',
  '.first-use-in-tasks ~ .home-navigation-scroll',
  '.notes-editor-content',
  '.plugin-native-app',
] as const;

/** One kind of asking box: where it is found and the variable it reads. */
interface Kind { name: string; live: { selector: string; list: HTMLCollectionOf<Element> }[] | null; given: HTMLElement[] }
const KINDS: [readonly string[], Kind][] = [
  [ROOM_BOXES, { name: STACK_ROOM_VAR, live: null, given: [] }],
  [SPACER_BOXES, { name: STACK_SPACER_VAR, live: null, given: [] }],
];

/** The boxes of one kind on the page now, each found by the class its selector ends in (a list the
 *  browser keeps live and cheap to read). */
function boxesOf(selectors: readonly string[], kind: Kind): HTMLElement[] {
  kind.live ??= selectors.map((selector) => ({ selector, list: document.getElementsByClassName(/\.([\w-]+)$/.exec(selector)![1]!) }));
  const out: HTMLElement[] = [];
  for (const { selector, list } of kind.live) {
    for (const el of list) if (el instanceof HTMLElement && el.matches(selector)) out.push(el);
  }
  return out;
}

/**
 * Gives every asking box on the page `px` of room (0: none, taken off every box). Cheap to call
 * often: it writes only a box whose value differs, so a box a route mounted since gets it on the
 * next call and the rest are left alone.
 */
export function giveStackRoom(px: number): void {
  const value = `${px}px`;
  for (const [selectors, kind] of KINDS) {
    const boxes = px > 0 ? boxesOf(selectors, kind) : [];
    const keep = new Set(boxes);
    for (const el of kind.given) if (!keep.has(el)) el.style.removeProperty(kind.name);
    for (const el of boxes) if (el.style.getPropertyValue(kind.name) !== value) el.style.setProperty(kind.name, value);
    kind.given = boxes;
  }
}
