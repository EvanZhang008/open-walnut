/**
 * Cut-off text has one behavior everywhere: its whole real container widens in the top layer,
 * keeping its exact height and leaving neighbouring rows still. No cloned text tooltip.
 * Mark a component `data-peek-row` to open all its cut-off texts when hovered anywhere;
 * unmarked text opens its nearest control or layout container through the same path. A card
 * a person types into (`growsDown`) opens only from its text, in place in its own column, and
 * a tap opens it on a touch screen (truncation-peek-row.ts).
 * Native titles are lifted during the peek and restored on exit. Fields, touch, drags and
 * `data-peek="off"` stay untouched. One capturing listener serves every surface.
 */
import '@/styles/truncation-peek.css';
import { clippingAncestors } from './clip-ancestors';
import { collapseRow, expandRow, growsDown, within, type RowMarks } from './truncation-peek-row';

/** How far up from the hovered node the cut-off text is looked for. */
const MAX_DEPTH = 6;

/** Fields show their own text (a value, not child nodes): never peeked. */
const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function optedOut(el: Element): boolean {
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


/** A task row (or any list row) that expands as a whole: the pointer anywhere on it shows every cut-off text in it. */
export const PEEK_ROW_SELECTOR = '[data-peek-row]';
/** A row opens once the pointer rests on it this long, so sweeping across rows moves nothing. */
const ROW_OPEN_MS = 140;
/** A row's own buttons (its ⋮ menu, Start, Close): over one the row keeps quiet, so the button shows. */
const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="treeitem"], [role="tab"], [role="checkbox"], input, select, textarea, summary';

/**
 * The row's own control under `target`, if any. A control that reads as part of the row's text
 * (its project name, which filters on click) carries `data-peek-through`, so the row still
 * expands over it; the row itself is never its own control.
 */
function rowControl(target: Element): Element | null {
  const c = target.closest(CONTROL);
  return c && !c.matches('[data-peek-row], [data-peek-through]') ? c : null;
}

function isTruncating(cs: CSSStyleDeclaration): boolean {
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
  if (!(target instanceof Element) || optedOut(target)) return null;
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
function onTextOf(row: Element, target: Element, hosts: HTMLElement[]): boolean {
  for (let el: Element | null = target; el && el !== row; el = el.parentElement) {
    if (el.matches(NOT_TEXT)) return false;
    if (hosts.includes(el as HTMLElement) || isTruncating(getComputedStyle(el))) return true;
  }
  return false;
}

/** An open card that grows downward and holds `node`: it keeps open while the person works in it. */
function openDownHolding(node: EventTarget | Node | null): Active | null {
  if (!(node instanceof Node)) return null;
  for (const a of [active, lingering]) if (a?.marked.down && a.key.contains(node)) return a;
  return null;
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

/** The container being opened and the attributes to restore on exit. */
interface Active {
  key: Element; hosts: HTMLElement[]; titles: Array<[Element, string]>; texts: string[]; timer: ReturnType<typeof setTimeout> | null;
  /** What expanding the row marked. */
  marked: RowMarks;
}

let active: Active | null = null;
let pointer: { x: number; y: number } | null = null;
/** Briefly keep a row open while the pointer crosses a gap. No list geometry changes. */
let lingering: Active | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
const LINGER_MS = 220;

function closeLingering(): void {
  if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
  const was = lingering;
  if (!was) return;
  lingering = null;
  if (!active) observer?.disconnect();
  collapseRow(was.marked);
  putTitlesBack(was.titles);
}

/** The pointer left the open row `state`: it stays open a moment (see `lingering`). */
function linger(state: Active): void {
  closeLingering();
  lingering = state;
  const wait = () => {
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      // A row about to open closes it itself, in its own step; a press holds it as it is.
      if (active?.timer || pressed || (state.marked.down && state.key.contains(document.activeElement))) wait();
      else closeLingering();
    }, LINGER_MS);
  };
  wait();
}
let observer: MutationObserver | null = null;

/**
 * Takes every native title from the pointer's element to the root, and in the row, off while
 * it peeks. In a row the titles of its own buttons stay: they show their own labels.
 */
function takeTitles(from: Element, row?: Element): Array<[Element, string]> {
  const out: Array<[Element, string]> = [];
  const take = (a: Element) => {
    if (row && a !== row && row.contains(a) && rowControl(a)) return;
    const t = a.getAttribute('title');
    if (t !== null) { out.push([a, t]); a.removeAttribute('title'); }
  };
  for (let a: Element | null = from; a; a = a.parentElement) take(a);
  if (row && row !== from) row.querySelectorAll('[title]').forEach(take);
  return out;
}

function putTitlesBack(titles: Array<[Element, string]>): void {
  // A title React set again meanwhile is the newer one: keep it.
  for (const [el, t] of titles) if (!el.hasAttribute('title')) el.setAttribute('title', t);
}

/** Ends every peek, the row just left included. */
export function hidePeek(): void {
  close();
  closeLingering();
}

/** Ends the current peek without moving the list. */
function close(): void {
  if (!active) return;
  const was = active;
  active = null;
  if (was.timer) clearTimeout(was.timer);
  if (!lingering) observer?.disconnect();
  collapseRow(was.marked);
  putTitlesBack(was.titles);
}

function renderAll(state: Active): void {
  closeLingering();
  state.marked = expandRow(state.key, state.hosts);
}

/**
 * The open row's texts changed while it stays under the pointer (a status push re-rendered it, a
 * late markdown pass replaced its nodes): measure the original box and widen its new text in
 * the same task. No painted frame changes height or moves a neighbour. False when it no longer
 * has cut-off text there; then it is closed.
 */
function reopenInPlace(a: Active): boolean {
  if (!a.key.isConnected || !a.marked.length || !pointer || !within(a.key, pointer)) return false;
  collapseRow(a.marked);
  a.marked = [];
  const hosts = cutTextsIn(a.key);
  if (!hosts.length || hosts.some((h) => h.isContentEditable)) return false;
  a.hosts = hosts;
  a.texts = hosts.map((h) => h.textContent ?? '');
  a.titles.push(...takeTitles(a.key, a.key));
  a.marked = expandRow(a.key, hosts, false);
  return true;
}

/** The row it shows changed under the pointer (renamed, re-sorted, gone): the peek goes with it. */
function watchActive(): void {
  observer ??= new MutationObserver(() => {
    const moved = (state: Active) => !!state.marked.placeholder &&
      (state.marked.placeholder.nextSibling !== state.key || !state.key.matches(':popover-open'));
    if (lingering && (!lingering.key.isConnected || moved(lingering))) closeLingering();
    const a = active;
    if (!a) return;
    // React can move the same node without disconnecting it or changing any text. Its old
    // shell must go immediately; settle on whatever is now under the pointer at the new order.
    if (!a.key.isConnected || moved(a)) { close(); settleSoon(); return; }
    if (!a.hosts.some((h, i) => !h.isConnected || h.isContentEditable || h.textContent !== a.texts[i])) return;
    if (reopenInPlace(a)) return;
    close();
    settleSoon();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable'] });
}

function activate(key: Element, hosts: HTMLElement[], target: Element, keyboard = false): void {
  close();
  const state: Active = { key, hosts, titles: takeTitles(target, key), texts: hosts.map((h) => h.textContent ?? ''), timer: null, marked: [] };
  active = state;
  watchActive();
  state.timer = setTimeout(() => {
    if (active !== state) return;
    state.timer = null;
    if (key.matches(':hover') || (keyboard && key.contains(document.activeElement))) renderAll(state);
    else close();
  }, keyboard ? 0 : ROW_OPEN_MS);
}

let downAt: { x: number; y: number } | null = null;

function onOver(e: PointerEvent): void {
  // A touch on an open card that grows downward keeps it (onUp toggles it from its text).
  if (e.pointerType === 'touch') { if (!openDownHolding(e.target)) hidePeek(); return; }
  // A press in progress: a click lands on the row as it is; a drag closes it (onMove).
  if (e.buttons !== 0) return;
  releaseLostPress();
  pointer = { x: e.clientX, y: e.clientY };
  const target = e.target instanceof Element ? e.target : null;
  if (lingering && target) {
    // Back on the row just left: it is the open row again.
    if (lingering.key.contains(target)) {
      close();
      if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
      active = lingering;
      lingering = null;
      watchActive();
      return;
    }
    if (!within(lingering.key, pointer)) closeLingering();
  }
  // On the open row, its own buttons included: it stays open (closing it would move the button
  // out from under the pointer and open it again).
  if (active?.marked.length && target && active.key.contains(target)) {
    if (!rowControl(target)) active.titles.push(...takeTitles(target, active.key));
    return;
  }
  // Off an open row: it stays open a moment, and closes in the step the next one opens.
  if (active?.marked.length) {
    const was = active;
    active = null;
    linger(was);
    watchActive();
  }
  over(target);
}

/** What `target` peeks, now that the pointer is on it. */
function over(target: Element | null): void {
  if (pressed) return;
  // Still on the row that peeks, off its own buttons: nothing to scan again.
  // A card that grows downward opens only from its text, so its other parts are scanned again.
  const sameRow = active && target && active.key.matches(PEEK_ROW_SELECTOR) && !growsDown(active.key) && target.closest(PEEK_ROW_SELECTOR) === active.key && !rowControl(target);
  if (active && target && (sameRow || active.key === target || (active.hosts.length === 1 && active.hosts[0].contains(target)))) {
    active.titles.push(...takeTitles(target));
    return;
  }
  const next = peekTargetOf(target);
  if (active && next && next.key === active.key) {
    // The pointer moved onto a child that carries its own title: take that one off too.
    active.titles.push(...takeTitles(target as Element));
    return;
  }
  if (!next || !target) { close(); return; }
  activate(next.key, next.hosts, target);
}

/** After a scroll or a resize moved the page under a still pointer: what it is on now. */
let settle: ReturnType<typeof setTimeout> | null = null;
function settleSoon(): void {
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    if (!active && pointer) over(document.elementFromPoint(pointer.x, pointer.y));
  }, 160);
}

/** Whether a scroll or a wheel at `t` moves what peeks (another pane streaming its chat does not). */
function movesPeek(t: EventTarget | null): boolean {
  if (!(t instanceof Element) || t === document.documentElement || t === document.body) return true;
  const shown = [active, lingering].filter((a): a is Active => !!a);
  // A text of an open card that grows downward scrolls inside itself: reading on keeps it open.
  return shown.some(({ key: r, marked }) => t.contains(r) || (r.contains(t) && !(marked.down && t !== r)));
}

function hideAndSettle(e?: Event): void {
  if (e && e.type !== 'resize' && (pressed || !movesPeek(e.target))) return;
  hidePeek();
  settleSoon();
}

/**
 * A press in progress: nothing changes size until it ends, so a click lands where it was aimed
 * and a drag (dnd-kit measures the rows as it starts) sees the list hold still.
 */
let pressed = false;
let dragged = false;

function onDown(e: PointerEvent): void {
  downAt = { x: e.clientX, y: e.clientY };
  pressed = true;
  dragged = false;
  // A click on an open row keeps it as it is, so the click lands where it was aimed.
  // A row not open yet stays closed through the press, so the click lands where it was aimed.
  if (active?.timer) close();
}

function onMove(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  pointer = { x: e.clientX, y: e.clientY };
  // The press ended unheard: take this move as the pointer arriving where it is, open row and all.
  if (e.buttons === 0 && releaseLostPress()) { onOver(e); return; }
  if (pressed && e.buttons !== 0 && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) {
    dragged = true;
    hidePeek();
  }
}

function onUp(e: PointerEvent): void {
  if (!pressed) return;
  pressed = false;
  if (e.type === 'pointerup' && e.pointerType === 'touch' && !dragged) tapped(e);
  // After a drag the rows are where it dropped them: start over from what the pointer is on.
  if (dragged) { dragged = false; hidePeek(); settleSoon(); }
}

/**
 * A touch screen has no hover: a tap on the text of a card that grows downward opens it, a tap
 * on its text again or anywhere outside it closes it. A link or a button in it does its own job.
 */
function tapped(e: PointerEvent): void {
  const target = e.target instanceof Element ? e.target : null;
  if (!target || (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4)) return;
  const control = target.closest(CONTROL);
  const row = target.closest(PEEK_ROW_SELECTOR);
  if (!row || !growsDown(row) || (control && row.contains(control) && control !== row)) return;
  const open = openDownHolding(target);
  if (open) {
    if (onTextOf(row, target, open.hosts)) hidePeek();
    return;
  }
  const next = peekTargetOf(target);
  if (!next) return;
  hidePeek();
  pointer = { x: e.clientX, y: e.clientY };
  const state: Active = { key: next.key, hosts: next.hosts, titles: takeTitles(target, next.key), texts: next.hosts.map((h) => h.textContent ?? ''), timer: null, marked: [] };
  active = state;
  watchActive();
  renderAll(state);
}

/**
 * A press whose release the page never heard (a native right-click menu takes the mouse-up, a
 * drag ends outside the window, the app loses focus mid-press) must not keep every row closed:
 * the pointer moving with no button held proves the press is over. True when one was pending.
 */
function releaseLostPress(): boolean {
  if (!pressed) return false;
  pressed = false;
  dragged = false;
  downAt = null;
  return true;
}

function onOut(e: PointerEvent): void {
  // Out of the window: nothing else will say the pointer left. A finger "leaves" as it lifts: a
  // tap's card stays open until the next tap (`tapped`).
  if (!e.relatedTarget && e.pointerType !== 'touch') hidePeek();
}

const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock']);
let installed = false;

/** Once per window, from main.tsx. */
export function installTruncationPeek(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (!(target instanceof Element) || openDownHolding(target) || !target.matches(':focus-visible')) return;
    const next = peekTargetOf(target);
    if (next) activate(next.key, next.hosts, target, true);
    else hidePeek();
  }, true);
  document.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (active && (!(next instanceof Element) || !active.key.contains(next))) hidePeek();
    // Focus leaving a card that stayed open for it, after the pointer had already left.
    else if (lingering?.marked.down && !(next instanceof Element && lingering.key.contains(next))) closeLingering();
  }, true);
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('pointerup', onUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onUp, { capture: true, passive: true });
  // Anything that starts an action ends the peek at once, before the action's own handlers.
  document.addEventListener('dragstart', hidePeek, { capture: true, passive: true });
  // React resolves the real control first; restore afterwards so a new menu is not hidden
  // underneath the top layer. Capture would change its geometry before its own click handler.
  // A card that grows downward has no top layer to hide a menu under: a click in it (its box,
  // its buttons) keeps it open, so the box does not move as it is clicked.
  document.addEventListener('click', (e) => { if (!openDownHolding(e.target)) setTimeout(hidePeek, 0); }, { capture: true, passive: true });
  // A modifier held for a click (Cmd or Shift to select) is no action of its own.
  // Typing an answer in a card that grows downward keeps its question open above the box.
  document.addEventListener('keydown', (e) => { if (!MODIFIERS.has(e.key) && !openDownHolding(e.target)) hidePeek(); }, { capture: true, passive: true });
  // Anything that moves the page under the pointer ends it, and what the pointer rests on after peeks.
  document.addEventListener('wheel', hideAndSettle, { capture: true, passive: true });
  document.addEventListener('scroll', hideAndSettle, { capture: true, passive: true });
  window.addEventListener('resize', hideAndSettle);
  // A button may still be held across a blur; the next move with none held ends the press.
  window.addEventListener('blur', hidePeek);
  document.addEventListener('visibilitychange', hidePeek);
  document.addEventListener('dragend', () => { releaseLostPress(); hidePeek(); settleSoon(); }, { capture: true, passive: true });
}
