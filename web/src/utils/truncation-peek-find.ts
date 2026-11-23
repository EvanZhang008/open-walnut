/**
 * What the truncation peek reads of the page (utils/truncation-peek.ts drives it): which texts
 * the page cut off, the row a pointer is on, and what that row opens. Pure reads of the DOM and
 * its computed styles; no state, no listener.
 */
import { clippingAncestors } from './clip-ancestors';
import { growsDown } from './truncation-peek-row';

/** How far up from the hovered node the cut-off text is looked for. */
const MAX_DEPTH = 6;

/** Fields show their own text (a value, not child nodes): never peeked. */
const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

export function optedOut(el: Element): boolean {
  return !!el.closest('[data-peek="off"], [inert], [aria-hidden="true"], [contenteditable="true"], [contenteditable=""]');
}

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE && n.textContent && n.textContent.trim()) return true;
  return false;
}

/**
 * The right edge the page clips `el` at: the ancestors that hide their overflow sideways, the
 * nearest scroller and the window. `scrolls`: a scroller came before any other clip, so what
 * runs past it is reached by scrolling it, not cut.
 */
function clipOf(el: Element): { right: number; scrolls: boolean } {
  let right = window.innerWidth;
  // The ancestors that really clip it (a fixed or absolute box escapes some): the one clip rule.
  for (const c of clippingAncestors(el, { stop: document.body })) {
    if (!c.x) continue;
    const cs = getComputedStyle(c.el);
    const edge = c.el.getBoundingClientRect().right - (parseFloat(cs.borderRightWidth) || 0);
    const scroller = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (!scroller) { right = Math.min(right, edge); continue; }
    // A scroller: the last edge that counts.
    return edge < right ? { right: edge, scrolls: true } : { right, scrolls: false };
  }
  return { right, scrolls: false };
}

function clipRight(el: Element): number { return clipOf(el).right; }

function contentRect(el: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect();
}

/** Text that runs past what the page shows of it, by its own box (ellipsis, clamp) or a clipping ancestor. */
export function isCut(el: HTMLElement, cs: CSSStyleDeclaration): boolean {
  if (!el.textContent || !el.textContent.trim()) return false;
  const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
  if (el.clientWidth > 0) {
    if (el.scrollWidth - el.clientWidth > 1) return true;
    // A single line's descenders can stand a pixel or two past its box: only a hidden line counts.
    if (clamped && el.scrollHeight - el.clientHeight > 4) return true;
  }
  return contentRect(el).right > clipRight(el) + 1;
}

/** The cut-off text the pointer is on, or null. */
export function findCutText(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || optedOut(target)) return null;
  let textHost: HTMLElement | null = null;
  let el: Element | null = target;
  for (let depth = 0; el && el !== document.body && depth < MAX_DEPTH; el = el.parentElement, depth++) {
    if (!(el instanceof HTMLElement)) continue;
    if (SKIP_TAGS.has(el.tagName) || el.isContentEditable) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return null;
    if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) return isCut(el, cs) ? el : null;
    if (!textHost && hasOwnText(el)) textHost = el;
  }
  // No ellipsis on the way up: one line of text a column cuts off at its edge (the Org list's
  // lines). Text that wraps is never cut sideways.
  if (!textHost) return null;
  const ws = getComputedStyle(textHost).whiteSpace;
  if (ws !== 'nowrap' && ws !== 'pre') return null;
  // Inside a scroller (a code block, a diff) the rest of the line is reached by scrolling.
  const clip = clipOf(textHost);
  if (!clip.scrolls && contentRect(textHost).right > clip.right + 1) return textHost;
  return null;
}


/**
 * Where cut-off text widens on hover: only inside a narrow side list of tasks, marked
 * `data-peek-zone` (Home's task panel, which the session columns sit beside). Everywhere else it
 * stays as it is and shows its full text as a native tooltip (truncation-peek.ts), and a click
 * opens what holds it (2026-11-23, the user: "就是那种非常非常 narrow 的地方，然后可能我们放大可以，
 * 但所有东西都放大真的是不太舒服"; first on the Org page head: "这个 title 不要，就是放上去之后还要放大").
 * A new zone is a new entry in tests/web/truncation-peek-zones.test.ts.
 */
export const PEEK_ZONE_SELECTOR = '[data-peek-zone]';

/**
 * A page's or a panel's header (a title row and its tools), inside a zone too, never widens: a row
 * on the header rule (`data-fit-header`), a `<header>`, a row classed `*-head`, `*-header`,
 * `*-heading`, `*-toolbar`, `*-titlebar` or `*-topbar` (tests/web/header-fit-scan.ts names them the
 * same way), or one marked `data-peek-header`. A list row (`data-peek-row`) around it is no header.
 */
const HEADER_SELECTOR = '[data-fit-header], header, [data-peek-header]';
const HEADER_CLASS = /(?:^|\s)[A-Za-z][\w-]*-(?:head|header|heading|toolbar|titlebar|topbar)(?=\s|$)/;
export function headerOf(el: Element): Element | null {
  let found: Element | null = null;
  for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
    if (a.matches(PEEK_ROW_SELECTOR)) return null;
    // What holds a zone is not its header.
    if (a.matches(PEEK_ZONE_SELECTOR)) break;
    if (!found && (a.matches(HEADER_SELECTOR) || HEADER_CLASS.test(a.getAttribute('class') ?? ''))) found = a;
  }
  return found;
}

/**
 * Whether cut-off text at `el` may widen on hover: inside a zone, not in a header there. A card with
 * a box to type in inside a zone (Home's ask card) still opens downward in its column, the way the
 * user designed it there (2026-11-20, truncation-peek-row.ts growsDown); outside a zone it does not
 * (2026-11-23: a session's question card opened down over the reply box).
 */
export function peekAllowed(el: Element): boolean {
  return !!el.closest(PEEK_ZONE_SELECTOR) && !headerOf(el);
}

/**
 * A menu, a popover, a list of choices or a dialog showing now: the overlay family
 * (styles/overlay-family.css, which every floating layer takes) and the ARIA roles of one. A peek
 * opens in the top layer, above every portal, so it never opens while one shows (2026-11-23: at
 * 1280 a cut task title opened over the row menu's Pin to, beside it). A tooltip (wn-tip) is none.
 */
export const OVERLAY_SELECTOR = '.wn-overlay, .wn-dialog, .wn-scrim, [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog[open]';

export function overlayShowing(): boolean {
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') return true;
  }
  return false;
}

/** A task row (or any list row) that expands as a whole: the pointer anywhere on it shows every cut-off text in it. */
export const PEEK_ROW_SELECTOR = '[data-peek-row]';
/** A row's own buttons (its ⋮ menu, Start, Close): over one the row keeps quiet, so the button shows. */
export const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="treeitem"], [role="tab"], [role="checkbox"], input, select, textarea, summary';

/**
 * The row's own control under `target`, if any. A control that reads as part of the row's text
 * (its project name, which filters on click) carries `data-peek-through`, so the row still
 * expands over it; the row itself is never its own control.
 */
export function rowControl(target: Element): Element | null {
  const c = target.closest(CONTROL);
  return c && !c.matches('[data-peek-row], [data-peek-through]') ? c : null;
}

export function isTruncating(cs: CSSStyleDeclaration): boolean {
  return cs.textOverflow === 'ellipsis' || (!!cs.webkitLineClamp && cs.webkitLineClamp !== 'none');
}

/** Every text in `row` the page cut off, in document order (not those of a row nested in it). */
export function cutTextsIn(row: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]) {
    if (!(el instanceof HTMLElement)) continue;
    if (out.some((h) => h.contains(el))) continue;
    if (el.closest(PEEK_ROW_SELECTOR) !== row.closest(PEEK_ROW_SELECTOR) || optedOut(el) || el.isContentEditable || SKIP_TAGS.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (!isTruncating(cs) || cs.visibility === 'hidden' || cs.display === 'none' || el.getClientRects().length === 0) continue;
    if (isCut(el, cs)) out.push(el);
  }
  return out;
}

/**
 * What the pointer at `target` peeks: the cut-off texts of the row it is on (anywhere on the
 * row, except on one of the row's own buttons that holds none of them), else the cut-off text
 * right under it. `key` is the row, or that text.
 */
export function peekTargetOf(target: EventTarget | null): { key: Element; hosts: HTMLElement[] } | null {
  if (!(target instanceof Element) || optedOut(target) || !peekAllowed(target)) return null;
  const row = target.closest(PEEK_ROW_SELECTOR);
  if (row && growsDown(row)) {
    // A card with a box to type in opens from its text only: its box and buttons stay as they are.
    const hosts = cutTextsIn(row);
    return hosts.length && onTextOf(row, target, hosts) ? { key: row, hosts } : null;
  }
  if (row) {
    const hosts = cutTextsIn(row);
    if (hosts.length) {
      const control = rowControl(target);
      const onOwnButton = control && row.contains(control) && !hosts.some((h) => control.contains(h) || h.contains(control));
      if (!onOwnButton) return { key: row, hosts };
      return null;
    }
  }
  const host = findCutText(target);
  if (!host) return null;
  // Unmarked components widen through the same whole-container path.
  const key = boxOf(host.closest(CONTROL) ?? host.parentElement ?? host);
  const hosts = cutTextsIn(key);
  if (!hosts.includes(host)) hosts.push(host);
  return { key, hosts };
}

/** What the pointer on a card's text is never on: its box to type in, its buttons, a menu. A link in the text is text. */
const NOT_TEXT = 'input, textarea, select, button, summary, [role="button"], [role="menuitem"], [role="option"], [role="checkbox"], [contenteditable="true"], [contenteditable=""]';

/** Whether `target` is on one of `row`'s texts: a cut-off one, or one the page would cut. */
export function onTextOf(row: Element, target: Element, hosts: HTMLElement[]): boolean {
  for (let el: Element | null = target; el && el !== row; el = el.parentElement) {
    if (el.matches(NOT_TEXT)) return false;
    if (hosts.includes(el as HTMLElement) || isTruncating(getComputedStyle(el))) return true;
  }
  return false;
}

/**
 * The nearest element from `el` up that draws a box of its own. An inline element (a sentence's
 * span around a cut host name) has none: its placeholder would hold one line's height and the
 * words around it would reflow, so the container that opens is the block that holds it
 * (2026-11-16: a session notice's sentence opened 86px taller than its placeholder).
 */
function boxOf(el: Element): Element {
  let at: Element = el;
  while (at.parentElement && at.parentElement !== document.body && /^(inline|contents)$/.test(getComputedStyle(at).display)) at = at.parentElement;
  return at;
}
